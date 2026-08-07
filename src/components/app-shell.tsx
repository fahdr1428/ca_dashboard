"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  Building2,
  Radar,
  FileText,
  Cog,
  BookOpen,
  Moon,
  Sun,
  Menu,
  X,
  LogOut,
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/prospects", label: "Lead tracker", icon: Users },
  { href: "/companies", label: "Companies", icon: Building2 },
  { href: "/signals", label: "Wealth signals", icon: Radar },
  { href: "/reports", label: "Weekly reports", icon: FileText },
  { href: "/automation", label: "Automation", icon: Cog },
  { href: "/methodology", label: "Methodology", icon: BookOpen },
];

export function AppShell({
  children,
  demoMode,
  lastRunAt,
}: {
  children: React.ReactNode;
  demoMode: boolean;
  lastRunAt: string | null;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = React.useState(false);

  React.useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <div className="min-h-dvh flex">
      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-60 shrink-0 border-r border-line bg-surface flex flex-col",
          "transition-transform duration-200 lg:translate-x-0 lg:static",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center gap-2.5 px-4 h-14 border-b border-line">
          <div className="size-7 rounded-md bg-accent grid place-items-center shrink-0">
            <span className="text-[11px] font-bold text-surface">LI</span>
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold leading-tight truncate">Lead Intelligence</div>
            <div className="text-[10px] text-ink-3 leading-tight truncate">Private wealth · South England</div>
          </div>
          <button
            className="ml-auto lg:hidden text-ink-3 hover:text-ink"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          >
            <X className="size-4" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-2 scroll-thin">
          {NAV.map((item) => {
            const active = item.exact
              ? pathname === item.href
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors",
                  active
                    ? "bg-accent-soft text-accent-ink"
                    : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                )}
              >
                <Icon className="size-4 shrink-0" strokeWidth={active ? 2.2 : 1.8} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-line p-2 space-y-1">
          <div className="px-2.5 py-1.5 text-[10px] text-ink-3 leading-relaxed">
            {lastRunAt ? `Last refresh ${lastRunAt}` : "No automated run recorded yet"}
          </div>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <form action="/api/auth/logout" method="post" className="flex-1">
              <button
                type="submit"
                className="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
              >
                <LogOut className="size-4" strokeWidth={1.8} />
                Sign out
              </button>
            </form>
          </div>
        </div>
      </aside>

      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="lg:hidden sticky top-0 z-20 flex items-center gap-3 h-14 px-4 border-b border-line bg-surface">
          <button onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <Menu className="size-5" />
          </button>
          <span className="text-sm font-semibold">Lead Intelligence</span>
        </header>

        {demoMode && <DemoBanner />}

        <main className="flex-1 min-w-0">{children}</main>

        <footer className="border-t border-line px-5 py-4 text-[11px] leading-relaxed text-ink-3 no-print">
          <p className="max-w-4xl">
            All wealth figures shown are <strong className="text-ink-2">modelled estimates</strong> derived
            from publicly available sources, principally the Companies House register. They are not
            verified statements of any individual&apos;s wealth and must not be presented to a client as
            fact. Companies House data is used under the Open Government Licence v3.0. Boundary data
            © Crown copyright and database right.
          </p>
        </footer>
      </div>
    </div>
  );
}

function DemoBanner() {
  return (
    <div className="border-b border-line bg-signal-soft px-5 py-2 no-print">
      <p className="text-[11px] text-signal leading-relaxed">
        <strong>Demonstration data.</strong> Every person and company shown is fictional. Set{" "}
        <code className="font-mono text-[10px]">COMPANIES_HOUSE_API_KEY</code> and run an ingest from
        the Automation page to replace it with live public-register data.
      </p>
    </div>
  );
}

function ThemeToggle() {
  const [dark, setDark] = React.useState(false);

  React.useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      /* private browsing — the class still applies for this session */
    }
  }

  return (
    <button
      onClick={toggle}
      className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {dark ? <Sun className="size-4" strokeWidth={1.8} /> : <Moon className="size-4" strokeWidth={1.8} />}
    </button>
  );
}

/** Page heading used across every route for a consistent rhythm. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 px-5 pt-6 pb-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && (
          <p className="mt-1 text-[13px] text-ink-3 leading-relaxed max-w-3xl">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 no-print">{actions}</div>}
    </div>
  );
}
