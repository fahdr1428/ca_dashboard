import { prisma } from "@/lib/db";
import { REGION_META, REGIONS, type RegionKey } from "@/lib/regions";
import { QUALIFYING_WHERE, PRE_LIQUIDITY_WHERE, NOT_SUPPRESSED, cohortFor, type Cohort } from "@/lib/pipeline-filters";
import { WEALTH_BANDS, QUALIFYING_THRESHOLD_GBP } from "@/lib/wealth";
import { startOfIsoWeek } from "@/lib/utils";
import type {
  Prisma,
} from "@/generated/prisma/client";
import type {
  LeadStatus,
  Region,
  WealthBand,
  SignalType,
  RelationshipStage,
} from "@/generated/prisma/enums";

/** Everything the pages read goes through here, so filtering stays consistent. */

export interface ProspectFilters {
  q?: string;
  regions?: RegionKey[];
  bands?: WealthBand[];
  industries?: string[];
  statuses?: LeadStatus[];
  minConfidence?: number;
  cohort?: "all" | "qualifying" | "pre_liquidity";
  sort?: "wealth" | "newest" | "confidence" | "name" | "updated";
  limit?: number;
  offset?: number;
}

export interface ProspectRow {
  id: string;
  slug: string;
  fullName: string;
  jobTitle: string | null;
  occupation: string | null;
  officeLocation: string | null;
  region: Region;
  regionLabel: string;
  companyId: string | null;
  companyName: string | null;
  companySlug: string | null;
  industry: string | null;
  wealthBand: WealthBand;
  estGrossMidGBP: number;
  estInvestableMidGBP: number;
  estInvestableLowGBP: number;
  estInvestableHighGBP: number;
  confidence: number;
  confidenceBand: "LOW" | "MEDIUM" | "HIGH" | "VERIFIED";
  status: LeadStatus;
  relationshipStage: RelationshipStage;
  owner: string | null;
  tags: string[];
  cohort: Cohort;
  dateAdded: string;
  lastUpdated: string;
  latitude: number | null;
  longitude: number | null;
  signalCount: number;
  sourceCount: number;
  rationale: string | null;
}

function buildWhere(f: ProspectFilters): Prisma.ProspectWhereInput {
  const and: Prisma.ProspectWhereInput[] = [NOT_SUPPRESSED];

  if (f.cohort === "qualifying") and.push(QUALIFYING_WHERE);
  else if (f.cohort === "pre_liquidity") and.push(PRE_LIQUIDITY_WHERE);

  if (f.q?.trim()) {
    const q = f.q.trim();
    and.push({
      OR: [
        { fullName: { contains: q, mode: "insensitive" } },
        { jobTitle: { contains: q, mode: "insensitive" } },
        { occupation: { contains: q, mode: "insensitive" } },
        { officeLocation: { contains: q, mode: "insensitive" } },
        { company: { name: { contains: q, mode: "insensitive" } } },
        { company: { companyNumber: { contains: q, mode: "insensitive" } } },
      ],
    });
  }
  if (f.regions?.length) and.push({ region: { in: f.regions as Region[] } });
  if (f.bands?.length) and.push({ wealthBand: { in: f.bands } });
  if (f.industries?.length) and.push({ company: { industry: { in: f.industries } } });
  if (f.statuses?.length) and.push({ status: { in: f.statuses } });
  if (f.minConfidence) and.push({ confidence: { gte: f.minConfidence } });

  return { AND: and };
}

function buildOrder(sort: ProspectFilters["sort"]): Prisma.ProspectOrderByWithRelationInput[] {
  switch (sort) {
    case "newest":
      return [{ dateAdded: "desc" }, { estInvestableMidGBP: "desc" }];
    case "confidence":
      return [{ confidence: "desc" }, { estInvestableMidGBP: "desc" }];
    case "name":
      return [{ fullName: "asc" }];
    case "updated":
      return [{ lastUpdated: "desc" }];
    default:
      return [{ estInvestableMidGBP: "desc" }, { estGrossWealthMidGBP: "desc" }];
  }
}

