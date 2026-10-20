// Outils communs aux scripts de maintenance (saisie masquee, hachage identique au Worker, requetes D1).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const PBKDF2_ITERATIONS = 25000;   // doit rester identique a src/worker.js
const DEFAULT_ADMIN_PASSWORD = 'admin123';

// Lu a chaque appel : la cible (locale ou production) ne peut pas changer entre l'annonce et l'execution.
const isLocal = () => process.argv.includes('--local');

function arg(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, a => { rl.close(); resolve(a.trim()); }));
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

// Demande deux fois le mot de passe et applique les memes regles que l'application.
async function askNewPassword() {
    const pw = await askHidden('Nouveau mot de passe (8 caracteres minimum) : ');
    if (pw.length < 8) throw new Error('Trop court : au moins 8 caracteres. Rien n\'a ete modifie.');
    if (pw === DEFAULT_ADMIN_PASSWORD) throw new Error('Choisissez un mot de passe different du mot de passe par defaut.');
    const again = await askHidden('Confirmez le mot de passe : ');
    if (again !== pw) throw new Error('Les deux saisies ne correspondent pas. Rien n\'a ete modifie.');
    return pw;
}

function hashPassword(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(Buffer.from(pw, 'utf8'), Buffer.from(salt, 'utf8'), PBKDF2_ITERATIONS, 32, 'sha256').toString('hex');
    return { hash, salt };
}

const sqlText = v => "'" + String(v).replace(/'/g, "''") + "'";

// Execute un fichier SQL temporaire sur la base locale (--local) ou de production.
function runSql(sql) {
    const file = path.join(os.tmpdir(), `resto-maint-${process.pid}.sql`);
    fs.writeFileSync(file, sql, { mode: 0o600 });
    try {
        const cmd = `npx --yes wrangler@4 d1 execute sissiman ${isLocal() ? '--local' : '--remote'} --file="${file}" --yes`;
        const r = spawnSync(cmd, { cwd: path.join(__dirname, '..'), stdio: 'inherit', shell: true });
        if (r.status !== 0) throw new Error('Echec de la requete sur la base. Rien n\'a ete modifie.');
    } finally {
        fs.rmSync(file, { force: true });
    }
}

module.exports = { isLocal, arg, ask, askHidden, askNewPassword, hashPassword, sqlText, runSql };
