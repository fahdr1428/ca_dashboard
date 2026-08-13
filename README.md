# Wealth Advisor Lead Intelligence

Prospect identification for a private wealth advisor. It finds individuals likely
to hold significant investable assets, estimates what those assets are, shows
exactly how each estimate was derived, and refreshes itself weekly.

There are **two apps in this repository**, and most people want the first one:

- **[Research app](RESEARCH_APP.md)** (Python/Streamlit) — discovers prospects
  from public news across 70 markets in the UK, the US, the Middle East, Europe
  and Asia-Pacific. `pip install -r requirements.txt && streamlit run streamlit_app.py`
  and you are running.
- **Dashboard** (Next.js 15, React 19, TypeScript, Tailwind 4, PostgreSQL,
  Prisma, Recharts, and an inline SVG map from ONS boundary data) — verifies
  ownership and financials against the Companies House register for the original
  13 southern English counties. Documented in the rest of this file.

---

## The one thing to understand first

**Every monetary figure in this system is a modelled estimate, not a fact.**

The dashboard does not tell you what anyone is worth. It tells you what a model
infers from public filings and press coverage, and — just as importantly — how
much of that inference is actually evidenced. This is enforced structurally, not
by convention:

- Estimates are stored as low/mid/high ranges, never a bare number.
- Every estimate carries a machine-readable trace (`Prospect.estimateBreakdown`)
  recording each component, its arithmetic, its evidence grade and its sources.
- Every monetary figure in the UI renders through an `<Estimated>` marker.
- Nothing enters the database without at least one `Citation` pointing at a
  public, re-checkable URL.

If you cannot open the sources and check a figure yourself, the system is not
doing its job.

---

## Two apps in this repo

| | **Research app** (Streamlit, Python) | **Dashboard** (Next.js, TypeScript) |
| --- | --- | --- |
| **Finds prospects by** | Searching public news across 70 markets — UK, US, Middle East, Europe, Asia-Pacific | Reading the Companies House register and filed accounts |
| **Geography** | 70 markets, chosen by preset | The 13 southern English counties |
| **Needs** | `pip install` and one command | Postgres, a build step, a deployment |
| **Companies House** | Optional bonus — verifies an assumed stake and supplies an address | Required; it is the whole data source |
| **Start with** | `streamlit run streamlit_app.py` | `npm run setup && npm run dev` |
| **Docs** | **[RESEARCH_APP.md](RESEARCH_APP.md)** | this file |

If you want prospects **discovered** — people you have never heard of, anywhere
from Cornwall to Riyadh, with no infrastructure to set up — use the **research
app**. If you want ownership and financials **verified** against the statutory
register for the original southern-England patch, use the **Next.js dashboard**.
They share the same thresholds and the same rule that an estimate is never
presented as a fact.

---

## Quick start (Next.js dashboard)

You need Node 20+ and a PostgreSQL 14+ database. If you have Docker, the
database is one command; otherwise point `DATABASE_URL` at your own instance.

```bash
docker compose up -d     # PostgreSQL on :5432 (skip if you have your own)
npm install
npm run setup            # generates .env with real secrets, applies the
                         # schema, loads the demo data — and prints your
                         # sign-in passphrase
npm run dev
```

Open http://localhost:3000 and sign in with the passphrase `npm run setup`
printed. Change `DASHBOARD_PASSWORD` in `.env` if you'd prefer something
memorable.

`npm run setup` is idempotent and never overwrites an existing `.env`, so it is
safe to re-run — for example after starting the database.

<details>
<summary>Manual setup, if you'd rather do it step by step</summary>

```bash
cp .env.example .env
# Set DATABASE_URL, then generate the secrets:
#   openssl rand -base64 36   # AUTH_SECRET
#   openssl rand -hex 32      # CRON_SECRET
#   Pick your own DASHBOARD_PASSWORD

npx prisma generate
npx prisma db push
npm run db:seed
npm run dev
```

</details>

### Switching from demo data to live records

