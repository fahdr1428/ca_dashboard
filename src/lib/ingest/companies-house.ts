import { resolveRegion } from "@/lib/regions";
import type {
  Connector,
  ConnectorContext,
  ConnectorResult,
  RawCompany,
  RawProspect,
  RawFinancial,
  RawShareholding,
  RawSignal,
  RawSource,
} from "./types";
import { emptyResult } from "./types";
import { sicToIndustry } from "./sic";
import { parseIxbrlAccounts, deriveEbitda } from "./ixbrl";

/**
 * Companies House connector.
 *
 * Reads the free public REST API at api.company-information.service.gov.uk,
 * which is the authoritative UK register and is published under the Open
 * Government Licence v3.0. Authentication is HTTP Basic with the API key as the
 * username and an empty password.
 *
 * This is the connector that makes ownership *verifiable* rather than asserted:
 * the PSC register tells us, as a matter of statutory filing, who controls a
 * company and in which 25-point band.
 *
 * Rate limit: 600 requests per rolling 5 minutes per key. The limiter below
 * stays well inside that.
 */

const BASE = "https://api.company-information.service.gov.uk";

/** 600 req / 5 min = 2/sec. We run at 4 req/sec burst, 1.6/sec sustained. */
class RateLimiter {
  private queue: Array<() => void> = [];
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly capacity = 8,
    private readonly refillPerSecond = 1.6,
  ) {
    this.tokens = capacity;
  }

  async take(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = ((1 - this.tokens) / this.refillPerSecond) * 1000;
    await new Promise((r) => setTimeout(r, Math.ceil(waitMs)));
    return this.take();
  }

  private refill() {
    const now = Date.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.lastRefill) / 1000) * this.refillPerSecond,
    );
    this.lastRefill = now;
  }
}

export class CompaniesHouseClient {
  private readonly limiter = new RateLimiter();
  private requestCount = 0;

  constructor(
    private readonly apiKey: string,
    private readonly maxRequests = 400,
  ) {}

  get requestsUsed() {
    return this.requestCount;
  }

