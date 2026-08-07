import { AppShell } from "@/components/app-shell";
import { prisma } from "@/lib/db";
import { formatRelative } from "@/lib/utils";

/**
 * Shell for every authenticated route. Login sits outside this group so it
 * renders without navigation.
 */
async function getShellState() {
  // This runs on every route, so it must not throw when the database is
  // unreachable — a missing banner beats a broken app.
  try {
    const [mode, lastRun] = await Promise.all([
      prisma.systemState.findUnique({ where: { key: "dataset.mode" } }),
      prisma.ingestRun.findFirst({
        where: { status: { in: ["SUCCESS", "PARTIAL"] } },
        orderBy: { startedAt: "desc" },
        select: { finishedAt: true, startedAt: true },
      }),
    ]);
    const value = mode?.value as { mode?: string } | null;
    return {
      demoMode: value?.mode === "demo",
      lastRunAt: lastRun ? formatRelative(lastRun.finishedAt ?? lastRun.startedAt) : null,
    };
  } catch {
    return { demoMode: false, lastRunAt: null };
  }
}

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { demoMode, lastRunAt } = await getShellState();
  return (
    <AppShell demoMode={demoMode} lastRunAt={lastRunAt}>
      {children}
    </AppShell>
  );
}
