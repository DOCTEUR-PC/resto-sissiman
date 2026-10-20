const COLLECTIONS = new Set(['tables', 'categories', 'menuItems', 'orders', 'payments', 'refunds', 'cashSessions',
    'ingredients', 'purchases', 'inventories']);
const INGREDIENT_SERVER_FIELDS = ['stock', 'avgCost'];
const ORDER_SERVER_FIELDS = ['paid', 'refunded', 'paidAt', 'paymentMethod', 'readyAt', 'servedAt'];
const ACTIVE_ORDER = ['en_cours', 'prete', 'servie'];
const ID_RE = /^[a-zA-Z0-9_-]{8,60}$/;
const ROLES = new Set(['proprietaire', 'gerant', 'caissier', 'serveur', 'cuisinier', 'stock', 'comptable']);

// Every server-side check refers to one of these keys; roles only bundle them.
const PERMISSIONS = [
    ['page.dashboard', 'Voir le tableau de bord', 'Pages'],
    ['page.tables', 'Voir le plan de salle', 'Pages'],
    ['page.orders', 'Voir les commandes', 'Pages'],
    ['page.menu', 'Voir le menu', 'Pages'],
    ['page.caisse', 'Voir la caisse', 'Pages'],
    ['page.cuisine', "Voir l'ecran cuisine", 'Pages'],
    ['page.rapports', 'Voir les rapports', 'Pages'],
    ['orders.create', 'Prendre et completer des commandes', 'Service'],
    ['orders.transfer', 'Transferer une commande de table', 'Service'],
    ['orders.serve', 'Marquer une commande servie', 'Service'],
    ['orders.cancel', 'Annuler une commande', 'Service'],
    ['tables.status', 'Changer l\'etat d\'une table (libre, occupee, reservee)', 'Service'],
    ['tables.manage', 'Creer, modifier et placer les tables', 'Service'],
    ['kitchen.start', 'Demarrer une commande en cuisine', 'Cuisine'],
    ['orders.ready', 'Marquer une commande prete', 'Cuisine'],
    ['menu.availability', 'Rendre un plat disponible ou indisponible', 'Cuisine'],
    ['menu.manage', 'Modifier le menu et les prix', 'Menu'],
    ['payments.create', 'Encaisser', 'Caisse'],
    ['cash.session', 'Ouvrir et cloturer sa caisse', 'Caisse'],
    ['cash.history', 'Superviser les caisses et leurs ecarts', 'Caisse'],
    ['refunds.create', 'Effectuer des remboursements', 'Caisse'],
    ['stock.view', 'Voir les stocks', 'Stocks'],
    ['stock.manage', 'Gerer les ingredients et les recettes', 'Stocks'],
    ['stock.purchase', 'Enregistrer les achats fournisseurs', 'Stocks'],
    ['stock.loss', 'Declarer des pertes', 'Stocks'],
    ['stock.inventory', 'Valider les inventaires', 'Stocks'],
    ['reports.view', 'Consulter les chiffres et rapports financiers', 'Gestion'],
    ['audit.view', "Consulter le journal d'activite", 'Gestion'],
    ['staff.manage', 'Gerer le personnel', 'Gestion'],
    ['roles.manage', 'Modifier les roles et permissions', 'Gestion']
];
const PERM_KEYS = new Set(PERMISSIONS.map(p => p[0]));
const OWNER_ONLY = new Set(['roles.manage']);
const DEFAULT_ROLE_PERMS = {
    gerant: [...PERM_KEYS].filter(p => !OWNER_ONLY.has(p)),
    caissier: ['page.dashboard', 'page.tables', 'page.orders', 'page.menu', 'page.caisse', 'page.cuisine',
        'orders.create', 'orders.transfer', 'orders.serve', 'orders.cancel', 'tables.status', 'payments.create', 'cash.session'],
    serveur: ['page.tables', 'page.orders', 'page.menu', 'page.cuisine',
        'orders.create', 'orders.transfer', 'orders.serve', 'orders.ready', 'tables.status'],
    cuisinier: ['page.orders', 'page.menu', 'page.cuisine', 'kitchen.start', 'orders.ready', 'menu.availability', 'stock.view', 'stock.loss'],
    stock: ['page.menu', 'menu.availability', 'stock.view', 'stock.manage', 'stock.purchase', 'stock.loss', 'stock.inventory'],
    comptable: ['page.dashboard', 'page.caisse', 'page.rapports', 'stock.view', 'reports.view', 'cash.history', 'audit.view']
};
// Collections a device only receives when the user holds one of these permissions.
const COLLECTION_PERMS = {
    payments: ['payments.create', 'cash.history', 'reports.view', 'page.dashboard'],
    refunds: ['payments.create', 'cash.history', 'reports.view', 'page.dashboard'],
    cashSessions: ['cash.session', 'cash.history', 'reports.view'],
    ingredients: ['stock.view', 'menu.manage', 'reports.view'],
    purchases: ['stock.view', 'reports.view'],
    inventories: ['stock.view', 'reports.view']
};

