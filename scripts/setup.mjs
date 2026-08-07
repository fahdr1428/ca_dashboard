/**
 * One-command first-run setup.
 *
 *   npm run setup
 *
 * Creates .env from the example with real generated secrets (never overwriting
 * an existing one), then pushes the schema and loads the demo dataset. Every
 * step is idempotent, so it is safe to re-run.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const step = (msg) => console.log(`\n\x1b[36m▸ ${msg}\x1b[0m`);
const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const warn = (msg) => console.log(`  \x1b[33m!\x1b[0m ${msg}`);

step("Configuration");
if (existsSync(".env")) {
  ok(".env already exists — leaving it alone");
} else {
  if (!existsSync(".env.example")) {
    console.error("  .env.example is missing; cannot generate configuration.");
    process.exit(1);
  }
  const secrets = {
    AUTH_SECRET: randomBytes(36).toString("base64"),
    CRON_SECRET: randomBytes(32).toString("hex"),
    DASHBOARD_PASSWORD: randomBytes(9).toString("base64url"),
  };
  let env = readFileSync(".env.example", "utf8");
  for (const [key, value] of Object.entries(secrets)) {
    env = env.replace(new RegExp(`^${key}=.*$`, "m"), `${key}="${value}"`);
  }
  writeFileSync(".env", env);
  ok("Wrote .env with freshly generated secrets");
  console.log(`\n  \x1b[1mYour sign-in passphrase: ${secrets.DASHBOARD_PASSWORD}\x1b[0m`);
  console.log("  (change DASHBOARD_PASSWORD in .env to something memorable if you prefer)\n");
}

step("Prisma client");
run("npx prisma generate");
ok("Generated");

step("Database schema");
try {
  run("npx prisma db push");
  ok("Schema applied");
} catch {
  warn("Could not reach the database.");
  console.log("  Start one with:  docker compose up -d");
  console.log("  Or point DATABASE_URL in .env at your own PostgreSQL instance.");
  console.log("  Then re-run:     npm run setup");
  process.exit(1);
}

step("Demo data");
run("npx tsx prisma/seed.ts");

console.log("\n\x1b[32mReady.\x1b[0m Start the dashboard with:  npm run dev\n");
console.log("The dataset is fictional demonstration data. To collect real records,");
console.log("set COMPANIES_HOUSE_API_KEY in .env and run an ingest from the");
console.log("Automation page. A key is free from:");
console.log("  https://developer.company-information.service.gov.uk/\n");

function run(cmd) {
  execSync(cmd, { stdio: ["ignore", "inherit", "inherit"] });
}
