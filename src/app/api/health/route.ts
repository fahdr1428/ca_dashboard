import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/** Liveness probe. Deliberately leaks nothing beyond reachability. */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", database: "reachable" });
  } catch {
    return NextResponse.json({ status: "degraded", database: "unreachable" }, { status: 503 });
  }
}
