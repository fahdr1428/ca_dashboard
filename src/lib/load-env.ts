/**
 * Minimal .env loader for contexts Next.js doesn't bootstrap (Prisma CLI, tsx
 * scripts, cron workers). Next.js loads .env itself, so this is a no-op there.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function load(file: string) {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

load(".env.local");
load(".env");
