import * as React from "react";
import { ExternalLink, FileCheck2, EyeOff, Sigma } from "lucide-react";
import { Badge } from "./ui";
import { formatGBP } from "@/lib/wealth";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/utils";
import type { FactProvenance } from "@/lib/verification";
import type { CompanyVerification } from "@/lib/verification";

/**
 * Renders a figure together with what kind of figure it is.
 *
 * A filed number and a modelled one look different on purpose. A number that
 * isn't on the public record shows as "not disclosed" with the reason, never as
 * zero and never as a silent dash — because an advisor reading a dash cannot
 * tell whether the company earned nothing or simply wasn't required to say.
 */
export function Fact({
  value,
  provenance,
  className,
  showBadge = true,
}: {
  value: number | null;
  provenance: FactProvenance;
  className?: string;
  showBadge?: boolean;
}) {
  if (provenance.grade === "NOT_DISCLOSED") {
    return (
      <span className={cn("inline-flex items-center gap-1.5", className)} title={provenance.reason ?? undefined}>
        <span className="text-[13px] text-ink-3 italic">Not disclosed</span>
        {showBadge && <EyeOff className="size-3 text-ink-3" />}
      </span>
    );
  }

  if (provenance.grade === "FILED") {
    return (
      <span
        className={cn("inline-flex items-center gap-1.5", className)}
        title={`Filed figure${provenance.asOf ? ` — accounts to ${formatDate(provenance.asOf)}` : ""}`}
      >
        <span className="tabular font-medium">{formatGBP(value)}</span>
        {showBadge && <FileCheck2 className="size-3 text-positive" />}
      </span>
    );
  }

  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      title={provenance.reason ?? "Modelled estimate"}
    >
      <span className="tabular font-medium">{formatGBP(value)}</span>
      <span className="text-[9px] font-semibold uppercase tracking-wider text-ink-3 select-none">
        est
      </span>
      {showBadge && provenance.confidence !== null && (
        <span className="text-[10px] tabular text-ink-3">{provenance.confidence}</span>
      )}
    </span>
  );
}

/** Full-width provenance row for detail pages: figure, grade, reason, source. */
export function FactRow({
  label,
  value,
  provenance,
}: {
  label: string;
  value: number | null;
  provenance: FactProvenance;
}) {
  const grade = provenance.grade;
  return (
    <div className="py-2.5 border-b border-line last:border-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-ink">{label}</span>
        <div className="flex items-center gap-2">
          {grade === "NOT_DISCLOSED" ? (
            <span className="text-[13px] text-ink-3 italic">Not disclosed</span>
          ) : (
            <span className="text-[14px] font-semibold tabular">{formatGBP(value)}</span>
          )}
          <GradeBadge provenance={provenance} />
        </div>
      </div>
      {provenance.reason && (
        <p className="mt-1 text-[11px] text-ink-3 leading-relaxed max-w-2xl">{provenance.reason}</p>
      )}
      {provenance.sourceUrl && grade === "FILED" && (
        <a
          href={provenance.sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-1 inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
        >
          Check the filing
          <ExternalLink className="size-2.5" />
        </a>
      )}
    </div>
  );
}

export function GradeBadge({ provenance }: { provenance: FactProvenance }) {
  switch (provenance.grade) {
    case "FILED":
      return (
        <Badge tone="accent" title="Stated in a statutory filing — a fact, not an estimate.">
          <FileCheck2 className="size-3" /> Filed
        </Badge>
      );
    case "NOT_DISCLOSED":
      return (
        <Badge tone="outline" title={provenance.reason ?? undefined}>
          <EyeOff className="size-3" /> Not on record
        </Badge>
      );
    default:
      return (
        <Badge tone="signal" title={provenance.reason ?? undefined}>
          <Sigma className="size-3" /> Modelled
          {provenance.confidence !== null && ` · ${provenance.confidence}`}
        </Badge>
      );
  }
}

/** Compact verification verdict for tables. */
export function VerificationBadge({
  verification,
  className,
}: {
  verification: CompanyVerification;
  className?: string;
}) {
  const tone =
    verification.status === "VERIFIED"
      ? "accent"
      : verification.status === "PARTIAL"
        ? "signal"
        : "outline";
  return (
    <Badge tone={tone} className={className} title={verification.summary}>
      {verification.status === "VERIFIED" && <FileCheck2 className="size-3" />}
      {verification.label}
      <span className="tabular opacity-70">
        {verification.filedCount}/{verification.totalCount}
      </span>
    </Badge>
  );
}
