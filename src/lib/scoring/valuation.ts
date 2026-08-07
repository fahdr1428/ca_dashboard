import { ASSUMPTIONS } from "./assumptions";

/**
 * Sector valuation comparables for UK private companies. These are broad,
 * publicly-discussed ranges for lower-mid-market deals — they are a modelling
 * prior, not a quote, and the UI always says so.
 */
export interface SectorComp {
  /** EV / EBITDA range. */
  ebitdaLow: number;
  ebitdaMid: number;
  ebitdaHigh: number;
  /** EV / Revenue range, used when EBITDA is unavailable or negative. */
  revenueLow: number;
  revenueMid: number;
  revenueHigh: number;
}

const COMPS: Record<string, SectorComp> = {
  "Software & SaaS": { ebitdaLow: 12, ebitdaMid: 16, ebitdaHigh: 22, revenueLow: 2.5, revenueMid: 4.5, revenueHigh: 8 },
  Technology: { ebitdaLow: 10, ebitdaMid: 14, ebitdaHigh: 19, revenueLow: 1.8, revenueMid: 3.2, revenueHigh: 5.5 },
  Fintech: { ebitdaLow: 11, ebitdaMid: 16, ebitdaHigh: 24, revenueLow: 2.5, revenueMid: 5, revenueHigh: 9 },
  "Healthcare & Life Sciences": { ebitdaLow: 9, ebitdaMid: 13, ebitdaHigh: 18, revenueLow: 1.5, revenueMid: 3, revenueHigh: 6 },
  "Financial Services": { ebitdaLow: 8, ebitdaMid: 11, ebitdaHigh: 15, revenueLow: 1.8, revenueMid: 3, revenueHigh: 5 },
  "Professional Services": { ebitdaLow: 5, ebitdaMid: 7.5, ebitdaHigh: 10, revenueLow: 0.8, revenueMid: 1.3, revenueHigh: 2 },
  "Energy & Renewables": { ebitdaLow: 8, ebitdaMid: 11, ebitdaHigh: 15, revenueLow: 1.5, revenueMid: 2.6, revenueHigh: 4.5 },
  "Manufacturing & Engineering": { ebitdaLow: 5, ebitdaMid: 7, ebitdaHigh: 9.5, revenueLow: 0.7, revenueMid: 1.1, revenueHigh: 1.8 },
  "Food & Beverage": { ebitdaLow: 6, ebitdaMid: 9, ebitdaHigh: 12, revenueLow: 0.8, revenueMid: 1.4, revenueHigh: 2.4 },
  "Consumer & Retail": { ebitdaLow: 5, ebitdaMid: 7.5, ebitdaHigh: 11, revenueLow: 0.6, revenueMid: 1.1, revenueHigh: 2 },
  "Construction & Property": { ebitdaLow: 4, ebitdaMid: 6, ebitdaHigh: 8, revenueLow: 0.5, revenueMid: 0.9, revenueHigh: 1.4 },
  "Transport & Logistics": { ebitdaLow: 5, ebitdaMid: 7, ebitdaHigh: 9.5, revenueLow: 0.6, revenueMid: 1, revenueHigh: 1.6 },
  "Marine & Leisure": { ebitdaLow: 5, ebitdaMid: 7.5, ebitdaHigh: 10, revenueLow: 0.7, revenueMid: 1.2, revenueHigh: 2 },
  "Media & Marketing": { ebitdaLow: 6, ebitdaMid: 8.5, ebitdaHigh: 12, revenueLow: 0.9, revenueMid: 1.5, revenueHigh: 2.6 },
  "Agriculture & Land": { ebitdaLow: 6, ebitdaMid: 9, ebitdaHigh: 13, revenueLow: 1, revenueMid: 1.8, revenueHigh: 3 },
  Default: { ebitdaLow: 5, ebitdaMid: 7.5, ebitdaHigh: 10, revenueLow: 0.8, revenueMid: 1.3, revenueHigh: 2.2 },
};

export const SECTORS = Object.keys(COMPS).filter((k) => k !== "Default");

export function sectorComp(industry: string | null | undefined): SectorComp {
  if (!industry) return COMPS.Default;
  return COMPS[industry] ?? COMPS.Default;
}

export interface FinancialPeriod {
  periodEnd: Date;
  revenueGBP: number | null;
  ebitdaGBP: number | null;
  pretaxProfitGBP: number | null;
  netAssetsGBP: number | null;
  cashGBP: number | null;
  isAbridged: boolean;
}

export interface ValuationResult {
  lowGBP: number;
  midGBP: number;
  highGBP: number;
  /** Plain-English description rendered verbatim next to the number. */
  method: string;
  multiple: number | null;
  basis: "EBITDA_MULTIPLE" | "REVENUE_MULTIPLE" | "NET_ASSETS" | "FUNDING_ROUND" | "NONE";
  asOf: Date | null;
  inputs: Record<string, number | string | null>;
  caveats: string[];
}

