import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createCompaniesHouseConnector, CompaniesHouseClient } from "./companies-house";

/**
 * The Companies House connector cannot be exercised against the live API in CI
 * (no key, and locked-down networks block the host), so these tests drive the
 * real connector code against recorded API response shapes.
 *
 * The fixtures mirror the actual payloads documented at
 * developer.company-information.service.gov.uk — same field names, same PSC
 * "natures of control" strings, same officer name casing ("SURNAME, Forename"),
 * same links structure. If the connector works against these, it works against
 * the register.
 */

const ADVANCED_SEARCH = {
  hits: 2,
  items: [
    {
      company_number: "07890123",
      company_name: "HALBERTON PRECISION ENGINEERING LIMITED",
      company_status: "active",
      date_of_creation: "1999-04-12",
      sic_codes: ["71121"],
      registered_office_address: {
        address_line_1: "Marsh Barton Trading Estate",
        locality: "Exeter",
        region: "Devon",
        postal_code: "EX2 8LX",
        country: "England",
      },
    },
    {
      // Out of scope — a Manchester registered office must be discarded, not
      // defaulted into the pipeline.
      company_number: "09999999",
      company_name: "NORTHERN WIDGETS LIMITED",
      company_status: "active",
      date_of_creation: "2010-01-01",
      sic_codes: ["62012"],
      registered_office_address: {
        address_line_1: "1 Deansgate",
        locality: "Manchester",
        postal_code: "M3 2AY",
        country: "England",
      },
    },
  ],
};

const PSC = {
  items: [
    {
      name: "Gareth Halberton",
      kind: "individual-person-with-significant-control",
      natures_of_control: [
        "ownership-of-shares-25-to-50-percent",
        "voting-rights-25-to-50-percent",
      ],
      notified_on: "2016-07-01",
      nationality: "British",
      country_of_residence: "England",
      date_of_birth: { month: 4, year: 1968 },
      address: { locality: "Exeter", region: "Devon", country: "England" },
    },
    {
      // A ceased PSC must be ignored.
      name: "Former Holder",
      kind: "individual-person-with-significant-control",
      natures_of_control: ["ownership-of-shares-75-to-100-percent"],
      notified_on: "2016-07-01",
      ceased_on: "2020-03-01",
    },
    {
      // A corporate entity is not a prospect.
      name: "HOLDINGS SARL",
      kind: "corporate-entity-person-with-significant-control",
      natures_of_control: ["ownership-of-shares-75-to-100-percent"],
    },
  ],
};

const OFFICERS = {
  items: [
    {
      name: "HALBERTON, Gareth John",
      officer_role: "director",
      appointed_on: "1999-04-12",
      occupation: "Company Director",
      nationality: "British",
      date_of_birth: { month: 4, year: 1968 },
      links: { officer: { appointments: "/officers/aBc123XyZ/appointments" } },
    },
    {
      name: "SMITH, Jane",
      officer_role: "secretary",
      appointed_on: "2005-01-01",
      resigned_on: "2019-06-30",
      links: { officer: { appointments: "/officers/resigned1/appointments" } },
    },
  ],
};

const FILING_HISTORY = {
  items: [
    {
      category: "accounts",
      date: "2026-07-15",
      description: "accounts-with-accounts-type-full",
      type: "AA",
      transaction_id: "TX1",
      links: { document_metadata: "https://document-api.company-information.service.gov.uk/document/DOC1" },
    },
    {
      category: "persons-with-significant-control",
      date: "2026-06-02",
      description: "psc-statement-notification",
      type: "PSC01",
      transaction_id: "TX2",
    },
    {
      category: "capital",
      date: "2026-05-20",
      description: "purchase-of-own-shares",
      type: "SH03",
      transaction_id: "TX3",
    },
  ],
};

/** Document API metadata: declares which content types the filing has. */
const DOC_METADATA = {
  company_number: "07890123",
  resources: { "application/xhtml+xml": { content_length: 84000 }, "application/pdf": {} },
};

