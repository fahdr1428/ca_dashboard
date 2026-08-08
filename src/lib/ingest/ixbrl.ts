/**
 * iXBRL accounts parser.
 *
 * This is what makes the wealth model work on real data. The Companies House
 * REST API gives you the register — who owns what — but not the numbers. The
 * numbers live inside the filed accounts, published as Inline XBRL (iXBRL)
 * through the Document API: XHTML with machine-readable facts tagged in place.
 *
 * Without this, a live ingest produces companies with no turnover or profit,
 * every valuation comes out at zero, and nobody qualifies. With it, turnover,
 * profit, net assets, cash and — critically for this dashboard — dividends come
 * straight from a statutory filing, which is the strongest evidence available.
 *
 * Two things make real filings awkward:
 *
 *  1. Tag names vary by taxonomy version and by the software that produced the
 *     accounts. FRS 102 filings from 2015 don't look like 2024 ones, and every
 *     filing agent picks slightly different elements. So each figure is matched
 *     against a list of known aliases, in preference order.
 *  2. Facts are bound to contexts, not to periods directly. A single document
 *     carries the current year, the comparative year, and often segment
 *     breakdowns. We resolve contexts to date ranges and only report the periods
 *     we can place confidently.
 */

export interface IxbrlPeriod {
  /** End of the accounting period. */
  periodEnd: Date;
  periodStart: Date | null;
  revenueGBP: number | null;
  grossProfitGBP: number | null;
  operatingProfitGBP: number | null;
  pretaxProfitGBP: number | null;
  netAssetsGBP: number | null;
  cashGBP: number | null;
  dividendsGBP: number | null;
  employees: number | null;
  /**
   * True when turnover is absent. Small companies filing abridged or
   * filleted accounts are not required to disclose it, and the wealth model
   * widens its error bars when that is the case rather than guessing.
   */
  isAbridged: boolean;
}

export interface IxbrlResult {
  periods: IxbrlPeriod[];
  /** Company registration number, if the document declares it. */
  companyNumber: string | null;
  /** Facts we found but could not place in a period — useful for debugging. */
  unplacedFactCount: number;
  warnings: string[];
}

/**
 * Element name aliases, in preference order. Names are matched on the local
 * part only, case-insensitively, so namespace prefixes (`core:`, `ns5:`,
 * `uk-gaap:`) don't matter.
 */
const CONCEPTS = {
  revenue: [
    "TurnoverRevenue",
    "Turnover",
    "Revenue",
    "TurnoverGrossOperatingRevenue",
    "GrossRevenue",
  ],
  grossProfit: ["GrossProfitLoss", "GrossProfit"],
  operatingProfit: ["OperatingProfitLoss", "OperatingProfit"],
  pretaxProfit: [
    "ProfitLossOnOrdinaryActivitiesBeforeTax",
    "ProfitLossBeforeTax",
    "ProfitLossOnOrdinaryActivitiesBeforeTaxation",
  ],
  profit: ["ProfitLoss", "ProfitLossForPeriod"],
  netAssets: [
    "NetAssetsLiabilities",
    "NetAssetsLiabilitiesIncludingPensionAssetLiability",
    "ShareholdersFunds",
    "Equity",
    "TotalEquity",
  ],
  cash: [
    "CashBankOnHand",
    "CashBankInHand",
    "CashAndCashEquivalents",
    "CashCashEquivalents",
  ],
  dividends: [
    "DividendsPaid",
    "DividendsPaidOnShares",
    "DividendsPaidClassOfShares",
    "DistributionsToOwners",
    "DividendsOnOrdinaryShares",
    "DividendsPaidPayableOnShares",
  ],
  employees: [
    "AverageNumberEmployeesDuringPeriod",
    "AverageNumberOfEmployeesDuringPeriod",
    "NumberOfEmployees",
  ],
  depreciation: [
    "DepreciationAmortisationImpairmentExpense",
    "DepreciationExpensePropertyPlantEquipment",
    "DepreciationAmortisationExpense",
  ],
} as const;

interface Fact {
  concept: string;
  contextRef: string;
  value: number;
}

interface Context {
  id: string;
  startDate: Date | null;
  endDate: Date | null;
  instant: Date | null;
  /** Contexts carrying dimensional breakdowns are segment detail, not totals. */
  hasDimensions: boolean;
}