/** Compound annual growth rate over the supplied ordered periods. */
export function revenueCagr(periods: FinancialPeriod[]): number | null {
  const withRev = periods
    .filter((p) => p.revenueGBP && p.revenueGBP > 0)
    .sort((a, b) => a.periodEnd.getTime() - b.periodEnd.getTime());
  if (withRev.length < 2) return null;
  const first = withRev[0];
  const last = withRev[withRev.length - 1];
  const years =
    (last.periodEnd.getTime() - first.periodEnd.getTime()) / (365.25 * 24 * 3600 * 1000);
  if (years < 0.9) return null;
  return (Math.pow(last.revenueGBP! / first.revenueGBP!, 1 / years) - 1) * 100;
}

export function pretaxMargin(p: FinancialPeriod | undefined): number | null {
  if (!p?.revenueGBP || !p.pretaxProfitGBP) return null;
  return (p.pretaxProfitGBP / p.revenueGBP) * 100;
}

/**
 * Estimate the equity value of a private company.
 *
 * Order of preference:
 *   1. A priced funding round or completed transaction (best evidence).
 *   2. EBITDA multiple against sector comparables.
 *   3. Revenue multiple, when EBITDA is missing or negative.
 *   4. Net assets, as a floor for asset-heavy or loss-making businesses.
 */
export function valueCompany(input: {
  industry: string | null;
  financials: FinancialPeriod[];
  /** Post-money from the most recent priced round, if any. */
  latestPostMoneyGBP?: number | null;
  latestRoundDate?: Date | null;
  /** Growth premium/discount driven by revenue CAGR. */
  applyGrowthAdjustment?: boolean;
}): ValuationResult {
  const caveats: string[] = [];
  const periods = [...input.financials].sort(
    (a, b) => b.periodEnd.getTime() - a.periodEnd.getTime(),
  );
  const latest = periods[0];
  const comp = sectorComp(input.industry);

  // 1. Priced round wins — it is an actual transaction between real parties.
  if (input.latestPostMoneyGBP && input.latestPostMoneyGBP > 0) {
    const ageYears = input.latestRoundDate
      ? (Date.now() - input.latestRoundDate.getTime()) / (365.25 * 24 * 3600 * 1000)
      : 0;
    // Priced rounds go stale; widen the band as they age.
    const spread = Math.min(0.55, 0.15 + ageYears * 0.12);
    if (ageYears > 1.5) {
      caveats.push(
        `Round price is ${ageYears.toFixed(1)} years old; the valuation band has been widened accordingly.`,
      );
    }
    return {
      lowGBP: Math.round(input.latestPostMoneyGBP * (1 - spread)),
      midGBP: Math.round(input.latestPostMoneyGBP),
      highGBP: Math.round(input.latestPostMoneyGBP * (1 + spread * 0.6)),
      method: `Post-money valuation from the most recent priced funding round${
        input.latestRoundDate ? ` (${input.latestRoundDate.getFullYear()})` : ""
      }.`,
      multiple: null,
      basis: "FUNDING_ROUND",
      asOf: input.latestRoundDate ?? null,
      inputs: { postMoneyGBP: input.latestPostMoneyGBP },
      caveats,
    };
  }

  if (!latest) {
    return {
      lowGBP: 0,
      midGBP: 0,
      highGBP: 0,
      method: "No filed accounts or transaction evidence available — no valuation attempted.",
      multiple: null,
      basis: "NONE",
      asOf: null,
      inputs: {},
      caveats: ["No financial data on file."],
    };
  }

  // Staleness and disclosure quality widen the band rather than shifting it.
  const ageYears = Math.max(
    0,
    (Date.now() - latest.periodEnd.getTime()) / (365.25 * 24 * 3600 * 1000) - 1,
  );
  let extraSpread = ageYears * ASSUMPTIONS.stalenessSpreadPerYear;
  if (ageYears > 0.5) {
    caveats.push(
      `Most recent accounts are to ${latest.periodEnd.toISOString().slice(0, 10)}; figures may have moved since.`,
    );
  }
  if (latest.isAbridged) {
    extraSpread += ASSUMPTIONS.abridgedAccountsSpread;
    caveats.push(
      "Company files abridged accounts, so turnover is not disclosed; revenue-linked inputs are inferred.",
    );
  }

  const cagr = input.applyGrowthAdjustment === false ? null : revenueCagr(periods);
  let growthFactor = 1;
  if (cagr !== null) {
    // ±25% swing across a plausible growth range, clamped.
    growthFactor = 1 + Math.max(-0.2, Math.min(0.35, (cagr - 8) / 100));
    if (cagr >= ASSUMPTIONS.rapidGrowthPct) {
      caveats.push(`Growth premium applied for ${cagr.toFixed(0)}% revenue CAGR.`);
    }
  }

  const netCash = latest.cashGBP ?? 0;
  const ebitda = latest.ebitdaGBP ?? latest.pretaxProfitGBP;

  if (ebitda && ebitda > 0) {
    const ev = (m: number) => ebitda * m * growthFactor;
    const low = Math.max(0, ev(comp.ebitdaLow) * (1 - extraSpread) + netCash);
    const mid = Math.max(0, ev(comp.ebitdaMid) + netCash);
    const high = Math.max(0, ev(comp.ebitdaHigh) * (1 + extraSpread) + netCash);
    return {
      lowGBP: Math.round(low),
      midGBP: Math.round(mid),
      highGBP: Math.round(high),
      method: `${comp.ebitdaLow}–${comp.ebitdaHigh}× EBITDA against ${
        input.industry ?? "generic"
      } sector comparables, plus net cash${
        growthFactor !== 1 ? `, adjusted ${((growthFactor - 1) * 100).toFixed(0)}% for growth` : ""
      }.`,
      multiple: comp.ebitdaMid * growthFactor,
      basis: "EBITDA_MULTIPLE",
      asOf: latest.periodEnd,
      inputs: {
        ebitdaGBP: ebitda,
        netCashGBP: netCash,
        multipleMid: comp.ebitdaMid,
        revenueCagrPct: cagr,
      },
      caveats,
    };
  }

  if (latest.revenueGBP && latest.revenueGBP > 0) {
    caveats.push(
      "Valued on revenue because the business is loss-making or EBITDA is not disclosed; revenue multiples are a blunt instrument.",
    );
    const rv = (m: number) => latest.revenueGBP! * m * growthFactor;
    return {
      lowGBP: Math.round(Math.max(0, rv(comp.revenueLow) * (1 - extraSpread))),
      midGBP: Math.round(Math.max(0, rv(comp.revenueMid))),
      highGBP: Math.round(Math.max(0, rv(comp.revenueHigh) * (1 + extraSpread))),
      method: `${comp.revenueLow}–${comp.revenueHigh}× revenue against ${
        input.industry ?? "generic"
      } sector comparables.`,
      multiple: comp.revenueMid * growthFactor,
      basis: "REVENUE_MULTIPLE",
      asOf: latest.periodEnd,
      inputs: { revenueGBP: latest.revenueGBP, multipleMid: comp.revenueMid, revenueCagrPct: cagr },
      caveats,
    };
  }

  const na = latest.netAssetsGBP ?? 0;
  caveats.push(
    "Neither turnover nor profit is disclosed; valued at filed net assets, which is a floor rather than a market value.",
  );
  return {
    lowGBP: Math.round(na * 0.8),
    midGBP: Math.round(na),
    highGBP: Math.round(na * 1.6),
    method: "Filed net assets, used as a valuation floor where no earnings are disclosed.",
    multiple: null,
    basis: "NET_ASSETS",
    asOf: latest.periodEnd,
    inputs: { netAssetsGBP: na },
    caveats,
  };
}

