/**
 * Run a collection pass from the command line.
 *
 *   npm run ingest                      # all available connectors, last 30 days
 *   npm run ingest -- --only companies-house
 *   npm run ingest -- --since 90 --snapshot
 */
import "../src/lib/load-env";
import { prisma } from "../src/lib/db";
import { runIngest } from "../src/lib/ingest/pipeline";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const only = arg("only")?.split(",").map((s) => s.trim());
  const sinceDays = Number(arg("since") ?? 30);
  const snapshot = process.argv.includes("--snapshot");

  const summary = await runIngest({
    trigger: "MANUAL",
    only,
    since: new Date(Date.now() - sinceDays * 24 * 3600 * 1000),
    snapshot,
  });

  console.log(`\nRun ${summary.runId} — ${summary.status} in ${(summary.durationMs / 1000).toFixed(1)}s`);
  console.log(`Connectors run: ${summary.connectorsRun.join(", ") || "none"}`);
  for (const s of summary.connectorsSkipped) console.log(`  skipped ${s.key}: ${s.reason}`);
  console.log("\nStats:");
  for (const [k, v] of Object.entries(summary.stats)) console.log(`  ${k.padEnd(22)} ${v}`);
  if (summary.log.length) {
    console.log("\nLog:");
    for (const l of summary.log) console.log(`  ${l}`);
  }
  if (summary.warnings.length) {
    console.log("\nWarnings:");
    for (const w of summary.warnings) console.log(`  ${w}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
