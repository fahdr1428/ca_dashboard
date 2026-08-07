import { confidenceBandFor } from "@/lib/wealth";
import type { ConfidenceBand, SourceType } from "@/generated/prisma/enums";
import type { WealthEstimate } from "./estimate";

/**
 * Confidence scoring.
 *
 * Confidence answers "how much should the advisor trust this record?", which is
 * a different question from "how rich is this person?". It is scored across five
 * independent dimensions so a weak spot is visible rather than averaged away.
 */

export interface ConfidenceDimension {
  key: string;
  label: string;
  /** 0-100 for this dimension alone. */
  score: number;
  weight: number;
  /** Why it scored what it scored — rendered in the UI. */
  explanation: string;
}

export interface ConfidenceResult {
  score: number;
  band: ConfidenceBand;
  dimensions: ConfidenceDimension[];
  /** The single biggest thing that would raise this score. */
  nextBestAction: string;
  computedAt: string;
}

/** How much a source type counts towards corroboration. */
const SOURCE_WEIGHT: Record<SourceType, number> = {
  COMPANIES_HOUSE: 1.0,
  COMPANY_ACCOUNTS: 1.0,
  RNS_REGULATORY: 0.95,
  LAND_REGISTRY: 0.9,
  CHARITY_COMMISSION: 0.8,
  OPEN_DATASET: 0.75,
  PRESS_RELEASE: 0.55,
  NEWS: 0.6,
  FUNDING_DATABASE: 0.6,
  PUBLIC_WEALTH_LIST: 0.5,
  COMPANY_WEBSITE: 0.45,
  LINKEDIN: 0.35,
  MANUAL: 0.4,
};

export interface ConfidenceInput {
  /** Did we match the person to a Companies House officer record? */
  chOfficerMatched: boolean;
  /** 0-100 from the name/DOB/address matcher. */
  identityConfidence: number;
  /** Strongest ownership evidence we hold. */
  ownershipEvidence: "FILED" | "DISCLOSED" | "REPORTED" | "MODELLED" | "ASSERTED" | "NONE";
  /** Whether ownership is a PSC band (wide) or an exact shareholding. */
  ownershipIsBanded: boolean;
  /** Months since the most recent filed accounts. */
  accountsAgeMonths: number | null;
  accountsAreAbridged: boolean;
  /** Distinct sources supporting the record. */
  sources: Array<{ sourceType: SourceType; reliability: number }>;
  /** The estimate whose spread we are judging. */
  estimate: Pick<WealthEstimate, "investableLowGBP" | "investableMidGBP" | "investableHighGBP" | "components">;
  /** Corroborating signals detected in the last 24 months. */
  recentSignalCount: number;
}

