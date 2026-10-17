CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    pass_salt TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    must_change_pw INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    staff_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_staff ON sessions (staff_id);

CREATE TABLE IF NOT EXISTS records (
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS idx_records_updated ON records (updated_at);

CREATE TABLE IF NOT EXISTS counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);

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
CREATE TABLE IF NOT EXISTS stock_moves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT UNIQUE,
    at INTEGER NOT NULL,
    ingredient_id TEXT NOT NULL,
    qty REAL NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT,
    unit_cost REAL,
    staff_id INTEGER,
    staff_name TEXT,
    note TEXT
);
CREATE INDEX IF NOT EXISTS idx_moves_ingredient ON stock_moves (ingredient_id, at);
CREATE INDEX IF NOT EXISTS idx_moves_ref ON stock_moves (ref);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