  async get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T | null> {
    if (this.requestCount >= this.maxRequests) {
      throw new Error(`Companies House request budget of ${this.maxRequests} exhausted`);
    }
    await this.limiter.take();

    const url = new URL(path, BASE);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const auth = Buffer.from(`${this.apiKey}:`).toString("base64");
    for (let attempt = 0; attempt < 4; attempt++) {
      this.requestCount++;
      const res = await fetch(url, {
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
        // Never send cookies or credentials anywhere else.
        redirect: "follow",
      });

      if (res.status === 404) return null;
      if (res.status === 429) {
        // Honour Retry-After; the register publishes it on throttle.
        const retryAfter = Number(res.headers.get("retry-after") ?? 0);
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : 2000 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      if (!res.ok) {
        throw new Error(`Companies House ${res.status} on ${url.pathname}: ${await res.text()}`);
      }
      return (await res.json()) as T;
    }
    throw new Error(`Companies House repeatedly unavailable for ${url.pathname}`);
  }

  /** Advanced search — the entry point for discovering in-region companies. */
  advancedSearch(opts: {
    location?: string;
    sicCodes?: string[];
    incorporatedFrom?: string;
    incorporatedTo?: string;
    size?: number;
    startIndex?: number;
    companyStatus?: string;
  }) {
    return this.get<CHAdvancedSearch>("/advanced-search/companies", {
      location: opts.location,
      sic_codes: opts.sicCodes?.join(","),
      incorporated_from: opts.incorporatedFrom,
      incorporated_to: opts.incorporatedTo,
      company_status: opts.companyStatus ?? "active",
      size: opts.size ?? 100,
      start_index: opts.startIndex ?? 0,
    });
  }

  company(number: string) {
    return this.get<CHCompany>(`/company/${encodeURIComponent(number)}`);
  }

  psc(number: string) {
    return this.get<CHPscList>(
      `/company/${encodeURIComponent(number)}/persons-with-significant-control`,
      { items_per_page: 50 },
    );
  }

  officers(number: string) {
    return this.get<CHOfficerList>(`/company/${encodeURIComponent(number)}/officers`, {
      items_per_page: 50,
      order_by: "appointed_on",
    });
  }

  filingHistory(number: string) {
    return this.get<CHFilingHistory>(`/company/${encodeURIComponent(number)}/filing-history`, {
      items_per_page: 25,
    });
  }

  /**
   * Fetches a filed document's iXBRL content via the Document API.
   *
   * `documentMetadataUrl` comes from a filing history item's
   * `links.document_metadata` and points at a different host, which `get()`
   * handles because an absolute URL overrides the base. The metadata is checked
   * first so we only request XHTML when the filing actually has it — accounts
   * filed on paper are scanned PDFs with no tagged data, and asking for XHTML
   * would just waste a request against the rate limit.
   */
  async accountsDocument(
    documentMetadataUrl: string,
  ): Promise<{ content: string | null; reason: DocumentSkipReason | null }> {
    let metadata: CHDocumentMetadata | null;
    try {
      metadata = await this.get<CHDocumentMetadata>(documentMetadataUrl);
    } catch (err) {
      // A 401/403 here means the key is not authorised for the Document API,
      // which is a separate product from the Public Data API. That is a
      // configuration problem with a specific fix, and it must not be reported
      // as "this company filed on paper".
      const message = err instanceof Error ? err.message : String(err);
      if (/\b40[13]\b/.test(message)) return { content: null, reason: "NOT_AUTHORISED" };
      throw err;
    }

    if (!metadata) return { content: null, reason: "NO_DOCUMENT" };

    const resources = metadata.resources ?? {};
    const xhtmlType = Object.keys(resources).find((t) => /xhtml|xml/i.test(t));
    if (!xhtmlType) return { content: null, reason: "NO_TAGGED_VERSION" };

    const content = await this.getText(
      `${documentMetadataUrl.replace(/\/$/, "")}/content`,
      xhtmlType,
    );
    return { content, reason: content ? null : "CONTENT_UNAVAILABLE" };
  }

  /** As `get`, but for non-JSON payloads. */
  private async getText(url: string, accept: string): Promise<string | null> {
    if (this.requestCount >= this.maxRequests) {
      throw new Error(`Companies House request budget of ${this.maxRequests} exhausted`);
    }
    await this.limiter.take();
    this.requestCount++;

    const auth = Buffer.from(`${this.apiKey}:`).toString("base64");
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: accept },
      redirect: "follow",
    });
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) return null;

    // Guard against pulling a very large document into memory; tagged accounts
    // for a company of this size are comfortably under this.
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > 12_000_000) return null;

    return res.text();
  }
}

// ---------------------------------------------------------------------------
// API response shapes (only the fields we use)
// ---------------------------------------------------------------------------

interface CHAddress {
  address_line_1?: string;
  address_line_2?: string;
  locality?: string;
  region?: string;
  postal_code?: string;
  country?: string;
}

interface CHAdvancedSearch {
  hits: number;
  items: Array<{
    company_number: string;
    company_name: string;
    company_status: string;
    date_of_creation: string;
    sic_codes?: string[];
    registered_office_address?: CHAddress;
  }>;
}

interface CHCompany {
  company_number: string;
  company_name: string;
  company_status: string;
  date_of_creation?: string;
  sic_codes?: string[];
  registered_office_address?: CHAddress;
  accounts?: {
    last_accounts?: { made_up_to?: string; type?: string };
    next_accounts?: { period_end_on?: string };
  };
}

interface CHPscList {
  items: Array<{
    name?: string;
    kind: string;
    natures_of_control?: string[];
    notified_on?: string;
    ceased_on?: string;
    nationality?: string;
    country_of_residence?: string;
    date_of_birth?: { month?: number; year?: number };
    address?: CHAddress;
    links?: { self?: string };
    name_elements?: { forename?: string; surname?: string; middle_name?: string; title?: string };
  }>;
}

interface CHOfficerList {
  items: Array<{
    name: string;
    officer_role: string;
    appointed_on?: string;
    resigned_on?: string;
    occupation?: string;
    nationality?: string;
    country_of_residence?: string;
    address?: CHAddress;
    date_of_birth?: { month?: number; year?: number };
    links?: { officer?: { appointments?: string } };
  }>;
}

interface CHFilingHistory {
  items: Array<{
    category: string;
    date: string;
    description: string;
    type: string;
    transaction_id?: string;
    links?: { document_metadata?: string };
  }>;
}

