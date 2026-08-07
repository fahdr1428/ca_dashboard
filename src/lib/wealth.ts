import type { WealthBand, ConfidenceBand } from "@/generated/prisma/enums";

/** The advisor's qualifying threshold for the pipeline. */
export const QUALIFYING_THRESHOLD_GBP = 7_500_000;
/** The "priority founder" threshold called out in the brief. */
export const PRIORITY_THRESHOLD_GBP = 15_000_000;

export interface BandMeta {
  key: WealthBand;
  label: string;
  short: string;
  minGBP: number;
  maxGBP: number | null;
  /** Tailwind-friendly accent token, resolved in globals.css. */
  tone: "slate" | "sky" | "teal" | "amber" | "violet" | "rose";
}

export const WEALTH_BANDS: BandMeta[] = [
  { key: "BELOW_7_5M", label: "Below £7.5m", short: "<7.5m", minGBP: 0, maxGBP: 7_500_000, tone: "slate" },
  { key: "BAND_7_5_15M", label: "£7.5m – £15m", short: "7.5–15m", minGBP: 7_500_000, maxGBP: 15_000_000, tone: "sky" },
  { key: "BAND_15_30M", label: "£15m – £30m", short: "15–30m", minGBP: 15_000_000, maxGBP: 30_000_000, tone: "teal" },
  { key: "BAND_30_50M", label: "£30m – £50m", short: "30–50m", minGBP: 30_000_000, maxGBP: 50_000_000, tone: "amber" },
  { key: "BAND_50_100M", label: "£50m – £100m", short: "50–100m", minGBP: 50_000_000, maxGBP: 100_000_000, tone: "violet" },
  { key: "BAND_100M_PLUS", label: "£100m+", short: "100m+", minGBP: 100_000_000, maxGBP: null, tone: "rose" },
];

export const BAND_META: Record<WealthBand, BandMeta> = Object.fromEntries(
  WEALTH_BANDS.map((b) => [b.key, b]),
) as Record<WealthBand, BandMeta>;

/** Bands at or above the advisor's qualifying threshold. */
export const QUALIFYING_BANDS: WealthBand[] = WEALTH_BANDS.filter(
  (b) => b.minGBP >= QUALIFYING_THRESHOLD_GBP,
).map((b) => b.key);

export function bandForAmount(investableGBP: number): WealthBand {
  for (let i = WEALTH_BANDS.length - 1; i >= 0; i--) {
    if (investableGBP >= WEALTH_BANDS[i].minGBP) return WEALTH_BANDS[i].key;
  }
  return "BELOW_7_5M";
}

export const CONFIDENCE_BANDS: Array<{
  key: ConfidenceBand;
  label: string;
  min: number;
  description: string;
}> = [
  {
    key: "LOW",
    label: "Low",
    min: 0,
    description: "Single weak source or heavily modelled. Treat as a research lead only.",
  },
  {
    key: "MEDIUM",
    label: "Medium",
    min: 45,
    description: "Corroborated by more than one public source, but key inputs are modelled.",
  },
  {
    key: "HIGH",
    label: "High",
    min: 68,
    description: "Ownership and financials evidenced by statutory filings; estimate is narrow.",
  },
  {
    key: "VERIFIED",
    label: "Verified",
    min: 85,
    description: "Person matched on the Companies House register with filed ownership and recent accounts.",
  },
];

export function confidenceBandFor(score: number): ConfidenceBand {
  let band: ConfidenceBand = "LOW";
  for (const b of CONFIDENCE_BANDS) if (score >= b.min) band = b.key;
  return band;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Compact GBP for dense UI: £7.5m, £120k, £1.4bn. Deliberately low precision —
 * these are estimates and false precision misleads.
 */
export function formatGBP(value: number | bigint | null | undefined, opts?: { precise?: boolean }): string {
  if (value === null || value === undefined) return "—";
  const n = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  if (opts?.precise) {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: "GBP",
      maximumFractionDigits: 0,
    }).format(n);
  }
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}£${trim(abs / 1_000_000_000)}bn`;
  if (abs >= 1_000_000) return `${sign}£${trim(abs / 1_000_000)}m`;
  if (abs >= 1_000) return `${sign}£${trim(abs / 1_000)}k`;
  return `${sign}£${Math.round(abs)}`;
}

function trim(n: number): string {
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1).replace(/\.0$/, "");
  return n.toFixed(2).replace(/\.?0+$/, "");
}

/** "£7.5m – £12m" */
export function formatRange(low: number | bigint, high: number | bigint): string {
  return `${formatGBP(low)} – ${formatGBP(high)}`;
}

export function formatPct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "" : ""}${n.toFixed(digits)}%`;
}

/** Ownership bands from the PSC register render as "50–75%", not "62.5%". */
export function formatOwnership(low: number, high: number): string {
  if (Math.abs(high - low) < 0.51) return `${low.toFixed(low % 1 ? 1 : 0)}%`;
  return `${low.toFixed(0)}–${high.toFixed(0)}%`;
}

export function num(value: bigint | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "bigint" ? Number(value) : value;
}
