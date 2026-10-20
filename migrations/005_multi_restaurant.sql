-- Multi-restaurant: every business table gets a restaurant_id; existing data belongs to the pilot restaurant.

CREATE TABLE IF NOT EXISTS restaurants (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    city TEXT,
    phone TEXT,
    plan TEXT NOT NULL DEFAULT 'professionnel',
    status TEXT NOT NULL DEFAULT 'actif',
    paid_until INTEGER,
    created_at INTEGER NOT NULL,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS subscription_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    restaurant_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    plan TEXT,
    months INTEGER,
    amount INTEGER,
    paid_until INTEGER,
    staff_name TEXT,
    note TEXT
);
CREATE INDEX IF NOT EXISTS idx_sub_events ON subscription_events (restaurant_id, at);

INSERT INTO restaurants (id, slug, name, city, plan, status, paid_until, created_at, notes)
SELECT 'r_sissiman', 'sissiman', 'Restaurant Sissiman', 'Bobo-Dioulasso, Burkina Faso', 'professionnel', 'actif',
       1830297600000, CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'Restaurant pilote'
WHERE NOT EXISTS (SELECT 1 FROM restaurants);

-- records: primary key now includes the restaurant
CREATE TABLE records_new (
    restaurant_id TEXT NOT NULL,
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (restaurant_id, collection, id)
);
INSERT INTO records_new (restaurant_id, collection, id, data, deleted, updated_at)
SELECT 'r_sissiman', collection, id, data, deleted, updated_at FROM records;
DROP TABLE records;
ALTER TABLE records_new RENAME TO records;
CREATE INDEX IF NOT EXISTS idx_records_updated ON records (restaurant_id, updated_at);

CREATE TABLE counters_new (
    restaurant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    value INTEGER NOT NULL,
    PRIMARY KEY (restaurant_id, name)
);
INSERT INTO counters_new SELECT 'r_sissiman', name, value FROM counters;
DROP TABLE counters;
ALTER TABLE counters_new RENAME TO counters;

CREATE TABLE settings_new (
    restaurant_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (restaurant_id, key)
);
INSERT INTO settings_new SELECT 'r_sissiman', key, value FROM settings;
DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;

-- staff: usernames are unique per restaurant; is_platform marks Docteur PC administrators.
CREATE TABLE staff_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    restaurant_id TEXT NOT NULL,
    username TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    pass_salt TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    must_change_pw INTEGER NOT NULL DEFAULT 0,
    is_platform INTEGER NOT NULL DEFAULT 0,
    UNIQUE (restaurant_id, username)
);
INSERT INTO staff_new (id, restaurant_id, username, name, role, pass_hash, pass_salt, created_at, must_change_pw, is_platform)
SELECT id, 'r_sissiman', username, name, role, pass_hash, pass_salt, created_at, must_change_pw,
       CASE WHEN id = (SELECT MIN(id) FROM staff) THEN 1 ELSE 0 END FROM staff;
DROP TABLE staff;
ALTER TABLE staff_new RENAME TO staff;

ALTER TABLE audit ADD COLUMN restaurant_id TEXT;
UPDATE audit SET restaurant_id = 'r_sissiman';
CREATE INDEX IF NOT EXISTS idx_audit_restaurant ON audit (restaurant_id, id);

ALTER TABLE stock_moves ADD COLUMN restaurant_id TEXT;
UPDATE stock_moves SET restaurant_id = 'r_sissiman';
CREATE INDEX IF NOT EXISTS idx_moves_restaurant ON stock_moves (restaurant_id, ingredient_id, at);
