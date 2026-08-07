"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import geo from "@/data/regions-geo.json";
import { formatGBP } from "@/lib/wealth";
import { cn } from "@/lib/utils";
import type { RegionKey } from "@/lib/regions";

/**
 * Prospect map.
 *
 * Real ONS district boundaries, projected and drawn inline as SVG. No tile
 * server and no external requests, which keeps the content-security policy
 * closed and means the map still works on a locked-down network.
 */

interface GeoFeature {
  type: "Feature";
  properties: { region: RegionKey; district: string; code: string };
  geometry:
    | { type: "Polygon"; coordinates: number[][][] }
    | { type: "MultiPolygon"; coordinates: number[][][][] };
}

const FEATURES = geo.features as unknown as GeoFeature[];
const BBOX = geo.meta.bbox as [number, number, number, number];

const WIDTH = 720;
const PADDING = 12;

/**
 * Equirectangular with a cos(φ) correction — accurate enough at this extent,
 * and the viewBox height is derived from the data's own aspect ratio so the
 * counties fill the frame instead of floating in whitespace.
 */
const [MIN_LNG, MIN_LAT, MAX_LNG, MAX_LAT] = BBOX;
const KX = Math.cos((((MIN_LAT + MAX_LAT) / 2) * Math.PI) / 180);
const SPAN_X = (MAX_LNG - MIN_LNG) * KX;
const SPAN_Y = MAX_LAT - MIN_LAT;
const SCALE = (WIDTH - PADDING * 2) / SPAN_X;
const HEIGHT = Math.round(SPAN_Y * SCALE + PADDING * 2);

function project(lng: number, lat: number): [number, number] {
  return [
    PADDING + (lng - MIN_LNG) * KX * SCALE,
    // SVG y grows downward, latitude grows upward.
    PADDING + (MAX_LAT - lat) * SCALE,
  ];
}

