const COLLECTIONS = new Set(['tables', 'categories', 'menuItems', 'orders', 'payments', 'refunds', 'cashSessions']);
const SERVER_ONLY = new Set(['payments', 'refunds', 'cashSessions']);
const ORDER_SERVER_FIELDS = ['paid', 'refunded', 'paidAt', 'paymentMethod', 'readyAt', 'servedAt'];
const ACTIVE_ORDER = ['en_cours', 'prete', 'servie'];
const ID_RE = /^[a-zA-Z0-9_-]{8,60}$/;
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

// "payee" is only reachable through POST /api/payments.
const ORDER_TRANSITIONS = {
    'en_cours>prete': ['gerant', 'cuisinier', 'serveur'],
    'prete>servie': ['gerant', 'serveur', 'caissier'],
    'en_cours>annulee': ['gerant', 'caissier'],
    'prete>annulee': ['gerant', 'caissier'],
    'servie>annulee': ['gerant', 'caissier']
};
const ORDER_MUTABLE = new Set(['status', 'startedAt']);

const PHOTO_RE = /^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/]+=*$/;
const isShortText = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;

function validateMenuItem(m) {
    if (!isShortText(m.name, 60)) return 'Nom du plat invalide';
    if (!isInt(m.price, 0, 10000000)) return 'Prix invalide';
    if (m.photo != null && (typeof m.photo !== 'string' || m.photo.length > 45000 || !PHOTO_RE.test(m.photo))) return 'Photo invalide';
    const o = m.options;
    if (o == null) return null;
    if (typeof o !== 'object' || Array.isArray(o)) return 'Options invalides';
    const list = (a, ok) => a == null || (Array.isArray(a) && a.length <= 12 && a.every(ok));
    if (!list(o.sides, s => isShortText(s, 40))) return 'Accompagnements invalides';
    if (!list(o.prefs, s => isShortText(s, 40))) return 'Preferences invalides';
    if (!list(o.extras, e => e && isShortText(e.name, 40) && isInt(e.price, 0, 1000000))) return 'Supplements invalides';
    return null;
}

