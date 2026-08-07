import Link from "next/link";
import { ArrowUpRight, TrendingUp, Coins, Radar } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { Card, CardHeader, Stat, Badge, WealthBandBadge, ConfidenceBadge, Estimated, EmptyState, Meter } from "@/components/ui";
import { MapPanel } from "@/components/map-panel";
import {
  PipelineTrendChart,
  BandDistributionChart,
  IndustryChart,
  RevenueSparkline,
  ConfidenceTrendChart,
} from "@/components/charts";
import {
  getDashboardStats,
  getRegionStats,
  getBandDistribution,
  getIndustryDistribution,
  getPipelineTrend,
  getFastestGrowingCompanies,
  getTopDividendRecipients,
  listProspects,
  listSignals,
} from "@/lib/queries";
import { formatGBP, formatPct } from "@/lib/wealth";
import { formatRelative } from "@/lib/utils";
import { SIGNAL_LABELS } from "@/lib/signal-labels";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [
    stats,
    regionStats,
    bands,
    industries,
    trend,
    growing,
    dividendRecipients,
    topProspects,
    newProspects,
    recentSignals,
  ] = await Promise.all([
    getDashboardStats(),
    getRegionStats(),
    getBandDistribution(),
    getIndustryDistribution(),
    getPipelineTrend(14),
    getFastestGrowingCompanies(5),
    getTopDividendRecipients(5),
    listProspects({ cohort: "qualifying", sort: "wealth", limit: 8 }),
    listProspects({ sort: "newest", limit: 5 }),
    listSignals({ limit: 8 }),
  ]);

  const mapMarkers = (await listProspects({ limit: 400 })).rows
    .filter((p) => p.latitude != null && p.longitude != null)
    .map((p) => ({
      slug: p.slug,
      fullName: p.fullName,
      companyName: p.companyName,
      regionLabel: p.regionLabel,
      latitude: p.latitude!,
      longitude: p.longitude!,
      estInvestableMidGBP: p.estInvestableMidGBP,
      wealthBand: p.wealthBand,
      confidence: p.confidence,
    }));

  return (
    <>
      <PageHeader
        title="Overview"
        description="Prospects identified from public sources across the 13 target counties. Every wealth figure is a modelled estimate with a visible derivation."
        actions={
          <Link
            href="/reports"
            className="rounded-lg border border-line px-3 py-1.5 text-[13px] font-medium text-ink-2 hover:bg-surface-2"
          >
            This week&apos;s report
          </Link>
        }
      />

      <div className="px-5 pb-8 space-y-4">
        {/* KPIs */}
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
          <Stat
            label="Total prospects"
            value={stats.totalProspects}
            hint={`${stats.qualifyingCount} qualifying`}
          />
          <Stat
            label="New this week"
            value={stats.newThisWeek}
            hint={stats.newThisWeek ? "since Monday" : "none yet"}
          />
          <Stat
            label="Addressable assets"
            value={<Estimated>{formatGBP(stats.addressableGBP)}</Estimated>}
            tone="accent"
            delta={
              stats.addressableDeltaGBP
                ? {
                    value: formatGBP(Math.abs(stats.addressableDeltaGBP)),
                    positive: stats.addressableDeltaGBP > 0,
                  }
                : null
            }
            hint="qualifying leads only"
          />
          <Stat
            label="High confidence"
            value={stats.highConfidenceCount}
            hint={`median ${stats.medianConfidence}/100`}
          />
          <Stat
            label="Pre-liquidity founders"
            value={stats.preLiquidityCount}
            hint="£15m+ paper wealth"
          />
          <Stat
            label="Signals this week"
            value={stats.signalsThisWeek}
            hint={
              stats.largestDividendGBP
                ? `largest dividend ${formatGBP(stats.largestDividendGBP)}`
                : undefined
            }
          />
        </div>

        {/* Map + trend */}
        <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
          <MapPanel regionStats={regionStats} markers={mapMarkers} />

          <div className="space-y-4 min-w-0">
            <Card>
              <CardHeader
                title="Pipeline trend"
                subtitle="Weekly snapshot of estimated wealth across the whole tracked book."
              />
              <div className="px-2 pb-3">
                <PipelineTrendChart data={trend} />
              </div>
              <div className="px-5 pb-4 flex items-center gap-4 text-[11px] text-ink-3">
                <span className="flex items-center gap-1.5">
                  <span className="h-0.5 w-4 bg-[var(--color-accent)]" /> Investable
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-0.5 w-4 border-t border-dashed border-[var(--color-band-violet)]" />{" "}
                  Gross (incl. unrealised equity)
                </span>
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Wealth band distribution"
                subtitle="Prospects by estimated investable assets."
              />
              <div className="px-2 pb-3">
                <BandDistributionChart data={bands} />
              </div>
            </Card>
          </div>
        </div>

        {/* Highest value prospects */}
        <Card>
          <CardHeader
            title="Highest-value qualifying prospects"
            subtitle="Ranked by estimated investable assets — the figure a discretionary mandate would be written against."
            action={
              <Link href="/prospects" className="text-[12px] font-medium text-accent hover:underline">
                Full tracker →
              </Link>
            }
          />
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-y border-line text-left text-[11px] uppercase tracking-wide text-ink-3">
                  <th className="px-5 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Company</th>
                  <th className="px-3 py-2 font-medium">County</th>
                  <th className="px-3 py-2 font-medium text-right">Est. investable</th>
                  <th className="px-3 py-2 font-medium text-right">Range</th>
                  <th className="px-3 py-2 font-medium">Band</th>
                  <th className="px-3 py-2 font-medium text-right">Conf.</th>
                  <th className="px-5 py-2 font-medium text-right">Sources</th>
                </tr>
              </thead>
              <tbody>
                {topProspects.rows.map((p) => (
                  <tr key={p.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                    <td className="px-5 py-2.5">
                      <Link href={`/prospects/${p.slug}`} className="font-medium hover:text-accent">
                        {p.fullName}
                      </Link>
                      <div className="text-[11px] text-ink-3">{p.jobTitle ?? p.occupation ?? "—"}</div>
                    </td>
                    <td className="px-3 py-2.5 text-ink-2">
                      {p.companySlug ? (
                        <Link href={`/companies/${p.companySlug}`} className="hover:text-accent">
                          {p.companyName}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-ink-2">{p.regionLabel}</td>
                    <td className="px-3 py-2.5 text-right font-medium">
                      <Estimated>{formatGBP(p.estInvestableMidGBP)}</Estimated>
                    </td>
                    <td className="px-3 py-2.5 text-right text-[11px] text-ink-3 tabular">
                      {formatGBP(p.estInvestableLowGBP)}–{formatGBP(p.estInvestableHighGBP)}
                    </td>
                    <td className="px-3 py-2.5">
                      <WealthBandBadge band={p.wealthBand} />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <ConfidenceBadge score={p.confidence} band={p.confidenceBand} />
                    </td>
                    <td className="px-5 py-2.5 text-right text-[11px] text-ink-3 tabular">
                      {p.sourceCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Three-up: growth, dividends, signals */}
        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-1.5">
                  <TrendingUp className="size-3.5 text-accent" /> Fastest-growing companies
                </span>
              }
              subtitle="Revenue CAGR from filed accounts."
            />
            <div className="px-5 pb-4 space-y-3">
              {growing.length === 0 && <EmptyState title="No multi-year accounts on file yet." />}
              {growing.map((c) => (
                <div key={c.id} className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/companies/${c.slug}`}
                      className="text-[13px] font-medium hover:text-accent block truncate"
                    >
                      {c.name}
                    </Link>
                    <div className="text-[11px] text-ink-3 truncate">
                      {c.industry ?? "Unclassified"} ·{" "}
                      <Estimated>{formatGBP(c.valuationMidGBP)}</Estimated>
                    </div>
                  </div>
                  <div className="w-16 shrink-0">
                    <RevenueSparkline series={c.series} />
                  </div>
                  <div className="w-14 text-right shrink-0">
                    <div className="text-[13px] font-semibold text-positive tabular">
                      {formatPct(c.cagrPct)}
                    </div>
                    <div className="text-[10px] text-ink-3">CAGR</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-1.5">
                  <Coins className="size-3.5 text-signal" /> Largest dividend recipients
                </span>
              }
              subtitle="Attributed by ownership share across filed accounts."
            />
            <div className="px-5 pb-4 space-y-3">
              {dividendRecipients.length === 0 && (
                <EmptyState title="No attributed dividends recorded." />
              )}
              {dividendRecipients.map((d) => (
                <div key={d.slug} className="flex items-baseline gap-3">
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/prospects/${d.slug}`}
                      className="text-[13px] font-medium hover:text-accent block truncate"
                    >
                      {d.fullName}
                    </Link>
                    <div className="text-[11px] text-ink-3 truncate">
                      {d.companyName ?? d.regionLabel}
                    </div>
                  </div>
                  <div className="text-[13px] font-semibold tabular shrink-0">
                    <Estimated>{formatGBP(d.totalAttributedGBP)}</Estimated>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-1.5">
                  <Radar className="size-3.5 text-accent" /> Latest wealth signals
                </span>
              }
              action={
                <Link href="/signals" className="text-[12px] font-medium text-accent hover:underline">
                  All →
                </Link>
              }
            />
            <div className="px-5 pb-4 space-y-2.5">
              {recentSignals.map((s) => (
                <div key={s.id} className="flex gap-2.5">
                  <span className="mt-1.5 size-1.5 rounded-full bg-accent shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[12px] leading-snug">
                      {s.prospect ? (
                        <Link
                          href={`/prospects/${s.prospect.slug}`}
                          className="font-medium hover:text-accent"
                        >
                          {s.title}
                        </Link>
                      ) : (
                        <span className="font-medium">{s.title}</span>
                      )}
                    </div>
                    <div className="text-[10px] text-ink-3 flex items-center gap-1.5 flex-wrap mt-0.5">
                      <Badge tone="outline">{SIGNAL_LABELS[s.type]}</Badge>
                      <span>{formatRelative(s.occurredOn)}</span>
                      {s.source && (
                        <a
                          href={s.source.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-center gap-0.5 hover:text-accent"
                        >
                          {s.source.publisher ?? "source"}
                          <ArrowUpRight className="size-2.5" />
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Industry + confidence + newest */}
        <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <Card>
            <CardHeader
              title="Estimated addressable assets by industry"
              subtitle="Where the money in the pipeline actually sits."
            />
            <div className="px-2 pb-3">
              <IndustryChart data={industries} />
            </div>
          </Card>

          <div className="space-y-4">
            <Card>
              <CardHeader
                title="Confidence tracker"
                subtitle="Mean record confidence across the book. Rising means better evidence, not more prospects."
              />
              <div className="px-2 pb-3">
                <ConfidenceTrendChart data={trend} />
              </div>
            </Card>

            <Card>
              <CardHeader title="Newest opportunities" />
              <div className="px-5 pb-4 space-y-2.5">
                {newProspects.rows.map((p) => (
                  <div key={p.id} className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/prospects/${p.slug}`}
                        className="text-[13px] font-medium hover:text-accent block truncate"
                      >
                        {p.fullName}
                      </Link>
                      <div className="text-[11px] text-ink-3 truncate">
                        {p.regionLabel} · added {formatRelative(p.dateAdded)}
                      </div>
                    </div>
                    <WealthBandBadge band={p.wealthBand} />
                    <div className="w-10 shrink-0">
                      <Meter value={p.confidence} label={`Confidence ${p.confidence}`} />
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}
