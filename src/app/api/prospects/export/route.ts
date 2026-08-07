import { type NextRequest } from "next/server";
import { listProspects } from "@/lib/queries";
import { REGIONS, type RegionKey } from "@/lib/regions";
import { WEALTH_BANDS } from "@/lib/wealth";

/**
 * CSV export of the current tracker view. Column headers spell out that the
 * money columns are estimates, because a spreadsheet leaves the UI's caveats
 * behind the moment it is emailed to someone.
 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const regions = sp.getAll("region").filter((r): r is RegionKey =>
    (REGIONS as readonly string[]).includes(r),
  );
  const bands = sp.getAll("band").filter((b) => WEALTH_BANDS.some((w) => w.key === b));

  const { rows } = await listProspects({
    q: sp.get("q") ?? undefined,
    regions,
    bands: bands as never,
    industries: sp.getAll("industry"),
    cohort: (sp.get("cohort") as "qualifying" | "pre_liquidity" | null) ?? "all",
    sort: (sp.get("sort") as never) ?? "wealth",
    limit: 1000,
  });

  const headers = [
    "Full name", "Job title", "Occupation", "Company", "Office location", "County",
    "Estimated investable assets (GBP, ESTIMATE)",
    "Estimate low (GBP)", "Estimate high (GBP)",
    "Estimated gross wealth (GBP, ESTIMATE)",
    "Wealth band (estimated)", "Confidence /100", "Confidence band",
    "Cited public sources", "Signals", "Lead status", "Relationship stage",
    "Owner", "Date added", "Last updated", "Why identified",
  ];

  const lines = [headers.map(csv).join(",")];
  for (const p of rows) {
    lines.push(
      [
        p.fullName, p.jobTitle ?? "", p.occupation ?? "", p.companyName ?? "",
        p.officeLocation ?? "", p.regionLabel,
        p.estInvestableMidGBP, p.estInvestableLowGBP, p.estInvestableHighGBP,
        p.estGrossMidGBP, p.wealthBand, p.confidence, p.confidenceBand,
        p.sourceCount, p.signalCount, p.status, p.relationshipStage,
        p.owner ?? "", p.dateAdded.slice(0, 10), p.lastUpdated.slice(0, 10),
        p.rationale ?? "",
      ].map(csv).join(","),
    );
  }

  const preamble =
    "# All monetary figures are MODELLED ESTIMATES derived from public sources. They are not verified statements of wealth.\n";

  return new Response(preamble + lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="lead-tracker-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}

function csv(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