// Prices always come from the server's copy of the menu; the client's figures must match them exactly.
async function validateOrderLines(items, lookup) {
    let total = 0;
    for (const it of items) {
        if (!it || typeof it !== 'object' || !isInt(it.qty, 1, 999)) return { error: 'Quantite invalide' };
        const m = await lookup('menuItems', it.menuId);
        if (!m) return { error: 'Plat introuvable' };
        if (m.available === false) return { error: `${m.name} est indisponible` };
        if (it.price !== m.price) return { error: `Prix incorrect pour ${m.name}` };
        const opts = m.options || {};
        if (it.side != null && !(opts.sides || []).includes(it.side)) return { error: `Accompagnement invalide pour ${m.name}` };
        if (it.prefs != null && (!Array.isArray(it.prefs) || !it.prefs.every(p => (opts.prefs || []).includes(p)))) {
            return { error: `Preference invalide pour ${m.name}` };
        }
        let unit = m.price;
        if (it.extras != null) {
            if (!Array.isArray(it.extras) || it.extras.length > 12) return { error: `Supplements invalides pour ${m.name}` };
            for (const e of it.extras) {
                const ref = (opts.extras || []).find(x => e && x.name === e.name);
                if (!ref || ref.price !== e.price) return { error: `Supplement incorrect pour ${m.name}` };
                unit += ref.price;
            }
        }
        if (it.comment != null && (typeof it.comment !== 'string' || it.comment.length > 120)) return { error: 'Commentaire trop long' };
        if (it.unitPrice != null && it.unitPrice !== unit) return { error: `Prix incorrect pour ${m.name}` };
        total += unit * it.qty;
    }
    return { total };
}

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
            if (can(user, 'gerant')) return after ? validateMenuItem(after) : null;
            if (before && after && can(user, 'cuisinier') && onlyChanged(new Set(['available']))) return null;
            return 'Seul le gerant peut modifier le menu et les prix';
        }

        case 'tables': {
            if (can(user, 'gerant')) return null;
            if (before && after && onlyChanged(new Set(['status']))) return null;
            return 'Seul le gerant peut creer, modifier ou supprimer des tables';
        }

        case 'payments':
        case 'refunds':
        case 'cashSessions':
            return 'Les operations de caisse doivent passer par l\'ecran Caisse';

        case 'orders': {
            if (!after) return 'Une commande ne peut pas etre supprimee, annulez-la';
            if (!before) {
                if (!can(user, 'gerant', 'serveur', 'caissier')) return "Vous n'etes pas autorise a prendre des commandes";
                if (after.status !== 'en_cours') return 'Statut initial invalide';
                if (!isInt(after.number, 1, 1e9)) return 'Numero de commande invalide';
                if (!Array.isArray(after.items) || after.items.length === 0 || after.items.length > 100) return 'Articles invalides';
                if (after.tableId && !(await ctx.lookup('tables', after.tableId))) return 'Table introuvable';
                const v = await validateOrderLines(after.items, ctx.lookup);
                if (v.error) return v.error;
                if (after.total !== v.total) return 'Total incorrect';
                return null;
            }
            if ('items' in diff || 'total' in diff) {
                // Only appending lines to an open order is allowed; existing lines stay untouched.
                if (!can(user, 'gerant', 'serveur', 'caissier')) return "Vous n'etes pas autorise a modifier une commande";
                if (!ACTIVE_ORDER.includes(before.status)) return 'Cette commande est cloturee, creez-en une nouvelle';
                if (!onlyChanged(new Set(['items', 'total', 'status', 'note']))) return 'Modification non autorisee';
                if ('note' in diff && (typeof after.note !== 'string' || after.note.length > 600 || !after.note.startsWith(before.note || ''))) {
                    return 'La note existante ne peut pas etre modifiee';
                }
                const old = before.items || [];
                if (!Array.isArray(after.items) || after.items.length <= old.length || after.items.length > 200) return 'Articles invalides';
                if (old.some((it, i) => JSON.stringify(it) !== JSON.stringify(after.items[i]))) {
                    return 'Les articles deja envoyes en cuisine ne peuvent pas etre modifies';
                }
                const added = after.items.slice(old.length);
                const v = await validateOrderLines(added, ctx.lookup);
                if (v.error) return v.error;
                if (after.total !== before.total + v.total) return 'Total incorrect';
                if (after.status !== 'en_cours') return 'Une commande completee repasse en preparation';
                return null;
            }
            if (!onlyChanged(ORDER_MUTABLE)) return 'Les articles et le total ne peuvent plus etre modifies';
            if ('startedAt' in diff) {
                if (!can(user, 'gerant', 'cuisinier')) return 'Seule la cuisine peut demarrer une commande';
                if (before.status !== 'en_cours') return 'Cette commande a deja quitte la cuisine';
            }
            if (!('status' in diff)) return null;
            const roles = ORDER_TRANSITIONS[before.status + '>' + after.status];
            if (after.status === 'payee') return "Une commande passe a « payee » uniquement par l'encaissement";
            if (!roles) return `Passage de "${before.status}" a "${after.status}" impossible`;
            if (!roles.includes(user.role)) return 'Votre role ne permet pas ce changement de statut';
            if (after.status === 'annulee' && (before.paid || 0) - (before.refunded || 0) > 0) {
                return 'Cette commande a des paiements : remboursez-les avant de l\'annuler';
            }
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
        // Ids end up inside onclick attributes on the client, so only plain characters are accepted.
        if (!c || !COLLECTIONS.has(c.collection) || typeof c.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(c.id)) {
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
    for (const c of changes) {
        c.before = existing.get(c.key) || null;
        // Payment fields on orders belong to the server; a client's stale copy must not overwrite them.
        if (c.collection === 'orders' && c.after) {
            for (const f of ORDER_SERVER_FIELDS) {
                if (c.before && f in c.before) c.after[f] = c.before[f]; else delete c.after[f];
            }
            c.data = JSON.stringify(c.after);
        }
    }

    // Menu and tables first so a new order can reference items created in the same batch.
    const rank = { categories: 0, menuItems: 1, tables: 2, orders: 3, payments: 4, refunds: 4, cashSessions: 4 };
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
        }
    };

    const rejected = [];
    for (const c of ordered) {
        const error = await checkChange(c, ctx);
        if (error) rejected.push({ c, error });
        else accepted.set(c.key, c);
    }

    const now = Date.now();
    const iso = new Date(now).toISOString();
    for (const c of accepted.values()) {
        // Kitchen timings use the server clock so tablets with a wrong time cannot skew them.
        if (c.collection !== 'orders' || !c.after) continue;
        if (!c.before) delete c.after.startedAt;
        else {
            if (c.after.startedAt && !c.before.startedAt) c.after.startedAt = iso;
            if (c.after.status !== c.before.status) {
                if (c.after.status === 'prete') c.after.readyAt = iso;
                if (c.after.status === 'servie') c.after.servedAt = iso;
                if (c.after.status === 'en_cours') delete c.after.readyAt;
            }
        }
        c.data = JSON.stringify(c.after);
    }
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

