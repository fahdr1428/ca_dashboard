import { NextResponse, type NextRequest } from "next/server";
import { prisma, serialise } from "@/lib/db";
import { generateAndStoreWeeklyReport } from "@/lib/report/weekly";

/** Fetch a stored report, or regenerate this week's on demand. */
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  const format = request.nextUrl.searchParams.get("format");

  const report = id
    ? await prisma.weeklyReport.findUnique({ where: { id } })
    : await prisma.weeklyReport.findFirst({ orderBy: { weekStart: "desc" } });

  if (!report) return NextResponse.json({ error: "No report found" }, { status: 404 });

  if (format === "md") {
    return new Response(report.summaryMd, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="weekly-report-${report.weekStart.toISOString().slice(0, 10)}.md"`,
      },
    });
  }

  return NextResponse.json(serialise(report));
}

/** Regenerate the current week's report without running ingestion. */
export async function POST() {
  const report = await generateAndStoreWeeklyReport(new Date());
  return NextResponse.json(serialise({ ok: true, id: report.id }));
}
