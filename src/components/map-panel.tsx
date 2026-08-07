"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ProspectMap, type MapMarker, type MapRegionStat } from "./prospect-map";
import { Card, CardHeader } from "./ui";
import type { RegionKey } from "@/lib/regions";

/** Wraps the map so county selection can drive navigation into the tracker. */
export function MapPanel({
  regionStats,
  markers,
}: {
  regionStats: MapRegionStat[];
  markers: MapMarker[];
}) {
  const router = useRouter();
  const [selected, setSelected] = React.useState<RegionKey | null>(null);

  const selectedStat = selected ? regionStats.find((r) => r.region === selected) : null;

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Prospect geography"
        subtitle="Shading shows estimated addressable assets by county; bubbles are prospect office locations."
        action={
          selectedStat ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => router.push(`/prospects?region=${selected}`)}
                className="rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-surface"
              >
                View {selectedStat.label}
              </button>
              <button
                onClick={() => setSelected(null)}
                className="rounded-md border border-line px-2 py-1 text-[11px] text-ink-2"
              >
                Clear
              </button>
            </div>
          ) : null
        }
      />
      <div className="px-3 pb-3">
        <ProspectMap
          regionStats={regionStats}
          markers={markers}
          selectedRegion={selected}
          onSelectRegion={setSelected}
        />
      </div>
    </Card>
  );
}
