/**
 * Every constant the wealth model uses, in one place, exported so the UI can
 * render them on the Methodology page. If an advisor disagrees with an
 * assumption they can see it, change it here, and re-run the estimate — that is
 * the whole point of keeping them out of the algorithm body.
 */

export const MODEL_VERSION = "1.2.0";

export const ASSUMPTIONS = {
  /** Discount for lack of marketability on unquoted shares, by control level. */
  dlomMinority: 0.3, // <25%
  dlomSignificant: 0.25, // 25–50%
  dlomControl: 0.18, // >50%

  /** Share of a private stake treated as investable *today* (i.e. pre-exit). */
  liquidityPrivateStake: 0.04,
  /** Raised when a live exit process or IPO preparation signal exists. */
  liquidityPrivateStakeInExit: 0.35,
  liquidityRealisedExit: 0.95,
  liquidityDividends: 0.9,
  liquidityRemuneration: 0.85,
  liquidityPublicHoldings: 0.9,
  liquidityReported: 0.6,

  /** Effective CGT on a business disposal (blend of BADR band and main rate). */
  exitTaxRate: 0.22,
  /** Additional-rate dividend tax. */
  dividendTaxRate: 0.3935,
  /** Share of post-tax dividends assumed retained rather than spent. */
  dividendRetentionRate: 0.6,
  dividendRetentionLow: 0.4,
  dividendRetentionHigh: 0.75,
  /** Years of dividend history rolled into accumulated wealth. */
  dividendLookbackYears: 7,

  /** Effective income tax + NI on senior remuneration. */
  remunerationTaxRate: 0.45,
  /** Share of post-tax remuneration assumed saved by a high earner. */
  remunerationSavingsRate: 0.3,
  remunerationLookbackYears: 6,

  /** Compounding applied to historic retained cash to bring it to today. */
  realReturnRate: 0.04,

  /** Uncertainty widening applied when accounts are abridged (no turnover). */
  abridgedAccountsSpread: 0.45,
  /** Extra spread per full year since the latest filed accounts. */
  stalenessSpreadPerYear: 0.08,

  /** A dividend at or above this is a headline wealth signal. */
  largeDividendThresholdGBP: 2_000_000,
  /** Revenue CAGR at or above this counts as "rapid growth". */
  rapidGrowthPct: 25,
  /** Pre-tax margin at or above this counts as "highly profitable". */
  highProfitabilityPct: 20,
} as const;

export type Assumptions = typeof ASSUMPTIONS;

export const ASSUMPTION_NOTES: Record<keyof Assumptions, string> = {
  dlomMinority: "Unquoted minority stakes are discounted 30% for lack of marketability.",
  dlomSignificant: "25–50% stakes carry a 25% marketability discount.",
  dlomControl: "Controlling stakes are more saleable; discount reduced to 18%.",
  liquidityPrivateStake:
    "Only 4% of an unquoted stake is treated as investable today — founder equity is paper wealth until an exit.",
  liquidityPrivateStakeInExit:
    "Raised to 35% when an IPO-preparation or M&A signal indicates a live process.",
  liquidityRealisedExit: "Realised sale proceeds are treated as 95% investable.",
  liquidityDividends: "Retained dividend income is treated as 90% investable.",
  liquidityRemuneration: "Accumulated savings from salary are treated as 85% investable.",
  liquidityPublicHoldings: "Listed holdings are 90% investable, allowing for lock-ups.",
  liquidityReported: "Third-party reported wealth is 60% investable absent a breakdown.",
  exitTaxRate: "22% effective CGT applied to disposal proceeds.",
  dividendTaxRate: "39.35% additional-rate dividend tax applied to distributions.",
  dividendRetentionRate: "60% of post-tax dividends assumed retained rather than spent.",
  dividendRetentionLow: "Low case assumes 40% retention.",
  dividendRetentionHigh: "High case assumes 75% retention.",
  dividendLookbackYears: "Seven years of dividend history are accumulated.",
  remunerationTaxRate: "45% effective tax and NI on senior remuneration.",
  remunerationSavingsRate: "30% of post-tax remuneration assumed saved.",
  remunerationLookbackYears: "Six years of remuneration are accumulated.",
  realReturnRate: "Historic retained cash is rolled forward at 4% real.",
  abridgedAccountsSpread:
    "Abridged accounts hide turnover, so the estimate range widens by 45%.",
  stalenessSpreadPerYear: "The range widens 8% for each year since the last filed accounts.",
  largeDividendThresholdGBP: "Distributions of £2m+ are flagged as a wealth signal.",
  rapidGrowthPct: "Revenue CAGR of 25%+ is flagged as rapid growth.",
  highProfitabilityPct: "A pre-tax margin of 20%+ is flagged as high profitability.",
};
