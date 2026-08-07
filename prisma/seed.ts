/**
 * Demo dataset.
 *
 * IMPORTANT: every person and company below is FICTIONAL. This system holds
 * personal data about identifiable living people when it runs for real, so the
 * demo data must never contain unverified claims about actual individuals.
 * The seed marks the database as `demo`, and the UI shows a banner saying so
 * until a live connector run replaces it.
 *
 * Financials, ownership bands and events are modelled on the shape of real
 * Companies House filings so the wealth model is exercised realistically.
 *
 *   npm run db:seed
 */
import "../src/lib/load-env";
import { prisma, toBigInt } from "../src/lib/db";
import { slugify, startOfIsoWeek } from "../src/lib/utils";
import { recomputeAll, recomputeCompany, recomputeProspect } from "../src/lib/scoring/recompute";
import { deriveFinancialSignals } from "../src/lib/ingest/derive-signals";
import { generateAndStoreWeeklyReport } from "../src/lib/report/weekly";
import type {
  Region,
  CorporateEventType,
  EvidenceStrength,
  SignalType,
  LeadStatus,
  RelationshipStage,
} from "../src/generated/prisma/enums";

const YEAR = 365.25 * 24 * 3600 * 1000;
const now = Date.now();
const ago = (years: number) => new Date(now - years * YEAR);
const daysAgo = (days: number) => new Date(now - days * 24 * 3600 * 1000);

interface SeedCompany {
  name: string;
  companyNumber: string;
  industry: string;
  region: Region;
  officeLocation: string;
  lat: number;
  lng: number;
  incorporatedYearsAgo: number;
  employees: number;
  website?: string;
  /** Revenue in the most recent year, and the CAGR that produced it. */
  revenueGBP: number | null;
  revenueCagr: number;
  marginPct: number;
  cashGBP: number;
  netAssetsGBP: number;
  years: number;
  abridged?: boolean;
  dividendsGBP?: number[];
  fundingRounds?: Array<{ yearsAgo: number; stage: string; amountGBP: number; postMoneyGBP: number; investors: string[] }>;
  corporateEvents?: Array<{
    type: CorporateEventType;
    yearsAgo: number;
    completed?: boolean;
    counterparty?: string;
    considerationGBP?: number;
    summary?: string;
  }>;
}

interface SeedProspect {
  fullName: string;
  jobTitle: string;
  occupation: string;
  companyNumber: string;
  region: Region;
  officeLocation: string;
  lat: number;
  lng: number;
  ownershipLow: number;
  ownershipHigh: number;
  evidence?: EvidenceStrength;
  chOfficerId?: string;
  identityConfidence?: number;
  status?: LeadStatus;
  stage?: RelationshipStage;
  owner?: string;
  /** Share of company dividends attributed to this person, 0-1. */
  dividendShare?: number;
  publicHoldings?: Array<{ ticker: string; companyName: string; valueGBP: number; percentHeld?: number }>;
  extraSignals?: Array<{
    type: SignalType;
    title: string;
    summary: string;
    daysAgo: number;
    magnitudeGBP?: number;
    weight: number;
    confidence: number;
    sourceUrl: string;
    sourceTitle: string;
    publisher: string;
    sourceType?: "NEWS" | "PRESS_RELEASE" | "RNS_REGULATORY" | "PUBLIC_WEALTH_LIST" | "LAND_REGISTRY";
  }>;
  notes?: string[];
}

// ---------------------------------------------------------------------------
// Fictional companies
// ---------------------------------------------------------------------------

