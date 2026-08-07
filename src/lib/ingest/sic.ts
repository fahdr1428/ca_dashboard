/**
 * Companies House SIC 2007 codes -> the industry labels the dashboard filters
 * and values on. Only the prefixes we care about are enumerated; everything
 * else falls through to a division-level bucket.
 */

const EXACT: Record<string, string> = {
  "62012": "Software & SaaS",
  "62020": "Technology",
  "62090": "Technology",
  "63110": "Technology",
  "64205": "Financial Services",
  "64209": "Financial Services",
  "64992": "Financial Services",
  "66300": "Financial Services",
  "66190": "Fintech",
  "70100": "Professional Services",
  "70229": "Professional Services",
  "71121": "Manufacturing & Engineering",
  "71122": "Manufacturing & Engineering",
  "86101": "Healthcare & Life Sciences",
  "86900": "Healthcare & Life Sciences",
  "21100": "Healthcare & Life Sciences",
  "35110": "Energy & Renewables",
  "35119": "Energy & Renewables",
  "41100": "Construction & Property",
  "41202": "Construction & Property",
  "68209": "Construction & Property",
  "10890": "Food & Beverage",
  "11020": "Food & Beverage",
  "50100": "Marine & Leisure",
  "30120": "Marine & Leisure",
  "73110": "Media & Marketing",
  "59111": "Media & Marketing",
  "01500": "Agriculture & Land",
};

/** SIC division (first two digits) -> label, as a fallback. */
const DIVISION: Array<[RegExp, string]> = [
  [/^0[1-3]/, "Agriculture & Land"],
  [/^(10|11)/, "Food & Beverage"],
  [/^(2[0-1])/, "Healthcare & Life Sciences"],
  [/^(1[3-9]|2[2-9]|3[0-3])/, "Manufacturing & Engineering"],
  [/^35/, "Energy & Renewables"],
  [/^4[1-3]/, "Construction & Property"],
  [/^4[5-7]/, "Consumer & Retail"],
  [/^(49|5[0-3])/, "Transport & Logistics"],
  [/^5[5-6]/, "Marine & Leisure"],
  [/^(58|59|60|73)/, "Media & Marketing"],
  [/^6[1-3]/, "Technology"],
  [/^6[4-6]/, "Financial Services"],
  [/^68/, "Construction & Property"],
  [/^(69|70|71|74|78|82)/, "Professional Services"],
  [/^8[5-8]/, "Healthcare & Life Sciences"],
  [/^9[0-3]/, "Marine & Leisure"],
];

export function sicToIndustry(codes: string[]): string | undefined {
  for (const raw of codes) {
    const code = raw.trim();
    if (EXACT[code]) return EXACT[code];
  }
  for (const raw of codes) {
    const code = raw.trim();
    for (const [re, label] of DIVISION) {
      if (re.test(code)) return label;
    }
  }
  return undefined;
}
