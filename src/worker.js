const COLLECTIONS = new Set(['tables', 'categories', 'menuItems', 'orders', 'payments']);
const ROLES = new Set(['gerant', 'caissier', 'serveur', 'cuisinier']);
const SESSION_TTL = 7 * 24 * 3600 * 1000;
// Workers free plan caps CPU at ~10 ms per request; keep PBKDF2 cheap enough to fit.
const PBKDF2_ITERATIONS = 25000;
const MAX_CHANGES = 200;
const MAX_RECORD_BYTES = 50000;

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});
const fail = (status, error) => json({ error }, status);

async function hashPassword(password, salt) {
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS }, key, 256);
    return hex(bits);
}

function safeEqual(a, b) {
    if (a.length !== b.length) return false;
    let r = 0;
    for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return r === 0;
}

const publicStaff = s => ({ id: s.id, username: s.username, name: s.name, role: s.role });

async function readBody(request) {
    try { return await request.json(); } catch { return null; }
}

async function ensureAdmin(db) {
    const row = await db.prepare('SELECT COUNT(*) AS n FROM staff').first();
    if (row.n > 0) return;
    const salt = randomHex(16);
    await db.prepare('INSERT INTO staff (username, name, role, pass_hash, pass_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind('admin', 'Administrateur', 'gerant', await hashPassword('admin123', salt), salt, Date.now()).run();
}

async function getUser(request, db) {
    const m = (request.headers.get('Authorization') || '').match(/^Bearer ([a-f0-9]{64})$/);
    if (!m) return null;
    return db.prepare(`SELECT s.id, s.username, s.name, s.role FROM sessions x
        JOIN staff s ON s.id = x.staff_id WHERE x.token_hash = ? AND x.expires_at > ?`)
        .bind(await sha256(m[1]), Date.now()).first();
}

async function login(request, db) {
    const body = await readBody(request);
    const username = body && typeof body.username === 'string' ? body.username.trim() : '';
    const password = body && typeof body.password === 'string' ? body.password : '';
    if (!username || !password) return fail(400, 'Identifiants manquants');

    await ensureAdmin(db);
    const s = await db.prepare('SELECT * FROM staff WHERE username = ?').bind(username).first();
    const hash = await hashPassword(password, s ? s.pass_salt : 'no-such-user');
    if (!s || !safeEqual(hash, s.pass_hash)) return fail(401, 'Identifiant ou mot de passe incorrect');

    const token = randomHex(32);
    const now = Date.now();
    await db.batch([
        db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
        db.prepare('INSERT INTO sessions (token_hash, staff_id, expires_at) VALUES (?, ?, ?)')
            .bind(await sha256(token), s.id, now + SESSION_TTL)
    ]);
    return json({ token, user: publicStaff(s) });
}

async function pull(url, db) {
    const since = Math.max(0, parseInt(url.searchParams.get('since'), 10) || 0);
    const now = Date.now();
    const sql = since === 0
        ? 'SELECT collection, id, data, deleted FROM records WHERE deleted = 0'
        : 'SELECT collection, id, data, deleted FROM records WHERE updated_at >= ?';
    const stmt = since === 0 ? db.prepare(sql) : db.prepare(sql).bind(since);
    const { results } = await stmt.all();
    return json({ now, records: results });
}

async function push(request, db) {
    const body = await readBody(request);
    const changes = body && Array.isArray(body.changes) ? body.changes : null;
    if (!changes || changes.length === 0 || changes.length > MAX_CHANGES) return fail(400, 'Modifications invalides');

    const now = Date.now();
    const stmts = [];
    for (const c of changes) {
        if (!c || !COLLECTIONS.has(c.collection) || typeof c.id !== 'string' || !c.id || c.id.length > 100) {
            return fail(400, 'Modification invalide');
        }
        if (c.data !== null) {
            if (typeof c.data !== 'string' || c.data.length > MAX_RECORD_BYTES) return fail(400, 'Donnees invalides');
            let parsed;
            try { parsed = JSON.parse(c.data); } catch { return fail(400, 'Donnees invalides'); }
            if (!parsed || typeof parsed !== 'object' || String(parsed.id) !== c.id) return fail(400, 'Donnees invalides');
        }
        stmts.push(db.prepare(`INSERT INTO records (collection, id, data, deleted, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, deleted = excluded.deleted, updated_at = excluded.updated_at`)
            .bind(c.collection, c.id, c.data, c.data === null ? 1 : 0, now));
    }
    await db.batch(stmts);
    return json({ ok: true, now });
}

async function nextOrderNumber(request, db) {
    const body = await readBody(request);
    const min = Math.max(1, parseInt(body && body.min, 10) || 1);
    const row = await db.prepare(`INSERT INTO counters (name, value) VALUES ('order', ?)
        ON CONFLICT (name) DO UPDATE SET value = MAX(value + 1, excluded.value) RETURNING value`).bind(min).first();
    return json({ number: row.value });
}

function validateStaff(body, creating) {
    if (!body) return 'Donnees invalides';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!name || name.length > 60) return 'Nom invalide';
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) return 'Identifiant invalide (3 a 32 caracteres : lettres, chiffres, . _ -)';
    if (!ROLES.has(body.role)) return 'Role invalide';
    if ((creating || password) && password.length < 6) return 'Mot de passe trop court (6 caracteres minimum)';
    return null;
}

