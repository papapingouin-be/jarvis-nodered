const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.TRACE_MONITOR_DB || path.join(dataDir, 'trace-monitor.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  service TEXT NOT NULL,
  level TEXT,
  trace_id TEXT NOT NULL,
  span_id TEXT,
  parent_span_id TEXT,
  event TEXT NOT NULL,
  stage TEXT,
  tool TEXT,
  intent TEXT,
  status TEXT,
  summary TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_trace_ts ON events(trace_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_service_ts ON events(service, ts);
CREATE INDEX IF NOT EXISTS idx_events_event_ts ON events(event, ts);
`);

module.exports = db;
