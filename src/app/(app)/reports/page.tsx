import Link from "next/link";
import { PageHeader } from "@/components/app-shell";
import { Card, CardHeader, Estimated, EmptyState, Badge } from "@/components/ui";
import { prisma } from "@/lib/db";
import { formatGBP } from "@/lib/wealth";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const reports = await prisma.weeklyReport.findMany({
    orderBy: { weekStart: "desc" },
    take: 26,
  });

  return (
    <>
      <PageHeader
        title="Weekly intelligence reports"
        description="Generated every Monday at 07:00 UTC after the scheduled refresh. Each report covers new prospects and what changed for existing ones."
      />
      <div className="px-5 pb-8 space-y-3">
        {reports.length === 0 && (
          <Card>
            <EmptyState
              title="No reports generated yet"
              description="Reports appear after the first scheduled run, or trigger one from the Automation page."
            />
          </Card>
        )}
        {reports.map((r, i) => (
          <Card key={r.id}>
            <CardHeader
              title={
                <Link href={`/reports/${r.id}`} className="hover:text-accent">
                  Week of {formatDate(r.weekStart)}
                  {i === 0 && (
                    <Badge tone="accent" className="ml-2">
                      Latest
                    </Badge>
                  )}
                </Link>
              }
              subtitle={`Generated ${formatDate(r.generatedAt)}`}
              action={
                <Link
                  href={`/reports/${r.id}`}
                  className="text-[12px] font-medium text-accent hover:underline"
                >
                  Read →
                </Link>
              }
            />
            <div className="px-5 pb-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Metric label="New prospects" value={r.newProspectCount} />
              <Metric label="Prospects updated" value={r.updatedProspectCount} />
              <Metric label="Signals detected" value={r.newSignalCount} />
              <div>
                <div className="text-[11px] uppercase tracking-wide text-ink-3">
                  Addressable assets
                </div>
                <div className="text-lg font-semibold tabular mt-0.5">
                  <Estimated>{formatGBP(Number(r.totalAddressableGBP))}</Estimated>
                </div>
                {Number(r.deltaAddressableGBP) !== 0 && (
                  <div
                    className={
                      Number(r.deltaAddressableGBP) > 0
                        ? "text-[11px] text-positive tabular"
                        : "text-[11px] text-negative tabular"
                    }
                  >
                    {Number(r.deltaAddressableGBP) > 0 ? "▲" : "▼"}{" "}
                    {formatGBP(Math.abs(Number(r.deltaAddressableGBP)))}
                  </div>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-ink-3">{label}</div>
      <div className="text-lg font-semibold tabular mt-0.5">{value}</div>
    </div>
  );
}
