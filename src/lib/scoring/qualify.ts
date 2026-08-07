import { QUALIFYING_THRESHOLD_GBP, PRIORITY_THRESHOLD_GBP, formatGBP } from "@/lib/wealth";
import type { SignalType } from "@/generated/prisma/enums";
import type { WealthEstimate } from "./estimate";

/**
 * Turns the model output into the "why were they identified?" sentence the
 * advisor reads first. Generated rather than hand-written so it can never drift
 * out of step with the numbers it is describing.
 */

export interface QualifyInput {
  fullName: string;
  jobTitle: string | null;
  companyName: string | null;
  regionLabel: string;
  estimate: WealthEstimate;
  signals: Array<{ type: SignalType; title: string; occurredOn: Date; magnitudeGBP: number | null }>;
}

export interface QualifyResult {
  qualifies: boolean;
  isPriority: boolean;
  rationale: string;
  /** Short chips for the table view. */
  reasons: string[];
}

const SIGNAL_PHRASES: Partial<Record<SignalType, string>> = {
  LARGE_DIVIDEND: "a large dividend distribution",
  BUSINESS_EXIT: "a completed business exit",
  LIQUIDITY_EVENT: "a recent liquidity event",
  MA_ACTIVITY: "M&A activity",
  IPO_PREPARATION: "IPO preparation",
  PE_INVESTMENT: "private equity investment",
  VENTURE_FUNDING: "venture funding",
  REVENUE_GROWTH: "rapid revenue growth",
  HIGH_PROFITABILITY: "high profitability",
  SHARE_SALE: "a disclosed share sale",
  PUBLIC_INVESTMENT: "disclosed listed holdings",
  FAMILY_OFFICE: "family office formation",
  HIGH_REMUNERATION: "high executive remuneration",
  INHERITANCE: "inherited wealth",
  WEALTH_LIST_ENTRY: "an entry on a published wealth list",
  PROPERTY_ACQUISITION: "a significant property acquisition",
  DIRECTOR_APPOINTMENT: "a new directorship",
};

export function qualifyProspect(input: QualifyInput): QualifyResult {
  const { estimate } = input;
  const investable = estimate.investableMidGBP;
  const gross = estimate.grossMidGBP;

  const qualifies =
    investable >= QUALIFYING_THRESHOLD_GBP ||
    // Founders whose paper wealth clears the priority bar are worth tracking
    // even before a liquidity event turns it into investable assets.
    gross >= PRIORITY_THRESHOLD_GBP;

  const isPriority = gross >= PRIORITY_THRESHOLD_GBP;

  const reasons: string[] = [];
  const sentences: string[] = [];

  // Lead with the largest component — that is the actual reason they are here.
  const byComponent = [...estimate.components].sort((a, b) => b.midGBP - a.midGBP);
  const top = byComponent[0];

  if (top) {
    switch (top.key) {
      case "PRIVATE_EQUITY_STAKE":
        reasons.push("Private company equity");
        sentences.push(
          `${input.fullName} holds an estimated ${formatGBP(top.midGBP)} of equity in ${
            top.subject ?? "a private company"
          }, which is the dominant component of their estimated wealth.`,
        );
        break;
      case "REALISED_EXIT":
        reasons.push("Realised exit");
        sentences.push(
          `${input.fullName} realised an estimated ${formatGBP(
            top.midGBP,
          )} net of tax from the disposal of ${top.subject ?? "a business"} — a liquidity event that puts genuinely investable assets in play.`,
        );
        break;
      case "DIVIDEND_ACCUMULATION":
        reasons.push("Dividend income");
        sentences.push(
          `${input.fullName} has drawn substantial dividends from ${
            top.subject ?? "their company"
          }, accumulating an estimated ${formatGBP(top.midGBP)} of retained personal capital.`,
        );
        break;
      case "PUBLIC_HOLDINGS":
        reasons.push("Listed holdings");
        sentences.push(
          `${input.fullName} has disclosed holdings in ${top.subject ?? "listed companies"} worth an estimated ${formatGBP(
            top.midGBP,
          )}.`,
        );
        break;
      case "REMUNERATION":
        reasons.push("High remuneration");
        sentences.push(
          `${input.fullName}'s accumulated savings from senior remuneration are estimated at ${formatGBP(
            top.midGBP,
          )}.`,
        );
        break;
      case "REPORTED_OR_INHERITED":
        reasons.push("Reported wealth");
        sentences.push(
          `${input.fullName} appears on ${top.subject ?? "a published wealth list"} with a reported figure of ${formatGBP(
            top.midGBP,
          )}.`,
        );
        break;
    }
  }

  // Then the signals that corroborate or add urgency.
  const recent = input.signals
    .filter((s) => Date.now() - s.occurredOn.getTime() < 730 * 24 * 3600 * 1000)
    .sort((a, b) => b.occurredOn.getTime() - a.occurredOn.getTime());

  const phrases: string[] = [];
  const seen = new Set<SignalType>();
  for (const s of recent) {
    if (seen.has(s.type)) continue;
    seen.add(s.type);
    const phrase = SIGNAL_PHRASES[s.type];
    if (phrase) {
      phrases.push(phrase);
      reasons.push(titleCase(phrase));
    }
    if (phrases.length >= 3) break;
  }
  if (phrases.length) {
    sentences.push(`Corroborating signals in the last 24 months include ${joinList(phrases)}.`);
  }

  // Finally the qualification verdict, stated as an estimate.
  if (qualifies) {
    sentences.push(
      `Estimated investable assets of ${formatGBP(investable)} (range ${formatGBP(
        estimate.investableLowGBP,
      )}–${formatGBP(estimate.investableHighGBP)}) against gross estimated wealth of ${formatGBP(
        gross,
      )}. ${
        investable >= QUALIFYING_THRESHOLD_GBP
          ? `That clears the £7.5m qualifying threshold.`
          : `Investable assets sit below the £7.5m threshold, but paper wealth of ${formatGBP(
              gross,
            )} makes this a pre-liquidity relationship worth building now.`
      }`,
    );
  } else {
    sentences.push(
      `Estimated investable assets of ${formatGBP(
        investable,
      )} are below the £7.5m qualifying threshold on current evidence.`,
    );
  }

  sentences.push(
    "All figures are modelled estimates derived from public sources, not verified statements of wealth.",
  );

  return {
    qualifies,
    isPriority,
    rationale: sentences.join(" "),
    reasons: [...new Set(reasons)].slice(0, 4),
  };
}

function joinList(items: string[]): string {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