let matrixCache = null;
async function roleMatrix(db, fresh) {
    if (!fresh && matrixCache && Date.now() - matrixCache.at < 30000) return matrixCache.matrix;
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'role_perms'").first();
    let custom = {};
    try { custom = row ? JSON.parse(row.value) : {}; } catch { custom = {}; }
    const matrix = {};
    for (const r of ROLES) {
        matrix[r] = r === 'proprietaire' ? [...PERM_KEYS]
            : Array.isArray(custom[r]) ? custom[r].filter(p => PERM_KEYS.has(p) && !OWNER_ONLY.has(p))
            : DEFAULT_ROLE_PERMS[r];
    }
    matrixCache = { at: Date.now(), matrix };
    return matrix;
}

const has = (user, perm) => !!(user && user.perms && user.perms.has(perm));
const visible = (user, collection) => !COLLECTION_PERMS[collection] || COLLECTION_PERMS[collection].some(p => has(user, p));
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
        .bind('admin', 'Administrateur', 'proprietaire', await hashPassword(DEFAULT_ADMIN_PASSWORD, salt), salt, Date.now()).run();
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
    return json({ token, user: { ...publicStaff(s), perms: (await roleMatrix(db))[s.role] || [] }, mustChangePassword: mustChange });
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

async function pull(url, db, user) {
    const since = Math.max(0, parseInt(url.searchParams.get('since'), 10) || 0);
    const now = Date.now();
    const stmt = since === 0
        ? db.prepare('SELECT collection, id, data, deleted FROM records WHERE deleted = 0')
        : db.prepare('SELECT collection, id, data, deleted FROM records WHERE updated_at >= ?').bind(since);
    const { results } = await stmt.all();
    // perms travel with every pull so a change made by the owner reaches open devices within seconds.
    return json({ now, perms: [...user.perms], records: results.filter(r => visible(user, r.collection)) });
}

const isInt = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

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
    'en_cours>prete': 'orders.ready',
    'prete>servie': 'orders.serve',
    'en_cours>annulee': 'orders.cancel',
    'prete>annulee': 'orders.cancel',
    'servie>annulee': 'orders.cancel'
};
const ORDER_MUTABLE = new Set(['status', 'startedAt', 'tableId']);
const TABLE_STATUSES = new Set(['libre', 'occupee', 'reservee', 'indisponible']);

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

const isQty = (n, max = 100000) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= max;
const round4 = n => Math.round(n * 10000) / 10000;

function validateRecipe(recipe) {
    if (recipe == null) return null;
    if (!Array.isArray(recipe) || recipe.length > 30) return 'Recette invalide';
    for (const r of recipe) {
        if (!r || typeof r.ingredientId !== 'string' || !isQty(r.qty)) return 'Ligne de recette invalide';
    }
    return null;
}

