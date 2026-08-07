import { defineConfig } from "prisma/config";
import "./src/lib/load-env";

/**
 * `DATABASE_URL` is read leniently rather than through prisma's `env()` helper,
 * which throws at config-load time when the variable is missing. That would
 * break `prisma generate` on a fresh clone — before `.env` exists — and
 * generate does not need a database at all. Commands that do need one still
 * fail, but only when they are actually run.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: { url: process.env.DATABASE_URL ?? "" },
  migrations: { seed: "tsx prisma/seed.ts" },
});
