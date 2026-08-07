"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, ShieldOff, Check } from "lucide-react";
import { Card, CardHeader, STATUS_LABELS, STAGE_LABELS } from "./ui";
import { formatRelative, cn } from "@/lib/utils";
import type { LeadStatus, RelationshipStage } from "@/generated/prisma/enums";

/** Advisor-facing workflow controls: status, stage, owner, notes, suppression. */
export function ProspectWorkflow({
  prospectId,
  status,
  relationshipStage,
  owner,
  suppressedAt,
  notes,
}: {
  prospectId: string;
  status: LeadStatus;
  relationshipStage: RelationshipStage;
  owner: string | null;
  suppressedAt: string | null;
  notes: Array<{ id: string; body: string; author: string | null; createdAt: string }>;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  async function patch(body: Record<string, unknown>, key: string) {
    setPending(key);
    setError(null);
    try {
      const res = await fetch(`/api/prospects/${prospectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Update failed.");
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setPending(null);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Pipeline"
        action={
          saved ? (
            <span className="flex items-center gap-1 text-[11px] text-accent">
              <Check className="size-3" /> Saved
            </span>
          ) : null
        }
      />
      <div className="px-5 pb-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-ink-3">Lead status</span>
            <select
              value={status}
              disabled={pending === "status"}
              onChange={(e) => patch({ status: e.target.value }, "status")}
              className="mt-1 w-full rounded-lg border border-line bg-canvas px-2 py-1.5 text-[13px] outline-none focus:border-accent"
            >
              {(Object.keys(STATUS_LABELS) as LeadStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-ink-3">
              Relationship stage
            </span>
            <select
              value={relationshipStage}
              disabled={pending === "stage"}
              onChange={(e) => patch({ relationshipStage: e.target.value }, "stage")}
              className="mt-1 w-full rounded-lg border border-line bg-canvas px-2 py-1.5 text-[13px] outline-none focus:border-accent"
            >
              {(Object.keys(STAGE_LABELS) as RelationshipStage[]).map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-ink-3">Owner</span>
          <input
            defaultValue={owner ?? ""}
            placeholder="Advisor initials"
            onBlur={(e) => {
              if (e.target.value !== (owner ?? "")) patch({ owner: e.target.value || null }, "owner");
            }}
            className="mt-1 w-full rounded-lg border border-line bg-canvas px-2 py-1.5 text-[13px] outline-none focus:border-accent"
          />
        </label>

        <div>
          <span className="text-[11px] uppercase tracking-wide text-ink-3">Notes</span>
          <div className="mt-1 space-y-2">
            {notes.map((n) => (
              <div key={n.id} className="rounded-lg border border-line bg-canvas p-2.5">
                <p className="text-[12px] leading-relaxed">{n.body}</p>
                <div className="mt-1 text-[10px] text-ink-3">
                  {n.author ?? "advisor"} · {formatRelative(n.createdAt)}
                </div>
              </div>
            ))}
            {notes.length === 0 && (
              <p className="text-[12px] text-ink-3">No notes yet.</p>
            )}
          </div>

          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Add a research note or a record of contact…"
            className="mt-2 w-full rounded-lg border border-line bg-canvas px-2 py-1.5 text-[13px] outline-none focus:border-accent resize-y"
          />
          <button
            disabled={!note.trim() || pending === "note"}
            onClick={async () => {
              await patch({ note: note.trim() }, "note");
              setNote("");
            }}
            className="mt-1.5 flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-[12px] font-medium text-surface disabled:opacity-40"
          >
            {pending === "note" && <Loader2 className="size-3 animate-spin" />}
            Add note
          </button>
        </div>

        {error && <p className="text-[12px] text-danger">{error}</p>}

        <div className="border-t border-line pt-3">
          <button
            onClick={() => {
              const reason = suppressedAt
                ? undefined
                : window.prompt(
                    "Record the reason for suppressing this record (e.g. the individual objected to being tracked). This stops all future automated updates.",
                  );
              if (!suppressedAt && !reason) return;
              patch(
                { suppress: !suppressedAt, suppressionReason: reason ?? undefined },
                "suppress",
              );
            }}
            className={cn(
              "flex items-center gap-1.5 text-[12px] font-medium",
              suppressedAt ? "text-accent" : "text-danger hover:underline",
            )}
          >
            <ShieldOff className="size-3.5" />
            {suppressedAt ? "Lift suppression" : "Suppress tracking (objection)"}
          </button>
          <p className="mt-1 text-[10px] text-ink-3 leading-relaxed">
            Suppression stops ingestion updating this person and removes them from the pipeline
            totals. Use it when an individual objects to being profiled under UK GDPR Article 21.
          </p>
        </div>
      </div>
    </Card>
  );
}
