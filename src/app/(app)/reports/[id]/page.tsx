import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, Download, TrendingUp, TrendingDown, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { Card, CardHeader, Badge, Estimated, EmptyState, WealthBandBadge } from "@/components/ui";
import { prisma } from "@/lib/db";
import { formatGBP } from "@/lib/wealth";
import { formatDate } from "@/lib/utils";
import type { WeeklyReportPayload, ReportChange } from "@/lib/report/weekly";

export const dynamic = "force-dynamic";

const CHANGE_TONE: Record<ReportChange["kind"], "accent" | "signal" | "danger" | "neutral"> = {
  WEALTH_INCREASE: "accent",
  WEALTH_DECREASE: "danger",
  BAND_CHANGE: "accent",
  NEW_FUNDING: "signal",
  NEW_DIVIDEND: "signal",
  ACQUISITION: "signal",
  EXIT: "accent",
  DIRECTOR_CHANGE: "neutral",
  COMPANY_GROWTH: "neutral",
  OTHER: "neutral",
};

const CHANGE_LABEL: Record<ReportChange["kind"], string> = {
  WEALTH_INCREASE: "Wealth increase",
  WEALTH_DECREASE: "Wealth decrease",
  BAND_CHANGE: "Band change",
  NEW_FUNDING: "New funding",
  NEW_DIVIDEND: "New dividend",
  ACQUISITION: "Acquisition",
  EXIT: "Business exit",
  DIRECTOR_CHANGE: "Director change",
  COMPANY_GROWTH: "Company growth",
  OTHER: "Other",
};

