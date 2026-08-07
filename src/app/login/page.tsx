"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ShieldCheck, Loader2 } from "lucide-react";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [passphrase, setPassphrase] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase, next: params.get("next") ?? "/" }),
      });
      const data = (await res.json()) as { error?: string; next?: string };
      if (!res.ok) {
        setError(data.error ?? "Sign-in failed.");
        setPending(false);
        return;
      }
      router.push(data.next ?? "/");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
      setPending(false);
    }
  }

  return (
    <main className="min-h-dvh grid place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5 mb-6">
          <div className="size-9 rounded-lg bg-accent grid place-items-center">
            <span className="text-xs font-bold text-surface">LI</span>
          </div>
          <div>
            <h1 className="text-[15px] font-semibold leading-tight">Lead Intelligence</h1>
            <p className="text-[11px] text-ink-3 leading-tight">Private wealth · South England</p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="bg-surface border border-line rounded-xl p-5">
          <label htmlFor="passphrase" className="block text-[13px] font-medium mb-1.5">
            Passphrase
          </label>
          <input
            id="passphrase"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent"
            placeholder="Enter the shared passphrase"
          />

          {error && (
            <p role="alert" className="mt-2.5 text-[12px] text-danger">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={pending || !passphrase}
            className="mt-4 w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-surface disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {pending && <Loader2 className="size-4 animate-spin" />}
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div className="mt-4 flex gap-2 text-[11px] text-ink-3 leading-relaxed">
          <ShieldCheck className="size-4 shrink-0 mt-0.5" strokeWidth={1.8} />
          <p>
            This dashboard holds personal data about identifiable living people, collected from
            public sources. Access is restricted and use is subject to your firm&apos;s UK GDPR
            obligations.
          </p>
        </div>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <React.Suspense>
      <LoginForm />
    </React.Suspense>
  );
}
