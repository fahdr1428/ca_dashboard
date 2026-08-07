import * as React from "react";
import { cn } from "@/lib/utils";
import { BAND_META } from "@/lib/wealth";
import type { WealthBand, ConfidenceBand, LeadStatus, RelationshipStage } from "@/generated/prisma/enums";

/** Shared primitives. Deliberately small — the dashboard's character comes from
 * the data density, not from decorative chrome. */

export function Card({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("bg-surface border border-line rounded-xl", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4 px-5 pt-4 pb-3", className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight text-ink">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-ink-3 leading-relaxed">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

const BADGE_TONES = {
  neutral: "bg-surface-2 text-ink-2 border-line",
  accent: "bg-accent-soft text-accent-ink border-transparent",
  signal: "bg-signal-soft text-signal border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
  outline: "bg-transparent text-ink-3 border-line-strong",
} as const;

export function Badge({
  children,
  tone = "neutral",
  className,
  title,
}: {
  children: React.ReactNode;
  tone?: keyof typeof BADGE_TONES;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap",
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const BAND_COLOR_VAR: Record<string, string> = {
  slate: "var(--color-band-slate)",
  sky: "var(--color-band-sky)",
  teal: "var(--color-band-teal)",
  amber: "var(--color-band-amber)",
  violet: "var(--color-band-violet)",
  rose: "var(--color-band-rose)",
};

export function bandColor(band: WealthBand): string {
  return BAND_COLOR_VAR[BAND_META[band].tone];
}

export function WealthBandBadge({ band, className }: { band: WealthBand; className?: string }) {
  const meta = BAND_META[band];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-line px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap tabular",
        className,
      )}
      title={`Estimated investable assets: ${meta.label}`}
    >
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ background: bandColor(band) }}
      />
      {meta.short}
    </span>
  );
}

const CONFIDENCE_TONE: Record<ConfidenceBand, keyof typeof BADGE_TONES> = {
  LOW: "danger",
  MEDIUM: "signal",
  HIGH: "accent",
  VERIFIED: "accent",
};

export function ConfidenceBadge({
  score,
  band,
  className,
}: {
  score: number;
  band: ConfidenceBand;
  className?: string;
}) {
  return (
    <Badge tone={CONFIDENCE_TONE[band]} className={cn("tabular", className)} title={`Confidence ${score}/100 — ${band.toLowerCase()}`}>
      {score}
    </Badge>
  );
}

export const STATUS_LABELS: Record<LeadStatus, string> = {
  NEW: "New",
  RESEARCHING: "Researching",
  QUALIFIED: "Qualified",
  CONTACTED: "Contacted",
  MEETING_BOOKED: "Meeting booked",
  IN_DISCUSSION: "In discussion",
  CLIENT: "Client",
  NURTURE: "Nurture",
  DISQUALIFIED: "Disqualified",
};

export const STAGE_LABELS: Record<RelationshipStage, string> = {
  UNAWARE: "Unaware",
  AWARE: "Aware",
  INTRODUCED: "Introduced",
  ENGAGED: "Engaged",
  PROPOSAL: "Proposal",
  ONBOARDING: "Onboarding",
  CLIENT: "Client",
  LAPSED: "Lapsed",
};

const STATUS_TONE: Record<LeadStatus, keyof typeof BADGE_TONES> = {
  NEW: "outline",
  RESEARCHING: "outline",
  QUALIFIED: "accent",
  CONTACTED: "accent",
  MEETING_BOOKED: "accent",
  IN_DISCUSSION: "accent",
  CLIENT: "accent",
  NURTURE: "neutral",
  DISQUALIFIED: "danger",
};

export function StatusBadge({ status }: { status: LeadStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABELS[status]}</Badge>;
}

/**
 * The estimate marker. Every derived monetary figure in the UI is wrapped in
 * this, so it is impossible for a modelled number to be displayed as if it
 * were a filed fact.
 */
export function Estimated({
  children,
  title,
  className,
}: {
  children: React.ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-flex items-baseline gap-1", className)}
      title={title ?? "Modelled estimate — not a verified figure"}
    >
      <span className="tabular">{children}</span>
      <span
        aria-label="estimate"
        className="text-[9px] font-semibold uppercase tracking-wider text-ink-3 select-none"
      >
        est
      </span>
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
  delta,
  tone = "neutral",
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  delta?: { value: string; positive: boolean } | null;
  tone?: "neutral" | "accent";
}) {
  return (
    <Card className="px-4 py-3.5 flex flex-col gap-1 min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-3 truncate">
        {label}
      </div>
      <div
        className={cn(
          "text-2xl font-semibold tracking-tight tabular leading-tight",
          tone === "accent" ? "text-accent" : "text-ink",
        )}
      >
        {value}
      </div>
      <div className="flex items-center gap-2 min-h-4">
        {delta && (
          <span
            className={cn(
              "text-[11px] font-medium tabular",
              delta.positive ? "text-positive" : "text-negative",
            )}
          >
            {delta.positive ? "▲" : "▼"} {delta.value}
          </span>
        )}
        {hint && <span className="text-[11px] text-ink-3 truncate">{hint}</span>}
      </div>
    </Card>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="max-w-md text-xs text-ink-3 leading-relaxed">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Divider({ className }: { className?: string }) {
  return <div className={cn("h-px bg-line", className)} />;
}

/** Small labelled metric used inside detail panels. */
export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-[11px] uppercase tracking-wide text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink break-words">{children}</dd>
    </div>
  );
}

/** A horizontal 0-100 meter, used for confidence and exit potential. */
export function Meter({
  value,
  max = 100,
  tone = "accent",
  className,
  label,
}: {
  value: number;
  max?: number;
  tone?: "accent" | "signal";
  className?: string;
  label?: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-2", className)}
      role="meter"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
    >
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{
          width: `${pct}%`,
          background: tone === "accent" ? "var(--color-accent)" : "var(--color-signal)",
        }}
      />
    </div>
  );
}
