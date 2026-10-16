ALTER TABLE staff ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    staff_id INTEGER,
    staff_name TEXT,
    action TEXT NOT NULL,
    collection TEXT,
    record_id TEXT,
    detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit (at);

CREATE TABLE IF NOT EXISTS login_attempts (
    key TEXT PRIMARY KEY,
    fails INTEGER NOT NULL,
    locked_until INTEGER NOT NULL
);
