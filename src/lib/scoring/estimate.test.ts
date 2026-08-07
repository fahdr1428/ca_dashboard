import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { estimateWealth, type EstimateInput } from "./estimate";
import { ASSUMPTIONS } from "./assumptions";
import { ownershipFromNaturesOfControl } from "@/lib/ingest/companies-house";
import { resolveRegion, isInScope } from "@/lib/regions";
import { bandForAmount, confidenceBandFor, formatGBP, formatOwnership } from "@/lib/wealth";
import { startOfIsoWeek, endOfIsoWeek } from "@/lib/utils";
import { valueCompany, revenueCagr } from "./valuation";

function emptyInput(): EstimateInput {
  return { stakes: [], exits: [], dividends: [], remuneration: null, publicHoldings: [], reported: [] };
}

const YEAR_MS = 365.25 * 24 * 3600 * 1000;

describe("estimateWealth", () => {
  test("a founder's unquoted stake is mostly not investable", () => {
    const result = estimateWealth({
      ...emptyInput(),
      stakes: [
        {
          companyName: "Example Ltd",
          ownershipPctLow: 50,
          ownershipPctHigh: 75,
          evidence: "FILED",
          valuationLowGBP: 60_000_000,
          valuationMidGBP: 80_000_000,
          valuationHighGBP: 100_000_000,
          valuationMethod: "8x EBITDA",
          inExitProcess: false,
          sourceIds: [],
        },
      ],
    });

    // 62.5% of £80m, less an 18% control-stake marketability discount.
    assert.equal(result.grossMidGBP, Math.round(80_000_000 * 0.625 * (1 - ASSUMPTIONS.dlomControl)));
    // The whole point of the model: paper wealth is not a mandate.
    assert.ok(
      result.investableMidGBP < result.grossMidGBP * 0.1,
      "unquoted equity should be almost entirely illiquid",
    );
    assert.equal(result.wealthBand, "BELOW_7_5M");
  });

  test("a live exit process raises the liquid share of the same stake", () => {
    const base = {
      companyName: "Example Ltd",
      ownershipPctLow: 50,
      ownershipPctHigh: 75,
      evidence: "FILED" as const,
      valuationLowGBP: 60_000_000,
      valuationMidGBP: 80_000_000,
      valuationHighGBP: 100_000_000,
      valuationMethod: "8x EBITDA",
      sourceIds: [],
    };
    const quiet = estimateWealth({ ...emptyInput(), stakes: [{ ...base, inExitProcess: false }] });
    const inPlay = estimateWealth({ ...emptyInput(), stakes: [{ ...base, inExitProcess: true }] });

    assert.equal(quiet.grossMidGBP, inPlay.grossMidGBP, "gross wealth is unchanged");
    assert.ok(inPlay.investableMidGBP > quiet.investableMidGBP * 5);
  });

  // Regression: counting a pre-sale stake alongside the proceeds of selling it
  // roughly doubles the headline figure. That is the easiest way for a model
  // like this to badly mislead an advisor.
  test("does not double-count a stake that has already been sold", () => {
    const stake = {
      companyName: "Sold Ltd",
      ownershipPctLow: 50,
      ownershipPctHigh: 75,
      evidence: "FILED" as const,
      valuationLowGBP: 60_000_000,
      valuationMidGBP: 80_000_000,
      valuationHighGBP: 100_000_000,
      valuationMethod: "8x EBITDA",
      inExitProcess: false,
      sourceIds: [],
    };
    const exit = {
      companyName: "Sold Ltd",
      completedOn: new Date(Date.now() - YEAR_MS),
      considerationGBP: 96_000_000,
      ownershipPct: 62.5,
      evidence: "REPORTED" as const,
      sourceIds: [],
    };

    const result = estimateWealth({ ...emptyInput(), stakes: [stake], exits: [exit] });

    assert.equal(
      result.components.filter((c) => c.key === "PRIVATE_EQUITY_STAKE").length,
      0,
      "the sold stake must be excluded",
    );
    assert.equal(result.components.filter((c) => c.key === "REALISED_EXIT").length, 1);
    assert.ok(
      result.caveats.some((c) => c.includes("completed disposal")),
      "the exclusion must be disclosed as a caveat, not hidden",
    );
    // Proceeds are now genuinely investable.
    assert.ok(result.investableMidGBP > result.grossMidGBP * 0.9);
  });

  test("dividends are taxed and only partly retained", () => {
    const result = estimateWealth({
      ...emptyInput(),
      dividends: [
        {
          companyName: "Payer Ltd",
          periodEnd: new Date(),
          attributedGBP: 1_000_000,
          evidence: "FILED",
          sourceIds: [],
        },
      ],
    });
    const postTax = 1_000_000 * (1 - ASSUMPTIONS.dividendTaxRate);
    assert.equal(result.grossMidGBP, Math.round(postTax * ASSUMPTIONS.dividendRetentionRate));
    assert.ok(result.grossLowGBP < result.grossMidGBP);
    assert.ok(result.grossHighGBP > result.grossMidGBP);
  });

  test("dividends outside the lookback window are dropped", () => {
    const stale = estimateWealth({
      ...emptyInput(),
      dividends: [
        {
          companyName: "Payer Ltd",
          periodEnd: new Date(Date.now() - (ASSUMPTIONS.dividendLookbackYears + 2) * YEAR_MS),
          attributedGBP: 5_000_000,
          evidence: "FILED",
          sourceIds: [],
        },
      ],
    });
    assert.equal(stale.components.length, 0);
    assert.equal(stale.grossMidGBP, 0);
  });

  test("an empty input produces zeros, not NaN", () => {
    const result = estimateWealth(emptyInput());
    assert.equal(result.grossMidGBP, 0);
    assert.equal(result.investableMidGBP, 0);
    assert.equal(result.wealthBand, "BELOW_7_5M");
  });

  test("low/high bounds always bracket the midpoint", () => {
    const result = estimateWealth({
      ...emptyInput(),
      stakes: [
        {
          companyName: "A Ltd",
          ownershipPctLow: 25,
          ownershipPctHigh: 50,
          evidence: "FILED",
          valuationLowGBP: 10_000_000,
          valuationMidGBP: 30_000_000,
          valuationHighGBP: 55_000_000,
          valuationMethod: "comps",
          inExitProcess: false,
          sourceIds: [],
        },
      ],
      publicHoldings: [
        { companyName: "Listed plc", valueGBP: 4_000_000, asOf: null, evidence: "DISCLOSED", sourceIds: [] },
      ],
    });
    assert.ok(result.grossLowGBP <= result.grossMidGBP);
    assert.ok(result.grossMidGBP <= result.grossHighGBP);
    assert.ok(result.investableLowGBP <= result.investableMidGBP);
    assert.ok(result.investableMidGBP <= result.investableHighGBP);
  });
});