const COMPANIES: SeedCompany[] = [
  {
    name: "Trevanning Marine Systems Ltd",
    companyNumber: "SC900101",
    industry: "Marine & Leisure",
    region: "CORNWALL",
    officeLocation: "Falmouth",
    lat: 50.1531, lng: -5.0708,
    incorporatedYearsAgo: 16, employees: 210,
    revenueGBP: 34_800_000, revenueCagr: 0.14, marginPct: 17, cashGBP: 4_200_000, netAssetsGBP: 19_400_000,
    years: 5,
    dividendsGBP: [900_000, 1_400_000, 2_600_000, 3_100_000, 4_050_000],
  },
  {
    name: "Halberton Precision Engineering Ltd",
    companyNumber: "SC900102",
    industry: "Manufacturing & Engineering",
    region: "DEVON",
    officeLocation: "Exeter",
    lat: 50.7184, lng: -3.5339,
    incorporatedYearsAgo: 27, employees: 380,
    revenueGBP: 61_200_000, revenueCagr: 0.09, marginPct: 13, cashGBP: 7_800_000, netAssetsGBP: 33_000_000,
    years: 5,
    dividendsGBP: [1_800_000, 2_100_000, 2_400_000, 2_900_000, 3_300_000],
    corporateEvents: [
      {
        type: "ACQUISITION_OF", yearsAgo: 1.2, completed: true,
        counterparty: "Kingsbridge Toolworks Ltd", considerationGBP: 8_400_000,
        summary: "Bolt-on acquisition of a South Hams toolmaker, funded from cash reserves.",
      },
    ],
  },
  {
    name: "Quantock Renewables Group Ltd",
    companyNumber: "SC900103",
    industry: "Energy & Renewables",
    region: "SOMERSET",
    officeLocation: "Taunton",
    lat: 51.0147, lng: -3.1026,
    incorporatedYearsAgo: 11, employees: 95,
    revenueGBP: 28_500_000, revenueCagr: 0.31, marginPct: 24, cashGBP: 6_100_000, netAssetsGBP: 41_000_000,
    years: 5,
    dividendsGBP: [400_000, 800_000, 1_200_000, 2_200_000, 2_800_000],
    fundingRounds: [
      { yearsAgo: 1.6, stage: "PE growth capital", amountGBP: 22_000_000, postMoneyGBP: 118_000_000, investors: ["Meridian Growth Partners"] },
    ],
  },
  {
    name: "Avonmouth Logistics Holdings Ltd",
    companyNumber: "SC900104",
    industry: "Transport & Logistics",
    region: "BRISTOL",
    officeLocation: "Bristol",
    lat: 51.4998, lng: -2.6996,
    incorporatedYearsAgo: 21, employees: 640,
    revenueGBP: 128_000_000, revenueCagr: 0.11, marginPct: 8, cashGBP: 9_400_000, netAssetsGBP: 52_000_000,
    years: 5,
    dividendsGBP: [2_400_000, 2_900_000, 3_400_000, 3_900_000, 4_600_000],
  },
  {
    name: "Redcliffe Data Labs Ltd",
    companyNumber: "SC900105",
    industry: "Software & SaaS",
    region: "BRISTOL",
    officeLocation: "Bristol",
    lat: 51.4467, lng: -2.5879,
    incorporatedYearsAgo: 7, employees: 140,
    revenueGBP: 19_600_000, revenueCagr: 0.58, marginPct: 21, cashGBP: 12_800_000, netAssetsGBP: 15_200_000,
    years: 4,
    fundingRounds: [
      { yearsAgo: 3.4, stage: "Series A", amountGBP: 8_000_000, postMoneyGBP: 34_000_000, investors: ["Bramble Ventures"] },
      { yearsAgo: 0.8, stage: "Series B", amountGBP: 31_000_000, postMoneyGBP: 186_000_000, investors: ["Northgate Capital", "Bramble Ventures"] },
    ],
  },
  {
    name: "Cotswold Provisions Group Ltd",
    companyNumber: "SC900106",
    industry: "Food & Beverage",
    region: "GLOUCESTERSHIRE",
    officeLocation: "Cirencester",
    lat: 51.7186, lng: -1.9686,
    incorporatedYearsAgo: 32, employees: 420,
    revenueGBP: 74_500_000, revenueCagr: 0.07, marginPct: 11, cashGBP: 5_600_000, netAssetsGBP: 38_000_000,
    years: 5,
    dividendsGBP: [1_600_000, 1_900_000, 2_050_000, 2_300_000, 2_550_000],
  },
  {
    name: "Marlborough Clinical Holdings Ltd",
    companyNumber: "SC900107",
    industry: "Healthcare & Life Sciences",
    region: "WILTSHIRE",
    officeLocation: "Marlborough",
    lat: 51.4210, lng: -1.7280,
    incorporatedYearsAgo: 14, employees: 260,
    revenueGBP: 42_300_000, revenueCagr: 0.19, marginPct: 22, cashGBP: 8_900_000, netAssetsGBP: 29_500_000,
    years: 5,
    dividendsGBP: [1_100_000, 1_500_000, 2_000_000, 2_700_000, 3_200_000],
    corporateEvents: [
      {
        type: "ACQUIRED_BY", yearsAgo: 0.35, completed: false,
        counterparty: "Ardenhall Healthcare Partners",
        considerationGBP: 210_000_000,
        summary: "Exclusivity agreed with a European healthcare group; completion expected within six months.",
      },
    ],
  },
  {
    name: "Sandbanks Property Partners Ltd",
    companyNumber: "SC900108",
    industry: "Construction & Property",
    region: "DORSET",
    officeLocation: "Poole",
    lat: 50.7150, lng: -1.9872,
    incorporatedYearsAgo: 19, employees: 48,
    revenueGBP: null, revenueCagr: 0, marginPct: 0, cashGBP: 3_100_000, netAssetsGBP: 47_800_000,
    years: 4, abridged: true,
  },
  {
    name: "Solent Semiconductor Ltd",
    companyNumber: "SC900109",
    industry: "Technology",
    region: "HAMPSHIRE",
    officeLocation: "Southampton",
    lat: 50.9097, lng: -1.4044,
    incorporatedYearsAgo: 9, employees: 175,
    revenueGBP: 47_900_000, revenueCagr: 0.36, marginPct: 26, cashGBP: 16_400_000, netAssetsGBP: 44_000_000,
    years: 5,
    corporateEvents: [
      { type: "IPO", yearsAgo: 0.2, completed: false, summary: "Advisers appointed for a possible AIM listing." },
    ],
  },
  {
    name: "Chichester Wealth Advisory Group Ltd",
    companyNumber: "SC900110",
    industry: "Financial Services",
    region: "WEST_SUSSEX",
    officeLocation: "Chichester",
    lat: 50.8365, lng: -0.7792,
    incorporatedYearsAgo: 23, employees: 88,
    revenueGBP: 21_400_000, revenueCagr: 0.13, marginPct: 31, cashGBP: 7_200_000, netAssetsGBP: 18_600_000,
    years: 5,
    dividendsGBP: [1_900_000, 2_200_000, 2_600_000, 3_000_000, 3_450_000],
  },
  {
    name: "Weybridge Software Holdings Ltd",
    companyNumber: "SC900111",
    industry: "Software & SaaS",
    region: "SURREY",
    officeLocation: "Weybridge",
    lat: 51.3719, lng: -0.4581,
    incorporatedYearsAgo: 12, employees: 310,
    revenueGBP: 88_000_000, revenueCagr: 0.27, marginPct: 24, cashGBP: 22_000_000, netAssetsGBP: 61_000_000,
    years: 5,
    dividendsGBP: [2_800_000, 3_400_000, 4_100_000, 5_200_000, 6_400_000],
  },
  {
    name: "Thameside Payments Ltd",
    companyNumber: "SC900112",
    industry: "Fintech",
    region: "BERKSHIRE",
    officeLocation: "Reading",
    lat: 51.4543, lng: -0.9781,
    incorporatedYearsAgo: 8, employees: 205,
    revenueGBP: 33_700_000, revenueCagr: 0.49, marginPct: 9, cashGBP: 28_000_000, netAssetsGBP: 31_000_000,
    years: 4,
    fundingRounds: [
      { yearsAgo: 2.1, stage: "Series B", amountGBP: 24_000_000, postMoneyGBP: 142_000_000, investors: ["Kestrel Partners", "Aldgate Ventures"] },
      { yearsAgo: 0.45, stage: "Series C", amountGBP: 62_000_000, postMoneyGBP: 410_000_000, investors: ["Northgate Capital", "Kestrel Partners"] },
    ],
  },
  {
    name: "Bloomsbury Asset Management Ltd",
    companyNumber: "SC900113",
    industry: "Financial Services",
    region: "GREATER_LONDON",
    officeLocation: "City of London",
    lat: 51.5155, lng: -0.0922,
    incorporatedYearsAgo: 18, employees: 130,
    revenueGBP: 96_000_000, revenueCagr: 0.16, marginPct: 38, cashGBP: 34_000_000, netAssetsGBP: 78_000_000,
    years: 5,
    dividendsGBP: [8_200_000, 9_600_000, 11_400_000, 13_800_000, 16_200_000],
  },
  {
    name: "Shoreditch Creative Holdings Ltd",
    companyNumber: "SC900114",
    industry: "Media & Marketing",
    region: "GREATER_LONDON",
    officeLocation: "Hackney",
    lat: 51.5265, lng: -0.0784,
    incorporatedYearsAgo: 13, employees: 240,
    revenueGBP: 51_000_000, revenueCagr: 0.12, marginPct: 15, cashGBP: 6_800_000, netAssetsGBP: 22_000_000,
    years: 5,
    dividendsGBP: [1_200_000, 1_500_000, 1_800_000, 2_100_000, 2_400_000],
    corporateEvents: [
      {
        type: "TRADE_SALE", yearsAgo: 0.6, completed: true,
        counterparty: "Havas Lane Group", considerationGBP: 96_000_000,
        summary: "Majority stake sold to an international marketing group.",
      },
    ],
  },
  {
    name: "Wytham Bio Ltd",
    companyNumber: "SC900115",
    industry: "Healthcare & Life Sciences",
    region: "OXFORDSHIRE",
    officeLocation: "Oxford",
    lat: 51.7520, lng: -1.2577,
    incorporatedYearsAgo: 6, employees: 68,
    revenueGBP: 4_200_000, revenueCagr: 0.72, marginPct: -40, cashGBP: 31_000_000, netAssetsGBP: 33_500_000,
    years: 4,
    fundingRounds: [
      { yearsAgo: 2.8, stage: "Series A", amountGBP: 18_000_000, postMoneyGBP: 62_000_000, investors: ["Oxford Science Enterprises", "Bramble Ventures"] },
      { yearsAgo: 0.55, stage: "Series B", amountGBP: 54_000_000, postMoneyGBP: 295_000_000, investors: ["Wellcome Growth", "Northgate Capital"] },
    ],
  },
  {
    name: "Newbury Agritech Ltd",
    companyNumber: "SC900116",
    industry: "Agriculture & Land",
    region: "BERKSHIRE",
    officeLocation: "Newbury",
    lat: 51.4014, lng: -1.3231,
    incorporatedYearsAgo: 15, employees: 120,
    revenueGBP: 26_800_000, revenueCagr: 0.18, marginPct: 19, cashGBP: 4_400_000, netAssetsGBP: 24_000_000,
    years: 5,
    dividendsGBP: [700_000, 950_000, 1_300_000, 1_700_000, 2_150_000],
  },
  {
    name: "Guildford Diagnostics Ltd",
    companyNumber: "SC900117",
    industry: "Healthcare & Life Sciences",
    region: "SURREY",
    officeLocation: "Guildford",
    lat: 51.2362, lng: -0.5704,
    incorporatedYearsAgo: 10, employees: 155,
    revenueGBP: 31_500_000, revenueCagr: 0.23, marginPct: 20, cashGBP: 9_100_000, netAssetsGBP: 26_400_000,
    years: 5,
    dividendsGBP: [800_000, 1_100_000, 1_500_000, 2_000_000, 2_450_000],
  },
  {
    name: "Stroud Timber Systems Ltd",
    companyNumber: "SC900118",
    industry: "Construction & Property",
    region: "GLOUCESTERSHIRE",
    officeLocation: "Stroud",
    lat: 51.7457, lng: -2.2174,
    incorporatedYearsAgo: 24, employees: 190,
    revenueGBP: 38_200_000, revenueCagr: 0.06, marginPct: 9, cashGBP: 2_900_000, netAssetsGBP: 16_800_000,
    years: 5,
    dividendsGBP: [600_000, 700_000, 850_000, 900_000, 1_050_000],
  },
  {
    name: "Plymouth Sound Robotics Ltd",
    companyNumber: "SC900119",
    industry: "Manufacturing & Engineering",
    region: "DEVON",
    officeLocation: "Plymouth",
    lat: 50.3755, lng: -4.1427,
    incorporatedYearsAgo: 8, employees: 82,
    revenueGBP: 14_600_000, revenueCagr: 0.44, marginPct: 18, cashGBP: 5_300_000, netAssetsGBP: 11_200_000,
    years: 4,
    fundingRounds: [
      { yearsAgo: 1.1, stage: "Series A", amountGBP: 12_000_000, postMoneyGBP: 68_000_000, investors: ["Kestrel Partners"] },
    ],
  },
  {
    name: "Salisbury Defence Optics Ltd",
    companyNumber: "SC900120",
    industry: "Manufacturing & Engineering",
    region: "WILTSHIRE",
    officeLocation: "Salisbury",
    lat: 51.0688, lng: -1.7945,
    incorporatedYearsAgo: 20, employees: 145,
    revenueGBP: 29_400_000, revenueCagr: 0.15, marginPct: 23, cashGBP: 6_700_000, netAssetsGBP: 21_300_000,
    years: 5,
    dividendsGBP: [900_000, 1_200_000, 1_600_000, 2_100_000, 2_600_000],
  },
  {
    name: "Bournemouth Digital Care Ltd",
    companyNumber: "SC900121",
    industry: "Healthcare & Life Sciences",
    region: "DORSET",
    officeLocation: "Bournemouth",
    lat: 50.7192, lng: -1.8808,
    incorporatedYearsAgo: 7, employees: 96,
    revenueGBP: 12_900_000, revenueCagr: 0.39, marginPct: 14, cashGBP: 3_800_000, netAssetsGBP: 8_600_000,
    years: 4,
  },
  {
    name: "Winchester Legal Group LLP Holdings Ltd",
    companyNumber: "SC900122",
    industry: "Professional Services",
    region: "HAMPSHIRE",
    officeLocation: "Winchester",
    lat: 51.0632, lng: -1.3080,
    incorporatedYearsAgo: 26, employees: 210,
    revenueGBP: 44_800_000, revenueCagr: 0.08, marginPct: 28, cashGBP: 11_200_000, netAssetsGBP: 19_900_000,
    years: 5,
    dividendsGBP: [2_100_000, 2_400_000, 2_800_000, 3_200_000, 3_700_000],
  },
  {
    name: "Horsham Speciality Chemicals Ltd",
    companyNumber: "SC900123",
    industry: "Manufacturing & Engineering",
    region: "WEST_SUSSEX",
    officeLocation: "Horsham",
    lat: 51.0629, lng: -0.3260,
    incorporatedYearsAgo: 29, employees: 265,
    revenueGBP: 56_300_000, revenueCagr: 0.05, marginPct: 16, cashGBP: 8_400_000, netAssetsGBP: 34_700_000,
    years: 5,
    dividendsGBP: [1_400_000, 1_600_000, 1_750_000, 1_900_000, 2_200_000],
  },
  {
    name: "Truro Coastal Hospitality Ltd",
    companyNumber: "SC900124",
    industry: "Marine & Leisure",
    region: "CORNWALL",
    officeLocation: "Truro",
    lat: 50.2632, lng: -5.0510,
    incorporatedYearsAgo: 17, employees: 340,
    revenueGBP: 23_100_000, revenueCagr: 0.10, marginPct: 15, cashGBP: 2_700_000, netAssetsGBP: 26_900_000,
    years: 5,
    dividendsGBP: [500_000, 650_000, 800_000, 1_000_000, 1_250_000],
  },
  {
    name: "Mendip Water Technologies Ltd",
    companyNumber: "SC900125",
    industry: "Energy & Renewables",
    region: "SOMERSET",
    officeLocation: "Wells",
    lat: 51.2094, lng: -2.6480,
    incorporatedYearsAgo: 12, employees: 110,
    revenueGBP: 18_700_000, revenueCagr: 0.21, marginPct: 18, cashGBP: 3_600_000, netAssetsGBP: 14_100_000,
    years: 5,
    dividendsGBP: [400_000, 550_000, 750_000, 950_000, 1_200_000],
  },
  {
    name: "Banbury Industrial Automation Ltd",
    companyNumber: "SC900126",
    industry: "Manufacturing & Engineering",
    region: "OXFORDSHIRE",
    officeLocation: "Banbury",
    lat: 52.0629, lng: -1.3398,
    incorporatedYearsAgo: 22, employees: 230,
    revenueGBP: 49_600_000, revenueCagr: 0.12, marginPct: 14, cashGBP: 6_200_000, netAssetsGBP: 27_800_000,
    years: 5,
    dividendsGBP: [1_300_000, 1_550_000, 1_800_000, 2_150_000, 2_500_000],
  },
];

