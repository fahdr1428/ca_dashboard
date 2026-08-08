import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, isPublicPath, verifySessionToken, verifyCronSecret } from "@/lib/auth";

/**
 * Everything is private by default. A route is reachable only with a valid
 * session cookie, or — for the scheduler's endpoints — a bearer cron secret.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) return NextResponse.next();

  if (pathname.startsWith("/api/cron/")) {
    if (verifyCronSecret(request.headers.get("authorization"))) return NextResponse.next();
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  // A misconfigured AUTH_SECRET would throw here on every request, taking the
  // whole app down with an opaque error instead of a diagnosable one.
  let session = null;
  try {
    session = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  } catch {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Server misconfigured: AUTH_SECRET is missing or too short." },
        { status: 500 },
      );
    }
  }
  if (session) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|webp)$).*)"],
};
