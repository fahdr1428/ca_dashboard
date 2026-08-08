import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseIxbrlAccounts, deriveEbitda } from "./ixbrl";

/**
 * Fixtures modelled on real filed accounts. The awkward parts of genuine
 * Companies House filings are all represented deliberately: varying namespace
 * prefixes, the `scale` attribute for figures presented in thousands, the
 * `sign` attribute, bracketed negatives, dimensional (segment) contexts that
 * must not be counted as totals, and a comparative prior year alongside the
 * current one.
 */

/** A full FRS 102 filing: two years, P&L plus balance sheet, dividends. */
const FULL_ACCOUNTS = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:xbrli="http://www.xbrl.org/2003/instance">
<head><ix:header><ix:resources>
  <xbrli:context id="D2026">
    <xbrli:entity><xbrli:identifier scheme="http://www.companieshouse.gov.uk/">07890123</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:startDate>2025-04-01</xbrli:startDate><xbrli:endDate>2026-03-31</xbrli:endDate></xbrli:period>
  </xbrli:context>
  <xbrli:context id="D2025">
    <xbrli:period><xbrli:startDate>2024-04-01</xbrli:startDate><xbrli:endDate>2025-03-31</xbrli:endDate></xbrli:period>
  </xbrli:context>
  <xbrli:context id="I2026">
    <xbrli:period><xbrli:instant>2026-03-31</xbrli:instant></xbrli:period>
  </xbrli:context>
  <xbrli:context id="I2025">
    <xbrli:period><xbrli:instant>2025-03-31</xbrli:instant></xbrli:period>
  </xbrli:context>
  <!-- A segment breakdown. Counting this as a total would overstate turnover. -->
  <xbrli:context id="D2026_SegmentUK">
    <xbrli:entity><xbrli:segment>
      <xbrldi:explicitMember dimension="core:GeographicalMarketsDimension">core:UnitedKingdom</xbrldi:explicitMember>
    </xbrli:segment></xbrli:entity>
    <xbrli:period><xbrli:startDate>2025-04-01</xbrli:startDate><xbrli:endDate>2026-03-31</xbrli:endDate></xbrli:period>
  </xbrli:context>
</ix:resources></ix:header></head>
<body>
  <p>Company registration number 07890123</p>
  <ix:nonNumeric name="core:UKCompaniesHouseRegisteredNumber" contextRef="D2026">07890123</ix:nonNumeric>

  <table>
    <tr><td>Turnover</td>
      <td><ix:nonFraction name="core:TurnoverRevenue" contextRef="D2026" unitRef="GBP" decimals="0" scale="0">61,200,000</ix:nonFraction></td>
      <td><ix:nonFraction name="core:TurnoverRevenue" contextRef="D2025" unitRef="GBP" decimals="0" scale="0">56,100,000</ix:nonFraction></td>
    </tr>
    <tr><td>Gross profit</td>
      <td><ix:nonFraction name="core:GrossProfitLoss" contextRef="D2026" unitRef="GBP" scale="0">14,800,000</ix:nonFraction></td>
    </tr>
    <tr><td>Operating profit</td>
      <td><ix:nonFraction name="core:OperatingProfitLoss" contextRef="D2026" unitRef="GBP" scale="0">8,300,000</ix:nonFraction></td>
    </tr>
    <tr><td>Depreciation</td>
      <td><ix:nonFraction name="core:DepreciationAmortisationImpairmentExpense" contextRef="D2026" unitRef="GBP" scale="0">1,150,000</ix:nonFraction></td>
    </tr>
    <tr><td>Profit before taxation</td>
      <td><ix:nonFraction name="core:ProfitLossOnOrdinaryActivitiesBeforeTax" contextRef="D2026" unitRef="GBP" scale="0">7,956,000</ix:nonFraction></td>
      <td><ix:nonFraction name="core:ProfitLossOnOrdinaryActivitiesBeforeTax" contextRef="D2025" unitRef="GBP" scale="0">7,293,000</ix:nonFraction></td>
    </tr>
    <tr><td>Dividends paid</td>
      <td><ix:nonFraction name="core:DividendsPaid" contextRef="D2026" unitRef="GBP" scale="0" sign="-">3,300,000</ix:nonFraction></td>
    </tr>
    <tr><td>Average employees</td>
      <td><ix:nonFraction name="core:AverageNumberEmployeesDuringPeriod" contextRef="D2026" unitRef="pure" decimals="0">380</ix:nonFraction></td>
    </tr>
    <!-- Segment turnover, must be ignored -->
    <tr><td>UK turnover</td>
      <td><ix:nonFraction name="core:TurnoverRevenue" contextRef="D2026_SegmentUK" unitRef="GBP" scale="0">44,000,000</ix:nonFraction></td>
    </tr>
    <tr><td>Net assets</td>
      <td><ix:nonFraction name="core:NetAssetsLiabilities" contextRef="I2026" unitRef="GBP" scale="0">33,000,000</ix:nonFraction></td>
      <td><ix:nonFraction name="core:NetAssetsLiabilities" contextRef="I2025" unitRef="GBP" scale="0">28,400,000</ix:nonFraction></td>
    </tr>
    <tr><td>Cash at bank and in hand</td>
      <td><ix:nonFraction name="core:CashBankOnHand" contextRef="I2026" unitRef="GBP" scale="0">7,800,000</ix:nonFraction></td>
    </tr>
  </table>