describe("valueCompany", () => {
  test("prefers a priced round over a modelled multiple", () => {
    const result = valueCompany({
      industry: "Software & SaaS",
      financials: [
        {
          periodEnd: new Date(),
          revenueGBP: 10_000_000,
          ebitdaGBP: 2_000_000,
          pretaxProfitGBP: 1_800_000,
          netAssetsGBP: 5_000_000,
          cashGBP: 1_000_000,
          isAbridged: false,
        },
      ],
      latestPostMoneyGBP: 150_000_000,
      latestRoundDate: new Date(),
    });
    assert.equal(result.basis, "FUNDING_ROUND");
    assert.equal(result.midGBP, 150_000_000);
  });

  test("falls back to net assets when nothing is disclosed, and says so", () => {
    const result = valueCompany({
      industry: null,
      financials: [
        {
          periodEnd: new Date(),
          revenueGBP: null,
          ebitdaGBP: null,
          pretaxProfitGBP: null,
          netAssetsGBP: 20_000_000,
          cashGBP: null,
          isAbridged: true,
        },
      ],
    });
    assert.equal(result.basis, "NET_ASSETS");
    assert.equal(result.midGBP, 20_000_000);
    assert.ok(result.caveats.some((c) => c.includes("abridged")));
  });

  test("reports no valuation rather than guessing when there is no data", () => {
    const result = valueCompany({ industry: "Technology", financials: [] });
    assert.equal(result.basis, "NONE");
    assert.equal(result.midGBP, 0);
  });

  test("computes revenue CAGR across filed periods", () => {
    const cagr = revenueCagr([
      { periodEnd: new Date("2023-01-01"), revenueGBP: 10_000_000, ebitdaGBP: null, pretaxProfitGBP: null, netAssetsGBP: null, cashGBP: null, isAbridged: false },
      { periodEnd: new Date("2026-01-01"), revenueGBP: 20_000_000, ebitdaGBP: null, pretaxProfitGBP: null, netAssetsGBP: null, cashGBP: null, isAbridged: false },
    ]);
    assert.ok(cagr !== null);
    assert.ok(Math.abs(cagr! - 26) < 1, `expected ~26%, got ${cagr}`);
  });
});

