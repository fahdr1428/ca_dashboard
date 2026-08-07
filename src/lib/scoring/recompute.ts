import { prisma, toBigInt } from "@/lib/db";
import { estimateWealth, type EstimateInput, type WealthEstimate } from "./estimate";
import { scoreConfidence, type ConfidenceResult } from "./confidence";
import { qualifyProspect } from "./qualify";
import { valueCompany, exitPotential, revenueCagr, pretaxMargin, type FinancialPeriod } from "./valuation";
import { REGION_META } from "@/lib/regions";
import type { EvidenceStrength, SourceType } from "@/generated/prisma/enums";

/**
 * Recomputation is the single place where stored numbers are produced. Nothing
 * else in the app writes an estimate, a confidence score or a wealth band, so
 * the model can be changed in one place and re-applied to the whole book.
 */

const EXIT_SIGNAL_TYPES = new Set(["IPO_PREPARATION", "MA_ACTIVITY", "PE_INVESTMENT"]);

/** Re-value one company from its filed financials and funding history. */
export async function recomputeCompany(companyId: string): Promise<void> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: {
      financials: { orderBy: { periodEnd: "desc" } },
      fundingRounds: { orderBy: { announcedOn: "desc" }, take: 1 },
      signals: { where: { occurredOn: { gte: monthsAgo(24) } } },
    },
  });
  if (!company) return;

  const financials: FinancialPeriod[] = company.financials.map((f) => ({
    periodEnd: f.periodEnd,
    revenueGBP: f.revenueGBP === null ? null : Number(f.revenueGBP),
    ebitdaGBP: f.ebitdaGBP === null ? null : Number(f.ebitdaGBP),
    pretaxProfitGBP: f.pretaxProfitGBP === null ? null : Number(f.pretaxProfitGBP),
    netAssetsGBP: f.netAssetsGBP === null ? null : Number(f.netAssetsGBP),
    cashGBP: f.cashGBP === null ? null : Number(f.cashGBP),
    isAbridged: f.isAbridged,
  }));

  const round = company.fundingRounds[0];
  const valuation = valueCompany({
    industry: company.industry,
    financials,
    latestPostMoneyGBP: round?.postMoneyGBP ? Number(round.postMoneyGBP) : null,
    latestRoundDate: round?.announcedOn ?? null,
  });

  const cagr = revenueCagr(financials);
  const margin = pretaxMargin(financials[0]);
  const ageYears = company.incorporatedOn
    ? (Date.now() - company.incorporatedOn.getTime()) / (365.25 * 24 * 3600 * 1000)
    : null;

  const exit = exitPotential({
    cagrPct: cagr,
    marginPct: margin,
    hasPeBacking: company.signals.some((s) => s.type === "PE_INVESTMENT"),
    hasIpoSignal: company.signals.some((s) => s.type === "IPO_PREPARATION"),
    hasMaSignal: company.signals.some((s) => s.type === "MA_ACTIVITY"),
    companyAgeYears: ageYears,
    valuationMidGBP: valuation.midGBP,
  });

  await prisma.company.update({
    where: { id: companyId },
    data: {
      estValuationLowGBP: toBigInt(valuation.lowGBP),
      estValuationMidGBP: toBigInt(valuation.midGBP),
      estValuationHighGBP: toBigInt(valuation.highGBP),
      valuationMethod: valuation.method,
      valuationMultiple: valuation.multiple,
      valuationAsOf: valuation.asOf,
      exitPotential: exit.score,
      exitRationale: exit.rationale,
    },
  });
}

export interface RecomputeOutcome {
  prospectId: string;
  estimate: WealthEstimate;
  confidence: ConfidenceResult;
  qualifies: boolean;
  /** Change in investable midpoint since the previous stored value. */
  deltaInvestableGBP: number;
  bandChanged: boolean;
}