// ---------- CAISSE ----------
// Each write below is guarded by the order's (or session's) exact stored JSON, so two cashiers acting on the
// same record at once cannot both succeed: the batch's last UPDATE reports 0 changes for the loser.

const rec = (collection, obj) => ({ collection, id: obj.id, data: JSON.stringify(obj), deleted: 0 });

async function getRecord(db, collection, id) {
    if (typeof id !== 'string' || !id) return null;
    const row = await db.prepare('SELECT data FROM records WHERE collection = ? AND id = ? AND deleted = 0').bind(collection, id).first();
    return row ? { raw: row.data, obj: JSON.parse(row.data) } : null;
}

async function openSessionOf(db, staffId) {
    const row = await db.prepare(`SELECT data FROM records WHERE collection = 'cashSessions' AND deleted = 0
        AND json_extract(data, '$.staffId') = ? AND json_extract(data, '$.status') = 'ouverte' LIMIT 1`).bind(staffId).first();
    return row ? { raw: row.data, obj: JSON.parse(row.data) } : null;
}

function guardedInsert(db, collection, obj, now, guardCollection, guardId, guardRaw) {
    return db.prepare(`INSERT INTO records (collection, id, data, deleted, updated_at)
        SELECT ?, ?, ?, 0, ? WHERE EXISTS (SELECT 1 FROM records WHERE collection = ? AND id = ? AND data = ?)`)
        .bind(collection, obj.id, JSON.stringify(obj), now, guardCollection, guardId, guardRaw);
}

function guardedUpdate(db, collection, obj, now, guardRaw) {
    return db.prepare('UPDATE records SET data = ?, updated_at = ? WHERE collection = ? AND id = ? AND data = ?')
        .bind(JSON.stringify(obj), now, collection, obj.id, guardRaw);
}

const isUniqueError = e => String(e).includes('UNIQUE') || String(e).includes('PRIMARY KEY');
const CONFLICT = 'Cette operation a ete modifiee en meme temps sur un autre poste. Reessayez.';

async function openCash(request, db, user) {
    if (!can(user, 'gerant', 'caissier')) return fail(403, 'Reserve au caissier et au gerant');
    const body = await readBody(request);
    if (!body || !ID_RE.test(body.id || '')) return fail(400, 'Identifiant invalide');
    if (!isInt(body.openingFloat, 0, 100000000)) return fail(400, 'Fonds de caisse invalide');
    const dup = await getRecord(db, 'cashSessions', body.id);
    if (dup) return json({ duplicate: true, records: [rec('cashSessions', dup.obj)] });
    if (await openSessionOf(db, user.id)) return fail(409, 'Vous avez deja une caisse ouverte');

    const session = {
        id: body.id, staffId: user.id, staffName: user.name, status: 'ouverte',
        openedAt: new Date().toISOString(), openingFloat: body.openingFloat
    };
    const res = await db.prepare(`INSERT INTO records (collection, id, data, deleted, updated_at)
        SELECT 'cashSessions', ?, ?, 0, ? WHERE NOT EXISTS (SELECT 1 FROM records WHERE collection = 'cashSessions'
        AND deleted = 0 AND json_extract(data, '$.staffId') = ? AND json_extract(data, '$.status') = 'ouverte')`)
        .bind(session.id, JSON.stringify(session), Date.now(), user.id).run();
    if (!res.meta.changes) return fail(409, 'Vous avez deja une caisse ouverte');
    await auditStmt(db, user, 'ouverture_caisse', 'cashSessions', session.id, { fonds: session.openingFloat }).run();
    return json({ ok: true, records: [rec('cashSessions', session)] });
}

async function sessionTotals(db, sessionId) {
    const { results } = await db.prepare(`SELECT collection, data FROM records WHERE collection IN ('payments', 'refunds')
        AND deleted = 0 AND json_extract(data, '$.sessionId') = ?`).bind(sessionId).all();
    const t = { payments: { especes: 0, mobile: 0, carte: 0 }, refunds: { especes: 0, mobile: 0, carte: 0 }, paymentCount: 0, refundCount: 0 };
    for (const r of results) {
        const d = JSON.parse(r.data);
        const bucket = r.collection === 'payments' ? t.payments : t.refunds;
        bucket[d.method] = (bucket[d.method] || 0) + d.amount;
        if (r.collection === 'payments') t.paymentCount++; else t.refundCount++;
    }
    return t;
}

