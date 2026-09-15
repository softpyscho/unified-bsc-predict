# Running the worker 24/7 on an Android phone

A modern phone left on its charger at home is a free, always-on computer. This guide runs the worker on it with
**Termux**, a Linux terminal app for Android. A OnePlus 12R (Snapdragon 8 Gen 2, 8–16 GB memory) is far more than
the worker needs; it uses well under 1 GB of memory and very little CPU.

The worker only needs the code and your `.env`: all data lives in Supabase. **Only one worker is ever active per
database** (the worker lease), so your PC can keep its worker enabled as a standby: if the phone stops while the PC
is on, the PC takes over within about 15 seconds. Whichever one is active keeps the role; the other waits until it
stops.

## 1. Install Termux and Termux:Boot

Use **F-Droid**, not the Play Store (the Play Store build of Termux is limited):

1. On the phone, open <https://f-droid.org>, download and install the F-Droid app (allow "install unknown apps" for
   your browser when asked).
2. In F-Droid, install **Termux** and **Termux:Boot**. Both must come from F-Droid, or they cannot work together.
3. Open **Termux:Boot** once (it shows a short message and closes). This lets it start the worker after the phone
   restarts.

## 2. Stop Android from killing it (important on OnePlus)

OxygenOS closes background apps aggressively. For **Termux** and **Termux:Boot**:

1. **Settings → Apps → App management → Termux → Battery usage**: turn on **Allow background activity** (or choose
   **Unrestricted**). Do the same for Termux:Boot.
2. Open the recent-apps view, long-press the Termux card and choose **Lock**, so "clear all" never closes it.
3. Keep the phone **on its charger and on Wi-Fi**. The worker exchanges a few GB of data a month; mobile data works
   but counts against your plan. To protect the battery while it stays plugged in, turn on
   **Settings → Battery → Battery health → Smart charging** (or the 80% charge limit, if your phone offers it).

## 3. Install the worker (one command)

Open Termux and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/softpyscho/unified-bsc-predict/main/deploy/termux/setup.sh | bash
```

It installs Node.js and git, downloads the code, builds it and sets up the start-after-reboot hook. The first run
takes 5–15 minutes. If a question appears during package updates, press **Enter** to accept the default.

## 4. Allow Termux to read your Downloads folder

```bash
termux-setup-storage
```

Tap **Allow** when Android asks.

## 5. Copy your settings (`.env`) to the phone

1. Connect the phone to the PC with a USB cable and choose **File transfer** on the phone.
2. On the PC, copy `C:\Users\Santo\unified-bsc-predict\.env` into the phone's **Download** folder.
3. In Termux, move it into place and delete the copy from Downloads (other apps can read that folder):

```bash
cp ~/storage/downloads/.env ~/unified-bsc-predict/.env
chmod 600 ~/unified-bsc-predict/.env
rm ~/storage/downloads/.env
```

The file holds your admin token and Supabase password: keep it off cloud drives and chats. It never needs a wallet
private key unless you deliberately move live trading to the phone.

## 6. Start it and check

```bash
nohup bash ~/unified-bsc-predict/deploy/termux/worker.sh >/dev/null 2>&1 &
sleep 30; curl -s http://127.0.0.1:8080/api/health
```

Look for `"status":"ok"` and `"phase":"READY"`. While your PC's worker is running, the phone shows
`"workerLease":"standby"`. To make the phone the active worker, stop the PC's worker (on the PC, in PowerShell, in
the project folder): `.\scripts\worker-stop.ps1`. The phone takes over within about 15 seconds. You can leave the
PC's scheduled task enabled as a backup.

If the operator console was built, open <http://127.0.0.1:8080> in the phone's browser.

## Day to day (in Termux)

| Task                         | Command                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------- |
| Health                       | `curl -s http://127.0.0.1:8080/api/health`                                   |
| Recent activity              | `tail -n 20 ~/unified-bsc-predict/logs/audit.log`                            |
| Restarts and crashes         | `cat ~/unified-bsc-predict/logs/worker-supervisor.log`                       |
| Update to the latest version | `bash ~/unified-bsc-predict/deploy/termux/update.sh`                         |
| Stop                         | `bash ~/unified-bsc-predict/deploy/termux/stop.sh`                           |
| Start                        | `nohup bash ~/unified-bsc-predict/deploy/termux/worker.sh >/dev/null 2>&1 &` |

- After the phone restarts, Termux:Boot starts the worker by itself (give it a minute after unlocking).
- Termux shows a notification while it runs. Don't tap **Exit** on it: that stops the worker.
- If the phone is off or out of Wi-Fi for a while, nothing is lost except paper bets for those rounds: round history
  and bet events are recovered automatically when it comes back (bet events within about 3 days).
