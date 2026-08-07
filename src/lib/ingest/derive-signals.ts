import { ASSUMPTIONS } from "@/lib/scoring/assumptions";
import { revenueCagr, pretaxMargin, type FinancialPeriod } from "@/lib/scoring/valuation";
import type { RawSignal } from "./types";

/**
 * Signals derived from filed accounts rather than found in the wild.
 *
 * These are the highest-quality wealth signals available, because they come
 * from statutory filings: a £3m distribution in the accounts is a fact, where a
 * newspaper saying someone "is worth millions" is not.
 */
export function deriveFinancialSignals(input: {
  companyNumber: string | null;
  companyName: string;
  financials: FinancialPeriod[];
  dividendsByPeriod: Array<{ periodEnd: Date; totalGBP: number }>;
  sourceUrl?: string;
}): RawSignal[] {
  const out: RawSignal[] = [];
  const id = input.companyNumber ?? slug(input.companyName);
  const periods = [...input.financials].sort(
    (a, b) => b.periodEnd.getTime() - a.periodEnd.getTime(),
  );
  const latest = periods[0];

  // --- Large dividend -----------------------------------------------------
  for (const d of input.dividendsByPeriod) {
    if (d.totalGBP < ASSUMPTIONS.largeDividendThresholdGBP) continue;
    out.push({
      type: "LARGE_DIVIDEND",
      title: `${fmt(d.totalGBP)} dividend declared by ${input.companyName}`,
      summary: `Distribution of ${fmt(d.totalGBP)} in the period to ${iso(
        d.periodEnd,
      )}, per filed accounts. Shareholders receive this in proportion to their holdings.`,
      occurredOn: d.periodEnd,
      magnitudeGBP: d.totalGBP,
      weight: d.totalGBP >= 3_000_000 ? 90 : 75,
      confidence: 88,
      payload: { periodEnd: iso(d.periodEnd), totalGBP: d.totalGBP },
      dedupeKey: `fin:${id}:dividend:${iso(d.periodEnd)}`,
      companyNumber: input.companyNumber ?? undefined,
      companyName: input.companyName,
    });
  }

  // --- Rapid revenue growth ----------------------------------------------
  const cagr = revenueCagr(periods);
  if (cagr !== null && cagr >= ASSUMPTIONS.rapidGrowthPct && latest) {
    const oldest = [...periods].reverse().find((p) => p.revenueGBP);
    out.push({
      type: "REVENUE_GROWTH",
      title: `${input.companyName} revenue growing ${cagr.toFixed(0)}% a year`,
      summary:
        oldest && latest.revenueGBP && oldest.revenueGBP
          ? `Turnover moved from ${fmt(oldest.revenueGBP)} (${oldest.periodEnd.getFullYear()}) to ${fmt(
              latest.revenueGBP,
            )} (${latest.periodEnd.getFullYear()}) in the filed accounts.`
          : `Compound annual revenue growth of ${cagr.toFixed(0)}% across the filed accounts.`,
      occurredOn: latest.periodEnd,
      magnitudeGBP: latest.revenueGBP ?? null,
      weight: cagr >= 50 ? 70 : 55,
      confidence: 85,
      payload: {
        cagrPct: Number(cagr.toFixed(1)),
        fromGBP: oldest?.revenueGBP ?? null,
        toGBP: latest.revenueGBP ?? null,
      },
      dedupeKey: `fin:${id}:growth:${iso(latest.periodEnd)}`,
      companyNumber: input.companyNumber ?? undefined,
      companyName: input.companyName,
    });
  }

  // --- High profitability -------------------------------------------------
  const margin = pretaxMargin(latest);
  if (margin !== null && margin >= ASSUMPTIONS.highProfitabilityPct && latest) {
    out.push({
      type: "HIGH_PROFITABILITY",
      title: `${input.companyName} at a ${margin.toFixed(0)}% pre-tax margin`,
      summary: `Pre-tax profit of ${fmt(latest.pretaxProfitGBP ?? 0)} on turnover of ${fmt(
        latest.revenueGBP ?? 0,
      )} in the year to ${iso(latest.periodEnd)}. High margins support both valuation and distributable reserves.`,
      occurredOn: latest.periodEnd,
      magnitudeGBP: latest.pretaxProfitGBP ?? null,
      weight: 50,
      confidence: 85,
      payload: { marginPct: Number(margin.toFixed(1)) },
      dedupeKey: `fin:${id}:margin:${iso(latest.periodEnd)}`,
      companyNumber: input.companyNumber ?? undefined,
      companyName: input.companyName,
    });
  }

  return out;
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `£${(n / 1_000_000_000).toFixed(2)}bn`;
  if (Math.abs(n) >= 1_000_000) return `£${(n / 1_000_000).toFixed(1)}m`;
  if (Math.abs(n) >= 1_000) return `£${(n / 1_000).toFixed(0)}k`;
  return `£${Math.round(n)}`;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