export function parseIxbrlAccounts(html: string): IxbrlResult {
  const warnings: string[] = [];
  const contexts = parseContexts(html);
  const facts = parseFacts(html);

  if (!facts.length) {
    return {
      periods: [],
      companyNumber: extractCompanyNumber(html),
      unplacedFactCount: 0,
      warnings: ["No tagged iXBRL facts found — the document may be a scanned PDF."],
    };
  }

  // Only consolidated totals matter; dimensional contexts are segment splits
  // that would otherwise be double-counted.
  const usableContexts = new Map(
    [...contexts.values()].filter((c) => !c.hasDimensions).map((c) => [c.id, c]),
  );

  // --- Group duration facts by the period they cover ----------------------
  // Keyed on the period end date, since that is how accounts are identified.
  const byPeriodEnd = new Map<
    string,
    { start: Date | null; end: Date; duration: Fact[]; instant: Fact[] }
  >();

  let unplaced = 0;

  for (const fact of facts) {
    const context = usableContexts.get(fact.contextRef);
    if (!context) {
      unplaced++;
      continue;
    }

    if (context.endDate) {
      const key = iso(context.endDate);
      const bucket =
        byPeriodEnd.get(key) ??
        { start: context.startDate, end: context.endDate, duration: [], instant: [] };
      bucket.duration.push(fact);
      if (!bucket.start && context.startDate) bucket.start = context.startDate;
      byPeriodEnd.set(key, bucket);
    } else if (context.instant) {
      const key = iso(context.instant);
      const bucket =
        byPeriodEnd.get(key) ?? { start: null, end: context.instant, duration: [], instant: [] };
      bucket.instant.push(fact);
      byPeriodEnd.set(key, bucket);
    } else {
      unplaced++;
    }
  }

  const periods: IxbrlPeriod[] = [];

  for (const bucket of byPeriodEnd.values()) {
    // A duration context spanning far less than a year is usually a stub or a
    // note disclosure, not the reporting period.
    const months =
      bucket.start && bucket.end
        ? (bucket.end.getTime() - bucket.start.getTime()) / (30.44 * 24 * 3600 * 1000)
        : null;
    if (months !== null && months < 6) continue;

    const all = [...bucket.duration, ...bucket.instant];
    const pick = (aliases: readonly string[]) => firstMatch(all, aliases);

    const revenue = pick(CONCEPTS.revenue);
    const pretax = pick(CONCEPTS.pretaxProfit) ?? pick(CONCEPTS.profit);
    const operating = pick(CONCEPTS.operatingProfit);
    const netAssets = pick(CONCEPTS.netAssets);
    const cash = pick(CONCEPTS.cash);
    // Dividends are frequently tagged as a negative (a distribution out).
    const dividendsRaw = pick(CONCEPTS.dividends);
    const employees = pick(CONCEPTS.employees);

    // Nothing usable in this context group — skip rather than emit an empty row.
    if (
      revenue === null &&
      pretax === null &&
      operating === null &&
      netAssets === null &&
      cash === null &&
      dividendsRaw === null
    ) {
      continue;
    }

    periods.push({
      periodEnd: bucket.end,
      periodStart: bucket.start,
      revenueGBP: revenue,
      grossProfitGBP: pick(CONCEPTS.grossProfit),
      operatingProfitGBP: operating,
      pretaxProfitGBP: pretax,
      netAssetsGBP: netAssets,
      cashGBP: cash,
      dividendsGBP: dividendsRaw === null ? null : Math.abs(dividendsRaw),
      employees: employees === null ? null : Math.round(employees),
      isAbridged: revenue === null,
    });
  }

  // Merge balance-sheet-only rows into the P&L period they belong to. A
  // balance sheet is dated the same day the accounting period ends, so an
  // instant context on that date is the same set of accounts.
  const merged = mergeSameDatePeriods(periods);
  merged.sort((a, b) => b.periodEnd.getTime() - a.periodEnd.getTime());

  if (merged.some((p) => p.isAbridged)) {
    warnings.push(
      "Turnover is not disclosed in at least one period — the company files abridged or filleted accounts.",
    );
  }

  return {
    periods: merged,
    companyNumber: extractCompanyNumber(html),
    unplacedFactCount: unplaced,
    warnings,
  };
}

/** Estimate EBITDA where the accounts disclose enough to derive it. */
export function deriveEbitda(html: string, period: IxbrlPeriod): number | null {
  const operating = period.operatingProfitGBP ?? period.pretaxProfitGBP;
  if (operating === null) return null;
  const contexts = parseContexts(html);
  const facts = parseFacts(html).filter((f) => {
    const c = contexts.get(f.contextRef);
    return c && !c.hasDimensions && c.endDate && iso(c.endDate) === iso(period.periodEnd);
  });
  const depreciation = firstMatch(facts, CONCEPTS.depreciation);
  if (depreciation === null) return null;
  return operating + Math.abs(depreciation);
}

// ---------------------------------------------------------------------------
// Low-level parsing
// ---------------------------------------------------------------------------

