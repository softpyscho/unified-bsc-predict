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

## 1. The worker, 24/7 on Oracle Cloud (Always Free)

An Oracle "Always Free" virtual machine runs around the clock at no cost; your PC can be switched off. The worker
talks to Supabase, so the machine only needs the code and a `.env` file.

**Only one worker is ever active per database.** The server takes a "worker lease" (a Postgres lock on its own
connection) before it starts any loop. A second copy (your PC and the VM, say) answers its API but stands by, and
takes over only if the active one stops or loses its connection. `GET /api/health` shows `"workerLease": "active"`
or `"standby"`.

### A. Create the account

1. Go to <https://www.oracle.com/cloud/free/> and choose **Start for free**.
2. **Home region**: choose **South Korea Central (Seoul)**, the same city as your Supabase project, so database
   calls stay fast. The home region cannot be changed later, and Always Free machines live only there.
3. Oracle asks for a card to verify your identity. Always Free resources are not charged.

### B. Create the machine

1. In the console: **☰ → Compute → Instances → Create instance**. Name it `bsc-predict`.
2. **Image**: click _Change image_ and pick **Canonical Ubuntu 24.04**.
3. **Shape**: click _Change shape → Ampere → VM.Standard.A1.Flex_ with **1 OCPU and 6 GB memory** (marked "Always
   Free-eligible"). If Oracle reports "out of capacity", try again later, or choose _Specialty and previous
   generation → VM.Standard.E2.1.Micro_ (1 GB, also Always Free).
4. **Networking**: keep the defaults (a new virtual network with a public IPv4 address).
5. **SSH keys**: choose _Generate a key pair for me_ and click **Save private key**. Keep this file safe: it is the
   only way in.
6. Click **Create**. When the instance shows _Running_, copy its **Public IP address**.

### C. Connect from your PC

In PowerShell, protect the key file once (Windows' SSH refuses keys that others can read), then connect:

```powershell
icacls "$HOME\Downloads\ssh-key.key" /inheritance:r /grant:r "$($env:USERNAME):R"
ssh -i "$HOME\Downloads\ssh-key.key" ubuntu@<public IP>
```

Use the path and name your key was saved under. Answer `yes` the first time.

### D. Install (on the VM, one command)

```bash
curl -fsSL https://raw.githubusercontent.com/softpyscho/unified-bsc-predict/main/deploy/linux/setup.sh | bash
```

It installs Node.js 24 and git, adds swap on 1 GB machines, clones the repository, builds it and installs the
`bsc-predict` service (starts at boot, restarts 10 s after any crash). It takes 5–10 minutes.

### E. Give it your settings

Copy your `.env` from the PC to the VM. Run this in PowerShell on the PC, not on the VM:

```powershell
scp -i "$HOME\Downloads\ssh-key.key" C:\Users\Santo\unified-bsc-predict\.env ubuntu@<public IP>:~/unified-bsc-predict/.env
```

It already contains everything the worker needs: `ADMIN_API_TOKEN`, `DATABASE_URL` (Supabase) and your stake and
risk limits. Never put a wallet private key on the VM unless you deliberately move live trading there.

### F. Start it and check

On the VM:

```bash
chmod 600 ~/unified-bsc-predict/.env
sudo systemctl start bsc-predict
curl -s http://127.0.0.1:8080/api/health
```

Look for `"status":"ok"`, `"phase":"READY"` and `"workerLease":"active"`. If it says `"standby"`, the PC worker still
holds the lease: stop and disable it (step G). The VM takes over within 15 s.

### G. Turn off the PC worker

On the PC, in PowerShell:

```powershell
.\scripts\worker-stop.ps1
Disable-ScheduledTask -TaskName 'BSC Predict worker'
```

(Keeping it enabled is safe too: it only stands by while the VM is active.)

### H. Day to day

| Task                                | Command (on the VM unless noted)                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| Health                              | `curl -s http://127.0.0.1:8080/api/health`                                                        |
| Live logs                           | `journalctl -u bsc-predict -f` (also `~/unified-bsc-predict/logs/`)                               |
| Update to the latest GitHub version | `~/unified-bsc-predict/deploy/linux/update.sh`                                                    |
| Stop / start                        | `sudo systemctl stop bsc-predict` / `sudo systemctl start bsc-predict`                            |
| Operator console on your PC         | on the PC: `ssh -i <key> -L 8080:127.0.0.1:8080 ubuntu@<public IP>`, then <http://localhost:8080> |

Never open port 8080 to the internet: the console is reached through the SSH tunnel above, and the public view is
the Vercel dashboard.

**Idle reclamation.** Oracle may reclaim Always Free machines that stay almost idle for 7 days (under 20% CPU,
network and, on Ampere, memory). This worker is light, so it can look idle. Upgrading the account to
**Pay As You Go** (_Billing → Upgrade and manage payment_) exempts it; Always Free resources stay free, and nothing is
charged unless you create paid resources. Set a budget alert to be sure.

## 1b. Alternative: the worker on your Windows PC

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
