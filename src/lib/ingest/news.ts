import { resolveRegion, REGION_META, type RegionKey } from "@/lib/regions";
import type {
  Connector,
  ConnectorContext,
  ConnectorResult,
  RawSignal,
  RawSource,
} from "./types";
import { emptyResult } from "./types";
import type { SignalType } from "@/generated/prisma/enums";

/**
 * Business-news connector.
 *
 * Reads publisher-provided RSS feeds only — the feeds exist to be consumed, so
 * this does not scrape article bodies, does not bypass paywalls, and does not
 * touch any site that disallows it. Everything it produces is marked REPORTED
 * with reliability 3, and is intended to *point at* a company that then gets
 * verified against Companies House, not to stand as evidence on its own.
 */

const DEFAULT_FEEDS: Array<{ url: string; publisher: string; regionHint?: RegionKey }> = [
  { url: "https://www.business-live.co.uk/west-country/?service=rss", publisher: "BusinessLive South West" },
  { url: "https://www.business-live.co.uk/south-east/?service=rss", publisher: "BusinessLive South East" },
  { url: "https://feeds.bbci.co.uk/news/business/rss.xml", publisher: "BBC Business" },
  { url: "https://www.uktech.news/feed", publisher: "UKTN" },
  { url: "https://www.insidermedia.com/rss/southwest", publisher: "Insider Media South West" },
  { url: "https://www.insidermedia.com/rss/southeast", publisher: "Insider Media South East" },
];

interface FeedItem {
  title: string;
  link: string;
  description: string;
  pubDate: Date | null;
}

/** Small, dependency-free RSS/Atom reader. Feeds are simple; a parser is overkill. */
export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  for (const block of blocks) {
    const title = decode(pick(block, "title"));
    const link =
      pick(block, "link") ||
      (block.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] ?? "");
    const description = decode(
      pick(block, "description") || pick(block, "summary") || pick(block, "content"),
    );
    const dateText =
      pick(block, "pubDate") || pick(block, "published") || pick(block, "updated") || pick(block, "dc:date");
    const parsed = dateText ? new Date(dateText) : null;
    if (!title || !link) continue;
    items.push({
      title,
      link: link.trim(),
      description,
      pubDate: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
    });
  }
  return items;
}

