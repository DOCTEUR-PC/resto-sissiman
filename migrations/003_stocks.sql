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