/** Re-run the wealth model, confidence model and rationale for one prospect. */
export async function recomputeProspect(prospectId: string): Promise<RecomputeOutcome | null> {
  const p = await prisma.prospect.findUnique({
    where: { id: prospectId },
    include: {
      company: true,
      shareholdings: {
        where: { isCurrent: true },
        include: {
          company: {
            include: {
              signals: { where: { occurredOn: { gte: monthsAgo(18) } } },
              corporateEvents: true,
            },
          },
        },
      },
      publicHoldings: true,
      dividends: { include: { company: true } },
      signals: { orderBy: { occurredOn: "desc" }, include: { source: true } },
    },
  });
  if (!p) return null;

  // --- Gather the citations backing this record --------------------------
  const citations = await prisma.citation.findMany({
    where: {
      OR: [
        { entityType: "prospect", entityId: p.id },
        { entityType: "company", entityId: { in: p.shareholdings.map((s) => s.companyId) } },
        { entityType: "shareholding", entityId: { in: p.shareholdings.map((s) => s.id) } },
      ],
    },
    include: { source: true },
  });
  const sourcesById = new Map<string, { sourceType: SourceType; reliability: number }>();
  for (const c of citations) {
    sourcesById.set(c.source.id, {
      sourceType: c.source.sourceType,
      reliability: c.source.reliability,
    });
  }
  for (const s of p.signals) {
    if (s.source) {
      sourcesById.set(s.source.id, {
        sourceType: s.source.sourceType,
        reliability: s.source.reliability,
      });
    }
  }

  const citationsFor = (entityType: string, entityId: string): string[] =>
    citations.filter((c) => c.entityType === entityType && c.entityId === entityId).map((c) => c.sourceId);

  // --- Build the estimate input ------------------------------------------
  const caveats: string[] = [];

  const stakes: EstimateInput["stakes"] = [];
  for (const sh of p.shareholdings) {
    const c = sh.company;
    const inExit = c.signals.some((s) => EXIT_SIGNAL_TYPES.has(s.type));
    const valMid = Number(c.estValuationMidGBP ?? 0n);
    if (valMid <= 0) {
      caveats.push(`${c.name}: no valuation could be produced, so this stake contributes nothing to the estimate.`);
      continue;
    }
    stakes.push({
      companyName: c.name,
      ownershipPctLow: sh.ownershipPctLow,
      ownershipPctHigh: sh.ownershipPctHigh,
      evidence: sh.evidence,
      valuationLowGBP: Number(c.estValuationLowGBP ?? 0n),
      valuationMidGBP: valMid,
      valuationHighGBP: Number(c.estValuationHighGBP ?? 0n),
      valuationMethod: c.valuationMethod ?? "Not stated",
      inExitProcess: inExit,
      sourceIds: [...citationsFor("shareholding", sh.id), ...citationsFor("company", c.id)],
    });
  }

  const exits: EstimateInput["exits"] = [];
  for (const sh of p.shareholdings) {
    for (const ev of sh.company.corporateEvents) {
      if (!ev.completedOn || !ev.considerationGBP) continue;
      if (!["ACQUIRED_BY", "TRADE_SALE", "SECONDARY_SALE", "MBO"].includes(ev.type)) continue;
      exits.push({
        companyName: sh.company.name,
        completedOn: ev.completedOn,
        considerationGBP: Number(ev.considerationGBP),
        ownershipPct: (sh.ownershipPctLow + sh.ownershipPctHigh) / 2,
        evidence: ev.evidence,
        sourceIds: citationsFor("corporateEvent", ev.id),
      });
    }
  }

  const dividends: EstimateInput["dividends"] = p.dividends
    .filter((d) => d.attributedGBP && Number(d.attributedGBP) > 0)
    .map((d) => ({
      companyName: d.company.name,
      periodEnd: d.periodEnd,
      attributedGBP: Number(d.attributedGBP),
      evidence: d.evidence,
      sourceIds: citationsFor("dividend", d.id),
    }));

  const publicHoldings: EstimateInput["publicHoldings"] = p.publicHoldings
    .filter((h) => h.valueGBP && Number(h.valueGBP) > 0)
    .map((h) => ({
      companyName: h.companyName,
      valueGBP: Number(h.valueGBP),
      asOf: h.asOf,
      evidence: h.evidence,
      sourceIds: citationsFor("publicHolding", h.id),
    }));

  // Remuneration and reported wealth are carried on the existing breakdown so
  // advisor-entered research survives a model re-run.
  const previous = p.estimateBreakdown as WealthEstimate | null;
  const prevRemuneration = previous?.components?.find((c) => c.key === "REMUNERATION");
  const prevReported = previous?.components?.filter((c) => c.key === "REPORTED_OR_INHERITED") ?? [];

  const estimate = estimateWealth({
    stakes,
    exits,
    dividends,
    remuneration: prevRemuneration
      ? {
          annualGBP: Number(prevRemuneration.inputs.annualGBP ?? 0),
          years: Number(prevRemuneration.inputs.years ?? 0),
          evidence: prevRemuneration.evidence,
          sourceIds: prevRemuneration.sourceIds,
        }
      : null,
    publicHoldings,
    reported: prevReported.map((c) => ({
      label: c.subject ?? "Reported wealth",
      lowGBP: c.lowGBP,
      midGBP: c.midGBP,
      highGBP: c.highGBP,
      evidence: c.evidence,
      sourceIds: c.sourceIds,
    })),
    inheritedCaveats: caveats,
  });

  // --- Confidence ---------------------------------------------------------
  const strongestEvidence = strongest(p.shareholdings.map((s) => s.evidence));
  const allFinancials = await prisma.companyFinancial.findMany({
    where: { companyId: { in: p.shareholdings.map((s) => s.companyId) } },
    orderBy: { periodEnd: "desc" },
    take: 1,
  });
  const latestAccounts = allFinancials[0];
  const accountsAgeMonths = latestAccounts
    ? (Date.now() - latestAccounts.periodEnd.getTime()) / (30.44 * 24 * 3600 * 1000)
    : null;

  const confidence = scoreConfidence({
    chOfficerMatched: Boolean(p.chOfficerId),
    identityConfidence: p.identityConfidence,
    ownershipEvidence: strongestEvidence,
    ownershipIsBanded: p.shareholdings.some((s) => s.ownershipPctHigh - s.ownershipPctLow >= 20),
    accountsAgeMonths,
    accountsAreAbridged: latestAccounts?.isAbridged ?? false,
    sources: [...sourcesById.values()],
    estimate,
    recentSignalCount: p.signals.filter((s) => s.occurredOn >= monthsAgo(24)).length,
  });

  // --- Rationale ----------------------------------------------------------
  const qualification = qualifyProspect({
    fullName: p.fullName,
    jobTitle: p.jobTitle,
    companyName: p.company?.name ?? p.shareholdings[0]?.company.name ?? null,
    regionLabel: REGION_META[p.region].label,
    estimate,
    signals: p.signals.map((s) => ({
      type: s.type,
      title: s.title,
      occurredOn: s.occurredOn,
      magnitudeGBP: s.magnitudeGBP === null ? null : Number(s.magnitudeGBP),
    })),
  });

  const previousInvestable = Number(p.estInvestableMidGBP);
  const deltaInvestableGBP = estimate.investableMidGBP - previousInvestable;
  const bandChanged = p.wealthBand !== estimate.wealthBand;

  await prisma.prospect.update({
    where: { id: p.id },
    data: {
      estGrossWealthLowGBP: toBigInt(estimate.grossLowGBP),
      estGrossWealthMidGBP: toBigInt(estimate.grossMidGBP),
      estGrossWealthHighGBP: toBigInt(estimate.grossHighGBP),
      estInvestableLowGBP: toBigInt(estimate.investableLowGBP),
      estInvestableMidGBP: toBigInt(estimate.investableMidGBP),
      estInvestableHighGBP: toBigInt(estimate.investableHighGBP),
      wealthBand: estimate.wealthBand,
      estimateBreakdown: estimate as unknown as object,
      confidence: confidence.score,
      confidenceBand: confidence.band,
      confidenceBreakdown: confidence as unknown as object,
      rationale: qualification.rationale,
      tags: mergeTags(p.tags, qualification.reasons),
    },
  });

  // Record a material revision on the timeline so the weekly report can
  // explain what moved and why.
  //
  // The first computation for a new prospect is not a revision — it is the
  // record coming into existence. Logging it as a "wealth increase" would fill
  // the weekly report with phantom movements the moment the book is populated.
  const isFirstComputation = previousInvestable === 0 && Number(p.estGrossWealthMidGBP) === 0;
  const isMaterialMove =
    Math.abs(deltaInvestableGBP) > Math.max(250_000, previousInvestable * 0.05) || bandChanged;

  if (!isFirstComputation && isMaterialMove) {
    await prisma.prospectEvent.create({
      data: {
        prospectId: p.id,
        type: "estimate_revised",
        message: bandChanged
          ? `Wealth band moved from ${p.wealthBand} to ${estimate.wealthBand}.`
          : `Estimated investable assets revised by ${deltaInvestableGBP >= 0 ? "+" : ""}${Math.round(
              deltaInvestableGBP / 1000,
            )}k.`,
        before: { investableMidGBP: previousInvestable, wealthBand: p.wealthBand },
        after: { investableMidGBP: estimate.investableMidGBP, wealthBand: estimate.wealthBand },
        actor: "system:model",
      },
    });
  }

  return {
    prospectId: p.id,
    estimate,
    confidence,
    qualifies: qualification.qualifies,
    deltaInvestableGBP,
    bandChanged,
  };
}

