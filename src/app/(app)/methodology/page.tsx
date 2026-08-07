import { ShieldCheck, Scale, Calculator, Database, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { Card, CardHeader, Badge } from "@/components/ui";
import { ASSUMPTIONS, ASSUMPTION_NOTES, MODEL_VERSION } from "@/lib/scoring/assumptions";
import { SECTORS } from "@/lib/scoring/valuation";
import { CONFIDENCE_BANDS, WEALTH_BANDS, QUALIFYING_THRESHOLD_GBP, PRIORITY_THRESHOLD_GBP, formatGBP } from "@/lib/wealth";
import { COMPONENT_LABELS } from "@/lib/scoring/estimate";
import { EVIDENCE_LABELS, EVIDENCE_DESCRIPTIONS } from "@/lib/signal-labels";
import { REGIONS, REGION_META } from "@/lib/regions";

export const metadata = { title: "Methodology — Lead Intelligence" };

export default function MethodologyPage() {
  return (
    <>
      <PageHeader
        title="Methodology"
        description={`How every number in this dashboard is produced, what it assumes, and where it can be wrong. Wealth model v${MODEL_VERSION}.`}
      />

      <div className="px-5 pb-10 space-y-4 max-w-5xl">
        <Card className="border-signal/40 bg-signal-soft/40">
          <div className="px-5 py-4 flex gap-3">
            <AlertTriangle className="size-4 text-signal shrink-0 mt-0.5" />
            <div className="space-y-2 text-[13px] leading-relaxed">
              <p className="font-semibold text-ink">
                Every monetary figure in this system is an estimate, not a fact.
              </p>
              <p className="text-ink-2">
                Nothing here tells you what someone is worth. It tells you what a model infers from
                public filings and press coverage, together with how much of that inference is
                evidenced. Ranges are wide on purpose: a single point estimate would imply a
                precision the underlying data does not support. Before acting on a record, open its
                sources and check them.
              </p>
            </div>
          </div>
        </Card>

        {/* Scope */}
        <Card>
          <CardHeader
            title={<Section icon={<Database className="size-3.5" />}>Scope and thresholds</Section>}
          />
          <div className="px-5 pb-4 space-y-3 text-[13px] leading-relaxed text-ink-2">
            <p>
              Only individuals connected to the following {REGIONS.length} counties are tracked. A
              record whose location cannot be resolved to one of them is discarded rather than
              guessed at:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {REGIONS.map((r) => (
                <Badge key={r} tone="outline">
                  {REGION_META[r].label}
                </Badge>
              ))}
            </div>
            <p>Two cohorts are tracked, because they need different handling:</p>
            <ul className="space-y-1.5 pl-4 list-disc marker:text-ink-3">
              <li>
                <strong className="text-ink">Qualifying</strong> — estimated investable assets of{" "}
                {formatGBP(QUALIFYING_THRESHOLD_GBP)} or more. A discretionary mandate could be
                written today.
              </li>
              <li>
                <strong className="text-ink">Pre-liquidity founders</strong> — gross estimated
                wealth of {formatGBP(PRIORITY_THRESHOLD_GBP)} or more, but investable assets below
                the threshold. Almost always unrealised founder equity. Not a mandate today, but the
                relationship has to exist before the exit.
              </li>
            </ul>
          </div>
        </Card>

        {/* Wealth model */}
        <Card>
          <CardHeader
            title={<Section icon={<Calculator className="size-3.5" />}>The wealth model</Section>}
            subtitle="Gross wealth is the sum of six components. Investable assets apply a liquidity factor to each."
          />
          <div className="px-5 pb-4 space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              {Object.entries(COMPONENT_LABELS).map(([key, label]) => (
                <div key={key} className="rounded-lg border border-line p-2.5">
                  <div className="text-[12px] font-medium">{label}</div>
                  <p className="mt-0.5 text-[11px] text-ink-3 leading-relaxed">
                    {COMPONENT_EXPLANATIONS[key]}
                  </p>
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-line bg-canvas p-3">
              <p className="text-[12px] text-ink-2 leading-relaxed">
                The distinction that matters most is between <strong>gross</strong> and{" "}
                <strong>investable</strong>. A founder holding 60% of a business valued at £80m has
                a large gross figure and almost nothing a discretionary manager can invest, because
                the shares cannot be sold. Only {(ASSUMPTIONS.liquidityPrivateStake * 100).toFixed(0)}%
                of an unquoted stake is counted as investable — rising to{" "}
                {(ASSUMPTIONS.liquidityPrivateStakeInExit * 100).toFixed(0)}% when a live sale
                process is detected. Realised proceeds, by contrast, count at{" "}
                {(ASSUMPTIONS.liquidityRealisedExit * 100).toFixed(0)}%.
              </p>
            </div>

            <p className="text-[12px] text-ink-2 leading-relaxed">
              Low and high bounds are produced by pairing the pessimistic inputs together and the
              optimistic inputs together — a low ownership bound against a low valuation, and vice
              versa. That widens the range relative to a naive calculation, which is the honest
              result when two independent quantities are both uncertain.
            </p>
          </div>
        </Card>

        {/* Assumptions */}
        <Card>
          <CardHeader
            title="Model assumptions"
            subtitle="Every constant the model uses. If you disagree with one, change it in src/lib/scoring/assumptions.ts and re-run the estimate."
          />
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-y border-line text-left text-[11px] uppercase tracking-wide text-ink-3">
                  <th className="px-5 py-2 font-medium">Assumption</th>
                  <th className="px-3 py-2 font-medium text-right">Value</th>
                  <th className="px-5 py-2 font-medium">Effect</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(ASSUMPTIONS).map(([key, value]) => (
                  <tr key={key} className="border-b border-line last:border-0">
                    <td className="px-5 py-2 font-mono text-[11px] whitespace-nowrap">{key}</td>
                    <td className="px-3 py-2 text-right tabular whitespace-nowrap">
                      {formatAssumption(key, value as number)}
                    </td>
                    <td className="px-5 py-2 text-[12px] text-ink-2 leading-relaxed">
                      {ASSUMPTION_NOTES[key as keyof typeof ASSUMPTIONS]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Valuation */}
        <Card>
          <CardHeader
            title="Company valuation"
            subtitle="Applied in order of evidence quality. The method used is always shown next to the number."
          />
          <div className="px-5 pb-4 space-y-2 text-[13px] leading-relaxed text-ink-2">
            <ol className="space-y-1.5 pl-5 list-decimal marker:text-ink-3">
              <li>
                <strong className="text-ink">A priced transaction.</strong> A funding round or
                completed deal is a real price agreed between real parties, so it beats any model.
                The range widens as the price ages.
              </li>
              <li>
                <strong className="text-ink">EBITDA multiple</strong> against sector comparables,
                plus net cash, adjusted for revenue growth.
              </li>
              <li>
                <strong className="text-ink">Revenue multiple</strong>, when the business is
                loss-making or EBITDA is not disclosed. A blunt instrument, and flagged as such.
              </li>
              <li>
                <strong className="text-ink">Filed net assets</strong>, used as a floor when nothing
                else is available.
              </li>
            </ol>
            <p className="pt-1">
              Sector comparables are held for: {SECTORS.join(", ")}. Anything unmatched falls back to
              a generic 5–10× EBITDA band.
            </p>
            <p className="rounded-lg border border-line bg-canvas p-2.5 text-[12px]">
              <strong className="text-ink">Known limitation:</strong> small companies filing
              abridged accounts do not disclose turnover, and Companies House does not publish debt
              in a structured form. Valuations for those companies are materially less reliable, and
              the model widens their range by{" "}
              {(ASSUMPTIONS.abridgedAccountsSpread * 100).toFixed(0)}% rather than pretending
              otherwise.
            </p>
          </div>
        </Card>

        {/* Confidence */}
        <Card>
          <CardHeader
            title="Confidence scoring"
            subtitle="A separate question from wealth: how much should this record be trusted?"
          />
          <div className="px-5 pb-4 space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              {CONFIDENCE_DIMENSIONS.map((d) => (
                <div key={d.label} className="rounded-lg border border-line p-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[12px] font-medium">{d.label}</span>
                    <span className="text-[11px] tabular text-ink-3">{d.weight}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-ink-3 leading-relaxed">{d.description}</p>
                </div>
              ))}
            </div>
            <div className="space-y-1.5">
              {CONFIDENCE_BANDS.map((b) => (
                <div key={b.key} className="flex items-baseline gap-3">
                  <Badge tone={b.min >= 68 ? "accent" : b.min >= 45 ? "signal" : "danger"}>
                    {b.label} {b.min}+
                  </Badge>
                  <span className="text-[12px] text-ink-2 leading-relaxed">{b.description}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>

        {/* Evidence grades */}
        <Card>
          <CardHeader title="Evidence grades" subtitle="Attached to every stored claim." />
          <div className="px-5 pb-4 space-y-1.5">
            {Object.entries(EVIDENCE_LABELS).map(([key, label]) => (
              <div key={key} className="flex items-baseline gap-3">
                <Badge tone="outline" className="w-20 justify-center">
                  {label}
                </Badge>
                <span className="text-[12px] text-ink-2 leading-relaxed">
                  {EVIDENCE_DESCRIPTIONS[key]}
                </span>
              </div>
            ))}
          </div>
        </Card>

        {/* Bands */}
        <Card>
          <CardHeader title="Wealth bands" subtitle="Applied to estimated investable assets." />
          <div className="px-5 pb-4 flex flex-wrap gap-2">
            {WEALTH_BANDS.map((b) => (
              <span
                key={b.key}
                className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[12px]"
              >
                <span
                  className="size-2 rounded-full"
                  style={{ background: `var(--color-band-${b.tone})` }}
                />
                {b.label}
              </span>
            ))}
          </div>
        </Card>

        {/* Sources & legal */}
        <Card>
          <CardHeader
            title={<Section icon={<Scale className="size-3.5" />}>Sources and lawful use</Section>}
          />
          <div className="px-5 pb-4 space-y-3 text-[13px] leading-relaxed text-ink-2">
            <p>
              Only publicly available, lawfully obtainable information is used. Nothing leaked,
              confidential, purchased from a data broker, or obtained behind a login is ingested.
            </p>
            <ul className="space-y-1.5 pl-4 list-disc marker:text-ink-3">
              <li>
                <strong className="text-ink">Companies House</strong> — the register, PSC filings,
                filed accounts and filing history, via the free public API under the Open Government
                Licence v3.0. This is the system&apos;s primary and most reliable source, and the
                only one used to verify ownership.
              </li>
              <li>
                <strong className="text-ink">Business news and press releases</strong> — read from
                publisher-provided RSS feeds only. Article bodies are not scraped and paywalls are
                not circumvented. Everything derived this way is graded <em>Reported</em> and needs
                verification against the register before it is relied on.
              </li>
              <li>
                <strong className="text-ink">Regulatory disclosures</strong> — RNS announcements and
                major-holdings notifications, which are published for exactly this purpose.
              </li>
              <li>
                <strong className="text-ink">LinkedIn</strong> — never automated. LinkedIn&apos;s
                User Agreement prohibits scraping, so the dashboard only generates a search link for
                an advisor to open by hand; anything found is recorded as a manual note.
              </li>
              <li>
                <strong className="text-ink">Boundary data</strong> — ONS local authority districts,
                © Crown copyright and database right, Open Government Licence v3.0.
              </li>
            </ul>
          </div>
        </Card>

        <Card>
          <CardHeader
            title={<Section icon={<ShieldCheck className="size-3.5" />}>Data protection</Section>}
            subtitle="This system processes personal data about identifiable living people. That carries obligations."
          />
          <div className="px-5 pb-4 space-y-3 text-[13px] leading-relaxed text-ink-2">
            <p>
              Building a profile of someone&apos;s wealth from public sources is still processing
              personal data under UK GDPR. Publicly available does not mean unregulated. Points your
              firm needs to have settled before using this in anger:
            </p>
            <ul className="space-y-1.5 pl-4 list-disc marker:text-ink-3">
              <li>
                <strong className="text-ink">Lawful basis.</strong> Legitimate interests is the usual
                basis for prospecting, and it requires a documented balancing test weighing your
                commercial interest against the individual&apos;s reasonable expectations.
              </li>
              <li>
                <strong className="text-ink">Article 14 notice.</strong> Because the data is
                collected from third parties rather than the individual, you generally have to tell
                them you hold it — normally within a month, or at first contact.
              </li>
              <li>
                <strong className="text-ink">Right to object.</strong> Individuals can object to
                direct-marketing profiling at any time, and it is an absolute right. Use the{" "}
                <em>Suppress tracking</em> control on a prospect record to honour it: suppression
                stops all future ingestion and removes the person from pipeline totals.
              </li>
              <li>
                <strong className="text-ink">Retention.</strong> Agree how long a non-responsive
                prospect stays on file, and delete on schedule.
              </li>
              <li>
                <strong className="text-ink">Accuracy.</strong> The estimates here are explicitly
                labelled as estimates, which is part of meeting the accuracy principle — but if an
                individual tells you a figure is wrong, correct or remove it.
              </li>
            </ul>
            <p className="rounded-lg border border-line bg-canvas p-2.5 text-[12px]">
              This is a description of how the software behaves, not legal advice. Have your
              compliance function sign off the balancing test and privacy notice before first use.
            </p>
          </div>
        </Card>
      </div>
    </>
  );
}

function Section({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-accent">{icon}</span>
      {children}
    </span>
  );
}

const COMPONENT_EXPLANATIONS: Record<string, string> = {
  PRIVATE_EQUITY_STAKE:
    "Ownership percentage from the PSC register applied to a modelled company valuation, less a discount for lack of marketability.",
  REALISED_EXIT:
    "Consideration from a completed disposal, apportioned by ownership, net of capital gains tax and rolled forward to today.",
  DIVIDEND_ACCUMULATION:
    "Distributions in the filed accounts, apportioned by ownership, net of dividend tax, with an assumed retention rate.",
  REMUNERATION:
    "Disclosed director remuneration over time, net of tax, with an assumed savings rate. The softest component.",
  PUBLIC_HOLDINGS:
    "Holdings in listed companies disclosed through regulatory notifications, at their disclosed value.",
  REPORTED_OR_INHERITED:
    "Figures published by third parties, such as rich lists. Recorded but never treated as evidence.",
};

const CONFIDENCE_DIMENSIONS = [
  {
    label: "Identity verification",
    weight: "22%",
    description:
      "Whether the person is matched to a Companies House officer record. Name-only matching is unreliable for common names.",
  },
  {
    label: "Ownership evidence",
    weight: "26%",
    description:
      "How the stake is evidenced — a statutory filing scores far higher than a press report. PSC bands cost a small penalty for imprecision.",
  },
  {
    label: "Financial data quality",
    weight: "20%",
    description:
      "How recent the filed accounts are, and whether they are abridged. Decays as accounts age.",
  },
  {
    label: "Source corroboration",
    weight: "18%",
    description:
      "Number and independence of public sources, weighted by reliability. Single-source records are the most common false positive.",
  },
  {
    label: "Estimate precision",
    weight: "14%",
    description:
      "How wide the range is relative to its midpoint, with a penalty when most of the estimate rests on behavioural assumptions.",
  },
];

function formatAssumption(key: string, value: number): string {
  if (key.endsWith("GBP")) return formatGBP(value);
  if (key.toLowerCase().includes("years")) return `${value} yr`;
  if (key.includes("Pct")) return `${value}%`;
  if (value > 0 && value <= 1) return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
  return String(value);
}