function pick(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = block.match(re);
  if (!m) return "";
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

// ---------------------------------------------------------------------------
// Money and signal extraction
// ---------------------------------------------------------------------------

/** Parses "£12.5m", "£4 million", "$30m", "£1.2bn" into GBP. */
export function parseMoney(text: string): number | null {
  const re = /([£$€])\s?([\d,]+(?:\.\d+)?)\s?(bn|billion|m|million|k|thousand)?/i;
  const m = text.match(re);
  if (!m) return null;
  const [, currency, digits, unit] = m;
  let value = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const u = (unit ?? "").toLowerCase();
  if (u.startsWith("b")) value *= 1_000_000_000;
  else if (u.startsWith("m")) value *= 1_000_000;
  else if (u.startsWith("k") || u.startsWith("t")) value *= 1_000;
  // Rough FX so a dollar headline doesn't overstate a UK founder's position.
  const fx: Record<string, number> = { "£": 1, $: 0.78, "€": 0.85 };
  return Math.round(value * (fx[currency] ?? 1));
}

interface SignalRule {
  type: SignalType;
  /** Must match for the rule to fire. */
  pattern: RegExp;
  weight: number;
  label: (money: number | null) => string;
}

const RULES: SignalRule[] = [
  {
    type: "VENTURE_FUNDING",
    pattern: /\b(raises?|raised|secures?|secured|closes?|closed)\b[^.]{0,60}\b(seed|series [a-e]|funding|investment round|round)\b/i,
    weight: 70,
    label: (m) => (m ? `Venture funding round of ${gbp(m)}` : "Venture funding round"),
  },
  {
    type: "PE_INVESTMENT",
    pattern: /\b(private equity|pe (firm|house|backer)|buyout|growth capital)\b[^.]{0,60}\b(invest|backs?|backed|acquires?|stake)\b/i,
    weight: 75,
    label: (m) => (m ? `Private equity investment of ${gbp(m)}` : "Private equity investment"),
  },
  {
    type: "MA_ACTIVITY",
    pattern: /\b(acquires?|acquired|acquisition of|takeover|merges? with|bought by|snaps? up)\b/i,
    weight: 80,
    label: (m) => (m ? `M&A transaction worth ${gbp(m)}` : "M&A transaction"),
  },
  {
    type: "BUSINESS_EXIT",
    pattern: /\b(sells? (his|her|their|its)|sold (his|her|their) stake|exits?|exit(ed)?|sale of the business|founders? sell)\b/i,
    weight: 90,
    label: (m) => (m ? `Business exit realising ${gbp(m)}` : "Business exit"),
  },
  {
    type: "IPO_PREPARATION",
    pattern: /\b(ipo|initial public offering|float(ation)?|list(ing|s) on the (london stock exchange|lse|aim))\b/i,
    weight: 85,
    label: (m) => (m ? `IPO or flotation valued at ${gbp(m)}` : "IPO or flotation reported"),
  },
  {
    type: "LARGE_DIVIDEND",
    pattern: /\b(dividend|distribution|pay(s|out|ed|ment) to shareholders)\b/i,
    weight: 75,
    label: (m) => (m ? `Dividend of ${gbp(m)} reported` : "Dividend reported"),
  },
  {
    type: "FAMILY_OFFICE",
    pattern: /\b(family office|family investment company)\b/i,
    weight: 85,
    label: () => "Family office or family investment company reported",
  },
  {
    type: "PROPERTY_ACQUISITION",
    pattern: /\b(buys?|bought|purchases?|acquires?)\b[^.]{0,40}\b(estate|manor|mansion|country house|property portfolio)\b/i,
    weight: 55,
    label: (m) => (m ? `Property acquisition of ${gbp(m)}` : "Significant property acquisition"),
  },
  {
    type: "REVENUE_GROWTH",
    pattern: /\b(revenue|turnover|sales)\b[^.]{0,40}\b(up|rises?|grew|grows?|jumps?|climbs?|soars?)\b/i,
    weight: 45,
    label: (m) => (m ? `Revenue growth reported, ${gbp(m)}` : "Revenue growth reported"),
  },
  {
    type: "WEALTH_LIST_ENTRY",
    pattern: /\b(rich list|wealth list|richest|billionaires? list)\b/i,
    weight: 60,
    label: (m) => (m ? `Wealth list entry at ${gbp(m)}` : "Wealth list entry"),
  },
];

function gbp(n: number): string {
  if (n >= 1_000_000_000) return `£${(n / 1_000_000_000).toFixed(2)}bn`;
  if (n >= 1_000_000) return `£${(n / 1_000_000).toFixed(1)}m`;
  return `£${(n / 1_000).toFixed(0)}k`;
}

/** Names of the 13 regions and their major towns, for geographic filtering. */
const REGION_TERMS: Array<[RegionKey, RegExp]> = (
  Object.keys(REGION_META) as RegionKey[]
).map((key) => {
  const meta = REGION_META[key];
  const terms = [meta.label, ...meta.districts].map((t) =>
    t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  if (key === "GREATER_LONDON") terms.push("London");
  return [key, new RegExp(`\\b(${terms.join("|")})\\b`, "i")] as [RegionKey, RegExp];
});

function regionFromText(text: string): RegionKey | null {
  for (const [key, re] of REGION_TERMS) {
    if (re.test(text)) return key;
  }
  return resolveRegion(text);
}

/**
 * Extracts a "Name, title of Company" style attribution from a headline or
 * standfirst. Deliberately conservative: it would rather find nothing than
 * invent a person, because a wrong name here becomes a wrong record about a
 * real individual.
 */
export function extractPeople(text: string): Array<{ name: string; title: string }> {
  const out: Array<{ name: string; title: string }> = [];
  const NAME = "[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?(?:\\s+[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?){1,2}";

  // Titles are matched case-insensitively, names are NOT. An `i` flag on the
  // whole pattern would let `[A-Z][a-z]+` match lowercase words, so a headline
  // like "chairman Gareth Halberton has bought…" would capture the name as
  // "Gareth Halberton has". Build the case-insensitivity into the title
  // alternation instead of setting a flag.
  const TITLE_WORDS = [
    "founder", "co-founder", "chief executive", "chairman", "chairwoman", "chair",
    "managing director", "owner", "entrepreneur", "president", "chief financial officer",
  ];
  const TITLE_ACRONYMS = ["CEO", "CFO"];
  const TITLES = [...TITLE_WORDS.map(caseInsensitive), ...TITLE_ACRONYMS].join("|");

  const patterns = [
    new RegExp(`(${NAME}),?\\s+(?:the\\s+)?(${TITLES})\\b`, "g"),
    new RegExp(`\\b(${TITLES})\\s+(${NAME})\\b`, "g"),
  ];

  for (const [i, re] of patterns.entries()) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const name = (i === 0 ? m[1] : m[2]).trim();
      const title = (i === 0 ? m[2] : m[1]).trim();
      if (name.split(/\s+/).length < 2) continue;
      // Guard against publication names and boilerplate being read as people.
      if (/\b(The|A|An|This|That|New|Business|Company|Group|Limited|Ltd)\b/.test(name.split(/\s+/)[0]))
        continue;
      if (out.some((p) => p.name === name)) continue;
      out.push({ name, title: normaliseTitle(title) });
    }
  }
  return out.slice(0, 3);
}

