import type { Connector } from "./types";
import { emptyResult } from "./types";

/**
 * LinkedIn — deliberately read-only-by-hand.
 *
 * LinkedIn's User Agreement prohibits automated scraping, and the brief asks
 * for legally obtainable information only. So this "connector" never fetches
 * anything. It exists to (a) be visible on the automation page as an explicitly
 * manual source, and (b) generate the search URLs an advisor can open
 * themselves, with whatever they find entered as a MANUAL source carrying its
 * own citation.
 *
 * If the firm later licenses LinkedIn's Sales Navigator or Talent Solutions
 * API, this is the file to implement against it.
 */
export function createLinkedInConnector(): Connector {
  return {
    key: "linkedin",
    label: "LinkedIn (manual)",
    description:
      "Not automated. LinkedIn's terms prohibit scraping, so the dashboard generates search links for an advisor to review by hand and record findings as manual sources.",
    sourceType: "LINKEDIN",
    isAvailable: () => false,
    unavailableReason: () =>
      "Automated collection from LinkedIn is not permitted under its User Agreement. Use the per-prospect 'Search LinkedIn' link and record what you find as a manual note.",
    async run() {
      return emptyResult();
    },
  };
}

/** Deep link an advisor can click to check a person by hand. */
export function linkedInSearchUrl(fullName: string, companyName?: string | null): string {
  const q = [fullName, companyName].filter(Boolean).join(" ");
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}`;
}

/** The equivalent official-register link, which is always preferable. */
export function companiesHouseOfficerSearchUrl(fullName: string): string {
  return `https://find-and-update.company-information.service.gov.uk/search/officers?q=${encodeURIComponent(
    fullName,
  )}`;
}

export function companiesHouseCompanyUrl(companyNumber: string): string {
  return `https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(
    companyNumber,
  )}`;
}