async function createStaff(request, db) {
    const body = await readBody(request);
    const error = validateStaff(body, true);
    if (error) return fail(400, error);
    const salt = randomHex(16);
    try {
        const row = await db.prepare(`INSERT INTO staff (username, name, role, pass_hash, pass_salt, created_at)
            VALUES (?, ?, ?, ?, ?, ?) RETURNING id, username, name, role`)
            .bind(body.username.trim(), body.name.trim(), body.role, await hashPassword(body.password, salt), salt, Date.now()).first();
        return json({ staff: row }, 201);
    } catch (e) {
        if (String(e).includes('UNIQUE')) return fail(409, 'Cet identifiant existe deja');
        throw e;
    }
}

async function updateStaff(request, db, id) {
    const body = await readBody(request);
    const error = validateStaff(body, false);
    if (error) return fail(400, error);
    const role = id === 1 ? 'gerant' : body.role;
    const stmts = [];
    if (body.password) {
        const salt = randomHex(16);
        stmts.push(db.prepare('UPDATE staff SET username = ?, name = ?, role = ?, pass_hash = ?, pass_salt = ? WHERE id = ?')
            .bind(body.username.trim(), body.name.trim(), role, await hashPassword(body.password, salt), salt, id));
        stmts.push(db.prepare('DELETE FROM sessions WHERE staff_id = ?').bind(id));
    } else {
        stmts.push(db.prepare('UPDATE staff SET username = ?, name = ?, role = ? WHERE id = ?')
            .bind(body.username.trim(), body.name.trim(), role, id));
    }
    try {
        const [res] = await db.batch(stmts);
        if (!res.meta.changes) return fail(404, 'Membre introuvable');
    } catch (e) {
        if (String(e).includes('UNIQUE')) return fail(409, 'Cet identifiant existe deja');
        throw e;
    }
    const row = await db.prepare('SELECT id, username, name, role FROM staff WHERE id = ?').bind(id).first();
    return json({ staff: row });
}

async function deleteStaff(db, id, user) {
    if (id === 1) return fail(403, "Le compte administrateur ne peut pas etre supprime");
    if (id === user.id) return fail(403, 'Vous ne pouvez pas supprimer votre propre compte');
    await db.batch([
        db.prepare('DELETE FROM sessions WHERE staff_id = ?').bind(id),
        db.prepare('DELETE FROM staff WHERE id = ?').bind(id)
    ]);
    return json({ ok: true });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);
        return env.ASSETS.fetch(request);
    }
};

async function handleApi(request, env, url) {
    const db = env.DB;
    if (!db) return fail(500, 'Base de donnees non configuree');
    const route = url.pathname.slice(4).replace(/\/+$/, '');
    const method = request.method;

    try {
        if (route === '/login' && method === 'POST') return await login(request, db);

        const user = await getUser(request, db);
        if (!user) return fail(401, 'Session expiree');

        if (route === '/me' && method === 'GET') return json({ user });
        if (route === '/logout' && method === 'POST') {
            const token = request.headers.get('Authorization').slice(7);
            await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
            return json({ ok: true });
        }
        if (route === '/sync' && method === 'GET') return await pull(url, db);
        if (route === '/sync' && method === 'POST') return await push(request, db);
        if (route === '/orders/next-number' && method === 'POST') return await nextOrderNumber(request, db);

        if (route === '/staff' && method === 'GET') {
            const { results } = await db.prepare('SELECT id, username, name, role FROM staff ORDER BY id').all();
            return json({ staff: results });
        }
        const sm = route.match(/^\/staff(?:\/(\d+))?$/);
        if (sm) {
            if (user.role !== 'gerant') return fail(403, 'Reserve au gerant');
            if (!sm[1] && method === 'POST') return await createStaff(request, db);
            const id = parseInt(sm[1], 10);
            if (sm[1] && method === 'PUT') return await updateStaff(request, db, id);
            if (sm[1] && method === 'DELETE') return await deleteStaff(db, id, user);
        }
        return fail(404, 'Introuvable');
    } catch (e) {
        console.error(e);
        return fail(500, 'Erreur serveur');
    }
}