export function scoreConfidence(input: ConfidenceInput): ConfidenceResult {
  const dims: ConfidenceDimension[] = [];

  // --- 1. Identity (is this the right person?) ----------------------------
  {
    let score = Math.min(100, input.identityConfidence);
    let explanation: string;
    if (input.chOfficerMatched) {
      score = Math.max(score, 82);
      explanation =
        "Matched to a Companies House officer record, so the individual behind the appointments is confirmed.";
    } else {
      score = Math.min(score, 55);
      explanation =
        "Not yet matched to a Companies House officer record — the person is identified by name and location only, which is unreliable for common names.";
    }
    dims.push({ key: "identity", label: "Identity verification", score, weight: 0.22, explanation });
  }

  // --- 2. Ownership evidence ---------------------------------------------
  {
    const base: Record<ConfidenceInput["ownershipEvidence"], number> = {
      FILED: 92,
      DISCLOSED: 78,
      REPORTED: 55,
      MODELLED: 38,
      ASSERTED: 30,
      NONE: 10,
    };
    let score = base[input.ownershipEvidence];
    const notes: string[] = [];
    switch (input.ownershipEvidence) {
      case "FILED":
        notes.push("Ownership is evidenced by a statutory filing (PSC register or confirmation statement).");
        break;
      case "DISCLOSED":
        notes.push("Ownership comes from a regulated or company-issued disclosure.");
        break;
      case "REPORTED":
        notes.push("Ownership is reported by press coverage only and has not been verified against the register.");
        break;
      case "MODELLED":
        notes.push("Ownership is inferred rather than evidenced.");
        break;
      default:
        notes.push("No ownership evidence on file.");
    }
    if (input.ownershipIsBanded) {
      score -= 8;
      notes.push("The PSC register gives a 25-point band rather than an exact percentage, so the stake size is imprecise.");
    }
    dims.push({
      key: "ownership",
      label: "Ownership evidence",
      score: clamp(score),
      weight: 0.26,
      explanation: notes.join(" "),
    });
  }

  // --- 3. Financial data quality -----------------------------------------
  {
    let score: number;
    const notes: string[] = [];
    if (input.accountsAgeMonths === null) {
      score = 20;
      notes.push("No filed accounts are attached to the underlying company.");
    } else {
      // 100 at 0 months, decaying to ~35 at 30 months.
      score = Math.max(25, 100 - input.accountsAgeMonths * 2.2);
      notes.push(
        `Most recent accounts are ${Math.round(input.accountsAgeMonths)} months old.` +
          (input.accountsAgeMonths > 21
            ? " That is beyond the usual filing cycle, so the picture may be materially out of date."
            : ""),
      );
    }
    if (input.accountsAreAbridged) {
      score -= 22;
      notes.push("Accounts are abridged, so turnover and profit are not disclosed and had to be inferred.");
    }
    dims.push({
      key: "financials",
      label: "Financial data quality",
      score: clamp(score),
      weight: 0.2,
      explanation: notes.join(" "),
    });
  }

  // --- 4. Source corroboration -------------------------------------------
  {
    const distinctTypes = new Set(input.sources.map((s) => s.sourceType));
    const weighted = input.sources.reduce(
      (a, s) => a + (SOURCE_WEIGHT[s.sourceType] ?? 0.4) * (s.reliability / 5),
      0,
    );
    // Saturating: 3 good independent sources gets you most of the way.
    let score = 100 * (1 - Math.exp(-weighted / 1.6));
    if (distinctTypes.size >= 3) score += 8;
    if (input.recentSignalCount >= 2) score += 5;
    const notes = [
      `${input.sources.length} public source${input.sources.length === 1 ? "" : "s"} across ${
        distinctTypes.size
      } source type${distinctTypes.size === 1 ? "" : "s"}.`,
    ];
    if (distinctTypes.size <= 1) {
      notes.push("Single-source records are the most common cause of false positives — corroborate before contact.");
    }
    dims.push({
      key: "corroboration",
      label: "Source corroboration",
      score: clamp(score),
      weight: 0.18,
      explanation: notes.join(" "),
    });
  }

  // --- 5. Estimate precision ---------------------------------------------
  {
    const mid = input.estimate.investableMidGBP;
    let score: number;
    let explanation: string;
    if (mid <= 0) {
      score = 15;
      explanation = "No investable-asset estimate could be produced.";
    } else {
      const spread =
        (input.estimate.investableHighGBP - input.estimate.investableLowGBP) / Math.max(mid, 1);
      // spread of 0.5 -> ~85, 1.5 -> ~55, 3 -> ~25
      score = clamp(100 - spread * 27);
      explanation = `The investable range spans ${(spread * 100).toFixed(0)}% of the midpoint.${
        spread > 1.6 ? " That is wide — the figure should be treated as an order of magnitude." : ""
      }`;
      const softest = input.estimate.components
        .filter((c) => c.key === "REMUNERATION" || c.key === "REPORTED_OR_INHERITED")
        .reduce((a, c) => a + c.midGBP, 0);
      if (softest / mid > 0.5) {
        score -= 12;
        explanation += " Over half the estimate rests on behavioural or third-party assumptions.";
      }
    }
    dims.push({
      key: "precision",
      label: "Estimate precision",
      score: clamp(score),
      weight: 0.14,
      explanation,
    });
  }

  const total = dims.reduce((a, d) => a + d.score * d.weight, 0);
  const score = Math.round(clamp(total));

  const weakest = [...dims].sort((a, b) => a.score * a.weight - b.score * b.weight)[0];
  const actions: Record<string, string> = {
    identity: "Match the individual to their Companies House officer profile to confirm identity.",
    ownership: "Pull the PSC register entry or latest confirmation statement to evidence the stake.",
    financials: "Check Companies House for newer accounts, or request the latest filed set.",
    corroboration: "Find a second, independent public source — ideally a filing rather than press coverage.",
    precision: "Narrow the valuation inputs; a disclosed transaction price would tighten the range most.",
  };

  return {
    score,
    band: confidenceBandFor(score),
    dimensions: dims,
    nextBestAction: actions[weakest.key] ?? "Corroborate with an additional public source.",
    computedAt: new Date().toISOString(),
  };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}
