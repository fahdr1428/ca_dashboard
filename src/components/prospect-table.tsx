"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, X, SlidersHorizontal, ArrowUpDown, Download } from "lucide-react";
import {
  Badge,
  WealthBandBadge,
  ConfidenceBadge,
  StatusBadge,
  Estimated,
  EmptyState,
  STAGE_LABELS,
  STATUS_LABELS,
} from "./ui";
import { formatGBP } from "@/lib/wealth";
import { WEALTH_BANDS } from "@/lib/wealth";
import { REGIONS, REGION_META, type RegionKey } from "@/lib/regions";
import { COHORT_LABELS } from "@/lib/pipeline-filters";
import { formatRelative, cn } from "@/lib/utils";
import type { ProspectRow } from "@/lib/queries";
import type { LeadStatus, WealthBand } from "@/generated/prisma/enums";

/**
 * The lead tracker.
 *
 * Filter state lives in the URL, so a filtered view is a shareable link and
 * the back button behaves. Filtering and sorting run on the server via a
 * navigation, which keeps one source of truth for "who matches".
 */

const SORTS = [
  { key: "wealth", label: "Estimated wealth" },
  { key: "newest", label: "Newest" },
  { key: "confidence", label: "Confidence" },
  { key: "updated", label: "Recently updated" },
  { key: "name", label: "Name" },
] as const;

const COHORTS = [
  { key: "all", label: "All tracked" },
  { key: "qualifying", label: "Qualifying (£7.5m+)" },
  { key: "pre_liquidity", label: "Pre-liquidity founders" },
] as const;