function ringToPath(ring: number[][]): string {
  let d = "";
  for (let i = 0; i < ring.length; i++) {
    const [x, y] = project(ring[i][0], ring[i][1]);
    d += `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  return `${d}Z`;
}

/** One path string per district, computed once at module load. */
const DISTRICT_PATHS: Array<{ region: RegionKey; district: string; d: string }> = FEATURES.map(
  (f) => {
    const polys =
      f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    const d = polys.map((poly) => poly.map(ringToPath).join("")).join("");
    return { region: f.properties.region, district: f.properties.district, d };
  },
);

export interface MapRegionStat {
  region: RegionKey;
  label: string;
  count: number;
  qualifying: number;
  addressableGBP: number;
}

export interface MapMarker {
  slug: string;
  fullName: string;
  companyName: string | null;
  regionLabel: string;
  latitude: number;
  longitude: number;
  estInvestableMidGBP: number;
  wealthBand: string;
  confidence: number;
}

export function ProspectMap({
  regionStats,
  markers,
  selectedRegion,
  onSelectRegion,
  className,
}: {
  regionStats: MapRegionStat[];
  markers: MapMarker[];
  selectedRegion?: RegionKey | null;
  onSelectRegion?: (region: RegionKey | null) => void;
  className?: string;
}) {
  const router = useRouter();
  const [hovered, setHovered] = React.useState<
    | { kind: "region"; region: RegionKey; x: number; y: number }
    | { kind: "marker"; marker: MapMarker; x: number; y: number }
    | null
  >(null);

  const statByRegion = React.useMemo(
    () => new Map(regionStats.map((s) => [s.region, s])),
    [regionStats],
  );

  const maxAddressable = Math.max(1, ...regionStats.map((s) => s.addressableGBP));

  // Cluster markers that land on the same pixel so overlapping offices don't
  // hide each other.
  const placed = React.useMemo(() => {
    const groups = new Map<string, { x: number; y: number; items: MapMarker[] }>();
    for (const m of markers) {
      if (m.latitude == null || m.longitude == null) continue;
      const [x, y] = project(m.longitude, m.latitude);
      const key = `${Math.round(x / 9)}:${Math.round(y / 9)}`;
      const g = groups.get(key) ?? { x, y, items: [] };
      g.items.push(m);
      groups.set(key, g);
    }
    return [...groups.values()];
  }, [markers]);

  const maxMarkerValue = Math.max(1, ...markers.map((m) => m.estInvestableMidGBP));

  function fillFor(region: RegionKey): string {
    const stat = statByRegion.get(region);
    const intensity = stat ? stat.addressableGBP / maxAddressable : 0;
    if (!stat?.count) return "var(--color-surface-2)";
    // 0.08 floor so a region with any presence is still visibly distinct.
    return `color-mix(in oklab, var(--color-accent) ${(8 + intensity * 62).toFixed(1)}%, var(--color-surface-2))`;
  }

  return (
    <div className={cn("relative", className)}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full h-auto select-none"
        role="img"
        aria-label="Map of prospect locations across the 13 target counties"
        onMouseLeave={() => setHovered(null)}
      >
        <g>
          {DISTRICT_PATHS.map((p, i) => {
            const isSelected = selectedRegion === p.region;
            const isDimmed = selectedRegion != null && !isSelected;
            return (
              <path
                key={`${p.district}-${i}`}
                d={p.d}
                fill={fillFor(p.region)}
                stroke="var(--color-line)"
                strokeWidth={0.5}
                opacity={isDimmed ? 0.35 : 1}
                className="cursor-pointer transition-opacity"
                onMouseMove={(e) => {
                  const rect = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
                  setHovered({
                    kind: "region",
                    region: p.region,
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top,
                  });
                }}
                onClick={() =>
                  onSelectRegion?.(selectedRegion === p.region ? null : p.region)
                }
              />
            );
          })}
        </g>

        {/* County outlines drawn on top so borders read cleanly. */}
        <g pointerEvents="none">
          {DISTRICT_PATHS.map((p, i) => (
            <path
              key={`outline-${i}`}
              d={p.d}
              fill="none"
              stroke={
                selectedRegion === p.region ? "var(--color-accent)" : "transparent"
              }
              strokeWidth={1.4}
            />
          ))}
        </g>

        <g>
          {placed.map((g, i) => {
            const total = g.items.reduce((a, m) => a + m.estInvestableMidGBP, 0);
            const r = 3.5 + Math.sqrt(total / maxMarkerValue) * 8;
            const top = g.items.reduce((a, b) =>
              a.estInvestableMidGBP >= b.estInvestableMidGBP ? a : b,
            );
            const dimmed =
              selectedRegion != null &&
              !g.items.some((m) => m.regionLabel === statByRegion.get(selectedRegion)?.label);
            return (
              <g key={i} opacity={dimmed ? 0.25 : 1}>
                <circle
                  cx={g.x}
                  cy={g.y}
                  r={r}
                  fill="var(--color-accent)"
                  fillOpacity={0.28}
                  stroke="var(--color-accent)"
                  strokeWidth={1.2}
                  className="cursor-pointer"
                  onMouseMove={(e) => {
                    const rect = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
                    setHovered({
                      kind: "marker",
                      marker: top,
                      x: e.clientX - rect.left,
                      y: e.clientY - rect.top,
                    });
                  }}
                  onClick={() => router.push(`/prospects/${top.slug}`)}
                />
                {g.items.length > 1 && (
                  <text
                    x={g.x}
                    y={g.y + 3}
                    textAnchor="middle"
                    className="pointer-events-none"
                    fontSize={9}
                    fontWeight={600}
                    fill="var(--color-ink)"
                  >
                    {g.items.length}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {hovered && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-line bg-surface px-2.5 py-1.5 shadow-lg text-[11px] leading-snug max-w-56"
          style={{
            left: Math.min(hovered.x + 12, WIDTH - 180),
            top: hovered.y + 12,
          }}
        >
          {hovered.kind === "region" ? (
            <RegionTooltip stat={statByRegion.get(hovered.region)} />
          ) : (
            <MarkerTooltip marker={hovered.marker} />
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 px-1 pt-2 text-[10px] text-ink-3">
        <span className="flex items-center gap-1.5">
          <span className="flex">
            {[0.1, 0.3, 0.5, 0.7].map((v) => (
              <span
                key={v}
                className="size-2.5"
                style={{
                  background: `color-mix(in oklab, var(--color-accent) ${v * 100}%, var(--color-surface-2))`,
                }}
              />
            ))}
          </span>
          Addressable assets by county
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full border border-[var(--color-accent)] bg-[var(--color-accent)]/30" />
          Prospect office (size = estimated investable assets)
        </span>
        <span className="ml-auto">Click a county to filter · click a bubble to open the record</span>
      </div>
    </div>
  );
}

function RegionTooltip({ stat }: { stat: MapRegionStat | undefined }) {
  if (!stat) return null;
  return (
    <>
      <div className="font-semibold text-ink">{stat.label}</div>
      <div className="text-ink-3 tabular">
        {stat.count} tracked · {stat.qualifying} qualifying
      </div>
      <div className="text-ink-2 tabular">
        {formatGBP(stat.addressableGBP)} estimated addressable
      </div>
    </>
  );
}

function MarkerTooltip({ marker }: { marker: MapMarker }) {
  return (
    <>
      <div className="font-semibold text-ink">{marker.fullName}</div>
      {marker.companyName && <div className="text-ink-3">{marker.companyName}</div>}
      <div className="text-ink-2 tabular">
        {formatGBP(marker.estInvestableMidGBP)} est. investable · confidence {marker.confidence}
      </div>
    </>
  );
}