function parseContexts(html: string): Map<string, Context> {
  const contexts = new Map<string, Context>();
  // Prefix-agnostic: xbrli:context, xbrl:context, or bare context.
  const blocks = html.match(/<(?:[\w-]+:)?context\b[\s\S]*?<\/(?:[\w-]+:)?context>/gi) ?? [];

  for (const block of blocks) {
    const id = block.match(/\bid=["']([^"']+)["']/i)?.[1];
    if (!id) continue;

    const startDate = date(block.match(/<(?:[\w-]+:)?startDate>([^<]+)</i)?.[1]);
    const endDate = date(block.match(/<(?:[\w-]+:)?endDate>([^<]+)</i)?.[1]);
    const instant = date(block.match(/<(?:[\w-]+:)?instant>([^<]+)</i)?.[1]);

    contexts.set(id, {
      id,
      startDate,
      endDate,
      instant,
      hasDimensions: /explicitMember|typedMember/i.test(block),
    });
  }
  return contexts;
}

function parseFacts(html: string): Fact[] {
  const facts: Fact[] = [];
  // ix:nonFraction carries every numeric fact. Self-closing tags carry no value
  // and are skipped by the pattern requiring a closing tag.
  const pattern = /<(?:[\w-]+:)?nonFraction\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?nonFraction>/gi;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const attrs = match[1];
    const raw = match[2];

    const name = attr(attrs, "name");
    const contextRef = attr(attrs, "contextRef") ?? attr(attrs, "contextref");
    if (!name || !contextRef) continue;

    const value = parseFactValue(raw, attrs);
    if (value === null) continue;

    facts.push({ concept: localName(name), contextRef, value });
  }
  return facts;
}

/**
 * Turns a tagged value into a number, honouring the iXBRL `scale` and `sign`
 * attributes. `scale="3"` means the displayed figure is in thousands;
 * `sign="-"` means the displayed figure is positive but the fact is negative.
 * Getting either wrong misstates a company's accounts by orders of magnitude.
 */
function parseFactValue(raw: string, attrs: string): number | null {
  const text = raw
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/[£$€,\s]/g, "")
    .trim();

  if (!text || text === "-" || text === "—") return null;

  // Accounts show negatives in brackets.
  const bracketed = /^\((.*)\)$/.exec(text);
  const digits = bracketed ? bracketed[1] : text;
  if (!/^-?\d*\.?\d+$/.test(digits)) return null;

  let value = Number(digits);
  if (!Number.isFinite(value)) return null;
  if (bracketed) value = -value;

  const scale = Number(attr(attrs, "scale") ?? "0");
  if (Number.isFinite(scale) && scale !== 0) value *= Math.pow(10, scale);

  if (attr(attrs, "sign") === "-") value = -Math.abs(value);

  return value;
}

/** First alias with a value wins, so preference order is respected. */
function firstMatch(facts: Fact[], aliases: readonly string[]): number | null {
  for (const alias of aliases) {
    const target = alias.toLowerCase();
    const hit = facts.find((f) => f.concept === target);
    if (hit) return hit.value;
  }
  return null;
}

function mergeSameDatePeriods(periods: IxbrlPeriod[]): IxbrlPeriod[] {
  const byDate = new Map<string, IxbrlPeriod>();
  for (const p of periods) {
    const key = iso(p.periodEnd);
    const existing = byDate.get(key);
    if (!existing) {
      byDate.set(key, { ...p });
      continue;
    }
    // Prefer whichever row actually has each figure.
    existing.revenueGBP ??= p.revenueGBP;
    existing.grossProfitGBP ??= p.grossProfitGBP;
    existing.operatingProfitGBP ??= p.operatingProfitGBP;
    existing.pretaxProfitGBP ??= p.pretaxProfitGBP;
    existing.netAssetsGBP ??= p.netAssetsGBP;
    existing.cashGBP ??= p.cashGBP;
    existing.dividendsGBP ??= p.dividendsGBP;
    existing.employees ??= p.employees;
    existing.periodStart ??= p.periodStart;
    existing.isAbridged = existing.revenueGBP === null;
  }
  return [...byDate.values()];
}

function extractCompanyNumber(html: string): string | null {
  const tagged = html.match(
    /<(?:[\w-]+:)?nonNumeric\b[^>]*name=["'][^"']*(?:UKCompaniesHouseRegisteredNumber|CompanyNumber)["'][^>]*>([\s\S]*?)</i,
  );
  if (tagged) {
    const cleaned = tagged[1].replace(/<[^>]+>/g, "").trim();
    if (/^[A-Z0-9]{6,10}$/i.test(cleaned)) return cleaned.toUpperCase();
  }
  const inline = html.match(/(?:company\s+(?:registration\s+)?number|registered\s+number)[:\s]*([A-Z0-9]{6,10})/i);
  return inline ? inline[1].toUpperCase() : null;
}

function attr(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i");
  return attrs.match(re)?.[1] ?? null;
}

function localName(name: string): string {
  return name.includes(":") ? name.slice(name.indexOf(":") + 1).toLowerCase() : name.toLowerCase();
}

function date(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