async function closeCash(request, db, user) {
    if (!can(user, 'gerant', 'caissier')) return fail(403, 'Reserve au caissier et au gerant');
    const body = await readBody(request);
    const s = body && await getRecord(db, 'cashSessions', body.sessionId);
    if (!s) return fail(404, 'Session de caisse introuvable');
    if (s.obj.status !== 'ouverte') return fail(409, 'Cette caisse est deja cloturee');
    if (s.obj.staffId !== user.id && user.role !== 'gerant') return fail(403, "Seul le gerant peut cloturer la caisse d'un autre");
    if (!isInt(body.countedCash, 0, 1000000000)) return fail(400, 'Montant compte invalide');
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';

    const totals = await sessionTotals(db, s.obj.id);
    const expectedCash = s.obj.openingFloat + totals.payments.especes - totals.refunds.especes;
    const closed = {
        ...s.obj, status: 'fermee', closedAt: new Date().toISOString(), closedById: user.id, closedByName: user.name,
        totals, expectedCash, countedCash: body.countedCash, diff: body.countedCash - expectedCash, note
    };
    const res = await guardedUpdate(db, 'cashSessions', closed, Date.now(), s.raw).run();
    if (!res.meta.changes) return fail(409, CONFLICT);
    await auditStmt(db, user, 'cloture_caisse', 'cashSessions', closed.id,
        { attendu: expectedCash, compte: closed.countedCash, ecart: closed.diff, caissier: s.obj.staffName }).run();
    return json({ ok: true, records: [rec('cashSessions', closed)] });
}

async function createPayment(request, db, user) {
    if (!can(user, 'gerant', 'caissier')) return fail(403, 'Seuls le caissier et le gerant peuvent encaisser');
    const body = await readBody(request);
    if (!body || !ID_RE.test(body.id || '')) return fail(400, 'Identifiant invalide');
    const lines = Array.isArray(body.lines) ? body.lines : [];
    if (lines.length < 1 || lines.length > 4) return fail(400, 'Indiquez entre 1 et 4 moyens de paiement');

    const dup = await getRecord(db, 'payments', body.id + '-0');
    if (dup) {
        const order = await getRecord(db, 'orders', dup.obj.orderId);
        return json({ duplicate: true, records: order ? [rec('orders', order.obj)] : [] });
    }

    const session = await openSessionOf(db, user.id);
    if (!session) return fail(409, "Ouvrez votre caisse avant d'encaisser");
    const order = await getRecord(db, 'orders', body.orderId);
    if (!order) return fail(404, 'Commande introuvable');
    const o = order.obj;
    if (o.status === 'annulee') return fail(400, 'Cette commande est annulee');
    const paid = o.paid || 0;
    const remaining = o.total - paid;
    if (remaining <= 0) return fail(409, 'Cette commande est deja payee');

    let sum = 0;
    for (const l of lines) {
        if (!l || !PAYMENT_METHODS.has(l.method)) return fail(400, 'Mode de paiement invalide');
        if (!isInt(l.amount, 1, 100000000)) return fail(400, 'Montant invalide');
        if (l.received != null && (l.method !== 'especes' || !isInt(l.received, l.amount, 100000000))) {
            return fail(400, 'Montant recu invalide');
        }
        sum += l.amount;
    }
    if (sum > remaining) return fail(400, `Le montant depasse le reste a payer (${remaining} FCFA)`);

    const now = Date.now();
    const iso = new Date(now).toISOString();
    const payments = lines.map((l, i) => ({
        id: `${body.id}-${i}`, groupId: body.id, orderId: o.id, orderNumber: o.number, tableId: o.tableId,
        amount: l.amount, method: l.method,
        received: l.received != null ? l.received : undefined,
        change: l.received != null ? l.received - l.amount : undefined,
        sessionId: session.obj.id, staffId: user.id, staffName: user.name, paidAt: iso
    }));
    const methods = [...new Set([...(o.paymentMethod ? o.paymentMethod.split('+') : []), ...lines.map(l => l.method)])];
    const full = paid + sum >= o.total;
    const newOrder = { ...o, paid: paid + sum, paymentMethod: methods.join('+'), status: full ? 'payee' : o.status };
    if (full) newOrder.paidAt = iso;

    const stmts = payments.map(p => guardedInsert(db, 'payments', p, now, 'orders', o.id, order.raw));
    const out = [rec('orders', newOrder), ...payments.map(p => rec('payments', p))];
    if (full && o.tableId) {
        const other = await db.prepare(`SELECT 1 FROM records WHERE collection = 'orders' AND deleted = 0 AND id != ?
            AND json_extract(data, '$.tableId') = ? AND json_extract(data, '$.status') IN ('en_cours', 'prete', 'servie') LIMIT 1`)
            .bind(o.id, o.tableId).first();
        const table = other ? null : await getRecord(db, 'tables', o.tableId);
        if (table && table.obj.status !== 'libre') {
            const freed = { ...table.obj, status: 'libre' };
            stmts.push(db.prepare(`UPDATE records SET data = ?, updated_at = ? WHERE collection = 'tables' AND id = ?
                AND EXISTS (SELECT 1 FROM records WHERE collection = 'orders' AND id = ? AND data = ?)`)
                .bind(JSON.stringify(freed), now, freed.id, o.id, order.raw));
            out.push(rec('tables', freed));
        }
    }
    stmts.push(guardedUpdate(db, 'orders', newOrder, now, order.raw));

    let results;
    try {
        results = await db.batch(stmts);
    } catch (e) {
        if (isUniqueError(e)) return fail(409, 'Paiement deja enregistre');
        throw e;
    }
    if (!results[results.length - 1].meta.changes) return fail(409, CONFLICT);
    await auditStmt(db, user, 'encaissement', 'payments', body.id, {
        commande: o.number, montant: sum, modes: lines.map(l => `${l.method} ${l.amount}`).join(' + '),
        reste: Math.max(0, o.total - paid - sum)
    }).run();
    return json({ ok: true, records: out });
}

