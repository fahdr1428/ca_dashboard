import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, Building2, MapPin, Briefcase, Search } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import {
  Card,
  CardHeader,
  Badge,
  WealthBandBadge,
  StatusBadge,
  Estimated,
  Field,
  Meter,
} from "@/components/ui";
import { EstimatePanel, ConfidencePanel } from "@/components/estimate-panel";
import { ProspectWorkflow } from "@/components/prospect-workflow";
import { prisma } from "@/lib/db";
import { REGION_META } from "@/lib/regions";
import { formatGBP, formatOwnership } from "@/lib/wealth";
import { formatDate, formatRelative } from "@/lib/utils";
import { COHORT_LABELS, COHORT_DESCRIPTIONS, cohortFor } from "@/lib/pipeline-filters";
import { SIGNAL_LABELS, SOURCE_TYPE_LABELS, EVIDENCE_LABELS } from "@/lib/signal-labels";
import {
  linkedInSearchUrl,
  companiesHouseOfficerSearchUrl,
  companiesHouseCompanyUrl,
} from "@/lib/ingest/linkedin";
import type { WealthEstimate } from "@/lib/scoring/estimate";
import type { ConfidenceResult } from "@/lib/scoring/confidence";

export const dynamic = "force-dynamic";

export default async function ProspectDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const prospect = await prisma.prospect.findUnique({
    where: { slug },
    include: {
      company: true,
      shareholdings: { include: { company: true }, orderBy: { ownershipPctLow: "desc" } },
      publicHoldings: { orderBy: { valueGBP: "desc" } },
      dividends: { include: { company: true }, orderBy: { periodEnd: "desc" } },
      signals: { include: { source: true, company: true }, orderBy: { occurredOn: "desc" } },
      notes: { orderBy: [{ pinned: "desc" }, { createdAt: "desc" }] },
      events: { orderBy: { createdAt: "desc" }, take: 25 },
      snapshots: { orderBy: { takenAt: "asc" } },
    },
  });

  if (!prospect) notFound();

  const citations = await prisma.citation.findMany({
    where: {
      OR: [
        { entityType: "prospect", entityId: prospect.id },
        { entityType: "company", entityId: { in: prospect.shareholdings.map((s) => s.companyId) } },
        { entityType: "shareholding", entityId: { in: prospect.shareholdings.map((s) => s.id) } },
      ],
    },
    include: { source: true },
    orderBy: { createdAt: "asc" },
  });

  const sourcesById = new Map(
    citations.map((c) => [
      c.sourceId,
      { url: c.source.url, title: c.source.title, publisher: c.source.publisher },
    ]),
  );
  for (const s of prospect.signals) {
    if (s.source) {
      sourcesById.set(s.source.id, {
        url: s.source.url,
        title: s.source.title,
        publisher: s.source.publisher,
      });
    }
  }

  const estimate = prospect.estimateBreakdown as WealthEstimate | null;
  const confidence = prospect.confidenceBreakdown as ConfidenceResult | null;
  const cohort = cohortFor({
    estInvestableMidGBP: Number(prospect.estInvestableMidGBP),
    estGrossWealthMidGBP: Number(prospect.estGrossWealthMidGBP),
  });

  // Unique sources for the provenance list.
  const uniqueSources = [
    ...new Map(
      [...citations.map((c) => c.source), ...prospect.signals.map((s) => s.source)]
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .map((s) => [s.id, s]),
    ).values(),
  ].sort((a, b) => b.reliability - a.reliability);

  return (
    <>
      <PageHeader
        title={prospect.fullName}
        description={
          [prospect.jobTitle, prospect.company?.name].filter(Boolean).join(" · ") || undefined
        }
        actions={
          <>
            <a
              href={companiesHouseOfficerSearchUrl(prospect.fullName)}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-medium text-ink-2 hover:bg-surface-2"
            >
              <Search className="size-3.5" /> Verify on Companies House
            </a>
            <a
              href={linkedInSearchUrl(prospect.fullName, prospect.company?.name)}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-medium text-ink-2 hover:bg-surface-2"
              title="Opens a LinkedIn search. This system never scrapes LinkedIn — review it yourself."
            >
              <ExternalLink className="size-3.5" /> LinkedIn search
            </a>
          </>
        }
      />

      <div className="px-5 pb-8 space-y-4">
        {prospect.suppressedAt && (
          <div className="rounded-xl border border-danger/40 bg-danger-soft px-4 py-3">
            <p className="text-[13px] text-danger">
              <strong>Tracking suppressed</strong> on {formatDate(prospect.suppressedAt)}.{" "}
              {prospect.suppressionReason}. Automated ingestion will not update this record and it
              is excluded from pipeline totals.
            </p>
          </div>
        )}

        {/* Summary strip */}
        <Card className="px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-ink-3">
                Estimated investable assets
              </div>
              <div className="text-2xl font-semibold tabular text-accent mt-0.5">
                <Estimated>{formatGBP(Number(prospect.estInvestableMidGBP))}</Estimated>
              </div>
              <div className="text-[11px] text-ink-3 tabular">
                {formatGBP(Number(prospect.estInvestableLowGBP))} –{" "}
                {formatGBP(Number(prospect.estInvestableHighGBP))}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-ink-3">
                Gross estimated wealth
              </div>
              <div className="text-2xl font-semibold tabular mt-0.5">
                <Estimated>{formatGBP(Number(prospect.estGrossWealthMidGBP))}</Estimated>
              </div>
              <div className="mt-1">
                <WealthBandBadge band={prospect.wealthBand} />
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-ink-3">Confidence</div>
              <div className="text-2xl font-semibold tabular mt-0.5">{prospect.confidence}</div>
              <Meter value={prospect.confidence} className="mt-1.5" />
              <div className="text-[11px] text-ink-3 mt-1">
                {uniqueSources.length} cited public source{uniqueSources.length === 1 ? "" : "s"}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-ink-3">Cohort</div>
              <div className="mt-1">
                <Badge tone={cohort === "QUALIFYING" ? "accent" : cohort === "PRE_LIQUIDITY" ? "signal" : "neutral"}>
                  {COHORT_LABELS[cohort]}
                </Badge>
              </div>
              <p className="text-[11px] text-ink-3 leading-relaxed mt-1">
                {COHORT_DESCRIPTIONS[cohort]}
              </p>
            </div>
          </div>
        </Card>

        {prospect.rationale && (
          <Card className="px-5 py-4">
            <div className="text-[11px] uppercase tracking-wide text-ink-3 mb-1">
              Why they were identified
            </div>
            <p className="text-[13px] leading-relaxed text-ink-2">{prospect.rationale}</p>
          </Card>
        )}

        <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr] items-start">
          <div className="space-y-4 min-w-0">
            {estimate && <EstimatePanel estimate={estimate} sourcesById={sourcesById} />}

            {/* Holdings */}
            <Card>
              <CardHeader
                title="Holdings"
                subtitle="Ownership positions behind the estimate, with the filing that evidences each one."
              />
              <div className="px-5 pb-4 space-y-3">
                {prospect.shareholdings.map((sh) => (
                  <div key={sh.id} className="rounded-lg border border-line p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <Link
                        href={`/companies/${sh.company.slug}`}
                        className="text-[13px] font-medium hover:text-accent"
                      >
                        {sh.company.name}
                      </Link>
                      <span className="text-[13px] font-semibold tabular">
                        {formatOwnership(sh.ownershipPctLow, sh.ownershipPctHigh)}
                      </span>
                    </div>
                    <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
                      <Field label="Company valuation">
                        <Estimated>{formatGBP(Number(sh.company.estValuationMidGBP ?? 0n))}</Estimated>
                      </Field>
                      <Field label="Evidence">
                        <Badge tone="outline">{EVIDENCE_LABELS[sh.evidence]}</Badge>
                      </Field>
                      <Field label="As at">{formatDate(sh.asOf)}</Field>
                    </div>
                    {sh.basis && (
                      <p className="mt-1.5 text-[11px] text-ink-3 font-mono">{sh.basis}</p>
                    )}
                    {sh.company.companyNumber && (
                      <a
                        href={companiesHouseCompanyUrl(sh.company.companyNumber)}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
                      >
                        Companies House {sh.company.companyNumber}
                        <ExternalLink className="size-2.5" />
                      </a>
                    )}
                  </div>
                ))}

                {prospect.publicHoldings.map((h) => (
                  <div key={h.id} className="rounded-lg border border-line p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[13px] font-medium">
                        {h.companyName}
                        {h.ticker && <span className="text-ink-3 ml-1.5">{h.ticker}</span>}
                      </span>
                      <span className="text-[13px] font-semibold tabular">
                        <Estimated>{formatGBP(Number(h.valueGBP ?? 0n))}</Estimated>
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-ink-3">
                      Listed holding · {h.percentHeld ? `${h.percentHeld}% held · ` : ""}
                      disclosed {formatDate(h.asOf)}
                    </div>
                  </div>
                ))}

                {prospect.shareholdings.length === 0 && prospect.publicHoldings.length === 0 && (
                  <p className="text-[12px] text-ink-3">No holdings recorded.</p>
                )}
              </div>
            </Card>

            {/* Dividends */}
            {prospect.dividends.length > 0 && (
              <Card>
                <CardHeader
                  title="Attributed dividends"
                  subtitle="Company distributions from filed accounts, apportioned by ownership share."
                />
                <div className="overflow-x-auto scroll-thin">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="border-y border-line text-left text-[11px] uppercase tracking-wide text-ink-3">
                        <th className="px-5 py-2 font-medium">Period</th>
                        <th className="px-3 py-2 font-medium">Company</th>
                        <th className="px-3 py-2 font-medium text-right">Total declared</th>
                        <th className="px-5 py-2 font-medium text-right">Attributed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {prospect.dividends.map((d) => (
                        <tr key={d.id} className="border-b border-line last:border-0">
                          <td className="px-5 py-2 tabular">{formatDate(d.periodEnd)}</td>
                          <td className="px-3 py-2 text-ink-2">{d.company.name}</td>
                          <td className="px-3 py-2 text-right tabular">
                            {formatGBP(Number(d.totalGBP))}
                          </td>
                          <td className="px-5 py-2 text-right tabular font-medium">
                            <Estimated>{formatGBP(Number(d.attributedGBP ?? 0n))}</Estimated>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}

            {/* Signals */}
            <Card>
              <CardHeader
                title="Wealth signals"
                subtitle="Events that changed, or could change, this person's position."
              />
              <div className="px-5 pb-4 space-y-3">
                {prospect.signals.map((s) => (
                  <div key={s.id} className="flex gap-3">
                    <div className="flex flex-col items-center pt-1">
                      <span className="size-2 rounded-full bg-accent" />
                      <span className="flex-1 w-px bg-line mt-1" />
                    </div>
                    <div className="pb-2 min-w-0">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-[13px] font-medium">{s.title}</span>
                        {s.magnitudeGBP && (
                          <span className="text-[12px] font-semibold tabular text-accent">
                            {formatGBP(Number(s.magnitudeGBP))}
                          </span>
                        )}
                      </div>
                      {s.summary && (
                        <p className="text-[12px] text-ink-2 leading-relaxed mt-0.5">{s.summary}</p>
                      )}
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-ink-3">
                        <Badge tone="outline">{SIGNAL_LABELS[s.type]}</Badge>
                        <span>{formatDate(s.occurredOn)}</span>
                        <span>confidence {s.confidence}</span>
                        {s.source && (
                          <a
                            href={s.source.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-0.5 text-accent hover:underline"
                          >
                            {s.source.publisher ?? "source"}
                            <ExternalLink className="size-2.5" />
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                {prospect.signals.length === 0 && (
                  <p className="text-[12px] text-ink-3">No signals recorded yet.</p>
                )}
              </div>
            </Card>
          </div>

          {/* Right column */}
          <div className="space-y-4 min-w-0">
            <Card>
              <CardHeader title="Record" />
              <div className="px-5 pb-4 grid gap-3 grid-cols-2">
                <Field label="Occupation">
                  <span className="flex items-center gap-1.5">
                    <Briefcase className="size-3 text-ink-3" />
                    {prospect.occupation ?? "—"}
                  </span>
                </Field>
                <Field label="Job title">{prospect.jobTitle ?? "—"}</Field>
                <Field label="Company">
                  <span className="flex items-center gap-1.5">
                    <Building2 className="size-3 text-ink-3" />
                    {prospect.company ? (
                      <Link href={`/companies/${prospect.company.slug}`} className="hover:text-accent">
                        {prospect.company.name}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </span>
                </Field>
                <Field label="Office location">
                  <span className="flex items-center gap-1.5">
                    <MapPin className="size-3 text-ink-3" />
                    {prospect.officeLocation ?? "—"}
                  </span>
                </Field>
                <Field label="County">{REGION_META[prospect.region].label}</Field>
                <Field label="Status">
                  <StatusBadge status={prospect.status} />
                </Field>
                <Field label="Date added">{formatDate(prospect.dateAdded)}</Field>
                <Field label="Last updated">{formatRelative(prospect.lastUpdated)}</Field>
                <Field label="Identity match">
                  {prospect.chOfficerId ? (
                    <Badge tone="accent">Companies House officer</Badge>
                  ) : (
                    <Badge tone="signal">Unverified</Badge>
                  )}
                </Field>
                <Field label="Identity confidence">
                  <span className="tabular">{prospect.identityConfidence}/100</span>
                </Field>
              </div>
            </Card>

            {confidence && <ConfidencePanel confidence={confidence} />}

            <ProspectWorkflow
              prospectId={prospect.id}
              status={prospect.status}
              relationshipStage={prospect.relationshipStage}
              owner={prospect.owner}
              suppressedAt={prospect.suppressedAt?.toISOString() ?? null}
              notes={prospect.notes.map((n) => ({
                id: n.id,
                body: n.body,
                author: n.author,
                createdAt: n.createdAt.toISOString(),
              }))}
            />

            <Card>
              <CardHeader
                title="Sources"
                subtitle="Every public document behind this record. Open any of them to verify a figure yourself."
              />
              <div className="px-5 pb-4 space-y-2">
                {uniqueSources.map((s) => (
                  <a
                    key={s.id}
                    href={s.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="block rounded-lg border border-line p-2.5 hover:border-accent/50 hover:bg-surface-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[12px] font-medium leading-snug">{s.title}</span>
                      <ExternalLink className="size-3 text-ink-3 shrink-0 mt-0.5" />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-ink-3">
                      <Badge tone="outline">{SOURCE_TYPE_LABELS[s.sourceType]}</Badge>
                      <span>{s.publisher}</span>
                      <span>· reliability {s.reliability}/5</span>
                      {s.publishedAt && <span>· {formatDate(s.publishedAt)}</span>}
                    </div>
                    {s.licence && (
                      <div className="mt-1 text-[10px] text-ink-3">{s.licence}</div>
                    )}
                  </a>
                ))}
                {uniqueSources.length === 0 && (
                  <p className="text-[12px] text-ink-3">No sources cited.</p>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader title="Activity" subtitle="Append-only audit trail." />
              <div className="px-5 pb-4 space-y-2">
                {prospect.events.map((e) => (
                  <div key={e.id} className="text-[12px] leading-relaxed">
                    <span className="text-ink-2">{e.message}</span>
                    <div className="text-[10px] text-ink-3">
                      {e.actor ?? "system"} · {formatRelative(e.createdAt)}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}
