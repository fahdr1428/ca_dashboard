import { NextResponse, type NextRequest } from "next/server";
import { runIngest } from "@/lib/ingest/pipeline";
import { generateAndStoreWeeklyReport } from "@/lib/report/weekly";
import { prisma } from "@/lib/db";
import { deliverWeeklyReport } from "@/lib/report/deliver";

/**
 * The Monday-morning job.
 *
 * Scheduled by vercel.json (or any external scheduler) for 07:00 UTC every
 * Monday. Authenticated with CRON_SECRET as a bearer token — see middleware.
 *
 * Order matters: refresh the data, regenerate the report from the refreshed
 * data, then deliver it. If ingestion fails entirely we still produce a report,
 * because "nothing changed and here is why" is itself useful on a Monday.
 */
export const maxDuration = 800;

export async function GET(request: NextRequest) {
  return run(request);
}

export async function POST(request: NextRequest) {
  return run(request);
}

async function run(request: NextRequest) {
  const startedAt = Date.now();
  const errors: string[] = [];
  let ingest = null;

  try {
    ingest = await runIngest({
      trigger: "CRON_WEEKLY",
      // A weekly job only needs the last fortnight; the overlap covers a
      // missed run without re-reading the whole register.
      since: new Date(Date.now() - 14 * 24 * 3600 * 1000),
      snapshot: true,
    });
  } catch (err) {
    errors.push(`Ingest failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let reportId: string | null = null;
  try {
    const report = await generateAndStoreWeeklyReport(new Date());
    reportId = report.id;
  } catch (err) {
    errors.push(`Report generation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let delivery: { delivered: boolean; detail: string } = {
    delivered: false,
    detail: "not attempted",
  };
  if (reportId) {
    try {
      delivery = await deliverWeeklyReport(reportId, new URL(request.url).origin);
    } catch (err) {
      errors.push(`Delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await prisma.systemState.upsert({
    where: { key: "cron.lastWeeklyRun" },
    create: {
      key: "cron.lastWeeklyRun",
      value: { at: new Date().toISOString(), reportId, errors },
    },
    update: { value: { at: new Date().toISOString(), reportId, errors } },
  });

  return NextResponse.json({
    ok: errors.length === 0,
    durationMs: Date.now() - startedAt,
    ingest: ingest
      ? { runId: ingest.runId, status: ingest.status, stats: ingest.stats, warnings: ingest.warnings }
      : null,
    reportId,
    delivery,
    errors,
  });
}
