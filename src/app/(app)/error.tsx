"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, XCircle, RefreshCw } from "lucide-react";

/**
 * Error boundary for the authenticated app.
 *
 * The overwhelmingly likely cause of a page failing on a fresh deployment is
 * missing configuration — no DATABASE_URL, or a database that was never
 * migrated. An opaque "something went wrong" wastes the reader's time, so this
 * asks the health endpoint what is actually missing and says so.
 */

interface Health {
  status: string;
  configured: Record<string, boolean>;
  database: { reachable: boolean; migrated: boolean; error?: string };
}

const LABELS: Record<string, string> = {
  database: "DATABASE_URL",
  authSecret: "AUTH_SECRET (24+ characters)",
  dashboardPassword: "DASHBOARD_PASSWORD",
  cronSecret: "CRON_SECRET",
  companiesHouseKey: "COMPANIES_HOUSE_API_KEY (optional — enables live data)",
  newsConnector: "News connector enabled",
  reportDelivery: "Report delivery (optional)",
};

const OPTIONAL = new Set(["companiesHouseKey", "newsConnector", "reportDelivery", "cronSecret"]);

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [health, setHealth] = React.useState<Health | null>(null);
  const [checked, setChecked] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((h: Health) => setHealth(h))
      .catch(() => setHealth(null))
      .finally(() => setChecked(true));
  }, []);

  const setupProblem = health && health.status !== "ok";

  return (
    <div className="px-5 py-10 max-w-2xl">
      <div className="flex items-start gap-3">
        <AlertTriangle className="size-5 text-signal shrink-0 mt-0.5" />
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">
            {setupProblem ? "This deployment needs configuring" : "Something went wrong"}
          </h1>
          <p className="mt-1 text-[13px] text-ink-2 leading-relaxed">
            {setupProblem
              ? "The app is running, but it can't reach a usable database yet. Everything below marked with a cross needs setting in your environment variables."
              : "The page failed to render. The details below may help."}
          </p>
        </div>
      </div>

      {checked && health && (
        <div className="mt-5 rounded-xl border border-line bg-surface p-4">
          <h2 className="text-[13px] font-semibold mb-2.5">Configuration</h2>
          <ul className="space-y-1.5">
            {Object.entries(health.configured).map(([key, present]) => (
              <li key={key} className="flex items-center gap-2 text-[12px]">
                {present ? (
                  <CheckCircle2 className="size-3.5 text-positive shrink-0" />
                ) : (
                  <XCircle
                    className={`size-3.5 shrink-0 ${OPTIONAL.has(key) ? "text-ink-3" : "text-danger"}`}
                  />
                )}
                <code className="font-mono">{LABELS[key] ?? key}</code>
                {!present && OPTIONAL.has(key) && (
                  <span className="text-ink-3">— not required to start</span>
                )}
              </li>
            ))}
          </ul>

          <h2 className="text-[13px] font-semibold mt-4 mb-2.5">Database</h2>
          <ul className="space-y-1.5 text-[12px]">
            <li className="flex items-center gap-2">
              {health.database.reachable ? (
                <CheckCircle2 className="size-3.5 text-positive shrink-0" />
              ) : (
                <XCircle className="size-3.5 text-danger shrink-0" />
              )}
              Reachable
            </li>
            <li className="flex items-center gap-2">
              {health.database.migrated ? (
                <CheckCircle2 className="size-3.5 text-positive shrink-0" />
              ) : (
                <XCircle className="size-3.5 text-danger shrink-0" />
              )}
              Schema applied
              {health.database.reachable && !health.database.migrated && (
                <span className="text-ink-3">
                  — run <code className="font-mono">npx prisma db push</code> against it
                </span>
              )}
            </li>
          </ul>
          {health.database.error && (
            <p className="mt-2 text-[11px] text-danger font-mono break-words">
              {health.database.error}
            </p>
          )}
        </div>
      )}

      {setupProblem && (
        <div className="mt-4 rounded-xl border border-line bg-canvas p-4 text-[12px] leading-relaxed text-ink-2">
          <p className="font-semibold text-ink mb-1.5">To finish setting this up</p>
          <ol className="space-y-1.5 pl-4 list-decimal marker:text-ink-3">
            <li>
              Create a PostgreSQL database. Any provider works — Neon, Supabase and Vercel Postgres
              all have a free tier.
            </li>
            <li>
              Add its connection string as <code className="font-mono">DATABASE_URL</code> in your
              deployment&apos;s environment variables.
            </li>
            <li>
              Apply the schema:{" "}
              <code className="font-mono">DATABASE_URL=&quot;…&quot; npx prisma db push</code> from a
              local checkout.
            </li>
            <li>
              Optionally seed the demo data with <code className="font-mono">npm run db:seed</code>,
              or go straight to live data by setting{" "}
              <code className="font-mono">COMPANIES_HOUSE_API_KEY</code> and running an ingest.
            </li>
            <li>Redeploy, or just reload this page.</li>
          </ol>
        </div>
      )}

      <div className="mt-5 flex items-center gap-2">
        <button
          onClick={reset}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-surface"
        >
          <RefreshCw className="size-3.5" />
          Try again
        </button>
        <a
          href="/api/health"
          className="rounded-lg border border-line px-3 py-1.5 text-[13px] font-medium text-ink-2 hover:bg-surface-2"
        >
          Raw health check
        </a>
      </div>

      {!setupProblem && error.message && (
        <details className="mt-5">
          <summary className="cursor-pointer text-[12px] text-ink-3">Error detail</summary>
          <pre className="mt-2 overflow-x-auto rounded-lg border border-line bg-canvas p-3 text-[11px] font-mono whitespace-pre-wrap">
            {error.message}
            {error.digest && `\n\ndigest: ${error.digest}`}
          </pre>
        </details>
      )}
    </div>
  );
}
