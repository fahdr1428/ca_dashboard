/**
 * Session handling.
 *
 * This dashboard holds personal data about identifiable living people, so it
 * must never be left open. A single shared passphrase plus an HMAC-signed,
 * httpOnly session cookie is the right weight for a one- or two-advisor firm:
 * no user table to leak, no password reset flow to get wrong.
 *
 * If this is ever deployed for a larger team, replace `verifyPassphrase` with a
 * real identity provider — everything else here stays as it is.
 *
 * Web Crypto only, so the same code runs in middleware (edge) and in routes.
 */

const COOKIE_NAME = "wa_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 24) {
    throw new Error(
      "AUTH_SECRET must be set to a random string of at least 24 characters.",
    );
  }
  return s;
}

async function hmac(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64url(new Uint8Array(sig));
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time string comparison, so signature checks can't be timed. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface Session {
  issuedAt: number;
  expiresAt: number;
}

export async function createSessionToken(): Promise<{ value: string; maxAge: number }> {
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ issuedAt: now, expiresAt: now + SESSION_TTL_SECONDS });
  const encoded = base64url(new TextEncoder().encode(payload));
  const sig = await hmac(encoded);
  return { value: `${encoded}.${sig}`, maxAge: SESSION_TTL_SECONDS };
}

export async function verifySessionToken(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  const [encoded, sig] = token.split(".");
  if (!encoded || !sig) return null;

  const expected = await hmac(encoded);
  if (!timingSafeEqual(sig, expected)) return null;

  try {
    const json = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    const session = JSON.parse(json) as Session;
    if (typeof session.expiresAt !== "number") return null;
    if (session.expiresAt < Math.floor(Date.now() / 1000)) return null;
    return session;
  } catch {
    return null;
  }
}

/**
 * Passphrase check. Compares the SHA-256 of the supplied value against the
 * SHA-256 of the configured one, so the comparison is fixed-length and the
 * secret never appears in a timing signal.
 */
export async function verifyPassphrase(supplied: string): Promise<boolean> {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) {
    throw new Error("DASHBOARD_PASSWORD is not set — refusing to authenticate anyone.");
  }
  const [a, b] = await Promise.all([sha256(supplied), sha256(expected)]);
  return timingSafeEqual(a, b);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64url(new Uint8Array(digest));
}

export const SESSION_COOKIE = COOKIE_NAME;

/** Routes reachable without a session. */
export const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/health"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Cron endpoints authenticate with a bearer secret instead of a session, so a
 * scheduler can call them without a browser.
 */
export function verifyCronSecret(header: string | null): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const supplied = header?.replace(/^Bearer\s+/i, "") ?? "";
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