// ---------------------------------------------------------------------------
// Fictional prospects
// ---------------------------------------------------------------------------

const PROSPECTS: SeedProspect[] = [
  {
    fullName: "Imogen Trevanning", jobTitle: "Founder & Chief Executive", occupation: "Company Director",
    companyNumber: "SC900101", region: "CORNWALL", officeLocation: "Falmouth", lat: 50.1531, lng: -5.0708,
    ownershipLow: 50, ownershipHigh: 75, chOfficerId: "demo-officer-001", identityConfidence: 88,
    dividendShare: 0.62, status: "QUALIFIED", stage: "AWARE", owner: "RH",
    extraSignals: [
      {
        type: "LARGE_DIVIDEND", title: "£4.05m distribution declared at Trevanning Marine Systems",
        summary: "Filed accounts show a £4.05m dividend, the largest in the company's history.",
        daysAgo: 26, magnitudeGBP: 4_050_000, weight: 90, confidence: 88,
        sourceUrl: "https://find-and-update.company-information.service.gov.uk/company/SC900101/filing-history",
        sourceTitle: "Trevanning Marine Systems Ltd — filing history", publisher: "Companies House",
      },
    ],
    notes: ["Sponsors the Falmouth regatta — possible warm introduction via the sailing club."],
  },
  {
    fullName: "Gareth Halberton", jobTitle: "Chairman", occupation: "Company Director",
    companyNumber: "SC900102", region: "DEVON", officeLocation: "Exeter", lat: 50.7184, lng: -3.5339,
    ownershipLow: 25, ownershipHigh: 50, chOfficerId: "demo-officer-002", identityConfidence: 86,
    dividendShare: 0.4, status: "RESEARCHING", stage: "UNAWARE",
    extraSignals: [
      {
        type: "MA_ACTIVITY", title: "Halberton acquires Kingsbridge Toolworks for £8.4m",
        summary: "Cash acquisition of a South Hams toolmaker, funded from reserves.",
        daysAgo: 430, magnitudeGBP: 8_400_000, weight: 70, confidence: 65,
        sourceUrl: "https://www.business-live.co.uk/example/halberton-kingsbridge-acquisition",
        sourceTitle: "Exeter engineer buys South Hams toolmaker", publisher: "BusinessLive South West",
        sourceType: "NEWS",
      },
    ],
  },
  {
    fullName: "Priya Nadkarni", jobTitle: "Founder & Executive Chair", occupation: "Company Director",
    companyNumber: "SC900103", region: "SOMERSET", officeLocation: "Taunton", lat: 51.0147, lng: -3.1026,
    ownershipLow: 25, ownershipHigh: 50, chOfficerId: "demo-officer-003", identityConfidence: 90,
    dividendShare: 0.45, status: "QUALIFIED", stage: "INTRODUCED", owner: "RH",
    extraSignals: [
      {
        type: "PE_INVESTMENT", title: "Meridian Growth Partners invests £22m in Quantock Renewables",
        summary: "Minority growth investment at a reported £118m post-money valuation.",
        daysAgo: 584, magnitudeGBP: 22_000_000, weight: 80, confidence: 62,
        sourceUrl: "https://www.insidermedia.com/example/meridian-quantock",
        sourceTitle: "Meridian backs Somerset renewables group", publisher: "Insider Media South West",
        sourceType: "NEWS",
      },
    ],
    notes: ["PE minority holder will want an exit inside 4 years — time the approach for 2027."],
  },
  {
    fullName: "Duncan Avonmouth", jobTitle: "Managing Director", occupation: "Company Director",
    companyNumber: "SC900104", region: "BRISTOL", officeLocation: "Bristol", lat: 51.4998, lng: -2.6996,
    ownershipLow: 50, ownershipHigh: 75, chOfficerId: "demo-officer-004", identityConfidence: 84,
    dividendShare: 0.55, status: "CONTACTED", stage: "ENGAGED", owner: "JM",
  },
  {
    fullName: "Sofia Marchetti", jobTitle: "Co-founder & CTO", occupation: "Software Engineer",
    companyNumber: "SC900105", region: "BRISTOL", officeLocation: "Bristol", lat: 51.4467, lng: -2.5879,
    ownershipLow: 25, ownershipHigh: 50, chOfficerId: "demo-officer-005", identityConfidence: 82,
    status: "NEW", stage: "UNAWARE",
    extraSignals: [
      {
        type: "VENTURE_FUNDING", title: "Redcliffe Data Labs raises £31m Series B",
        summary: "Northgate Capital led a £31m round at a reported £186m post-money valuation.",
        daysAgo: 292, magnitudeGBP: 31_000_000, weight: 75, confidence: 60,
        sourceUrl: "https://www.uktech.news/example/redcliffe-series-b",
        sourceTitle: "Bristol data platform closes £31m Series B", publisher: "UKTN",
        sourceType: "NEWS",
      },
    ],
    notes: ["Pre-liquidity founder. Paper wealth only — build the relationship before any exit."],
  },
  {
    fullName: "Edward Pelling", jobTitle: "Chief Executive", occupation: "Company Director",
    companyNumber: "SC900106", region: "GLOUCESTERSHIRE", officeLocation: "Cirencester", lat: 51.7186, lng: -1.9686,
    ownershipLow: 25, ownershipHigh: 50, chOfficerId: "demo-officer-006", identityConfidence: 80,
    dividendShare: 0.35, status: "NURTURE", stage: "AWARE",
  },
  {
    fullName: "Alastair Wren", jobTitle: "Founder", occupation: "Company Director",
    companyNumber: "SC900107", region: "WILTSHIRE", officeLocation: "Marlborough", lat: 51.4210, lng: -1.7280,
    ownershipLow: 50, ownershipHigh: 75, chOfficerId: "demo-officer-007", identityConfidence: 92,
    dividendShare: 0.6, status: "QUALIFIED", stage: "INTRODUCED", owner: "RH",
    extraSignals: [
      {
        type: "MA_ACTIVITY", title: "Ardenhall in exclusive talks to buy Marlborough Clinical for £210m",
        summary: "Exclusivity agreed with a European healthcare group; completion expected within six months.",
        daysAgo: 128, magnitudeGBP: 210_000_000, weight: 95, confidence: 58,
        sourceUrl: "https://www.insidermedia.com/example/ardenhall-marlborough",
        sourceTitle: "Ardenhall closes in on Wiltshire clinical group", publisher: "Insider Media South West",
        sourceType: "NEWS",
      },
      {
        type: "FAMILY_OFFICE", title: "Wren family investment company incorporated",
        summary: "A new family investment company was registered at Companies House with Alastair Wren as sole PSC.",
        daysAgo: 74, weight: 85, confidence: 88,
        sourceUrl: "https://find-and-update.company-information.service.gov.uk/company/SC900107/filing-history",
        sourceTitle: "Companies House filing history", publisher: "Companies House",
      },
    ],
    notes: [
      "Highest-priority lead in the book: live sale process plus a family office being set up.",
      "Approach before completion — post-deal he will be inundated.",
    ],
  },
  {
    fullName: "Marianne Delacroix", jobTitle: "Director", occupation: "Property Developer",
    companyNumber: "SC900108", region: "DORSET", officeLocation: "Poole", lat: 50.7150, lng: -1.9872,
    ownershipLow: 75, ownershipHigh: 100, chOfficerId: "demo-officer-008", identityConfidence: 78,
    status: "RESEARCHING", stage: "UNAWARE",
    extraSignals: [
      {
        type: "PROPERTY_ACQUISITION", title: "Sandbanks waterfront site acquired for £14.2m",
        summary: "Land Registry records a £14.2m transfer of a Sandbanks development site.",
        daysAgo: 210, magnitudeGBP: 14_200_000, weight: 55, confidence: 80,
        sourceUrl: "https://www.gov.uk/government/organisations/land-registry",
        sourceTitle: "HM Land Registry price paid data", publisher: "HM Land Registry",
        sourceType: "LAND_REGISTRY",
      },
    ],
    notes: ["Abridged accounts — turnover not disclosed. Estimate rests on net assets, so treat with caution."],
  },
  {
    fullName: "Rowan Fitzhugh", jobTitle: "Founder & CEO", occupation: "Company Director",
    companyNumber: "SC900109", region: "HAMPSHIRE", officeLocation: "Southampton", lat: 50.9097, lng: -1.4044,
    ownershipLow: 25, ownershipHigh: 50, chOfficerId: "demo-officer-009", identityConfidence: 87,
    status: "QUALIFIED", stage: "AWARE", owner: "JM",
    extraSignals: [
      {
        type: "IPO_PREPARATION", title: "Solent Semiconductor appoints advisers for AIM listing",
        summary: "Brokers appointed ahead of a possible AIM admission in the next 12 months.",
        daysAgo: 68, weight: 85, confidence: 55,
        sourceUrl: "https://www.uktech.news/example/solent-semiconductor-aim",
        sourceTitle: "Hampshire chip designer eyes AIM float", publisher: "UKTN",
        sourceType: "NEWS",
      },
    ],
  },
  {
    fullName: "Helena Ashcombe", jobTitle: "Managing Partner", occupation: "Financial Adviser",
    companyNumber: "SC900110", region: "WEST_SUSSEX", officeLocation: "Chichester", lat: 50.8365, lng: -0.7792,
    ownershipLow: 50, ownershipHigh: 75, chOfficerId: "demo-officer-010", identityConfidence: 89,
    dividendShare: 0.58, status: "DISQUALIFIED", stage: "UNAWARE",
    notes: ["Competitor — runs her own advisory firm. Kept on file for market intelligence only."],
  },
  {
    fullName: "Charles Weybridge", jobTitle: "Executive Chairman", occupation: "Company Director",
    companyNumber: "SC900111", region: "SURREY", officeLocation: "Weybridge", lat: 51.3719, lng: -0.4581,
    ownershipLow: 50, ownershipHigh: 75, chOfficerId: "demo-officer-011", identityConfidence: 93,
    dividendShare: 0.62, status: "MEETING_BOOKED", stage: "PROPOSAL", owner: "RH",
    publicHoldings: [
      { ticker: "AVST", companyName: "Avonstone Group plc", valueGBP: 4_800_000, percentHeld: 1.2 },
    ],
    notes: ["Meeting booked for the 14th. Wants a discretionary mandate for the family trust."],
  },
  {
    fullName: "Yusuf Karadag", jobTitle: "Co-founder & CEO", occupation: "Company Director",
    companyNumber: "SC900112", region: "BERKSHIRE", officeLocation: "Reading", lat: 51.4543, lng: -0.9781,
    ownershipLow: 25, ownershipHigh: 50, chOfficerId: "demo-officer-012", identityConfidence: 85,
    status: "NEW", stage: "UNAWARE",
    extraSignals: [
      {
        type: "VENTURE_FUNDING", title: "Thameside Payments raises £62m Series C at £410m valuation",
        summary: "Northgate Capital led the round; the company confirmed the post-money valuation.",
        daysAgo: 164, magnitudeGBP: 62_000_000, weight: 80, confidence: 62,
        sourceUrl: "https://www.uktech.news/example/thameside-series-c",
        sourceTitle: "Reading fintech lands £62m Series C", publisher: "UKTN",
        sourceType: "NEWS",
      },
    ],
  },
  {
    fullName: "Victoria Bloomsbury", jobTitle: "Founding Partner", occupation: "Fund Manager",
    companyNumber: "SC900113", region: "GREATER_LONDON", officeLocation: "City of London", lat: 51.5155, lng: -0.0922,
    ownershipLow: 25, ownershipHigh: 50, chOfficerId: "demo-officer-013", identityConfidence: 91,
    dividendShare: 0.38, status: "QUALIFIED", stage: "AWARE", owner: "JM",
    publicHoldings: [
      { ticker: "BLMS", companyName: "Bloomsbury Investment Trust plc", valueGBP: 12_400_000, percentHeld: 3.4 },
    ],
    extraSignals: [
      {
        type: "SHARE_SALE", title: "Director sells 400,000 shares in Bloomsbury Investment Trust",
        summary: "TR-1 notification of a disposal realising approximately £3.1m.",
        daysAgo: 96, magnitudeGBP: 3_100_000, weight: 70, confidence: 90,
        sourceUrl: "https://www.londonstockexchange.com/news-article/example/tr-1-notification",
        sourceTitle: "TR-1: Standard form notification of major holdings", publisher: "London Stock Exchange RNS",
        sourceType: "RNS_REGULATORY",
      },
    ],
  },
  {
    fullName: "Nathaniel Osei", jobTitle: "Founder", occupation: "Company Director",
    companyNumber: "SC900114", region: "GREATER_LONDON", officeLocation: "Hackney", lat: 51.5265, lng: -0.0784,
    ownershipLow: 50, ownershipHigh: 75, chOfficerId: "demo-officer-014", identityConfidence: 90,
    dividendShare: 0.55, status: "QUALIFIED", stage: "ENGAGED", owner: "RH",
    extraSignals: [
      {
        type: "BUSINESS_EXIT", title: "Havas Lane buys majority of Shoreditch Creative for £96m",
        summary: "Founder sold a majority stake; completion confirmed in the company's press release.",
        daysAgo: 219, magnitudeGBP: 96_000_000, weight: 95, confidence: 72,
        sourceUrl: "https://www.business-live.co.uk/example/havas-lane-shoreditch",
        sourceTitle: "Havas Lane acquires London creative group", publisher: "BusinessLive",
        sourceType: "PRESS_RELEASE",
      },
    ],
    notes: ["Exit completed 7 months ago. Proceeds likely still in cash — highest urgency in the book."],
  },
  {
    fullName: "Eleanor Wytham", jobTitle: "Co-founder & Chief Scientific Officer", occupation: "Research Scientist",
    companyNumber: "SC900115", region: "OXFORDSHIRE", officeLocation: "Oxford", lat: 51.7520, lng: -1.2577,
    ownershipLow: 25, ownershipHigh: 50, chOfficerId: "demo-officer-015", identityConfidence: 83,
    status: "NEW", stage: "UNAWARE",
    extraSignals: [
      {
        type: "VENTURE_FUNDING", title: "Wytham Bio raises £54m Series B at £295m valuation",
        summary: "Wellcome Growth and Northgate Capital co-led the round.",
        daysAgo: 201, magnitudeGBP: 54_000_000, weight: 80, confidence: 60,
        sourceUrl: "https://www.uktech.news/example/wytham-bio-series-b",
        sourceTitle: "Oxford biotech raises £54m", publisher: "UKTN",
        sourceType: "NEWS",
      },
    ],
    notes: ["Loss-making — valuation is entirely round-price driven. Paper wealth, no liquidity."],
  },
  {
    fullName: "Thomas Cranleigh", jobTitle: "Managing Director", occupation: "Company Director",
    companyNumber: "SC900116", region: "BERKSHIRE", officeLocation: "Newbury", lat: 51.4014, lng: -1.3231,
    ownershipLow: 50, ownershipHigh: 75, chOfficerId: "demo-officer-016", identityConfidence: 81,
    dividendShare: 0.6, status: "RESEARCHING", stage: "UNAWARE",
  },
  {
    fullName: "Anita Rajaram", jobTitle: "Chief Executive", occupation: "Company Director",
    companyNumber: "SC900117", region: "SURREY", officeLocation: "Guildford", lat: 51.2362, lng: -0.5704,
    ownershipLow: 25, ownershipHigh: 50, chOfficerId: "demo-officer-017", identityConfidence: 86,
    dividendShare: 0.42, status: "CONTACTED", stage: "ENGAGED", owner: "JM",
  },
  {
    fullName: "Gordon Fairbairn", jobTitle: "Director", occupation: "Company Director",
    companyNumber: "SC900118", region: "GLOUCESTERSHIRE", officeLocation: "Stroud", lat: 51.7457, lng: -2.2174,
    ownershipLow: 50, ownershipHigh: 75, identityConfidence: 62,
    dividendShare: 0.65, status: "NEW", stage: "UNAWARE",
    notes: ["Not yet matched to a Companies House officer record — confirm identity before any outreach."],
  },
  {
    fullName: "Sian Morwenna", jobTitle: "Founder & CEO", occupation: "Company Director",
    companyNumber: "SC900119", region: "DEVON", officeLocation: "Plymouth", lat: 50.3755, lng: -4.1427,
    ownershipLow: 25, ownershipHigh: 50, chOfficerId: "demo-officer-019", identityConfidence: 84,
    status: "NEW", stage: "UNAWARE",
  },
  {
    fullName: "Peter Lansdowne", jobTitle: "Chairman", occupation: "Company Director",
    companyNumber: "SC900120", region: "WILTSHIRE", officeLocation: "Salisbury", lat: 51.0688, lng: -1.7945,
    ownershipLow: 50, ownershipHigh: 75, chOfficerId: "demo-officer-020", identityConfidence: 88,
    dividendShare: 0.58, status: "QUALIFIED", stage: "AWARE",
  },
  {
    fullName: "Grace Okonjo", jobTitle: "Founder", occupation: "Company Director",
    companyNumber: "SC900121", region: "DORSET", officeLocation: "Bournemouth", lat: 50.7192, lng: -1.8808,
    ownershipLow: 50, ownershipHigh: 75, chOfficerId: "demo-officer-021", identityConfidence: 79,
    status: "NEW", stage: "UNAWARE",
  },
  {
    fullName: "Rupert Wintersgill", jobTitle: "Senior Partner", occupation: "Solicitor",
    companyNumber: "SC900122", region: "HAMPSHIRE", officeLocation: "Winchester", lat: 51.0632, lng: -1.3080,
    ownershipLow: 25, ownershipHigh: 50, chOfficerId: "demo-officer-022", identityConfidence: 87,
    dividendShare: 0.3, status: "NURTURE", stage: "AWARE",
  },
  {
    fullName: "Beatrice Haldane", jobTitle: "Chief Executive", occupation: "Company Director",
    companyNumber: "SC900123", region: "WEST_SUSSEX", officeLocation: "Horsham", lat: 51.0629, lng: -0.3260,
    ownershipLow: 25, ownershipHigh: 50, chOfficerId: "demo-officer-023", identityConfidence: 85,
    dividendShare: 0.36, status: "RESEARCHING", stage: "UNAWARE",
  },
  {
    fullName: "Jago Penrose", jobTitle: "Owner", occupation: "Hotelier",
    companyNumber: "SC900124", region: "CORNWALL", officeLocation: "Truro", lat: 50.2632, lng: -5.0510,
    ownershipLow: 75, ownershipHigh: 100, chOfficerId: "demo-officer-024", identityConfidence: 90,
    dividendShare: 0.85, status: "NEW", stage: "UNAWARE",
  },
  {
    fullName: "Fiona Ashgrove", jobTitle: "Managing Director", occupation: "Company Director",
    companyNumber: "SC900125", region: "SOMERSET", officeLocation: "Wells", lat: 51.2094, lng: -2.6480,
    ownershipLow: 50, ownershipHigh: 75, chOfficerId: "demo-officer-025", identityConfidence: 82,
    dividendShare: 0.6, status: "NEW", stage: "UNAWARE",
  },
  {
    fullName: "Malcolm Ridgeway", jobTitle: "Chairman", occupation: "Company Director",
    companyNumber: "SC900126", region: "OXFORDSHIRE", officeLocation: "Banbury", lat: 52.0629, lng: -1.3398,
    ownershipLow: 25, ownershipHigh: 50, chOfficerId: "demo-officer-026", identityConfidence: 83,
    dividendShare: 0.4, status: "QUALIFIED", stage: "AWARE", owner: "JM",
  },
];