/** A minimal but realistic iXBRL accounts document. */
const ACCOUNTS_IXBRL = `<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:xbrli="http://www.xbrl.org/2003/instance">
<ix:header><ix:resources>
  <xbrli:context id="D26"><xbrli:period><xbrli:startDate>2025-04-01</xbrli:startDate><xbrli:endDate>2026-03-31</xbrli:endDate></xbrli:period></xbrli:context>
  <xbrli:context id="D25"><xbrli:period><xbrli:startDate>2024-04-01</xbrli:startDate><xbrli:endDate>2025-03-31</xbrli:endDate></xbrli:period></xbrli:context>
  <xbrli:context id="I26"><xbrli:period><xbrli:instant>2026-03-31</xbrli:instant></xbrli:period></xbrli:context>
</ix:resources></ix:header><body>
  <ix:nonFraction name="core:TurnoverRevenue" contextRef="D26" unitRef="GBP" scale="0">61,200,000</ix:nonFraction>
  <ix:nonFraction name="core:TurnoverRevenue" contextRef="D25" unitRef="GBP" scale="0">52,400,000</ix:nonFraction>
  <ix:nonFraction name="core:OperatingProfitLoss" contextRef="D26" unitRef="GBP" scale="0">8,300,000</ix:nonFraction>
  <ix:nonFraction name="core:DepreciationAmortisationImpairmentExpense" contextRef="D26" unitRef="GBP" scale="0">1,150,000</ix:nonFraction>
  <ix:nonFraction name="core:ProfitLossOnOrdinaryActivitiesBeforeTax" contextRef="D26" unitRef="GBP" scale="0">7,956,000</ix:nonFraction>
  <ix:nonFraction name="core:DividendsPaid" contextRef="D26" unitRef="GBP" scale="0" sign="-">3,300,000</ix:nonFraction>
  <ix:nonFraction name="core:NetAssetsLiabilities" contextRef="I26" unitRef="GBP" scale="0">33,000,000</ix:nonFraction>
  <ix:nonFraction name="core:CashBankOnHand" contextRef="I26" unitRef="GBP" scale="0">7,800,000</ix:nonFraction>
  <ix:nonFraction name="core:AverageNumberEmployeesDuringPeriod" contextRef="D26" unitRef="pure">380</ix:nonFraction>
</body></html>`;

/** Routes a request path to the matching fixture, like the real API would. */
function fixtureFor(pathname: string, search: URLSearchParams): unknown {
  if (pathname === "/advanced-search/companies") {
    // Only Devon returns results; every other county returns an empty page so
    // the connector's pagination stops immediately.
    const location = search.get("location");
    const startIndex = Number(search.get("start_index") ?? 0);
    if (location === "Devon" && startIndex === 0) return ADVANCED_SEARCH;
    return { hits: 0, items: [] };
  }
  if (pathname.endsWith("/persons-with-significant-control")) return PSC;
  if (pathname.endsWith("/officers")) return OFFICERS;
  if (pathname.endsWith("/filing-history")) return FILING_HISTORY;
  if (pathname === "/document/DOC1") return DOC_METADATA;
  return null;
}

interface RecordedCall {
  pathname: string;
  authorization: string | null;
}

let calls: RecordedCall[] = [];
const realFetch = globalThis.fetch;

