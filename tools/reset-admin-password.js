#!/usr/bin/env node
// Reinitialise le mot de passe d'un compte directement dans la base D1.
// Le mot de passe est saisi masque, hache sur ce PC (PBKDF2, comme le Worker)
// et seuls le hash et le sel sont envoyes a Cloudflare.
//
// Usage :
//   node tools/reset-admin-password.js                 -> production, compte admin de sissiman
//   node tools/reset-admin-password.js --local         -> base locale de wrangler dev
//   node tools/reset-admin-password.js --user gerant --restaurant sissiman

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PBKDF2_ITERATIONS = 25000;   // doit rester identique a src/worker.js
const DEFAULT_ADMIN_PASSWORD = 'admin123';

function arg(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const local = process.argv.includes('--local');
const username = arg('user', 'admin');
const slug = arg('restaurant', 'sissiman').toLowerCase();
if (!/^[a-z0-9-]{2,40}$/.test(slug) || !/^[\w.@-]{1,40}$/.test(username)) {
    console.error('Code restaurant ou identifiant invalide.');
    process.exit(1);
}

function askHidden(question) {
    return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        if (!stdin.isTTY) return reject(new Error('Lancez ce script dans un terminal interactif.'));
        process.stdout.write(question);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        let value = '';
        const onData = chunk => {
            for (const ch of chunk) {
                if (ch === '\r' || ch === '\n') {
                    stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
                    process.stdout.write('\n');
                    return resolve(value);
                }
                if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
                if (ch === '\u007f' || ch === '\b') { if (value) { value = value.slice(0, -1); process.stdout.write('\b \b'); } continue; }
                if (ch >= ' ') { value += ch; process.stdout.write('*'); }
            }
        };
        stdin.on('data', onData);
    });
}

function d1(sqlFile) {
    const cmd = `npx --yes wrangler@4 d1 execute sissiman ${local ? '--local' : '--remote'} --file="${sqlFile}" --yes`;
    return spawnSync(cmd, { cwd: path.join(__dirname, '..'), stdio: 'inherit', shell: true });
}

(async () => {
    console.log(`Reinitialisation du mot de passe de "${username}" (restaurant "${slug}") sur la base ${local ? 'LOCALE' : 'de PRODUCTION'}.`);
    const pw = await askHidden('Nouveau mot de passe (8 caracteres minimum) : ');
    if (pw.length < 8) { console.error('Trop court : au moins 8 caracteres.'); process.exit(1); }
    if (pw === DEFAULT_ADMIN_PASSWORD) { console.error('Choisissez un mot de passe different du mot de passe par defaut.'); process.exit(1); }
    const again = await askHidden('Confirmez le mot de passe : ');
    if (again !== pw) { console.error('Les deux saisies ne correspondent pas. Rien n\'a ete modifie.'); process.exit(1); }

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(Buffer.from(pw, 'utf8'), Buffer.from(salt, 'utf8'), PBKDF2_ITERATIONS, 32, 'sha256').toString('hex');
    const now = Date.now();
    const staffWhere = `restaurant_id = (SELECT id FROM restaurants WHERE slug = '${slug}') AND username = '${username}'`;
    const sql = [
        `UPDATE staff SET pass_hash = '${hash}', pass_salt = '${salt}', must_change_pw = 0 WHERE ${staffWhere};`,
        // Deconnecte les anciennes sessions de ce compte et leve un eventuel blocage.
        `DELETE FROM sessions WHERE staff_id IN (SELECT id FROM staff WHERE ${staffWhere});`,
        `DELETE FROM login_attempts;`,
        `INSERT INTO audit (restaurant_id, at, staff_id, staff_name, action, collection, record_id, detail)
            SELECT restaurant_id, ${now}, NULL, 'Script de maintenance', 'mot_de_passe_reinitialise', 'staff', CAST(id AS TEXT), '{"via":"tools/reset-admin-password.js"}'
            FROM staff WHERE ${staffWhere};`,
        `SELECT username, restaurant_id, 'mot de passe mis a jour' AS resultat FROM staff WHERE ${staffWhere};`
    ].join('\n');

    const file = path.join(os.tmpdir(), `reset-pw-${process.pid}.sql`);
    fs.writeFileSync(file, sql, { mode: 0o600 });
    try {
        const r = d1(file);
        if (r.status !== 0) { console.error('Echec de la mise a jour. Rien n\'a ete modifie.'); process.exit(1); }
    } finally {
        fs.rmSync(file, { force: true });
    }
    console.log('\nSi le tableau ci-dessus montre une ligne, connectez-vous avec le nouveau mot de passe.');
    console.log('S\'il est vide, le compte ou le code restaurant n\'existe pas : rien n\'a ete modifie.');
})().catch(e => { console.error(e.message); process.exit(1); });