/**
 * Prospects dated inside the current ISO week, so the Monday report has a
 * populated "new prospects" section on a fresh install. All three are
 * pre-liquidity founders — the cohort the weekly sweep is most likely to
 * surface in reality.
 */
const NEW_THIS_WEEK = new Set([
  "Sofia Marchetti",
  "Yusuf Karadag",
  "Eleanor Wytham",
]);

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function main() {
  console.log("Clearing existing data …");
  // Order matters: children before parents.
  await prisma.$transaction([
    prisma.wealthSnapshot.deleteMany(),
    prisma.prospectEvent.deleteMany(),
    prisma.note.deleteMany(),
    prisma.signal.deleteMany(),
    prisma.dividendPayment.deleteMany(),
    prisma.publicHolding.deleteMany(),
    prisma.shareholding.deleteMany(),
    prisma.corporateEvent.deleteMany(),
    prisma.fundingRound.deleteMany(),
    prisma.companyFinancial.deleteMany(),
    prisma.citation.deleteMany(),
    prisma.prospect.deleteMany(),
    prisma.company.deleteMany(),
    prisma.source.deleteMany(),
    prisma.weeklyReport.deleteMany(),
    prisma.ingestRun.deleteMany(),
    prisma.systemState.deleteMany(),
  ]);

  await prisma.systemState.create({
    data: {
      key: "dataset.mode",
      value: {
        mode: "demo",
        note: "Fictional demonstration data. No real individual is described. Run an ingest with a Companies House API key to replace it.",
        seededAt: new Date().toISOString(),
      },
    },
  });

  console.log(`Seeding ${COMPANIES.length} companies …`);
  const companyIdByNumber = new Map<string, string>();

  for (const c of COMPANIES) {
    const chUrl = `https://find-and-update.company-information.service.gov.uk/company/${c.companyNumber}`;
    const source = await prisma.source.create({
      data: {
        url: chUrl,
        title: `${c.name} — Companies House register`,
        publisher: "Companies House",
        sourceType: "COMPANIES_HOUSE",
        reliability: 5,
        licence: "Companies House data — Open Government Licence v3.0",
        excerpt: `Registered company ${c.companyNumber}, incorporated ${ago(c.incorporatedYearsAgo).getFullYear()}, registered office in ${c.officeLocation}.`,
      },
    });

    const company = await prisma.company.create({
      data: {
        name: c.name,
        slug: slugify(`${c.name}-${c.companyNumber}`),
        companyNumber: c.companyNumber,
        status: "active",
        incorporatedOn: ago(c.incorporatedYearsAgo),
        industry: c.industry,
        sicCodes: [],
        region: c.region,
        officeLocation: c.officeLocation,
        registeredAddress: `${c.officeLocation}, United Kingdom`,
        latitude: c.lat,
        longitude: c.lng,
        website: c.website,
        employees: c.employees,
        chLastCheckedAt: daysAgo(2),
      },
    });
    companyIdByNumber.set(c.companyNumber, company.id);

    await prisma.citation.create({
      data: { sourceId: source.id, entityType: "company", entityId: company.id, field: "" },
    });

    // Financial history, newest last.
    const dividendsByPeriod: Array<{ periodEnd: Date; totalGBP: number }> = [];
    for (let i = c.years - 1; i >= 0; i--) {
      const periodEnd = ago(i + 0.4);
      const scale = Math.pow(1 + c.revenueCagr, -i);
      const revenue = c.revenueGBP === null ? null : Math.round(c.revenueGBP * scale);
      const pretax = revenue === null ? null : Math.round(revenue * (c.marginPct / 100));
      const ebitda = pretax === null ? null : Math.round(pretax * 1.18);
      const dividend = c.dividendsGBP?.[c.years - 1 - i] ?? null;

      await prisma.companyFinancial.create({
        data: {
          companyId: company.id,
          periodEnd,
          periodLabel: `FY${String(periodEnd.getFullYear()).slice(2)}`,
          revenueGBP: revenue === null ? null : toBigInt(revenue),
          ebitdaGBP: ebitda === null ? null : toBigInt(ebitda),
          pretaxProfitGBP: pretax === null ? null : toBigInt(pretax),
          netAssetsGBP: toBigInt(Math.round(c.netAssetsGBP * scale)),
          cashGBP: toBigInt(Math.round(c.cashGBP * scale)),
          employees: Math.round(c.employees * scale),
          dividendsDeclaredGBP: dividend === null ? null : toBigInt(dividend),
          isAbridged: c.abridged ?? false,
          evidence: "FILED",
        },
      });

      if (dividend) dividendsByPeriod.push({ periodEnd, totalGBP: dividend });
    }

    for (const r of c.fundingRounds ?? []) {
      await prisma.fundingRound.create({
        data: {
          companyId: company.id,
          announcedOn: ago(r.yearsAgo),
          stage: r.stage,
          amountGBP: toBigInt(r.amountGBP),
          postMoneyGBP: toBigInt(r.postMoneyGBP),
          preMoneyGBP: toBigInt(r.postMoneyGBP - r.amountGBP),
          investors: r.investors,
          evidence: "REPORTED",
        },
      });
    }

    for (const e of c.corporateEvents ?? []) {
      await prisma.corporateEvent.create({
        data: {
          companyId: company.id,
          type: e.type,
          announcedOn: ago(e.yearsAgo),
          completedOn: e.completed ? ago(e.yearsAgo - 0.1) : null,
          counterparty: e.counterparty,
          considerationGBP: e.considerationGBP ? toBigInt(e.considerationGBP) : null,
          evidence: "REPORTED",
          summary: e.summary,
        },
      });
    }

    // Signals that fall out of the filed numbers.
    for (const raw of deriveFinancialSignals({
      companyNumber: c.companyNumber,
      companyName: c.name,
      financials: (
        await prisma.companyFinancial.findMany({
          where: { companyId: company.id },
          orderBy: { periodEnd: "desc" },
        })
      ).map((f) => ({
        periodEnd: f.periodEnd,
        revenueGBP: f.revenueGBP === null ? null : Number(f.revenueGBP),
        ebitdaGBP: f.ebitdaGBP === null ? null : Number(f.ebitdaGBP),
        pretaxProfitGBP: f.pretaxProfitGBP === null ? null : Number(f.pretaxProfitGBP),
        netAssetsGBP: f.netAssetsGBP === null ? null : Number(f.netAssetsGBP),
        cashGBP: f.cashGBP === null ? null : Number(f.cashGBP),
        isAbridged: f.isAbridged,
      })),
      dividendsByPeriod,
    })) {
      await prisma.signal.create({
        data: {
          type: raw.type,
          title: raw.title,
          summary: raw.summary,
          occurredOn: raw.occurredOn,
          detectedAt: daysAgo(Math.random() * 40),
          magnitudeGBP: raw.magnitudeGBP == null ? null : toBigInt(raw.magnitudeGBP),
          weight: raw.weight ?? 50,
          confidence: raw.confidence ?? 50,
          payload: raw.payload as object,
          dedupeKey: raw.dedupeKey,
          companyId: company.id,
          sourceId: source.id,
        },
      });
    }
  }

  console.log(`Seeding ${PROSPECTS.length} prospects …`);
  for (const p of PROSPECTS) {
    const companyId = companyIdByNumber.get(p.companyNumber);
    if (!companyId) throw new Error(`Unknown company ${p.companyNumber} for ${p.fullName}`);
    const companySeed = COMPANIES.find((c) => c.companyNumber === p.companyNumber)!;

    const pscUrl = `https://find-and-update.company-information.service.gov.uk/company/${p.companyNumber}/persons-with-significant-control`;
    const pscSource = await prisma.source.upsert({
      where: { url: pscUrl },
      create: {
        url: pscUrl,
        title: `${companySeed.name} — persons with significant control`,
        publisher: "Companies House",
        sourceType: "COMPANIES_HOUSE",
        reliability: 5,
        licence: "Companies House data — Open Government Licence v3.0",
        excerpt: `PSC register entry recording ownership of shares, ${p.ownershipLow}% to ${p.ownershipHigh}%.`,
      },
      update: {},
    });

    // A few prospects land inside the current ISO week so the Monday report
    // and the "new this week" KPI have something real to show; the rest are
    // spread deterministically over the preceding months.
    const index = PROSPECTS.indexOf(p);
    const isNewThisWeek = NEW_THIS_WEEK.has(p.fullName);
    const dateAdded = isNewThisWeek
      ? new Date(startOfIsoWeek().getTime() + (index % 3) * 7 * 3600 * 1000 + 9 * 3600 * 1000)
      : daysAgo(9 + index * 6);

    const prospect = await prisma.prospect.create({
      data: {
        fullName: p.fullName,
        slug: slugify(`${p.fullName}-${p.companyNumber}`),
        occupation: p.occupation,
        jobTitle: p.jobTitle,
        companyId,
        officeLocation: p.officeLocation,
        region: p.region,
        latitude: p.lat,
        longitude: p.lng,
        chOfficerId: p.chOfficerId,
        identityConfidence: p.identityConfidence ?? 60,
        status: p.status ?? "NEW",
        relationshipStage: p.stage ?? "UNAWARE",
        owner: p.owner,
        dateAdded,
      },
    });

    await prisma.citation.createMany({
      data: [
        { sourceId: pscSource.id, entityType: "prospect", entityId: prospect.id, field: "" },
      ],
    });

    await prisma.prospectEvent.create({
      data: {
        prospectId: prospect.id,
        type: "created",
        message: "Identified from the Companies House PSC register.",
        actor: "system:ingest",
        createdAt: dateAdded,
      },
    });

    const shareholding = await prisma.shareholding.create({
      data: {
        prospectId: prospect.id,
        companyId,
        ownershipPctLow: p.ownershipLow,
        ownershipPctHigh: p.ownershipHigh,
        shareClass: "ORDINARY",
        basis: `PSC register: ownership-of-shares-${p.ownershipLow}-to-${p.ownershipHigh}-percent`,
        evidence: p.evidence ?? "FILED",
        asOf: ago(1.5),
      },
    });

    await prisma.citation.create({
      data: {
        sourceId: pscSource.id,
        entityType: "shareholding",
        entityId: shareholding.id,
        field: "ownershipPct",
        note: `PSC register band ${p.ownershipLow}–${p.ownershipHigh}%`,
      },
    });

    // Attribute company dividends to the individual by ownership.
    if (p.dividendShare && companySeed.dividendsGBP) {
      for (const [i, total] of companySeed.dividendsGBP.entries()) {
        const periodEnd = ago(companySeed.years - 1 - i + 0.4);
        await prisma.dividendPayment.create({
          data: {
            companyId,
            prospectId: prospect.id,
            periodEnd,
            totalGBP: toBigInt(total),
            attributedGBP: toBigInt(total * p.dividendShare),
            evidence: "FILED",
          },
        });
      }
    }

    for (const h of p.publicHoldings ?? []) {
      await prisma.publicHolding.create({
        data: {
          prospectId: prospect.id,
          ticker: h.ticker,
          companyName: h.companyName,
          valueGBP: toBigInt(h.valueGBP),
          percentHeld: h.percentHeld,
          asOf: daysAgo(30),
          evidence: "DISCLOSED",
        },
      });
    }

    for (const s of p.extraSignals ?? []) {
      const src = await prisma.source.upsert({
        where: { url: s.sourceUrl },
        create: {
          url: s.sourceUrl,
          title: s.sourceTitle,
          publisher: s.publisher,
          sourceType: s.sourceType ?? "COMPANIES_HOUSE",
          publishedAt: daysAgo(s.daysAgo),
          reliability: s.sourceType === "NEWS" ? 3 : s.sourceType === "PRESS_RELEASE" ? 3 : 5,
          excerpt: s.summary,
        },
        update: {},
      });
      await prisma.signal.create({
        data: {
          type: s.type,
          title: s.title,
          summary: s.summary,
          occurredOn: daysAgo(s.daysAgo),
          detectedAt: daysAgo(Math.max(0, s.daysAgo - 2)),
          magnitudeGBP: s.magnitudeGBP ? toBigInt(s.magnitudeGBP) : null,
          weight: s.weight,
          confidence: s.confidence,
          dedupeKey: `seed:${prospect.id}:${s.type}:${s.daysAgo}`,
          prospectId: prospect.id,
          companyId,
          sourceId: src.id,
        },
      });
      await prisma.citation.upsert({
        where: {
          sourceId_entityType_entityId_field: {
            sourceId: src.id, entityType: "prospect", entityId: prospect.id, field: "",
          },
        },
        create: { sourceId: src.id, entityType: "prospect", entityId: prospect.id, field: "" },
        update: {},
      });
    }

    for (const body of p.notes ?? []) {
      await prisma.note.create({
        data: { prospectId: prospect.id, body, author: p.owner ?? "RH" },
      });
    }
  }

  console.log("Running valuation, wealth and confidence models …");
  const counts = await recomputeAll();
  console.log(`  valued ${counts.companies} companies, scored ${counts.prospects} prospects`);

  // Backfill 14 weeks of snapshots so the trend charts have history. Earlier
  // weeks are scaled down slightly to represent the book growing over time.
  console.log("Backfilling wealth snapshots …");
  const prospects = await prisma.prospect.findMany({
    select: {
      id: true, dateAdded: true, estGrossWealthMidGBP: true,
      estInvestableMidGBP: true, confidence: true, wealthBand: true,
    },
  });
  for (let week = 14; week >= 1; week--) {
    const takenAt = daysAgo(week * 7);
    const drift = 1 - week * 0.011;
    const rows = prospects
      .filter((p) => p.dateAdded <= takenAt)
      .map((p) => ({
        prospectId: p.id,
        takenAt,
        estGrossMidGBP: toBigInt(Number(p.estGrossWealthMidGBP) * drift),
        estInvestableMidGBP: toBigInt(Number(p.estInvestableMidGBP) * drift),
        confidence: Math.max(10, Math.round(p.confidence - week * 0.6)),
        wealthBand: p.wealthBand,
      }));
    if (rows.length) await prisma.wealthSnapshot.createMany({ data: rows });
  }

  // A genuine movement inside the current week, so the Monday report has a real
  // change to describe rather than an artefact of seeding: the Marlborough
  // Clinical sale, previously only announced, completes.
  console.log("Simulating this week's completed transaction …");
  const marlborough = companyIdByNumber.get("SC900107");
  if (marlborough) {
    const pending = await prisma.corporateEvent.findFirst({
      where: { companyId: marlborough, type: "ACQUIRED_BY" },
    });
    if (pending) {
      await prisma.corporateEvent.update({
        where: { id: pending.id },
        data: { completedOn: daysAgo(1) },
      });
      const chSource = await prisma.source.findFirst({
        where: { url: { contains: "SC900107" }, sourceType: "COMPANIES_HOUSE" },
      });
      await prisma.signal.create({
        data: {
          type: "BUSINESS_EXIT",
          title: "Ardenhall completes £210m acquisition of Marlborough Clinical",
          summary:
            "The disposal announced earlier in the year has completed, converting the founder's shareholding into realised proceeds.",
          occurredOn: daysAgo(1),
          detectedAt: daysAgo(1),
          magnitudeGBP: toBigInt(210_000_000),
          weight: 95,
          confidence: 75,
          dedupeKey: "seed:marlborough:completion",
          companyId: marlborough,
          prospectId: (
            await prisma.shareholding.findFirst({
              where: { companyId: marlborough },
              select: { prospectId: true },
            })
          )?.prospectId,
          sourceId: chSource?.id,
        },
      });
      await recomputeCompany(marlborough);
      const holders = await prisma.shareholding.findMany({
        where: { companyId: marlborough },
        select: { prospectId: true },
      });
      for (const h of holders) await recomputeProspect(h.prospectId);
    }
  }

  // Today's snapshot, taken after the movement so the trend shows the step.
  const current = await prisma.prospect.findMany({
    select: {
      id: true,
      estGrossWealthMidGBP: true,
      estInvestableMidGBP: true,
      confidence: true,
      wealthBand: true,
    },
  });
  await prisma.wealthSnapshot.createMany({
    data: current.map((p) => ({
      prospectId: p.id,
      estGrossMidGBP: p.estGrossWealthMidGBP,
      estInvestableMidGBP: p.estInvestableMidGBP,
      confidence: p.confidence,
      wealthBand: p.wealthBand,
    })),
  });

  // A couple of completed ingest runs so the automation page isn't empty.
  for (let week = 3; week >= 1; week--) {
    await prisma.ingestRun.create({
      data: {
        trigger: "CRON_WEEKLY",
        status: "SUCCESS",
        startedAt: daysAgo(week * 7),
        finishedAt: new Date(daysAgo(week * 7).getTime() + 94_000),
        connectorsRun: ["companies-house", "business-news"],
        stats: {
          sourcesUpserted: 40 + week * 7,
          companiesUpserted: 12 + week,
          prospectsCreated: week === 1 ? 3 : 2,
          prospectsUpdated: 14,
          signalsCreated: 8 + week,
          prospectsRecomputed: 26,
          snapshotsTaken: 26,
        },
      },
    });
  }

  console.log("Generating weekly reports …");
  for (let week = 3; week >= 0; week--) {
    const ref = new Date(startOfIsoWeek().getTime() - week * 7 * 24 * 3600 * 1000);
    await generateAndStoreWeeklyReport(ref);
  }

  const [companies, prospectCount, signals, sources] = await Promise.all([
    prisma.company.count(),
    prisma.prospect.count(),
    prisma.signal.count(),
    prisma.source.count(),
  ]);
  console.log(
    `\nDone. ${companies} companies · ${prospectCount} prospects · ${signals} signals · ${sources} cited sources.`,
  );
  console.log("Dataset is marked DEMO — every person and company in it is fictional.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
