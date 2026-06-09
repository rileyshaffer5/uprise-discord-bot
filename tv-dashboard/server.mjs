/**
 * Uprise Financial — TV Dashboard (standalone, drop-in server)
 * ------------------------------------------------------------------
 * A single, ZERO-dependency Node server that:
 *   1. Serves the live leaderboard API at  GET /api/leaderboards
 *   2. Serves the dashboard web UI (static build) at  /tv
 *
 * It reads sales LIVE and READ-ONLY from the Discord bot's uprise.sqlite.
 * It NEVER writes to the database — the bot stays the sole writer/logger.
 *
 * Requirements: Node >= 22.5 (uses the built-in `node:sqlite` module).
 * No `npm install` needed.
 *
 * Run:
 *   UPRISE_SQLITE_PATH=/path/to/uprise.sqlite node server.mjs
 * Then open:  http://localhost:5000/tv
 *
 * Environment variables:
 *   PORT               Port to listen on            (default 5000)
 *   UPRISE_SQLITE_PATH Path to the bot's uprise.sqlite
 *                      (default: ./uprise.sqlite beside this file)
 *   DASHBOARD_TIMEZONE Office timezone for day/week/month bucketing
 *                      (default America/New_York)
 *   MONTHLY_GOAL       Monthly production goal in dollars (default 1000000)
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(HERE, "public");
const BASE_PATH = "/tv";

const PORT = (() => {
  const n = Number(process.env.PORT);
  return Number.isFinite(n) && n > 0 ? n : 5000;
})();

const TIMEZONE = process.env.DASHBOARD_TIMEZONE || "America/New_York";

const MONTHLY_GOAL = (() => {
  const raw = Number(process.env.MONTHLY_GOAL);
  return Number.isFinite(raw) && raw > 0 ? raw : 1_000_000;
})();

function resolveDbPath() {
  if (process.env.UPRISE_SQLITE_PATH) return process.env.UPRISE_SQLITE_PATH;
  return join(HERE, "uprise.sqlite");
}

// ---------------------------------------------------------------------------
// Live leaderboard computation (read-only) from the bot's `sales` table.
//
// sales columns (owned by the bot, do NOT change):
//   id, agent_discord_id, agent_name, amount, carrier,
//   effective_date, sale_date, created_at, source_message_id
//
// Date filtering uses created_at (ISO string the bot sets on insert).
// sale_date is intentionally NOT used — the bot does not populate it.
// ---------------------------------------------------------------------------

const tzFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Calendar date (in the office timezone) as a YYYYMMDD integer for ordering. */
function dateNumInTz(d) {
  const [y, m, day] = tzFormatter.format(d).split("-").map(Number);
  return y * 10000 + m * 100 + day;
}

function monthKeyInTz(d) {
  return Math.floor(dateNumInTz(d) / 100); // YYYYMM
}

/** Parse a created_at value into a JS Date (ISO string, "YYYY-MM-DD HH:MM:SS", date, or epoch). */
function parseTimestamp(value) {
  if (value == null) return null;

  if (typeof value === "number") {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }

  const raw = String(value).trim();
  if (raw === "") return null;

  if (/^\d+$/.test(raw)) {
    const num = Number(raw);
    const ms = num < 1e12 ? num * 1000 : num;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }

  if (/[tT].*(\d|:)/.test(raw) || /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }

  if (/^\d{4}-\d{2}-\d{2}[ ]\d{2}:\d{2}/.test(raw)) {
    const d = new Date(raw.replace(" ", "T") + "Z");
    return isNaN(d.getTime()) ? null : d;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(raw + "T12:00:00Z");
    return isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

function parseAmount(value) {
  if (value == null) return 0;
  if (typeof value === "number") return isFinite(value) ? value : 0;
  const n = Number(String(value).replace(/[^0-9.-]/g, ""));
  return isFinite(n) ? n : 0;
}

function topTen(totals) {
  return [...totals.entries()]
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);
}

function readSales() {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    console.warn(
      `[tv-dashboard] uprise.sqlite not found at "${dbPath}" — returning empty leaderboards. ` +
        `Set UPRISE_SQLITE_PATH to the bot's uprise.sqlite file.`,
    );
    return [];
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const stmt = db.prepare("SELECT agent_name, amount, created_at FROM sales");
    return stmt.all();
  } finally {
    db.close();
  }
}

/**
 * Compute live daily / weekly / monthly leaderboards and agency totals.
 * "Today", "this week" (Sunday start), and "this month" are evaluated in the
 * office timezone (DASHBOARD_TIMEZONE, default ET).
 */
