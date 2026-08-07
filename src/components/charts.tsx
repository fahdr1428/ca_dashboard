"use client";

import * as React from "react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from "recharts";
import { formatGBP } from "@/lib/wealth";
import { formatDate } from "@/lib/utils";

/**
 * Chart set.
 *
 * One accent colour carries money everywhere; the wealth-band ramp is the only
 * categorical scale. Axis labels are compact GBP because these are estimates —
 * showing pounds and pence would imply a precision the model doesn't have.
 */

const AXIS = { stroke: "var(--color-line)", tickLine: false, axisLine: false } as const;

function TooltipShell({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; value: string; tone?: string }>;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface px-2.5 py-1.5 shadow-lg">
      <div className="text-[11px] font-semibold text-ink mb-0.5">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-baseline gap-3 text-[11px]">
          <span className="text-ink-3">{r.label}</span>
          <span className="ml-auto tabular font-medium" style={{ color: r.tone }}>
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function PipelineTrendChart({
  data,
}: {
  data: Array<{ week: string; investableGBP: number; grossGBP: number; prospects: number }>;
}) {
  if (data.length < 2) {
    return <NoData message="Trend appears once two weekly snapshots exist." />;
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="investableFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="grossFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-band-violet)" stopOpacity={0.18} />
            <stop offset="100%" stopColor="var(--color-band-violet)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="2 4" vertical={false} />
        <XAxis
          dataKey="week"
          {...AXIS}
          tickFormatter={(v: string) => formatDate(v).slice(0, 6)}
          minTickGap={24}
        />
        <YAxis {...AXIS} tickFormatter={(v: number) => formatGBP(v)} width={62} />
        <Tooltip
          content={({ active, payload, label }) =>
            active && payload?.length ? (
              <TooltipShell
                title={`Week of ${formatDate(label as string)}`}
                rows={[
                  {
                    label: "Gross estimated wealth",
                    value: formatGBP(payload[1]?.value as number),
                    tone: "var(--color-band-violet)",
                  },
                  {
                    label: "Estimated investable",
                    value: formatGBP(payload[0]?.value as number),
                    tone: "var(--color-accent)",
                  },
                  { label: "Prospects tracked", value: String(payload[0]?.payload?.prospects ?? "") },
                ]}
              />
            ) : null
          }
        />
        <Area
          type="monotone"
          dataKey="investableGBP"
          stroke="var(--color-accent)"
          strokeWidth={2}
          fill="url(#investableFill)"
        />
        <Area
          type="monotone"
          dataKey="grossGBP"
          stroke="var(--color-band-violet)"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          fill="url(#grossFill)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

const TONE_VAR: Record<string, string> = {
  slate: "var(--color-band-slate)",
  sky: "var(--color-band-sky)",
  teal: "var(--color-band-teal)",
  amber: "var(--color-band-amber)",
  violet: "var(--color-band-violet)",
  rose: "var(--color-band-rose)",
};

export function BandDistributionChart({
  data,
  onSelect,
}: {
  data: Array<{ band: string; short: string; label: string; tone: string; count: number; addressableGBP: number }>;
  onSelect?: (band: string) => void;
}) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 4, bottom: 4 }}>
        <CartesianGrid strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="short" {...AXIS} interval={0} tick={{ fontSize: 10 }} height={20} />
        <YAxis {...AXIS} allowDecimals={false} width={28} />
        <Tooltip
          cursor={{ fill: "var(--color-surface-2)" }}
          content={({ active, payload }) =>
            active && payload?.length ? (
              <TooltipShell
                title={payload[0].payload.label}
                rows={[
                  { label: "Prospects", value: String(payload[0].payload.count) },
                  {
                    label: "Est. investable total",
                    value: formatGBP(payload[0].payload.addressableGBP),
                  },
                ]}
              />
            ) : null
          }
        />
        <Bar dataKey="count" radius={[3, 3, 0, 0]} onClick={(d) => onSelect?.((d as unknown as { band: string }).band)}>
          {data.map((d) => (
            <Cell key={d.band} fill={TONE_VAR[d.tone]} cursor={onSelect ? "pointer" : undefined} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function IndustryChart({
  data,
}: {
  data: Array<{ industry: string; count: number; addressableGBP: number }>;
}) {
  const top = data.slice(0, 8);
  return (
    <ResponsiveContainer width="100%" height={Math.max(180, top.length * 30)}>
      <BarChart data={top} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 4 }}>
        <CartesianGrid strokeDasharray="2 4" horizontal={false} />
        <XAxis type="number" {...AXIS} tickFormatter={(v: number) => formatGBP(v)} />
        <YAxis
          type="category"
          dataKey="industry"
          {...AXIS}
          width={150}
          interval={0}
          tick={{ fontSize: 11 }}
          tickFormatter={(v: string) => (v.length > 20 ? `${v.slice(0, 19)}…` : v)}
        />
        <Tooltip
          cursor={{ fill: "var(--color-surface-2)" }}
          content={({ active, payload }) =>
            active && payload?.length ? (
              <TooltipShell
                title={payload[0].payload.industry}
                rows={[
                  { label: "Prospects", value: String(payload[0].payload.count) },
                  {
                    label: "Est. investable total",
                    value: formatGBP(payload[0].payload.addressableGBP),
                  },
                ]}
              />
            ) : null
          }
        />
        <Bar dataKey="addressableGBP" fill="var(--color-accent)" radius={[0, 3, 3, 0]} barSize={14} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function RevenueSparkline({
  series,
}: {
  series: Array<{ period: string; revenueGBP: number }>;
}) {
  return (
    <ResponsiveContainer width="100%" height={36}>
      <LineChart data={series} margin={{ top: 4, right: 2, left: 2, bottom: 2 }}>
        <Line
          type="monotone"
          dataKey="revenueGBP"
          stroke="var(--color-accent)"
          strokeWidth={1.6}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function CompanyFinancialsChart({
  data,
}: {
  data: Array<{
    period: string;
    revenueGBP: number | null;
    pretaxProfitGBP: number | null;
    dividendsGBP: number | null;
  }>;
}) {
  if (!data.length) return <NoData message="No filed financial history on record." />;
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="period" {...AXIS} />
        <YAxis {...AXIS} tickFormatter={(v: number) => formatGBP(v)} width={62} />
        <Tooltip
          cursor={{ fill: "var(--color-surface-2)" }}
          content={({ active, payload, label }) =>
            active && payload?.length ? (
              <TooltipShell
                title={String(label)}
                rows={payload.map((p) => ({
                  label: String(p.name),
                  value: formatGBP(p.value as number),
                  tone: p.color,
                }))}
              />
            ) : null
          }
        />
        <ReferenceLine y={0} stroke="var(--color-line-strong)" />
        <Bar dataKey="revenueGBP" name="Turnover" fill="var(--color-accent)" radius={[3, 3, 0, 0]} />
        <Bar
          dataKey="pretaxProfitGBP"
          name="Pre-tax profit"
          fill="var(--color-band-sky)"
          radius={[3, 3, 0, 0]}
        />
        <Bar
          dataKey="dividendsGBP"
          name="Dividends declared"
          fill="var(--color-signal)"
          radius={[3, 3, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ConfidenceTrendChart({
  data,
}: {
  data: Array<{ week: string; avgConfidence: number }>;
}) {
  if (data.length < 2) return <NoData message="Confidence trend needs two weeks of history." />;
  return (
    <ResponsiveContainer width="100%" height={140}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="2 4" vertical={false} />
        <XAxis
          dataKey="week"
          {...AXIS}
          tickFormatter={(v: string) => formatDate(v).slice(0, 6)}
          minTickGap={24}
        />
        <YAxis {...AXIS} domain={[0, 100]} width={34} ticks={[0, 25, 50, 75, 100]} />
        <ReferenceLine
          y={68}
          stroke="var(--color-accent)"
          strokeDasharray="3 3"
          label={{ value: "High", fontSize: 10, fill: "var(--color-ink-3)", position: "insideTopRight" }}
        />
        <Tooltip
          content={({ active, payload, label }) =>
            active && payload?.length ? (
              <TooltipShell
                title={`Week of ${formatDate(label as string)}`}
                rows={[{ label: "Mean confidence", value: `${payload[0].value}/100` }]}
              />
            ) : null
          }
        />
        <Line
          type="monotone"
          dataKey="avgConfidence"
          stroke="var(--color-accent)"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Horizontal stacked bar showing how an estimate decomposes. */
export function EstimateCompositionBar({
  components,
}: {
  components: Array<{ label: string; midGBP: number; color: string }>;
}) {
  const total = components.reduce((a, c) => a + c.midGBP, 0);
  if (total <= 0) return null;
  return (
    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-2">
      {components.map((c, i) => (
        <div
          key={i}
          style={{ width: `${(c.midGBP / total) * 100}%`, background: c.color }}
          title={`${c.label}: ${formatGBP(c.midGBP)}`}
        />
      ))}
    </div>
  );
}

function NoData({ message }: { message: string }) {
  return (
    <div className="grid h-[140px] place-items-center text-[11px] text-ink-3 px-4 text-center">
      {message}
    </div>
  );
}
