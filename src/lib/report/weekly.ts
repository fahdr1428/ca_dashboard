import { prisma, toBigInt } from "@/lib/db";
import { startOfIsoWeek, endOfIsoWeek, formatDate } from "@/lib/utils";
import { formatGBP, BAND_META } from "@/lib/wealth";
import { QUALIFYING_WHERE } from "@/lib/pipeline-filters";
import { REGION_META } from "@/lib/regions";
import type { Region, SignalType, WealthBand } from "@/generated/prisma/enums";

/**
 * The Monday-morning intelligence report.
 *
 * Two halves, matching how an advisor actually works: who is new this week and
 * why they qualify, then what changed for people already in the book.
 */

export interface ReportNewProspect {
  id: string;
  slug: string;
  fullName: string;
  jobTitle: string | null;
  companyName: string | null;
  region: Region;
  regionLabel: string;
  wealthBand: WealthBand;
  wealthBandLabel: string;
  estInvestableMidGBP: number;
  estGrossMidGBP: number;
  confidence: number;
  rationale: string | null;
  companySummary: string | null;
  sourceCount: number;
}

export interface ReportChange {
  prospectId: string;
  slug: string;
  fullName: string;
  companyName: string | null;
  regionLabel: string;
  headline: string;
  detail: string;
  kind:
    | "WEALTH_INCREASE"
    | "WEALTH_DECREASE"
    | "BAND_CHANGE"
    | "NEW_FUNDING"
    | "NEW_DIVIDEND"
    | "ACQUISITION"
    | "EXIT"
    | "DIRECTOR_CHANGE"
    | "COMPANY_GROWTH"
    | "OTHER";
  magnitudeGBP: number | null;
  occurredOn: string;
  sourceUrl: string | null;
}

export interface WeeklyReportPayload {
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  totals: {
    prospects: number;
    qualifying: number;
    newThisWeek: number;
    addressableGBP: number;
    deltaAddressableGBP: number;
    signalsThisWeek: number;
  };
  newProspects: ReportNewProspect[];
  changes: ReportChange[];
  byRegion: Array<{ region: Region; label: string; count: number; addressableGBP: number }>;
  topSignals: Array<{
    id: string;
    type: SignalType;
    title: string;
    summary: string | null;
    occurredOn: string;
    magnitudeGBP: number | null;
    prospectName: string | null;
    companyName: string | null;
    sourceUrl: string | null;
  }>;
  dataQuality: {
    lowConfidenceCount: number;
    unverifiedIdentityCount: number;
    staleAccountsCount: number;
  };
}

const CHANGE_KIND_BY_SIGNAL: Partial<Record<SignalType, ReportChange["kind"]>> = {
  VENTURE_FUNDING: "NEW_FUNDING",
  PE_INVESTMENT: "NEW_FUNDING",
  LARGE_DIVIDEND: "NEW_DIVIDEND",
  MA_ACTIVITY: "ACQUISITION",
  BUSINESS_EXIT: "EXIT",
  LIQUIDITY_EVENT: "EXIT",
  DIRECTOR_APPOINTMENT: "DIRECTOR_CHANGE",
  PSC_CHANGE: "DIRECTOR_CHANGE",
  REVENUE_GROWTH: "COMPANY_GROWTH",
  HIGH_PROFITABILITY: "COMPANY_GROWTH",
};

