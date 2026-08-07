import { ASSUMPTIONS, MODEL_VERSION } from "./assumptions";
import { bandForAmount } from "@/lib/wealth";
import type { WealthBand } from "@/generated/prisma/enums";

/**
 * The wealth model.
 *
 * The output is deliberately a *trace*, not a number. Every pound in
 * `grossMidGBP` is attributable to exactly one component, and every component
 * records the arithmetic and the sources behind it, so an advisor can audit any
 * figure before putting it in front of a client.
 */

export type ComponentKey =
  | "PRIVATE_EQUITY_STAKE"
  | "REALISED_EXIT"
  | "DIVIDEND_ACCUMULATION"
  | "REMUNERATION"
  | "PUBLIC_HOLDINGS"
  | "REPORTED_OR_INHERITED";

export const COMPONENT_LABELS: Record<ComponentKey, string> = {
  PRIVATE_EQUITY_STAKE: "Private company equity",
  REALISED_EXIT: "Realised exit proceeds",
  DIVIDEND_ACCUMULATION: "Accumulated dividends",
  REMUNERATION: "Accumulated remuneration",
  PUBLIC_HOLDINGS: "Listed shareholdings",
  REPORTED_OR_INHERITED: "Reported or inherited wealth",
};

export interface EstimateComponent {
  key: ComponentKey;
  label: string;
  /** What this component attaches to, e.g. the company name. */
  subject: string | null;
  lowGBP: number;
  midGBP: number;
  highGBP: number;
  /** Fraction of the mid figure treated as investable today. */
  liquidityFactor: number;
  investableMidGBP: number;
  /** Plain-English arithmetic, shown verbatim in the UI. */
  method: string;
  inputs: Record<string, number | string | null>;
  evidence: "FILED" | "DISCLOSED" | "REPORTED" | "MODELLED" | "ASSERTED";
  sourceIds: string[];
}

