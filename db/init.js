import Database from "better-sqlite3";

const db = new Database("uprise.sqlite");

db.exec(`
  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_discord_id TEXT,
    agent_name TEXT,
    amount REAL,
    carrier TEXT,
    effective_date TEXT,
    sale_date TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    source_message_id TEXT UNIQUE
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS bot_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

export default db;