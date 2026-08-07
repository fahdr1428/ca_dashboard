import Link from "next/link";
import { ExternalLink, Info } from "lucide-react";
import { Card, CardHeader, Badge, Estimated, Meter } from "./ui";
import { EstimateCompositionBar } from "./charts";
import { formatGBP, formatPct } from "@/lib/wealth";
import { EVIDENCE_LABELS, EVIDENCE_DESCRIPTIONS } from "@/lib/signal-labels";
import type { WealthEstimate } from "@/lib/scoring/estimate";
import type { ConfidenceResult } from "@/lib/scoring/confidence";

const COMPONENT_COLOR: Record<string, string> = {
  PRIVATE_EQUITY_STAKE: "var(--color-band-violet)",
  REALISED_EXIT: "var(--color-accent)",
  DIVIDEND_ACCUMULATION: "var(--color-band-amber)",
  REMUNERATION: "var(--color-band-sky)",
  PUBLIC_HOLDINGS: "var(--color-band-teal)",
  REPORTED_OR_INHERITED: "var(--color-band-slate)",
};

/**
 * The "show your working" panel. This is the reason an advisor can defend a
 * number in front of a client: every component states its arithmetic, its
 * evidence grade, and the sources that back it.
 */
export function EstimatePanel({
  estimate,
  sourcesById,
}: {
  estimate: WealthEstimate;
  sourcesById: Map<string, { url: string; title: string; publisher: string | null }>;
}) {
  const composition = estimate.components.map((c) => ({
    label: `${c.label}${c.subject ? ` — ${c.subject}` : ""}`,
    midGBP: c.midGBP,
    color: COMPONENT_COLOR[c.key] ?? "var(--color-band-slate)",
  }));

  return (
    <Card>
      <CardHeader
        title="How this estimate was built"
        subtitle={`Model v${estimate.modelVersion}. Every figure below is derived, not observed — the arithmetic is shown so you can challenge it.`}
      />

      <div className="px-5 pb-4 space-y-4">
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="rounded-lg border border-line bg-canvas p-3">
            <div className="text-[11px] uppercase tracking-wide text-ink-3">
              Gross estimated wealth
            </div>
            <div className="text-xl font-semibold tabular mt-0.5">
              <Estimated>{formatGBP(estimate.grossMidGBP)}</Estimated>
            </div>
            <div className="text-[11px] text-ink-3 tabular">
              range {formatGBP(estimate.grossLowGBP)} – {formatGBP(estimate.grossHighGBP)}
            </div>
          </div>
          <div className="rounded-lg border border-accent/40 bg-accent-soft/40 p-3">
            <div className="text-[11px] uppercase tracking-wide text-ink-3">
              Estimated investable assets
            </div>
            <div className="text-xl font-semibold tabular mt-0.5 text-accent">
              <Estimated>{formatGBP(estimate.investableMidGBP)}</Estimated>
            </div>
            <div className="text-[11px] text-ink-3 tabular">
              range {formatGBP(estimate.investableLowGBP)} – {formatGBP(estimate.investableHighGBP)}
            </div>
          </div>
        </div>

        <div>
          <EstimateCompositionBar components={composition} />
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
            {composition.map((c, i) => (
              <span key={i} className="flex items-center gap-1.5 text-[11px] text-ink-3">
                <span className="size-2 rounded-sm" style={{ background: c.color }} />
                {c.label}
              </span>
            ))}
          </div>
        </div>

        <div className="space-y-2.5">
          {estimate.components.map((c, i) => (
            <div key={i} className="rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="size-2 rounded-sm shrink-0"
                    style={{ background: COMPONENT_COLOR[c.key] }}
                  />
                  <span className="text-[13px] font-medium">{c.label}</span>
                  {c.subject && <span className="text-[12px] text-ink-3 truncate">{c.subject}</span>}
                </div>
                <div className="text-right">
                  <div className="text-[13px] font-semibold tabular">
                    {formatGBP(c.midGBP)}
                  </div>
                  <div className="text-[10px] text-ink-3 tabular">
                    {formatGBP(c.lowGBP)} – {formatGBP(c.highGBP)}
                  </div>
                </div>
              </div>

              <p className="mt-1.5 text-[12px] text-ink-2 leading-relaxed">{c.method}</p>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge tone="outline" title={EVIDENCE_DESCRIPTIONS[c.evidence]}>
                  {EVIDENCE_LABELS[c.evidence]}
                </Badge>
                <Badge
                  tone="neutral"
                  title="Share of this component treated as investable today"
                >
                  {formatPct(c.liquidityFactor * 100)} liquid → {formatGBP(c.investableMidGBP)}
                </Badge>
                {c.sourceIds.map((id) => {
                  const s = sourcesById.get(id);
                  if (!s) return null;
                  return (
                    <a
                      key={id}
                      href={s.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
                    >
                      {s.publisher ?? "Source"}
                      <ExternalLink className="size-2.5" />
                    </a>
                  );
                })}
              </div>
            </div>
          ))}
          {estimate.components.length === 0 && (
            <p className="text-[12px] text-ink-3">
              No estimate components could be derived from the evidence on file.
            </p>
          )}
        </div>

        {estimate.caveats.length > 0 && (
          <div className="rounded-lg border border-line bg-canvas p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3 mb-1.5">
              <Info className="size-3.5" /> Caveats
            </div>
            <ul className="space-y-1">
              {estimate.caveats.map((c, i) => (
                <li key={i} className="text-[12px] text-ink-2 leading-relaxed flex gap-2">
                  <span className="text-ink-3 shrink-0">•</span>
                  {c}
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-[11px] text-ink-3 leading-relaxed">
          Assumptions used by this model are listed on the{" "}
          <Link href="/methodology" className="text-accent hover:underline">
            methodology page
          </Link>
          . Change them there and re-run the estimate to see the effect.
        </p>
      </div>
    </Card>
  );
}

export function ConfidencePanel({ confidence }: { confidence: ConfidenceResult }) {
  return (
    <Card>
      <CardHeader
        title="Confidence"
        subtitle="How much this record should be trusted — a separate question from how wealthy the person is."
        action={
          <div className="text-right">
            <div className="text-2xl font-semibold tabular leading-none">{confidence.score}</div>
            <div className="text-[10px] uppercase tracking-wide text-ink-3">
              {confidence.band.toLowerCase()}
            </div>
          </div>
        }
      />
      <div className="px-5 pb-4 space-y-3">
        {confidence.dimensions.map((d) => (
          <div key={d.key}>
            <div className="flex items-baseline justify-between gap-3 mb-1">
              <span className="text-[12px] font-medium">{d.label}</span>
              <span className="text-[11px] text-ink-3 tabular">
                {Math.round(d.score)}/100 · weight {Math.round(d.weight * 100)}%
              </span>
            </div>
            <Meter value={d.score} label={d.label} tone={d.score < 50 ? "signal" : "accent"} />
            <p className="mt-1 text-[11px] text-ink-3 leading-relaxed">{d.explanation}</p>
          </div>
        ))}

        <div className="rounded-lg border border-accent/40 bg-accent-soft/40 p-2.5">
          <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-0.5">
            Best next action
          </div>
          <p className="text-[12px] text-ink leading-relaxed">{confidence.nextBestAction}</p>
        </div>
      </div>
    </Card>
  );
}
