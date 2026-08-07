import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and point it at your PostgreSQL instance.",
    );
  }
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * Prisma returns BigInt for money columns, which `JSON.stringify` refuses to
 * serialise. Every API route funnels through this so the wire format is plain
 * numbers — safe here because GBP amounts are far below Number.MAX_SAFE_INTEGER.
 */
export function serialise<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v)),
  ) as T;
}

export function toBigInt(n: number | null | undefined): bigint {
  if (n === null || n === undefined || !Number.isFinite(n)) return 0n;
  return BigInt(Math.round(n));
}