export type DocumentSkipReason =
  | "NOT_AUTHORISED"
  | "NO_DOCUMENT"
  | "NO_TAGGED_VERSION"
  | "CONTENT_UNAVAILABLE";

interface CHDocumentMetadata {
  company_number?: string;
  /** Keyed by content type, e.g. "application/xhtml+xml". */
  resources?: Record<string, { content_length?: number }>;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * PSC "natures of control" are published as banded strings. We map them to the
 * band boundaries and never to a false point estimate.
 */
export function ownershipFromNaturesOfControl(
  natures: string[] | undefined,
): { low: number; high: number; basis: string } | null {
  if (!natures?.length) return null;
  const bands: Array<[RegExp, number, number]> = [
    [/(ownership-of-shares|voting-rights)-75-to-100-percent/, 75, 100],
    [/(ownership-of-shares|voting-rights)-50-to-75-percent/, 50, 75],
    [/(ownership-of-shares|voting-rights)-25-to-50-percent/, 25, 50],
  ];
  let best: { low: number; high: number; basis: string } | null = null;
  for (const n of natures) {
    for (const [re, low, high] of bands) {
      if (re.test(n) && (!best || low > best.low)) {
        best = { low, high, basis: `PSC register: ${n}` };
      }
    }
  }
  if (best) return best;

  // Control without a share band (e.g. right to appoint directors) still marks
  // them as significant, but we cannot size the stake from it.
  if (natures.some((n) => /right-to-appoint-and-remove-directors/.test(n))) {
    return {
      low: 0,
      high: 25,
      basis: "PSC register: right to appoint and remove directors (no share band filed)",
    };
  }
  return null;
}

export function chSource(path: string, title: string, publishedAt?: Date): RawSource {
  return {
    url: `https://find-and-update.company-information.service.gov.uk${path}`,
    title,
    publisher: "Companies House",
    sourceType: "COMPANIES_HOUSE",
    publishedAt,
    reliability: 5,
    licence: "Companies House data — Open Government Licence v3.0",
  };
}

function addressToText(a: CHAddress | undefined): string {
  if (!a) return "";
  return [a.address_line_1, a.address_line_2, a.locality, a.region, a.postal_code]
    .filter(Boolean)
    .join(", ");
}

function properCase(name: string): string {
  // Companies House returns officer names in upper case: "SMITH, Jane Elizabeth".
  const [surname, rest] = name.includes(",") ? name.split(",", 2) : [null, name];
  const fix = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/(^|[\s'-])([a-z])/g, (_, p, c) => p + c.toUpperCase());
  return surname ? `${fix(rest)} ${fix(surname)}`.trim() : fix(name);
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

/** SIC codes that skew towards owner-managed, high-margin businesses. */
const TARGET_SIC_CODES = [
  "62012", "62020", "62090", // software & IT consultancy
  "64205", "64209", "70100", // holding companies
  "66300", "64992", // fund management, financial intermediation
  "46900", "46760", // wholesale
  "71121", "71122", // engineering design
  "86101", "86900", // healthcare
  "35110", "35119", // electricity generation (renewables)
  "41100", "41202", // property development, construction
  "10890", "11020", // food & drink production
];

export function createCompaniesHouseConnector(): Connector {
  const apiKey = process.env.COMPANIES_HOUSE_API_KEY;

  return {
    key: "companies-house",
    label: "Companies House",
    description:
      "Discovers active companies registered in the 13 target counties, reads the PSC register to establish who owns them, and watches filing history for changes.",
    sourceType: "COMPANIES_HOUSE",
    isAvailable: () => Boolean(apiKey),
    unavailableReason: () =>
      "COMPANIES_HOUSE_API_KEY is not set. Register a free key at developer.company-information.service.gov.uk and add it to your environment.",

    async run(ctx: ConnectorContext): Promise<ConnectorResult> {
      if (!apiKey) return { ...emptyResult(), warnings: ["Companies House API key not configured."] };

      const client = new CompaniesHouseClient(apiKey, ctx.maxRequests);
      const result = emptyResult();
      const seenCompanies = new Set<string>();

      // Search location by location so we stay inside the declared geography.
      const locations = [
        "Cornwall", "Devon", "Somerset", "Bristol", "Gloucestershire", "Wiltshire",
        "Dorset", "Hampshire", "West Sussex", "Surrey", "Berkshire", "London", "Oxfordshire",
      ];

      // If the register is down or the key is rejected, the failure will repeat
      // for every county. Retrying all thirteen wastes minutes of backoff and
      // hammers an API that has already told us it can't help, so give up after
      // two consecutive failures and report once.
      let consecutiveFailures = 0;
      const FAILURE_LIMIT = 2;

      // Set once if the key cannot reach the Document API, so the remaining
      // companies skip the attempt instead of failing identically.
      let documentApiBlocked = false;

      for (const location of locations) {
        let page = 0;
        try {
          // Two pages per county per run keeps a weekly run comfortably inside
          // the API budget while still turning over new material.
          for (; page < 2; page++) {
            const search = await client.advancedSearch({
              location,
              sicCodes: TARGET_SIC_CODES,
              size: 50,
              startIndex: page * 50,
            });
            if (!search?.items?.length) break;

            for (const item of search.items) {
              if (seenCompanies.has(item.company_number)) continue;
              seenCompanies.add(item.company_number);

              const region = resolveRegion(
                addressToText(item.registered_office_address) || location,
              );
              // Out-of-scope registered office: skip rather than guess.
              if (!region) continue;

              const company: RawCompany = {
                companyNumber: item.company_number,
                name: item.company_name,
                status: item.company_status,
                incorporatedOn: item.date_of_creation ? new Date(item.date_of_creation) : undefined,
                sicCodes: item.sic_codes ?? [],
                industry: sicToIndustry(item.sic_codes ?? []),
                region,
                officeLocation:
                  item.registered_office_address?.locality ?? location,
                registeredAddress: addressToText(item.registered_office_address),
                sources: [
                  chSource(
                    `/company/${item.company_number}`,
                    `${item.company_name} — Companies House register`,
                  ),
                ],
              };

              // Filing history gives us a cheap change-detection hash and the
              // director/PSC events that drive weekly signals.
              const filings = await client.filingHistory(item.company_number);
              if (filings?.items?.length) {
                company.filingHash = hashFilings(filings.items);
                for (const f of filings.items.slice(0, 10)) {
                  const occurredOn = new Date(f.date);
                  if (ctx.since && occurredOn < ctx.since) continue;
                  const signal = filingToSignal(item.company_number, item.company_name, f, occurredOn);
                  if (signal) result.signals.push(signal);
                }

                // The accounts are where the money is. Without them every
                // valuation is zero and nobody qualifies, so this is the part
                // that makes the wealth model work on live data.
                if (!documentApiBlocked) {
                  try {
                    const { financials, warnings } = await readFiledAccounts(
                      client,
                      filings.items,
                      item.company_name,
                    );
                    if (financials.length) company.financials = financials;
                    result.warnings.push(...warnings);
                  } catch (err) {
                    if (err instanceof DocumentApiUnauthorised) {
                      documentApiBlocked = true;
                      result.warnings.push(err.message);
                    } else {
                      throw err;
                    }
                  }
                }
              }

              // PSC register: the ownership evidence.
              const psc = await client.psc(item.company_number);
              for (const p of psc?.items ?? []) {
                if (p.kind !== "individual-person-with-significant-control") continue;
                if (p.ceased_on) continue;
                const ownership = ownershipFromNaturesOfControl(p.natures_of_control);
                if (!ownership || ownership.high <= 25) continue;

                const personName = p.name ? properCase(p.name) : null;
                if (!personName) continue;

                const personRegion =
                  resolveRegion(addressToText(p.address)) ?? region;

                const shareholding: RawShareholding = {
                  companyNumber: item.company_number,
                  companyName: item.company_name,
                  ownershipPctLow: ownership.low,
                  ownershipPctHigh: ownership.high,
                  basis: ownership.basis,
                  evidence: "FILED",
                  asOf: p.notified_on ? new Date(p.notified_on) : undefined,
                };

                const prospect: RawProspect = {
                  fullName: personName,
                  region: personRegion,
                  officeLocation: item.registered_office_address?.locality ?? location,
                  primaryCompanyNumber: item.company_number,
                  primaryCompanyName: item.company_name,
                  // Name + DOB month/year + a filed address is a strong but not
                  // conclusive identity match; officer linkage raises this.
                  identityConfidence: p.date_of_birth?.year ? 72 : 58,
                  shareholdings: [shareholding],
                  sources: [
                    chSource(
                      `/company/${item.company_number}/persons-with-significant-control`,
                      `${item.company_name} — persons with significant control`,
                      p.notified_on ? new Date(p.notified_on) : undefined,
                    ),
                  ],
                };
                result.prospects.push(prospect);
              }

              // Officers give job title and occupation for the people we found.
              const officers = await client.officers(item.company_number);
              for (const o of officers?.items ?? []) {
                if (o.resigned_on) continue;
                const name = properCase(o.name);
                const match = result.prospects.find(
                  (pr) => pr.primaryCompanyNumber === item.company_number && namesMatch(pr.fullName, name),
                );
                if (match) {
                  match.jobTitle = titleForRole(o.officer_role);
                  match.occupation = o.occupation ?? match.occupation;
                  const appointments = o.links?.officer?.appointments;
                  if (appointments) {
                    match.chOfficerId = appointments.split("/")[2];
                    match.identityConfidence = Math.max(match.identityConfidence ?? 0, 84);
                  }
                }
              }

              result.companies.push(company);
            }
          }
          consecutiveFailures = 0;
        } catch (err) {
          consecutiveFailures++;
          result.warnings.push(
            `Companies House search for ${location} stopped at page ${page}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          if (consecutiveFailures >= FAILURE_LIMIT) {
            result.warnings.push(
              `Companies House failed ${consecutiveFailures} counties in a row — abandoning the rest of this run. Check the API key and https://status.company-information.service.gov.uk.`,
            );
            break;
          }
        }
      }

      ctx.log(
        `Companies House: ${result.companies.length} companies, ${result.prospects.length} controlling individuals, ${client.requestsUsed} API requests used.`,
      );
      return result;
    },
  };
}

/** How many accounts filings to open per company. */
const ACCOUNTS_FILINGS_TO_READ = 2;

/** Thrown once when the API key cannot reach the Document API at all. */
class DocumentApiUnauthorised extends Error {
  constructor() {
    super(
      "Companies House rejected the Document API request (401/403). Filed accounts cannot be read, " +
        "so turnover, profit and dividends will be unavailable and valuations will fall back to net assets. " +
        "The Document API is a separate product from the Public Data API — check that your application at " +
        "developer.company-information.service.gov.uk is registered for it, and that you are using the REST key rather than a streaming key.",
    );
    this.name = "DocumentApiUnauthorised";
  }
}

const SKIP_REASONS: Record<string, string> = {
  NO_DOCUMENT: "the accounts filing has no retrievable document.",
  NO_TAGGED_VERSION:
    "accounts were filed on paper or as a scanned PDF, so no machine-readable figures are available.",
  CONTENT_UNAVAILABLE: "the accounts document could not be downloaded.",
};

/**
 * Downloads and parses the most recent filed accounts.
 *
 * Each iXBRL document carries the current year and its comparative, so two
 * filings yield up to four years — enough for the revenue CAGR the growth
 * signals and exit-potential model depend on. Reading more than that costs
 * requests against the rate limit for diminishing returns.
 */
async function readFiledAccounts(
  client: CompaniesHouseClient,
  filings: Array<{ category: string; date: string; links?: { document_metadata?: string } }>,
  companyName: string,
): Promise<{ financials: RawFinancial[]; warnings: string[] }> {
  const warnings: string[] = [];
  const byPeriodEnd = new Map<string, RawFinancial>();

  const accountsFilings = filings
    .filter((f) => f.category === "accounts" && f.links?.document_metadata)
    .slice(0, ACCOUNTS_FILINGS_TO_READ);

  for (const filing of accountsFilings) {
    try {
      const { content: document, reason } = await client.accountsDocument(
        filing.links!.document_metadata!,
      );

      if (!document) {
        if (reason === "NOT_AUTHORISED") {
          // Report once and stop trying — every subsequent company will fail
          // the same way.
          throw new DocumentApiUnauthorised();
        }
        warnings.push(`${companyName}: ${SKIP_REASONS[reason ?? "NO_DOCUMENT"]}`);
        continue;
      }

      const parsed = parseIxbrlAccounts(document);
      if (!parsed.periods.length) {
        warnings.push(
          `${companyName}: accounts filed ${filing.date} carry no tagged data (likely a scanned paper filing).`,
        );
        continue;
      }

      for (const period of parsed.periods) {
        const key = period.periodEnd.toISOString().slice(0, 10);
        // The newest filing wins: a later filing may restate an earlier year.
        if (byPeriodEnd.has(key)) continue;
        byPeriodEnd.set(key, {
          periodEnd: period.periodEnd,
          periodLabel: `FY${String(period.periodEnd.getUTCFullYear()).slice(2)}`,
          revenueGBP: period.revenueGBP,
          grossProfitGBP: period.grossProfitGBP,
          ebitdaGBP: deriveEbitda(document, period),
          pretaxProfitGBP: period.pretaxProfitGBP,
          netAssetsGBP: period.netAssetsGBP,
          cashGBP: period.cashGBP,
          employees: period.employees,
          dividendsDeclaredGBP: period.dividendsGBP,
          isAbridged: period.isAbridged,
          evidence: "FILED",
        });
      }
    } catch (err) {
      // A Document API authorisation failure is systemic — let it propagate so
      // the connector reports it once rather than once per company.
      if (err instanceof DocumentApiUnauthorised) throw err;
      // One unreadable document must not abandon the company, let alone the run.
      warnings.push(
        `${companyName}: could not read accounts filed ${filing.date}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return {
    financials: [...byPeriodEnd.values()].sort(
      (a, b) => a.periodEnd.getTime() - b.periodEnd.getTime(),
    ),
    warnings,
  };
}

function namesMatch(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean);
  const [x, y] = [norm(a), norm(b)];
  if (!x.length || !y.length) return false;
  // Same surname and same first initial is the standard register heuristic.
  return x[x.length - 1] === y[y.length - 1] && x[0][0] === y[0][0];
}

function titleForRole(role: string): string {
  const map: Record<string, string> = {
    director: "Director",
    "corporate-director": "Corporate Director",
    secretary: "Company Secretary",
    "llp-member": "LLP Member",
    "llp-designated-member": "LLP Designated Member",
  };
  return map[role] ?? role.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function hashFilings(items: CHFilingHistory["items"]): string {
  const key = items
    .slice(0, 10)
    .map((i) => `${i.date}:${i.type}:${i.transaction_id ?? ""}`)
    .join("|");
  // Small, stable, non-cryptographic — this only needs to detect change.
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function filingToSignal(
  companyNumber: string,
  companyName: string,
  f: CHFilingHistory["items"][number],
  occurredOn: Date,
): RawSignal | null {
  const source = chSource(
    `/company/${companyNumber}/filing-history`,
    `${companyName} — filing history`,
    occurredOn,
  );
  const base = {
    occurredOn,
    companyNumber,
    companyName,
    source,
    confidence: 90,
  };

  if (f.category === "officers" && /appointment/i.test(f.description)) {
    return {
      ...base,
      type: "DIRECTOR_APPOINTMENT",
      title: `Director appointed at ${companyName}`,
      summary: f.description,
      weight: 35,
      dedupeKey: `ch:${companyNumber}:officer:${f.transaction_id ?? f.date}`,
    };
  }
  if (f.category === "persons-with-significant-control") {
    return {
      ...base,
      type: "PSC_CHANGE",
      title: `Change to persons with significant control at ${companyName}`,
      summary: f.description,
      weight: 60,
      dedupeKey: `ch:${companyNumber}:psc:${f.transaction_id ?? f.date}`,
    };
  }
  if (f.category === "capital" && /purchase|cancellation|transfer|allot/i.test(f.description)) {
    return {
      ...base,
      type: "SHARE_SALE",
      title: `Share capital transaction at ${companyName}`,
      summary: f.description,
      weight: 65,
      dedupeKey: `ch:${companyNumber}:capital:${f.transaction_id ?? f.date}`,
    };
  }
  if (f.category === "accounts") {
    return {
      ...base,
      type: "FILING_UPDATE",
      title: `New accounts filed by ${companyName}`,
      summary: f.description,
      weight: 45,
      dedupeKey: `ch:${companyNumber}:accounts:${f.transaction_id ?? f.date}`,
    };
  }
  return null;
}
