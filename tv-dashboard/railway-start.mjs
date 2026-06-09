/**
 * Uprise Financial — Railway launcher (bot + TV dashboard in ONE service)
 * ----------------------------------------------------------------------
 * Railway runs a single start command per service, but we need BOTH:
 *   1. your existing Discord sales bot  (the SOLE writer to uprise.sqlite)
 *   2. the TV dashboard web server      (read-only reader of uprise.sqlite)
 *
 * Running them in the same service means they share the same container
 * filesystem, so the dashboard can read /app/uprise.sqlite directly.
 *
 * This launcher:
 *   - spawns your bot as a child process (unchanged, still the only writer)
 *   - runs the dashboard server in THIS process (binds Railway's $PORT)
 *   - if the bot dies, it exits so Railway restarts the whole service
 *   - forwards shutdown signals so redeploys stop the bot cleanly
 *
 * Required env var:
 *   BOT_CMD   The exact command you use today to start your bot,
 *             e.g. "python bot.py"  or  "node index.js"  or  "npm run bot"
 *
 * Set this as your Railway service Start Command:
 *   node tv-dashboard/railway-start.mjs
 */

import { spawn } from "node:child_process";

const BOT_CMD = process.env.BOT_CMD;

if (!BOT_CMD || !BOT_CMD.trim()) {
  console.error(
    "[launcher] BOT_CMD env var is required — set it to your bot's start " +
      'command, e.g. BOT_CMD="python bot.py" or BOT_CMD="node index.js".',
  );
  process.exit(1);
}

console.log(`[launcher] Starting Discord bot:  ${BOT_CMD}`);

// The bot keeps doing exactly what it does today — it remains the sole writer.
const bot = spawn(BOT_CMD, {
  shell: true,
  stdio: "inherit",
  env: process.env,
});

let shuttingDown = false;

bot.on("exit", (code, signal) => {
  if (shuttingDown) return;
  console.error(
    `[launcher] Bot process exited (code=${code}, signal=${signal}). ` +
      "Exiting so Railway restarts the service.",
  );
  process.exit(code ?? 1);
});

bot.on("error", (err) => {
  console.error("[launcher] Failed to start bot:", err);
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    shuttingDown = true;
    console.log(`[launcher] Received ${sig}, stopping bot...`);
    try {
      bot.kill(sig);
    } finally {
      process.exit(0);
    }
  });
}

// Start the dashboard web server in this process. It binds Railway's $PORT
// and reads uprise.sqlite read-only (set UPRISE_SQLITE_PATH=/app/uprise.sqlite).
console.log("[launcher] Starting TV dashboard web server...");
await import("./server.mjs");
