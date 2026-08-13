# Research app (Streamlit)

A Python/Streamlit app that **finds prospects by searching public news** across
70 markets — the UK, the United States, the Middle East, Europe and Asia-Pacific.
Companies House is optional: a bonus verification step, not a dependency.

Built because the Next.js app needs a Postgres server, a build step and a working
Vercel deployment. This one needs none of that.

---

## Run it

```bash
pip install -r requirements.txt
python scripts/seed_demo.py        # optional: 50 fictional prospects to look at
streamlit run streamlit_app.py
```

It opens at http://localhost:8501. No database to install (SQLite, one file), no
build step, no API key needed to start.

---

## The five pages

| Page | What it is for |
| --- | --- |
| **Overview** | Totals, addressable assets by market and country, wealth bands, a map |
| **Prospect list** | One sortable, filterable table of everyone found. Click a row for the full record |
| **Find prospects** | Choose where to look and how hard, see the cost, press go |
| **Weekly research document** | The Monday write-up: who is new, why, what each figure rests on |
| **How it works** | Every model assumption, the market list, lawful use, Companies House setup |

---

## Where it looks

70 markets in six groups, selected through presets so nobody has to tick sixty
boxes:

| Preset | Markets |
| --- | --- |
| Core patch | The original 13 southern English counties |
| All United Kingdom | 20 — the counties plus the Home Counties, Midlands, North, Scotland, Wales |
| UK + United States | 33 |
| **UK + US + Middle East** (default) | 47 |
| Everywhere | 70 — adds Europe, Asia-Pacific, Canada, Africa, Latin America |

Each market carries the town and district names that identify it in text, its
currency, and a coordinate for the map. The `Find prospects` page also lets you
tick individual markets if a preset is nearly right.

Google News' locale follows the market: searching Dubai uses the `AE` edition,
because `gl=GB` quietly hides most of the Gulf press.

---

## How hard it looks

Depth is an explicit choice with an honest cost, shown before you commit:

| Depth | What it does | Cost on the default 47 markets |
| --- | --- | --- |
| **Quick look** | 5 realised-money events, market names only | ~250 searches, ~4 min |
| **Standard sweep** | All 14 events, main towns folded in | ~680 searches, ~11 min |
| **Deep search** | All events, every town, recent + wider window | ~2,230 searches, ~35 min |
| **Exhaustive** | Everything, three windows | ~4,260 searches, ~1 hour |

The `Find prospects` page shows the real number for whatever you have selected
before you commit to it, so you never have to guess.

Towns are OR-ed into each query rather than searched separately — one
`("Devon" OR "Exeter" OR "Plymouth" OR "Torbay" …)` query finds what four
separate queries would, for a quarter of the requests. That is what makes a deep
sweep affordable.

A **time budget** (default 20 minutes) stops a long run cleanly. Everything found
before the cut-off is already saved, and running again continues where it left
off, because processed articles are never reprocessed.

---

## What a sweep does

1. **Builds the searches.** 14 wealth-event patterns × selected markets ×
   look-back windows, via Google News' RSS endpoint — free, no API key, indexes
   thousands of publishers. Plus a broad sweep of 20 business publishers across
   the UK regions, the US, and the Gulf.

   The patterns are the ways wealth actually arrives: business sold, acquired,
   management buyout, funding round, PE investment, IPO, large dividend,
   windfall, share sale, wealth-list entry, family office, significant property,
   rapid growth, succession.

2. **Locates each article.** Geography is resolved against all 70 markets and
   *then* checked against your selection:

   - The article names a place in scope → located, evidence recorded.
   - The article names a place **out of** scope → **discarded.** A Manchester
     story found by a Devon query is not a Devon prospect.
   - The article names nowhere at all → the market is **inherited from the
     search**, flagged as inferred, and scored lower for it.

   That third case is the difference between this version and the first one. The
   original resolved geography only from article text, so a Devon query returning
   a perfect Devon story got thrown away whenever the 200-character snippet
   didn't repeat the word "Devon" — which threw away nearly everything.

   Ambiguous place names ("Bath", "Reading", "Chelsea", "Palm Beach") are only
   accepted when the market or country name corroborates them, so an article
   about bathroom fittings doesn't become a Somerset prospect.

3. **Extracts** the transaction value in ~25 currencies, the named individual and
   their role, and the company. The extractor prefers finding nothing to
   guessing: "acquired by German rival Schmidt AG" yields no person, and
   "US Firm Sold for £40m" yields no person, because a false name here becomes a
   wrong claim about a real individual.

4. **Estimates, or explicitly declines to.** See below.

5. **Verifies, if it can.** UK companies are checked against Companies House.

6. **Scores confidence** across six dimensions and names the single best action
   to raise it.

7. **Writes the weekly research document.**

---

## The honesty model

News tells you a transaction happened and usually its size. It almost never tells
you what share reached a named individual. So:

| Situation | What the app does |
| --- | --- |
| Transaction value reported, individual named | Estimates, and states the arithmetic: *"£210m reported value, of which the named individual is assumed to hold 55% (range 35–75%), less 22% CGT, of which 75% assumed retained"* |
| Value reported, **no individual named** | **No figure.** Recorded as a company-level lead with the reason. Inventing a name would be worse than useless |
| Individual named, **no value reported** | **No figure**, with the reason. A lead for manual research |
| Property purchase, retirement, family office | **No figure** — these indicate wealth but cannot size it. Recorded as corroboration |
| Funding round | Estimates, but flags it as **paper wealth**: only 5% counted as investable, because unexited founder equity can't be sold |
| Figure is a **valuation**, not proceeds | Estimates, with a caveat that the number prices the whole company and may be too high by a large multiple |
| Location inferred from the search | Kept, marked *inferred*, and the confidence score drops |

