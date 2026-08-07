import { prisma, toBigInt } from "@/lib/db";
import { recomputeCompany, recomputeProspect, snapshotProspects } from "@/lib/scoring/recompute";
import { isInScope } from "@/lib/regions";
import { slugify } from "@/lib/utils";
import { createCompaniesHouseConnector } from "./companies-house";
import { createNewsConnector } from "./news";
import { createLinkedInConnector } from "./linkedin";
import type { Connector, ConnectorResult, RawCompany, RawProspect, RawSignal, RawSource } from "./types";
import type { IngestTrigger, RunStatus } from "@/generated/prisma/enums";

/** Every connector the system knows about, in priority order. */
export function allConnectors(): Connector[] {
  return [createCompaniesHouseConnector(), createNewsConnector(), createLinkedInConnector()];
}

export interface IngestOptions {
  trigger: IngestTrigger;
  /** Limit to specific connector keys. */
  only?: string[];
  /** Only consider material published after this date. */
  since?: Date | null;
  maxRequestsPerConnector?: number;
  /** Skip the weekly snapshot (used by ad-hoc manual runs). */
  snapshot?: boolean;
}

export interface IngestSummary {
  runId: string;
  status: RunStatus;
  connectorsRun: string[];
  connectorsSkipped: Array<{ key: string; reason: string }>;
  stats: {
    sourcesUpserted: number;
    companiesUpserted: number;
    prospectsCreated: number;
    prospectsUpdated: number;
    signalsCreated: number;
    prospectsRecomputed: number;
    snapshotsTaken: number;
  };
  warnings: string[];
  log: string[];
  durationMs: number;
}

