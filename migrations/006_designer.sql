-- Docteur PC designer access: a home space for the designer accounts and,
-- per login session, the restaurant the designer is currently working in.
ALTER TABLE sessions ADD COLUMN acting_restaurant_id TEXT;

INSERT OR IGNORE INTO restaurants (id, slug, name, city, phone, plan, status, paid_until, created_at, notes)
VALUES ('r_docteurpc', 'docteurpc', 'Docteur PC', 'Bobo-Dioulasso, Burkina Faso', '', 'multisites', 'actif',
        4102444800000, CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'Espace concepteur (plateforme)');
