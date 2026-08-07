import { resolveRegion } from "@/lib/regions";
import type {
  Connector,
  ConnectorContext,
  ConnectorResult,
  RawCompany,
  RawProspect,
  RawShareholding,
  RawSignal,
  RawSource,
} from "./types";
import { emptyResult } from "./types";
import { sicToIndustry } from "./sic";

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
  private limiter = new RateLimiter();
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
  }>;
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
        } catch (err) {
          result.warnings.push(
            `Companies House search for ${location} stopped at page ${page}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      ctx.log(
        `Companies House: ${result.companies.length} companies, ${result.prospects.length} controlling individuals, ${client.requestsUsed} API requests used.`,
      );
      return result;
    },
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
