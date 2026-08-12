/**
 * Verification status.
 *
 * The brief is explicit: show actual figures where they can be verified, and
 * where they cannot, say *why* and attach a confidence. This module is the
 * single place that decides which of those a given number is.
 *
 * Three grades, and the distinction between them matters more than any of the
 * numbers themselves:
 *
 *   FILED         The company stated this figure in a statutory filing. It is a
 *                 fact. Displayed plainly, with a link to the filing.
 *   NOT_DISCLOSED The company was not required to state it, or did not. Shown as
 *                 "not disclosed" with the reason — never as zero, and never
 *                 quietly filled in with a guess.
 *   MODELLED      This system derived it. Always labelled, always accompanied by
 *                 its method and its confidence.
 */

export type FactGrade = "FILED" | "NOT_DISCLOSED" | "MODELLED";

export interface FactProvenance {
  grade: FactGrade;
  /** Plain-English reason, shown to the advisor. Required for anything not FILED. */
  reason: string | null;
  /** 0-100. Only meaningful for MODELLED figures. */
  confidence: number | null;
  /** The filing or document this came from, when there is one. */
  sourceUrl: string | null;
  asOf: Date | null;
}

export interface CompanyFactInput {
  companyNumber: string | null;
  latestPeriodEnd: Date | null;
  isAbridged: boolean;
  hasAnyAccounts: boolean;
  revenueGBP: number | null;
  pretaxProfitGBP: number | null;
  netAssetsGBP: number | null;
  cashGBP: number | null;
  dividendsGBP: number | null;
  valuationMidGBP: number;
  valuationMethod: string | null;
  valuationBasisIsTransaction: boolean;
}

export type CompanyFactKey =
  | "revenue"
  | "pretaxProfit"
  | "netAssets"
  | "cash"
  | "dividends"
  | "valuation";

export const FACT_LABELS: Record<CompanyFactKey, string> = {
  revenue: "Turnover",
  pretaxProfit: "Pre-tax profit",
  netAssets: "Net assets",
  cash: "Cash at bank",
  dividends: "Dividends declared",
  valuation: "Equity value",
};

function filingUrl(companyNumber: string | null): string | null {
  return companyNumber
    ? `https://find-and-update.company-information.service.gov.uk/company/${companyNumber}/filing-history`
    : null;
}

/**
 * Grades each headline company figure. The reasons are specific because "no
 * data" is not actionable, whereas "this company files filleted accounts under
 * the small companies regime, so turnover is not on the public record" tells an
 * advisor exactly what they can and cannot say to a client.
 */
export function gradeCompanyFacts(
  input: CompanyFactInput,
): Record<CompanyFactKey, { value: number | null; provenance: FactProvenance }> {
  const source = filingUrl(input.companyNumber);
  const asOf = input.latestPeriodEnd;

  const filed = (value: number | null): FactProvenance => ({
    grade: "FILED",
    reason: null,
    confidence: null,
    sourceUrl: source,
    asOf,
  });

  const notDisclosed = (reason: string): FactProvenance => ({
    grade: "NOT_DISCLOSED",
    reason,
    confidence: null,
    sourceUrl: source,
    asOf,
  });

  const noAccountsReason =
    "No accounts have been filed for this company yet, so none of its financials are on the public record. Newly incorporated companies have up to 21 months before their first filing is due.";

  const abridgedReason =
    "The company files abridged or filleted accounts under the small companies regime. Turnover and profit are not required to be disclosed, so they are not on the public record.";

  function gradeFiled(
    value: number | null,
    missingReason: string,
  ): { value: number | null; provenance: FactProvenance } {
    if (!input.hasAnyAccounts) return { value: null, provenance: notDisclosed(noAccountsReason) };
    if (value === null) return { value: null, provenance: notDisclosed(missingReason) };
    return { value, provenance: filed(value) };
  }

  // The valuation is the only figure here this system invents, and its
  // confidence depends entirely on what it had to work with.
  const valuationProvenance: FactProvenance = (() => {
    if (input.valuationMidGBP <= 0) {
      return {
        grade: "NOT_DISCLOSED",
        reason: input.hasAnyAccounts
          ? "Not enough disclosed financial detail to support a valuation. Rather than publish a guess, no figure is given."
          : noAccountsReason,
        confidence: null,
        sourceUrl: source,
        asOf,
      };
    }
    // A real transaction price is close to a fact; a sector multiple is not.
    let confidence = input.valuationBasisIsTransaction ? 78 : input.isAbridged ? 32 : 58;
    if (!input.revenueGBP && !input.valuationBasisIsTransaction) confidence -= 10;

    const staleYears = asOf
      ? (Date.now() - asOf.getTime()) / (365.25 * 24 * 3600 * 1000)
      : null;
    if (staleYears !== null && staleYears > 2) confidence -= 12;

    return {
      grade: "MODELLED",
      reason:
        input.valuationMethod ??
        "Derived from filed financials against sector comparables. An estimate, not a quote or an offer.",
      confidence: Math.max(5, Math.min(100, Math.round(confidence))),
      sourceUrl: source,
      asOf,
    };
  })();

  return {
    revenue: gradeFiled(
      input.revenueGBP,
      input.isAbridged
        ? abridgedReason
        : "Turnover is not tagged in the filed accounts, so it could not be read from the public record.",
    ),
    pretaxProfit: gradeFiled(
      input.pretaxProfitGBP,
      input.isAbridged
        ? abridgedReason
        : "Profit before tax is not tagged in the filed accounts.",
    ),
    netAssets: gradeFiled(
      input.netAssetsGBP,
      "Net assets are not tagged in the filed accounts.",
    ),
    cash: gradeFiled(input.cashGBP, "Cash at bank is not separately disclosed."),
    dividends: gradeFiled(
      input.dividendsGBP,
      "No distribution is disclosed for this period. That may mean none was paid, or that it is not separately tagged — the accounts do not distinguish the two.",
    ),
    valuation: { value: input.valuationMidGBP || null, provenance: valuationProvenance },
  };
}

export interface CompanyVerification {
  /** Share of the headline figures that come from a statutory filing, 0-100. */
  score: number;
  status: "VERIFIED" | "PARTIAL" | "UNVERIFIED";
  label: string;
  summary: string;
  filedCount: number;
  totalCount: number;
}

/** A single verification verdict for a company, for tables and list views. */
export function summariseVerification(
  facts: ReturnType<typeof gradeCompanyFacts>,
): CompanyVerification {
  // The valuation is always modelled, so it is excluded from the ratio; what
  // matters is how much of the *underlying* record is filed fact.
  const keys: CompanyFactKey[] = ["revenue", "pretaxProfit", "netAssets", "cash", "dividends"];
  const filedCount = keys.filter((k) => facts[k].provenance.grade === "FILED").length;
  const score = Math.round((filedCount / keys.length) * 100);

  if (filedCount === 0) {
    return {
      score,
      status: "UNVERIFIED",
      label: "Unverified",
      summary:
        facts.revenue.provenance.reason ??
        "None of this company's financials could be read from the public record.",
      filedCount,
      totalCount: keys.length,
    };
  }
  if (filedCount >= 4) {
    return {
      score,
      status: "VERIFIED",
      label: "Filed accounts",
      summary: `${filedCount} of ${keys.length} headline figures read directly from filed accounts.`,
      filedCount,
      totalCount: keys.length,
    };
  }
  return {
    score,
    status: "PARTIAL",
    label: "Partly filed",
    summary: `${filedCount} of ${keys.length} headline figures are on the public record; the rest are noted with a reason.`,
    filedCount,
    totalCount: keys.length,
  };
}
