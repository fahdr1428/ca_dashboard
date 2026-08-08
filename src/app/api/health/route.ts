import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * Liveness and configuration probe.
 *
 * Reports *whether* each piece of configuration is present, never its value, so
 * it is safe to leave unauthenticated. This is what makes a fresh deployment
 * diagnosable: without it, a missing DATABASE_URL just produces opaque 500s.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const configured = {
    database: Boolean(process.env.DATABASE_URL),
    authSecret: Boolean(process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 24),
    dashboardPassword: Boolean(process.env.DASHBOARD_PASSWORD),
    cronSecret: Boolean(process.env.CRON_SECRET),
    companiesHouseKey: Boolean(process.env.COMPANIES_HOUSE_API_KEY),
    newsConnector: process.env.ENABLE_NEWS_CONNECTOR !== "false",
    reportDelivery: Boolean(
      process.env.REPORT_WEBHOOK_URL ||
        (process.env.RESEND_API_KEY && process.env.REPORT_EMAIL_TO),
    ),
  };

  let database: { reachable: boolean; migrated: boolean; error?: string };
  try {
    await prisma.$queryRaw`SELECT 1`;
    // A reachable database with no tables means the schema was never pushed —
    // a different problem with a different fix, so report it separately.
    try {
      await prisma.prospect.count();
      database = { reachable: true, migrated: true };
    } catch {
      database = { reachable: true, migrated: false };
    }
  } catch (err) {
    database = {
      reachable: false,
      migrated: false,
      error: err instanceof Error ? describeDbError(err) : "unknown",
    };
  }

  const ready = configured.database && configured.authSecret && configured.dashboardPassword && database.migrated;

  return NextResponse.json(
    { status: ready ? "ok" : "needs-setup", configured, database },
    { status: ready ? 200 : 503 },
  );
}

/**
 * Prisma wraps the real cause several lines deep behind a generic
 * "Invalid invocation" header, so surface the line that actually explains the
 * failure. That difference is what turns a 20-minute debugging session into a
 * 20-second one.
 */
const CAUSE_PATTERNS = [
  /can'?t reach database server/i,
  /authentication failed/i,
  /does not exist/i,
  /ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i,
  /timed out/i,
  /too many connections/i,
  /SSL|TLS/i,
];

function describeDbError(err: Error): string {
  const lines = err.message
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const cause = lines.find((l) => CAUSE_PATTERNS.some((p) => p.test(l)));
  const code = (err as { code?: string }).code;
  const detail = cause ?? lines[lines.length - 1] ?? err.name;
  return (code ? `${code}: ${detail}` : detail).slice(0, 240);
}
