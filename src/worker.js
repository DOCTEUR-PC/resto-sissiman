const COLLECTIONS = new Set(['tables', 'categories', 'menuItems', 'orders', 'payments']);
const ROLES = new Set(['gerant', 'caissier', 'serveur', 'cuisinier']);
const PAYMENT_METHODS = new Set(['especes', 'mobile', 'carte']);
const SESSION_TTL = 7 * 24 * 3600 * 1000;
// Workers free plan caps CPU at ~10 ms per request; keep PBKDF2 cheap enough to fit.
const PBKDF2_ITERATIONS = 25000;
const DEFAULT_ADMIN_PASSWORD = 'admin123';
const MAX_CHANGES = 200;
const MAX_RECORD_BYTES = 50000;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    }
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

function auditStmt(db, user, action, collection, recordId, detail) {
    return db.prepare(`INSERT INTO audit (at, staff_id, staff_name, action, collection, record_id, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(Date.now(), user ? user.id : null, user ? user.name : null, action, collection || null,
            recordId == null ? null : String(recordId), detail ? JSON.stringify(detail).slice(0, 2000) : null);
}

async function ensureAdmin(db) {
    const row = await db.prepare('SELECT COUNT(*) AS n FROM staff').first();
    if (row.n > 0) return;
    const salt = randomHex(16);
    await db.prepare(`INSERT INTO staff (username, name, role, pass_hash, pass_salt, created_at, must_change_pw)
        VALUES (?, ?, ?, ?, ?, ?, 1)`)
        .bind('admin', 'Administrateur', 'gerant', await hashPassword(DEFAULT_ADMIN_PASSWORD, salt), salt, Date.now()).run();
}

async function getUser(request, db) {
    const m = (request.headers.get('Authorization') || '').match(/^Bearer ([a-f0-9]{64})$/);
    if (!m) return null;
    return db.prepare(`SELECT s.id, s.username, s.name, s.role, s.must_change_pw FROM sessions x
        JOIN staff s ON s.id = x.staff_id WHERE x.token_hash = ? AND x.expires_at > ?`)
        .bind(await sha256(m[1]), Date.now()).first();
}

// ---------- AUTH ----------

async function login(request, db) {
    const body = await readBody(request);
    const username = body && typeof body.username === 'string' ? body.username.trim() : '';
    const password = body && typeof body.password === 'string' ? body.password : '';
    if (!username || !password) return fail(400, 'Identifiants manquants');

    const now = Date.now();
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    const attemptKey = await sha256(ip + '|' + username.toLowerCase());
    const attempt = await db.prepare('SELECT fails, locked_until FROM login_attempts WHERE key = ?').bind(attemptKey).first();
    if (attempt && attempt.locked_until > now) {
        const min = Math.ceil((attempt.locked_until - now) / 60000);
        return fail(429, `Trop de tentatives. Reessayez dans ${min} min.`);
    }

    await ensureAdmin(db);
    const s = await db.prepare('SELECT * FROM staff WHERE username = ?').bind(username).first();
    const hash = await hashPassword(password, s ? s.pass_salt : 'no-such-user');
    if (!s || !safeEqual(hash, s.pass_hash)) {
        const fails = (attempt && attempt.locked_until <= now && attempt.locked_until > 0 ? 0 : (attempt ? attempt.fails : 0)) + 1;
        const lockedUntil = fails >= LOGIN_MAX_FAILS ? now + LOGIN_LOCK_MS : 0;
        await db.batch([
            db.prepare(`INSERT INTO login_attempts (key, fails, locked_until) VALUES (?, ?, ?)
                ON CONFLICT (key) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until`)
                .bind(attemptKey, lockedUntil ? 0 : fails, lockedUntil),
            auditStmt(db, null, 'login_echec', 'staff', null, { username: username.slice(0, 40), ip, verrouille: !!lockedUntil })
        ]);
        if (lockedUntil) return fail(429, 'Trop de tentatives. Reessayez dans 15 min.');
        return fail(401, 'Identifiant ou mot de passe incorrect');
    }

    const mustChange = s.must_change_pw === 1 || (s.username === 'admin' && password === DEFAULT_ADMIN_PASSWORD);
    const token = randomHex(32);
    await db.batch([
        db.prepare('DELETE FROM login_attempts WHERE key = ?').bind(attemptKey),
        db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
        db.prepare('INSERT INTO sessions (token_hash, staff_id, expires_at) VALUES (?, ?, ?)')
            .bind(await sha256(token), s.id, now + SESSION_TTL),
        db.prepare('UPDATE staff SET must_change_pw = ? WHERE id = ?').bind(mustChange ? 1 : 0, s.id),
        auditStmt(db, s, 'login', 'staff', s.id, { ip })
    ]);
    return json({ token, user: publicStaff(s), mustChangePassword: mustChange });
}

async function changeOwnPassword(request, db, user) {
    const body = await readBody(request);
    const current = body && typeof body.current === 'string' ? body.current : '';
    const next = body && typeof body.next === 'string' ? body.next : '';
    if (next.length < 8) return fail(400, 'Le nouveau mot de passe doit faire au moins 8 caracteres');
    if (next === DEFAULT_ADMIN_PASSWORD || next === current) return fail(400, 'Choisissez un mot de passe different');
    const s = await db.prepare('SELECT pass_hash, pass_salt FROM staff WHERE id = ?').bind(user.id).first();
    if (!s || !safeEqual(await hashPassword(current, s.pass_salt), s.pass_hash)) return fail(400, 'Mot de passe actuel incorrect');
    const salt = randomHex(16);
    const token = request.headers.get('Authorization').slice(7);
    await db.batch([
        db.prepare('UPDATE staff SET pass_hash = ?, pass_salt = ?, must_change_pw = 0 WHERE id = ?')
            .bind(await hashPassword(next, salt), salt, user.id),
        db.prepare('DELETE FROM sessions WHERE staff_id = ? AND token_hash != ?').bind(user.id, await sha256(token)),
        auditStmt(db, user, 'mot_de_passe', 'staff', user.id, null)
    ]);
    return json({ ok: true });
}

// ---------- SYNC ----------

async function pull(url, db) {
    const since = Math.max(0, parseInt(url.searchParams.get('since'), 10) || 0);
    const now = Date.now();
    const stmt = since === 0
        ? db.prepare('SELECT collection, id, data, deleted FROM records WHERE deleted = 0')
        : db.prepare('SELECT collection, id, data, deleted FROM records WHERE updated_at >= ?').bind(since);
    const { results } = await stmt.all();
    return json({ now, records: results });
}

const isInt = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
const can = (user, ...roles) => roles.includes(user.role);

function changedFields(before, after) {
    const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    const out = {};
    for (const k of keys) {
        const a = JSON.stringify(before ? before[k] : undefined);
        const b = JSON.stringify(after ? after[k] : undefined);
        if (a !== b) out[k] = [before ? before[k] : null, after ? after[k] : null];
    }
    return out;
}

const ORDER_TRANSITIONS = {
    'en_cours>prete': ['gerant', 'cuisinier', 'serveur'],
    'prete>servie': ['gerant', 'serveur', 'caissier'],
    'en_cours>annulee': ['gerant', 'caissier'],
    'prete>annulee': ['gerant', 'caissier'],
    'servie>annulee': ['gerant', 'caissier'],
    'en_cours>payee': ['gerant', 'caissier'],
    'prete>payee': ['gerant', 'caissier'],
    'servie>payee': ['gerant', 'caissier']
};
const ORDER_MUTABLE = new Set(['status', 'paidAt', 'paymentMethod']);

// Returns an error message when the change is not allowed, null otherwise.
async function checkChange(c, ctx) {
    const { user } = ctx;
    const before = c.before;
    const after = c.after;
    const diff = changedFields(before, after);
    const onlyChanged = allowed => Object.keys(diff).every(k => allowed.has(k));

    if (Object.keys(diff).length === 0) return null;

    switch (c.collection) {
        case 'categories':
            return can(user, 'gerant') ? null : 'Seul le gerant peut modifier les categories';

        case 'menuItems': {
            if (can(user, 'gerant')) {
                if (after && (!Number.isFinite(after.price) || after.price < 0)) return 'Prix invalide';
                return null;
            }
            if (before && after && can(user, 'cuisinier') && onlyChanged(new Set(['available']))) return null;
            return 'Seul le gerant peut modifier le menu et les prix';
        }

        case 'tables': {
            if (can(user, 'gerant')) return null;
            if (before && after && onlyChanged(new Set(['status']))) return null;
            return 'Seul le gerant peut creer, modifier ou supprimer des tables';
        }

        case 'payments': {
            if (before) return before && !after ? 'Un paiement ne peut pas etre supprime' : 'Un paiement ne peut pas etre modifie';
            if (!can(user, 'gerant', 'caissier')) return 'Seuls le caissier et le gerant peuvent encaisser';
            if (!PAYMENT_METHODS.has(after.method)) return 'Mode de paiement invalide';
            const order = await ctx.lookup('orders', after.orderId);
            if (!order) return 'Commande introuvable pour ce paiement';
            if (order.status === 'annulee') return 'Commande annulee';
            if (after.amount !== order.total) return 'Le montant ne correspond pas au total de la commande';
            if (await ctx.orderHasPayment(after.orderId, c.id)) return 'Cette commande est deja payee';
            return null;
        }

        case 'orders': {
            if (!after) return 'Une commande ne peut pas etre supprimee, annulez-la';
            if (!before) {
                if (!can(user, 'gerant', 'serveur', 'caissier')) return "Vous n'etes pas autorise a prendre des commandes";
                if (after.status !== 'en_cours') return 'Statut initial invalide';
                if (!isInt(after.number, 1, 1e9)) return 'Numero de commande invalide';
                if (!Array.isArray(after.items) || after.items.length === 0 || after.items.length > 100) return 'Articles invalides';
                if (after.tableId && !(await ctx.lookup('tables', after.tableId))) return 'Table introuvable';
                let total = 0;
                for (const it of after.items) {
                    if (!it || !isInt(it.qty, 1, 999)) return 'Quantite invalide';
                    const m = await ctx.lookup('menuItems', it.menuId);
                    if (!m) return 'Plat introuvable';
                    if (m.available === false) return `${m.name} est indisponible`;
                    if (it.price !== m.price) return `Prix incorrect pour ${m.name}`;
                    total += m.price * it.qty;
                }
                if (after.total !== total) return 'Total incorrect';
                return null;
            }
            if (!onlyChanged(ORDER_MUTABLE)) return 'Les articles et le total ne peuvent plus etre modifies';
            if (before.status === after.status) return can(user, 'gerant', 'caissier') ? null : 'Modification non autorisee';
            const roles = ORDER_TRANSITIONS[before.status + '>' + after.status];
            if (!roles) return `Passage de "${before.status}" a "${after.status}" impossible`;
            if (!roles.includes(user.role)) return 'Votre role ne permet pas ce changement de statut';
            if (after.status === 'payee' && !(await ctx.orderHasPayment(c.id))) return 'Aucun paiement enregistre pour cette commande';
            return null;
        }
    }
    return 'Collection inconnue';
}

async function loadRecords(db, keys) {
    const out = new Map();
    for (let i = 0; i < keys.length; i += 40) {
        const part = keys.slice(i, i + 40);
        const where = part.map(() => '(collection = ? AND id = ?)').join(' OR ');
        const { results } = await db.prepare(`SELECT collection, id, data FROM records WHERE deleted = 0 AND (${where})`)
            .bind(...part.flatMap(k => k.split('\u0000'))).all();
        for (const r of results) out.set(r.collection + '\u0000' + r.id, JSON.parse(r.data));
    }
    return out;
}

async function push(request, db, user) {
    const body = await readBody(request);
    const raw = body && Array.isArray(body.changes) ? body.changes : null;
    if (!raw || raw.length === 0 || raw.length > MAX_CHANGES) return fail(400, 'Modifications invalides');

    const changes = [];
    for (const c of raw) {
        if (!c || !COLLECTIONS.has(c.collection) || typeof c.id !== 'string' || !c.id || c.id.length > 100) {
            return fail(400, 'Modification invalide');
        }
        let after = null;
        if (c.data !== null) {
            if (typeof c.data !== 'string' || c.data.length > MAX_RECORD_BYTES) return fail(400, 'Donnees invalides');
            try { after = JSON.parse(c.data); } catch { return fail(400, 'Donnees invalides'); }
            if (!after || typeof after !== 'object' || Array.isArray(after) || String(after.id) !== c.id) return fail(400, 'Donnees invalides');
        }
        changes.push({ collection: c.collection, id: c.id, data: c.data, after, key: c.collection + '\u0000' + c.id });
    }

    const existing = await loadRecords(db, [...new Set(changes.map(c => c.key))]);
    for (const c of changes) c.before = existing.get(c.key) || null;

    // Payments are checked before orders so an order can be marked paid with the payment sent in the same batch.
    const rank = { categories: 0, menuItems: 1, tables: 2, payments: 3, orders: 4 };
    const ordered = [...changes].sort((a, b) => rank[a.collection] - rank[b.collection]);

    const accepted = new Map();
    const extraCache = new Map();
    const ctx = {
        user,
        async lookup(collection, id) {
            if (typeof id !== 'string' || !id) return null;
            const key = collection + '\u0000' + id;
            if (accepted.has(key)) return accepted.get(key).after;
            if (existing.has(key)) return existing.get(key);
            if (!extraCache.has(key)) extraCache.set(key, (await loadRecords(db, [key])).get(key) || null);
            return extraCache.get(key);
        },
        async orderHasPayment(orderId, exceptPaymentId) {
            for (const a of accepted.values()) {
                if (a.collection === 'payments' && a.after && a.after.orderId === orderId && a.id !== exceptPaymentId) return true;
            }
            const row = await db.prepare(`SELECT id FROM records WHERE collection = 'payments' AND deleted = 0
                AND json_extract(data, '$.orderId') = ? AND id != ? LIMIT 1`).bind(orderId, exceptPaymentId || '').first();
            return !!row;
        }
    };

    const rejected = [];
    for (const c of ordered) {
        const error = await checkChange(c, ctx);
        if (error) rejected.push({ c, error });
        else accepted.set(c.key, c);
    }

    const now = Date.now();
    const stmts = [];
    for (const c of accepted.values()) {
        const diff = changedFields(c.before, c.after);
        if (Object.keys(diff).length === 0) continue;
        stmts.push(db.prepare(`INSERT INTO records (collection, id, data, deleted, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, deleted = excluded.deleted, updated_at = excluded.updated_at`)
            .bind(c.collection, c.id, c.data, c.after ? 0 : 1, now));
        const action = !c.before ? 'creation' : !c.after ? 'suppression' : 'modification';
        const detail = action === 'modification' ? diff : action === 'creation' ? summarize(c.collection, c.after) : summarize(c.collection, c.before);
        stmts.push(auditStmt(db, user, action, c.collection, c.id, detail));
    }
    for (const r of rejected) {
        stmts.push(auditStmt(db, user, 'refus', r.c.collection, r.c.id, { raison: r.error }));
    }
    if (stmts.length) await db.batch(stmts);

    return json({
        ok: true,
        now,
        rejected: rejected.map(r => ({
            collection: r.c.collection,
            id: r.c.id,
            error: r.error,
            data: r.c.before ? JSON.stringify(r.c.before) : null
        }))
    });
}

function summarize(collection, rec) {
    if (!rec) return null;
    if (collection === 'orders') return { numero: rec.number, total: rec.total, table: rec.tableId, articles: (rec.items || []).length };
    if (collection === 'payments') return { commande: rec.orderNumber, montant: rec.amount, mode: rec.method };
    if (collection === 'menuItems') return { nom: rec.name, prix: rec.price };
    if (collection === 'tables') return { numero: rec.number };
    if (collection === 'categories') return { nom: rec.name };
    return null;
}

async function nextOrderNumber(request, db, user) {
    if (!can(user, 'gerant', 'serveur', 'caissier')) return fail(403, "Vous n'etes pas autorise a prendre des commandes");
    const body = await readBody(request);
    const min = Math.max(1, parseInt(body && body.min, 10) || 1);
    const row = await db.prepare(`INSERT INTO counters (name, value) VALUES ('order', ?)
        ON CONFLICT (name) DO UPDATE SET value = MAX(value + 1, excluded.value) RETURNING value`).bind(min).first();
    return json({ number: row.value });
}

// ---------- STAFF ----------

function validateStaff(body, creating) {
    if (!body) return 'Donnees invalides';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!name || name.length > 60) return 'Nom invalide';
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) return 'Identifiant invalide (3 a 32 caracteres : lettres, chiffres, . _ -)';
    if (!ROLES.has(body.role)) return 'Role invalide';
    if ((creating || password) && password.length < 8) return 'Mot de passe trop court (8 caracteres minimum)';
    return null;
}

async function createStaff(request, db, user) {
    const body = await readBody(request);
    const error = validateStaff(body, true);
    if (error) return fail(400, error);
    const salt = randomHex(16);
    try {
        const row = await db.prepare(`INSERT INTO staff (username, name, role, pass_hash, pass_salt, created_at, must_change_pw)
            VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id, username, name, role`)
            .bind(body.username.trim(), body.name.trim(), body.role, await hashPassword(body.password, salt), salt, Date.now()).first();
        await auditStmt(db, user, 'creation', 'staff', row.id, { nom: row.name, identifiant: row.username, role: row.role }).run();
        return json({ staff: row }, 201);
    } catch (e) {
        if (String(e).includes('UNIQUE')) return fail(409, 'Cet identifiant existe deja');
        throw e;
    }
}

async function updateStaff(request, db, id, user) {
    const body = await readBody(request);
    const error = validateStaff(body, false);
    if (error) return fail(400, error);
    const before = await db.prepare('SELECT id, username, name, role FROM staff WHERE id = ?').bind(id).first();
    if (!before) return fail(404, 'Membre introuvable');
    const role = id === 1 ? 'gerant' : body.role;
    const stmts = [];
    if (body.password) {
        const salt = randomHex(16);
        stmts.push(db.prepare('UPDATE staff SET username = ?, name = ?, role = ?, pass_hash = ?, pass_salt = ?, must_change_pw = 1 WHERE id = ?')
            .bind(body.username.trim(), body.name.trim(), role, await hashPassword(body.password, salt), salt, id));
        stmts.push(db.prepare('DELETE FROM sessions WHERE staff_id = ?').bind(id));
    } else {
        stmts.push(db.prepare('UPDATE staff SET username = ?, name = ?, role = ? WHERE id = ?')
            .bind(body.username.trim(), body.name.trim(), role, id));
    }
    if (role !== before.role) stmts.push(db.prepare('DELETE FROM sessions WHERE staff_id = ? AND staff_id != ?').bind(id, user.id));
    const detail = changedFields(before, { id, username: body.username.trim(), name: body.name.trim(), role });
    if (body.password) detail.mot_de_passe = ['***', 'reinitialise'];
    stmts.push(auditStmt(db, user, 'modification', 'staff', id, detail));
    try {
        await db.batch(stmts);
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
    const before = await db.prepare('SELECT name, username, role FROM staff WHERE id = ?').bind(id).first();
    if (!before) return fail(404, 'Membre introuvable');
    await db.batch([
        db.prepare('DELETE FROM sessions WHERE staff_id = ?').bind(id),
        db.prepare('DELETE FROM staff WHERE id = ?').bind(id),
        auditStmt(db, user, 'suppression', 'staff', id, { nom: before.name, identifiant: before.username, role: before.role })
    ]);
    return json({ ok: true });
}

async function listAudit(url, db) {
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 100));
    const { results } = await db.prepare(`SELECT id, at, staff_name, action, collection, record_id, detail
        FROM audit ORDER BY id DESC LIMIT ?`).bind(limit).all();
    return json({ entries: results });
}

// ---------- ROUTER ----------

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

    if (method !== 'GET') {
        const origin = request.headers.get('Origin');
        if (origin && origin !== url.origin) return fail(403, 'Origine refusee');
    }

    try {
        if (route === '/login' && method === 'POST') return await login(request, db);

        const user = await getUser(request, db);
        if (!user) return fail(401, 'Session expiree');

        if (route === '/me' && method === 'GET') return json({ user: publicStaff(user), mustChangePassword: user.must_change_pw === 1 });
        if (route === '/logout' && method === 'POST') {
            const token = request.headers.get('Authorization').slice(7);
            await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
            return json({ ok: true });
        }
        if (route === '/password' && method === 'POST') return await changeOwnPassword(request, db, user);
        if (user.must_change_pw === 1) return fail(403, 'Changement de mot de passe requis');

        if (route === '/sync' && method === 'GET') return await pull(url, db);
        if (route === '/sync' && method === 'POST') return await push(request, db, user);
        if (route === '/orders/next-number' && method === 'POST') return await nextOrderNumber(request, db, user);

        if (route === '/staff' && method === 'GET') {
            const { results } = await db.prepare('SELECT id, username, name, role FROM staff ORDER BY id').all();
            return json({ staff: results });
        }
        if (route === '/audit' && method === 'GET') {
            if (user.role !== 'gerant') return fail(403, 'Reserve au gerant');
            return await listAudit(url, db);
        }
        const sm = route.match(/^\/staff(?:\/(\d+))?$/);
        if (sm) {
            if (user.role !== 'gerant') return fail(403, 'Reserve au gerant');
            if (!sm[1] && method === 'POST') return await createStaff(request, db, user);
            const id = parseInt(sm[1], 10);
            if (sm[1] && method === 'PUT') return await updateStaff(request, db, id, user);
            if (sm[1] && method === 'DELETE') return await deleteStaff(db, id, user);
        }
        return fail(404, 'Introuvable');
    } catch (e) {
        console.error(e);
        return fail(500, 'Erreur serveur');
    }
}
