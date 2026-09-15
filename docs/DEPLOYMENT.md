# Deployment: GitHub, Supabase, Vercel and a 24/7 worker

```
GitHub (source + CI) ──deploys──▶ Vercel (dashboard, read-only)
                                        │ reads
Worker (your PC or a VM) ──writes──▶ Supabase (PostgreSQL)
  paper trading, data collection,
  research; the only place a private key may live
```

## What runs where, and why

| Piece     | Where                                  | Why                                                                                                         |
| --------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Source    | GitHub                                 | history, review, CI (`npm run validate` on every push)                                                      |
| Database  | Supabase Postgres (free tier)          | the same migrations as local; the dashboard and the worker share it                                         |
| Dashboard | Vercel                                 | static + serverless pages that read the database                                                            |
| Worker    | your PC (scheduled task) or a small VM | it must run continuously: it polls the chain every few seconds, collects every bet event and settles trades |

GitHub Actions, Vercel and Supabase cannot host the worker. Their compute is short-lived: Actions jobs end, Vercel
functions run per request, and Supabase functions time out. The brief also forbids GitHub Actions as a betting
worker. So the worker runs on a machine you control. Today that is this PC; a free always-on VM (for example Oracle
Cloud "Always Free") is the upgrade if the PC cannot stay on.

Private keys stay in the worker's environment only: never in Supabase, Vercel, GitHub or the dashboard.

## 1. The worker, 24/7 on Windows

The **BSC Predict worker** scheduled task starts at logon and runs `scripts/worker.ps1`. That script runs the server
and restarts it 10 s after any exit; each restart is recorded in `logs/worker-supervisor.log`.

```powershell
Start-ScheduledTask -TaskName 'BSC Predict worker'   # start
.\scripts\worker-stop.ps1                               # stop the task and the server together
Invoke-RestMethod http://127.0.0.1:8080/api/health     # check: status, bot phase, chain, pool events
```

- After code changes: `npm run build`, then stop and start the task.
- It runs while you are logged on. Sleep, hibernation, logging off and shutdown stop it; it starts again at the next
  logon. For true 24/7, disable sleep while plugged in, or move the worker to a VM.
- With the embedded database (`pglite:./data/pg`) only one process may open it; the server holds `data/pg.lock`.
  Stop the worker before CLI commands that need the database, or move to Supabase, which any number of processes
  can share.

## 2. Supabase (the database)

1. Create a free project at supabase.com. In **Connect**, copy the **Session pooler** connection string (port 5432).
2. Add it to `.env` as the copy target (never commit `.env`):
   ```
   TARGET_DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=no-verify
   ```
   `sslmode=no-verify` encrypts the connection but does not verify the server's certificate. To verify it, download
   the project's CA certificate from Supabase and use `?sslmode=verify-full&sslrootcert=<path to the certificate>`.
3. Copy the data (about 290 MB today), then switch the worker over:
   ```powershell
   .\scripts\worker-stop.ps1
   npm run app -- copy-db
   # in .env: DATABASE_URL=<the same postgres URL>
   Start-ScheduledTask -TaskName 'BSC Predict worker'
   ```
   `copy-db` migrates the target, copies every table with ids intact, restores the bot state and advances the id
   sequences. It refuses a target that already has data. `data/pg` is left untouched as a backup.
4. Growth is about 1.5 MB a day (mostly pool events), so the free 500 MB tier lasts roughly a year.

A read-only role for the dashboard (run in Supabase's SQL editor; pick your own password):

```sql
CREATE ROLE dashboard_ro LOGIN PASSWORD '<a long random password>';
GRANT USAGE ON SCHEMA public TO dashboard_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dashboard_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO dashboard_ro;
```

## 3. GitHub

Push `main` to the `origin` repository; the CI workflow (`.github/workflows/ci.yml`) runs the full validation on
every push and pull request. `.env`, `data/` and `logs/` are git-ignored, and `npm run check:secrets` fails the
build if a key or env file is ever committed.

## 4. Vercel (the dashboard)

The Vercel dashboard reads Supabase through the read-only role above (Phase 13, in progress). In Vercel: import the
GitHub repository, set the project root to the dashboard app, and add these environment variables:

| Variable             | Value                                                         |
| -------------------- | ------------------------------------------------------------- |
| `DATABASE_URL`       | the Supabase session-pooler URL, logging in as `dashboard_ro` |
| `DASHBOARD_PASSWORD` | a password for signing in to the dashboard                    |

The dashboard never holds a private key and cannot arm live trading. Operator controls that change what the worker
does stay with the worker's own console (`http://127.0.0.1:8080`).