function installFakeApi(options: { failWith?: number } = {}) {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers = new Headers(init?.headers);
    calls.push({ pathname: url.pathname, authorization: headers.get("authorization") });

    if (options.failWith) {
      return new Response("upstream error", { status: options.failWith });
    }

    if (url.pathname === "/document/DOC1/content") {
      return new Response(ACCOUNTS_IXBRL, {
        status: 200,
        headers: { "Content-Type": "application/xhtml+xml" },
      });
    }

    const body = fixtureFor(url.pathname, url.searchParams);
    if (body === null) return new Response("Not Found", { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  process.env.COMPANIES_HOUSE_API_KEY = "test-key-abc123";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.COMPANIES_HOUSE_API_KEY;
});

describe("CompaniesHouseClient", () => {
  test("authenticates with the API key as HTTP Basic username", async () => {
    installFakeApi();
    const client = new CompaniesHouseClient("test-key-abc123");
    await client.company("07890123");

    const auth = calls[0].authorization;
    assert.ok(auth?.startsWith("Basic "), "must use HTTP Basic");
    // Companies House expects "<key>:" — key as username, empty password.
    const decoded = Buffer.from(auth!.slice(6), "base64").toString();
    assert.equal(decoded, "test-key-abc123:");
  });

  test("returns null on 404 rather than throwing", async () => {
    installFakeApi();
    const client = new CompaniesHouseClient("test-key-abc123");
    assert.equal(await client.get("/company/00000000/unknown-endpoint"), null);
  });

  test("refuses to exceed its request budget", async () => {
    installFakeApi();
    const client = new CompaniesHouseClient("test-key-abc123", 2);
    await client.company("07890123");
    await client.company("07890123");
    await assert.rejects(() => client.company("07890123"), /budget/);
  });

  test("gives up after retrying a persistent server error", async () => {
    installFakeApi({ failWith: 503 });
    const client = new CompaniesHouseClient("test-key-abc123", 20);
    await assert.rejects(() => client.company("07890123"), /repeatedly unavailable/);
    assert.ok(calls.length > 1, "should have retried");
  });
});

describe("Companies House connector", () => {
  test("is unavailable, with a reason, when no API key is set", () => {
    delete process.env.COMPANIES_HOUSE_API_KEY;
    const connector = createCompaniesHouseConnector();
    assert.equal(connector.isAvailable(), false);
    assert.match(connector.unavailableReason!(), /COMPANIES_HOUSE_API_KEY/);
  });

  test("builds companies, prospects and signals from the register", async () => {
    installFakeApi();
    const connector = createCompaniesHouseConnector();
    assert.equal(connector.isAvailable(), true);

    const result = await connector.run({ since: null, maxRequests: 200, log: () => {} });

    // --- Geography is enforced: Manchester is dropped ---------------------
    assert.equal(result.companies.length, 1);
    const company = result.companies[0];
    assert.equal(company.companyNumber, "07890123");
    assert.equal(company.region, "DEVON");
    assert.equal(company.officeLocation, "Exeter");
    // SIC 71121 maps to engineering, not left blank.
    assert.equal(company.industry, "Manufacturing & Engineering");
    assert.ok(company.filingHash, "a filing hash is needed for change detection");
    assert.equal(company.sources[0].sourceType, "COMPANIES_HOUSE");
    assert.match(company.sources[0].licence!, /Open Government Licence/);

    // --- The PSC becomes a prospect, with a banded stake ------------------
    assert.equal(result.prospects.length, 1, "only the live individual PSC counts");
    const prospect = result.prospects[0];
    assert.equal(prospect.fullName, "Gareth Halberton");
    assert.equal(prospect.region, "DEVON");

    const stake = prospect.shareholdings![0];
    assert.equal(stake.ownershipPctLow, 25);
    assert.equal(stake.ownershipPctHigh, 50);
    assert.equal(stake.evidence, "FILED");
    assert.match(stake.basis!, /ownership-of-shares-25-to-50-percent/);

    // --- Officer linkage confirms identity --------------------------------
    assert.equal(prospect.chOfficerId, "aBc123XyZ");
    assert.equal(prospect.jobTitle, "Director");
    assert.equal(prospect.occupation, "Company Director");
    assert.ok(
      prospect.identityConfidence! >= 84,
      "matching the officer record should raise identity confidence",
    );

    // --- Filing history becomes signals -----------------------------------
    const types = result.signals.map((s) => s.type);
    assert.ok(types.includes("FILING_UPDATE"), "new accounts");
    assert.ok(types.includes("PSC_CHANGE"), "PSC filing");
    assert.ok(types.includes("SHARE_SALE"), "share capital transaction");
    // Dedupe keys must be stable so a re-run updates rather than duplicates.
    assert.equal(new Set(result.signals.map((s) => s.dedupeKey)).size, result.signals.length);
    assert.ok(result.signals.every((s) => s.dedupeKey.startsWith("ch:07890123:")));
  });

  // Without this the register gives us ownership but no money, every valuation
  // comes out at zero, and the whole pipeline is inert on live data.
  test("reads filed accounts from the Document API into financials", async () => {
    installFakeApi();
    const connector = createCompaniesHouseConnector();
    const result = await connector.run({ since: null, maxRequests: 200, log: () => {} });

    const financials = result.companies[0].financials ?? [];
    assert.equal(financials.length, 2, "current year plus the comparative");

    // Oldest first, as the valuation model expects.
    assert.equal(financials[0].periodEnd.toISOString().slice(0, 10), "2025-03-31");
    const latest = financials[1];
    assert.equal(latest.periodEnd.toISOString().slice(0, 10), "2026-03-31");
    assert.equal(latest.periodLabel, "FY26");
    assert.equal(latest.revenueGBP, 61_200_000);
    assert.equal(latest.pretaxProfitGBP, 7_956_000);
    assert.equal(latest.netAssetsGBP, 33_000_000);
    assert.equal(latest.cashGBP, 7_800_000);
    assert.equal(latest.employees, 380);
    assert.equal(latest.isAbridged, false);
    assert.equal(latest.evidence, "FILED");
    // Dividends are what drive the largest-recipient panel and the wealth model.
    assert.equal(latest.dividendsDeclaredGBP, 3_300_000);
    // EBITDA is derived by adding depreciation back to operating profit.
    assert.equal(latest.ebitdaGBP, 8_300_000 + 1_150_000);
  });

  test("does not request XHTML when a filing has no tagged version", async () => {
    installFakeApi();
    // Strip the xhtml resource so only a scanned PDF remains.
    const original = DOC_METADATA.resources;
    (DOC_METADATA as { resources: unknown }).resources = { "application/pdf": {} };
    try {
      const result = await createCompaniesHouseConnector().run({
        since: null, maxRequests: 200, log: () => {},
      });
      assert.equal(result.companies[0].financials, undefined);
      assert.ok(
        !calls.some((c) => c.pathname.endsWith("/content")),
        "must not fetch content when no XHTML resource is offered",
      );
    } finally {
      (DOC_METADATA as { resources: unknown }).resources = original;
    }
  });

  test("skips filings older than the incremental cutoff", async () => {
    installFakeApi();
    const connector = createCompaniesHouseConnector();
    const result = await connector.run({
      since: new Date("2026-07-01"),
      maxRequests: 200,
      log: () => {},
    });
    // Only the 2026-07-15 accounts filing is newer than the cutoff.
    assert.equal(result.signals.length, 1);
    assert.equal(result.signals[0].type, "FILING_UPDATE");
  });

  test("reports upstream failure as a warning instead of crashing the run", async () => {
    installFakeApi({ failWith: 500 });
    const connector = createCompaniesHouseConnector();
    const result = await connector.run({ since: null, maxRequests: 60, log: () => {} });

    assert.equal(result.companies.length, 0);
    assert.ok(result.warnings.length > 0, "the failure must be surfaced, not swallowed");
    assert.match(result.warnings[0], /Companies House/);
  });
});