export async function buildWeeklyReport(reference: Date = new Date()): Promise<{
  payload: WeeklyReportPayload;
  markdown: string;
}> {
  const weekStart = startOfIsoWeek(reference);
  const weekEnd = endOfIsoWeek(reference);
  const previousWeekStart = new Date(weekStart);
  previousWeekStart.setUTCDate(previousWeekStart.getUTCDate() - 7);

  // --- New prospects -------------------------------------------------------
  const newProspectRows = await prisma.prospect.findMany({
    where: { dateAdded: { gte: weekStart, lte: weekEnd }, suppressedAt: null },
    include: {
      company: { include: { financials: { orderBy: { periodEnd: "desc" }, take: 1 } } },
      shareholdings: { include: { company: true } },
    },
    orderBy: { estInvestableMidGBP: "desc" },
  });

  const citationCounts = await prisma.citation.groupBy({
    by: ["entityId"],
    where: { entityType: "prospect", entityId: { in: newProspectRows.map((p) => p.id) } },
    _count: { _all: true },
  });
  const citationsByProspect = new Map(citationCounts.map((c) => [c.entityId, c._count._all]));

  const newProspects: ReportNewProspect[] = newProspectRows.map((p) => {
    const company = p.company ?? p.shareholdings[0]?.company ?? null;
    const latest = p.company?.financials?.[0];
    return {
      id: p.id,
      slug: p.slug,
      fullName: p.fullName,
      jobTitle: p.jobTitle,
      companyName: company?.name ?? null,
      region: p.region,
      regionLabel: REGION_META[p.region].label,
      wealthBand: p.wealthBand,
      wealthBandLabel: BAND_META[p.wealthBand].label,
      estInvestableMidGBP: Number(p.estInvestableMidGBP),
      estGrossMidGBP: Number(p.estGrossWealthMidGBP),
      confidence: p.confidence,
      rationale: p.rationale,
      companySummary: company
        ? [
            company.industry,
            company.estValuationMidGBP
              ? `estimated value ${formatGBP(Number(company.estValuationMidGBP))}`
              : null,
            latest?.revenueGBP ? `turnover ${formatGBP(Number(latest.revenueGBP))}` : null,
            latest?.pretaxProfitGBP
              ? `pre-tax profit ${formatGBP(Number(latest.pretaxProfitGBP))}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : null,
      sourceCount: citationsByProspect.get(p.id) ?? 0,
    };
  });

  // --- Changes to existing prospects --------------------------------------
  const changes: ReportChange[] = [];

  // 1. Model revisions recorded on the timeline.
  const revisions = await prisma.prospectEvent.findMany({
    where: {
      type: "estimate_revised",
      createdAt: { gte: weekStart, lte: weekEnd },
      prospect: { dateAdded: { lt: weekStart }, suppressedAt: null },
    },
    include: { prospect: { include: { company: true } } },
    orderBy: { createdAt: "desc" },
  });

  for (const r of revisions) {
    const before = (r.before ?? {}) as { investableMidGBP?: number; wealthBand?: string };
    const after = (r.after ?? {}) as { investableMidGBP?: number; wealthBand?: string };
    const delta = (after.investableMidGBP ?? 0) - (before.investableMidGBP ?? 0);
    const bandChanged = before.wealthBand !== after.wealthBand;
    changes.push({
      prospectId: r.prospectId,
      slug: r.prospect.slug,
      fullName: r.prospect.fullName,
      companyName: r.prospect.company?.name ?? null,
      regionLabel: REGION_META[r.prospect.region].label,
      headline: bandChanged
        ? `Moved to the ${BAND_META[after.wealthBand as WealthBand]?.label ?? "next"} band`
        : `Estimated investable assets ${delta >= 0 ? "up" : "down"} ${formatGBP(Math.abs(delta))}`,
      detail: r.message,
      kind: bandChanged ? "BAND_CHANGE" : delta >= 0 ? "WEALTH_INCREASE" : "WEALTH_DECREASE",
      magnitudeGBP: delta,
      occurredOn: r.createdAt.toISOString(),
      sourceUrl: null,
    });
  }

  // 2. Signals detected this week against existing prospects.
  const weekSignals = await prisma.signal.findMany({
    where: {
      detectedAt: { gte: weekStart, lte: weekEnd },
      prospect: { dateAdded: { lt: weekStart }, suppressedAt: null },
    },
    include: { prospect: { include: { company: true } }, source: true, company: true },
    orderBy: [{ weight: "desc" }, { occurredOn: "desc" }],
  });

  for (const s of weekSignals) {
    if (!s.prospect) continue;
    changes.push({
      prospectId: s.prospect.id,
      slug: s.prospect.slug,
      fullName: s.prospect.fullName,
      companyName: s.company?.name ?? s.prospect.company?.name ?? null,
      regionLabel: REGION_META[s.prospect.region].label,
      headline: s.title,
      detail: s.summary ?? "",
      kind: CHANGE_KIND_BY_SIGNAL[s.type] ?? "OTHER",
      magnitudeGBP: s.magnitudeGBP === null ? null : Number(s.magnitudeGBP),
      occurredOn: s.occurredOn.toISOString(),
      sourceUrl: s.source?.url ?? null,
    });
  }

  changes.sort((a, b) => Math.abs(b.magnitudeGBP ?? 0) - Math.abs(a.magnitudeGBP ?? 0));

  // --- Totals --------------------------------------------------------------
  const qualifyingWhere = QUALIFYING_WHERE;

  const [prospectCount, qualifyingCount, addressable, signalsThisWeek] = await Promise.all([
    prisma.prospect.count({ where: { suppressedAt: null } }),
    prisma.prospect.count({ where: qualifyingWhere }),
    prisma.prospect.aggregate({ where: qualifyingWhere, _sum: { estInvestableMidGBP: true } }),
    prisma.signal.count({ where: { detectedAt: { gte: weekStart, lte: weekEnd } } }),
  ]);

  const addressableGBP = Number(addressable._sum.estInvestableMidGBP ?? 0n);

  const previousReport = await prisma.weeklyReport.findFirst({
    where: { weekStart: { lt: weekStart } },
    orderBy: { weekStart: "desc" },
  });
  const deltaAddressableGBP = previousReport
    ? addressableGBP - Number(previousReport.totalAddressableGBP)
    : 0;

  // --- Region breakdown ----------------------------------------------------
  const regionGroups = await prisma.prospect.groupBy({
    by: ["region"],
    where: qualifyingWhere,
    _count: { _all: true },
    _sum: { estInvestableMidGBP: true },
  });
  const byRegion = regionGroups
    .map((g) => ({
      region: g.region,
      label: REGION_META[g.region].label,
      count: g._count._all,
      addressableGBP: Number(g._sum.estInvestableMidGBP ?? 0n),
    }))
    .sort((a, b) => b.addressableGBP - a.addressableGBP);

  // --- Top signals ---------------------------------------------------------
  const topSignalRows = await prisma.signal.findMany({
    where: { detectedAt: { gte: weekStart, lte: weekEnd } },
    include: { prospect: true, company: true, source: true },
    orderBy: [{ weight: "desc" }, { magnitudeGBP: "desc" }],
    take: 12,
  });

  // --- Data quality --------------------------------------------------------
  const twoYearsAgo = new Date(Date.now() - 730 * 24 * 3600 * 1000);
  const [lowConfidenceCount, unverifiedIdentityCount, staleAccountsCount] = await Promise.all([
    prisma.prospect.count({ where: { suppressedAt: null, confidence: { lt: 45 } } }),
    prisma.prospect.count({ where: { suppressedAt: null, chOfficerId: null } }),
    prisma.company.count({
      where: {
        financials: { none: { periodEnd: { gte: twoYearsAgo } } },
        prospects: { some: {} },
      },
    }),
  ]);

  const payload: WeeklyReportPayload = {
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    generatedAt: new Date().toISOString(),
    totals: {
      prospects: prospectCount,
      qualifying: qualifyingCount,
      newThisWeek: newProspects.length,
      addressableGBP,
      deltaAddressableGBP,
      signalsThisWeek,
    },
    newProspects,
    changes: changes.slice(0, 40),
    byRegion,
    topSignals: topSignalRows.map((s) => ({
      id: s.id,
      type: s.type,
      title: s.title,
      summary: s.summary,
      occurredOn: s.occurredOn.toISOString(),
      magnitudeGBP: s.magnitudeGBP === null ? null : Number(s.magnitudeGBP),
      prospectName: s.prospect?.fullName ?? null,
      companyName: s.company?.name ?? null,
      sourceUrl: s.source?.url ?? null,
    })),
    dataQuality: { lowConfidenceCount, unverifiedIdentityCount, staleAccountsCount },
  };

  return { payload, markdown: renderMarkdown(payload) };
}

function renderMarkdown(p: WeeklyReportPayload): string {
  const lines: string[] = [];
  const start = formatDate(p.weekStart);
  const end = formatDate(p.weekEnd);

  lines.push(`# Weekly Lead Intelligence — ${start} to ${end}`);
  lines.push("");
  lines.push(
    `**${p.totals.newThisWeek}** new prospects · **${p.totals.qualifying}** qualifying leads in the book · ` +
      `**${formatGBP(p.totals.addressableGBP)}** estimated addressable assets` +
      (p.totals.deltaAddressableGBP
        ? ` (${p.totals.deltaAddressableGBP >= 0 ? "+" : ""}${formatGBP(p.totals.deltaAddressableGBP)} on last week)`
        : "") +
      ` · **${p.totals.signalsThisWeek}** signals detected.`,
  );
  lines.push("");
  lines.push(
    "> All wealth figures in this report are **modelled estimates** derived from public sources. They are not verified statements of any individual's wealth and must not be presented to a client as fact.",
  );
  lines.push("");

  lines.push("## New prospects");
  lines.push("");
  if (!p.newProspects.length) {
    lines.push("_No new prospects met the qualifying criteria this week._");
  } else {
    for (const n of p.newProspects) {
      lines.push(`### ${n.fullName}${n.jobTitle ? `, ${n.jobTitle}` : ""}`);
      lines.push("");
      lines.push(
        `- **Company:** ${n.companyName ?? "—"}${n.companySummary ? ` (${n.companySummary})` : ""}`,
      );
      lines.push(`- **Region:** ${n.regionLabel}`);
      lines.push(
        `- **Estimated investable assets:** ${formatGBP(n.estInvestableMidGBP)} — band ${n.wealthBandLabel} (gross estimated wealth ${formatGBP(n.estGrossMidGBP)})`,
      );
      lines.push(`- **Confidence:** ${n.confidence}/100 across ${n.sourceCount} cited public source(s)`);
      if (n.rationale) {
        lines.push(`- **Why they qualify:** ${n.rationale}`);
      }
      lines.push("");
    }
  }

  lines.push("## Changes to existing prospects");
  lines.push("");
  if (!p.changes.length) {
    lines.push("_No material changes detected this week._");
  } else {
    for (const c of p.changes) {
      const money = c.magnitudeGBP ? ` — ${formatGBP(Math.abs(c.magnitudeGBP))}` : "";
      lines.push(
        `- **${c.fullName}** (${c.regionLabel}${c.companyName ? `, ${c.companyName}` : ""}): ${c.headline}${money}` +
          (c.sourceUrl ? ` [[source]](${c.sourceUrl})` : ""),
      );
      if (c.detail && c.detail !== c.headline) lines.push(`  - ${c.detail}`);
    }
  }
  lines.push("");

  lines.push("## Pipeline by county");
  lines.push("");
  lines.push("| County | Qualifying prospects | Estimated addressable assets |");
  lines.push("| --- | ---: | ---: |");
  for (const r of p.byRegion) {
    lines.push(`| ${r.label} | ${r.count} | ${formatGBP(r.addressableGBP)} |`);
  }
  lines.push("");

  lines.push("## Data quality watchlist");
  lines.push("");
  lines.push(
    `- ${p.dataQuality.unverifiedIdentityCount} prospect(s) are not yet matched to a Companies House officer record.`,
  );
  lines.push(`- ${p.dataQuality.lowConfidenceCount} prospect(s) sit below 45/100 confidence.`);
  lines.push(
    `- ${p.dataQuality.staleAccountsCount} linked compan(ies) have no accounts filed in the last two years.`,
  );
  lines.push("");

  return lines.join("\n");
}

/** Generate and persist the report for the week containing `reference`. */
export async function generateAndStoreWeeklyReport(reference: Date = new Date()) {
  const { payload, markdown } = await buildWeeklyReport(reference);
  const weekStart = new Date(payload.weekStart);

  return prisma.weeklyReport.upsert({
    where: { weekStart },
    create: {
      weekStart,
      weekEnd: new Date(payload.weekEnd),
      newProspectCount: payload.totals.newThisWeek,
      updatedProspectCount: new Set(payload.changes.map((c) => c.prospectId)).size,
      newSignalCount: payload.totals.signalsThisWeek,
      totalAddressableGBP: toBigInt(payload.totals.addressableGBP),
      deltaAddressableGBP: toBigInt(payload.totals.deltaAddressableGBP),
      summaryMd: markdown,
      payload: payload as unknown as object,
    },
    update: {
      generatedAt: new Date(),
      newProspectCount: payload.totals.newThisWeek,
      updatedProspectCount: new Set(payload.changes.map((c) => c.prospectId)).size,
      newSignalCount: payload.totals.signalsThisWeek,
      totalAddressableGBP: toBigInt(payload.totals.addressableGBP),
      deltaAddressableGBP: toBigInt(payload.totals.deltaAddressableGBP),
      summaryMd: markdown,
      payload: payload as unknown as object,
    },
  });
}
