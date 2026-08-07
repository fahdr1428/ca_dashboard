/**
 * Builds the dashboard's map from real ONS local-authority boundaries.
 *
 * Source: martinjc/UK-GeoJSON, derived from Office for National Statistics
 * boundary data (Open Government Licence v3.0 / © Crown copyright).
 *
 * The 326 English districts are filtered to the 13 in-scope counties, grouped
 * by county, simplified, and written out as a small GeoJSON file the client can
 * render inline. Doing this at build time rather than runtime means the map
 * needs no external tile server, which keeps the CSP locked down.
 *
 *   npx tsx scripts/build-geo.ts
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import { REGIONS, REGION_META, type RegionKey } from "../src/lib/regions";

const SOURCE_URL =
  "https://raw.githubusercontent.com/martinjc/UK-GeoJSON/master/json/administrative/eng/topo_lad.json";
const CACHE = resolve(process.cwd(), "data/eng_lad_topo.json");
const OUT = resolve(process.cwd(), "src/data/regions-geo.json");

/** Coordinate precision: 3dp ≈ 110m, plenty for a county-level overview map. */
const PRECISION = 3;

interface LadProps {
  LAD13CD: string;
  LAD13NM: string;
}

type Ring = [number, number][];

async function main() {
  let raw: string;
  if (existsSync(CACHE)) {
    raw = readFileSync(CACHE, "utf8");
    console.log(`Using cached boundaries at ${CACHE}`);
  } else {
    console.log(`Downloading ${SOURCE_URL} …`);
    const res = await fetch(SOURCE_URL);
    if (!res.ok) throw new Error(`Boundary download failed: HTTP ${res.status}`);
    raw = await res.text();
    mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
    writeFileSync(CACHE, raw);
  }

  const topo = JSON.parse(raw) as Topology;
  const collection = feature(topo, topo.objects.lad as GeometryCollection<LadProps>);

  // Build district -> region lookup, with Greater London resolved by ONS code.
  const districtToRegion = new Map<string, RegionKey>();
  for (const key of REGIONS) {
    for (const d of REGION_META[key].districts) districtToRegion.set(d, key);
  }

  const wanted = new Set(districtToRegion.keys());
  const found = new Set<string>();
  const features: Array<{
    type: "Feature";
    properties: { region: RegionKey; district: string; code: string };
    geometry: { type: "Polygon" | "MultiPolygon"; coordinates: number[][][] | number[][][][] };
  }> = [];

  for (const f of collection.features) {
    const props = f.properties as LadProps;
    const isLondon = props.LAD13CD.startsWith("E09");
    const region: RegionKey | undefined = isLondon
      ? "GREATER_LONDON"
      : districtToRegion.get(props.LAD13NM);
    if (!region) continue;
    if (!isLondon) found.add(props.LAD13NM);

    const geom = f.geometry;
    if (geom.type === "Polygon") {
      const rings = simplifyPolygon(geom.coordinates as Ring[]);
      if (rings.length) {
        features.push({
          type: "Feature",
          properties: { region, district: props.LAD13NM, code: props.LAD13CD },
          geometry: { type: "Polygon", coordinates: rings },
        });
      }
    } else if (geom.type === "MultiPolygon") {
      const polys = (geom.coordinates as Ring[][])
        .map(simplifyPolygon)
        .filter((p) => p.length > 0);
      if (polys.length) {
        features.push({
          type: "Feature",
          properties: { region, district: props.LAD13NM, code: props.LAD13CD },
          geometry: { type: "MultiPolygon", coordinates: polys },
        });
      }
    }
  }

  const missing = [...wanted].filter((d) => !found.has(d));
  if (missing.length) {
    console.warn(
      `WARNING: ${missing.length} configured district(s) were not found in the boundary file: ${missing.join(", ")}`,
    );
  }

  // Bounding box, so the client can project without scanning every coordinate.
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const f of features) {
    const polys: Ring[][] =
      f.geometry.type === "Polygon"
        ? [f.geometry.coordinates as unknown as Ring[]]
        : (f.geometry.coordinates as unknown as Ring[][]);
    for (const poly of polys) {
      for (const ring of poly) {
        for (const [lng, lat] of ring) {
          if (lng < minLng) minLng = lng;
          if (lat < minLat) minLat = lat;
          if (lng > maxLng) maxLng = lng;
          if (lat > maxLat) maxLat = lat;
        }
      }
    }
  }

  const output = {
    type: "FeatureCollection" as const,
    meta: {
      source: SOURCE_URL,
      attribution:
        "Contains Ordnance Survey and ONS data © Crown copyright and database right. Open Government Licence v3.0.",
      generatedAt: new Date().toISOString(),
      bbox: [minLng, minLat, maxLng, maxLat],
      regions: REGIONS,
    },
    features,
  };

  mkdirSync(resolve(process.cwd(), "src/data"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(output));

  const kb = (Buffer.byteLength(JSON.stringify(output)) / 1024).toFixed(0);
  const byRegion = new Map<string, number>();
  for (const f of features) {
    byRegion.set(f.properties.region, (byRegion.get(f.properties.region) ?? 0) + 1);
  }
  console.log(`Wrote ${features.length} districts across ${byRegion.size} regions (${kb} kB) to ${OUT}`);
  for (const key of REGIONS) {
    console.log(`  ${key.padEnd(16)} ${byRegion.get(key) ?? 0} district(s)`);
  }
  console.log(`bbox: [${output.meta.bbox.map((n) => n.toFixed(2)).join(", ")}]`);
}

/**
 * Douglas-Peucker simplification, then rounding.
 *
 * The raw ONS boundaries carry metre-level coastline detail — 975 kB for the
 * 13 counties. At the zoom this map renders, a 500m tolerance is invisible and
 * cuts the payload by roughly 80%. Islands below a minimum area are dropped
 * entirely; they would be sub-pixel.
 */
const DP_TOLERANCE_DEG = 0.0045; // ≈ 500 m

function simplifyPolygon(rings: Ring[]): Ring[] {
  const out: Ring[] = [];
  for (const ring of rings) {
    if (ring.length < 4) continue;
    if (area(ring) < 0.0006) continue;

    // Simplify the open path, then re-close it, so the ring stays valid.
    const open = ring.slice(0, -1);
    const simplified = douglasPeucker(open, DP_TOLERANCE_DEG);
    if (simplified.length < 3) continue;

    const rounded: Ring = [];
    let prev: [number, number] | null = null;
    for (const [lng, lat] of simplified) {
      const p: [number, number] = [round(lng), round(lat)];
      if (prev && p[0] === prev[0] && p[1] === prev[1]) continue;
      rounded.push(p);
      prev = p;
    }
    if (rounded.length < 3) continue;
    rounded.push([rounded[0][0], rounded[0][1]]);
    out.push(rounded);
  }
  return out;
}

function douglasPeucker(points: Ring, tolerance: number): Ring {
  if (points.length < 3) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(points[i], points[first], points[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > tolerance && index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out: Ring = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

function perpendicularDistance(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  // Longitude degrees are shorter than latitude degrees at UK latitudes;
  // scaling keeps the tolerance roughly isotropic in metres.
  const kx = Math.cos((51 * Math.PI) / 180);
  const px = p[0] * kx, py = p[1];
  const ax = a[0] * kx, ay = a[1];
  const bx = b[0] * kx, by = b[1];

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);

  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function round(n: number): number {
  return Number(n.toFixed(PRECISION));
}

/** Shoelace area in square degrees — only used for a relative size threshold. */
function area(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(a / 2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
