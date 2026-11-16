import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, "mainframe.db"));

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,              -- email | website | handmatig | inkoop
  external_id   TEXT,                       -- bv. Graph message id
  received_at   TEXT NOT NULL,
  customer_name TEXT,
  company       TEXT,
  email         TEXT,
  phone         TEXT,
  subject       TEXT,
  body          TEXT,
  status        TEXT NOT NULL DEFAULT 'nieuw', -- nieuw | in_behandeling | concept_klaar | verstuurd | gewonnen | verloren | fout
  priority      TEXT DEFAULT 'normaal',     -- laag | normaal | hoog | spoed
  category      TEXT,
  summary       TEXT,
  quote_json    TEXT,                       -- AI-inschatting (regels, totalen, aannames)
  reply_draft   TEXT,
  estimator     TEXT,                       -- claude | regels
  error         TEXT,
  updated_at    TEXT NOT NULL,
  UNIQUE(source, external_id)
);
CREATE TABLE IF NOT EXISTS activity (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL,
  kind      TEXT NOT NULL,                  -- info | succes | waarschuwing | fout
  source    TEXT NOT NULL,
  message   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS integration_state (
  name        TEXT PRIMARY KEY,
  status      TEXT NOT NULL,                -- verbonden | niet_geconfigureerd | fout | demo | gepland
  last_sync   TEXT,
  detail      TEXT
);
CREATE TABLE IF NOT EXISTS finance_cache (
  key        TEXT PRIMARY KEY,
  json       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

export const now = () => new Date().toISOString();

export function logActivity(kind: "info" | "succes" | "waarschuwing" | "fout", source: string, message: string) {
  db.prepare("INSERT INTO activity (at, kind, source, message) VALUES (?, ?, ?, ?)").run(now(), kind, source, message);
}

export function setIntegrationState(name: string, status: string, detail = "") {
  db.prepare(`INSERT INTO integration_state (name, status, last_sync, detail) VALUES (?, ?, ?, ?)
              ON CONFLICT(name) DO UPDATE SET status=excluded.status, last_sync=excluded.last_sync, detail=excluded.detail`)
    .run(name, status, now(), detail);
}

export function cacheSet(key: string, value: unknown) {
  db.prepare(`INSERT INTO finance_cache (key, json, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at`)
    .run(key, JSON.stringify(value), now());
}
export function cacheGet<T>(key: string): { value: T; updatedAt: string } | null {
  const row = db.prepare("SELECT json, updated_at FROM finance_cache WHERE key = ?").get(key) as
    { json: string; updated_at: string } | undefined;
  return row ? { value: JSON.parse(row.json) as T, updatedAt: row.updated_at } : null;
}