export async function listProspects(
  filters: ProspectFilters = {},
): Promise<{ rows: ProspectRow[]; total: number }> {
  const where = buildWhere(filters);

  const [rows, total] = await Promise.all([
    prisma.prospect.findMany({
      where,
      orderBy: buildOrder(filters.sort),
      take: filters.limit ?? 200,
      skip: filters.offset ?? 0,
      include: {
        company: { select: { id: true, name: true, slug: true, industry: true } },
        _count: { select: { signals: true } },
      },
    }),
    prisma.prospect.count({ where }),
  ]);

  const citationCounts = await prisma.citation.groupBy({
    by: ["entityId"],
    where: { entityType: "prospect", entityId: { in: rows.map((r) => r.id) } },
    _count: { _all: true },
  });
  const sourceCounts = new Map(citationCounts.map((c) => [c.entityId, c._count._all]));

  return {
    total,
    rows: rows.map((p) => ({
      id: p.id,
      slug: p.slug,
      fullName: p.fullName,
      jobTitle: p.jobTitle,
      occupation: p.occupation,
      officeLocation: p.officeLocation,
      region: p.region,
      regionLabel: REGION_META[p.region].label,
      companyId: p.company?.id ?? null,
      companyName: p.company?.name ?? null,
      companySlug: p.company?.slug ?? null,
      industry: p.company?.industry ?? null,
      wealthBand: p.wealthBand,
      estGrossMidGBP: Number(p.estGrossWealthMidGBP),
      estInvestableMidGBP: Number(p.estInvestableMidGBP),
      estInvestableLowGBP: Number(p.estInvestableLowGBP),
      estInvestableHighGBP: Number(p.estInvestableHighGBP),
      confidence: p.confidence,
      confidenceBand: p.confidenceBand,
      status: p.status,
      relationshipStage: p.relationshipStage,
      owner: p.owner,
      tags: p.tags,
      cohort: cohortFor({
        estInvestableMidGBP: Number(p.estInvestableMidGBP),
        estGrossWealthMidGBP: Number(p.estGrossWealthMidGBP),
      }),
      dateAdded: p.dateAdded.toISOString(),
      lastUpdated: p.lastUpdated.toISOString(),
      latitude: p.latitude,
      longitude: p.longitude,
      signalCount: p._count.signals,
      sourceCount: sourceCounts.get(p.id) ?? 0,
      rationale: p.rationale,
    })),
  };
}

// ---------------------------------------------------------------------------
// Dashboard aggregates
// ---------------------------------------------------------------------------

export interface DashboardStats {
  totalProspects: number;
  qualifyingCount: number;
  preLiquidityCount: number;
  newThisWeek: number;
  addressableGBP: number;
  addressableDeltaGBP: number;
  highConfidenceCount: number;
  signalsThisWeek: number;
  largestDividendGBP: number;
  medianConfidence: number;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const weekStart = startOfIsoWeek();
  const lastWeekStart = new Date(weekStart.getTime() - 7 * 24 * 3600 * 1000);

  const [
    totalProspects,
    qualifyingCount,
    preLiquidityCount,
    newThisWeek,
    addressable,
    highConfidenceCount,
    signalsThisWeek,
    largestDividend,
    confidences,
    lastWeekSnapshot,
  ] = await Promise.all([
    prisma.prospect.count({ where: NOT_SUPPRESSED }),
    prisma.prospect.count({ where: QUALIFYING_WHERE }),
    prisma.prospect.count({ where: PRE_LIQUIDITY_WHERE }),
    prisma.prospect.count({ where: { ...NOT_SUPPRESSED, dateAdded: { gte: weekStart } } }),
    prisma.prospect.aggregate({ where: QUALIFYING_WHERE, _sum: { estInvestableMidGBP: true } }),
    prisma.prospect.count({ where: { ...QUALIFYING_WHERE, confidence: { gte: 68 } } }),
    prisma.signal.count({ where: { detectedAt: { gte: weekStart } } }),
    prisma.signal.findFirst({
      where: { type: "LARGE_DIVIDEND" },
      orderBy: { magnitudeGBP: "desc" },
      select: { magnitudeGBP: true },
    }),
    prisma.prospect.findMany({ where: QUALIFYING_WHERE, select: { confidence: true } }),
    // Like-for-like: last week's snapshot, filtered to the rows that *were*
    // qualifying at the time. Comparing against the whole book would show a
    // swing that has nothing to do with the pipeline moving.
    prisma.wealthSnapshot.aggregate({
      where: {
        takenAt: { gte: lastWeekStart, lt: weekStart },
        estInvestableMidGBP: { gte: BigInt(QUALIFYING_THRESHOLD_GBP) },
      },
      _sum: { estInvestableMidGBP: true },
      _count: { _all: true },
    }),
  ]);

  const addressableGBP = Number(addressable._sum.estInvestableMidGBP ?? 0n);
  const sorted = confidences.map((c) => c.confidence).sort((a, b) => a - b);
  const medianConfidence = sorted.length
    ? sorted[Math.floor(sorted.length / 2)]
    : 0;

