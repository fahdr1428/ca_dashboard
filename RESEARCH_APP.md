# Research app (Streamlit)

A Python/Streamlit version of the dashboard that **finds prospects by searching
public news**, refreshed weekly. Companies House is optional here — a bonus
verification step, not a dependency.

Built because the Next.js app needs a Postgres server, a build step and a
working Vercel deployment. This one needs none of that.

---

## Run it

```bash
pip install -r requirements.txt
python scripts/seed_demo.py        # optional: fictional demo data to look at
streamlit run streamlit_app.py
```

It opens at http://localhost:8501. There is no database to install (SQLite, one
file), no build step, and no API key needed to start.

---

## What it does each week

1. **Searches.** 14 wealth-event patterns crossed with 13 counties = **182
   targeted news queries**, via Google News' RSS endpoint — free, no API key,
   indexes thousands of publishers. Plus a broad sweep of eight regional
   business publishers.

   The patterns are the ways wealth actually arrives: business sold, acquired,
   management buyout, funding round, PE investment, IPO, large dividend,
   windfall, share sale, wealth-list entry, family office, significant property,
   rapid growth, succession.

2. **Filters by geography.** A record whose location can't be resolved to one of
   the 13 counties is **discarded, never defaulted**. Ambiguous place names
   ("Bath", "Reading", "Chelsea") are only accepted when the county name
   corroborates them, so an article about bathroom fittings doesn't become a
   Somerset prospect.

3. **Extracts** the transaction value, the named individual and their role, and
   the company. The extractor prefers finding nothing to guessing — "acquired by
   German rival Schmidt AG" yields no person, because a false name here becomes
   a wrong claim about a real individual.

4. **Estimates, or explicitly declines to.** See below.

5. **Scores confidence** across five dimensions and names the single best action
   to raise it.

6. **Writes the weekly research document.**

---

## The honesty model

News tells you a transaction happened and usually its size. It almost never
tells you what share reached a named individual. So:

| Situation | What the app does |
| --- | --- |
| Transaction value reported, individual named | Estimates, and states the arithmetic: *"£210m reported value, of which the named individual is assumed to hold 55% (range 35–75%), less 22% CGT, of which 75% assumed retained"* |
| Value reported, **no individual named** | **No figure.** Recorded as a company-level lead with the reason. Inventing a name would be worse than useless |
| Individual named, **no value reported** | **No figure**, with the reason. A lead for manual research |
| Property purchase, retirement, family office | **No figure** — these indicate wealth but cannot size it. Recorded as corroboration |
| Funding round | Estimates, but flags it as **paper wealth**: only 5% counted as investable, because unexited founder equity can't be sold |

A missing figure is stored as `NULL` and rendered as "not estimated" with its
reason — **never as £0**, which would read as a fact.

The assumed shareholding is the largest source of error in any figure, and the
app says so on every record. Verifying it on the Companies House PSC register is
the single highest-value thing you can do, which is why "Pull the PSC register
entry" is what the confidence model recommends first.

---

## Companies House (optional bonus)

```bash
export COMPANIES_HOUSE_API_KEY="your-key"
```

With a key, the sweep can look each company up, find the person on the PSC
register, and replace the **assumed** stake with a **filed** band. The prospect
detail then reads *"Shareholding filed at 50–75% on the Companies House PSC
register — this stake is a fact, not an assumption"* and confidence rises
accordingly.

Without a key everything still works; shareholdings stay labelled as
assumptions and confidence scores stay correspondingly lower.

---

## Automating the weekly run

The app detects when a sweep is due (no successful run in the current ISO week)
and says so in the sidebar. To run it unattended:

```bash
# macOS / Linux — 07:00 every Monday
0 7 * * 1 cd /path/to/ca_dashboard && python3 scripts/run_research.py --if-due >> research.log 2>&1
```

On Windows, Task Scheduler → weekly, Monday 07:00, action
`python C:\path\to\ca_dashboard\scripts\run_research.py --if-due`.

`--if-due` makes it a no-op if a sweep already ran that week, so it's safe to
schedule more often than weekly.

Options: `--days 30` for a wider first run, `--verify` to add Companies House
checks, `--max-queries 20` for a quick test.

---

## Deploying it (optional)

Streamlit Community Cloud (free) deploys straight from GitHub:

1. [share.streamlit.io](https://share.streamlit.io) → New app
2. Repo `fahdr1428/ca_dashboard`, branch `main`, main file `streamlit_app.py`
3. Advanced settings → Secrets, if you want Companies House:
   `COMPANIES_HOUSE_API_KEY = "your-key"`

One caveat worth knowing: Streamlit Cloud's filesystem is ephemeral, so the
SQLite file resets when the app restarts. For a durable book either run it
locally, or point `WEALTHSCAN_DB` at mounted storage.

---

## Layout

```
streamlit_app.py            Dashboard: Overview, Prospects, Research document,
                            Run research, Methodology
wealthscan/
  config.py                 Thresholds and every model assumption, in one place
  regions.py                The 13 counties, towns, and text → county resolution
  queries.py                14 wealth-event templates × 13 counties
  extract.py                Money, people, companies, event classification
  scoring.py                Estimates (or a stated reason), and confidence
  sources.py                Polite HTTP, RSS/Atom parsing, Companies House
  research.py              The weekly sweep
  report.py                 The weekly research document
  db.py                     SQLite schema and queries
scripts/
  run_research.py           CLI for a scheduler
  seed_demo.py              Fictional demo data
tests_py/test_research.py   33 tests
```

Run the tests with `python -m unittest discover -s tests_py -v`.

---

## Demo data

`python scripts/seed_demo.py` loads 12 fictional prospects. **Every person and
company in it is invented** — a tool like this must never carry unverified
claims about real people as filler. The records are produced by running the real
extraction, estimation and confidence code over invented articles, so what you
see is exactly what the pipeline does.

---

## Data protection

This builds profiles of identifiable living people from public sources. That is
still processing personal data under UK GDPR — *publicly available* does not mean
*unregulated*. Before using it in earnest you need a lawful basis (usually
legitimate interests, with a documented balancing test), an Article 14 privacy
notice, a way to honour objections, and a retention policy. The Methodology page
in the app states all of this. It is a description of the software, not legal
advice.
