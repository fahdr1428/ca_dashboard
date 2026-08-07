import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { Card, CardHeader, Badge, Estimated, EmptyState, Meter } from "@/components/ui";
import { listSignals } from "@/lib/queries";
import { SIGNAL_LABELS, SIGNAL_GROUPS } from "@/lib/signal-labels";
import { REGION_META } from "@/lib/regions";
import { formatGBP } from "@/lib/wealth";
import { formatDate, formatRelative, cn } from "@/lib/utils";
import type { SignalType } from "@/generated/prisma/enums";

export const dynamic = "force-dynamic";

const ALL_TYPES = Object.keys(SIGNAL_LABELS) as SignalType[];

export default async function SignalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const raw = sp.type ? (Array.isArray(sp.type) ? sp.type : [sp.type]) : [];
  const types = raw.filter((t): t is SignalType => ALL_TYPES.includes(t as SignalType));

  const signals = await listSignals({ types, limit: 200 });

  return (
    <>
      <PageHeader
        title="Wealth signals"
        description="Events detected from public sources that indicate a change in someone's financial position. Filed-accounts signals are strong evidence; press signals are leads to verify."
      />

      <div className="px-5 pb-8 space-y-4">
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {SIGNAL_GROUPS.map((group) => (
            <div key={group.label} className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] uppercase tracking-wide text-ink-3">
                {group.label}
              </span>
              {group.types.map((t) => {
                const active = types.includes(t);
                const next = active ? types.filter((x) => x !== t) : [...types, t];
                const qs = next.map((x) => `type=${x}`).join("&");
                return (
                  <Link
                    key={t}
                    href={qs ? `/signals?${qs}` : "/signals"}
                    className={cn(
                      "rounded-md border px-2 py-0.5 text-[11px] font-medium",
                      active
                        ? "border-accent bg-accent-soft text-accent-ink"
                        : "border-line text-ink-2 hover:bg-surface-2",
                    )}
                  >
                    {SIGNAL_LABELS[t]}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>

        {types.length > 0 && (
          <Link href="/signals" className="inline-block text-[12px] text-accent hover:underline">
            Clear filters
          </Link>
        )}

        <Card>
          <CardHeader
            title={`${signals.length} signal${signals.length === 1 ? "" : "s"}`}
            subtitle="Ordered by when the underlying event happened, not when we found it."
          />
          <div className="divide-y divide-line">
            {signals.map((s) => (
              <div key={s.id} className="px-5 py-3 hover:bg-surface-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium">{s.title}</div>
                    {s.summary && (
                      <p className="mt-0.5 text-[12px] text-ink-2 leading-relaxed max-w-3xl">
                        {s.summary}
                      </p>
                    )}
                  </div>
                  {s.magnitudeGBP !== null && (
                    <div className="text-[15px] font-semibold tabular text-accent shrink-0">
                      {formatGBP(s.magnitudeGBP)}
                    </div>
                  )}
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
                  <Badge tone="outline">{SIGNAL_LABELS[s.type]}</Badge>
                  {s.prospect && (
                    <Link
                      href={`/prospects/${s.prospect.slug}`}
                      className="font-medium text-ink-2 hover:text-accent"
                    >
                      {s.prospect.fullName}
                    </Link>
                  )}
                  {s.prospect && <span>· {REGION_META[s.prospect.region].label}</span>}
                  {s.company && (
                    <Link href={`/companies/${s.company.slug}`} className="hover:text-accent">
                      {s.company.name}
                    </Link>
                  )}
                  <span>· occurred {formatDate(s.occurredOn)}</span>
                  <span>· detected {formatRelative(s.detectedAt)}</span>
                  <span className="flex items-center gap-1.5">
                    · confidence
                    <Meter value={s.confidence} className="w-10" />
                    <span className="tabular">{s.confidence}</span>
                  </span>
                  {s.source && (
                    <a
                      href={s.source.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-0.5 text-accent hover:underline"
                    >
                      {s.source.publisher ?? "source"}
                      <ExternalLink className="size-2.5" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
          {signals.length === 0 && (
            <EmptyState
              title="No signals match these filters"
              description="Clear the filters, or run an ingest from the Automation page to pull fresh material."
            />
          )}
        </Card>
      </div>
    </>
  );
}
