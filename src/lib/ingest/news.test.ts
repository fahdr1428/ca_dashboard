import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseFeed, parseMoney, extractPeople } from "./news";

/**
 * The news connector's parsing runs against live publisher feeds, which cannot
 * be reached from CI. These fixtures pin the behaviour that matters: that we
 * read real feed shapes, extract money correctly, and — most importantly —
 * refuse to invent people.
 */

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Example Business</title>
  <item>
    <title>Exeter engineer Halberton Precision acquires toolmaker for £8.4m</title>
    <link>https://example.com/a</link>
    <description><![CDATA[The Devon manufacturer, led by chairman Gareth Halberton, has bought a South Hams business.]]></description>
    <pubDate>Mon, 03 Aug 2026 09:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Bristol data platform closes $40m Series B</title>
    <link>https://example.com/b</link>
    <description>Redcliffe Data Labs raised the round at a reported valuation.</description>
    <pubDate>Tue, 04 Aug 2026 08:30:00 GMT</pubDate>
  </item>
</channel></rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Surrey founder sells stake in software group</title>
    <link href="https://example.org/c"/>
    <summary>Deal values the Weybridge business at &#163;96 million.</summary>
    <published>2026-07-30T10:00:00Z</published>
  </entry>
</feed>`;

describe("parseFeed", () => {
  test("reads RSS items", () => {
    const items = parseFeed(RSS_FIXTURE);
    assert.equal(items.length, 2);
    assert.equal(items[0].title, "Exeter engineer Halberton Precision acquires toolmaker for £8.4m");
    assert.equal(items[0].link, "https://example.com/a");
    assert.match(items[0].description, /South Hams/);
    assert.equal(items[0].pubDate?.getUTCFullYear(), 2026);
  });

  test("reads Atom entries, including href links and numeric entities", () => {
    const items = parseFeed(ATOM_FIXTURE);
    assert.equal(items.length, 1);
    assert.equal(items[0].link, "https://example.org/c");
    assert.match(items[0].description, /£96 million/);
  });

  test("returns nothing for junk rather than throwing", () => {
    assert.deepEqual(parseFeed("<html><body>not a feed</body></html>"), []);
    assert.deepEqual(parseFeed(""), []);
  });
});

describe("parseMoney", () => {
  test("handles the unit suffixes UK business press actually uses", () => {
    assert.equal(parseMoney("raised £8.4m"), 8_400_000);
    assert.equal(parseMoney("a £1.2bn valuation"), 1_200_000_000);
    assert.equal(parseMoney("£4 million round"), 4_000_000);
    assert.equal(parseMoney("£750k seed"), 750_000);
    assert.equal(parseMoney("£96 million"), 96_000_000);
    assert.equal(parseMoney("worth £1,250,000"), 1_250_000);
  });

  test("converts foreign currency so a dollar headline doesn't overstate", () => {
    const usd = parseMoney("$40m Series B");
    assert.ok(usd !== null && usd < 40_000_000, "USD should be discounted to GBP");
    assert.equal(usd, 31_200_000);
  });

  test("returns null when there is no figure", () => {
    assert.equal(parseMoney("the company grew strongly"), null);
  });
});

describe("extractPeople", () => {
  test("finds a name attached to a title", () => {
    const people = extractPeople("chairman Gareth Halberton has bought a business");
    assert.equal(people.length, 1);
    assert.equal(people[0].name, "Gareth Halberton");
    assert.equal(people[0].title, "Chairman");
  });

  test("normalises CEO to a readable title", () => {
    const people = extractPeople("Imogen Trevanning, CEO of the marine group");
    assert.equal(people[0].name, "Imogen Trevanning");
    assert.equal(people[0].title, "Chief Executive");
  });

  // This is the important one. A false name here becomes a wrong record about a
  // real, identifiable person, so the extractor must prefer silence.
  test("does not invent people from company or boilerplate text", () => {
    assert.deepEqual(extractPeople("The Company Limited announced results"), []);
    assert.deepEqual(extractPeople("Business Live reports strong growth"), []);
    assert.deepEqual(extractPeople("revenue rose sharply this year"), []);
  });

  test("ignores single-word candidates", () => {
    assert.deepEqual(extractPeople("founder Smith said"), []);
  });
});
