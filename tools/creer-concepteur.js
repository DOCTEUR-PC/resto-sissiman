#!/usr/bin/env node
// Cree (ou met a jour) un compte concepteur Docteur PC : il se connecte avec le code restaurant
// "docteurpc", voit la console Plateforme et peut ouvrir chaque restaurant avec tous les droits.
//
// Usage :
//   node tools/creer-concepteur.js            -> production
//   node tools/creer-concepteur.js --local    -> base locale de wrangler dev

const { isLocal, ask, askNewPassword, hashPassword, sqlText, runSql } = require('./helpers');

(async () => {
    console.log(`Compte concepteur Docteur PC sur la base ${isLocal() ? 'LOCALE' : 'de PRODUCTION'}.\n`);
    const name = await ask('Votre nom complet (ex: Hamza BENGALY) : ');
    if (name.length < 2 || name.length > 60) throw new Error('Nom invalide (2 a 60 caracteres).');
    const username = (await ask('Identifiant de connexion (ex: hamza) : ')).toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new Error('Identifiant invalide : 3 a 30 caracteres, lettres minuscules, chiffres, . _ -');
    const { hash, salt } = hashPassword(await askNewPassword());
    const now = Date.now();
    const rid = "'r_docteurpc'";

    runSql([
        // L'espace concepteur existe des la migration 006 ; on le cree au besoin pour une base plus ancienne.
        `INSERT OR IGNORE INTO restaurants (id, slug, name, city, phone, plan, status, paid_until, created_at, notes)
            VALUES (${rid}, 'docteurpc', 'Docteur PC', 'Bobo-Dioulasso, Burkina Faso', '', 'multisites', 'actif', 4102444800000, ${now}, 'Espace concepteur (plateforme)');`,
        `INSERT INTO staff (restaurant_id, username, name, role, pass_hash, pass_salt, created_at, must_change_pw, is_platform)
            VALUES (${rid}, ${sqlText(username)}, ${sqlText(name)}, 'proprietaire', '${hash}', '${salt}', ${now}, 0, 1)
            ON CONFLICT (restaurant_id, username) DO UPDATE SET name = excluded.name, role = 'proprietaire',
                pass_hash = excluded.pass_hash, pass_salt = excluded.pass_salt, must_change_pw = 0, is_platform = 1;`,
        `DELETE FROM login_attempts;`,
        `INSERT INTO audit (restaurant_id, at, staff_id, staff_name, action, collection, record_id, detail)
            SELECT ${rid}, ${now}, NULL, 'Script de maintenance', 'concepteur_compte', 'staff', CAST(id AS TEXT), '{"via":"tools/creer-concepteur.js"}'
            FROM staff WHERE restaurant_id = ${rid} AND username = ${sqlText(username)};`,
        `SELECT username, name, 'compte concepteur pret' AS resultat FROM staff WHERE restaurant_id = ${rid} AND username = ${sqlText(username)};`
    ].join('\n'));

    console.log('\nConnexion : code restaurant "docteurpc", identifiant "' + username + '" et le mot de passe choisi.');
})().catch(e => { console.error('\n' + e.message); process.exitCode = 1; });
