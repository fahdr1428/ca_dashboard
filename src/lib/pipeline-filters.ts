import { QUALIFYING_THRESHOLD_GBP, PRIORITY_THRESHOLD_GBP } from "./wealth";
import type { Prisma } from "@/generated/prisma/client";

/**
 * The definition of "who counts" lives here and nowhere else, so a KPI card, a
 * table filter and the weekly report can never disagree about the size of the
 * pipeline.
 *
 * Two distinct cohorts, because they need different treatment:
 *
 *  - QUALIFYING: estimated investable assets at or above £7.5m. These are
 *    prospects a discretionary manager could take on today.
 *  - PRE-LIQUIDITY FOUNDERS: gross estimated wealth at or above £15m but
 *    investable assets below the threshold. Almost always founder equity that
 *    hasn't been realised. Not mandates today, but the relationship has to be
 *    built before the exit, not after.
 */

const investableAtLeast = (gbp: number): Prisma.ProspectWhereInput => ({
  estInvestableMidGBP: { gte: BigInt(gbp) },
});

export const NOT_SUPPRESSED: Prisma.ProspectWhereInput = { suppressedAt: null };

export const QUALIFYING_WHERE: Prisma.ProspectWhereInput = {
  ...NOT_SUPPRESSED,
  ...investableAtLeast(QUALIFYING_THRESHOLD_GBP),
};

export const PRE_LIQUIDITY_WHERE: Prisma.ProspectWhereInput = {
  ...NOT_SUPPRESSED,
  estGrossWealthMidGBP: { gte: BigInt(PRIORITY_THRESHOLD_GBP) },
  estInvestableMidGBP: { lt: BigInt(QUALIFYING_THRESHOLD_GBP) },
};

/** Everyone worth showing in the pipeline: either cohort. */
export const IN_PIPELINE_WHERE: Prisma.ProspectWhereInput = {
  ...NOT_SUPPRESSED,
  OR: [
    investableAtLeast(QUALIFYING_THRESHOLD_GBP),
    { estGrossWealthMidGBP: { gte: BigInt(PRIORITY_THRESHOLD_GBP) } },
  ],
};

export type Cohort = "QUALIFYING" | "PRE_LIQUIDITY" | "BELOW_THRESHOLD";

export function cohortFor(input: {
  estInvestableMidGBP: number;
  estGrossWealthMidGBP: number;
}): Cohort {
  if (input.estInvestableMidGBP >= QUALIFYING_THRESHOLD_GBP) return "QUALIFYING";
  if (input.estGrossWealthMidGBP >= PRIORITY_THRESHOLD_GBP) return "PRE_LIQUIDITY";
  return "BELOW_THRESHOLD";
}

export const COHORT_LABELS: Record<Cohort, string> = {
  QUALIFYING: "Qualifying",
  PRE_LIQUIDITY: "Pre-liquidity founder",
  BELOW_THRESHOLD: "Below threshold",
};

export const COHORT_DESCRIPTIONS: Record<Cohort, string> = {
  QUALIFYING:
    "Estimated investable assets of £7.5m or more — a mandate that could be written today.",
  PRE_LIQUIDITY:
    "£15m+ of gross estimated wealth, but most of it is unrealised founder equity. Build the relationship before the liquidity event.",
  BELOW_THRESHOLD:
    "Below both thresholds on current evidence. Kept for monitoring in case the picture changes.",
};
