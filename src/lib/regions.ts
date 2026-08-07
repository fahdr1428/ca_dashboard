import { Region } from "@/generated/prisma/enums";

export const REGIONS = [
  "CORNWALL",
  "DEVON",
  "SOMERSET",
  "BRISTOL",
  "GLOUCESTERSHIRE",
  "WILTSHIRE",
  "DORSET",
  "HAMPSHIRE",
  "WEST_SUSSEX",
  "SURREY",
  "BERKSHIRE",
  "GREATER_LONDON",
  "OXFORDSHIRE",
] as const satisfies readonly Region[];

export type RegionKey = (typeof REGIONS)[number];

export interface RegionMeta {
  key: RegionKey;
  label: string;
  /// Approximate administrative centre — used to place a marker when we only
  /// know the county, not a street address.
  centroid: { lat: number; lng: number };
  /// The 2013 local-authority districts that make up this ceremonial county.
  /// Used by scripts/build-geo.ts to assemble the map, and to resolve a
  /// Companies House registered-office district into one of our regions.
  districts: string[];
}

export const REGION_META: Record<RegionKey, RegionMeta> = {
  CORNWALL: {
    key: "CORNWALL",
    label: "Cornwall",
    centroid: { lat: 50.4, lng: -4.8 },
    districts: ["Cornwall", "Isles of Scilly"],
  },
  DEVON: {
    key: "DEVON",
    label: "Devon",
    centroid: { lat: 50.72, lng: -3.7 },
    districts: [
      "East Devon",
      "Exeter",
      "Mid Devon",
      "North Devon",
      "Plymouth",
      "South Hams",
      "Teignbridge",
      "Torbay",
      "Torridge",
      "West Devon",
    ],
  },
  SOMERSET: {
    key: "SOMERSET",
    label: "Somerset",
    centroid: { lat: 51.13, lng: -2.85 },
    districts: [
      "Bath and North East Somerset",
      "Mendip",
      "North Somerset",
      "Sedgemoor",
      "South Somerset",
      "Taunton Deane",
      "West Somerset",
    ],
  },
  BRISTOL: {
    key: "BRISTOL",
    label: "Bristol",
    centroid: { lat: 51.4545, lng: -2.5879 },
    districts: ["Bristol, City of"],
  },
  GLOUCESTERSHIRE: {
    key: "GLOUCESTERSHIRE",
    label: "Gloucestershire",
    centroid: { lat: 51.83, lng: -2.2 },
    districts: [
      "Cheltenham",
      "Cotswold",
      "Forest of Dean",
      "Gloucester",
      "South Gloucestershire",
      "Stroud",
      "Tewkesbury",
    ],
  },
  WILTSHIRE: {
    key: "WILTSHIRE",
    label: "Wiltshire",
    centroid: { lat: 51.35, lng: -1.95 },
    districts: ["Swindon", "Wiltshire"],
  },
  DORSET: {
    key: "DORSET",
    label: "Dorset",
    centroid: { lat: 50.75, lng: -2.35 },
    districts: [
      "Bournemouth",
      "Christchurch",
      "East Dorset",
      "North Dorset",
      "Poole",
      "Purbeck",
      "West Dorset",
      "Weymouth and Portland",
    ],
  },
  HAMPSHIRE: {
    key: "HAMPSHIRE",
    label: "Hampshire",
    centroid: { lat: 51.05, lng: -1.31 },
    districts: [
      "Basingstoke and Deane",
      "East Hampshire",
      "Eastleigh",
      "Fareham",
      "Gosport",
      "Hart",
      "Havant",
      "New Forest",
      "Portsmouth",
      "Rushmoor",
      "Southampton",
      "Test Valley",
      "Winchester",
    ],
  },
  WEST_SUSSEX: {
    key: "WEST_SUSSEX",
    label: "West Sussex",
    centroid: { lat: 50.94, lng: -0.47 },
    districts: [
      "Adur",
      "Arun",
      "Chichester",
      "Crawley",
      "Horsham",
      "Mid Sussex",
      "Worthing",
    ],
  },
  SURREY: {
    key: "SURREY",
    label: "Surrey",
    centroid: { lat: 51.27, lng: -0.44 },
    districts: [
      "Elmbridge",
      "Epsom and Ewell",
      "Guildford",
      "Mole Valley",
      "Reigate and Banstead",
      "Runnymede",
      "Spelthorne",
      "Surrey Heath",
      "Tandridge",
      "Waverley",
      "Woking",
    ],
  },
  BERKSHIRE: {
    key: "BERKSHIRE",
    label: "Berkshire",
    centroid: { lat: 51.45, lng: -0.98 },
    districts: [
      "Bracknell Forest",
      "Reading",
      "Slough",
      "West Berkshire",
      "Windsor and Maidenhead",
      "Wokingham",
    ],
  },
  GREATER_LONDON: {
    key: "GREATER_LONDON",
    label: "Greater London",
    centroid: { lat: 51.5074, lng: -0.1278 },
    // Resolved by ONS code prefix E09 in scripts/build-geo.ts.
    districts: [],
  },
  OXFORDSHIRE: {
    key: "OXFORDSHIRE",
    label: "Oxfordshire",
    centroid: { lat: 51.77, lng: -1.28 },
    districts: [
      "Cherwell",
      "Oxford",
      "South Oxfordshire",
      "Vale of White Horse",
      "West Oxfordshire",
    ],
  },
};