export interface WealthEstimate {
  modelVersion: string;
  computedAt: string;
  grossLowGBP: number;
  grossMidGBP: number;
  grossHighGBP: number;
  investableLowGBP: number;
  investableMidGBP: number;
  investableHighGBP: number;
  wealthBand: WealthBand;
  components: EstimateComponent[];
  caveats: string[];
  /** Snapshot of the constants used, so a historic estimate stays reproducible. */
  assumptions: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface StakeInput {
  companyName: string;
  ownershipPctLow: number;
  ownershipPctHigh: number;
  evidence: EstimateComponent["evidence"];
  valuationLowGBP: number;
  valuationMidGBP: number;
  valuationHighGBP: number;
  valuationMethod: string;
  /** True when an IPO/M&A signal suggests a live process. */
  inExitProcess: boolean;
  sourceIds: string[];
}

export interface ExitInput {
  companyName: string;
  completedOn: Date;
  considerationGBP: number;
  ownershipPct: number;
  evidence: EstimateComponent["evidence"];
  sourceIds: string[];
}

export interface DividendInput {
  companyName: string;
  periodEnd: Date;
  attributedGBP: number;
  evidence: EstimateComponent["evidence"];
  sourceIds: string[];
}

export interface RemunerationInput {
  annualGBP: number;
  years: number;
  evidence: EstimateComponent["evidence"];
  sourceIds: string[];
}

export interface PublicHoldingInput {
  companyName: string;
  valueGBP: number;
  asOf: Date | null;
  evidence: EstimateComponent["evidence"];
  sourceIds: string[];
}

export interface ReportedWealthInput {
  label: string;
  lowGBP: number;
  midGBP: number;
  highGBP: number;
  evidence: EstimateComponent["evidence"];
  sourceIds: string[];
}

export interface EstimateInput {
  stakes: StakeInput[];
  exits: ExitInput[];
  dividends: DividendInput[];
  remuneration: RemunerationInput | null;
  publicHoldings: PublicHoldingInput[];
  reported: ReportedWealthInput[];
  /** Extra caveats gathered upstream (e.g. from the valuation model). */
  inheritedCaveats?: string[];
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const YEAR_MS = 365.25 * 24 * 3600 * 1000;

function dlomFor(ownershipPct: number): number {
  if (ownershipPct > 50) return ASSUMPTIONS.dlomControl;
  if (ownershipPct >= 25) return ASSUMPTIONS.dlomSignificant;
  return ASSUMPTIONS.dlomMinority;
}

/** Roll a historic post-tax sum forward to today at the assumed real return. */
function compound(amount: number, since: Date): number {
  const years = Math.max(0, (Date.now() - since.getTime()) / YEAR_MS);
  return amount * Math.pow(1 + ASSUMPTIONS.realReturnRate, Math.min(years, 15));
}

export function estimateWealth(input: EstimateInput): WealthEstimate {
  const components: EstimateComponent[] = [];
  const caveats: string[] = [...(input.inheritedCaveats ?? [])];

  // Companies the individual has already sold. Their pre-sale stake must not
  // be counted alongside the proceeds of selling it — that would double the
  // headline figure, which is the single easiest way for a model like this to
  // mislead an advisor.
  const soldCompanies = new Set(input.exits.map((e) => e.companyName));

  // --- 1. Private company equity -----------------------------------------
  for (const s of input.stakes) {
    const pctMid = (s.ownershipPctLow + s.ownershipPctHigh) / 2;
    if (pctMid <= 0 || s.valuationMidGBP <= 0) continue;

    if (soldCompanies.has(s.companyName)) {
      caveats.push(
        `${s.companyName}: a completed disposal is on file, so the shareholding is excluded from the estimate and only the realised proceeds are counted. If the individual retained rollover equity, add it manually — this estimate is deliberately conservative.`,
      );
      continue;
    }

    const dlom = dlomFor(pctMid);
    // Low case pairs the low ownership bound with the low valuation, and vice
    // versa — the honest way to combine two independent uncertainties.
    const low = (s.valuationLowGBP * s.ownershipPctLow) / 100 * (1 - dlom);
    const mid = (s.valuationMidGBP * pctMid) / 100 * (1 - dlom);
    const high = (s.valuationHighGBP * s.ownershipPctHigh) / 100 * (1 - dlom);

    const liquidity = s.inExitProcess
      ? ASSUMPTIONS.liquidityPrivateStakeInExit
      : ASSUMPTIONS.liquidityPrivateStake;

    components.push({
      key: "PRIVATE_EQUITY_STAKE",
      label: COMPONENT_LABELS.PRIVATE_EQUITY_STAKE,
      subject: s.companyName,
      lowGBP: Math.round(low),
      midGBP: Math.round(mid),
      highGBP: Math.round(high),
      liquidityFactor: liquidity,
      investableMidGBP: Math.round(mid * liquidity),
      method:
        `${pctMid.toFixed(1)}% of an estimated equity value of ${fmt(s.valuationMidGBP)}, ` +
        `less a ${(dlom * 100).toFixed(0)}% discount for lack of marketability. ` +
        `Valuation basis: ${s.valuationMethod}`,
      inputs: {
        ownershipPctLow: s.ownershipPctLow,
        ownershipPctHigh: s.ownershipPctHigh,
        valuationMidGBP: s.valuationMidGBP,
        dlom,
        liquidityFactor: liquidity,
      },
      evidence: s.evidence === "FILED" ? "MODELLED" : s.evidence,
      sourceIds: s.sourceIds,
    });

    if (s.inExitProcess) {
      caveats.push(
        `${s.companyName}: an exit process is indicated, so a larger share of this stake is treated as near-liquid.`,
      );
    }
  }

  // --- 2. Realised exits --------------------------------------------------
  for (const e of input.exits) {
    const gross = (e.considerationGBP * e.ownershipPct) / 100;
    const net = gross * (1 - ASSUMPTIONS.exitTaxRate);
    const today = compound(net, e.completedOn);
    components.push({
      key: "REALISED_EXIT",
      label: COMPONENT_LABELS.REALISED_EXIT,
      subject: e.companyName,
      lowGBP: Math.round(today * 0.75),
      midGBP: Math.round(today),
      highGBP: Math.round(today * 1.15),
      liquidityFactor: ASSUMPTIONS.liquidityRealisedExit,
      investableMidGBP: Math.round(today * ASSUMPTIONS.liquidityRealisedExit),
      method:
        `${e.ownershipPct.toFixed(1)}% of ${fmt(e.considerationGBP)} consideration on the ` +
        `${e.completedOn.getFullYear()} disposal, less ${(ASSUMPTIONS.exitTaxRate * 100).toFixed(0)}% CGT, ` +
        `rolled forward at ${(ASSUMPTIONS.realReturnRate * 100).toFixed(0)}% real.`,
      inputs: {
        considerationGBP: e.considerationGBP,
        ownershipPct: e.ownershipPct,
        completedOn: e.completedOn.toISOString().slice(0, 10),
        netProceedsGBP: Math.round(net),
      },
      evidence: e.evidence,
      sourceIds: e.sourceIds,
    });
  }

  // --- 3. Accumulated dividends ------------------------------------------
  const cutoff = Date.now() - ASSUMPTIONS.dividendLookbackYears * YEAR_MS;
  const divs = input.dividends.filter((d) => d.periodEnd.getTime() >= cutoff && d.attributedGBP > 0);
  if (divs.length) {
    const byCompany = new Map<string, DividendInput[]>();
    for (const d of divs) {
      const list = byCompany.get(d.companyName) ?? [];
      list.push(d);
      byCompany.set(d.companyName, list);
    }
    for (const [companyName, list] of byCompany) {
      const grossTotal = list.reduce((a, d) => a + d.attributedGBP, 0);
      const postTax = list.map((d) => ({
        net: d.attributedGBP * (1 - ASSUMPTIONS.dividendTaxRate),
        when: d.periodEnd,
      }));
      const mid = postTax.reduce(
        (a, p) => a + compound(p.net * ASSUMPTIONS.dividendRetentionRate, p.when),
        0,
      );
      const low = postTax.reduce(
        (a, p) => a + compound(p.net * ASSUMPTIONS.dividendRetentionLow, p.when),
        0,
      );
      const high = postTax.reduce(
        (a, p) => a + compound(p.net * ASSUMPTIONS.dividendRetentionHigh, p.when),
        0,
      );
      components.push({
        key: "DIVIDEND_ACCUMULATION",
        label: COMPONENT_LABELS.DIVIDEND_ACCUMULATION,
        subject: companyName,
        lowGBP: Math.round(low),
        midGBP: Math.round(mid),
        highGBP: Math.round(high),
        liquidityFactor: ASSUMPTIONS.liquidityDividends,
        investableMidGBP: Math.round(mid * ASSUMPTIONS.liquidityDividends),
        method:
          `${fmt(grossTotal)} of dividends attributed across ${list.length} period${
            list.length === 1 ? "" : "s"
          }, less ${(ASSUMPTIONS.dividendTaxRate * 100).toFixed(1)}% dividend tax, ` +
          `of which ${(ASSUMPTIONS.dividendRetentionLow * 100).toFixed(0)}–${(
            ASSUMPTIONS.dividendRetentionHigh * 100
          ).toFixed(0)}% is assumed retained and invested.`,
        inputs: {
          grossAttributedGBP: Math.round(grossTotal),
          periods: list.length,
          taxRate: ASSUMPTIONS.dividendTaxRate,
        },
        evidence: list.some((d) => d.evidence === "FILED") ? "MODELLED" : "REPORTED",
        sourceIds: [...new Set(list.flatMap((d) => d.sourceIds))],
      });
    }
  }

  // --- 4. Remuneration ----------------------------------------------------
  if (input.remuneration && input.remuneration.annualGBP > 0) {
    const r = input.remuneration;
    const years = Math.min(r.years, ASSUMPTIONS.remunerationLookbackYears);
    const perYearSaved =
      r.annualGBP * (1 - ASSUMPTIONS.remunerationTaxRate) * ASSUMPTIONS.remunerationSavingsRate;
    let mid = 0;
    for (let i = 0; i < years; i++) {
      mid += perYearSaved * Math.pow(1 + ASSUMPTIONS.realReturnRate, i);
    }
    components.push({
      key: "REMUNERATION",
      label: COMPONENT_LABELS.REMUNERATION,
      subject: null,
      lowGBP: Math.round(mid * 0.55),
      midGBP: Math.round(mid),
      highGBP: Math.round(mid * 1.5),
      liquidityFactor: ASSUMPTIONS.liquidityRemuneration,
      investableMidGBP: Math.round(mid * ASSUMPTIONS.liquidityRemuneration),
      method:
        `${fmt(r.annualGBP)} annual remuneration over ${years} years, less ` +
        `${(ASSUMPTIONS.remunerationTaxRate * 100).toFixed(0)}% tax and NI, with ` +
        `${(ASSUMPTIONS.remunerationSavingsRate * 100).toFixed(0)}% assumed saved and compounded.`,
      inputs: { annualGBP: r.annualGBP, years },
      evidence: r.evidence === "FILED" ? "MODELLED" : r.evidence,
      sourceIds: r.sourceIds,
    });
    caveats.push(
      "Savings from remuneration are a behavioural assumption, not an observation; treat this component as the softest part of the estimate.",
    );
  }

  // --- 5. Listed holdings -------------------------------------------------
  for (const h of input.publicHoldings) {
    if (h.valueGBP <= 0) continue;
    components.push({
      key: "PUBLIC_HOLDINGS",
      label: COMPONENT_LABELS.PUBLIC_HOLDINGS,
      subject: h.companyName,
      lowGBP: Math.round(h.valueGBP * 0.85),
      midGBP: Math.round(h.valueGBP),
      highGBP: Math.round(h.valueGBP * 1.15),
      liquidityFactor: ASSUMPTIONS.liquidityPublicHoldings,
      investableMidGBP: Math.round(h.valueGBP * ASSUMPTIONS.liquidityPublicHoldings),
      method: `Disclosed holding in ${h.companyName} valued at ${fmt(h.valueGBP)}${
        h.asOf ? ` as at ${h.asOf.toISOString().slice(0, 10)}` : ""
      }. Market price moves daily.`,
      inputs: { valueGBP: h.valueGBP },
      evidence: h.evidence,
      sourceIds: h.sourceIds,
    });
  }

  // --- 6. Reported / inherited -------------------------------------------
  for (const r of input.reported) {
    components.push({
      key: "REPORTED_OR_INHERITED",
      label: COMPONENT_LABELS.REPORTED_OR_INHERITED,
      subject: r.label,
      lowGBP: Math.round(r.lowGBP),
      midGBP: Math.round(r.midGBP),
      highGBP: Math.round(r.highGBP),
      liquidityFactor: ASSUMPTIONS.liquidityReported,
      investableMidGBP: Math.round(r.midGBP * ASSUMPTIONS.liquidityReported),
      method: `Third-party reported figure (${r.label}). Not independently derived by this system.`,
      inputs: { midGBP: r.midGBP },
      evidence: r.evidence,
      sourceIds: r.sourceIds,
    });
    caveats.push(
      `${r.label} is a published third-party estimate; such lists are frequently inaccurate at the individual level.`,
    );
  }

  const grossLow = sum(components, "lowGBP");
  const grossMid = sum(components, "midGBP");
  const grossHigh = sum(components, "highGBP");

  const investableMid = components.reduce((a, c) => a + c.investableMidGBP, 0);
  const investableLow = components.reduce((a, c) => a + c.lowGBP * c.liquidityFactor, 0);
  const investableHigh = components.reduce((a, c) => a + c.highGBP * c.liquidityFactor, 0);

  if (components.some((c) => c.key === "PRIVATE_EQUITY_STAKE")) {
    caveats.push(
      "Most of this individual's gross wealth is unquoted founder equity. It is not investable until a liquidity event, which is why investable assets are far lower than the headline figure.",
    );
  }

  return {
    modelVersion: MODEL_VERSION,
    computedAt: new Date().toISOString(),
    grossLowGBP: Math.round(grossLow),
    grossMidGBP: Math.round(grossMid),
    grossHighGBP: Math.round(grossHigh),
    investableLowGBP: Math.round(investableLow),
    investableMidGBP: Math.round(investableMid),
    investableHighGBP: Math.round(investableHigh),
    wealthBand: bandForAmount(Math.round(investableMid)),
    components,
    caveats: [...new Set(caveats)],
    assumptions: { ...ASSUMPTIONS },
  };
}

function sum(cs: EstimateComponent[], key: "lowGBP" | "midGBP" | "highGBP"): number {
  return cs.reduce((a, c) => a + c[key], 0);
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `£${(n / 1_000_000_000).toFixed(2)}bn`;
  if (Math.abs(n) >= 1_000_000) return `£${(n / 1_000_000).toFixed(1)}m`;
  if (Math.abs(n) >= 1_000) return `£${(n / 1_000).toFixed(0)}k`;
  return `£${Math.round(n)}`;
}
