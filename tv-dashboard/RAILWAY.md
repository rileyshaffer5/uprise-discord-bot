# Uprise TV Dashboard — running inside your Railway `uprise-discord-bot` service

This folder runs the TV dashboard **in the same Railway service as your Discord
bot**, so it can read the live database at `/app/uprise.sqlite` directly.

- ✅ Your Discord bot keeps running, unchanged.
- ✅ The bot stays the **only writer** to `uprise.sqlite`. The dashboard opens it
  **read-only** and never writes.
- ✅ Dashboard UI is served at **`/tv`**, leaderboard API at **`/api/leaderboards`**.
- ✅ Leaderboards are computed live from the real `sales` table and the UI
  auto-refreshes every 30 seconds.
- ✅ No sample data — it reads only the path you set in `UPRISE_SQLITE_PATH`.

---

## How it works

Railway gives each service one container and one start command. To run two
processes (bot + dashboard) in that one container, the included
`railway-start.mjs` launcher:

1. starts your existing bot exactly as you start it today (via `BOT_CMD`), and
2. runs the dashboard web server in the same process (it binds Railway's `$PORT`).

Both share the same filesystem, so the dashboard reads `/app/uprise.sqlite`
that the bot writes.

> **Node version:** the dashboard uses Node's built-in `node:sqlite`, which needs
> **Node ≥ 22.5**. No `npm install` is required.
> - If your bot is **also Node**, just make sure the service uses Node ≥ 22.5
>   (see step 4).
> - If your bot is **Python**, your Railway image won't have Node by default —
>   see "Python bot" at the bottom.

---

## Steps

### 1. Add this folder to your bot's repo
Copy the whole `tv-dashboard/` folder into the root of your `uprise-discord-bot`
project, so it sits next to your bot code and ends up at `/app/tv-dashboard/` in
the container. Commit and push.

### 2. Set environment variables (Railway → your service → Variables)
| Variable | Value | Notes |
|----------|-------|-------|
| `UPRISE_SQLITE_PATH` | `/app/uprise.sqlite` | The live DB the bot writes. **Required.** |
| `BOT_CMD` | *your bot's current start command* | e.g. `python bot.py`, `node index.js`, or `npm run bot`. **Required.** |
| `DASHBOARD_TIMEZONE` | `America/New_York` | Optional; office timezone for day/week/month. |
| `MONTHLY_GOAL` | `1000000` | Optional; monthly production goal in dollars. |

Do **not** set `PORT` yourself — Railway sets it automatically and the dashboard
listens on it.

### 3. Change the service Start Command
Railway → your service → **Settings → Deploy → Start Command**:

```
node tv-dashboard/railway-start.mjs
```

(Your old start command now lives in `BOT_CMD` from step 2 — the launcher runs it
for you.)

### 4. Ensure Node ≥ 22.5 (Node bots)
Add an `engines` field to your bot's root `package.json` so Railway/Nixpacks
picks a new enough Node:

```json
"engines": { "node": ">=22.5.0" }
```

### 5. Expose the dashboard publicly
Railway → your service → **Settings → Networking → Generate Domain** (if you
don't already have one). The dashboard will be at:

```
https://<your-service>.up.railway.app/tv
```

### 6. Deploy and verify
After it deploys, open the **Deploy Logs**. You should see the launcher start the
bot, then the dashboard print:

```
[tv-dashboard]   Database:  /app/uprise.sqlite
```

That line confirms it's reading the real database. Then:

- Open `https://<your-service>.up.railway.app/tv` — the dashboard should show your
  real agents (307+ sales), not sample names.
- Hit `https://<your-service>.up.railway.app/api/leaderboards` — you should get
  live JSON with your real totals.

### 7. Live test (proves auto-update)
1. Log a new sale through the Discord bot as usual.
2. Within ~30 seconds the dashboard refreshes on its own (it polls every 30s) and
   the new sale appears in the daily leaderboard / agency metrics — no restart,
   no redeploy.

---

## Point this at the TV
Open `https://<your-service>.up.railway.app/tv` in full-screen (F11) on the
office TV / a browser plugged into it. It rotates through the slides on its own.

---

## Python bot

If `BOT_CMD` is a Python command, the Railway image is Python-only and has no
Node. Two easy options:

- **Easiest:** run the dashboard as a **second Railway service** that attaches the
  **same Railway Volume** as the bot (mount it at `/app` in both), so both see
  `/app/uprise.sqlite`. Set that service's Start Command to
  `node server.mjs` and `UPRISE_SQLITE_PATH=/app/uprise.sqlite`. Use a Node image
  (Nixpacks auto-detects Node from this folder's `package.json`).
- **Single service:** add Node to the build with a Nixpacks config or a custom
  Dockerfile that installs both Python and Node ≥ 22.5, then use the launcher as
  above. Tell me which and I'll generate the exact config.

> Note: a Railway **Volume** can normally only be attached to one service at a
> time. If you go the two-service route, confirm your plan supports the shared
> volume; otherwise keep everything in the one service with the launcher.

---

## Files in this folder
| File | What it is |
|------|-----------|
| `railway-start.mjs` | Launcher — runs your bot (`BOT_CMD`) + the dashboard together. |
| `server.mjs` | The dashboard server (API + UI), zero dependencies, read-only DB access. |
| `public/` | The built dashboard UI served at `/tv`. |
| `package.json` | `npm start` → the launcher; `engines` pins Node ≥ 22.5. |