describe("PSC ownership bands", () => {
  test("maps filed nature-of-control strings to their bands", () => {
    assert.deepEqual(
      ownershipFromNaturesOfControl(["ownership-of-shares-50-to-75-percent"]),
      { low: 50, high: 75, basis: "PSC register: ownership-of-shares-50-to-75-percent" },
    );
    assert.equal(ownershipFromNaturesOfControl(["ownership-of-shares-75-to-100-percent"])?.high, 100);
  });

  test("takes the highest band when several are filed", () => {
    const result = ownershipFromNaturesOfControl([
      "ownership-of-shares-25-to-50-percent",
      "voting-rights-75-to-100-percent",
    ]);
    assert.equal(result?.low, 75);
  });

  test("recognises control without a share band, but cannot size it", () => {
    const result = ownershipFromNaturesOfControl(["right-to-appoint-and-remove-directors"]);
    assert.equal(result?.low, 0);
    assert.equal(result?.high, 25);
  });

  test("returns null when nothing is filed", () => {
    assert.equal(ownershipFromNaturesOfControl([]), null);
    assert.equal(ownershipFromNaturesOfControl(undefined), null);
  });
});

describe("region resolution", () => {
  test("resolves districts and towns to the right county", () => {
    assert.equal(resolveRegion("Truro, Cornwall"), "CORNWALL");
    assert.equal(resolveRegion("Exeter"), "DEVON");
    assert.equal(resolveRegion("12 Some Street, London, EC2A 4NE"), "GREATER_LONDON");
    assert.equal(resolveRegion("Weybridge"), "SURREY");
    assert.equal(resolveRegion("Newbury"), "BERKSHIRE");
    assert.equal(resolveRegion("Bath and North East Somerset"), "SOMERSET");
  });

  // Out-of-scope records must be dropped, never defaulted into the pipeline.
  test("returns null for out-of-scope locations", () => {
    assert.equal(resolveRegion("Manchester"), null);
    assert.equal(resolveRegion("Edinburgh"), null);
    assert.equal(resolveRegion("Londonderry"), null);
    assert.equal(resolveRegion(""), null);
    assert.equal(resolveRegion(null), null);
  });

  test("isInScope guards the enum", () => {
    assert.equal(isInScope("DEVON"), true);
    assert.equal(isInScope("YORKSHIRE"), false);
    assert.equal(isInScope(null), false);
  });
});

describe("bands and formatting", () => {
  test("bands follow the advisor's thresholds", () => {
    assert.equal(bandForAmount(7_499_999), "BELOW_7_5M");
    assert.equal(bandForAmount(7_500_000), "BAND_7_5_15M");
    assert.equal(bandForAmount(15_000_000), "BAND_15_30M");
    assert.equal(bandForAmount(250_000_000), "BAND_100M_PLUS");
  });

  test("confidence bands", () => {
    assert.equal(confidenceBandFor(10), "LOW");
    assert.equal(confidenceBandFor(50), "MEDIUM");
    assert.equal(confidenceBandFor(70), "HIGH");
    assert.equal(confidenceBandFor(90), "VERIFIED");
  });

  test("money formats compactly and without false precision", () => {
    assert.equal(formatGBP(7_500_000), "£7.5m");
    assert.equal(formatGBP(1_240_000_000), "£1.24bn");
    assert.equal(formatGBP(822_000), "£822k");
    assert.equal(formatGBP(null), "—");
  });

  test("PSC bands render as ranges, not fake point estimates", () => {
    assert.equal(formatOwnership(50, 75), "50–75%");
    assert.equal(formatOwnership(12.5, 12.5), "12.5%");
  });
});

describe("ISO weeks", () => {
  test("a Monday is the start of its own week", () => {
    const monday = startOfIsoWeek(new Date("2026-08-03T12:00:00Z"));
    assert.equal(monday.toISOString(), "2026-08-03T00:00:00.000Z");
  });

  test("a Sunday belongs to the week that began the previous Monday", () => {
    const monday = startOfIsoWeek(new Date("2026-08-09T23:00:00Z"));
    assert.equal(monday.toISOString(), "2026-08-03T00:00:00.000Z");
  });

  test("the week ends immediately before the next Monday", () => {
    const end = endOfIsoWeek(new Date("2026-08-05T00:00:00Z"));
    assert.equal(end.toISOString(), "2026-08-09T23:59:59.999Z");
  });
});