export default async function ReportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = await prisma.weeklyReport.findUnique({ where: { id } });
  if (!report) notFound();

  const payload = report.payload as unknown as WeeklyReportPayload;

  return (
    <>
      <PageHeader
        title={`Week of ${formatDate(report.weekStart)}`}
        description={`Covering ${formatDate(payload.weekStart)} to ${formatDate(payload.weekEnd)}. Generated ${formatDate(report.generatedAt)}.`}
        actions={
          <>
            <a
              href={`/api/reports/weekly?id=${report.id}&format=md`}
              className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-medium text-ink-2 hover:bg-surface-2"
            >
              <Download className="size-3.5" /> Markdown
            </a>
            <Link
              href="/reports"
              className="rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-medium text-ink-2 hover:bg-surface-2"
            >
              All reports
            </Link>
          </>
        }
      />

      <div className="px-5 pb-8 space-y-4 max-w-6xl">
        <div className="rounded-xl border border-line bg-surface-2 px-4 py-3">
          <p className="text-[12px] text-ink-2 leading-relaxed">
            All wealth figures in this report are <strong>modelled estimates</strong> derived from
            public sources. They are not verified statements of any individual&apos;s wealth and must
            not be presented to a client as fact.
          </p>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <Summary label="New prospects" value={String(payload.totals.newThisWeek)} />
          <Summary label="Qualifying leads" value={String(payload.totals.qualifying)} />
          <Summary
            label="Addressable assets"
            value={formatGBP(payload.totals.addressableGBP)}
            delta={payload.totals.deltaAddressableGBP}
          />
          <Summary label="Signals detected" value={String(payload.totals.signalsThisWeek)} />
          <Summary label="Total tracked" value={String(payload.totals.prospects)} />
        </div>

        {/* New prospects */}
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-1.5">
                <Sparkles className="size-3.5 text-accent" /> New prospects
              </span>
            }
            subtitle="Individuals who first met the criteria this week, and why."
          />
          <div className="px-5 pb-4 space-y-3">
            {payload.newProspects.length === 0 && (
              <p className="text-[13px] text-ink-3">
                No new prospects met the qualifying criteria this week.
              </p>
            )}
            {payload.newProspects.map((p) => (
              <div key={p.id} className="rounded-lg border border-line p-3.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <Link
                      href={`/prospects/${p.slug}`}
                      className="text-[14px] font-semibold hover:text-accent"
                    >
                      {p.fullName}
                    </Link>
                    {p.jobTitle && <span className="text-[13px] text-ink-3">, {p.jobTitle}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <WealthBandBadge band={p.wealthBand} />
                    <Badge tone="outline">confidence {p.confidence}</Badge>
                    <Badge tone="outline">{p.sourceCount} sources</Badge>
                  </div>
                </div>

                <div className="mt-2 grid gap-3 sm:grid-cols-3">
                  <Field label="Company">{p.companyName ?? "—"}</Field>
                  <Field label="County">{p.regionLabel}</Field>
                  <Field label="Estimated investable">
                    <Estimated>{formatGBP(p.estInvestableMidGBP)}</Estimated>
                    <span className="text-ink-3">
                      {" "}
                      / gross {formatGBP(p.estGrossMidGBP)}
                    </span>
                  </Field>
                </div>

                {p.companySummary && (
                  <p className="mt-2 text-[12px] text-ink-3">{p.companySummary}</p>
                )}
                {p.rationale && (
                  <p className="mt-2 text-[12px] text-ink-2 leading-relaxed border-t border-line pt-2">
                    {p.rationale}
                  </p>
                )}
              </div>
            ))}
          </div>
        </Card>

        {/* Changes */}
        <Card>
          <CardHeader
            title="Changes to existing prospects"
            subtitle="Wealth revisions, funding, dividends, acquisitions, exits and register activity."
          />
          <div className="divide-y divide-line">
            {payload.changes.length === 0 && (
              <EmptyState title="No material changes detected this week." />
            )}
            {payload.changes.map((c, i) => (
              <div key={i} className="px-5 py-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <Badge tone={CHANGE_TONE[c.kind]}>{CHANGE_LABEL[c.kind]}</Badge>
                <Link
                  href={`/prospects/${c.slug}`}
                  className="text-[13px] font-medium hover:text-accent"
                >
                  {c.fullName}
                </Link>
                <span className="text-[12px] text-ink-2 flex-1 min-w-48">{c.headline}</span>
                {c.magnitudeGBP !== null && c.magnitudeGBP !== 0 && (
                  <span
                    className={
                      c.magnitudeGBP > 0
                        ? "text-[12px] font-semibold tabular text-positive"
                        : "text-[12px] font-semibold tabular text-negative"
                    }
                  >
                    {c.magnitudeGBP > 0 ? "+" : "−"}
                    {formatGBP(Math.abs(c.magnitudeGBP))}
                  </span>
                )}
                <span className="text-[11px] text-ink-3">{c.regionLabel}</span>
                {c.sourceUrl && (
                  <a
                    href={c.sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-[11px] text-accent hover:underline inline-flex items-center gap-0.5"
                  >
                    source <ExternalLink className="size-2.5" />
                  </a>
                )}
              </div>
            ))}
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Pipeline by county" />
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-y border-line text-left text-[11px] uppercase tracking-wide text-ink-3">
                    <th className="px-5 py-2 font-medium">County</th>
                    <th className="px-3 py-2 font-medium text-right">Qualifying</th>
                    <th className="px-5 py-2 font-medium text-right">Addressable assets</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.byRegion.map((r) => (
                    <tr key={r.region} className="border-b border-line last:border-0">
                      <td className="px-5 py-2">{r.label}</td>
                      <td className="px-3 py-2 text-right tabular">{r.count}</td>
                      <td className="px-5 py-2 text-right tabular">
                        <Estimated>{formatGBP(r.addressableGBP)}</Estimated>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Data quality watchlist"
              subtitle="Where the book is weakest. Fixing these raises confidence faster than adding prospects."
            />
            <div className="px-5 pb-4 space-y-2.5">
              <QualityRow
                value={payload.dataQuality.unverifiedIdentityCount}
                label="not matched to a Companies House officer record"
              />
              <QualityRow
                value={payload.dataQuality.lowConfidenceCount}
                label="below 45/100 confidence"
              />
              <QualityRow
                value={payload.dataQuality.staleAccountsCount}
                label="linked companies with no accounts filed in two years"
              />
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function Summary({ label, value, delta }: { label: string; value: string; delta?: number }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-ink-3">{label}</div>
      <div className="text-xl font-semibold tabular mt-0.5">{value}</div>
      {delta !== undefined && delta !== 0 && (
        <div
          className={
            delta > 0
              ? "text-[11px] text-positive tabular flex items-center gap-1"
              : "text-[11px] text-negative tabular flex items-center gap-1"
          }
        >
          {delta > 0 ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
          {formatGBP(Math.abs(delta))}
        </div>
      )}
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-ink-3">{label}</div>
      <div className="text-[12px] text-ink mt-0.5">{children}</div>
    </div>
  );
}

function QualityRow({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex items-baseline gap-2.5">
      <span className="text-lg font-semibold tabular w-8 shrink-0">{value}</span>
      <span className="text-[12px] text-ink-2 leading-relaxed">{label}</span>
    </div>
  );
}
