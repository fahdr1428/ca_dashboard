import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSessionToken, verifyPassphrase, SESSION_COOKIE } from "@/lib/auth";

const Body = z.object({ passphrase: z.string().min(1).max(256), next: z.string().optional() });

/** Fixed-cost failure delay, so a wrong passphrase can't be probed quickly. */
const FAILURE_DELAY_MS = 600;

export async function POST(request: NextRequest) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const ok = await verifyPassphrase(parsed.data.passphrase);
  if (!ok) {
    await new Promise((r) => setTimeout(r, FAILURE_DELAY_MS));
    return NextResponse.json({ error: "Incorrect passphrase." }, { status: 401 });
  }

  const { value, maxAge } = await createSessionToken();
  const response = NextResponse.json({ ok: true, next: safeNext(parsed.data.next) });
  response.cookies.set(SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  });
  return response;
}

/** Only same-origin paths, so ?next= can't be used as an open redirect. */
function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}