A missing figure is stored as `NULL` and rendered as "not estimated" with its
reason — **never as £0**, which would read as a fact.

The assumed shareholding is the largest source of error in any figure, and the
app says so on every record. Verifying it on the Companies House PSC register is
the single highest-value thing you can do, which is why "Pull the PSC register
entry" is what the confidence model recommends first.

---

## Companies House (optional bonus)

Free. Register at
[developer.company-information.service.gov.uk](https://developer.company-information.service.gov.uk/),
create an application, and make a **REST API key for the live environment** — a
streaming key or a test-sandbox key is rejected with a 401.

```bash
export COMPANIES_HOUSE_API_KEY="your-key"
streamlit run streamlit_app.py
```

On Streamlit Community Cloud put it in **Settings → Secrets** instead:

```toml
COMPANIES_HOUSE_API_KEY = "your-key"
```

With a key, the sweep does three things per UK prospect:

1. **PSC register** — replaces the **assumed** stake with a **filed** band. The
   record then reads *"Shareholding filed at 50–75% — this stake is a fact, not
   an assumption"*, the estimate is re-derived from the filed midpoint, and the
   contradictory "the stake is an assumption" caveat disappears.
2. **Officers list** — when they are not a PSC, confirms they are nonetheless a
   filed officer. That verifies the person, not the shareholding, and is recorded
   as the weaker claim it is.
3. **Registered office** — a real, verifiable address. It is the *company's*
   filed address and is labelled as such; it is never presented as a home
   address.

It is only used for UK companies. Running a Dubai or Texas business through a
British register would either find nothing or, worse, find a same-named British
company and attach the wrong number to a real person.

**Never commit a key or paste one into a chat window.** If a key has been shared
anywhere, revoke it in the developer portal and issue a new one.

Without a key everything still works; shareholdings stay labelled as
assumptions, no addresses are collected, and confidence scores stay
correspondingly lower.

---

## Automating the weekly run

The app detects when a sweep is due (no successful run in the current ISO week)
and says so in the sidebar. To run it unattended:

```bash
# macOS / Linux — 07:00 every Monday
0 7 * * 1 cd /path/to/ca_dashboard && python3 scripts/run_research.py \
  --if-due --depth standard --preset 'UK + US + Middle East' >> research.log 2>&1
```

On Windows, Task Scheduler → weekly, Monday 07:00, action
`python C:\path\to\ca_dashboard\scripts\run_research.py --if-due`.

`--if-due` makes it a no-op if a sweep already ran that week, so it is safe to
schedule more often than weekly.

```
--depth quick|standard|deep|exhaustive   how hard to look
--preset 'Everywhere'                    which markets
--markets uk-devon uk-london ae-dubai    specific markets instead of a preset
--days 30                                force one look-back window
--minutes 20                             stop after this long
--verify                                 add Companies House checks
--plan                                   print the cost and exit without running
```

---

## Deploying it

Streamlit Community Cloud (free) deploys straight from GitHub:

1. [share.streamlit.io](https://share.streamlit.io) → New app
2. Repo `fahdr1428/ca_dashboard`, branch `main`, main file `streamlit_app.py`
3. Advanced settings → Secrets, if you want Companies House:
   `COMPANIES_HOUSE_API_KEY = "your-key"`

Two caveats worth knowing:

- Streamlit Cloud's filesystem is ephemeral, so the SQLite file resets when the
  app restarts. For a durable book either run it locally, or point
  `WEALTHSCAN_DB` at mounted storage.
- A deep sweep takes tens of minutes. Cloud will keep the script running, but if
  your browser disconnects you may lose the result summary — the prospects are
  saved as they are found either way. For long sweeps prefer
  `scripts/run_research.py` on a machine you control.

---

## Layout

```
streamlit_app.py            Overview, Prospect list, Find prospects,
                            Weekly research document, How it works
wealthscan/
  config.py                 Thresholds and every model assumption, in one place
  markets.py                70 markets, presets, and text → market resolution
  queries.py                14 wealth-event templates, depths, the query matrix
  extract.py                Money, people, companies, event classification
  scoring.py                Estimates (or a stated reason), and confidence
  sources.py                Polite HTTP, RSS/Atom parsing, Companies House
  research.py               The sweep
  report.py                 The weekly research document
  db.py                     SQLite schema, migrations and queries
scripts/
  run_research.py           CLI for a scheduler
  seed_demo.py              50 fictional prospects
tests_py/test_research.py   58 tests
```

Run the tests with `python -m unittest discover -s tests_py -v`.

The database migrates itself on startup, including from the earlier
county-based schema — prospects, notes and citations are carried across rather
than reset.

---

## Demo data

`python scripts/seed_demo.py` loads **50 fictional prospects** across the UK, the
US, the Gulf, Europe and Asia. **Every person and company in it is invented** — a
tool like this must never carry unverified claims about real people as filler.

The records are produced by running the real extraction, estimation and
confidence code over invented articles, so what you see is exactly what the
pipeline does on live news. Two of the articles are there to be *rejected*: one
names a transaction with no individual, and one is positively about New Zealand
while being surfaced by a Somerset query.

---

## Data protection

This builds profiles of identifiable living people from public sources. That is
still processing personal data under UK GDPR — *publicly available* does not mean
*unregulated*. Before using it in earnest you need a lawful basis (usually
legitimate interests, with a documented balancing test), an Article 14 privacy
notice, a way to honour objections, and a retention policy.

Every prospect page has a **suppress** control for objections. It flags rather
than deletes, because a delete would let the next sweep find the person again and
recreate them; a suppressed record stops updating and drops out of every total
and report.

Searching US, Gulf and Asian markets does not exempt the processing from UK GDPR
if your firm is established here. The *How it works* page states all of this. It
is a description of the software, not legal advice.
