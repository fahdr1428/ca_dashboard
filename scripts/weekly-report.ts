/**
 * Generate (and optionally deliver) the weekly report from the command line.
 *
 *   npm run report:weekly
 *   npm run report:weekly -- --deliver --origin https://leads.example.com
 */
import "../src/lib/load-env";
import { prisma } from "../src/lib/db";
import { generateAndStoreWeeklyReport } from "../src/lib/report/weekly";
import { deliverWeeklyReport } from "../src/lib/report/deliver";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const report = await generateAndStoreWeeklyReport(new Date());
  console.log(`Report ${report.id} for week starting ${report.weekStart.toISOString().slice(0, 10)}`);
  console.log(`  ${report.newProspectCount} new · ${report.updatedProspectCount} updated · ${report.newSignalCount} signals`);
  console.log("\n" + report.summaryMd);

  if (process.argv.includes("--deliver")) {
    const origin = arg("origin") ?? "http://localhost:3000";
    const result = await deliverWeeklyReport(report.id, origin);
    console.log(`\nDelivery: ${result.delivered ? "sent" : "not sent"} — ${result.detail}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
