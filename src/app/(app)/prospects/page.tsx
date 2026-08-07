import { PageHeader } from "@/components/app-shell";
import { ProspectTable } from "@/components/prospect-table";
import { listProspects, getIndustryOptions, type ProspectFilters } from "@/lib/queries";
import { REGIONS } from "@/lib/regions";
import { WEALTH_BANDS } from "@/lib/wealth";
import { STATUS_LABELS } from "@/components/ui";
import type { LeadStatus, WealthBand } from "@/generated/prisma/enums";
import type { RegionKey } from "@/lib/regions";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function many(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/** Query strings are user input: validate every value against the known set. */
function parseFilters(sp: SearchParams): ProspectFilters & { raw: Record<string, never> } {
  const regions = many(sp.region).filter((r): r is RegionKey =>
    (REGIONS as readonly string[]).includes(r),
  );
  const bands = many(sp.band).filter((b): b is WealthBand =>
    WEALTH_BANDS.some((w) => w.key === b),
  );
  const statuses = many(sp.status).filter((s): s is LeadStatus => s in STATUS_LABELS);
  const minConfidence = Number(sp.minConfidence);
  const cohort = ["qualifying", "pre_liquidity"].includes(String(sp.cohort))
    ? (String(sp.cohort) as "qualifying" | "pre_liquidity")
    : "all";
  const sort = ["wealth", "newest", "confidence", "name", "updated"].includes(String(sp.sort))
    ? (String(sp.sort) as ProspectFilters["sort"])
    : "wealth";

  return {
    q: typeof sp.q === "string" ? sp.q.slice(0, 120) : "",
    regions,
    bands,
    industries: many(sp.industry),
    statuses,
    minConfidence: Number.isFinite(minConfidence) ? minConfidence : 0,
    cohort,
    sort,
    limit: 250,
  } as ProspectFilters & { raw: Record<string, never> };
}

export default async function ProspectsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const [{ rows, total }, industries] = await Promise.all([
    listProspects(filters),
    getIndustryOptions(),
  ]);

  return (
    <>
      <PageHeader
        title="Lead tracker"
        description="Every individual identified from public sources, with the estimate, the evidence behind it and where the relationship stands."
      />
      <div className="px-5 pb-8">
        <ProspectTable
          rows={rows}
          total={total}
          industries={industries}
          initial={{
            q: filters.q ?? "",
            regions: filters.regions ?? [],
            bands: filters.bands ?? [],
            industries: filters.industries ?? [],
            statuses: filters.statuses ?? [],
            minConfidence: filters.minConfidence ?? 0,
            cohort: filters.cohort ?? "all",
            sort: filters.sort ?? "wealth",
          }}
        />
      </div>
    </>
  );
}
