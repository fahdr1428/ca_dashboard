import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { Card, CardHeader, Badge, Estimated, Field, Meter, EmptyState } from "@/components/ui";
import { CompanyFinancialsChart } from "@/components/charts";
import { prisma } from "@/lib/db";
import { REGION_META } from "@/lib/regions";
import { formatGBP, formatPct, formatOwnership } from "@/lib/wealth";
import { formatDate } from "@/lib/utils";
import { revenueCagr, pretaxMargin } from "@/lib/scoring/valuation";
import { SIGNAL_LABELS, CORPORATE_EVENT_LABELS, EVIDENCE_LABELS, SOURCE_TYPE_LABELS } from "@/lib/signal-labels";
import { companiesHouseCompanyUrl } from "@/lib/ingest/linkedin";
import { gradeCompanyFacts, summariseVerification, FACT_LABELS, type CompanyFactKey } from "@/lib/verification";
import { FactRow, VerificationBadge } from "@/components/fact";

export const dynamic = "force-dynamic";

export default async function CompanyDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const company = await prisma.company.findUnique({
    where: { slug },
    include: {
      financials: { orderBy: { periodEnd: "asc" } },
      shareholdings: { include: { prospect: true }, orderBy: { ownershipPctLow: "desc" } },
      dividends: { orderBy: { periodEnd: "desc" } },
      fundingRounds: { orderBy: { announcedOn: "desc" } },
      corporateEvents: { orderBy: { announcedOn: "desc" } },
      signals: { include: { source: true }, orderBy: { occurredOn: "desc" } },
    },
  });

  if (!company) notFound();

  const citations = await prisma.citation.findMany({
    where: { entityType: "company", entityId: company.id },
    include: { source: true },
  });

  const periods = company.financials.map((f) => ({
    periodEnd: f.periodEnd,
    revenueGBP: f.revenueGBP === null ? null : Number(f.revenueGBP),
    ebitdaGBP: f.ebitdaGBP === null ? null : Number(f.ebitdaGBP),
    pretaxProfitGBP: f.pretaxProfitGBP === null ? null : Number(f.pretaxProfitGBP),
    netAssetsGBP: f.netAssetsGBP === null ? null : Number(f.netAssetsGBP),
    cashGBP: f.cashGBP === null ? null : Number(f.cashGBP),
    isAbridged: f.isAbridged,
  }));
  const latest = [...periods].reverse()[0];
  const cagr = revenueCagr(periods);
  const margin = pretaxMargin(latest);

  const chartData = company.financials.map((f) => ({
    period: f.periodLabel ?? f.periodEnd.toISOString().slice(0, 7),
    revenueGBP: f.revenueGBP === null ? null : Number(f.revenueGBP),
    pretaxProfitGBP: f.pretaxProfitGBP === null ? null : Number(f.pretaxProfitGBP),
    dividendsGBP: f.dividendsDeclaredGBP === null ? null : Number(f.dividendsDeclaredGBP),
  }));

  const valuationMid = Number(company.estValuationMidGBP ?? 0n);

  const latestFiled = [...company.financials].reverse()[0];
  const facts = gradeCompanyFacts({
    companyNumber: company.companyNumber,
    latestPeriodEnd: latestFiled?.periodEnd ?? null,
    isAbridged: latestFiled?.isAbridged ?? false,
    hasAnyAccounts: company.financials.length > 0,
    revenueGBP: latestFiled?.revenueGBP ? Number(latestFiled.revenueGBP) : null,
    pretaxProfitGBP: latestFiled?.pretaxProfitGBP ? Number(latestFiled.pretaxProfitGBP) : null,
    netAssetsGBP: latestFiled?.netAssetsGBP ? Number(latestFiled.netAssetsGBP) : null,
    cashGBP: latestFiled?.cashGBP ? Number(latestFiled.cashGBP) : null,
    dividendsGBP: latestFiled?.dividendsDeclaredGBP ? Number(latestFiled.dividendsDeclaredGBP) : null,
    valuationMidGBP: valuationMid,
    valuationMethod: company.valuationMethod,
    valuationBasisIsTransaction: company.fundingRounds.length > 0,
  });
  const verification = summariseVerification(facts);
  const FACT_ORDER: CompanyFactKey[] = [
    "revenue", "pretaxProfit", "netAssets", "cash", "dividends", "valuation",
  ];

  return (
    <>
      <PageHeader
        title={company.name}
        description={[company.industry, company.officeLocation, company.companyNumber]
          .filter(Boolean)
          .join(" · ")}
        actions={
          company.companyNumber ? (
            <a
              href={companiesHouseCompanyUrl(company.companyNumber)}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-medium text-ink-2 hover:bg-surface-2"
            >
              <ExternalLink className="size-3.5" /> Companies House
            </a>
          ) : null
        }
      />

      <div className="px-5 pb-8 space-y-4">
        <Card className="px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-ink-3">
                Estimated equity value
              </div>
              <div className="text-2xl font-semibold tabular text-accent mt-0.5">
                <Estimated>{formatGBP(valuationMid)}</Estimated>
              </div>
              <div className="text-[11px] text-ink-3 tabular">
                {formatGBP(Number(company.estValuationLowGBP ?? 0n))} –{" "}
                {formatGBP(Number(company.estValuationHighGBP ?? 0n))}
              </div>
            </div>
            <Field label="Latest turnover">
              {latest?.isAbridged ? (
                <Badge tone="signal">Not disclosed (abridged)</Badge>
              ) : (
                <span className="tabular">{formatGBP(latest?.revenueGBP)}</span>
              )}
            </Field>
            <Field label="Pre-tax profit">
              <span className="tabular">{formatGBP(latest?.pretaxProfitGBP)}</span>
              {margin !== null && (
                <div className="text-[11px] text-ink-3">{formatPct(margin)} margin</div>
              )}
            </Field>
            <Field label="Revenue CAGR">
              <span className="tabular">{cagr === null ? "—" : formatPct(cagr)}</span>
            </Field>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-ink-3">Exit potential</div>
              <div className="text-2xl font-semibold tabular mt-0.5">
                {company.exitPotential ?? 0}
              </div>
              <Meter
                value={company.exitPotential ?? 0}
                tone={(company.exitPotential ?? 0) >= 60 ? "signal" : "accent"}
                className="mt-1"
              />
            </div>
          </div>

          {company.valuationMethod && (
            <p className="mt-3 pt-3 border-t border-line text-[12px] text-ink-2 leading-relaxed">
              <span className="text-ink-3">Valuation basis: </span>
              {company.valuationMethod}
              {company.valuationAsOf && (
                <span className="text-ink-3"> As at {formatDate(company.valuationAsOf)}.</span>
              )}
            </p>
          )}
          {company.exitRationale && (
            <p className="mt-1.5 text-[12px] text-ink-2 leading-relaxed">
              <span className="text-ink-3">Exit potential: </span>
              {company.exitRationale}
            </p>
          )}
        </Card>

        <Card>
          <CardHeader
            title="What is on the public record"
            subtitle="Which of these figures is a filed fact, which this system derived, and — where a figure is missing — why it is not available."
            action={<VerificationBadge verification={verification} />}
          />
          <div className="px-5 pb-4">
            <p className="text-[12px] text-ink-2 leading-relaxed mb-2">{verification.summary}</p>
            {FACT_ORDER.map((key) => (
              <FactRow
                key={key}
                label={FACT_LABELS[key]}
                value={facts[key].value}
                provenance={facts[key].provenance}
              />
            ))}
          </div>
        </Card>

        <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr] items-start">
          <div className="space-y-4 min-w-0">
            <Card>
              <CardHeader
                title="Filed financial history"
                subtitle="Turnover, pre-tax profit and declared distributions as filed at Companies House."
              />
              <div className="px-2 pb-3">
                <CompanyFinancialsChart data={chartData} />
              </div>
              <div className="px-5 pb-4 flex flex-wrap gap-4 text-[11px] text-ink-3">
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-sm bg-[var(--color-accent)]" /> Turnover
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-sm bg-[var(--color-band-sky)]" /> Pre-tax profit
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-sm bg-[var(--color-signal)]" /> Dividends declared
                </span>
              </div>
            </Card>

            <Card>
              <CardHeader title="Accounts" />
              <div className="overflow-x-auto scroll-thin">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-y border-line text-left text-[11px] uppercase tracking-wide text-ink-3">
                      <th className="px-5 py-2 font-medium">Period end</th>
                      <th className="px-3 py-2 font-medium text-right">Turnover</th>
                      <th className="px-3 py-2 font-medium text-right">EBITDA</th>
                      <th className="px-3 py-2 font-medium text-right">Pre-tax profit</th>
                      <th className="px-3 py-2 font-medium text-right">Net assets</th>
                      <th className="px-3 py-2 font-medium text-right">Cash</th>
                      <th className="px-5 py-2 font-medium text-right">Dividends</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...company.financials].reverse().map((f) => (
                      <tr key={f.id} className="border-b border-line last:border-0">
                        <td className="px-5 py-2 tabular">
                          {formatDate(f.periodEnd)}
                          {f.isAbridged && (
                            <Badge tone="signal" className="ml-1.5">
                              abridged
                            </Badge>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular">{formatGBP(f.revenueGBP && Number(f.revenueGBP))}</td>
                        <td className="px-3 py-2 text-right tabular">{formatGBP(f.ebitdaGBP && Number(f.ebitdaGBP))}</td>
                        <td className="px-3 py-2 text-right tabular">{formatGBP(f.pretaxProfitGBP && Number(f.pretaxProfitGBP))}</td>
                        <td className="px-3 py-2 text-right tabular">{formatGBP(f.netAssetsGBP && Number(f.netAssetsGBP))}</td>
                        <td className="px-3 py-2 text-right tabular">{formatGBP(f.cashGBP && Number(f.cashGBP))}</td>
                        <td className="px-5 py-2 text-right tabular">
                          {formatGBP(f.dividendsDeclaredGBP && Number(f.dividendsDeclaredGBP))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {company.financials.length === 0 && (
                <EmptyState title="No filed accounts on record." />
              )}
            </Card>

            {(company.fundingRounds.length > 0 || company.corporateEvents.length > 0) && (
              <Card>
                <CardHeader
                  title="Funding and corporate activity"
                  subtitle="Rounds, acquisitions and disposals. These drive both the valuation and the liquidity view."
                />
                <div className="px-5 pb-4 space-y-2.5">
                  {company.fundingRounds.map((r) => (
                    <div key={r.id} className="rounded-lg border border-line p-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-[13px] font-medium">{r.stage}</span>
                        <span className="text-[13px] font-semibold tabular">
                          {formatGBP(r.amountGBP && Number(r.amountGBP))}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] text-ink-3">
                        {formatDate(r.announcedOn)}
                        {r.postMoneyGBP && ` · post-money ${formatGBP(Number(r.postMoneyGBP))}`}
                        {r.investors.length > 0 && ` · ${r.investors.join(", ")}`}
                      </div>
                      <Badge tone="outline" className="mt-1.5">
                        {EVIDENCE_LABELS[r.evidence]}
                      </Badge>
                    </div>
                  ))}
                  {company.corporateEvents.map((e) => (
                    <div key={e.id} className="rounded-lg border border-line p-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-[13px] font-medium">
                          {CORPORATE_EVENT_LABELS[e.type]}
                          {e.counterparty && (
                            <span className="text-ink-3 font-normal"> — {e.counterparty}</span>
                          )}
                        </span>
                        <span className="text-[13px] font-semibold tabular">
                          {formatGBP(e.considerationGBP && Number(e.considerationGBP))}
                        </span>
                      </div>
                      {e.summary && (
                        <p className="mt-1 text-[12px] text-ink-2 leading-relaxed">{e.summary}</p>
                      )}
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-ink-3">
                        <Badge tone={e.completedOn ? "accent" : "signal"}>
                          {e.completedOn ? `Completed ${formatDate(e.completedOn)}` : "Announced, not completed"}
                        </Badge>
                        <span>announced {formatDate(e.announcedOn)}</span>
                        <Badge tone="outline">{EVIDENCE_LABELS[e.evidence]}</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>

          <div className="space-y-4 min-w-0">
            <Card>
              <CardHeader title="Registered details" />
              <div className="px-5 pb-4 grid grid-cols-2 gap-3">
                <Field label="Company number">{company.companyNumber ?? "—"}</Field>
                <Field label="Status">{company.status ?? "—"}</Field>
                <Field label="Incorporated">{formatDate(company.incorporatedOn)}</Field>
                <Field label="Employees">{company.employees ?? "—"}</Field>
                <Field label="County">
                  {company.region ? REGION_META[company.region].label : "—"}
                </Field>
                <Field label="Registered office">{company.registeredAddress ?? "—"}</Field>
                <Field label="SIC codes">
                  {company.sicCodes.length ? company.sicCodes.join(", ") : "—"}
                </Field>
                <Field label="Register last checked">{formatDate(company.chLastCheckedAt)}</Field>
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Ownership"
                subtitle="From the PSC register. Bands are 25-point ranges, not exact percentages."
              />
              <div className="px-5 pb-4 space-y-2.5">
                {company.shareholdings.map((sh) => (
                  <div key={sh.id} className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        href={`/prospects/${sh.prospect.slug}`}
                        className="text-[13px] font-medium hover:text-accent"
                      >
                        {sh.prospect.fullName}
                      </Link>
                      <div className="text-[11px] text-ink-3">
                        {sh.prospect.jobTitle ?? "—"} · {EVIDENCE_LABELS[sh.evidence]}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[13px] font-semibold tabular">
                        {formatOwnership(sh.ownershipPctLow, sh.ownershipPctHigh)}
                      </div>
                      <div className="text-[10px] text-ink-3 tabular">
                        <Estimated>
                          {formatGBP(
                            (valuationMid * ((sh.ownershipPctLow + sh.ownershipPctHigh) / 2)) / 100,
                          )}
                        </Estimated>
                      </div>
                    </div>
                  </div>
                ))}
                {company.shareholdings.length === 0 && (
                  <p className="text-[12px] text-ink-3">No tracked shareholders.</p>
                )}
              </div>
            </Card>

            {company.signals.length > 0 && (
              <Card>
                <CardHeader title="Signals" />
                <div className="px-5 pb-4 space-y-2.5">
                  {company.signals.map((s) => (
                    <div key={s.id}>
                      <div className="text-[12px] font-medium leading-snug">{s.title}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-ink-3">
                        <Badge tone="outline">{SIGNAL_LABELS[s.type]}</Badge>
                        <span>{formatDate(s.occurredOn)}</span>
                        {s.source && (
                          <a
                            href={s.source.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="text-accent hover:underline"
                          >
                            source
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            <Card>
              <CardHeader title="Sources" />
              <div className="px-5 pb-4 space-y-2">
                {citations.map((c) => (
                  <a
                    key={c.id}
                    href={c.source.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="block rounded-lg border border-line p-2.5 hover:border-accent/50"
                  >
                    <div className="text-[12px] font-medium leading-snug">{c.source.title}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-ink-3">
                      <Badge tone="outline">{SOURCE_TYPE_LABELS[c.source.sourceType]}</Badge>
                      <span>reliability {c.source.reliability}/5</span>
                    </div>
                  </a>
                ))}
                {citations.length === 0 && <p className="text-[12px] text-ink-3">No sources cited.</p>}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}