export async function runIngest(options: IngestOptions): Promise<IngestSummary> {
  const startedAt = Date.now();
  const log: string[] = [];
  const warnings: string[] = [];
  const connectorsSkipped: Array<{ key: string; reason: string }> = [];

  const stats = {
    sourcesUpserted: 0,
    companiesUpserted: 0,
    prospectsCreated: 0,
    prospectsUpdated: 0,
    signalsCreated: 0,
    prospectsRecomputed: 0,
    snapshotsTaken: 0,
  };

  const connectors = allConnectors().filter(
    (c) => !options.only?.length || options.only.includes(c.key),
  );

  const run = await prisma.ingestRun.create({
    data: { trigger: options.trigger, status: "RUNNING", connectorsRun: [] },
  });

  const touchedCompanyIds = new Set<string>();
  const touchedProspectIds = new Set<string>();
  const connectorsRun: string[] = [];

  for (const connector of connectors) {
    if (!connector.isAvailable()) {
      const reason = connector.unavailableReason?.() ?? "Connector unavailable.";
      connectorsSkipped.push({ key: connector.key, reason });
      log.push(`SKIP ${connector.key}: ${reason}`);
      continue;
    }

    let result: ConnectorResult;
    try {
      result = await connector.run({
        since: options.since ?? null,
        maxRequests: options.maxRequestsPerConnector ?? 400,
        log: (m) => log.push(m),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`${connector.key} failed: ${message}`);
      log.push(`FAIL ${connector.key}: ${message}`);
      continue;
    }

    connectorsRun.push(connector.key);
    warnings.push(...result.warnings.map((w) => `${connector.key}: ${w}`));

    // --- Companies ---------------------------------------------------------
    for (const raw of result.companies) {
      try {
        const { id, created } = await upsertCompany(raw);
        touchedCompanyIds.add(id);
        stats.companiesUpserted++;
        stats.sourcesUpserted += raw.sources.length;
        if (created) log.push(`New company: ${raw.name}`);
      } catch (err) {
        warnings.push(`Failed to store company ${raw.name}: ${errText(err)}`);
      }
    }

    // --- Prospects ---------------------------------------------------------
    for (const raw of result.prospects) {
      try {
        const outcome = await upsertProspect(raw);
        if (!outcome) continue;
        touchedProspectIds.add(outcome.id);
        if (outcome.companyId) touchedCompanyIds.add(outcome.companyId);
        if (outcome.created) stats.prospectsCreated++;
        else stats.prospectsUpdated++;
      } catch (err) {
        warnings.push(`Failed to store prospect ${raw.fullName}: ${errText(err)}`);
      }
    }

    // --- Signals -----------------------------------------------------------
    for (const raw of result.signals) {
      try {
        const created = await upsertSignal(raw);
        if (created) stats.signalsCreated++;
        if (created?.companyId) touchedCompanyIds.add(created.companyId);
        if (created?.prospectId) touchedProspectIds.add(created.prospectId);
      } catch (err) {
        warnings.push(`Failed to store signal "${raw.title}": ${errText(err)}`);
      }
    }
  }

  // --- Recompute ------------------------------------------------------------
  for (const companyId of touchedCompanyIds) {
    try {
      await recomputeCompany(companyId);
    } catch (err) {
      warnings.push(`Valuation failed for company ${companyId}: ${errText(err)}`);
    }
  }

  // Any prospect holding a touched company needs re-estimating too.
  const affected = await prisma.prospect.findMany({
    where: {
      OR: [
        { id: { in: [...touchedProspectIds] } },
        { shareholdings: { some: { companyId: { in: [...touchedCompanyIds] } } } },
      ],
    },
    select: { id: true },
  });
  for (const { id } of affected) {
    try {
      await recomputeProspect(id);
      stats.prospectsRecomputed++;
    } catch (err) {
      warnings.push(`Recompute failed for prospect ${id}: ${errText(err)}`);
    }
  }

  if (options.snapshot !== false) {
    stats.snapshotsTaken = await snapshotProspects();
  }

  const status: RunStatus = warnings.length === 0 ? "SUCCESS" : connectorsRun.length ? "PARTIAL" : "FAILED";

  await prisma.ingestRun.update({
    where: { id: run.id },
    data: {
      status,
      finishedAt: new Date(),
      connectorsRun,
      stats,
      errors: warnings.length ? warnings : undefined,
    },
  });

  await prisma.systemState.upsert({
    where: { key: "ingest.lastRunAt" },
    create: { key: "ingest.lastRunAt", value: { at: new Date().toISOString() } },
    update: { value: { at: new Date().toISOString() } },
  });

  return {
    runId: run.id,
    status,
    connectorsRun,
    connectorsSkipped,
    stats,
    warnings,
    log,
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Upserts
// ---------------------------------------------------------------------------

export async function upsertSource(raw: RawSource): Promise<string> {
  const source = await prisma.source.upsert({
    where: { url: raw.url },
    create: {
      url: raw.url,
      title: raw.title,
      publisher: raw.publisher,
      sourceType: raw.sourceType,
      publishedAt: raw.publishedAt,
      reliability: raw.reliability ?? defaultReliability(raw),
      excerpt: raw.excerpt,
      licence: raw.licence,
    },
    update: {
      title: raw.title,
      retrievedAt: new Date(),
      excerpt: raw.excerpt ?? undefined,
      publishedAt: raw.publishedAt ?? undefined,
    },
  });
  return source.id;
}

function defaultReliability(raw: RawSource): number {
  switch (raw.sourceType) {
    case "COMPANIES_HOUSE":
    case "COMPANY_ACCOUNTS":
      return 5;
    case "RNS_REGULATORY":
    case "LAND_REGISTRY":
      return 5;
    case "OPEN_DATASET":
    case "CHARITY_COMMISSION":
      return 4;
    case "NEWS":
    case "PRESS_RELEASE":
    case "FUNDING_DATABASE":
      return 3;
    default:
      return 2;
  }
}

async function cite(
  sourceId: string,
  entityType: string,
  entityId: string,
  field?: string,
  note?: string,
) {
  await prisma.citation.upsert({
    where: {
      sourceId_entityType_entityId_field: {
        sourceId,
        entityType,
        entityId,
        field: field ?? "",
      },
    },
    create: { sourceId, entityType, entityId, field: field ?? "", note },
    update: { note },
  });
}

async function upsertCompany(raw: RawCompany): Promise<{ id: string; created: boolean }> {
  const where = raw.companyNumber
    ? { companyNumber: raw.companyNumber }
    : { slug: slugify(raw.name) };

  const existing = await prisma.company.findFirst({ where });

  const data = {
    name: raw.name,
    slug: slugify(raw.companyNumber ? `${raw.name}-${raw.companyNumber}` : raw.name),
    companyNumber: raw.companyNumber ?? null,
    status: raw.status,
    incorporatedOn: raw.incorporatedOn,
    industry: raw.industry,
    sicCodes: raw.sicCodes ?? [],
    region: raw.region ?? null,
    officeLocation: raw.officeLocation,
    registeredAddress: raw.registeredAddress,
    latitude: raw.latitude,
    longitude: raw.longitude,
    website: raw.website,
    employees: raw.employees,
    chLastCheckedAt: raw.companyNumber ? new Date() : undefined,
    chFilingHash: raw.filingHash,
  };

  const company = existing
    ? await prisma.company.update({ where: { id: existing.id }, data })
    : await prisma.company.create({ data });

  for (const s of raw.sources) {
    const sourceId = await upsertSource(s);
    await cite(sourceId, "company", company.id);
  }

  for (const f of raw.financials ?? []) {
    await prisma.companyFinancial.upsert({
      where: { companyId_periodEnd: { companyId: company.id, periodEnd: f.periodEnd } },
      create: {
        companyId: company.id,
        periodEnd: f.periodEnd,
        periodLabel: f.periodLabel,
        revenueGBP: f.revenueGBP == null ? null : toBigInt(f.revenueGBP),
        grossProfitGBP: f.grossProfitGBP == null ? null : toBigInt(f.grossProfitGBP),
        ebitdaGBP: f.ebitdaGBP == null ? null : toBigInt(f.ebitdaGBP),
        pretaxProfitGBP: f.pretaxProfitGBP == null ? null : toBigInt(f.pretaxProfitGBP),
        netAssetsGBP: f.netAssetsGBP == null ? null : toBigInt(f.netAssetsGBP),
        cashGBP: f.cashGBP == null ? null : toBigInt(f.cashGBP),
        employees: f.employees ?? null,
        dividendsDeclaredGBP: f.dividendsDeclaredGBP == null ? null : toBigInt(f.dividendsDeclaredGBP),
        isAbridged: f.isAbridged ?? false,
        evidence: f.evidence ?? "FILED",
      },
      update: {
        revenueGBP: f.revenueGBP == null ? undefined : toBigInt(f.revenueGBP),
        ebitdaGBP: f.ebitdaGBP == null ? undefined : toBigInt(f.ebitdaGBP),
        pretaxProfitGBP: f.pretaxProfitGBP == null ? undefined : toBigInt(f.pretaxProfitGBP),
        netAssetsGBP: f.netAssetsGBP == null ? undefined : toBigInt(f.netAssetsGBP),
        cashGBP: f.cashGBP == null ? undefined : toBigInt(f.cashGBP),
        dividendsDeclaredGBP:
          f.dividendsDeclaredGBP == null ? undefined : toBigInt(f.dividendsDeclaredGBP),
      },
    });
  }

  for (const r of raw.fundingRounds ?? []) {
    const exists = await prisma.fundingRound.findFirst({
      where: { companyId: company.id, announcedOn: r.announcedOn, stage: r.stage },
    });
    if (exists) continue;
    const round = await prisma.fundingRound.create({
      data: {
        companyId: company.id,
        announcedOn: r.announcedOn,
        stage: r.stage,
        amountGBP: r.amountGBP == null ? null : toBigInt(r.amountGBP),
        preMoneyGBP: r.preMoneyGBP == null ? null : toBigInt(r.preMoneyGBP),
        postMoneyGBP: r.postMoneyGBP == null ? null : toBigInt(r.postMoneyGBP),
        investors: r.investors ?? [],
        evidence: r.evidence ?? "REPORTED",
      },
    });
    for (const s of r.sources ?? []) await cite(await upsertSource(s), "fundingRound", round.id);
  }

  for (const e of raw.corporateEvents ?? []) {
    const exists = await prisma.corporateEvent.findFirst({
      where: { companyId: company.id, type: e.type, announcedOn: e.announcedOn },
    });
    if (exists) continue;
    const event = await prisma.corporateEvent.create({
      data: {
        companyId: company.id,
        type: e.type,
        announcedOn: e.announcedOn,
        completedOn: e.completedOn ?? null,
        counterparty: e.counterparty,
        considerationGBP: e.considerationGBP == null ? null : toBigInt(e.considerationGBP),
        evidence: e.evidence ?? "REPORTED",
        summary: e.summary,
      },
    });
    for (const s of e.sources ?? []) await cite(await upsertSource(s), "corporateEvent", event.id);
  }

  return { id: company.id, created: !existing };
}

async function upsertProspect(
  raw: RawProspect,
): Promise<{ id: string; created: boolean; companyId: string | null } | null> {
  if (!isInScope(raw.region)) return null;

  // Identity key: Companies House officer id is authoritative; otherwise fall
  // back to name + primary company, which is the best we can honestly do.
  const slug = slugify(
    raw.chOfficerId
      ? `${raw.fullName}-${raw.chOfficerId}`
      : `${raw.fullName}-${raw.primaryCompanyNumber ?? raw.region}`,
  );

  const existing = await prisma.prospect.findUnique({ where: { slug } });

  // Respect suppression: if someone has objected to being tracked, ingestion
  // must not resurrect or update their record.
  if (existing?.suppressedAt) return null;

  let companyId: string | null = null;
  if (raw.primaryCompanyNumber || raw.primaryCompanyName) {
    const company = await prisma.company.findFirst({
      where: raw.primaryCompanyNumber
        ? { companyNumber: raw.primaryCompanyNumber }
        : { name: raw.primaryCompanyName },
    });
    companyId = company?.id ?? null;
  }

  const prospect = existing
    ? await prisma.prospect.update({
        where: { id: existing.id },
        data: {
          jobTitle: raw.jobTitle ?? existing.jobTitle,
          occupation: raw.occupation ?? existing.occupation,
          officeLocation: raw.officeLocation ?? existing.officeLocation,
          chOfficerId: raw.chOfficerId ?? existing.chOfficerId,
          identityConfidence: Math.max(existing.identityConfidence, raw.identityConfidence ?? 0),
          linkedinUrl: raw.linkedinUrl ?? existing.linkedinUrl,
          companyId: companyId ?? existing.companyId,
          latitude: raw.latitude ?? existing.latitude,
          longitude: raw.longitude ?? existing.longitude,
        },
      })
    : await prisma.prospect.create({
        data: {
          fullName: raw.fullName,
          slug,
          occupation: raw.occupation,
          jobTitle: raw.jobTitle,
          officeLocation: raw.officeLocation,
          region: raw.region,
          latitude: raw.latitude,
          longitude: raw.longitude,
          chOfficerId: raw.chOfficerId,
          identityConfidence: raw.identityConfidence ?? 50,
          linkedinUrl: raw.linkedinUrl,
          companyId,
          status: "NEW",
          relationshipStage: "UNAWARE",
        },
      });

  if (!existing) {
    await prisma.prospectEvent.create({
      data: {
        prospectId: prospect.id,
        type: "created",
        message: `Identified from ${raw.sources[0]?.publisher ?? "a public source"}.`,
        actor: "system:ingest",
      },
    });
  }

  for (const s of raw.sources) {
    await cite(await upsertSource(s), "prospect", prospect.id);
  }

  for (const sh of raw.shareholdings ?? []) {
    const company = await prisma.company.findFirst({
      where: sh.companyNumber ? { companyNumber: sh.companyNumber } : { name: sh.companyName },
    });
    if (!company) continue;
    const record = await prisma.shareholding.upsert({
      where: {
        prospectId_companyId_shareClass: {
          prospectId: prospect.id,
          companyId: company.id,
          shareClass: sh.shareClass ?? "ORDINARY",
        },
      },
      create: {
        prospectId: prospect.id,
        companyId: company.id,
        ownershipPctLow: sh.ownershipPctLow,
        ownershipPctHigh: sh.ownershipPctHigh,
        shareClass: sh.shareClass ?? "ORDINARY",
        basis: sh.basis,
        evidence: sh.evidence ?? "FILED",
        asOf: sh.asOf,
      },
      update: {
        ownershipPctLow: sh.ownershipPctLow,
        ownershipPctHigh: sh.ownershipPctHigh,
        basis: sh.basis,
        evidence: sh.evidence ?? "FILED",
        asOf: sh.asOf,
        isCurrent: true,
      },
    });
    for (const s of raw.sources) {
      await cite(await upsertSource(s), "shareholding", record.id, "ownershipPct", sh.basis);
    }
  }

  for (const h of raw.publicHoldings ?? []) {
    const exists = await prisma.publicHolding.findFirst({
      where: { prospectId: prospect.id, companyName: h.companyName, asOf: h.asOf ?? undefined },
    });
    if (exists) continue;
    await prisma.publicHolding.create({
      data: {
        prospectId: prospect.id,
        ticker: h.ticker,
        companyName: h.companyName,
        shares: h.shares == null ? null : toBigInt(h.shares),
        percentHeld: h.percentHeld,
        valueGBP: h.valueGBP == null ? null : toBigInt(h.valueGBP),
        asOf: h.asOf,
        evidence: h.evidence ?? "DISCLOSED",
      },
    });
  }

  for (const d of raw.dividends ?? []) {
    const company = await prisma.company.findFirst({
      where: d.companyNumber ? { companyNumber: d.companyNumber } : { name: d.companyName },
    });
    if (!company) continue;
    const exists = await prisma.dividendPayment.findFirst({
      where: { companyId: company.id, prospectId: prospect.id, periodEnd: d.periodEnd },
    });
    if (exists) continue;
    await prisma.dividendPayment.create({
      data: {
        companyId: company.id,
        prospectId: prospect.id,
        periodEnd: d.periodEnd,
        totalGBP: toBigInt(d.totalGBP),
        attributedGBP: d.attributedGBP == null ? null : toBigInt(d.attributedGBP),
        evidence: d.evidence ?? "FILED",
      },
    });
  }

  return { id: prospect.id, created: !existing, companyId };
}

async function upsertSignal(
  raw: RawSignal,
): Promise<{ id: string; companyId: string | null; prospectId: string | null } | null> {
  const existing = await prisma.signal.findUnique({ where: { dedupeKey: raw.dedupeKey } });
  if (existing) return null;

  let companyId: string | null = null;
  if (raw.companyNumber || raw.companyName) {
    const company = await prisma.company.findFirst({
      where: raw.companyNumber ? { companyNumber: raw.companyNumber } : { name: raw.companyName },
    });
    companyId = company?.id ?? null;
  }

  // Attach the signal to whoever controls the company, so it shows on the
  // person's timeline as well as the company's.
  let prospectId: string | null = null;
  if (companyId) {
    const holder = await prisma.shareholding.findFirst({
      where: { companyId, isCurrent: true },
      orderBy: { ownershipPctLow: "desc" },
      select: { prospectId: true },
    });
    prospectId = holder?.prospectId ?? null;
  }

  const sourceId = raw.source ? await upsertSource(raw.source) : null;

  const signal = await prisma.signal.create({
    data: {
      type: raw.type,
      title: raw.title,
      summary: raw.summary,
      occurredOn: raw.occurredOn,
      magnitudeGBP: raw.magnitudeGBP == null ? null : toBigInt(raw.magnitudeGBP),
      weight: raw.weight ?? 50,
      confidence: raw.confidence ?? 50,
      payload: (raw.payload ?? undefined) as object | undefined,
      dedupeKey: raw.dedupeKey,
      companyId,
      prospectId,
      sourceId,
    },
  });

  if (prospectId) {
    await prisma.prospectEvent.create({
      data: {
        prospectId,
        type: "signal_linked",
        message: raw.title,
        actor: "system:ingest",
      },
    });
  }

  return { id: signal.id, companyId, prospectId };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
