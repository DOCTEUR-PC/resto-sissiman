#!/usr/bin/env node
// Reinitialise le mot de passe d'un compte directement dans la base D1.
// Le mot de passe est saisi masque, hache sur ce PC (PBKDF2, comme le Worker)
// et seuls le hash et le sel sont envoyes a Cloudflare.
//
// Usage :
//   node tools/reset-admin-password.js                 -> production, compte admin de sissiman
//   node tools/reset-admin-password.js --local         -> base locale de wrangler dev
//   node tools/reset-admin-password.js --user gerant --restaurant sissiman

const { isLocal, arg, askNewPassword, hashPassword, sqlText, runSql } = require('./helpers');

const username = arg('user', 'admin');
const slug = arg('restaurant', 'sissiman').toLowerCase();

(async () => {
    if (!/^[a-z0-9-]{2,40}$/.test(slug) || !/^[\w.@-]{1,40}$/.test(username)) throw new Error('Code restaurant ou identifiant invalide.');
    console.log(`Reinitialisation du mot de passe de "${username}" (restaurant "${slug}") sur la base ${isLocal() ? 'LOCALE' : 'de PRODUCTION'}.`);
    const { hash, salt } = hashPassword(await askNewPassword());
    const now = Date.now();
    const staffWhere = `restaurant_id = (SELECT id FROM restaurants WHERE slug = ${sqlText(slug)}) AND username = ${sqlText(username)}`;
    runSql([
        `UPDATE staff SET pass_hash = '${hash}', pass_salt = '${salt}', must_change_pw = 0 WHERE ${staffWhere};`,
        // Deconnecte les anciennes sessions de ce compte et leve un eventuel blocage.
        `DELETE FROM sessions WHERE staff_id IN (SELECT id FROM staff WHERE ${staffWhere});`,
        `DELETE FROM login_attempts;`,
        `INSERT INTO audit (restaurant_id, at, staff_id, staff_name, action, collection, record_id, detail)
            SELECT restaurant_id, ${now}, NULL, 'Script de maintenance', 'mot_de_passe_reinitialise', 'staff', CAST(id AS TEXT), '{"via":"tools/reset-admin-password.js"}'
            FROM staff WHERE ${staffWhere};`,
        `SELECT username, restaurant_id, 'mot de passe mis a jour' AS resultat FROM staff WHERE ${staffWhere};`
    ].join('\n'));
    console.log('\nSi le tableau ci-dessus montre une ligne, connectez-vous avec le nouveau mot de passe.');
    console.log('S\'il est vide, le compte ou le code restaurant n\'existe pas : rien n\'a ete modifie.');
})().catch(e => { console.error('\n' + e.message); process.exitCode = 1; });