/**
 * Modelled readiness for a liquidity event, 0–100. Drives the "exit potential"
 * column and the fastest-movers panel.
 */
export function exitPotential(input: {
  cagrPct: number | null;
  marginPct: number | null;
  hasPeBacking: boolean;
  hasIpoSignal: boolean;
  hasMaSignal: boolean;
  companyAgeYears: number | null;
  valuationMidGBP: number;
}): { score: number; rationale: string } {
  const reasons: string[] = [];
  let score = 20;

  if (input.hasIpoSignal) {
    score += 35;
    reasons.push("IPO preparation reported");
  }
  if (input.hasMaSignal) {
    score += 25;
    reasons.push("recent M&A approach or process");
  }
  if (input.hasPeBacking) {
    score += 18;
    reasons.push("private equity on the register (sponsors need an exit)");
  }
  if (input.cagrPct !== null && input.cagrPct >= ASSUMPTIONS.rapidGrowthPct) {
    score += 12;
    reasons.push(`${input.cagrPct.toFixed(0)}% revenue CAGR`);
  }
  if (input.marginPct !== null && input.marginPct >= ASSUMPTIONS.highProfitabilityPct) {
    score += 8;
    reasons.push(`${input.marginPct.toFixed(0)}% pre-tax margin`);
  }
  if (input.companyAgeYears !== null && input.companyAgeYears >= 12) {
    score += 6;
    reasons.push("mature ownership likely approaching succession");
  }
  if (input.valuationMidGBP >= 25_000_000) {
    score += 5;
    reasons.push("scale attractive to trade and sponsor buyers");
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    rationale: reasons.length
      ? `Driven by ${reasons.join("; ")}.`
      : "No active exit indicators; score reflects base rate only.",
  };
}
