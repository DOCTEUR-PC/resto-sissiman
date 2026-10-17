CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- The first account becomes the owner; it was the only manager-level account until now.
UPDATE staff SET role = 'proprietaire' WHERE id = (SELECT MIN(id) FROM staff);
