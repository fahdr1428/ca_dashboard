"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play, FileText } from "lucide-react";
import { Card, CardHeader, Badge } from "./ui";
import { cn } from "@/lib/utils";

interface IngestSummary {
  runId: string;
  status: string;
  connectorsRun: string[];
  connectorsSkipped: Array<{ key: string; reason: string }>;
  stats: Record<string, number>;
  warnings: string[];
  log: string[];
  durationMs: number;
}

/** Manual refresh, for when an advisor doesn't want to wait until Monday. */
export function IngestControls({
  connectors,
}: {
  connectors: Array<{ key: string; label: string; available: boolean }>;
}) {
  const router = useRouter();
  const [running, setRunning] = React.useState(false);
  const [regenerating, setRegenerating] = React.useState(false);
  const [selected, setSelected] = React.useState<string[]>(
    connectors.filter((c) => c.available).map((c) => c.key),
  );
  const [result, setResult] = React.useState<IngestSummary | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function runNow() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/ingest/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ only: selected, sinceDays: 30 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError((data as { error?: string }).error ?? "Ingest failed.");
        return;
      }
      setResult(data as IngestSummary);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setRunning(false);
    }
  }

  async function regenerateReport() {
    setRegenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/reports/weekly", { method: "POST" });
      if (!res.ok) {
        setError("Report generation failed.");
        return;
      }
      router.refresh();
      router.push("/reports");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setRegenerating(false);
    }
  }

  const availableConnectors = connectors.filter((c) => c.available);

  return (
    <Card>
      <CardHeader
        title="Run now"
        subtitle="Collects from the selected sources, re-runs the wealth and confidence models, and records the run."
      />
      <div className="px-5 pb-4 space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {availableConnectors.map((c) => {
            const on = selected.includes(c.key);
            return (
              <button
                key={c.key}
                onClick={() =>
                  setSelected((s) => (on ? s.filter((k) => k !== c.key) : [...s, c.key]))
                }
                className={cn(
                  "rounded-md border px-2 py-0.5 text-[11px] font-medium",
                  on
                    ? "border-accent bg-accent-soft text-accent-ink"
                    : "border-line text-ink-2 hover:bg-surface-2",
                )}
              >
                {c.label}
              </button>
            );
          })}
          {availableConnectors.length === 0 && (
            <p className="text-[12px] text-ink-3">
              No connectors are configured. Add a Companies House API key to enable live collection.
            </p>
          )}
        </div>

        <div className="flex gap-2">
          <button
            onClick={runNow}
            disabled={running || selected.length === 0}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-surface disabled:opacity-40"
          >
            {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            {running ? "Collecting…" : "Run ingest"}
          </button>
          <button
            onClick={regenerateReport}
            disabled={regenerating}
            className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-40"
          >
            {regenerating ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <FileText className="size-3.5" />
            )}
            Regenerate this week&apos;s report
          </button>
        </div>

        {error && <p className="text-[12px] text-danger">{error}</p>}

        {result && (
          <div className="rounded-lg border border-line bg-canvas p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Badge tone={result.status === "SUCCESS" ? "accent" : "signal"}>
                {result.status}
              </Badge>
              <span className="text-[11px] text-ink-3">
                {(result.durationMs / 1000).toFixed(1)}s
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
              {Object.entries(result.stats).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2">
                  <span className="text-ink-3">{humanKey(k)}</span>
                  <span className="tabular font-medium">{v}</span>
                </div>
              ))}
            </div>
            {result.connectorsSkipped.length > 0 && (
              <div className="text-[11px] text-ink-3 space-y-0.5">
                {result.connectorsSkipped.map((s) => (
                  <div key={s.key}>
                    <strong>{s.key}</strong> skipped — {s.reason}
                  </div>
                ))}
              </div>
            )}
            {result.warnings.length > 0 && (
              <details className="text-[11px]">
                <summary className="cursor-pointer text-signal">
                  {result.warnings.length} warning(s)
                </summary>
                <ul className="mt-1 space-y-0.5 text-ink-3">
                  {result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </details>
            )}
            {result.log.length > 0 && (
              <details className="text-[11px]">
                <summary className="cursor-pointer text-ink-3">Log</summary>
                <pre className="mt-1 whitespace-pre-wrap text-ink-3 font-mono text-[10px]">
                  {result.log.join("\n")}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function humanKey(k: string): string {
  return k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}