  return {
    totalProspects,
    qualifyingCount,
    preLiquidityCount,
    newThisWeek,
    addressableGBP,
    addressableDeltaGBP: lastWeekSnapshot._count._all
      ? addressableGBP - Number(lastWeekSnapshot._sum.estInvestableMidGBP ?? 0n)
      : 0,
    highConfidenceCount,
    signalsThisWeek,
    largestDividendGBP: Number(largestDividend?.magnitudeGBP ?? 0n),
    medianConfidence,
  };
}

export interface RegionStat {
  region: RegionKey;
  label: string;
  count: number;
  qualifying: number;
  addressableGBP: number;
  centroid: { lat: number; lng: number };
}

export async function getRegionStats(): Promise<RegionStat[]> {
  const [all, qualifying] = await Promise.all([
    prisma.prospect.groupBy({
      by: ["region"],
      where: NOT_SUPPRESSED,
      _count: { _all: true },
    }),
    prisma.prospect.groupBy({
      by: ["region"],
      where: QUALIFYING_WHERE,
      _count: { _all: true },
      _sum: { estInvestableMidGBP: true },
    }),
  ]);

  const allByRegion = new Map(all.map((r) => [r.region, r._count._all]));
  const qualByRegion = new Map(
    qualifying.map((r) => [
      r.region,
      { count: r._count._all, sum: Number(r._sum.estInvestableMidGBP ?? 0n) },
    ]),
  );

  return REGIONS.map((region) => ({
    region,
    label: REGION_META[region].label,
    count: allByRegion.get(region) ?? 0,
    qualifying: qualByRegion.get(region)?.count ?? 0,
    addressableGBP: qualByRegion.get(region)?.sum ?? 0,
    centroid: REGION_META[region].centroid,
  }));
}

export async function getBandDistribution() {
  const groups = await prisma.prospect.groupBy({
    by: ["wealthBand"],
    where: NOT_SUPPRESSED,
    _count: { _all: true },
    _sum: { estInvestableMidGBP: true },
  });
  const byBand = new Map(
    groups.map((g) => [
      g.wealthBand,
      { count: g._count._all, sum: Number(g._sum.estInvestableMidGBP ?? 0n) },
    ]),
  );
  return WEALTH_BANDS.map((b) => ({
    band: b.key,
    label: b.label,
    short: b.short,
    tone: b.tone,
    count: byBand.get(b.key)?.count ?? 0,
    addressableGBP: byBand.get(b.key)?.sum ?? 0,
  }));
}

export async function getIndustryDistribution() {
  const rows = await prisma.prospect.findMany({
    where: NOT_SUPPRESSED,
    select: {
      estInvestableMidGBP: true,
      company: { select: { industry: true } },
    },
  });
  const map = new Map<string, { count: number; sum: number }>();
  for (const r of rows) {
    const key = r.company?.industry ?? "Unclassified";
    const entry = map.get(key) ?? { count: 0, sum: 0 };
    entry.count += 1;
    entry.sum += Number(r.estInvestableMidGBP);
    map.set(key, entry);
  }
  return [...map.entries()]
    .map(([industry, v]) => ({ industry, count: v.count, addressableGBP: v.sum }))
    .sort((a, b) => b.addressableGBP - a.addressableGBP);
}

/** Weekly totals across the whole book, for the pipeline trend chart. */
export async function getPipelineTrend(weeks = 14) {
  const since = new Date(Date.now() - weeks * 7 * 24 * 3600 * 1000);
  const snapshots = await prisma.wealthSnapshot.findMany({
    where: { takenAt: { gte: since } },
    select: { takenAt: true, estInvestableMidGBP: true, estGrossMidGBP: true, confidence: true },
    orderBy: { takenAt: "asc" },
  });

  const buckets = new Map<
    string,
    { investable: number; gross: number; count: number; confidence: number }
  >();
  for (const s of snapshots) {
    const key = startOfIsoWeek(s.takenAt).toISOString().slice(0, 10);
    const b = buckets.get(key) ?? { investable: 0, gross: 0, count: 0, confidence: 0 };
    b.investable += Number(s.estInvestableMidGBP);
    b.gross += Number(s.estGrossMidGBP);
    b.confidence += s.confidence;
    b.count += 1;
    buckets.set(key, b);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, b]) => ({
      week,
      investableGBP: Math.round(b.investable),
      grossGBP: Math.round(b.gross),
      prospects: b.count,
      avgConfidence: b.count ? Math.round(b.confidence / b.count) : 0,
    }));
}

export interface SignalRow {
  id: string;
  type: SignalType;
  title: string;
  summary: string | null;
  occurredOn: string;
  detectedAt: string;
  magnitudeGBP: number | null;
  weight: number;
  confidence: number;
  status: string;
  prospect: { slug: string; fullName: string; region: Region } | null;
  company: { slug: string; name: string } | null;
  source: { url: string; title: string; publisher: string | null; sourceType: string } | null;
}