function validateIngredient(i) {
    if (!isShortText(i.name, 60)) return "Nom d'ingredient invalide";
    if (!isShortText(i.unit, 15)) return 'Unite invalide';
    if (!(typeof i.threshold === 'number' && i.threshold >= 0 && i.threshold <= 1000000)) return 'Seuil invalide';
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
            return has(user, 'menu.manage') ? null : 'Vous ne pouvez pas modifier les categories';

        case 'ingredients': {
            if (!has(user, 'stock.manage')) return 'Vous ne pouvez pas gerer les ingredients';
            if (!after) {
                const used = await ctx.db.prepare(`SELECT json_extract(data, '$.name') AS name FROM records WHERE collection = 'menuItems'
                    AND deleted = 0 AND data LIKE ? LIMIT 1`).bind(`%"ingredientId":"${c.id}"%`).first();
                return used ? `Ingredient utilise dans la recette « ${used.name} »` : null;
            }
            return validateIngredient(after);
        }

        case 'menuItems': {
            const recipeOnly = before && after && onlyChanged(new Set(['recipe']));
            if (has(user, 'menu.manage') || (recipeOnly && has(user, 'stock.manage'))) {
                if (!after) return null;
                const err = validateMenuItem(after) || validateRecipe(after.recipe);
                if (err) return err;
                for (const r of after.recipe || []) {
                    if (!(await ctx.lookup('ingredients', r.ingredientId))) return 'Ingredient de recette introuvable';
                }
                return null;
            }
            if (before && after && has(user, 'menu.availability') && onlyChanged(new Set(['available']))) return null;
            return 'Vous ne pouvez pas modifier le menu et les prix';
        }

        case 'tables': {
            if (after && !TABLE_STATUSES.has(after.status)) return 'Etat de table invalide';
            const becomesOff = after && after.status === 'indisponible' && (!before || before.status !== 'indisponible');
            if (becomesOff) {
                if (!has(user, 'tables.manage')) return 'Vous ne pouvez pas rendre une table indisponible';
                if (await ctx.activeOrdersOn(c.id) > 0) return 'Cette table a une commande en cours';
            }
            if (!after && before && await ctx.activeOrdersOn(c.id) > 0) return 'Cette table a une commande en cours';
            if (has(user, 'tables.manage')) {
                if (!after) return null;
                if (!isInt(after.number, 1, 9999) || !isInt(after.seats, 1, 60)) return 'Numero ou nombre de places invalide';
                if (typeof after.location !== 'string' || after.location.length > 30) return 'Zone invalide';
                for (const k of ['x', 'y']) {
                    if (after[k] != null && !(typeof after[k] === 'number' && after[k] >= 0 && after[k] <= 100)) return 'Position invalide';
                }
                return null;
            }
            if (before && after && onlyChanged(new Set(['status'])) && has(user, 'tables.status')) {
                if (before.status === 'indisponible') return 'Vous ne pouvez pas remettre cette table en service';
                return null;
            }
            return 'Vous ne pouvez pas creer, modifier ou supprimer des tables';
        }

        case 'payments':
        case 'refunds':
        case 'cashSessions':
            return 'Les operations de caisse doivent passer par l\'ecran Caisse';
        case 'purchases':
        case 'inventories':
            return 'Les achats et inventaires doivent passer par l\'ecran Stocks';

        case 'orders': {
            if (!after) return 'Une commande ne peut pas etre supprimee, annulez-la';
            if (!before) {
                if (!has(user, 'orders.create')) return "Vous n'etes pas autorise a prendre des commandes";
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
                if (!has(user, 'orders.create')) return "Vous n'etes pas autorise a modifier une commande";
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
                if (!has(user, 'kitchen.start')) return 'Seule la cuisine peut demarrer une commande';
                if (before.status !== 'en_cours') return 'Cette commande a deja quitte la cuisine';
            }
            if ('tableId' in diff) {
                if (!has(user, 'orders.transfer')) return "Vous n'etes pas autorise a transferer une commande";
                if (!ACTIVE_ORDER.includes(before.status) || 'status' in diff) return 'Seule une commande en cours peut etre transferee';
                const dest = await ctx.lookup('tables', after.tableId);
                if (!dest) return 'Table de destination introuvable';
                if (dest.status === 'indisponible') return `La table ${dest.number} est indisponible`;
                if (await ctx.activeOrdersOn(after.tableId, c.id) > 0) return `La table ${dest.number} a deja une commande en cours`;
            }
            if (!('status' in diff)) return null;
            const needed = ORDER_TRANSITIONS[before.status + '>' + after.status];
            if (after.status === 'payee') return "Une commande passe a « payee » uniquement par l'encaissement";
            if (!needed) return `Passage de "${before.status}" a "${after.status}" impossible`;
            if (!has(user, needed)) return 'Votre role ne permet pas ce changement de statut';
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
        const serverFields = c.collection === 'orders' ? ORDER_SERVER_FIELDS : c.collection === 'ingredients' ? INGREDIENT_SERVER_FIELDS : null;
        if (serverFields && c.after) {
            for (const f of serverFields) {
                if (c.before && f in c.before) c.after[f] = c.before[f]; else delete c.after[f];
            }
            if (c.collection === 'ingredients' && !c.before) { c.after.stock = 0; c.after.avgCost = 0; }
            c.data = JSON.stringify(c.after);
        }
    }

    // Menu and tables first so a new order can reference items created in the same batch.
    const rank = { ingredients: -1, categories: 0, menuItems: 1, tables: 2, orders: 3, payments: 4, refunds: 4, cashSessions: 4, purchases: 4, inventories: 4 };
    const ordered = [...changes].sort((a, b) => rank[a.collection] - rank[b.collection]);

    const accepted = new Map();
    const extraCache = new Map();
    const ctx = {
        user,
        db,
        async lookup(collection, id) {
            if (typeof id !== 'string' || !id) return null;
            const key = collection + '\u0000' + id;
            if (accepted.has(key)) return accepted.get(key).after;
            if (existing.has(key)) return existing.get(key);
            if (!extraCache.has(key)) extraCache.set(key, (await loadRecords(db, [key])).get(key) || null);
            return extraCache.get(key);
        },
        // Active orders seated at a table, taking into account orders already accepted earlier in this batch.
        async activeOrdersOn(tableId, exceptOrderId) {
            const { results } = await db.prepare(`SELECT id FROM records WHERE collection = 'orders' AND deleted = 0
                AND json_extract(data, '$.tableId') = ? AND json_extract(data, '$.status') IN ('en_cours', 'prete', 'servie')`)
                .bind(tableId).all();
            const ids = new Set(results.map(r => r.id));
            for (const a of accepted.values()) {
                if (a.collection !== 'orders' || !a.after) continue;
                if (a.after.tableId === tableId && ACTIVE_ORDER.includes(a.after.status)) ids.add(a.id); else ids.delete(a.id);
            }
            if (exceptOrderId) ids.delete(exceptOrderId);
            return ids.size;
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
        if (c.collection === 'orders') stmts.push(...await orderStockStmts(db, c, ctx, user, now));
    }
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

// ---------- STOCKS ----------

function stockMoveStmts(db, { ingredientId, qty, kind, ref, unitCost, user, note, clientId, now }) {
    return [
        db.prepare(`INSERT INTO stock_moves (client_id, at, ingredient_id, qty, kind, ref, unit_cost, staff_id, staff_name, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(clientId || null, now, ingredientId, round4(qty), kind, ref || null, unitCost == null ? null : unitCost,
                user ? user.id : null, user ? user.name : null, note || null),
        // Applied as a delta in SQL so concurrent sales and purchases never overwrite each other.
        db.prepare(`UPDATE records SET updated_at = ?, data = json_set(data, '$.stock', ROUND(COALESCE(json_extract(data, '$.stock'), 0) + ?, 4))
            WHERE collection = 'ingredients' AND id = ? AND deleted = 0`).bind(now, round4(qty), ingredientId)
    ];
}

// Theoretical consumption: recipes are applied when lines reach the kitchen and given back if the order is cancelled.
async function orderStockStmts(db, c, ctx, user, now) {
    if (!c.after) return [];
    const consume = async items => {
        const m = new Map();
        for (const it of items || []) {
            const mi = await ctx.lookup('menuItems', it.menuId);
            for (const r of (mi && mi.recipe) || []) m.set(r.ingredientId, (m.get(r.ingredientId) || 0) - r.qty * it.qty);
        }
        return m;
    };
    let deltas = new Map(), kind = 'vente';
    if (!c.before) {
        if (c.after.status !== 'annulee') deltas = await consume(c.after.items);
    } else if (c.after.status === 'annulee' && c.before.status !== 'annulee') {
        const { results } = await db.prepare(`SELECT ingredient_id, SUM(qty) AS q FROM stock_moves
            WHERE ref = ? AND kind IN ('vente', 'annulation') GROUP BY ingredient_id`).bind(c.id).all();
        deltas = new Map(results.map(r => [r.ingredient_id, -r.q]));
        kind = 'annulation';
    } else if ((c.after.items || []).length > (c.before.items || []).length) {
        deltas = await consume(c.after.items.slice(c.before.items.length));
    }
    const out = [];
    for (const [ingredientId, qty] of deltas) {
        if (Math.abs(qty) < 1e-9) continue;
        // Cost frozen at the time of the sale so later purchases do not rewrite past margins.
        const ing = await ctx.lookup('ingredients', ingredientId);
        out.push(...stockMoveStmts(db, { ingredientId, qty, kind, ref: c.id, unitCost: ing ? ing.avgCost || 0 : 0, user, now }));
    }
    return out;
}

async function createPurchase(request, db, user) {
    if (!has(user, 'stock.purchase')) return fail(403, "Vous ne pouvez pas enregistrer d'achat");
    const body = await readBody(request);
    if (!body || !ID_RE.test(body.id || '')) return fail(400, 'Identifiant invalide');
    const dup = await getRecord(db, 'purchases', body.id);
    if (dup) return json({ duplicate: true, records: [rec('purchases', dup.obj)] });
    const supplier = typeof body.supplier === 'string' ? body.supplier.trim().slice(0, 80) : '';
    if (!supplier) return fail(400, 'Indiquez le fournisseur');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || '')) return fail(400, 'Date invalide');
    const lines = Array.isArray(body.lines) ? body.lines : [];
    if (!lines.length || lines.length > 50) return fail(400, 'Ajoutez entre 1 et 50 lignes');
    const now = Date.now();
    const clean = [];
    const stmts = [];
    for (const l of lines) {
        const ing = l && await getRecord(db, 'ingredients', l.ingredientId);
        if (!ing) return fail(400, 'Ingredient introuvable');
        if (!isQty(l.qty)) return fail(400, `Quantite invalide pour ${ing.obj.name}`);
        if (!isInt(l.unitPrice, 0, 100000000)) return fail(400, `Prix invalide pour ${ing.obj.name}`);
        clean.push({ ingredientId: ing.obj.id, name: ing.obj.name, unit: ing.obj.unit, qty: round4(l.qty), unitPrice: l.unitPrice, total: Math.round(l.qty * l.unitPrice) });
        stmts.push(db.prepare(`INSERT INTO stock_moves (at, ingredient_id, qty, kind, ref, unit_cost, staff_id, staff_name, note)
            VALUES (?, ?, ?, 'achat', ?, ?, ?, ?, ?)`).bind(now, ing.obj.id, round4(l.qty), body.id, l.unitPrice, user.id, user.name, supplier));
        // Weighted average cost; a negative theoretical stock counts as zero so it cannot distort the average.
        stmts.push(db.prepare(`UPDATE records SET updated_at = ?, data = json_set(data,
                '$.avgCost', ROUND((MAX(COALESCE(json_extract(data, '$.stock'), 0), 0) * COALESCE(json_extract(data, '$.avgCost'), 0) + ? * ?)
                    / (MAX(COALESCE(json_extract(data, '$.stock'), 0), 0) + ?), 2),
                '$.stock', ROUND(COALESCE(json_extract(data, '$.stock'), 0) + ?, 4))
            WHERE collection = 'ingredients' AND id = ? AND deleted = 0`)
            .bind(now, round4(l.qty), l.unitPrice, round4(l.qty), round4(l.qty), ing.obj.id));
    }
    const purchase = {
        id: body.id, supplier, date: body.date, lines: clean, total: clean.reduce((s, l) => s + l.total, 0),
        note: typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '',
        staffId: user.id, staffName: user.name, at: new Date(now).toISOString()
    };
    stmts.unshift(db.prepare(`INSERT INTO records (collection, id, data, deleted, updated_at) VALUES ('purchases', ?, ?, 0, ?)`)
        .bind(purchase.id, JSON.stringify(purchase), now));
    stmts.push(auditStmt(db, user, 'achat', 'purchases', purchase.id, { fournisseur: supplier, total: purchase.total, lignes: clean.length }));
    try {
        await db.batch(stmts);
    } catch (e) {
        if (isUniqueError(e)) return fail(409, 'Achat deja enregistre');
        throw e;
    }
    return json({ ok: true, records: [rec('purchases', purchase), ...await ingredientRecords(db, clean.map(l => l.ingredientId))] });
}

async function ingredientRecords(db, ids) {
    const out = [];
    for (const id of [...new Set(ids)]) {
        const r = await getRecord(db, 'ingredients', id);
        if (r) out.push({ collection: 'ingredients', id, data: r.raw, deleted: 0 });
    }
    return out;
}

async function createLoss(request, db, user) {
    if (!has(user, 'stock.loss')) return fail(403, 'Vous ne pouvez pas declarer de perte');
    const body = await readBody(request);
    if (!body || !ID_RE.test(body.id || '')) return fail(400, 'Identifiant invalide');
    const ing = await getRecord(db, 'ingredients', body.ingredientId);
    if (!ing) return fail(404, 'Ingredient introuvable');
    if (!isQty(body.qty)) return fail(400, 'Quantite invalide');
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 3 || reason.length > 150) return fail(400, 'Indiquez le motif de la perte');
    const now = Date.now();
    try {
        await db.batch([
            ...stockMoveStmts(db, { ingredientId: ing.obj.id, qty: -body.qty, kind: 'perte', unitCost: ing.obj.avgCost || 0, user, note: reason, clientId: body.id, now }),
            auditStmt(db, user, 'perte', 'ingredients', ing.obj.id, { ingredient: ing.obj.name, quantite: body.qty, motif: reason })
        ]);
    } catch (e) {
        if (!isUniqueError(e)) throw e;
    }
    return json({ ok: true, records: await ingredientRecords(db, [ing.obj.id]) });
}

async function createInventory(request, db, user) {
    if (!has(user, 'stock.inventory')) return fail(403, "Vous ne pouvez pas valider d'inventaire");
    const body = await readBody(request);
    if (!body || !ID_RE.test(body.id || '')) return fail(400, 'Identifiant invalide');
    const dup = await getRecord(db, 'inventories', body.id);
    if (dup) return json({ duplicate: true, records: [rec('inventories', dup.obj)] });
    const lines = Array.isArray(body.lines) ? body.lines : [];
    if (!lines.length || lines.length > 500) return fail(400, 'Inventaire vide');
    const now = Date.now();
    const out = [];
    const stmts = [];
    for (const l of lines) {
        const ing = l && await getRecord(db, 'ingredients', l.ingredientId);
        if (!ing) return fail(400, 'Ingredient introuvable');
        if (!(typeof l.counted === 'number' && l.counted >= 0 && l.counted <= 1000000)) return fail(400, `Quantite comptee invalide pour ${ing.obj.name}`);
        const theoretical = round4(ing.obj.stock || 0);
        const diff = round4(l.counted - theoretical);
        const cost = ing.obj.avgCost || 0;
        out.push({ ingredientId: ing.obj.id, name: ing.obj.name, unit: ing.obj.unit, theoretical, counted: round4(l.counted), diff, value: Math.round(diff * cost) });
        if (diff !== 0) stmts.push(...stockMoveStmts(db, { ingredientId: ing.obj.id, qty: diff, kind: 'inventaire', ref: body.id, unitCost: cost, user, now }));
    }
    const inventory = {
        id: body.id, at: new Date(now).toISOString(), staffId: user.id, staffName: user.name, lines: out,
        totalValue: out.reduce((s, l) => s + l.value, 0),
        note: typeof body.note === 'string' ? body.note.trim().slice(0, 200) : ''
    };
    stmts.unshift(db.prepare(`INSERT INTO records (collection, id, data, deleted, updated_at) VALUES ('inventories', ?, ?, 0, ?)`)
        .bind(inventory.id, JSON.stringify(inventory), now));
    stmts.push(auditStmt(db, user, 'inventaire', 'inventories', inventory.id,
        { lignes: out.length, ecarts: out.filter(l => l.diff).length, valeur_ecart: inventory.totalValue }));
    try {
        await db.batch(stmts);
    } catch (e) {
        if (isUniqueError(e)) return fail(409, 'Inventaire deja enregistre');
        throw e;
    }
    return json({ ok: true, records: [rec('inventories', inventory), ...await ingredientRecords(db, out.map(l => l.ingredientId))] });
}

async function listMoves(url, db) {
    const id = url.searchParams.get('ingredientId') || '';
    const limit = Math.min(300, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 100));
    const { results } = await db.prepare(`SELECT at, qty, kind, ref, unit_cost, staff_name, note FROM stock_moves
        WHERE ingredient_id = ? ORDER BY id DESC LIMIT ?`).bind(id, limit).all();
    return json({ moves: results });
}

// Stock movements valued at their recorded cost (older sale moves without one fall back to the current average cost).
async function stockReport(url, db) {
    const from = parseInt(url.searchParams.get('from'), 10) || 0;
    const to = parseInt(url.searchParams.get('to'), 10) || Date.now();
    const value = 'm.qty * COALESCE(m.unit_cost, json_extract(r.data, \'$.avgCost\'), 0)';
    const join = "LEFT JOIN records r ON r.collection = 'ingredients' AND r.id = m.ingredient_id";
    const [byKind, byIngredient, losses] = await db.batch([
        db.prepare(`SELECT m.kind, COUNT(*) AS n, SUM(${value}) AS value FROM stock_moves m ${join}
            WHERE m.at >= ? AND m.at < ? GROUP BY m.kind`).bind(from, to),
        db.prepare(`SELECT m.ingredient_id AS id, json_extract(r.data, '$.name') AS name, json_extract(r.data, '$.unit') AS unit,
                SUM(CASE WHEN m.kind IN ('vente', 'annulation') THEN m.qty ELSE 0 END) AS consumed,
                SUM(CASE WHEN m.kind IN ('vente', 'annulation') THEN ${value} ELSE 0 END) AS consumedValue,
                SUM(CASE WHEN m.kind = 'perte' THEN m.qty ELSE 0 END) AS lost,
                SUM(CASE WHEN m.kind = 'perte' THEN ${value} ELSE 0 END) AS lostValue,
                SUM(CASE WHEN m.kind = 'inventaire' THEN ${value} ELSE 0 END) AS inventoryValue
            FROM stock_moves m ${join} WHERE m.at >= ? AND m.at < ? GROUP BY m.ingredient_id`).bind(from, to),
        db.prepare(`SELECT m.at, m.qty, m.note, m.staff_name, json_extract(r.data, '$.name') AS name, json_extract(r.data, '$.unit') AS unit,
                ${value} AS value FROM stock_moves m ${join} WHERE m.kind = 'perte' AND m.at >= ? AND m.at < ? ORDER BY m.at DESC LIMIT 200`).bind(from, to)
    ]);
    return json({ byKind: byKind.results, byIngredient: byIngredient.results, losses: losses.results });
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
    if (!has(user, 'orders.create')) return fail(403, "Vous n'etes pas autorise a prendre des commandes");
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
    if (!has(user, 'cash.session')) return fail(403, 'Vous ne pouvez pas gerer de caisse');
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
    if (!has(user, 'cash.session')) return fail(403, 'Vous ne pouvez pas gerer de caisse');
    const body = await readBody(request);
    const s = body && await getRecord(db, 'cashSessions', body.sessionId);
    if (!s) return fail(404, 'Session de caisse introuvable');
    if (s.obj.status !== 'ouverte') return fail(409, 'Cette caisse est deja cloturee');
    if (s.obj.staffId !== user.id && !has(user, 'cash.history')) return fail(403, "Vous ne pouvez pas cloturer la caisse d'un autre");
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
    if (!has(user, 'payments.create')) return fail(403, 'Vous ne pouvez pas encaisser');
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
    if (!has(user, 'refunds.create')) return fail(403, 'Vous ne pouvez pas effectuer de remboursement');
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

const ownerCount = async db => (await db.prepare("SELECT COUNT(*) AS n FROM staff WHERE role = 'proprietaire'").first()).n;

async function createStaff(request, db, user) {
    const body = await readBody(request);
    const error = validateStaff(body, true);
    if (error) return fail(400, error);
    if (body.role === 'proprietaire' && user.role !== 'proprietaire') return fail(403, 'Seul un proprietaire peut creer un compte proprietaire');
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
    const role = body.role;
    // Nobody can raise themselves or someone else to owner, or touch an owner account, without being an owner.
    if ((before.role === 'proprietaire' || role === 'proprietaire') && user.role !== 'proprietaire') {
        return fail(403, 'Seul un proprietaire peut modifier un compte proprietaire');
    }
    if (id === user.id && role !== before.role) return fail(403, 'Vous ne pouvez pas changer votre propre role');
    if (before.role === 'proprietaire' && role !== 'proprietaire' && await ownerCount(db) <= 1) {
        return fail(409, 'Il doit rester au moins un proprietaire');
    }
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
    if (id === user.id) return fail(403, 'Vous ne pouvez pas supprimer votre propre compte');
    const before = await db.prepare('SELECT name, username, role FROM staff WHERE id = ?').bind(id).first();
    if (!before) return fail(404, 'Membre introuvable');
    if (before.role === 'proprietaire') {
        if (user.role !== 'proprietaire') return fail(403, 'Seul un proprietaire peut supprimer un compte proprietaire');
        if (await ownerCount(db) <= 1) return fail(409, 'Il doit rester au moins un proprietaire');
    }
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

// ---------- ROLES ----------

async function getRoles(db) {
    return json({
        catalog: PERMISSIONS.map(([key, label, group]) => ({ key, label, group, ownerOnly: OWNER_ONLY.has(key) })),
        roles: await roleMatrix(db, true),
        defaults: DEFAULT_ROLE_PERMS
    });
}

async function updateRoles(request, db, user) {
    const body = await readBody(request);
    const roles = body && body.roles && typeof body.roles === 'object' ? body.roles : null;
    if (!roles) return fail(400, 'Donnees invalides');
    const custom = {};
    for (const r of ROLES) {
        if (r === 'proprietaire') continue;
        const list = Array.isArray(roles[r]) ? roles[r] : DEFAULT_ROLE_PERMS[r];
        if (list.some(p => !PERM_KEYS.has(p))) return fail(400, 'Permission inconnue');
        custom[r] = [...new Set(list.filter(p => !OWNER_ONLY.has(p)))];
    }
    const before = await roleMatrix(db, true);
    await db.batch([
        db.prepare(`INSERT INTO settings (key, value) VALUES ('role_perms', ?)
            ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(JSON.stringify(custom)),
        auditStmt(db, user, 'roles', 'staff', null, Object.fromEntries(Object.keys(custom).map(r => {
            const added = custom[r].filter(p => !before[r].includes(p));
            const removed = before[r].filter(p => !custom[r].includes(p));
            return [r, added.length || removed.length ? `+${added.join(',')} -${removed.join(',')}` : '='];
        }).filter(([, v]) => v !== '=')))
    ]);
    return getRoles(db);
}

// ---------- MENU PUBLIC (QR code) ----------
// No login: only what a customer may see (no recipes, costs or internal ids beyond the item id).

async function publicMenu(db) {
    const { results } = await db.prepare(`SELECT collection, data FROM records WHERE deleted = 0
        AND collection IN ('categories', 'menuItems')`).all();
    const categories = [], items = [];
    for (const r of results) {
        const d = JSON.parse(r.data);
        if (r.collection === 'categories') categories.push({ id: d.id, name: d.name, icon: d.icon || '' });
        else {
            const o = d.options || {};
            items.push({
                id: d.id, name: d.name, desc: d.desc || '', price: d.price, category: d.category, available: d.available !== false,
                photo: d.photo ? `/api/public/photo/${d.id}?v=${(await sha256(d.photo)).slice(0, 10)}` : null,
                sides: o.sides || [], extras: (o.extras || []).map(e => ({ name: e.name, price: e.price })), prefs: o.prefs || []
            });
        }
    }
    items.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    return { restaurant: { name: 'Restaurant Sissiman', city: 'Bobo-Dioulasso, Burkina Faso', currency: 'FCFA' }, categories, items, at: Date.now() };
}

async function publicPhoto(db, id) {
    const row = await db.prepare(`SELECT json_extract(data, '$.photo') AS photo FROM records
        WHERE collection = 'menuItems' AND id = ? AND deleted = 0`).bind(id).first();
    const m = row && row.photo && row.photo.match(/^data:(image\/(?:jpeg|webp|png));base64,([A-Za-z0-9+/]+=*)$/);
    if (!m) return new Response('Introuvable', { status: 404 });
    const bin = Uint8Array.from(atob(m[2]), ch => ch.charCodeAt(0));
    // The URL carries a content hash, so the image can be cached for a long time.
    return new Response(bin, { headers: { 'Content-Type': m[1], 'Cache-Control': 'public, max-age=604800, immutable', 'X-Content-Type-Options': 'nosniff' } });
}

async function handlePublic(request, env, url, ctx) {
    if (request.method !== 'GET') return fail(405, 'Methode non autorisee');
    const cache = caches.default;
    const hit = await cache.match(request);
    if (hit) return hit;
    let res;
    if (url.pathname === '/api/public/menu') {
        res = new Response(JSON.stringify(await publicMenu(env.DB)), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', 'X-Content-Type-Options': 'nosniff' }
        });
    } else {
        const pm = url.pathname.match(/^\/api\/public\/photo\/([a-zA-Z0-9_-]{1,100})$/);
        res = pm ? await publicPhoto(env.DB, pm[1]) : fail(404, 'Introuvable');
    }
    if (res.ok && ctx) ctx.waitUntil(cache.put(request, res.clone()));
    return res;
}

// ---------- ROUTER ----------

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/api/public/')) {
            try { return await handlePublic(request, env, url, ctx); } catch (e) { console.error(e); return fail(500, 'Erreur serveur'); }
        }
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
        user.perms = new Set((await roleMatrix(db))[user.role] || []);
        const me = () => ({ ...publicStaff(user), perms: [...user.perms] });

        if (route === '/me' && method === 'GET') return json({ user: me(), mustChangePassword: user.must_change_pw === 1 });
        if (route === '/logout' && method === 'POST') {
            const token = request.headers.get('Authorization').slice(7);
            await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
            return json({ ok: true });
        }
        if (route === '/password' && method === 'POST') return await changeOwnPassword(request, db, user);
        if (user.must_change_pw === 1) return fail(403, 'Changement de mot de passe requis');

        if (route === '/sync' && method === 'GET') return await pull(url, db, user);
        if (route === '/sync' && method === 'POST') return await push(request, db, user);
        if (route === '/orders/next-number' && method === 'POST') return await nextOrderNumber(request, db, user);
        if (route === '/cash/open' && method === 'POST') return await openCash(request, db, user);
        if (route === '/cash/close' && method === 'POST') return await closeCash(request, db, user);
        if (route === '/payments' && method === 'POST') return await createPayment(request, db, user);
        if (route === '/refunds' && method === 'POST') return await createRefund(request, db, user);
        if (route === '/purchases' && method === 'POST') return await createPurchase(request, db, user);
        if (route === '/stock/loss' && method === 'POST') return await createLoss(request, db, user);
        if (route === '/inventories' && method === 'POST') return await createInventory(request, db, user);
        if (route === '/stock/moves' && method === 'GET') {
            if (!has(user, 'stock.view')) return fail(403, 'Non autorise');
            return await listMoves(url, db);
        }

        if (route === '/reports/stock' && method === 'GET') {
            if (!has(user, 'reports.view') && !has(user, 'stock.view')) return fail(403, 'Non autorise');
            return await stockReport(url, db);
        }
        if (route === '/roles' && method === 'GET') {
            if (!has(user, 'staff.manage') && !has(user, 'roles.manage')) return fail(403, 'Non autorise');
            return await getRoles(db);
        }
        if (route === '/roles' && method === 'PUT') {
            if (!has(user, 'roles.manage')) return fail(403, 'Seul le proprietaire peut modifier les roles');
            return await updateRoles(request, db, user);
        }
        if (route === '/audit' && method === 'GET') {
            if (!has(user, 'audit.view')) return fail(403, "Vous ne pouvez pas consulter le journal");
            return await listAudit(url, db);
        }
        const sm = route.match(/^\/staff(?:\/(\d+))?$/);
        if (sm) {
            if (!has(user, 'staff.manage')) return fail(403, 'Vous ne pouvez pas gerer le personnel');
            if (!sm[1] && method === 'GET') {
                const { results } = await db.prepare('SELECT id, username, name, role FROM staff ORDER BY id').all();
                return json({ staff: results });
            }
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