export const REGION_LABELS: Record<RegionKey, string> = Object.fromEntries(
  REGIONS.map((r) => [r, REGION_META[r].label]),
) as Record<RegionKey, string>;

/** Reverse lookup: district / town name -> region. Built once at module load. */
const DISTRICT_INDEX: Map<string, RegionKey> = (() => {
  const m = new Map<string, RegionKey>();
  for (const r of REGIONS) {
    for (const d of REGION_META[r].districts) m.set(d.toLowerCase(), r);
    m.set(REGION_META[r].label.toLowerCase(), r);
  }
  return m;
})();

/**
 * Best-effort resolution of a free-text location (typically a Companies House
 * registered-office locality or county line) to one of the 13 in-scope regions.
 * Returns null when the address is out of scope — callers must treat null as
 * "do not track", not as "default to London".
 */
export function resolveRegion(input: string | null | undefined): RegionKey | null {
  if (!input) return null;
  const text = input.toLowerCase();

  // Exact district match first (most specific).
  const direct = DISTRICT_INDEX.get(text.trim());
  if (direct) return direct;

  // London postcode districts and the common "London" locality.
  if (/\blondon\b/.test(text) && !/\blondonderry\b/.test(text)) return "GREATER_LONDON";

  for (const [name, region] of DISTRICT_INDEX) {
    // Word-boundary match so "Reading" doesn't fire on "Spreading".
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (re.test(text)) return region;
  }

  // A handful of high-frequency towns that aren't district names.
  const towns: Array<[RegExp, RegionKey]> = [
    [/\b(truro|falmouth|newquay|penzance|st ives|bodmin|redruth)\b/, "CORNWALL"],
    [/\b(barnstaple|tiverton|newton abbot|paignton|totnes|okehampton)\b/, "DEVON"],
    [/\b(yeovil|bridgwater|frome|wells|glastonbury|bath|weston-super-mare|clevedon)\b/, "SOMERSET"],
    [/\b(cirencester|tetbury|dursley|thornbury|yate|nailsworth)\b/, "GLOUCESTERSHIRE"],
    [/\b(salisbury|chippenham|trowbridge|devizes|marlborough|malmesbury)\b/, "WILTSHIRE"],
    [/\b(dorchester|bridport|sherborne|wareham|blandford|swanage|wimborne)\b/, "DORSET"],
    [/\b(andover|romsey|petersfield|alton|farnborough|aldershot|lymington|hedge end)\b/, "HAMPSHIRE"],
    [/\b(haywards heath|burgess hill|east grinstead|bognor|littlehampton|shoreham)\b/, "WEST_SUSSEX"],
    [/\b(esher|weybridge|cobham|leatherhead|dorking|farnham|godalming|camberley|staines|redhill|oxted)\b/, "SURREY"],
    [/\b(newbury|maidenhead|ascot|thatcham|sandhurst|hungerford|eton)\b/, "BERKSHIRE"],
    [/\b(banbury|bicester|abingdon|witney|didcot|henley-on-thames|thame|wallingford)\b/, "OXFORDSHIRE"],
  ];
  for (const [re, region] of towns) if (re.test(text)) return region;

  return null;
}

export function isInScope(region: string | null | undefined): region is RegionKey {
  return !!region && (REGIONS as readonly string[]).includes(region);
}