/** "co-founder" -> "[Cc]o-founder", so titles match either case but names don't. */
function caseInsensitive(word: string): string {
  return word
    .split("")
    .map((ch) =>
      /[a-z]/i.test(ch)
        ? `[${ch.toLowerCase()}${ch.toUpperCase()}]`
        : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
}

function normaliseTitle(t: string): string {
  const lower = t.toLowerCase();
  if (lower === "ceo" || lower === "chief executive") return "Chief Executive";
  if (lower === "cfo" || lower === "chief financial officer") return "Chief Financial Officer";
  return lower.replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export function createNewsConnector(): Connector {
  const feeds = (process.env.NEWS_FEEDS?.split(",").map((u) => u.trim()).filter(Boolean) ?? [])
    .map((url) => ({ url, publisher: new URL(url).hostname }));
  const allFeeds = feeds.length ? feeds : DEFAULT_FEEDS;

  return {
    key: "business-news",
    label: "Business news & press releases",
    description:
      "Reads publisher RSS feeds for funding rounds, acquisitions, exits, IPOs and dividend news in the 13 target counties. Findings are leads for verification, not evidence.",
    sourceType: "NEWS",
    isAvailable: () => process.env.ENABLE_NEWS_CONNECTOR !== "false",
    unavailableReason: () => "Disabled via ENABLE_NEWS_CONNECTOR=false.",

    async run(ctx: ConnectorContext): Promise<ConnectorResult> {
      const result = emptyResult();
      const since = ctx.since ?? new Date(Date.now() - 30 * 24 * 3600 * 1000);

      for (const feed of allFeeds) {
        try {
          const res = await fetch(feed.url, {
            headers: {
              // Identify the client honestly so publishers can block us if they wish.
              "User-Agent":
                "WealthAdvisorLeadIntelligence/1.0 (RSS reader; contact: set CONTACT_EMAIL)",
              Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
            },
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) {
            result.warnings.push(`${feed.publisher}: HTTP ${res.status}`);
            continue;
          }
          const items = parseFeed(await res.text());

          for (const item of items) {
            if (item.pubDate && item.pubDate < since) continue;
            const text = `${item.title}. ${item.description}`;

            const region = regionFromText(text);
            if (!region) continue; // Out of geography — drop it.

            const money = parseMoney(text);
            const source: RawSource = {
              url: item.link,
              title: item.title,
              publisher: feed.publisher,
              sourceType: "NEWS",
              publishedAt: item.pubDate ?? undefined,
              reliability: 3,
              excerpt: item.description.slice(0, 400) || undefined,
            };

            for (const rule of RULES) {
              if (!rule.pattern.test(text)) continue;

              const signal: RawSignal = {
                type: rule.type,
                title: rule.label(money),
                summary: item.title,
                occurredOn: item.pubDate ?? new Date(),
                magnitudeGBP: money,
                weight: rule.weight,
                // Press coverage is a lead, not proof. Cap the confidence it
                // can contribute until Companies House corroborates it.
                confidence: 45,
                payload: { region, headline: item.title, people: extractPeople(text) },
                dedupeKey: `news:${rule.type}:${hash(item.link)}`,
                source,
              };
              result.signals.push(signal);
              break; // One signal per article — the strongest rule wins.
            }
          }
        } catch (err) {
          result.warnings.push(
            `${feed.publisher}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      ctx.log(
        `Business news: ${result.signals.length} in-region signals from ${allFeeds.length} feeds.`,
      );
      return result;
    },
  };
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