/** Weekly point-in-time snapshot for trend charts. */
export async function snapshotProspects(): Promise<number> {
  const prospects = await prisma.prospect.findMany({
    where: { suppressedAt: null },
    select: {
      id: true,
      estGrossWealthMidGBP: true,
      estInvestableMidGBP: true,
      confidence: true,
      wealthBand: true,
    },
  });
  if (!prospects.length) return 0;
  await prisma.wealthSnapshot.createMany({
    data: prospects.map((p) => ({
      prospectId: p.id,
      estGrossMidGBP: p.estGrossWealthMidGBP,
      estInvestableMidGBP: p.estInvestableMidGBP,
      confidence: p.confidence,
      wealthBand: p.wealthBand,
    })),
  });
  return prospects.length;
}

/** Recompute the whole book. Used after a model change or a full ingest. */
export async function recomputeAll(): Promise<{ companies: number; prospects: number }> {
  const companies = await prisma.company.findMany({ select: { id: true } });
  for (const c of companies) await recomputeCompany(c.id);

  const prospects = await prisma.prospect.findMany({ select: { id: true } });
  for (const p of prospects) await recomputeProspect(p.id);

  return { companies: companies.length, prospects: prospects.length };
}

const EVIDENCE_ORDER: EvidenceStrength[] = ["ASSERTED", "MODELLED", "REPORTED", "DISCLOSED", "FILED"];

function strongest(list: EvidenceStrength[]): "FILED" | "DISCLOSED" | "REPORTED" | "MODELLED" | "ASSERTED" | "NONE" {
  if (!list.length) return "NONE";
  return list.reduce((best, e) =>
    EVIDENCE_ORDER.indexOf(e) > EVIDENCE_ORDER.indexOf(best) ? e : best,
  );
}

function mergeTags(existing: string[], generated: string[]): string[] {
  // Advisor-added tags start with "@" and are never overwritten by the model.
  const manual = existing.filter((t) => t.startsWith("@"));
  return [...new Set([...manual, ...generated])];
}

function monthsAgo(n: number): Date {
  return new Date(Date.now() - n * 30.44 * 24 * 3600 * 1000);
}