export async function listSignals(opts: {
  types?: SignalType[];
  regions?: RegionKey[];
  since?: Date;
  limit?: number;
} = {}): Promise<SignalRow[]> {
  const rows = await prisma.signal.findMany({
    where: {
      type: opts.types?.length ? { in: opts.types } : undefined,
      detectedAt: opts.since ? { gte: opts.since } : undefined,
      ...(opts.regions?.length
        ? { prospect: { region: { in: opts.regions as Region[] } } }
        : {}),
    },
    orderBy: [{ occurredOn: "desc" }],
    take: opts.limit ?? 100,
    include: {
      prospect: { select: { slug: true, fullName: true, region: true } },
      company: { select: { slug: true, name: true } },
      source: { select: { url: true, title: true, publisher: true, sourceType: true } },
    },
  });

  return rows.map((s) => ({
    id: s.id,
    type: s.type,
    title: s.title,
    summary: s.summary,
    occurredOn: s.occurredOn.toISOString(),
    detectedAt: s.detectedAt.toISOString(),
    magnitudeGBP: s.magnitudeGBP === null ? null : Number(s.magnitudeGBP),
    weight: s.weight,
    confidence: s.confidence,
    status: s.status,
    prospect: s.prospect,
    company: s.company,
    source: s.source,
  }));
}

/** Fastest-growing companies with a tracked owner, for the dashboard panel. */
export async function getFastestGrowingCompanies(limit = 6) {
  const companies = await prisma.company.findMany({
    where: { prospects: { some: NOT_SUPPRESSED } },
    include: {
      financials: { orderBy: { periodEnd: "desc" }, take: 5 },
      prospects: { select: { slug: true, fullName: true }, take: 1 },
    },
  });

  const scored = companies
    .map((c) => {
      const withRevenue = c.financials
        .filter((f) => f.revenueGBP && Number(f.revenueGBP) > 0)
        .sort((a, b) => a.periodEnd.getTime() - b.periodEnd.getTime());
      if (withRevenue.length < 2) return null;
      const first = withRevenue[0];
      const last = withRevenue[withRevenue.length - 1];
      const years =
        (last.periodEnd.getTime() - first.periodEnd.getTime()) / (365.25 * 24 * 3600 * 1000);
      if (years < 0.9) return null;
      const cagr =
        (Math.pow(Number(last.revenueGBP) / Number(first.revenueGBP), 1 / years) - 1) * 100;
      return {
        id: c.id,
        slug: c.slug,
        name: c.name,
        industry: c.industry,
        cagrPct: cagr,
        latestRevenueGBP: Number(last.revenueGBP),
        valuationMidGBP: Number(c.estValuationMidGBP ?? 0n),
        exitPotential: c.exitPotential ?? 0,
        ownerSlug: c.prospects[0]?.slug ?? null,
        ownerName: c.prospects[0]?.fullName ?? null,
        series: withRevenue.map((f) => ({
          period: f.periodLabel ?? f.periodEnd.toISOString().slice(0, 7),
          revenueGBP: Number(f.revenueGBP),
        })),
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => b.cagrPct - a.cagrPct);

  return scored.slice(0, limit);
}

/** Largest attributed dividend recipients. */
export async function getTopDividendRecipients(limit = 6) {
  const grouped = await prisma.dividendPayment.groupBy({
    by: ["prospectId"],
    where: { prospectId: { not: null }, attributedGBP: { not: null } },
    _sum: { attributedGBP: true },
    orderBy: { _sum: { attributedGBP: "desc" } },
    take: limit,
  });

  const ids = grouped.map((g) => g.prospectId!).filter(Boolean);
  if (!ids.length) return [];

  const prospects = await prisma.prospect.findMany({
    where: { id: { in: ids }, ...NOT_SUPPRESSED },
    select: { id: true, slug: true, fullName: true, region: true, company: { select: { name: true } } },
  });
  const byId = new Map(prospects.map((p) => [p.id, p]));

  return grouped
    .map((g) => {
      const p = byId.get(g.prospectId!);
      if (!p) return null;
      return {
        slug: p.slug,
        fullName: p.fullName,
        regionLabel: REGION_META[p.region].label,
        companyName: p.company?.name ?? null,
        totalAttributedGBP: Number(g._sum.attributedGBP ?? 0n),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
}

export async function getIndustryOptions(): Promise<string[]> {
  const rows = await prisma.company.findMany({
    where: { industry: { not: null } },
    select: { industry: true },
    distinct: ["industry"],
    orderBy: { industry: "asc" },
  });
  return rows.map((r) => r.industry!).filter(Boolean);
}