async function createRefund(request, db, user) {
    if (!can(user, 'gerant')) return fail(403, 'Seul le gerant peut effectuer un remboursement');
    const body = await readBody(request);
    if (!body || !ID_RE.test(body.id || '')) return fail(400, 'Identifiant invalide');
    const dup = await getRecord(db, 'refunds', body.id);
    if (dup) return json({ duplicate: true, records: [rec('refunds', dup.obj)] });

    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 3 || reason.length > 200) return fail(400, 'Indiquez le motif du remboursement (3 a 200 caracteres)');
    const payment = await getRecord(db, 'payments', body.paymentId);
    if (!payment) return fail(404, 'Paiement introuvable');
    const p = payment.obj;
    const already = await db.prepare(`SELECT COALESCE(SUM(json_extract(data, '$.amount')), 0) AS s FROM records
        WHERE collection = 'refunds' AND deleted = 0 AND json_extract(data, '$.paymentId') = ?`).bind(p.id).first();
    const max = p.amount - already.s;
    if (max <= 0) return fail(409, 'Ce paiement est deja entierement rembourse');
    if (!isInt(body.amount, 1, max)) return fail(400, `Montant invalide (maximum ${max} FCFA)`);
    const session = await openSessionOf(db, user.id);
    if (p.method === 'especes' && !session) return fail(409, 'Ouvrez votre caisse pour rembourser en especes');
    const order = await getRecord(db, 'orders', p.orderId);
    if (!order) return fail(404, 'Commande introuvable');

    const now = Date.now();
    const refund = {
        id: body.id, paymentId: p.id, orderId: p.orderId, orderNumber: p.orderNumber, amount: body.amount,
        method: p.method, reason, sessionId: session ? session.obj.id : null,
        staffId: user.id, staffName: user.name, at: new Date(now).toISOString()
    };
    const newOrder = { ...order.obj, refunded: (order.obj.refunded || 0) + body.amount };
    let results;
    try {
        results = await db.batch([
            guardedInsert(db, 'refunds', refund, now, 'orders', newOrder.id, order.raw),
            guardedUpdate(db, 'orders', newOrder, now, order.raw)
        ]);
    } catch (e) {
        if (isUniqueError(e)) return fail(409, 'Remboursement deja enregistre');
        throw e;
    }
    if (!results[1].meta.changes) return fail(409, CONFLICT);
    await auditStmt(db, user, 'remboursement', 'refunds', refund.id,
        { commande: p.orderNumber, montant: refund.amount, mode: p.method, motif: reason }).run();
    return json({ ok: true, records: [rec('refunds', refund), rec('orders', newOrder)] });
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
        if (route === '/cash/open' && method === 'POST') return await openCash(request, db, user);
        if (route === '/cash/close' && method === 'POST') return await closeCash(request, db, user);
        if (route === '/payments' && method === 'POST') return await createPayment(request, db, user);
        if (route === '/refunds' && method === 'POST') return await createRefund(request, db, user);

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
