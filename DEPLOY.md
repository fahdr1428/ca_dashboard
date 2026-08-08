# Deploying to Vercel

Roughly ten minutes, most of it waiting for builds. The app is deployment-ready:
`vercel.json` already declares the Monday cron, and the build runs
`prisma generate` before `next build`.

## 1. Import the repository

1. Go to [vercel.com/new](https://vercel.com/new).
2. Import `fahdr1428/ca_dashboard`.
3. Set **Production Branch** to `claude/wealth-advisor-lead-dashboard-1ng2wo`
   (Settings → Git), or merge that branch to `main` first.
4. Leave the framework preset and build settings alone — Vercel detects Next.js
   and the repo's own build command is correct.

Don't deploy yet. Add the environment variables first, or the first build will
succeed but every page will land on the setup screen.

## 2. Create a PostgreSQL database

Any managed Postgres works. Free tiers that do:

- **[Neon](https://neon.tech)** — also available in Vercel's marketplace
  (Storage → Create → Neon), which wires `DATABASE_URL` in for you.
- **[Supabase](https://supabase.com)** — use the *connection pooling* string.

Take the connection string. It must include `sslmode=require` for most hosted
providers:

```
postgresql://user:password@host/dbname?sslmode=require
```

## 3. Set environment variables

In Vercel: Settings → Environment Variables. Apply each to **Production** and
**Preview**.

| Variable | Required | Value |
| --- | --- | --- |
| `DATABASE_URL` | yes | Your Postgres connection string |
| `AUTH_SECRET` | yes | `openssl rand -base64 36` |
| `DASHBOARD_PASSWORD` | yes | The passphrase you'll sign in with |
| `CRON_SECRET` | yes | `openssl rand -hex 32` — authenticates the weekly job |
| `COMPANIES_HOUSE_API_KEY` | for live data | Free from [developer.company-information.service.gov.uk](https://developer.company-information.service.gov.uk/) |
| `REPORT_WEBHOOK_URL` | optional | Slack/Teams/Zapier webhook for the Monday report |
| `RESEND_API_KEY` + `REPORT_EMAIL_TO` | optional | Email delivery instead of (or as well as) a webhook |

Vercel sets `CRON_SECRET` automatically on its own cron requests **only if you
name it exactly that** — which is why the middleware expects that name.

## 4. Apply the schema

Vercel's build doesn't touch your database, so push the schema once from a local
checkout:

```bash
DATABASE_URL="postgresql://…?sslmode=require" npx prisma db push
```

Optionally load the fictional demo data so the dashboard isn't empty while you
get a Companies House key:

```bash
DATABASE_URL="postgresql://…?sslmode=require" npm run db:seed
```

## 5. Deploy and check

Deploy, then open `/api/health`. It reports exactly what's configured and
whether the database is reachable and migrated — without echoing any secret
values, so it's safe to leave open:

```json
{ "status": "ok", "configured": { ... }, "database": { "reachable": true, "migrated": true } }
```

If anything is missing, signing in and loading any page shows the same
diagnosis as a readable checklist rather than a 500.

## 6. Switch to live data

1. Add `COMPANIES_HOUSE_API_KEY` and redeploy.
2. Open **Automation** and press **Run ingest**.

The first run walks all 13 counties, reads the PSC register for ownership,
downloads the filed accounts and extracts the numbers. Expect a few minutes and
several hundred API requests — the connector rate-limits itself well inside
Companies House's 600-per-5-minutes budget.

The demo banner disappears once real records land. If you seeded demo data
first, clear it before going live so fictional and real records never mix:

```bash
DATABASE_URL="…" npx prisma db push --force-reset
DATABASE_URL="…" npx prisma db push
```

## 7. Confirm the weekly job

`vercel.json` schedules `/api/cron/weekly` for 07:00 UTC every Monday. Check
Settings → Cron Jobs after the first deploy. To test it immediately:

```bash
curl -X POST "https://your-app.vercel.app/api/cron/weekly" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Vercel's Hobby plan allows one cron invocation per day, which is more than
enough for a weekly job.

## Notes on limits

- **Function duration.** The weekly job declares `maxDuration: 800`. Hobby caps
  functions at 60 seconds, so a full 13-county ingest will be cut short there.
  Either run ingestion from your own machine (`npm run ingest`) and let Vercel
  handle only the report, or use a Pro plan. The job is written to be
  interruptible: a truncated run leaves a `PARTIAL` record and the next run
  picks up where it left off.
- **Connection pooling.** Serverless functions open a lot of short-lived
  connections. Use your provider's pooled connection string (Neon's pooler,
  Supabase's port 6543) or you'll hit connection limits under load.
- **Data protection.** The moment you add a real API key this becomes a
  database of wealth estimates about identifiable living people. Read the
  Methodology page's data-protection section, and have your privacy notice and
  legitimate-interests balancing test signed off before first live use.
