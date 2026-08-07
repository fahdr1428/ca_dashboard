import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { runIngest } from "@/lib/ingest/pipeline";

/** Manual refresh, triggered from the Automation page. */
const Body = z.object({
  only: z.array(z.string()).optional(),
  sinceDays: z.number().int().min(1).max(365).optional(),
  snapshot: z.boolean().optional(),
});

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { only, sinceDays, snapshot } = parsed.data;

  try {
    const summary = await runIngest({
      trigger: "MANUAL",
      only,
      since: sinceDays ? new Date(Date.now() - sinceDays * 24 * 3600 * 1000) : null,
      snapshot: snapshot ?? false,
    });
    return NextResponse.json(summary);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Ingest failed" },
      { status: 500 },
    );
  }
}
