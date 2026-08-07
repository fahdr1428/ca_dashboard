import { defineConfig, env } from "prisma/config";
import "./src/lib/load-env";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: { url: env("DATABASE_URL") },
  migrations: { seed: "tsx prisma/seed.ts" },
});
