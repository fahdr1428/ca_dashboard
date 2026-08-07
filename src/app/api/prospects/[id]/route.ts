import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma, serialise } from "@/lib/db";
import { recomputeProspect } from "@/lib/scoring/recompute";

const Patch = z.object({
  status: z
    .enum([
      "NEW", "RESEARCHING", "QUALIFIED", "CONTACTED", "MEETING_BOOKED",
      "IN_DISCUSSION", "CLIENT", "NURTURE", "DISQUALIFIED",
    ])
    .optional(),
  relationshipStage: z
    .enum(["UNAWARE", "AWARE", "INTRODUCED", "ENGAGED", "PROPOSAL", "ONBOARDING", "CLIENT", "LAPSED"])
    .optional(),
  owner: z.string().max(24).nullable().optional(),
  note: z.string().min(1).max(4000).optional(),
  /** Records an Art.21 objection: stops all future ingestion for this person. */
  suppress: z.boolean().optional(),
  suppressionReason: z.string().max(500).optional(),
  recompute: z.boolean().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const parsed = Patch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", detail: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;

  const existing = await prisma.prospect.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  const events: Array<{ type: string; message: string; before?: object; after?: object }> = [];

  if (body.status && body.status !== existing.status) {
    data.status = body.status;
    events.push({
      type: "status_changed",
      message: `Lead status changed from ${existing.status} to ${body.status}.`,
      before: { status: existing.status },
      after: { status: body.status },
    });
  }
  if (body.relationshipStage && body.relationshipStage !== existing.relationshipStage) {
    data.relationshipStage = body.relationshipStage;
    events.push({
      type: "stage_changed",
      message: `Relationship stage changed from ${existing.relationshipStage} to ${body.relationshipStage}.`,
      before: { relationshipStage: existing.relationshipStage },
      after: { relationshipStage: body.relationshipStage },
    });
  }
  if (body.owner !== undefined) data.owner = body.owner;

  if (body.suppress !== undefined) {
    data.suppressedAt = body.suppress ? new Date() : null;
    data.suppressionReason = body.suppress ? (body.suppressionReason ?? "Objection recorded") : null;
    events.push({
      type: body.suppress ? "suppressed" : "unsuppressed",
      message: body.suppress
        ? `Tracking suppressed: ${body.suppressionReason ?? "objection recorded"}. Ingestion will no longer update this record.`
        : "Tracking suppression lifted.",
    });
  }

  if (Object.keys(data).length) {
    data.lastReviewedAt = new Date();
    await prisma.prospect.update({ where: { id }, data });
  }

  if (body.note) {
    await prisma.note.create({ data: { prospectId: id, body: body.note, author: existing.owner ?? "advisor" } });
    events.push({ type: "note_added", message: "Advisor note added." });
  }

  for (const e of events) {
    await prisma.prospectEvent.create({
      data: {
        prospectId: id,
        type: e.type,
        message: e.message,
        before: e.before,
        after: e.after,
        actor: "advisor",
      },
    });
  }

  if (body.recompute) await recomputeProspect(id);

  const updated = await prisma.prospect.findUnique({
    where: { id },
    include: { notes: { orderBy: { createdAt: "desc" } } },
  });
  return NextResponse.json(serialise({ ok: true, prospect: updated }));
}
