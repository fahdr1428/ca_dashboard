import type { SignalType, SourceType, CorporateEventType } from "@/generated/prisma/enums";

export const SIGNAL_LABELS: Record<SignalType, string> = {
  LARGE_DIVIDEND: "Large dividend",
  REVENUE_GROWTH: "Revenue growth",
  HIGH_PROFITABILITY: "High profitability",
  PE_INVESTMENT: "PE investment",
  VENTURE_FUNDING: "Venture funding",
  MA_ACTIVITY: "M&A activity",
  IPO_PREPARATION: "IPO preparation",
  DIRECTOR_APPOINTMENT: "Director appointment",
  SHARE_SALE: "Share sale",
  PROPERTY_ACQUISITION: "Property acquisition",
  PUBLIC_INVESTMENT: "Public investment",
  FAMILY_OFFICE: "Family office",
  LIQUIDITY_EVENT: "Liquidity event",
  BUSINESS_EXIT: "Business exit",
  INHERITANCE: "Inheritance",
  HIGH_REMUNERATION: "High remuneration",
  WEALTH_LIST_ENTRY: "Wealth list entry",
  FILING_UPDATE: "Filing update",
  NEWS_MENTION: "News mention",
  PSC_CHANGE: "PSC change",
};

/** Signals grouped the way an advisor thinks about them. */
export const SIGNAL_GROUPS: Array<{ label: string; types: SignalType[] }> = [
  {
    label: "Liquidity",
    types: ["BUSINESS_EXIT", "LIQUIDITY_EVENT", "SHARE_SALE", "MA_ACTIVITY", "IPO_PREPARATION"],
  },
  {
    label: "Cash to the individual",
    types: ["LARGE_DIVIDEND", "HIGH_REMUNERATION", "INHERITANCE"],
  },
  {
    label: "Company momentum",
    types: ["REVENUE_GROWTH", "HIGH_PROFITABILITY", "VENTURE_FUNDING", "PE_INVESTMENT"],
  },
  {
    label: "Wealth behaviour",
    types: ["FAMILY_OFFICE", "PROPERTY_ACQUISITION", "PUBLIC_INVESTMENT", "WEALTH_LIST_ENTRY"],
  },
  {
    label: "Register activity",
    types: ["PSC_CHANGE", "DIRECTOR_APPOINTMENT", "FILING_UPDATE", "NEWS_MENTION"],
  },
];

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  COMPANIES_HOUSE: "Companies House",
  COMPANY_ACCOUNTS: "Filed accounts",
  RNS_REGULATORY: "Regulatory (RNS)",
  PRESS_RELEASE: "Press release",
  NEWS: "News",
  FUNDING_DATABASE: "Funding database",
  OPEN_DATASET: "Open dataset",
  PUBLIC_WEALTH_LIST: "Public wealth list",
  LAND_REGISTRY: "Land Registry",
  CHARITY_COMMISSION: "Charity Commission",
  LINKEDIN: "LinkedIn",
  COMPANY_WEBSITE: "Company website",
  MANUAL: "Manual research",
};

export const EVIDENCE_LABELS: Record<string, string> = {
  FILED: "Filed",
  DISCLOSED: "Disclosed",
  REPORTED: "Reported",
  MODELLED: "Modelled",
  ASSERTED: "Asserted",
};

export const EVIDENCE_DESCRIPTIONS: Record<string, string> = {
  FILED: "Stated in a statutory filing — the strongest evidence available.",
  DISCLOSED: "Stated in a regulated disclosure or an official company release.",
  REPORTED: "Stated by credible journalism, not verified against the register.",
  MODELLED: "Derived by this system from filed inputs. An estimate.",
  ASSERTED: "Entered by an advisor from their own research.",
};

export const CORPORATE_EVENT_LABELS: Record<CorporateEventType, string> = {
  ACQUISITION_OF: "Acquisition made",
  ACQUIRED_BY: "Acquired by",
  MERGER: "Merger",
  IPO: "IPO",
  MBO: "Management buyout",
  SECONDARY_SALE: "Secondary sale",
  TRADE_SALE: "Trade sale",
  ADMINISTRATION: "Administration",
};
