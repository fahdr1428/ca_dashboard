import { CheckCircle2, XCircle, AlertTriangle, Clock } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { Card, CardHeader, Badge, EmptyState } from "@/components/ui";
import { IngestControls } from "@/components/ingest-controls";
import { prisma } from "@/lib/db";
import { allConnectors } from "@/lib/ingest/pipeline";
import { formatDate, formatRelative } from "@/lib/utils";
import { SOURCE_TYPE_LABELS } from "@/lib/signal-labels";

export const dynamic = "force-dynamic";

export default async function AutomationPage() {
  const connectors = allConnectors().map((c) => ({
    key: c.key,
    label: c.label,
    description: c.description,
    sourceType: c.sourceType,
    available: c.isAvailable(),
    reason: c.isAvailable() ? null : (c.unavailableReason?.() ?? "Unavailable."),
  }));

  const [runs, lastCron, sourceCounts] = await Promise.all([
    prisma.ingestRun.findMany({ orderBy: { startedAt: "desc" }, take: 12 }),
    prisma.systemState.findUnique({ where: { key: "cron.lastWeeklyRun" } }),
    prisma.source.groupBy({ by: ["sourceType"], _count: { _all: true } }),
  ]);

  const cron = lastCron?.value as { at?: string; reportId?: string; errors?: string[] } | undefined;

  const deliveryConfigured = Boolean(
    process.env.REPORT_WEBHOOK_URL || (process.env.RESEND_API_KEY && process.env.REPORT_EMAIL_TO),
  );

  return (
    <>
      <PageHeader
        title="Automation"
        description="Scheduled collection from public sources, and the record of what each run found."
      />

      <div className="px-5 pb-8 space-y-4">
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr] items-start">
          <Card>
            <CardHeader
              title="Connectors"
              subtitle="Each connector reads one class of public source. A connector without credentials is skipped, never faked."
            />
            <div className="px-5 pb-4 space-y-3">
              {connectors.map((c) => (
                <div key={c.key} className="rounded-lg border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium">{c.label}</span>
                      <Badge tone="outline">{SOURCE_TYPE_LABELS[c.sourceType]}</Badge>
                    </div>
                    {c.available ? (
                      <Badge tone="accent">
                        <CheckCircle2 className="size-3" /> Active
                      </Badge>
                    ) : (
                      <Badge tone="signal">
                        <AlertTriangle className="size-3" /> Not configured
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1.5 text-[12px] text-ink-2 leading-relaxed">{c.description}</p>
                  {c.reason && (
                    <p className="mt-1.5 text-[11px] text-signal leading-relaxed">{c.reason}</p>
                  )}
                </div>
              ))}
            </div>
          </Card>

          <div className="space-y-4">
            <IngestControls
              connectors={connectors.map((c) => ({
                key: c.key,
                label: c.label,
                available: c.available,
              }))}
            />

            <Card>
              <CardHeader
                title="Weekly schedule"
                subtitle="The Monday job refreshes every source, re-runs the models, writes a snapshot and generates the report."
              />
              <div className="px-5 pb-4 space-y-2.5 text-[12px]">
                <Row label="Cadence">
                  <span className="flex items-center gap-1.5">
                    <Clock className="size-3.5 text-ink-3" />
                    Mondays, 07:00 UTC
                  </span>
                </Row>
                <Row label="Endpoint">
                  <code className="font-mono text-[11px]">GET /api/cron/weekly</code>
                </Row>
                <Row label="Authentication">Bearer <code className="font-mono text-[11px]">CRON_SECRET</code></Row>
                <Row label="Last run">
                  {cron?.at ? (
                    <span>
                      {formatRelative(cron.at)}
                      {cron.errors?.length ? (
                        <Badge tone="danger" className="ml-1.5">
                          {cron.errors.length} error(s)
                        </Badge>
                      ) : (
                        <Badge tone="accent" className="ml-1.5">
                          clean
                        </Badge>
                      )}
                    </span>
                  ) : (
                    <span className="text-ink-3">never</span>
                  )}
                </Row>
                <Row label="Report delivery">
                  {deliveryConfigured ? (
                    <Badge tone="accent">Configured</Badge>
                  ) : (
                    <span className="text-ink-3">
                      Not configured — reports are stored in the dashboard only. Set{" "}
                      <code className="font-mono text-[11px]">REPORT_WEBHOOK_URL</code> or{" "}
                      <code className="font-mono text-[11px]">RESEND_API_KEY</code>.
                    </span>
                  )}
                </Row>
                {cron?.errors?.length ? (
                  <ul className="pt-1 space-y-1">
                    {cron.errors.map((e, i) => (
                      <li key={i} className="text-[11px] text-danger leading-relaxed">
                        {e}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </Card>

            <Card>
              <CardHeader title="Sources held" />
              <div className="px-5 pb-4 space-y-1.5">
                {sourceCounts
                  .sort((a, b) => b._count._all - a._count._all)
                  .map((s) => (
                    <div key={s.sourceType} className="flex items-baseline justify-between gap-3">
                      <span className="text-[12px] text-ink-2">
                        {SOURCE_TYPE_LABELS[s.sourceType]}
                      </span>
                      <span className="text-[12px] tabular font-medium">{s._count._all}</span>
                    </div>
                  ))}
                {sourceCounts.length === 0 && (
                  <p className="text-[12px] text-ink-3">No sources stored yet.</p>
                )}
              </div>
            </Card>
          </div>
        </div>

        <Card>
          <CardHeader title="Run history" subtitle="Every collection run, what it found and what went wrong." />
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-y border-line text-left text-[11px] uppercase tracking-wide text-ink-3">
                  <th className="px-5 py-2 font-medium">Started</th>
                  <th className="px-3 py-2 font-medium">Trigger</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Connectors</th>
                  <th className="px-3 py-2 font-medium text-right">New</th>
                  <th className="px-3 py-2 font-medium text-right">Updated</th>
                  <th className="px-3 py-2 font-medium text-right">Signals</th>
                  <th className="px-5 py-2 font-medium text-right">Duration</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const stats = (r.stats ?? {}) as Record<string, number>;
                  const duration = r.finishedAt
                    ? `${Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000)}s`
                    : "—";
                  return (
                    <tr key={r.id} className="border-b border-line last:border-0">
                      <td className="px-5 py-2 whitespace-nowrap">
                        {formatDate(r.startedAt)}
                        <div className="text-[11px] text-ink-3">{formatRelative(r.startedAt)}</div>
                      </td>
                      <td className="px-3 py-2 text-ink-2">{r.trigger.replace(/_/g, " ").toLowerCase()}</td>
                      <td className="px-3 py-2">
                        <StatusPill status={r.status} />
                      </td>
                      <td className="px-3 py-2 text-[11px] text-ink-3">
                        {r.connectorsRun.join(", ") || "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular">{stats.prospectsCreated ?? 0}</td>
                      <td className="px-3 py-2 text-right tabular">{stats.prospectsUpdated ?? 0}</td>
                      <td className="px-3 py-2 text-right tabular">{stats.signalsCreated ?? 0}</td>
                      <td className="px-5 py-2 text-right tabular text-ink-3">{duration}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {runs.length === 0 && <EmptyState title="No runs recorded yet." />}
        </Card>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <span className="text-[11px] uppercase tracking-wide text-ink-3">{label}</span>
      <span className="text-ink-2 text-right">{children}</span>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  if (status === "SUCCESS")
    return (
      <Badge tone="accent">
        <CheckCircle2 className="size-3" /> Success
      </Badge>
    );
  if (status === "PARTIAL")
    return (
      <Badge tone="signal">
        <AlertTriangle className="size-3" /> Partial
      </Badge>
    );
  if (status === "FAILED")
    return (
      <Badge tone="danger">
        <XCircle className="size-3" /> Failed
      </Badge>
    );
  return <Badge tone="outline">Running</Badge>;
}
