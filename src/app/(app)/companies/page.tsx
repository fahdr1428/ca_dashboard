import Link from "next/link";
import { PageHeader } from "@/components/app-shell";
import { Card, Meter, EmptyState } from "@/components/ui";
import { prisma } from "@/lib/db";
import { REGION_META } from "@/lib/regions";
import { formatPct } from "@/lib/wealth";
import { formatDate } from "@/lib/utils";
import { revenueCagr, pretaxMargin } from "@/lib/scoring/valuation";
import { gradeCompanyFacts, summariseVerification } from "@/lib/verification";
import { Fact, VerificationBadge } from "@/components/fact";

export const dynamic = "force-dynamic";

export default async function CompaniesPage() {
  const companies = await prisma.company.findMany({
    include: {
      financials: { orderBy: { periodEnd: "desc" }, take: 6 },
      prospects: { select: { slug: true, fullName: true } },
      shareholdings: { select: { ownershipPctLow: true, ownershipPctHigh: true } },
      _count: { select: { fundingRounds: true, corporateEvents: true, signals: true } },
    },
    orderBy: { estValuationMidGBP: "desc" },
  });

  const rows = companies.map((c) => {
    const periods = c.financials.map((f) => ({
      periodEnd: f.periodEnd,
      revenueGBP: f.revenueGBP === null ? null : Number(f.revenueGBP),
      ebitdaGBP: f.ebitdaGBP === null ? null : Number(f.ebitdaGBP),
      pretaxProfitGBP: f.pretaxProfitGBP === null ? null : Number(f.pretaxProfitGBP),
      netAssetsGBP: f.netAssetsGBP === null ? null : Number(f.netAssetsGBP),
      cashGBP: f.cashGBP === null ? null : Number(f.cashGBP),
      isAbridged: f.isAbridged,
    }));
    const latest = c.financials[0];
    const facts = gradeCompanyFacts({
      companyNumber: c.companyNumber,
      latestPeriodEnd: latest?.periodEnd ?? null,
      isAbridged: latest?.isAbridged ?? false,
      hasAnyAccounts: c.financials.length > 0,
      revenueGBP: latest?.revenueGBP ? Number(latest.revenueGBP) : null,
      pretaxProfitGBP: latest?.pretaxProfitGBP ? Number(latest.pretaxProfitGBP) : null,
      netAssetsGBP: latest?.netAssetsGBP ? Number(latest.netAssetsGBP) : null,
      cashGBP: latest?.cashGBP ? Number(latest.cashGBP) : null,
      dividendsGBP: latest?.dividendsDeclaredGBP ? Number(latest.dividendsDeclaredGBP) : null,
      valuationMidGBP: Number(c.estValuationMidGBP ?? 0n),
      valuationMethod: c.valuationMethod,
      // A priced round means the valuation rests on a real transaction rather
      // than a sector multiple, which materially raises its confidence.
      valuationBasisIsTransaction: c._count.fundingRounds > 0,
    });
    return {
      id: c.id,
      facts,
      verification: summariseVerification(facts),
      slug: c.slug,
      name: c.name,
      companyNumber: c.companyNumber,
      industry: c.industry,
      regionLabel: c.region ? REGION_META[c.region].label : "—",
      officeLocation: c.officeLocation,
      valuationMidGBP: Number(c.estValuationMidGBP ?? 0n),
      valuationMethod: c.valuationMethod,
      revenueGBP: latest?.revenueGBP ? Number(latest.revenueGBP) : null,
      profitGBP: latest?.pretaxProfitGBP ? Number(latest.pretaxProfitGBP) : null,
      dividendsGBP: latest?.dividendsDeclaredGBP ? Number(latest.dividendsDeclaredGBP) : null,
      periodEnd: latest?.periodEnd ?? null,
      isAbridged: latest?.isAbridged ?? false,
      cagrPct: revenueCagr(periods),
      marginPct: pretaxMargin(periods[0]),
      exitPotential: c.exitPotential ?? 0,
      owners: c.prospects,
      events: c._count.corporateEvents + c._count.fundingRounds,
    };
  });

  return (
    <>
      <PageHeader
        title="Companies"
        description="The businesses behind the prospects. Figures marked with a green tick are read straight from filed accounts; anything modelled is labelled, and anything not on the public record says so and why."
      />
      <div className="px-5 pb-8">
        <Card className="overflow-hidden">
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3">
                  <th className="px-4 py-2.5 font-medium">Company</th>
                  <th className="px-3 py-2.5 font-medium">Industry</th>
                  <th className="px-3 py-2.5 font-medium">County</th>
                  <th className="px-3 py-2.5 font-medium text-right">Est. valuation</th>
                  <th className="px-3 py-2.5 font-medium text-right">Turnover</th>
                  <th className="px-3 py-2.5 font-medium text-right">Pre-tax profit</th>
                  <th className="px-3 py-2.5 font-medium text-right">Dividends</th>
                  <th className="px-3 py-2.5 font-medium text-right">CAGR</th>
                  <th className="px-3 py-2.5 font-medium">Verification</th>
                  <th className="px-3 py-2.5 font-medium">Exit potential</th>
                  <th className="px-4 py-2.5 font-medium">Tracked owner</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                    <td className="px-4 py-2.5">
                      <Link href={`/companies/${c.slug}`} className="font-medium hover:text-accent">
                        {c.name}
                      </Link>
                      <div className="text-[11px] text-ink-3 tabular">
                        {c.companyNumber ?? "no company number"}
                        {c.periodEnd && ` · accounts to ${formatDate(c.periodEnd)}`}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-ink-2">{c.industry ?? "—"}</td>
                    <td className="px-3 py-2.5 text-ink-2 whitespace-nowrap">
                      {c.regionLabel}
                      {c.officeLocation && (
                        <div className="text-[11px] text-ink-3">{c.officeLocation}</div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <Fact value={c.facts.valuation.value} provenance={c.facts.valuation.provenance} />
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <Fact value={c.facts.revenue.value} provenance={c.facts.revenue.provenance} />
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <Fact value={c.facts.pretaxProfit.value} provenance={c.facts.pretaxProfit.provenance} />
                      {c.marginPct !== null && (
                        <div className="text-[11px] text-ink-3">{formatPct(c.marginPct)} margin</div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <Fact value={c.facts.dividends.value} provenance={c.facts.dividends.provenance} />
                    </td>
                    <td className="px-3 py-2.5 text-right tabular">
                      {c.cagrPct === null ? (
                        <span className="text-ink-3">—</span>
                      ) : (
                        <span className={c.cagrPct >= 25 ? "text-positive font-medium" : ""}>
                          {formatPct(c.cagrPct)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <VerificationBadge verification={c.verification} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <Meter
                          value={c.exitPotential}
                          className="w-12"
                          tone={c.exitPotential >= 60 ? "signal" : "accent"}
                          label="Exit potential"
                        />
                        <span className="text-[11px] tabular text-ink-3">{c.exitPotential}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      {c.owners.map((o) => (
                        <Link
                          key={o.slug}
                          href={`/prospects/${o.slug}`}
                          className="block text-[12px] text-ink-2 hover:text-accent"
                        >
                          {o.fullName}
                        </Link>
                      ))}
                      {c.owners.length === 0 && <span className="text-ink-3">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && <EmptyState title="No companies on file yet." />}
        </Card>
      </div>
    </>
  );
}