</body></html>`;

/** Small-company filleted accounts: no turnover, figures in thousands. */
const FILLETED_ACCOUNTS = `<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL">
<ix:header><ix:resources>
  <context id="c1"><period><instant>2026-01-31</instant></period></context>
  <context id="c2"><period><startDate>2025-02-01</startDate><endDate>2026-01-31</endDate></period></context>
</ix:resources></ix:header>
<body>
  <!-- scale="3": presented in thousands, so 47,800 means £47.8m -->
  <ix:nonFraction name="ns5:NetAssetsLiabilities" contextRef="c1" unitRef="GBP" scale="3" decimals="-3">47,800</ix:nonFraction>
  <ix:nonFraction name="ns5:CashBankInHand" contextRef="c1" unitRef="GBP" scale="3">3,100</ix:nonFraction>
  <!-- A bracketed negative -->
  <ix:nonFraction name="ns5:ProfitLoss" contextRef="c2" unitRef="GBP" scale="3">(1,240)</ix:nonFraction>
</body></html>`;

describe("parseIxbrlAccounts — full accounts", () => {
  const result = parseIxbrlAccounts(FULL_ACCOUNTS);

  test("extracts the company number from the tagged fact", () => {
    assert.equal(result.companyNumber, "07890123");
  });

  test("finds both the current year and the comparative", () => {
    assert.equal(result.periods.length, 2);
    // Newest first.
    assert.equal(result.periods[0].periodEnd.toISOString().slice(0, 10), "2026-03-31");
    assert.equal(result.periods[1].periodEnd.toISOString().slice(0, 10), "2025-03-31");
  });

  test("reads the current year's figures", () => {
    const y = result.periods[0];
    assert.equal(y.revenueGBP, 61_200_000);
    assert.equal(y.grossProfitGBP, 14_800_000);
    assert.equal(y.operatingProfitGBP, 8_300_000);
    assert.equal(y.pretaxProfitGBP, 7_956_000);
    assert.equal(y.employees, 380);
    assert.equal(y.isAbridged, false);
  });

  // The balance sheet is an instant context dated the same day the period ends;
  // it has to land on the same accounts row, not a separate one.
  test("merges the balance sheet into the matching accounting period", () => {
    const y = result.periods[0];
    assert.equal(y.netAssetsGBP, 33_000_000);
    assert.equal(y.cashGBP, 7_800_000);
    assert.equal(result.periods[1].netAssetsGBP, 28_400_000);
  });

  // A dividend tagged sign="-" is a distribution out, but this dashboard cares
  // about the magnitude the shareholders received.
  test("normalises a negatively-signed dividend to its magnitude", () => {
    assert.equal(result.periods[0].dividendsGBP, 3_300_000);
  });

  // Regression: counting a segment fact as a total would overstate turnover.
  test("ignores dimensional segment contexts", () => {
    assert.notEqual(result.periods[0].revenueGBP, 44_000_000);
    assert.equal(result.periods[0].revenueGBP, 61_200_000);
  });

  test("derives EBITDA by adding back depreciation", () => {
    assert.equal(deriveEbitda(FULL_ACCOUNTS, result.periods[0]), 8_300_000 + 1_150_000);
  });
});

describe("parseIxbrlAccounts — filleted small-company accounts", () => {
  const result = parseIxbrlAccounts(FILLETED_ACCOUNTS);

  // scale="3" means thousands. Getting this wrong understates a company by
  // 1000x, which would silently drop every small business out of the pipeline.
  test("applies the scale attribute", () => {
    const period = result.periods.find((p) => p.netAssetsGBP !== null)!;
    assert.equal(period.netAssetsGBP, 47_800_000);
    assert.equal(period.cashGBP, 3_100_000);
  });

  test("reads bracketed figures as negative", () => {
    const loss = result.periods.find((p) => p.pretaxProfitGBP !== null)!;
    assert.equal(loss.pretaxProfitGBP, -1_240_000);
  });

  test("flags missing turnover as abridged, and warns", () => {
    assert.ok(result.periods.every((p) => p.revenueGBP === null));
    assert.ok(result.periods.some((p) => p.isAbridged));
    assert.ok(result.warnings.some((w) => /abridged|filleted/i.test(w)));
  });

  test("works without namespace prefixes on context elements", () => {
    assert.ok(result.periods.length > 0, "bare <context> must still parse");
  });
});

describe("parseIxbrlAccounts — degenerate input", () => {
  test("reports no facts rather than throwing on a scanned PDF wrapper", () => {
    const result = parseIxbrlAccounts("<html><body><img src='page1.png'/></body></html>");
    assert.deepEqual(result.periods, []);
    assert.match(result.warnings[0], /No tagged iXBRL facts/);
  });

  test("survives empty input", () => {
    const result = parseIxbrlAccounts("");
    assert.deepEqual(result.periods, []);
  });

  test("skips facts whose value is a dash placeholder", () => {
    const html = `<html><ix:header><ix:resources>
      <context id="c"><period><startDate>2025-01-01</startDate><endDate>2025-12-31</endDate></period></context>
    </ix:resources></ix:header>
    <ix:nonFraction name="core:TurnoverRevenue" contextRef="c" scale="0">-</ix:nonFraction>
    <ix:nonFraction name="core:ProfitLoss" contextRef="c" scale="0">500000</ix:nonFraction>
    </html>`;
    const result = parseIxbrlAccounts(html);
    assert.equal(result.periods.length, 1);
    assert.equal(result.periods[0].revenueGBP, null);
    assert.equal(result.periods[0].pretaxProfitGBP, 500_000);
  });

  // Note disclosures often use short contexts; treating them as the reporting
  // period would produce nonsense accounts rows.
  test("ignores duration contexts shorter than six months", () => {
    const html = `<html><ix:header><ix:resources>
      <context id="stub"><period><startDate>2026-01-01</startDate><endDate>2026-02-01</endDate></period></context>
    </ix:resources></ix:header>
    <ix:nonFraction name="core:TurnoverRevenue" contextRef="stub" scale="0">99</ix:nonFraction>
    </html>`;
    assert.deepEqual(parseIxbrlAccounts(html).periods, []);
  });
});
