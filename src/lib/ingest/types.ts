import type { Region, SourceType, SignalType, EvidenceStrength, CorporateEventType } from "@/generated/prisma/enums";

/**
 * The normalised shape every connector emits. Connectors know about their own
 * source; they know nothing about the database, the wealth model, or each
 * other. The pipeline does the merging.
 */

export interface RawSource {
  url: string;
  title: string;
  publisher?: string;
  sourceType: SourceType;
  publishedAt?: Date;
  reliability?: number;
  excerpt?: string;
  licence?: string;
}

export interface RawFinancial {
  periodEnd: Date;
  periodLabel?: string;
  revenueGBP?: number | null;
  grossProfitGBP?: number | null;
  ebitdaGBP?: number | null;
  pretaxProfitGBP?: number | null;
  netAssetsGBP?: number | null;
  cashGBP?: number | null;
  employees?: number | null;
  dividendsDeclaredGBP?: number | null;
  isAbridged?: boolean;
  evidence?: EvidenceStrength;
}

export interface RawCompany {
  /** Companies House number is the primary identity where we have it. */
  companyNumber?: string;
  name: string;
  status?: string;
  incorporatedOn?: Date;
  industry?: string;
  sicCodes?: string[];
  region?: Region | null;
  officeLocation?: string;
  registeredAddress?: string;
  latitude?: number;
  longitude?: number;
  website?: string;
  employees?: number;
  financials?: RawFinancial[];
  fundingRounds?: RawFundingRound[];
  corporateEvents?: RawCorporateEvent[];
  filingHash?: string;
  sources: RawSource[];
}

export interface RawFundingRound {
  announcedOn: Date;
  stage: string;
  amountGBP?: number | null;
  preMoneyGBP?: number | null;
  postMoneyGBP?: number | null;
  investors?: string[];
  evidence?: EvidenceStrength;
  sources?: RawSource[];
}

export interface RawCorporateEvent {
  type: CorporateEventType;
  announcedOn: Date;
  completedOn?: Date | null;
  counterparty?: string;
  considerationGBP?: number | null;
  evidence?: EvidenceStrength;
  summary?: string;
  sources?: RawSource[];
}

export interface RawShareholding {
  companyNumber?: string;
  companyName: string;
  ownershipPctLow: number;
  ownershipPctHigh: number;
  shareClass?: string;
  basis?: string;
  evidence?: EvidenceStrength;
  asOf?: Date;
}

export interface RawPublicHolding {
  ticker?: string;
  companyName: string;
  shares?: number;
  percentHeld?: number;
  valueGBP?: number;
  asOf?: Date;
  evidence?: EvidenceStrength;
}

export interface RawDividend {
  companyNumber?: string;
  companyName: string;
  periodEnd: Date;
  totalGBP: number;
  /** Left null when the connector can't attribute a share to this person. */
  attributedGBP?: number | null;
  evidence?: EvidenceStrength;
}

export interface RawSignal {
  type: SignalType;
  title: string;
  summary?: string;
  occurredOn: Date;
  magnitudeGBP?: number | null;
  weight?: number;
  confidence?: number;
  payload?: Record<string, unknown>;
  /** Stable identity so re-runs update rather than duplicate. */
  dedupeKey: string;
  source?: RawSource;
  /** Company number the signal attaches to, if any. */
  companyNumber?: string;
  companyName?: string;
}

export interface RawProspect {
  fullName: string;
  occupation?: string;
  jobTitle?: string;
  officeLocation?: string;
  region: Region;
  latitude?: number;
  longitude?: number;
  chOfficerId?: string;
  identityConfidence?: number;
  linkedinUrl?: string;
  primaryCompanyNumber?: string;
  primaryCompanyName?: string;

  shareholdings?: RawShareholding[];
  publicHoldings?: RawPublicHolding[];
  dividends?: RawDividend[];
  remunerationGBP?: number | null;
  remunerationYears?: number;
  /** Published third-party wealth figures, e.g. a rich list entry. */
  reportedWealth?: Array<{ label: string; lowGBP: number; midGBP: number; highGBP: number; source: RawSource }>;

  sources: RawSource[];
}

export interface ConnectorResult {
  companies: RawCompany[];
  prospects: RawProspect[];
  signals: RawSignal[];
  /** Non-fatal problems worth surfacing on the automation page. */
  warnings: string[];
}

export interface ConnectorContext {
  /** Only look for material newer than this on incremental runs. */
  since: Date | null;
  /** Hard cap so a runaway connector can't burn the API quota. */
  maxRequests: number;
  log: (message: string) => void;
}

export interface Connector {
  key: string;
  label: string;
  description: string;
  /** Which public source this connector reads. */
  sourceType: SourceType;
  /** False when the connector lacks credentials or is disabled by config. */
  isAvailable: () => boolean;
  /** Why it isn't available, shown on the automation page. */
  unavailableReason?: () => string;
  run: (ctx: ConnectorContext) => Promise<ConnectorResult>;
}

export function emptyResult(): ConnectorResult {
  return { companies: [], prospects: [], signals: [], warnings: [] };
}