1. Get a free API key from
   [developer.company-information.service.gov.uk](https://developer.company-information.service.gov.uk/)
   — register, create an application, and take the REST API key.
2. Put it in `.env` as `COMPANIES_HOUSE_API_KEY`.
3. Restart the dev server, open **Automation**, and press **Run ingest**.

The connector searches each of the 13 counties for active companies in
owner-managed SIC codes, reads the PSC register to establish who controls them,
pulls officer records to confirm identity, and watches filing history for
change. The demo banner disappears once real records land.

The news connector needs no key and runs by default. If your network blocks
outbound HTTP to the publisher feeds you'll see per-feed warnings on the
Automation page and the run will be marked `PARTIAL` — that is the connector
degrading correctly, not a failure of the app.

### Demo data

`npm run db:seed` loads 26 fictional prospects across 26 fictional companies,
spread over all 13 counties. **Every person and company in it is invented.** The
seed marks the database as `demo` and the UI shows a banner saying so, because a
tool like this must never present unverified claims about real, identifiable
people. The financials are modelled on the shape of real Companies House filings
so the wealth model is exercised realistically.

To replace it with live data: set `COMPANIES_HOUSE_API_KEY` and run an ingest
from the Automation page.

---

## Geographic scope

Cornwall · Devon · Somerset · Bristol · Gloucestershire · Wiltshire · Dorset ·
Hampshire · West Sussex · Surrey · Berkshire · Greater London · Oxfordshire

Scope is enforced in code, not by convention. `resolveRegion()` in
`src/lib/regions.ts` maps a free-text address to one of the 13 counties, and the
ingestion pipeline **discards** anything it cannot resolve rather than guessing.
A record outside the target geography never reaches the database.

---

## Who counts as a prospect

Two cohorts, defined once in `src/lib/pipeline-filters.ts` so a KPI card, a table
filter and the weekly report can never disagree:

| Cohort | Definition | Why it's separate |
| --- | --- | --- |
| **Qualifying** | Estimated investable assets ≥ £7.5m | A discretionary mandate could be written today |
| **Pre-liquidity founder** | Gross estimated wealth ≥ £15m, investable < £7.5m | Unrealised founder equity. Not a mandate now, but the relationship has to exist before the exit |

The gross/investable split is the most consequential thing the model does. A
founder holding 60% of a business valued at £80m has a large gross figure and
almost nothing a discretionary manager can invest, because the shares cannot be
sold. Only 4% of an unquoted stake counts as investable — rising to 35% when a
live sale process is detected, and 95% once proceeds are realised.

---

## How the estimate is built

Gross wealth is the sum of six components, each with its own liquidity factor:

| Component | Derivation |
| --- | --- |
| Private company equity | PSC ownership band × modelled valuation, less a marketability discount |
| Realised exit proceeds | Disposal consideration × ownership, net of CGT, rolled forward |
| Accumulated dividends | Filed distributions × ownership, net of dividend tax, × retention rate |
| Accumulated remuneration | Disclosed pay, net of tax, × savings rate (the softest component) |
| Listed shareholdings | Disclosed holdings at disclosed value |
| Reported / inherited | Third-party published figures — recorded, never treated as evidence |

Company valuation is applied in order of evidence quality: a priced transaction
beats an EBITDA multiple, which beats a revenue multiple, which beats filed net
assets as a floor.

Low and high bounds pair pessimistic inputs together and optimistic inputs
together — a low ownership bound against a low valuation, and vice versa. That
widens the range relative to a naive calculation, which is the honest result when
two independent quantities are both uncertain.

Every constant lives in `src/lib/scoring/assumptions.ts` and is rendered on the
in-app **Methodology** page. Change one, run `npm run recompute`, and the whole
book is re-derived.

### Confidence

Scored separately from wealth, because "how rich are they?" and "should I trust
this record?" are different questions. Five weighted dimensions — identity
verification (22%), ownership evidence (26%), financial data quality (20%),
source corroboration (18%) and estimate precision (14%) — each with a plain
English explanation and a "best next action" telling the advisor what would raise
the score fastest.

---

## Data sources

| Source | Use | Automated? |
| --- | --- | --- |
| **Companies House REST API** | The register, PSC filings, accounts, filing history. The only source used to *verify* ownership. Open Government Licence v3.0 | Yes — needs a free API key |
| **Business news RSS** | Funding, acquisitions, exits, IPOs, dividends. Graded `Reported`; a lead to verify, never evidence | Yes — publisher feeds only |
| **Regulatory disclosures** | RNS and major-holdings notifications | Modelled; connector stub |
| **LinkedIn** | Job titles, corroboration | **No.** See below |
| **ONS boundaries** | The map. © Crown copyright, OGL v3.0 | Vendored at build time |

### On LinkedIn

The brief asked for LinkedIn "where appropriate". LinkedIn's User Agreement
prohibits automated scraping, so this system never fetches it. Instead
`src/lib/ingest/linkedin.ts` surfaces LinkedIn as an explicitly *manual* source
on the Automation page and generates a per-prospect search link for an advisor to
open by hand, recording anything found as a manual note with its own citation. If
the firm later licenses Sales Navigator or the Talent Solutions API, that file is
where to implement against it.

The news connector reads publisher-provided RSS feeds only. It does not scrape
article bodies, does not circumvent paywalls, and identifies itself honestly in
its `User-Agent`.

---

## Automation

The Monday job (`GET|POST /api/cron/weekly`, bearer `CRON_SECRET`):

1. Runs every available connector over the last 14 days — the overlap covers a
   missed run without re-reading the whole register.
2. Re-values every touched company and re-scores every affected prospect.
3. Writes a `WealthSnapshot` per prospect, which is what powers the trend charts
   and "wealth increased recently".
4. Generates the weekly report.
5. Delivers it, if a channel is configured.

Scheduling, in order of preference:

- **Vercel** — `vercel.json` already declares the cron for 07:00 UTC Mondays.
- **GitHub Actions** — `.github/workflows/weekly-refresh.yml`; set the
  `DASHBOARD_URL` and `CRON_SECRET` repository secrets.
- **Anything else** — `curl -X POST "$URL/api/cron/weekly" -H "Authorization: Bearer $CRON_SECRET"`.

Report delivery is optional and unconfigured by default, so the system is never
silently dependent on an unconfigured mail provider. Set `REPORT_WEBHOOK_URL`
(Slack, Teams, Zapier) or `RESEND_API_KEY` + `REPORT_EMAIL_TO` for email.

### Why weekly, not real time

The brief asked for real time if feasible. It isn't, honestly, on these sources:

- Companies House publishes accounts on a **annual** filing cycle and enforces
  600 requests per 5 minutes. There is nothing to poll for in real time.
- Companies House does offer a [streaming
  API](https://developer.company-information.service.gov.uk/streaming-api) for
  live filing events. That is the correct upgrade path if near-real-time
  detection of PSC and filing changes matters — it would slot in as another
  connector behind the same `Connector` interface. It needs a long-lived process,
  so it does not fit a serverless deployment.
- News RSS updates hourly at best.

A weekly cadence matches the data's actual refresh rate. Claiming real time would
mean polling sources that have not changed.

---

## Commands

```bash
npm run setup            # first-run: .env + schema + demo data
npm run dev              # development server
npm run build            # production build (runs prisma generate first)
npm run typecheck        # tsc --noEmit
npm test                 # unit tests (no database or network needed)
npm run db:push          # apply schema to the database
npm run db:seed          # load the fictional demo dataset
npm run db:studio        # Prisma Studio
npm run ingest           # collection pass; --only <keys> --since <days> --snapshot
npm run recompute        # re-run all models after changing assumptions
npm run report:weekly    # generate the report; --deliver --origin <url>
npm run geo:build        # rebuild the map from ONS boundary data
```

---

## Architecture

```
src/
  app/
    (app)/               authenticated routes — overview, tracker, companies,
                         signals, reports, automation, methodology
    login/               unauthenticated
    api/                 auth, prospects, ingest, cron, reports, health
  components/            UI primitives, charts, map, panels
  lib/
    scoring/             assumptions · valuation · estimate · confidence ·
                         qualify · recompute
    ingest/              types · companies-house · news · sic ·
                         derive-signals · linkedin · pipeline
    report/              weekly (build + markdown) · deliver
    regions.ts           the 13 counties and address resolution
    pipeline-filters.ts  the single definition of "who counts"
    queries.ts           every read the pages perform
prisma/schema.prisma     data model
scripts/                 build-geo · ingest · recompute · weekly-report
```

Two rules keep this coherent:

- **`recompute.ts` is the only writer of derived numbers.** Nothing else in the
  app writes an estimate, a confidence score or a wealth band, so the model can be
  changed in one place and re-applied to the whole book.
- **Connectors know nothing about the database.** They emit normalised records;
  `pipeline.ts` does all merging, deduplication and citation.

### The map

`scripts/build-geo.ts` downloads ONS local-authority boundaries, filters them to
the 111 districts making up the 13 counties, simplifies them with Douglas-Peucker
at a 500m tolerance (975 kB → 92 kB, ~90% smaller with no visible loss at this
zoom) and writes GeoJSON that ships with the app. No tile server, so the map
still works behind a locked-down CSP and on an offline network.

---

## Security

- Everything is private by default; middleware admits only a valid HMAC-signed
  session cookie, or a bearer `CRON_SECRET` on `/api/cron/*`.
- Session cookies are httpOnly, SameSite=Lax, Secure in production, 12-hour TTL.
- Passphrase comparison is constant-time over SHA-256 digests, with a fixed
  failure delay so wrong guesses can't be probed quickly.
- Strict CSP with no external origins, plus HSTS, `frame-ancestors 'none'`,
  `nosniff` and a restrictive Permissions-Policy.
- All query-string filters are validated against known enum values before they
  reach Prisma; `?next=` is restricted to same-origin paths.

For more than one or two advisors, replace `verifyPassphrase` in
`src/lib/auth.ts` with a real identity provider. Nothing else needs to change.

---

## Data protection

This system processes personal data about identifiable living people. Publicly
available does not mean unregulated. Before using it in anger, your firm needs:

- **A lawful basis.** Legitimate interests is the usual one for prospecting, and
  it requires a documented balancing test.
- **An Article 14 privacy notice.** Because the data is collected from third
  parties rather than the individual, you generally have to tell them you hold
  it — normally within a month, or at first contact.
- **A way to honour objections.** Built in: the *Suppress tracking* control on a
  prospect record stops all future ingestion, excludes the person from pipeline
  totals, and is respected by the ingestion pipeline itself.
- **A retention policy** for non-responsive prospects.

The in-app Methodology page states all of this to whoever is using the dashboard.
It is a description of how the software behaves, not legal advice — have your
compliance function sign off the balancing test and privacy notice first.

---

## Licensing and attribution

- Companies House data — Open Government Licence v3.0.
- Boundary data — ONS / Ordnance Survey, © Crown copyright and database right,
  Open Government Licence v3.0.
- News content is referenced by link and short excerpt only.