function computeLeaderboards() {
  const rows = readSales();

  const now = new Date();
  const todayNum = dateNumInTz(now);
  const thisMonthKey = monthKeyInTz(now);

  const [ty, tm, td] = tzFormatter.format(now).split("-").map(Number);
  const todayUtc = new Date(Date.UTC(ty, tm - 1, td));
  const weekday = todayUtc.getUTCDay(); // 0 = Sunday
  const weekStartUtc = new Date(todayUtc);
  weekStartUtc.setUTCDate(weekStartUtc.getUTCDate() - weekday);
  const weekStartNum =
    weekStartUtc.getUTCFullYear() * 10000 +
    (weekStartUtc.getUTCMonth() + 1) * 100 +
    weekStartUtc.getUTCDate();

  const daily = new Map();
  const weekly = new Map();
  const monthly = new Map();
  let dailyTotal = 0;
  let weeklyTotal = 0;
  let monthlyTotal = 0;
  let dailyDeals = 0;
  let weeklyDeals = 0;
  let monthlyDeals = 0;

  for (const row of rows) {
    const name = (row.agent_name ?? "").trim();
    if (!name) continue;

    const date = parseTimestamp(row.created_at);
    if (!date) continue;

    const amount = parseAmount(row.amount);
    const saleNum = dateNumInTz(date);
    const saleMonthKey = Math.floor(saleNum / 100);

    if (saleMonthKey === thisMonthKey) {
      monthly.set(name, (monthly.get(name) ?? 0) + amount);
      monthlyTotal += amount;
      monthlyDeals += 1;
    }
    if (saleNum >= weekStartNum && saleNum <= todayNum) {
      weekly.set(name, (weekly.get(name) ?? 0) + amount);
      weeklyTotal += amount;
      weeklyDeals += 1;
    }
    if (saleNum === todayNum) {
      daily.set(name, (daily.get(name) ?? 0) + amount);
      dailyTotal += amount;
      dailyDeals += 1;
    }
  }

  return {
    daily: topTen(daily),
    weekly: topTen(weekly),
    monthly: topTen(monthly),
    metrics: {
      dailyTotal,
      weeklyTotal,
      monthlyTotal,
      dailyDeals,
      weeklyDeals,
      monthlyDeals,
      monthlyGoal: MONTHLY_GOAL,
      monthlyGoalProgress: MONTHLY_GOAL > 0 ? monthlyTotal / MONTHLY_GOAL : 0,
    },
    updatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tiny static file server (no dependencies).
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-cache",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function sendFile(res, filePath) {
  const data = await readFile(filePath);
  res.writeHead(200, {
    "content-type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
    "cache-control": "no-cache",
    "content-length": data.length,
  });
  res.end(data);
}

/** Resolve a request path (relative to PUBLIC_DIR) safely, blocking traversal. */
function safeJoin(relPath) {
  const clean = normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const full = resolve(PUBLIC_DIR, "." + sep + clean);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + sep)) return null;
  return full;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = decodeURIComponent(url.pathname);

    // Live data API.
    if (pathname === "/api/leaderboards") {
      try {
        return sendJson(res, 200, computeLeaderboards());
      } catch (err) {
        console.error("[tv-dashboard] Failed to compute leaderboards:", err);
        return sendJson(res, 500, { error: "Failed to compute leaderboards" });
      }
    }

    // Send the bare root to the dashboard.
    if (pathname === "/" || pathname === "") {
      res.writeHead(302, { location: `${BASE_PATH}/` });
      return res.end();
    }

    // Dashboard UI under /tv.
    if (pathname === BASE_PATH || pathname.startsWith(BASE_PATH + "/")) {
      let rel = pathname.slice(BASE_PATH.length); // "", "/", "/assets/x.js", "/slide1"
      if (rel === "" || rel === "/") rel = "/index.html";

      const filePath = safeJoin(rel);
      if (filePath && existsSync(filePath) && statSync(filePath).isFile()) {
        return await sendFile(res, filePath);
      }

      // SPA fallback: client-side routes (no file extension) -> index.html.
      if (!extname(rel)) {
        const indexPath = join(PUBLIC_DIR, "index.html");
        if (existsSync(indexPath)) return await sendFile(res, indexPath);
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (err) {
    console.error("[tv-dashboard] Request error:", err);
    if (!res.headersSent) res.writeHead(500);
    res.end("Internal Server Error");
  }
});

server.listen(PORT, () => {
  console.log(`[tv-dashboard] Listening on http://localhost:${PORT}`);
  console.log(`[tv-dashboard]   Dashboard: http://localhost:${PORT}${BASE_PATH}`);
  console.log(`[tv-dashboard]   API:       http://localhost:${PORT}/api/leaderboards`);
  console.log(`[tv-dashboard]   Database:  ${resolveDbPath()}`);
  console.log(`[tv-dashboard]   Timezone:  ${TIMEZONE}   Monthly goal: $${MONTHLY_GOAL.toLocaleString("en-US")}`);
});