export function ProspectTable({
  rows,
  total,
  industries,
  initial,
}: {
  rows: ProspectRow[];
  total: number;
  industries: string[];
  initial: {
    q: string;
    regions: string[];
    bands: string[];
    industries: string[];
    statuses: string[];
    minConfidence: number;
    cohort: string;
    sort: string;
  };
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = React.useState(initial.q);
  const [showFilters, setShowFilters] = React.useState(
    initial.regions.length + initial.bands.length + initial.industries.length > 0,
  );

  const push = React.useCallback(
    (mutate: (p: URLSearchParams) => void) => {
      const next = new URLSearchParams(params.toString());
      mutate(next);
      router.push(`/prospects?${next.toString()}`, { scroll: false });
    },
    [params, router],
  );

  // Debounce the search box so typing doesn't fire a request per keystroke.
  React.useEffect(() => {
    if (q === initial.q) return;
    const t = setTimeout(() => {
      push((p) => {
        if (q) p.set("q", q);
        else p.delete("q");
      });
    }, 300);
    return () => clearTimeout(t);
  }, [q, initial.q, push]);

  function toggleMulti(key: string, value: string) {
    push((p) => {
      const current = p.getAll(key);
      p.delete(key);
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      for (const v of next) p.append(key, v);
    });
  }

  const activeFilterCount =
    initial.regions.length +
    initial.bands.length +
    initial.industries.length +
    initial.statuses.length +
    (initial.minConfidence ? 1 : 0);

  function clearAll() {
    router.push("/prospects", { scroll: false });
    setQ("");
  }

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-56">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-ink-3" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, company, town or company number…"
            className="w-full rounded-lg border border-line bg-surface pl-8 pr-8 py-1.5 text-[13px] outline-none focus:border-accent"
          />
          {q && (
            <button
              onClick={() => setQ("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink"
              aria-label="Clear search"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <div className="flex rounded-lg border border-line overflow-hidden">
          {COHORTS.map((c) => (
            <button
              key={c.key}
              onClick={() =>
                push((p) => {
                  if (c.key === "all") p.delete("cohort");
                  else p.set("cohort", c.key);
                })
              }
              className={cn(
                "px-2.5 py-1.5 text-[12px] font-medium whitespace-nowrap",
                initial.cohort === c.key
                  ? "bg-accent text-surface"
                  : "bg-surface text-ink-2 hover:bg-surface-2",
              )}
            >
              {c.label}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px]">
          <ArrowUpDown className="size-3.5 text-ink-3" />
          <select
            value={initial.sort}
            onChange={(e) => push((p) => p.set("sort", e.target.value))}
            className="bg-transparent outline-none text-ink"
          >
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        <button
          onClick={() => setShowFilters((v) => !v)}
          className={cn(
            "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium",
            activeFilterCount
              ? "border-accent text-accent"
              : "border-line text-ink-2 hover:bg-surface-2",
          )}
        >
          <SlidersHorizontal className="size-3.5" />
          Filters
          {activeFilterCount > 0 && (
            <span className="rounded bg-accent px-1 text-[10px] text-surface">
              {activeFilterCount}
            </span>
          )}
        </button>

        <a
          href={`/api/prospects/export?${params.toString()}`}
          className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-medium text-ink-2 hover:bg-surface-2"
          title="Download the current view as CSV"
        >
          <Download className="size-3.5" />
          CSV
        </a>
      </div>

      {showFilters && (
        <div className="rounded-xl border border-line bg-surface p-4 space-y-3">
          <FilterGroup label="County">
            {REGIONS.map((r) => (
              <Chip
                key={r}
                active={initial.regions.includes(r)}
                onClick={() => toggleMulti("region", r)}
              >
                {REGION_META[r as RegionKey].label}
              </Chip>
            ))}
          </FilterGroup>

          <FilterGroup label="Estimated investable band">
            {WEALTH_BANDS.map((b) => (
              <Chip
                key={b.key}
                active={initial.bands.includes(b.key)}
                onClick={() => toggleMulti("band", b.key)}
              >
                {b.label}
              </Chip>
            ))}
          </FilterGroup>

          <FilterGroup label="Industry">
            {industries.map((i) => (
              <Chip
                key={i}
                active={initial.industries.includes(i)}
                onClick={() => toggleMulti("industry", i)}
              >
                {i}
              </Chip>
            ))}
          </FilterGroup>

          <FilterGroup label="Lead status">
            {(Object.keys(STATUS_LABELS) as LeadStatus[]).map((s) => (
              <Chip
                key={s}
                active={initial.statuses.includes(s)}
                onClick={() => toggleMulti("status", s)}
              >
                {STATUS_LABELS[s]}
              </Chip>
            ))}
          </FilterGroup>

          <FilterGroup label="Minimum confidence">
            {[0, 45, 68, 85].map((c) => (
              <Chip
                key={c}
                active={initial.minConfidence === c}
                onClick={() =>
                  push((p) => {
                    if (c === 0) p.delete("minConfidence");
                    else p.set("minConfidence", String(c));
                  })
                }
              >
                {c === 0 ? "Any" : `${c}+`}
              </Chip>
            ))}
          </FilterGroup>

          {activeFilterCount > 0 && (
            <button onClick={clearAll} className="text-[12px] text-accent hover:underline">
              Clear all filters
            </button>
          )}
        </div>
      )}

      <div className="text-[12px] text-ink-3">
        {total} prospect{total === 1 ? "" : "s"}
        {rows.length < total && ` · showing first ${rows.length}`}
      </div>

      {/* Table */}
      <div className="rounded-xl border border-line bg-surface overflow-hidden">
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-3 py-2.5 font-medium">Company &amp; role</th>
                <th className="px-3 py-2.5 font-medium">County</th>
                <th className="px-3 py-2.5 font-medium">Industry</th>
                <th className="px-3 py-2.5 font-medium text-right">Est. investable</th>
                <th className="px-3 py-2.5 font-medium">Band</th>
                <th className="px-3 py-2.5 font-medium text-right">Conf.</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Stage</th>
                <th className="px-4 py-2.5 font-medium text-right">Added</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-b border-line last:border-0 hover:bg-surface-2 align-top">
                  <td className="px-4 py-2.5">
                    <Link href={`/prospects/${p.slug}`} className="font-medium hover:text-accent">
                      {p.fullName}
                    </Link>
                    <div className="flex items-center gap-1 mt-0.5">
                      {p.cohort === "PRE_LIQUIDITY" && (
                        <Badge tone="signal" title="Gross wealth clears £15m but is not yet liquid">
                          Pre-liquidity
                        </Badge>
                      )}
                      {p.owner && <Badge tone="outline">{p.owner}</Badge>}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    {p.companySlug ? (
                      <Link href={`/companies/${p.companySlug}`} className="text-ink-2 hover:text-accent">
                        {p.companyName}
                      </Link>
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                    <div className="text-[11px] text-ink-3">{p.jobTitle ?? p.occupation ?? ""}</div>
                  </td>
                  <td className="px-3 py-2.5 text-ink-2 whitespace-nowrap">
                    {p.regionLabel}
                    {p.officeLocation && (
                      <div className="text-[11px] text-ink-3">{p.officeLocation}</div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-ink-2">{p.industry ?? "—"}</td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap">
                    <Estimated className="font-medium">{formatGBP(p.estInvestableMidGBP)}</Estimated>
                    <div className="text-[11px] text-ink-3 tabular">
                      gross {formatGBP(p.estGrossMidGBP)}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <WealthBandBadge band={p.wealthBand} />
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <ConfidenceBadge score={p.confidence} band={p.confidenceBand} />
                    <div className="text-[10px] text-ink-3 mt-0.5">{p.sourceCount} src</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="px-3 py-2.5 text-[12px] text-ink-2 whitespace-nowrap">
                    {STAGE_LABELS[p.relationshipStage]}
                  </td>
                  <td className="px-4 py-2.5 text-right text-[11px] text-ink-3 whitespace-nowrap">
                    {formatRelative(p.dateAdded)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {rows.length === 0 && (
          <EmptyState
            title="No prospects match these filters"
            description="Try widening the county or band filters, or clear the search."
            action={
              <button onClick={clearAll} className="text-[12px] text-accent hover:underline">
                Clear all filters
              </button>
            }
          />
        )}
      </div>
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-ink-3 mb-1.5">{label}</div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors",
        active
          ? "border-accent bg-accent-soft text-accent-ink"
          : "border-line text-ink-2 hover:bg-surface-2",
      )}
    >
      {children}
    </button>
  );
}

export { COHORT_LABELS };
