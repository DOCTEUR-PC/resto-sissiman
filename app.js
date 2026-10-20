const App = {
    data: {
        tables: [],
        categories: [],
        menuItems: [],
        orders: [],
        payments: [],
        refunds: [],
        cashSessions: [],
        ingredients: [],
        purchases: [],
        inventories: []
    },

    staff: [],
    currentUser: null,
    token: localStorage.getItem('sissiman-token'),
    uiReady: false,

    init() {
        this.setupTheme();
        if (!this.auth.checkSession()) return;
        this.start();
    },

    async start() {
        this.loadData();
        if (!this.uiReady) {
            this.setupNav();
            this.startClock();
            this.setupUserMenu();
            this.setupSidebar();
            this.setupIconPicker();
            this.setupModals();
            this.setupKeyboard();
            this.cuisine.init();
            this.uiReady = true;
        }
        this.sync.restore();
        this.render();
        try {
            const me = await this.api('/me');
            this.currentUser = me.user;
            localStorage.setItem('sissiman-user', JSON.stringify(me.user));
            if (me.mustChangePassword) {
                this.password.open(true);
                return;
            }
        } catch (e) {
            if (e.status) return;
        }
        await this.sync.tick();
        if (!this.currentUser) return;
        if (this.sync.ready) {
            this.seedDefaults();
            await this.loadStaff();
        } else {
            this.toast('Serveur injoignable : affichage des donnees locales', 'error');
        }
        this.render();
        this.sync.start();
    },

    async api(path, { method = 'GET', body } = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (this.token) headers.Authorization = 'Bearer ' + this.token;
        const res = await fetch('/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            if (res.status === 401 && path !== '/login') this.auth.expire();
            if (res.status === 403 && data.error === 'Changement de mot de passe requis') this.password.open(true);
            const err = new Error(data.error || 'Erreur serveur');
            err.status = res.status;
            throw err;
        }
        return data;
    },

    // POSTs a server-side operation and applies the records it returns, so the screen updates without waiting for the next sync.
    async serverAction(path, body) {
        const res = await this.api(path, { method: 'POST', body });
        if (res.records && res.records.length) {
            this.sync.apply(res.records);
            this.cacheData();
        }
        this.render();
        return res;
    },

    // Waiters (and anyone not on the kitchen screen) hear and see when a dish is ready to be carried out.
    onOrderEvents(events) {
        if (!this.currentUser || document.body.classList.contains('kitchen-mode')) return;
        if (!this.can('orders.serve')) return;
        const ready = events.filter(e => e.to === 'prete' && e.from);
        if (!ready.length) return;
        ready.slice(0, 3).forEach(e => {
            const t = this.data.tables.find(x => x.id === e.order.tableId);
            this.toast(`Commande #${String(e.order.number).padStart(3, '0')} (${t ? 'table ' + t.number : 'a emporter'}) prete a servir`);
        });
        if (this.cuisine.sound) this.cuisine.playNotif(true);
    },

    balance(o) {
        const paid = o.paid || 0;
        return { paid, refunded: o.refunded || 0, remaining: Math.max(0, o.total - paid) };
    },

    lineTotal(it) {
        return (it.unitPrice != null ? it.unitPrice : it.price) * it.qty;
    },

    itemDetails(it) {
        const d = [];
        if (it.side) d.push(it.side);
        (it.extras || []).forEach(e => d.push('+ ' + e.name));
        (it.prefs || []).forEach(p => d.push(p));
        if (it.comment) d.push('« ' + it.comment + ' »');
        return d;
    },

    itemDetailHtml(it) {
        const d = this.itemDetails(it);
        return d.length ? `<span class="item-opts">${this.esc(d.join(' · '))}</span>` : '';
    },

    refundedOf(paymentId) {
        return this.data.refunds.filter(r => r.paymentId === paymentId).reduce((s, r) => s + r.amount, 0);
    },

    methodLabel(m) {
        return { especes: 'Especes', mobile: 'Mobile Money', carte: 'Carte' }[m] || this.esc(m || '');
    },

    myCashSession() {
        return this.currentUser
            ? this.data.cashSessions.find(s => s.status === 'ouverte' && s.staffId === this.currentUser.id)
            : null;
    },

    async loadStaff() {
        if (!this.can('staff.manage')) { this.staff = []; return; }
        try {
            this.staff = (await this.api('/staff')).staff;
        } catch (e) { /* garde la liste actuelle */ }
    },

    sync: {
        COLLECTIONS: ['tables', 'categories', 'menuItems', 'orders', 'payments', 'refunds', 'cashSessions', 'ingredients', 'purchases', 'inventories'],
        // synced[key] holds a hash of the last server-confirmed JSON, so pending local edits are whatever differs from it.
        synced: {},
        since: 0,
        ready: false,
        online: true,
        busy: false,
        timer: null,
        pushTimer: null,
        lastOk: 0,
        lastTick: 0,
        offlineSince: 0,
        events: [],

        h(s) {
            let x = 0x811c9dc5;
            for (let i = 0; i < s.length; i++) {
                x ^= s.charCodeAt(i);
                x = Math.imul(x, 0x01000193);
            }
            return (x >>> 0).toString(36) + '.' + s.length.toString(36);
        },

        snapshot() {
            const m = {};
            for (const c of this.COLLECTIONS) {
                for (const it of App.data[c]) m[c + '/' + it.id] = JSON.stringify(it);
            }
            return m;
        },

        pendingCount() {
            const now = this.snapshot();
            let n = 0;
            for (const [key, data] of Object.entries(now)) if (this.synced[key] !== this.h(data)) n++;
            for (const key of Object.keys(this.synced)) if (!(key in now)) n++;
            return n;
        },

        // Saved in the same localStorage entry as the data (see App.cacheData), so the two can never disagree.
        cached: null,

        // After a reload while offline, pending edits are still recognised and get sent when the network returns.
        restore() {
            const s = this.cached;
            this.cached = null;
            if (this.ready || !App.currentUser || !s || s.user !== App.currentUser.id || !s.synced) return;
            this.synced = s.synced;
            this.since = s.since || 0;
            this.ready = true;
        },

        apply(records, silent) {
            let changed = false;
            for (const r of records) {
                if (!this.COLLECTIONS.includes(r.collection)) continue;
                const key = r.collection + '/' + r.id;
                const list = App.data[r.collection];
                const idx = list.findIndex(x => String(x.id) === r.id);
                if (r.deleted) {
                    if (idx >= 0) { list.splice(idx, 1); changed = true; }
                    delete this.synced[key];
                } else {
                    const item = JSON.parse(r.data);
                    // Hash the re-serialised form: SQLite may write 2.0 where the browser writes 2.
                    const hash = this.h(JSON.stringify(item));
                    if (this.synced[key] === hash && idx >= 0) continue;
                    const old = idx >= 0 ? list[idx] : null;
                    if (!silent && r.collection === 'orders' && (!old || old.status !== item.status)) {
                        this.events.push({ order: item, from: old ? old.status : null, to: item.status });
                    }
                    if (idx >= 0) list[idx] = item; else list.push(item);
                    this.synced[key] = hash;
                    changed = true;
                }
            }
            return changed;
        },

        async initial() {
            const res = await App.api('/sync?since=0');
            this.since = res.now - 5000;
            this.synced = {};
            // Base vide : on garde les donnees locales, elles seront envoyees au prochain push.
            if (res.records.length > 0) {
                for (const c of this.COLLECTIONS) App.data[c] = [];
                this.apply(res.records, true);
            }
            this.ready = true;
        },

        async push() {
            const now = this.snapshot();
            const changes = [];
            for (const [key, data] of Object.entries(now)) {
                if (this.synced[key] !== this.h(data)) changes.push({ key, data });
            }
            for (const key of Object.keys(this.synced)) {
                if (!(key in now)) changes.push({ key, data: null });
            }
            let reverted = false;
            for (let i = 0; i < changes.length; i += 200) {
                const chunk = changes.slice(i, i + 200);
                const res = await App.api('/sync', {
                    method: 'POST',
                    body: { changes: chunk.map(c => {
                        const slash = c.key.indexOf('/');
                        return { collection: c.key.slice(0, slash), id: c.key.slice(slash + 1), data: c.data };
                    }) }
                });
                const rejected = new Set();
                for (const r of res.rejected || []) {
                    rejected.add(r.collection + '/' + r.id);
                    this.revert(r);
                    reverted = true;
                }
                if (res.rejected && res.rejected.length) App.toast(res.rejected[0].error, 'error');
                for (const c of chunk) {
                    if (rejected.has(c.key)) continue;
                    if (c.data === null) delete this.synced[c.key]; else this.synced[c.key] = this.h(c.data);
                }
            }
            if (reverted) {
                App.cacheData();
                App.render();
            }
            return changes.length > 0;
        },

        revert(r) {
            const key = r.collection + '/' + r.id;
            const list = App.data[r.collection];
            const idx = list.findIndex(x => String(x.id) === r.id);
            if (r.data === null) {
                if (idx >= 0) list.splice(idx, 1);
                delete this.synced[key];
            } else {
                const item = JSON.parse(r.data);
                if (idx >= 0) list[idx] = item; else list.push(item);
                this.synced[key] = this.h(JSON.stringify(item));
            }
        },

        async tick() {
            if (this.busy || !App.currentUser) return;
            this.busy = true;
            this.lastTick = Date.now();
            try {
                const fresh = !this.ready;
                if (fresh) await this.initial();
                const pushed = (await this.push()) || fresh;
                const res = await App.api('/sync?since=' + this.since);
                this.since = res.now - 5000;
                if (res.perms) App.setPerms(res.perms);
                const changed = this.apply(res.records);
                if (changed) App.render();
                if (changed || pushed) App.cacheData();
                this.lastOk = Date.now();
                this.setOnline(true);
                const events = this.events.splice(0);
                if (events.length) App.onOrderEvents(events);
            } catch (e) {
                if (!e.status) this.setOnline(false);
            } finally {
                this.busy = false;
            }
        },

        schedulePush() {
            clearTimeout(this.pushTimer);
            this.pushTimer = setTimeout(() => this.tick(), 300);
        },

        setOnline(online) {
            if (online === this.online) return;
            this.online = online;
            this.offlineSince = online ? 0 : Date.now();
            App.toast(online ? 'Connexion retablie' : 'Connexion perdue : modifications en attente', online ? 'success' : 'error');
        },

        // Every 4 s while visible; a background tab only checks every 30 s to save requests (free plan quota).
        start() {
            this.stop();
            this.timer = setInterval(() => {
                if (document.hidden && Date.now() - this.lastTick < 30000) return;
                this.tick();
            }, 4000);
            if (!this.visHandler) {
                this.visHandler = () => { if (!document.hidden && this.timer) this.tick(); };
                document.addEventListener('visibilitychange', this.visHandler);
            }
        },

        stop() {
            clearInterval(this.timer);
            clearTimeout(this.pushTimer);
            this.timer = null;
        },

        reset() {
            this.stop();
            this.synced = {};
            this.since = 0;
            this.ready = false;
            this.online = true;
            this.offlineSince = 0;
            this.lastOk = 0;
            this.events = [];
            this.cached = null;
        }
    },

    esc(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    },

    toast(message, type = 'success') {
        const el = document.createElement('div');
        el.className = `toast toast-${type}`;
        el.textContent = message;
        document.body.appendChild(el);
        requestAnimationFrame(() => el.classList.add('show'));
        setTimeout(() => {
            el.classList.remove('show');
            setTimeout(() => el.remove(), 300);
        }, 2500);
    },

    setupModals() {
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal && modal.dataset.locked !== 'true') modal.classList.remove('open');
            });
        });
    },

    setupKeyboard() {
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const openModals = document.querySelectorAll('.modal.open:not([data-locked="true"])');
                if (!openModals.length && this.pos.isOpen()) this.pos.close();
                openModals.forEach(m => m.classList.remove('open'));
            }
        });
    },

    // PERSISTENCE
    loadData() {
        const saved = localStorage.getItem('restoManagerData');
        if (saved) {
            const parsed = JSON.parse(saved);
            this.sync.cached = parsed.__sync || null;
            delete parsed.__sync;
            Object.assign(this.data, parsed);
        }
    },

    cacheData() {
        const payload = { ...this.data };
        if (this.sync.ready && this.currentUser) {
            payload.__sync = { user: this.currentUser.id, since: this.sync.since, synced: this.sync.synced };
        }
        try {
            localStorage.setItem('restoManagerData', JSON.stringify(payload));
        } catch (e) { /* stockage plein : les donnees restent en memoire et sur le serveur */ }
    },

    saveData() {
        this.cacheData();
        this.sync.schedulePush();
    },

    seedDefaults() {
        if (this.data.categories.length > 0) return;
        this.data.categories = [
            { id: 'cat1', name: 'Entrees', icon: '🥗' },
            { id: 'cat2', name: 'Grillades', icon: '🍗' },
            { id: 'cat3', name: 'Poissons', icon: '🐟' },
            { id: 'cat4', name: 'Accompagnements', icon: '🍚' },
            { id: 'cat5', name: 'Boissons', icon: '🥤' },
            { id: 'cat6', name: 'Desserts', icon: '🍰' }
        ];
        this.data.menuItems = [
            { id: 'm1', name: 'Salade composee', category: 'cat1', price: 1500, desc: 'Salade fraiche du jour', available: true },
            { id: 'm2', name: 'Aloko', category: 'cat1', price: 1000, desc: 'Bananes plantain frites', available: true },
            { id: 'm3', name: 'Poulet braise', category: 'cat2', price: 3500, desc: 'Poulet braise aux epices', available: true },
            { id: 'm4', name: 'Brochettes de boeuf', category: 'cat2', price: 2500, desc: '4 brochettes grillees', available: true },
            { id: 'm5', name: 'Cote de porc', category: 'cat2', price: 3000, desc: 'Cote de porc grillee', available: true },
            { id: 'm6', name: 'Poisson braise', category: 'cat3', price: 4000, desc: 'Poisson entier braise', available: true },
            { id: 'm7', name: 'Capitaine grille', category: 'cat3', price: 5000, desc: 'Filet de capitaine', available: true },
            { id: 'm8', name: 'Riz sauce', category: 'cat4', price: 1500, desc: 'Riz avec sauce tomate', available: true },
            { id: 'm9', name: 'Attiéke', category: 'cat4', price: 1000, desc: 'Semoule de manioc', available: true },
            { id: 'm10', name: 'Frites', category: 'cat4', price: 1000, desc: 'Frites de pommes de terre', available: true },
            { id: 'm11', name: 'Coca-Cola', category: 'cat5', price: 500, desc: 'Canette 33cl', available: true },
            { id: 'm12', name: 'Fanta', category: 'cat5', price: 500, desc: 'Canette 33cl', available: true },
            { id: 'm13', name: 'Biere Flag', category: 'cat5', price: 800, desc: 'Bouteille 65cl', available: true },
            { id: 'm14', name: 'Jus de bissap', category: 'cat5', price: 500, desc: 'Verre de bissap frais', available: true },
            { id: 'm15', name: 'Eau minerale', category: 'cat5', price: 300, desc: 'Bouteille 1.5L', available: true },
            { id: 'm16', name: 'Gateau chocolat', category: 'cat6', price: 1500, desc: 'Part de gateau', available: true },
            { id: 'm17', name: 'Fruits de saison', category: 'cat6', price: 1000, desc: 'Assiette de fruits', available: true }
        ];
        this.data.tables = [
            { id: 't1', number: 1, seats: 4, location: 'interieur', status: 'libre' },
            { id: 't2', number: 2, seats: 4, location: 'interieur', status: 'libre' },
            { id: 't3', number: 3, seats: 2, location: 'interieur', status: 'libre' },
            { id: 't4', number: 4, seats: 6, location: 'interieur', status: 'libre' },
            { id: 't5', number: 5, seats: 4, location: 'terrasse', status: 'libre' },
            { id: 't6', number: 6, seats: 4, location: 'terrasse', status: 'libre' },
            { id: 't7', number: 7, seats: 8, location: 'vip', status: 'libre' },
            { id: 't8', number: 8, seats: 2, location: 'terrasse', status: 'libre' }
        ];
        this.saveData();
    },

    // NAVIGATION
    setupNav() {
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                const page = item.dataset.page;
                this.navigateTo(page);
            });
        });
    },

    navigateTo(page) {
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        document.querySelector(`[data-page="${page}"]`).classList.add('active');
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.getElementById(`page-${page}`).classList.add('active');
        const titles = {
            dashboard: 'Tableau de bord',
            tables: 'Gestion des tables',
            orders: 'Commandes',
            menu: 'Menu / Carte',
            caisse: 'Caisse',
            cuisine: 'Ecran Cuisine',
            stocks: 'Stocks & approvisionnement',
            rapports: 'Rapports & Statistiques',
            personnel: 'Gestion du personnel'
        };
        document.getElementById('pageTitle').textContent = titles[page] || page;
        if (page === 'personnel') { this.audit.load(); this.roles.load(); }
        if (window.innerWidth <= 768) {
            document.getElementById('sidebar').classList.remove('open');
        }
        this.render();
    },

    password: {
        forced: false,

        open(forced) {
            this.forced = forced;
            const modal = document.getElementById('modalPassword');
            modal.dataset.locked = forced ? 'true' : 'false';
            document.getElementById('passwordClose').style.display = forced ? 'none' : '';
            document.getElementById('passwordNotice').style.display = forced ? '' : 'none';
            document.getElementById('passwordForm').reset();
            document.getElementById('passwordError').textContent = '';
            document.getElementById('userDropdown').classList.remove('open');
            modal.classList.add('open');
            document.getElementById('pwCurrent').focus();
        },

        close(forceClose) {
            if (this.forced && !forceClose) return;
            this.forced = false;
            const modal = document.getElementById('modalPassword');
            modal.dataset.locked = 'false';
            modal.classList.remove('open');
        },

        async submit(e) {
            e.preventDefault();
            const errorEl = document.getElementById('passwordError');
            const current = document.getElementById('pwCurrent').value;
            const next = document.getElementById('pwNext').value;
            if (next !== document.getElementById('pwConfirm').value) {
                errorEl.textContent = 'Les deux mots de passe ne correspondent pas';
                return false;
            }
            const btn = e.target.querySelector('button[type="submit"]');
            btn.disabled = true;
            try {
                await App.api('/password', { method: 'POST', body: { current, next } });
            } catch (err) {
                errorEl.textContent = err.status ? err.message : 'Impossible de joindre le serveur';
                return false;
            } finally {
                btn.disabled = false;
            }
            const wasForced = this.forced;
            this.close(true);
            App.toast('Mot de passe modifie');
            if (wasForced) App.start();
            return false;
        }
    },

    ROLE_LABELS: {
        proprietaire: 'Proprietaire', gerant: 'Gerant', caissier: 'Caissier', serveur: 'Serveur',
        cuisinier: 'Cuisinier', stock: 'Gestionnaire de stock', comptable: 'Comptable'
    },

    roleLabel(r) {
        return this.ROLE_LABELS[r] || r;
    },

    roles: {
        data: null,
        draft: null,
        ORDER: ['gerant', 'caissier', 'serveur', 'cuisinier', 'stock', 'comptable', 'proprietaire'],

        async load() {
            if (!App.can('staff.manage') && !App.can('roles.manage')) return;
            try {
                this.data = await App.api('/roles');
                this.draft = JSON.parse(JSON.stringify(this.data.roles));
                this.render();
            } catch (e) {
                document.getElementById('rolesMatrix').innerHTML = '<p class="empty-state">Roles indisponibles hors connexion</p>';
            }
        },

        render() {
            if (!this.data) return;
            const editable = App.can('roles.manage');
            document.getElementById('rolesSave').style.display = editable ? '' : 'none';
            document.getElementById('rolesReset').style.display = editable ? '' : 'none';
            document.getElementById('rolesHint').textContent = editable
                ? 'Cochez ce que chaque role peut faire. Le proprietaire a toujours tous les droits. Les changements s\'appliquent aux appareils connectes en quelques secondes.'
                : 'Seul le proprietaire peut modifier ces permissions.';
            const groups = [];
            this.data.catalog.forEach(p => {
                let g = groups.find(x => x.name === p.group);
                if (!g) groups.push(g = { name: p.group, perms: [] });
                g.perms.push(p);
            });
            const head = `<tr><th>Permission</th>${this.ORDER.map(r => `<th class="role-col">${App.esc(App.roleLabel(r))}</th>`).join('')}</tr>`;
            const rows = groups.map(g => `<tr class="perm-group"><td colspan="${this.ORDER.length + 1}">${App.esc(g.name)}</td></tr>` +
                g.perms.map(p => `<tr><td>${App.esc(p.label)}</td>${this.ORDER.map(r => {
                    const locked = !editable || r === 'proprietaire' || p.ownerOnly;
                    const on = (this.draft[r] || []).includes(p.key);
                    return `<td class="role-col"><input type="checkbox" ${on ? 'checked' : ''} ${locked ? 'disabled' : ''}
                        aria-label="${App.esc(App.roleLabel(r) + ' : ' + p.label)}" onchange="App.roles.toggle('${r}', '${p.key}', this.checked)"></td>`;
                }).join('')}</tr>`).join('')).join('');
            document.getElementById('rolesMatrix').innerHTML = `<table class="data-table roles-table"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
        },

        toggle(role, perm, on) {
            const list = new Set(this.draft[role] || []);
            if (on) list.add(perm); else list.delete(perm);
            this.draft[role] = [...list];
        },

        resetDefaults() {
            if (!this.data || !confirm('Revenir aux permissions par defaut pour tous les roles ?')) return;
            this.draft = { ...JSON.parse(JSON.stringify(this.data.defaults)), proprietaire: this.draft.proprietaire };
            this.render();
        },

        async save() {
            const btn = document.getElementById('rolesSave');
            btn.disabled = true;
            try {
                const roles = {};
                this.ORDER.filter(r => r !== 'proprietaire').forEach(r => { roles[r] = this.draft[r] || []; });
                this.data = await App.api('/roles', { method: 'PUT', body: { roles } });
                this.draft = JSON.parse(JSON.stringify(this.data.roles));
                this.render();
                App.toast('Permissions enregistrees');
                App.audit.load();
            } catch (e) {
                App.toast(e.status ? e.message : 'Connexion impossible', 'error');
            } finally {
                btn.disabled = false;
            }
        }
    },

    audit: {
        labels: {
            creation: 'a cree', modification: 'a modifie', suppression: 'a supprime', refus: 'action refusee :',
            login: "s'est connecte", login_echec: 'Echec de connexion', mot_de_passe: 'a change son mot de passe',
            roles: 'a modifie les permissions', encaissement: 'a encaisse', remboursement: 'a rembourse',
            ouverture_caisse: 'a ouvert sa caisse', cloture_caisse: 'a cloture une caisse',
            achat: 'a enregistre un achat', perte: 'a declare une perte', inventaire: 'a valide un inventaire'
        },
        collections: {
            orders: 'commande', payments: 'paiement', menuItems: 'plat', categories: 'categorie', tables: 'table', staff: 'membre'
        },

        async load() {
            const list = document.getElementById('auditList');
            if (!App.can('audit.view')) return;
            try {
                const { entries } = await App.api('/audit?limit=150');
                list.innerHTML = entries.length ? entries.map(e => this.row(e)).join('') : '<p class="empty-state">Aucune activite</p>';
            } catch (err) {
                list.innerHTML = '<p class="empty-state">Journal indisponible</p>';
            }
        },

        row(e) {
            const d = new Date(e.at);
            const time = d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) + ' ' +
                d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
            let detail = {};
            try { detail = JSON.parse(e.detail) || {}; } catch (err) { /* ignore */ }
            const what = [this.labels[e.action] || e.action];
            if (e.collection && ['creation', 'modification', 'suppression', 'refus'].includes(e.action)) {
                what.push(this.collections[e.collection] || e.collection);
            }
            if (e.action === 'refus') what.push('— ' + (detail.raison || ''));
            else if (e.action === 'login_echec') what.push(`(${detail.username || '?'})${detail.verrouille ? ' — compte bloque 15 min' : ''}`);
            else if (e.action === 'modification') {
                what.push(Object.entries(detail).map(([k, v]) => `${k}: ${this.val(v[0])} → ${this.val(v[1])}`).join(', '));
            } else if (detail && typeof detail === 'object') {
                what.push(Object.entries(detail).filter(([k]) => k !== 'ip').map(([k, v]) => `${k} ${this.val(v)}`).join(', '));
            }
            return `<div class="audit-row ${App.esc(e.action)}">
                <span class="audit-time">${App.esc(time)}</span>
                <span class="audit-who">${App.esc(e.staff_name || '—')}</span>
                <span class="audit-what">${App.esc(what.join(' '))}</span>
            </div>`;
        },

        val(v) {
            if (v === null || v === undefined) return '—';
            if (typeof v === 'object') return Array.isArray(v) ? `${v.length} element(s)` : '{…}';
            return String(v).slice(0, 40);
        }
    },

    loginBg: {
        count: 40,
        timer: null,
        order: [],
        pos: 0,
        layer: 0,
        credits: null,

        start() {
            if (this.timer) return;
            if (!this.order.length) {
                this.order = Array.from({ length: this.count }, (_, i) => i + 1);
                for (let i = this.order.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
                }
                fetch('images/food/credits.json').then(r => r.json()).then(c => { this.credits = c; }).catch(() => {});
            }
            this.timer = setInterval(() => this.next(), 5000);
            this.next();
        },

        stop() {
            clearInterval(this.timer);
            this.timer = null;
        },

        url(n) {
            return 'images/food/' + String(n).padStart(2, '0') + '.jpg';
        },

        next() {
            const n = this.order[this.pos % this.order.length];
            this.pos++;
            const img = new Image();
            img.onload = () => {
                if (!this.timer) return;
                const slides = document.querySelectorAll('.login-slide');
                const incoming = slides[this.layer];
                const outgoing = slides[1 - this.layer];
                incoming.style.backgroundImage = `url("${img.src}")`;
                incoming.classList.remove('kb-1', 'kb-2', 'kb-3', 'kb-4');
                void incoming.offsetWidth;
                incoming.classList.add('kb-' + (1 + Math.floor(Math.random() * 4)), 'active');
                outgoing.classList.remove('active');
                this.layer = 1 - this.layer;
                const c = this.credits && this.credits[n - 1];
                document.getElementById('loginCredit').textContent = c ? `Photo : ${c.author || 'Wikimedia Commons'} — ${c.license}` : '';
            };
            img.src = this.url(n);
            new Image().src = this.url(this.order[this.pos % this.order.length]);
        }
    },

    auth: {
        checkSession() {
            const saved = localStorage.getItem('sissiman-user');
            if (saved && App.token) {
                try {
                    App.currentUser = JSON.parse(saved);
                    document.getElementById('loginScreen').classList.add('hidden');
                    return true;
                } catch(e) { /* session locale corrompue */ }
            }
            this.clearSession();
            document.getElementById('loginScreen').classList.remove('hidden');
            App.loginBg.start();
            return false;
        },

        async login(e) {
            e.preventDefault();
            const btn = e.target.querySelector('button[type="submit"]');
            const errorEl = document.getElementById('loginError');
            const username = document.getElementById('loginUser').value.trim();
            const password = document.getElementById('loginPass').value;
            btn.disabled = true;
            errorEl.textContent = '';
            try {
                const res = await App.api('/login', { method: 'POST', body: { username, password } });
                App.token = res.token;
                App.currentUser = res.user;
                localStorage.setItem('sissiman-token', res.token);
                localStorage.setItem('sissiman-user', JSON.stringify(res.user));            } catch (err) {
                errorEl.textContent = err.status ? err.message : 'Impossible de joindre le serveur';
                return false;
            } finally {
                btn.disabled = false;
            }
            document.getElementById('loginScreen').classList.add('hidden');
            App.loginBg.stop();
            document.getElementById('loginUser').value = '';
            document.getElementById('loginPass').value = '';
            App.start();
            return false;
        },

        clearSession() {
            App.sync.reset();
            App.currentUser = null;
            App.token = null;
            App.staff = [];
            localStorage.removeItem('sissiman-user');
            localStorage.removeItem('sissiman-token');
            // Shared tablets: the next person must not find the previous user's data (payments, stock values) in storage.
            localStorage.removeItem('restoManagerData');
            Object.keys(App.data).forEach(k => { App.data[k] = []; });
            App.password.close(true);
            if (App.pos.isOpen()) App.pos.close(true);
        },

        showLogin() {
            document.getElementById('loginScreen').classList.remove('hidden');
            document.getElementById('userDropdown').classList.remove('open');
            App.loginBg.start();
        },

        logout() {
            if (App.token) App.api('/logout', { method: 'POST' }).catch(() => {});
            this.clearSession();
            this.showLogin();
        },

        expire() {
            if (!App.currentUser) return;
            this.clearSession();
            this.showLogin();
            App.toast('Session expiree, reconnectez-vous', 'error');
        }
    },

    setupTheme() {
        const saved = localStorage.getItem('sissiman-theme') || 'light';
        this.applyTheme(saved);
    },

    applyTheme(theme) {
        if (theme === 'system') {
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
        } else {
            document.documentElement.setAttribute('data-theme', theme);
        }
        localStorage.setItem('sissiman-theme', theme);
        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === theme);
        });
    },

    setupUserMenu() {
        const avatar = document.getElementById('userAvatar');
        const dropdown = document.getElementById('userDropdown');
        if (!avatar) return;

        avatar.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.toggle('open');
        });

        document.addEventListener('click', (e) => {
            if (!dropdown.contains(e.target) && !avatar.contains(e.target)) {
                dropdown.classList.remove('open');
            }
        });

        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.applyTheme(btn.dataset.theme);
            });
        });

        const currentTheme = localStorage.getItem('sissiman-theme') || 'light';
        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === currentTheme);
        });
    },

    setupSidebar() {
        const sidebar = document.getElementById('sidebar');
        document.getElementById('menuToggle').addEventListener('click', () => {
            sidebar.classList.toggle('open');
        });
        const overlay = document.getElementById('sidebarOverlay');
        if (overlay) {
            overlay.addEventListener('click', () => sidebar.classList.remove('open'));
        }
    },

    startClock() {
        const update = () => {
            const now = new Date();
            document.getElementById('clock').textContent = now.toLocaleTimeString('fr-FR');
            const options = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
            document.getElementById('date').textContent = now.toLocaleDateString('fr-FR', options);
        };
        update();
        setInterval(update, 1000);
    },

    setupIconPicker() {
        document.querySelectorAll('.icon-option').forEach(opt => {
            opt.addEventListener('click', () => {
                document.querySelectorAll('.icon-option').forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
            });
        });
    },

    renderUser() {
        const name = this.currentUser ? this.currentUser.name : '';
        const initials = name ? name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) : '--';
        document.getElementById('userInitials').textContent = initials;
        document.getElementById('dropdownUserName').textContent = name;
    },

    render() {
        this.renderUser();
        this.applyPermissions();
        this.dashboard.render();
        this.tables.render();
        this.orders.render();
        this.menu.render();
        this.caisse.render();
        this.cuisine.render();
        this.rapports.render();
        this.personnel.render();
        this.stocks.render();
        this.pos.render();
        this.updateBadge();
    },

    // Permissions come from the server (login, /me and every sync); these aliases map pages onto them.
    PAGE_ALIASES: {
        'page.stocks': ['stock.view'],
        'page.personnel': ['staff.manage', 'audit.view', 'roles.manage']
    },
    HOME_BY_ROLE: { cuisinier: 'cuisine', stock: 'stocks', comptable: 'rapports' },

    can(perm) {
        const perms = (this.currentUser && this.currentUser.perms) || [];
        const alias = this.PAGE_ALIASES[perm];
        return alias ? alias.some(p => perms.includes(p)) : perms.includes(perm);
    },

    setPerms(perms) {
        if (!this.currentUser || !Array.isArray(perms)) return;
        const before = (this.currentUser.perms || []).slice().sort().join();
        if (before === perms.slice().sort().join()) return;
        this.currentUser.perms = perms;
        localStorage.setItem('sissiman-user', JSON.stringify(this.currentUser));
        this.render();
    },

    applyPermissions() {
        document.querySelectorAll('[data-perm]').forEach(el => {
            el.style.display = this.can(el.dataset.perm) ? '' : 'none';
        });
        const active = document.querySelector('.nav-item.active');
        if (this.currentUser && active && !this.can('page.' + active.dataset.page)) {
            const home = this.HOME_BY_ROLE[this.currentUser.role];
            const first = home && this.can('page.' + home)
                ? document.querySelector(`.nav-item[data-page="${home}"]`)
                : [...document.querySelectorAll('.nav-item')].find(n => this.can('page.' + n.dataset.page));
            if (first) this.navigateTo(first.dataset.page);
        }
    },

    updateBadge() {
        const active = this.data.orders.filter(o => o.status === 'en_cours' || o.status === 'prete').length;
        document.getElementById('activeOrdersBadge').textContent = `${active} commande${active !== 1 ? 's' : ''}`;
    },

    fmt(n) {
        return new Intl.NumberFormat('fr-FR').format(n) + ' FCFA';
    },

    genId() {
        return 'id_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    },

    todayOrders() {
        const today = new Date().toDateString();
        return this.data.orders.filter(o => new Date(o.createdAt).toDateString() === today);
    },

    // DASHBOARD
    dashboard: {
        tips: {},
        timer: null,
        KITCHEN_LATE_MIN: 20,
        BILL_LATE_MIN: 45,
        CASH_OPEN_MAX_H: 14,

        dayKey(d) {
            const x = new Date(d);
            return x.getFullYear() + '-' + (x.getMonth() + 1) + '-' + x.getDate();
        },

        // Revenue = value of orders taken (not cancelled); cash = money actually collected, net of refunds.
        stats(from, to) {
            const inRange = iso => { const t = new Date(iso).getTime(); return t >= from && t < to; };
            const orders = App.data.orders.filter(o => inRange(o.createdAt));
            const valid = orders.filter(o => o.status !== 'annulee');
            const cash = App.data.payments.filter(p => inRange(p.paidAt)).reduce((s, p) => s + p.amount, 0)
                - App.data.refunds.filter(r => inRange(r.at)).reduce((s, r) => s + r.amount, 0);
            return {
                revenue: valid.reduce((s, o) => s + o.total, 0),
                cash,
                count: valid.length,
                cancelled: orders.length - valid.length
            };
        },

        startOfDay(offsetDays = 0) {
            const d = new Date();
            d.setHours(0, 0, 0, 0);
            d.setDate(d.getDate() + offsetDays);
            return d.getTime();
        },

        compact(n) {
            const a = Math.abs(n);
            if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.0', '').replace('.', ',') + ' M';
            if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace('.0', '').replace('.', ',') + ' k';
            return String(n);
        },

        delta(now, before) {
            if (!before) return '';
            const pct = Math.round((now - before) / before * 100);
            const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
            const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '=';
            return `<span class="kpi-delta ${cls}">${arrow} ${pct > 0 ? '+' : ''}${pct} % <span>vs hier a la meme heure</span></span>`;
        },

        render() {
            const page = document.getElementById('page-dashboard');
            if (!page) return;
            const now = Date.now();
            const today = this.startOfDay(0);
            const t = this.stats(today, now + 1);
            const y = this.stats(this.startOfDay(-1), now - 86400000 + 1);

            document.getElementById('dashDate').textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

            const unpaid = App.data.orders.filter(o => ['en_cours', 'prete', 'servie'].includes(o.status) && App.balance(o).remaining > 0);
            const toCollect = unpaid.reduce((s, o) => s + App.balance(o).remaining, 0);
            const avg = t.count ? Math.round(t.revenue / t.count) : 0;
            const cashPct = t.revenue ? Math.round(t.cash / t.revenue * 100) : null;

            document.getElementById('dashKpis').innerHTML = `
                <div class="kpi kpi-hero">
                    <span class="kpi-label">Chiffre d'affaires</span>
                    <span class="kpi-value">${App.fmt(t.revenue)}</span>
                    ${this.delta(t.revenue, y.revenue)}
                    <span class="kpi-sub">Valeur des commandes prises (hors annulations)</span>
                </div>
                <div class="kpi">
                    <span class="kpi-label">Encaisse</span>
                    <span class="kpi-value">${App.fmt(t.cash)}</span>
                    ${this.delta(t.cash, y.cash)}
                    <span class="kpi-sub">${cashPct === null ? 'Argent recu, net des remboursements' : `${cashPct} % du chiffre d'affaires`}</span>
                </div>
                <div class="kpi">
                    <span class="kpi-label">Commandes</span>
                    <span class="kpi-value">${t.count}</span>
                    ${this.delta(t.count, y.count)}
                    <span class="kpi-sub">Panier moyen ${App.fmt(avg)}${t.cancelled ? ` · ${t.cancelled} annulee(s)` : ''}</span>
                </div>
                <div class="kpi">
                    <span class="kpi-label">Reste a encaisser</span>
                    <span class="kpi-value">${App.fmt(toCollect)}</span>
                    <span class="kpi-sub">${unpaid.length} commande(s) non soldee(s)</span>
                </div>`;

            this.renderActivity(unpaid);
            this.renderAlerts(now);
            this.renderRecent();

            if (!page.classList.contains('active')) return;
            this.tips = {};
            this.renderWeek();
            this.renderHours(today, now);
            this.renderTop(today, now);
            this.renderMethods(today, now);
            this.ensureTimer();
        },

        ensureTimer() {
            if (this.timer) return;
            // Waiting times in the alerts move with the clock, not only with data changes.
            this.timer = setInterval(() => {
                if (document.getElementById('page-dashboard').classList.contains('active') && App.currentUser) this.render();
            }, 60000);
            let resizeT;
            window.addEventListener('resize', () => {
                clearTimeout(resizeT);
                resizeT = setTimeout(() => {
                    if (document.getElementById('page-dashboard').classList.contains('active')) this.render();
                }, 200);
            });
            this.bindTips(document.getElementById('page-dashboard'));
        },

        bindTips(page) {
            const show = e => {
                const el = e.target.closest('[data-tip]');
                if (!el || !page.contains(el)) return;
                this.showTip(el, e.type === 'focusin');
            };
            page.addEventListener('pointermove', show);
            page.addEventListener('focusin', show);
            page.addEventListener('pointerleave', () => this.hideTip());
            page.addEventListener('pointerout', e => { if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('[data-tip]')) this.hideTip(); });
            page.addEventListener('focusout', () => this.hideTip());
        },

        renderActivity(unpaid) {
            const count = s => App.data.orders.filter(o => o.status === s).length;
            const servedUnpaid = unpaid.filter(o => o.status === 'servie').length;
            const occupied = App.data.tables.filter(t => ['commande', 'addition', 'occupee'].includes(App.tables.state(t))).length;
            const tile = (label, value, sub, page) => {
                const clickable = App.can('page.' + page);
                return `<${clickable ? 'button' : 'div'} class="activity-tile" ${clickable ? `onclick="App.navigateTo('${page}')"` : ''}>
                    <span class="activity-value">${value}</span>
                    <span class="activity-label">${label}</span>
                    <span class="activity-sub">${sub}</span>
                </${clickable ? 'button' : 'div'}>`;
            };
            document.getElementById('dashActivity').innerHTML =
                tile('En preparation', count('en_cours'), 'Commandes en cuisine', 'cuisine') +
                tile('Pretes a servir', count('prete'), 'En attente du serveur', 'cuisine') +
                tile('Servies non reglees', servedUnpaid, "Addition a encaisser", 'caisse') +
                tile('Tables occupees', `${occupied}<small> / ${App.data.tables.length}</small>`, 'Taux ' + (App.data.tables.length ? Math.round(occupied / App.data.tables.length * 100) : 0) + ' %', 'tables');
        },

        renderAlerts(now) {
            const alerts = [];
            const mins = iso => Math.floor((now - new Date(iso).getTime()) / 60000);
            const num = o => '#' + String(o.number).padStart(3, '0');
            const tableOf = o => { const t = App.data.tables.find(x => x.id === o.tableId); return t ? 'table ' + t.number : 'sans table'; };

            const late = App.data.orders.filter(o => o.status === 'en_cours' && mins(o.createdAt) >= this.KITCHEN_LATE_MIN)
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            if (late.length) alerts.push({
                level: 'critical', page: 'cuisine',
                title: `${late.length} commande(s) en cuisine depuis plus de ${this.KITCHEN_LATE_MIN} min`,
                detail: late.slice(0, 4).map(o => `${num(o)} ${tableOf(o)} · ${mins(o.createdAt)} min`).join(' — ')
            });

            const waiting = App.data.orders.filter(o => o.status === 'prete' && o.readyAt && mins(o.readyAt) >= 5);
            if (waiting.length) alerts.push({
                level: 'serious', page: 'cuisine',
                title: `${waiting.length} commande(s) prete(s) non servie(s) depuis plus de 5 min`,
                detail: waiting.slice(0, 4).map(o => `${num(o)} ${tableOf(o)} · ${mins(o.readyAt)} min`).join(' — ')
            });

            const bills = App.data.orders.filter(o => o.status === 'servie' && App.balance(o).remaining > 0 && mins(o.createdAt) >= this.BILL_LATE_MIN);
            if (bills.length) alerts.push({
                level: 'warning', page: 'caisse',
                title: `${bills.length} addition(s) servie(s) non reglee(s) depuis plus de ${this.BILL_LATE_MIN} min`,
                detail: bills.slice(0, 4).map(o => `${num(o)} ${tableOf(o)} · reste ${App.fmt(App.balance(o).remaining)}`).join(' — ')
            });

            const gaps = App.data.cashSessions.filter(s => s.status === 'fermee' && s.diff && now - new Date(s.closedAt).getTime() < 7 * 86400000)
                .sort((a, b) => b.closedAt.localeCompare(a.closedAt));
            if (gaps.length && App.can('cash.history')) alerts.push({
                level: gaps.some(s => s.diff < 0) ? 'critical' : 'serious', page: 'caisse',
                title: `${gaps.length} ecart(s) de caisse sur les 7 derniers jours`,
                detail: gaps.slice(0, 3).map(s => `${s.staffName} le ${new Date(s.closedAt).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} : ${s.diff > 0 ? '+' : ''}${App.fmt(s.diff)}`).join(' — ')
            });

            const stale = App.data.cashSessions.filter(s => s.status === 'ouverte' && now - new Date(s.openedAt).getTime() > this.CASH_OPEN_MAX_H * 3600000);
            if (stale.length) alerts.push({
                level: 'serious', page: 'caisse',
                title: `${stale.length} caisse(s) ouverte(s) depuis plus de ${this.CASH_OPEN_MAX_H} h`,
                detail: stale.map(s => `${s.staffName}, ouverte le ${new Date(s.openedAt).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`).join(' — ')
            });

            const lowStock = App.stocks.alerts();
            if (lowStock.length && App.can('page.stocks')) {
                const outCount = lowStock.filter(i => App.stocks.level(i) === 'rupture').length;
                alerts.push({
                    level: outCount ? 'critical' : 'warning', page: 'stocks',
                    title: outCount ? `${outCount} ingredient(s) en rupture, ${lowStock.length - outCount} en stock bas` : `${lowStock.length} ingredient(s) en stock bas`,
                    detail: lowStock.slice(0, 5).map(i => `${i.name} : ${App.stocks.qty(i.stock)} ${i.unit}`).join(' — ')
                });
            }

            const off = App.data.menuItems.filter(m => m.available === false);
            if (off.length) alerts.push({
                level: 'warning', page: 'menu',
                title: `${off.length} plat(s) indisponible(s)`,
                detail: off.slice(0, 6).map(m => m.name).join(', ') + (off.length > 6 ? '…' : '')
            });

            const icons = {
                critical: '<path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/>',
                serious: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/>',
                warning: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
                good: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>'
            };
            const labels = { critical: 'Urgent', serious: 'Important', warning: 'A surveiller', good: 'Tout va bien' };
            const el = document.getElementById('dashAlerts');
            if (!alerts.length) {
                el.innerHTML = `<div class="alert-row good"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${icons.good}</svg>
                    <div><span class="alert-level">${labels.good}</span><strong>Aucune alerte</strong><span class="alert-detail">Cuisine a l'heure, caisses justes, menu complet.</span></div></div>`;
                return;
            }
            el.innerHTML = alerts.map(a => {
                const clickable = App.can('page.' + a.page);
                return `<${clickable ? 'button' : 'div'} class="alert-row ${a.level}" ${clickable ? `onclick="App.navigateTo('${a.page}')"` : ''}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${icons[a.level]}</svg>
                    <div><span class="alert-level">${labels[a.level]}</span><strong>${App.esc(a.title)}</strong><span class="alert-detail">${App.esc(a.detail)}</span></div>
                </${clickable ? 'button' : 'div'}>`;
            }).join('');
        },

        renderRecent() {
            const recentEl = document.getElementById('recentOrders');
            const recent = App.todayOrders().slice(-6).reverse();
            if (recent.length === 0) {
                recentEl.innerHTML = '<p class="empty-state">Aucune commande aujourd\'hui</p>';
                return;
            }
            recentEl.innerHTML = recent.map(o => {
                const table = App.data.tables.find(t => t.id === o.tableId);
                const time = new Date(o.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
                return `<div class="recent-order-row">
                    <span class="time">${App.esc(time)}</span>
                    <span class="details">#${String(o.number).padStart(3, '0')} · Table ${table ? table.number : '?'} - ${o.items.length} article(s)</span>
                    <span class="order-status ${App.esc(o.status)}">${App.esc(o.status.replace('_', ' '))}</span>
                    <span class="amount">${App.fmt(o.total)}</span>
                </div>`;
            }).join('');
        },

        // ---- charts ----

        // Round tick step (1/2/5 × 10^n) so every gridline lands on a clean amount.
        niceScale(v) {
            const raw = Math.max(v, 1000) / 4;
            const p = Math.pow(10, Math.floor(Math.log10(raw)));
            const n = raw / p;
            const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
            const max = step * Math.max(1, Math.ceil(v / step));
            const ticks = [];
            for (let t = 0; t <= max + step / 2; t += step) ticks.push(t);
            return { max, ticks };
        },

        tipKey(title, rows) {
            const key = 't' + Object.keys(this.tips).length;
            this.tips[key] = { title, rows };
            return key;
        },

        // Rounded data-end, square at the baseline.
        barPath(x, y, w, h) {
            if (h <= 0) return '';
            const r = Math.min(4, w / 2, h);
            return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
        },

        columns(el, { groups, series, height = 210, highlightMax = false }) {
            const width = Math.max(260, el.clientWidth || 0);
            const m = { top: 18, right: 8, bottom: 26, left: 44 };
            const pw = width - m.left - m.right, ph = height - m.top - m.bottom;
            const labelEvery = Math.max(1, Math.ceil(groups.length * 48 / pw));
            const { max, ticks } = this.niceScale(Math.max(0, ...groups.flatMap(g => g.values)));
            const band = pw / groups.length;
            const barW = Math.max(3, Math.min(24, (band * 0.7 - 2 * (series.length - 1)) / series.length));
            const groupW = barW * series.length + 2 * (series.length - 1);
            const yOf = v => m.top + ph - (v / max) * ph;
            let svg = `<svg class="viz" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${App.esc(series.map(s => s.name).join(' et '))}">`;
            svg += ticks.map(v => `<line class="viz-grid${v === 0 ? ' base' : ''}" x1="${m.left}" x2="${width - m.right}" y1="${yOf(v)}" y2="${yOf(v)}"/>
                <text class="viz-axis" x="${m.left - 6}" y="${yOf(v) + 4}" text-anchor="end">${this.compact(v)}</text>`).join('');
            let maxInfo = null;
            groups.forEach((g, i) => {
                const gx = m.left + band * i + (band - groupW) / 2;
                g.values.forEach((v, si) => {
                    const h = (v / max) * ph;
                    svg += `<path class="viz-bar s${si + 1}" d="${this.barPath(gx + si * (barW + 2), yOf(v), barW, h)}"/>`;
                    if (highlightMax && (!maxInfo || v > maxInfo.v)) maxInfo = { v, x: gx + barW / 2, y: yOf(v) };
                });
                if (i % labelEvery === 0) {
                    svg += `<text class="viz-axis" x="${m.left + band * i + band / 2}" y="${height - 8}" text-anchor="middle">${App.esc(g.label)}</text>`;
                }
                const key = this.tipKey(g.title || g.label, series.map((s, si) => ({ name: s.name, value: App.fmt(g.values[si]), cls: 's' + (si + 1) })));
                svg += `<rect class="viz-hit" x="${m.left + band * i}" y="${m.top}" width="${band}" height="${ph}" data-tip="${key}" tabindex="0"
                    aria-label="${App.esc((g.title || g.label) + ' : ' + series.map((s, si) => s.name + ' ' + App.fmt(g.values[si])).join(', '))}"/>`;
            });
            if (maxInfo && maxInfo.v > 0) {
                svg += `<text class="viz-label" x="${maxInfo.x}" y="${maxInfo.y - 6}" text-anchor="middle">${this.compact(maxInfo.v)}</text>`;
            }
            return svg + '</svg>';
        },

        table(headers, rows) {
            return `<table class="data-table viz-table"><thead><tr>${headers.map(h => `<th>${App.esc(h)}</th>`).join('')}</tr></thead>
                <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${App.esc(String(c))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
        },

        fill(el, chartHtml, tableHtml) {
            const showTable = el.closest('.chart-card').classList.contains('show-table');
            el.innerHTML = `<div class="viz-chart"${showTable ? ' hidden' : ''}>${chartHtml}</div><div class="viz-table-wrap"${showTable ? '' : ' hidden'}>${tableHtml}</div>`;
        },

        toggleTable(btn) {
            const card = btn.closest('.chart-card');
            const on = card.classList.toggle('show-table');
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            btn.textContent = on ? 'Graphique' : 'Tableau';
            card.querySelector('.viz-chart').hidden = on;
            card.querySelector('.viz-table-wrap').hidden = !on;
        },

        renderWeek() {
            const el = document.getElementById('chartWeek');
            const groups = [];
            for (let i = 6; i >= 0; i--) {
                const from = this.startOfDay(-i), to = this.startOfDay(-i + 1);
                const s = this.stats(from, to);
                const d = new Date(from);
                groups.push({
                    label: i === 0 ? "Auj." : d.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '') + ' ' + d.getDate(),
                    title: d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }),
                    values: [s.revenue, s.cash]
                });
            }
            const series = [{ name: "Chiffre d'affaires" }, { name: 'Encaisse' }];
            document.getElementById('weekLegend').innerHTML = series.map((s, i) =>
                `<span class="legend-item"><span class="legend-swatch s${i + 1}"></span>${App.esc(s.name)}</span>`).join('');
            if (groups.every(g => g.values.every(v => v === 0))) {
                el.innerHTML = '<p class="empty-state">Aucune vente sur les 7 derniers jours</p>';
                return;
            }
            this.fill(el, this.columns(el, { groups, series }),
                this.table(['Jour', "Chiffre d'affaires", 'Encaisse'], groups.map(g => [g.title, App.fmt(g.values[0]), App.fmt(g.values[1])])));
        },

        renderHours(today, now) {
            const el = document.getElementById('chartHours');
            const orders = App.data.orders.filter(o => o.status !== 'annulee' && new Date(o.createdAt).getTime() >= today);
            if (!orders.length) {
                el.innerHTML = '<p class="empty-state">Aucune commande aujourd\'hui</p>';
                return;
            }
            const byHour = {};
            orders.forEach(o => { const h = new Date(o.createdAt).getHours(); byHour[h] = (byHour[h] || 0) + o.total; });
            const hours = Object.keys(byHour).map(Number);
            const first = Math.min(8, ...hours), last = Math.max(22, ...hours);
            const groups = [];
            for (let h = first; h <= last; h++) groups.push({ label: h + 'h', title: `${h}h – ${h + 1}h`, values: [byHour[h] || 0] });
            this.fill(el, this.columns(el, { groups, series: [{ name: "Chiffre d'affaires" }], highlightMax: true }),
                this.table(['Heure', "Chiffre d'affaires"], groups.filter(g => g.values[0]).map(g => [g.title, App.fmt(g.values[0])])));
        },

        hbars(rows) {
            const max = Math.max(1, ...rows.map(r => r.value));
            return `<div class="hbars">${rows.map(r => {
                const key = this.tipKey(r.label, r.tip);
                return `<div class="hbar-row" data-tip="${key}" tabindex="0" aria-label="${App.esc(r.label + ' : ' + r.display)}">
                    <span class="hbar-label">${App.esc(r.label)}</span>
                    <span class="hbar-track"><span class="hbar-fill" style="width:${Math.max(1.5, r.value / max * 100)}%"></span></span>
                    <span class="hbar-value">${App.esc(r.display)}</span>
                </div>`;
            }).join('')}</div>`;
        },

        renderTop(today, now) {
            const el = document.getElementById('chartTopToday');
            const agg = {};
            App.data.orders.filter(o => o.status !== 'annulee' && new Date(o.createdAt).getTime() >= today).forEach(o => o.items.forEach(it => {
                const a = agg[it.name] || (agg[it.name] = { qty: 0, amount: 0 });
                a.qty += it.qty;
                a.amount += App.lineTotal(it);
            }));
            const top = Object.entries(agg).sort((a, b) => b[1].qty - a[1].qty || b[1].amount - a[1].amount).slice(0, 6);
            if (!top.length) {
                el.innerHTML = '<p class="empty-state">Aucun plat vendu aujourd\'hui</p>';
                return;
            }
            this.fill(el, this.hbars(top.map(([name, a]) => ({
                label: name, value: a.qty, display: String(a.qty),
                tip: [{ name: 'Quantite', value: String(a.qty), cls: 's1' }, { name: "Chiffre d'affaires", value: App.fmt(a.amount) }]
            }))), this.table(['Plat', 'Quantite', "Chiffre d'affaires"], top.map(([n, a]) => [n, a.qty, App.fmt(a.amount)])));
        },

        renderMethods(today, now) {
            const el = document.getElementById('chartMethods');
            const by = { especes: 0, mobile: 0, carte: 0 };
            App.data.payments.filter(p => new Date(p.paidAt).getTime() >= today).forEach(p => { by[p.method] = (by[p.method] || 0) + p.amount; });
            App.data.refunds.filter(r => new Date(r.at).getTime() >= today).forEach(r => { by[r.method] = (by[r.method] || 0) - r.amount; });
            const total = Object.values(by).reduce((s, v) => s + v, 0);
            if (total <= 0) {
                el.innerHTML = '<p class="empty-state">Aucun encaissement aujourd\'hui</p>';
                return;
            }
            const rows = Object.entries(by).map(([m, v]) => ({
                label: App.methodLabel(m), value: Math.max(0, v),
                display: `${App.fmt(v)} · ${Math.round(v / total * 100)} %`,
                tip: [{ name: 'Montant net', value: App.fmt(v), cls: 's1' }, { name: 'Part', value: Math.round(v / total * 100) + ' %' }]
            }));
            this.fill(el, this.hbars(rows), this.table(['Moyen de paiement', 'Montant net', 'Part'], rows.map(r => [r.label, App.fmt(r.value), Math.round(r.value / total * 100) + ' %'])));
        },

        showTip(el, fromFocus) {
            const data = this.tips[el.dataset.tip];
            const tip = document.getElementById('vizTip');
            if (!data) return;
            el.classList.add('is-hover');
            if (this.hoverEl && this.hoverEl !== el) this.hoverEl.classList.remove('is-hover');
            this.hoverEl = el;
            tip.replaceChildren();
            const title = document.createElement('div');
            title.className = 'viz-tip-title';
            title.textContent = data.title;
            tip.appendChild(title);
            data.rows.forEach(r => {
                const row = document.createElement('div');
                row.className = 'viz-tip-row';
                const key = document.createElement('span');
                key.className = 'viz-tip-key ' + (r.cls || 'none');
                const value = document.createElement('strong');
                value.textContent = r.value;
                const name = document.createElement('span');
                name.textContent = r.name;
                row.append(key, value, name);
                tip.appendChild(row);
            });
            tip.hidden = false;
            const box = el.getBoundingClientRect();
            const tw = tip.offsetWidth, th = tip.offsetHeight;
            let x = box.left + box.width / 2 - tw / 2;
            x = Math.max(8, Math.min(window.innerWidth - tw - 8, x));
            let y = box.top - th - 8;
            if (y < 8) y = box.bottom + 8;
            tip.style.left = x + 'px';
            tip.style.top = y + 'px';
        },

        hideTip() {
            const tip = document.getElementById('vizTip');
            if (tip) tip.hidden = true;
            if (this.hoverEl) this.hoverEl.classList.remove('is-hover');
            this.hoverEl = null;
        }
    },

    // TABLES
    tables: {
        editingId: null,
        openId: null,
        transferFrom: null,
        editMode: false,
        drag: null,
        ACTIVE: ['en_cours', 'prete', 'servie'],
        STATES: {
            libre: { label: 'Disponible', short: 'Libre' },
            commande: { label: 'Commande en cours', short: 'En cours' },
            occupee: { label: 'Occupee, pas encore commande', short: 'Occupee' },
            addition: { label: 'Addition a regler', short: 'Addition' },
            reservee: { label: 'Reservee', short: 'Reservee' },
            indisponible: { label: 'Indisponible', short: 'Hors service' }
        },
        ZONES: { interieur: 'Interieur', terrasse: 'Terrasse', vip: 'VIP' },

        zoneKey(loc) {
            return String(loc || 'salle').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase() || 'salle';
        },

        zoneLabel(loc) {
            return this.ZONES[this.zoneKey(loc)] || String(loc || 'Salle');
        },

        activeOrders(tableId) {
            return App.data.orders.filter(o => o.tableId === tableId && this.ACTIVE.includes(o.status))
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        },

        // The colour comes from what is happening at the table (its orders), not only from the stored status.
        state(t) {
            if (t.status === 'indisponible') return 'indisponible';
            const orders = this.activeOrders(t.id);
            if (orders.some(o => o.status === 'en_cours' || o.status === 'prete')) return 'commande';
            if (orders.length) return 'addition';
            if (t.status === 'occupee') return 'occupee';
            if (t.status === 'reservee') return 'reservee';
            return 'libre';
        },

        render() {
            const counts = {};
            App.data.tables.forEach(t => { const s = this.state(t); counts[s] = (counts[s] || 0) + 1; });
            document.getElementById('floorLegend').innerHTML = Object.entries(this.STATES).map(([k, v]) =>
                `<span class="legend-state st-${k}"><i aria-hidden="true"></i>${v.label} <b>${counts[k] || 0}</b></span>`).join('');

            const floor = document.getElementById('tablesGrid');
            floor.classList.toggle('editing', this.editMode);
            if (App.data.tables.length === 0) {
                floor.innerHTML = '<p class="empty-state">Aucune table configuree. Ajoutez-en une !</p>';
                this.renderDrawer();
                return;
            }
            const zones = {};
            [...App.data.tables].sort((a, b) => a.number - b.number).forEach(t => {
                const k = this.zoneKey(t.location);
                (zones[k] = zones[k] || { label: this.zoneLabel(t.location), tables: [] }).tables.push(t);
            });
            const now = Date.now();
            floor.innerHTML = Object.values(zones).map(z => {
                const cols = 4;
                const rows = Math.max(1, Math.ceil(z.tables.length / cols));
                const height = Math.max(200, rows * 130);
                return `<section class="floor-zone">
                    <h3 class="floor-zone-title">${App.esc(z.label)} <span>${z.tables.length} table(s)</span></h3>
                    <div class="floor-area" style="height:${height}px" data-zone="${App.esc(this.zoneKey(z.tables[0].location))}">
                        ${z.tables.map((t, i) => this.tableHtml(t, i, cols, rows, now)).join('')}
                    </div>
                </section>`;
            }).join('');
            this.renderDrawer();
        },

        tableHtml(t, i, cols, rows, now) {
            const x = t.x != null ? t.x : (i % cols + 0.5) / cols * 100;
            const y = t.y != null ? t.y : (Math.floor(i / cols) + 0.5) / rows * 100;
            const st = this.state(t);
            const orders = this.activeOrders(t.id);
            const shape = t.seats <= 2 ? 'round' : t.seats <= 4 ? 'square' : 'long';
            const since = orders.length ? Math.floor((now - new Date(orders[0].createdAt).getTime()) / 60000) : null;
            const due = orders.reduce((s, o) => s + App.balance(o).remaining, 0);
            const label = `Table ${t.number}, ${t.seats} places, ${this.STATES[st].label}${since !== null ? `, depuis ${since} min` : ''}`;
            return `<button class="ftable ${shape} st-${st} ${this.openId === t.id ? 'selected' : ''} ${this.transferFrom && this.canReceive(t) ? 'target' : ''}"
                style="left:${x}%;top:${y}%" data-id="${t.id}" aria-label="${App.esc(label)}"
                onclick="App.tables.onTableClick('${t.id}')" onpointerdown="App.tables.dragStart(event, '${t.id}')">
                <span class="ftable-num">${t.number}</span>
                <span class="ftable-state">${this.STATES[st].short}</span>
                <span class="ftable-meta">${since !== null ? `${since} min${due ? ' · ' + App.dashboard.compact(due) : ''}` : `${t.seats} pl.`}</span>
            </button>`;
        },

        onTableClick(id) {
            if (this.editMode) return;
            if (this.transferFrom) {
                const t = App.data.tables.find(x => x.id === id);
                if (t && this.canReceive(t)) this.transfer(this.transferFrom, id);
                else App.toast('Choisissez une table libre (contour pointille)', 'error');
                return;
            }
            this.openDrawer(id);
        },

        openDrawer(id) {
            this.openId = id;
            this.transferFrom = null;
            this.render();
        },

        closeDrawer() {
            this.openId = null;
            this.transferFrom = null;
            this.render();
        },

        renderDrawer() {
            const drawer = document.getElementById('tableDrawer');
            const t = App.data.tables.find(x => x.id === this.openId);
            document.body.classList.toggle('table-drawer-open', !!t);
            if (!t) { drawer.hidden = true; this.openId = null; return; }
            drawer.hidden = false;
            const st = this.state(t);
            const orders = this.activeOrders(t.id);
            const now = Date.now();
            document.getElementById('drawerTitle').textContent = `Table ${t.number}`;
            const stateEl = document.getElementById('drawerState');
            stateEl.className = `drawer-state st-${st}`;
            stateEl.innerHTML = `<i aria-hidden="true"></i>${this.STATES[st].label}`;

            const opened = orders.length ? new Date(orders[0].createdAt) : null;
            const btn = (label, onclick, cls = 'btn-secondary') => `<button class="btn ${cls}" onclick="${onclick}">${label}</button>`;
            let html = `<div class="drawer-info">
                <div><span>Places</span><strong>${t.seats}</strong></div>
                <div><span>Zone</span><strong>${App.esc(this.zoneLabel(t.location))}</strong></div>
                ${opened ? `<div><span>Ouverte a</span><strong>${opened.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} · ${Math.floor((now - opened) / 60000)} min</strong></div>` : ''}
            </div>`;

            if (this.transferFrom) {
                const o = App.data.orders.find(x => x.id === this.transferFrom);
                const targets = App.data.tables.filter(x => this.canReceive(x)).sort((a, b) => a.number - b.number);
                html += `<div class="drawer-transfer">
                    <strong>Transferer la commande #${String(o.number).padStart(3, '0')}</strong>
                    <p>Touchez une table libre sur le plan ou choisissez-la ici :</p>
                    <div class="transfer-list">${targets.length ? targets.map(x => `<button class="pos-table" onclick="App.tables.transfer('${o.id}', '${x.id}')">T${x.number}<small>${x.seats} pl.</small></button>`).join('') : '<em>Aucune table libre</em>'}</div>
                    ${btn('Annuler le transfert', 'App.tables.cancelTransfer()')}
                </div>`;
            }

            html += orders.length ? orders.map(o => {
                const b = App.balance(o);
                return `<div class="drawer-order">
                    <div class="drawer-order-head">
                        <strong>#${String(o.number).padStart(3, '0')}</strong>
                        <span class="order-status ${App.esc(o.status)}">${App.esc(o.status.replace('_', ' '))}</span>
                    </div>
                    <ul>${o.items.map(it => `<li><span>${it.qty} x ${App.esc(it.name)}${App.itemDetailHtml(it)}</span><span>${App.fmt(App.lineTotal(it))}</span></li>`).join('')}</ul>
                    <div class="drawer-order-total">
                        <div><span>Total</span><strong>${App.fmt(o.total)}</strong></div>
                        <div><span>Paye</span><strong>${App.fmt(b.paid)}</strong></div>
                        <div class="rest"><span>Reste a payer</span><strong>${App.fmt(b.remaining)}</strong></div>
                    </div>
                    <div class="drawer-actions">
                        ${App.can('orders.create') ? btn('+ Ajouter des plats', `App.pos.open('${t.id}', '${o.id}')`, 'btn-primary') : ''}
                        ${App.can('page.caisse') && b.remaining > 0 ? btn('Encaisser', `App.tables.goPay('${o.id}')`) : ''}
                        ${btn("Imprimer l'addition", `App.tickets.bill('${o.id}')`)}
                        ${App.can('orders.transfer') && !this.transferFrom ? btn('Transferer', `App.tables.startTransfer('${o.id}')`) : ''}
                    </div>
                </div>`;
            }).join('') : `<p class="drawer-empty">Aucune commande en cours sur cette table.</p>
                ${App.can('orders.create') && st !== 'indisponible' ? `<div class="drawer-actions">${btn('Prendre la commande', `App.pos.open('${t.id}')`, 'btn-primary')}</div>` : ''}`;

            const statusBtns = [];
            if (!orders.length && App.can('tables.status')) {
                if (st === 'libre' || st === 'reservee') statusBtns.push(btn('Installer des clients', `App.tables.setStatus('${t.id}','occupee')`));
                if (st === 'libre') statusBtns.push(btn('Reserver', `App.tables.setStatus('${t.id}','reservee')`));
                if (st === 'occupee' || st === 'reservee') statusBtns.push(btn('Liberer la table', `App.tables.setStatus('${t.id}','libre')`));
                if (App.can('tables.manage')) {
                    statusBtns.push(st === 'indisponible'
                        ? btn('Remettre en service', `App.tables.setStatus('${t.id}','libre')`)
                        : btn('Rendre indisponible', `App.tables.setStatus('${t.id}','indisponible')`));
                }
            }
            if (App.can('tables.manage')) {
                statusBtns.push(btn('Modifier', `App.tables.edit('${t.id}')`));
                if (!orders.length) statusBtns.push(btn('Supprimer', `App.tables.remove('${t.id}')`, 'btn-danger'));
            }
            if (statusBtns.length) html += `<div class="drawer-section"><div class="drawer-section-title">Table</div><div class="drawer-actions">${statusBtns.join('')}</div></div>`;
            document.getElementById('drawerBody').innerHTML = html;
        },

        goPay(orderId) {
            this.closeDrawer();
            App.navigateTo('caisse');
            App.caisse.selectOrder(orderId);
        },

        canReceive(t) {
            const st = this.state(t);
            return st === 'libre' || st === 'reservee' || st === 'occupee';
        },

        startTransfer(orderId) {
            this.transferFrom = orderId;
            this.render();
        },

        cancelTransfer() {
            this.transferFrom = null;
            this.render();
        },

        transfer(orderId, destId) {
            const o = App.data.orders.find(x => x.id === orderId);
            const dest = App.data.tables.find(x => x.id === destId);
            if (!o || !dest || !this.ACTIVE.includes(o.status)) return;
            if (!this.canReceive(dest)) { App.toast(`La table ${dest.number} n'est pas libre`, 'error'); return; }
            const src = App.data.tables.find(x => x.id === o.tableId);
            o.tableId = destId;
            dest.status = 'occupee';
            if (src && !this.activeOrders(src.id).length) src.status = 'libre';
            this.transferFrom = null;
            this.openId = destId;
            App.saveData();
            App.render();
            App.toast(`Commande #${String(o.number).padStart(3, '0')} transferee${src ? ` de la table ${src.number}` : ''} vers la table ${dest.number}`);
        },

        setStatus(id, status) {
            const t = App.data.tables.find(x => x.id === id);
            if (!t) return;
            if (status !== 'occupee' && status !== 'reservee' && this.activeOrders(id).length) {
                App.toast('Cette table a une commande en cours', 'error');
                return;
            }
            t.status = status;
            App.saveData();
            App.render();
        },

        // ---- edition du plan (gerant) ----

        toggleEdit() {
            this.editMode = !this.editMode;
            this.transferFrom = null;
            if (this.editMode) this.openId = null;
            document.getElementById('floorEditBtn').textContent = this.editMode ? 'Terminer' : 'Modifier le plan';
            document.getElementById('floorEditHint').hidden = !this.editMode;
            this.render();
        },

        dragStart(e, id) {
            if (!this.editMode) return;
            const el = e.currentTarget;
            const area = el.closest('.floor-area');
            e.preventDefault();
            el.setPointerCapture(e.pointerId);
            el.classList.add('dragging');
            this.drag = { id, el, area };
            const move = ev => {
                const r = area.getBoundingClientRect();
                const x = Math.max(4, Math.min(96, (ev.clientX - r.left) / r.width * 100));
                const y = Math.max(8, Math.min(92, (ev.clientY - r.top) / r.height * 100));
                el.style.left = x + '%';
                el.style.top = y + '%';
                this.drag.x = x;
                this.drag.y = y;
            };
            const up = () => {
                el.removeEventListener('pointermove', move);
                el.removeEventListener('pointerup', up);
                el.removeEventListener('pointercancel', up);
                el.classList.remove('dragging');
                const t = App.data.tables.find(x => x.id === id);
                if (t && this.drag.x != null) {
                    t.x = Math.round(this.drag.x * 10) / 10;
                    t.y = Math.round(this.drag.y * 10) / 10;
                    App.saveData();
                }
                this.drag = null;
            };
            el.addEventListener('pointermove', move);
            el.addEventListener('pointerup', up);
            el.addEventListener('pointercancel', up);
        },

        openAddModal() {
            this.editingId = null;
            document.getElementById('modalTableTitle').textContent = 'Ajouter une table';
            const next = App.data.tables.reduce((m, t) => Math.max(m, t.number), 0) + 1;
            document.getElementById('tableNumber').value = next;
            document.getElementById('tableSeats').value = 4;
            document.getElementById('tableLocation').value = 'Interieur';
            this.fillZones();
            document.getElementById('modalTable').classList.add('open');
        },

        fillZones() {
            const labels = new Set(Object.values(this.ZONES));
            App.data.tables.forEach(t => labels.add(this.zoneLabel(t.location)));
            document.getElementById('tableZones').innerHTML = [...labels].map(l => `<option value="${App.esc(l)}">`).join('');
        },

        edit(id) {
            const t = App.data.tables.find(x => x.id === id);
            if (!t) return;
            this.editingId = id;
            document.getElementById('modalTableTitle').textContent = 'Modifier la table';
            document.getElementById('tableNumber').value = t.number;
            document.getElementById('tableSeats').value = t.seats;
            document.getElementById('tableLocation').value = this.zoneLabel(t.location);
            this.fillZones();
            document.getElementById('modalTable').classList.add('open');
        },

        closeModal() {
            document.getElementById('modalTable').classList.remove('open');
        },

        save() {
            const number = parseInt(document.getElementById('tableNumber').value, 10);
            const seats = parseInt(document.getElementById('tableSeats').value, 10);
            const label = document.getElementById('tableLocation').value.trim() || 'Interieur';
            if (!number || !seats) { App.toast('Remplissez tous les champs', 'error'); return; }
            // Keep the historical keys (interieur, terrasse, vip) so existing tables stay in the same zone.
            const key = this.zoneKey(label);
            const location = this.ZONES[key] ? key : label.slice(0, 30);

            const duplicate = App.data.tables.find(t => t.number === number && t.id !== this.editingId);
            if (duplicate) { App.toast(`La table ${number} existe deja`, 'error'); return; }

            if (this.editingId) {
                const t = App.data.tables.find(x => x.id === this.editingId);
                if (t) {
                    if (this.zoneKey(t.location) !== key) { delete t.x; delete t.y; }
                    t.number = number; t.seats = seats; t.location = location;
                }
                App.toast('Table modifiee');
            } else {
                App.data.tables.push({ id: App.genId(), number, seats, location, status: 'libre' });
                App.toast('Table ajoutee');
            }
            App.saveData();
            this.closeModal();
            App.render();
        },

        remove(id) {
            if (this.activeOrders(id).length) { App.toast('Impossible : cette table a des commandes actives', 'error'); return; }
            if (!confirm('Supprimer cette table ?')) return;
            App.data.tables = App.data.tables.filter(t => t.id !== id);
            if (this.openId === id) this.openId = null;
            App.saveData();
            App.toast('Table supprimee');
            App.render();
        }
    },

    // ORDERS
    orders: {
        currentFilter: 'all',
        currentItems: [],
        searchQuery: '',

        render() {
            const list = document.getElementById('ordersList');
            let orders = App.todayOrders();
            if (this.currentFilter !== 'all') {
                orders = orders.filter(o => o.status === this.currentFilter);
            }
            orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

            if (orders.length === 0) {
                list.innerHTML = '<p class="empty-state">Aucune commande</p>';
                return;
            }

            list.innerHTML = orders.map(o => {
                const table = App.data.tables.find(t => t.id === o.tableId);
                const time = new Date(o.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
                const itemsText = o.items.map(it => `${it.qty}x ${App.esc(it.name)}${App.itemDetails(it).length ? ` <small>(${App.esc(App.itemDetails(it).join(', '))})</small>` : ''}`).join(', ');
                return `<div class="order-card">
                    <span class="order-id">#${String(o.number).padStart(3, '0')}</span>
                    <span class="order-table-badge">T${table ? table.number : '?'}</span>
                    <span class="order-details">${App.esc(time)} - ${itemsText}</span>
                    <span class="order-amount">${App.fmt(o.total)}</span>
                    <span class="order-status ${App.esc(o.status)}">${App.esc(o.status.replace('_', ' '))}</span>
                    <div class="order-actions">
                        ${['en_cours', 'prete', 'servie'].includes(o.status) && App.can('orders.create') ? `<button class="btn btn-small btn-secondary" onclick="App.pos.open('${o.tableId}', '${o.id}')">+ Ajouter</button>` : ''}
                        ${o.status === 'en_cours' && App.can('orders.ready') ? `<button class="btn btn-small btn-warning" onclick="App.orders.updateStatus('${o.id}','prete')">Prete</button>` : ''}
                        ${o.status === 'prete' && App.can('orders.serve') ? `<button class="btn btn-small btn-success" onclick="App.orders.updateStatus('${o.id}','servie')">Servir</button>` : ''}
                        ${o.status !== 'payee' && o.status !== 'annulee' && App.can('orders.cancel') ? `<button class="btn btn-small btn-danger" onclick="App.orders.updateStatus('${o.id}','annulee')">Annuler</button>` : ''}
                    </div>
                </div>`;
            }).join('');
        },

        filter(status) {
            this.currentFilter = status;
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === status));
            this.render();
        },

        updateStatus(id, status) {
            const o = App.data.orders.find(x => x.id === id);
            if (!o) return;
            o.status = status;
            if (status === 'annulee' || status === 'payee') {
                const table = App.data.tables.find(t => t.id === o.tableId);
                const hasOtherActive = App.data.orders.some(x => x.id !== id && x.tableId === o.tableId && (x.status === 'en_cours' || x.status === 'prete' || x.status === 'servie'));
                if (table && !hasOtherActive) table.status = 'libre';
            }
            App.saveData();
            App.render();
        },

        openNewOrder() {
            App.pos.open();
        }
    },

    pos: {
        tableId: null,
        takeaway: false,
        targetOrderId: null,
        forceNew: false,
        lines: [],
        covers: 1,
        cat: 'all',
        query: '',
        pendingId: null,
        pendingNumber: null,
        sending: false,
        opt: null,
        ACTIVE: ['en_cours', 'prete', 'servie'],

        open(tableId, orderId) {
            if (!App.can('orders.create')) return;
            this.lines = [];
            this.covers = 1;
            this.cat = 'all';
            this.query = '';
            this.forceNew = false;
            this.takeaway = false;
            this.targetOrderId = orderId || null;
            this.pendingId = App.genId();
            this.pendingNumber = null;
            this.tableId = tableId || null;
            if (orderId) {
                const o = App.data.orders.find(x => x.id === orderId);
                if (o && !o.tableId) this.takeaway = true;
            }
            const existing = this.target();
            if (existing) this.covers = existing.covers || 1;
            document.getElementById('posNote').value = '';
            document.getElementById('posSearch').value = '';
            let print = false;
            try { print = localStorage.getItem('sissiman-print-kitchen') === '1'; } catch (e) { /* stockage indisponible */ }
            document.getElementById('posPrintKitchen').checked = print;
            document.getElementById('pos').hidden = false;
            document.body.classList.add('pos-open');
            this.render();
        },

        close(force) {
            if (!force && this.lines.length && !confirm('Abandonner cette commande ? Les articles du panier seront perdus.')) return;
            document.getElementById('pos').hidden = true;
            document.body.classList.remove('pos-open');
            this.toggleCart(false);
            this.closeOptions();
        },

        isOpen() {
            return !document.getElementById('pos').hidden;
        },

        openOrderFor(tableId) {
            return App.data.orders
                .filter(o => o.tableId === tableId && this.ACTIVE.includes(o.status))
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
        },

        target() {
            if (this.forceNew) return null;
            if (this.targetOrderId) {
                const o = App.data.orders.find(x => x.id === this.targetOrderId);
                return o && this.ACTIVE.includes(o.status) ? o : null;
            }
            return this.tableId ? this.openOrderFor(this.tableId) : null;
        },

        render() {
            if (!this.isOpen()) return;
            this.renderTables();
            this.renderCats();
            this.renderGrid();
            this.renderCart();
        },

        renderTables() {
            const chip = (id, label, cls, badge, selected) => `<button class="pos-table ${cls} ${selected ? 'selected' : ''}" role="option" aria-selected="${selected}"
                onclick="App.pos.selectTable(${id === null ? 'null' : `'${id}'`})">${label}${badge ? `<small>${badge}</small>` : ''}</button>`;
            const tables = [...App.data.tables].filter(t => t.status !== 'indisponible').sort((a, b) => a.number - b.number);
            document.getElementById('posTables').innerHTML =
                chip(null, 'A emporter', 'takeaway', '', this.takeaway) +
                tables.map(t => {
                    const o = this.openOrderFor(t.id);
                    return chip(t.id, 'T' + t.number, 'st-' + App.tables.state(t), o ? '#' + String(o.number).padStart(3, '0') : '', !this.takeaway && this.tableId === t.id);
                }).join('');

            const target = this.target();
            const table = App.data.tables.find(t => t.id === this.tableId);
            const where = this.takeaway ? 'A emporter' : table ? `Table ${table.number} · ${table.seats} places` : 'Choisissez une table';
            document.getElementById('posTitle').textContent = target
                ? `Ajout a la commande #${String(target.number).padStart(3, '0')}` : 'Nouvelle commande';
            document.getElementById('posSubtitle').textContent = target ? `${where} · deja ${App.fmt(target.total)}` : where;
        },

        selectTable(id) {
            this.takeaway = id === null;
            this.tableId = id;
            this.targetOrderId = null;
            this.forceNew = false;
            const o = this.target();
            if (o) this.covers = o.covers || 1;
            this.render();
        },

        renderCats() {
            const cats = [{ id: 'all', name: 'Tout', icon: '' }, ...App.data.categories];
            document.getElementById('posCats').innerHTML = cats.map(c =>
                `<button class="pos-cat ${this.cat === c.id ? 'active' : ''}" onclick="App.pos.setCat('${c.id}')">${App.esc(c.icon || '')} ${App.esc(c.name)}</button>`).join('');
        },

        setCat(id) {
            this.cat = id;
            this.renderCats();
            this.renderGrid();
        },

        search(q) {
            this.query = q.trim().toLowerCase();
            this.renderGrid();
        },

        hasOptions(m) {
            const o = m.options || {};
            return !!((o.sides && o.sides.length) || (o.extras && o.extras.length) || (o.prefs && o.prefs.length));
        },

        renderGrid() {
            let items = this.cat === 'all' ? App.data.menuItems : App.data.menuItems.filter(m => m.category === this.cat);
            if (this.query) items = items.filter(m => m.name.toLowerCase().includes(this.query));
            items = [...items].sort((a, b) => (b.available !== false) - (a.available !== false));
            const grid = document.getElementById('posGrid');
            if (!items.length) {
                grid.innerHTML = '<p class="empty-state">Aucun plat ne correspond</p>';
                return;
            }
            grid.innerHTML = items.map(m => {
                const off = m.available === false;
                const inCart = this.lines.filter(l => l.menuId === m.id).reduce((s, l) => s + l.qty, 0);
                const cat = App.data.categories.find(c => c.id === m.category);
                return `<button class="pos-item ${off ? 'off' : ''}" onclick="App.pos.tap('${m.id}')" ${off ? 'disabled aria-disabled="true"' : ''}
                    aria-label="${App.esc(m.name)}, ${App.fmt(m.price)}${off ? ', indisponible' : ''}">
                    <span class="pos-item-img">${m.photo ? `<img src="${m.photo}" alt="" loading="lazy">` : `<span>${App.esc(cat ? cat.icon : '🍽️')}</span>`}</span>
                    ${inCart ? `<span class="pos-item-count">${inCart}</span>` : ''}
                    <span class="pos-item-name">${App.esc(m.name)}</span>
                    <span class="pos-item-meta">
                        <strong>${App.fmt(m.price)}</strong>
                        ${off ? '<em class="pos-off">Indisponible</em>' : this.hasOptions(m) ? '<em>Options</em>' : ''}
                    </span>
                </button>`;
            }).join('');
        },

        tap(menuId) {
            const m = App.data.menuItems.find(x => x.id === menuId);
            if (!m || m.available === false) return;
            if (this.hasOptions(m)) this.openOptions(menuId);
            else this.addLine({ menuId, qty: 1 });
        },

        buildLine(cfg) {
            const m = App.data.menuItems.find(x => x.id === cfg.menuId);
            const line = { lineId: cfg.lineId || App.genId(), menuId: m.id, name: m.name, price: m.price, qty: cfg.qty };
            if (cfg.side) line.side = cfg.side;
            if (cfg.extras && cfg.extras.length) line.extras = cfg.extras.map(e => ({ name: e.name, price: e.price }));
            if (cfg.prefs && cfg.prefs.length) line.prefs = [...cfg.prefs];
            if (cfg.comment) line.comment = cfg.comment;
            line.unitPrice = m.price + (line.extras || []).reduce((s, e) => s + e.price, 0);
            return line;
        },

        sameConfig(a, b) {
            const key = l => JSON.stringify([l.menuId, l.side || '', (l.extras || []).map(e => e.name), l.prefs || [], l.comment || '']);
            return key(a) === key(b);
        },

        addLine(cfg) {
            const line = this.buildLine(cfg);
            const same = this.lines.find(l => this.sameConfig(l, line));
            if (same) same.qty += line.qty; else this.lines.push(line);
            this.renderCart();
            this.renderGrid();
            const bar = document.getElementById('posCartBar');
            bar.classList.remove('bump');
            void bar.offsetWidth;
            bar.classList.add('bump');
        },

        changeQty(lineId, d) {
            const l = this.lines.find(x => x.lineId === lineId);
            if (!l) return;
            l.qty = Math.min(999, l.qty + d);
            if (l.qty <= 0) this.lines = this.lines.filter(x => x !== l);
            this.renderCart();
            this.renderGrid();
        },

        removeLine(lineId) {
            this.lines = this.lines.filter(x => x.lineId !== lineId);
            this.renderCart();
            this.renderGrid();
        },

        setCovers(d) {
            this.covers = Math.max(1, Math.min(99, this.covers + d));
            document.getElementById('posCovers').textContent = this.covers;
        },

        newTotal() {
            return this.lines.reduce((s, l) => s + l.unitPrice * l.qty, 0);
        },

        renderCart() {
            const target = this.target();
            document.getElementById('posCovers').textContent = this.covers;
            document.querySelector('.pos-covers').style.display = target ? 'none' : '';
            const ex = document.getElementById('posExisting');
            if (target) {
                ex.innerHTML = `<div class="pos-existing-head">
                        <span>Deja envoye · #${String(target.number).padStart(3, '0')}</span>
                        <button class="link-btn" onclick="App.pos.setForceNew(true)">Commande separee</button>
                    </div>
                    ${target.items.map(it => `<div class="pos-existing-row"><span>${it.qty} x ${App.esc(it.name)}</span><span>${App.fmt(App.lineTotal(it))}</span></div>`).join('')}`;
            } else if (this.forceNew && (this.takeaway ? false : this.openOrderFor(this.tableId))) {
                ex.innerHTML = `<div class="pos-existing-head"><span>Nouvelle commande separee</span>
                    <button class="link-btn" onclick="App.pos.setForceNew(false)">Ajouter plutot a la commande en cours</button></div>`;
            } else {
                ex.innerHTML = '';
            }

            const list = document.getElementById('posLines');
            list.innerHTML = this.lines.length === 0
                ? '<p class="empty-state pos-empty">Touchez un plat pour l\'ajouter</p>'
                : this.lines.map(l => {
                    const m = App.data.menuItems.find(x => x.id === l.menuId);
                    return `<div class="pos-line">
                        <div class="pos-qty">
                            <button onclick="App.pos.changeQty('${l.lineId}', -1)" aria-label="Retirer un ${App.esc(l.name)}">−</button>
                            <span>${l.qty}</span>
                            <button onclick="App.pos.changeQty('${l.lineId}', 1)" aria-label="Ajouter un ${App.esc(l.name)}">+</button>
                        </div>
                        <div class="pos-line-main">
                            <span class="pos-line-name">${App.esc(l.name)}</span>
                            ${App.itemDetailHtml(l)}
                            <button class="link-btn" onclick="App.pos.openOptions('${l.menuId}', '${l.lineId}')">${m && this.hasOptions(m) ? 'Options / commentaire' : 'Commentaire'}</button>
                        </div>
                        <div class="pos-line-end">
                            <strong>${App.fmt(l.unitPrice * l.qty)}</strong>
                            <button class="pos-line-remove" onclick="App.pos.removeLine('${l.lineId}')" aria-label="Supprimer ${App.esc(l.name)}">&times;</button>
                        </div>
                    </div>`;
                }).join('');

            const total = this.newTotal();
            document.getElementById('posTotal').innerHTML = target
                ? `${App.fmt(total)}<small>Nouveau total commande : ${App.fmt(target.total + total)}</small>` : App.fmt(total);
            const count = this.lines.reduce((s, l) => s + l.qty, 0);
            document.getElementById('posCartBarCount').textContent = count ? `${count} article(s) · Voir le panier` : 'Panier vide';
            document.getElementById('posCartBarTotal').textContent = App.fmt(total);
            this.updateSend();
        },

        updateSend() {
            const btn = document.getElementById('posSend');
            const target = this.target();
            const total = this.newTotal();
            const noPlace = !this.takeaway && !this.tableId;
            btn.disabled = this.sending || !this.lines.length || noPlace;
            btn.textContent = this.sending ? 'Envoi...'
                : noPlace ? 'Choisissez une table'
                : !this.lines.length ? 'Panier vide'
                : target ? `Ajouter a #${String(target.number).padStart(3, '0')} · ${App.fmt(total)}`
                : `Envoyer en cuisine · ${App.fmt(total)}`;
        },

        setForceNew(v) {
            this.forceNew = v;
            this.targetOrderId = null;
            this.render();
        },

        toggleCart(show) {
            document.getElementById('pos').classList.toggle('cart-open', !!show);
        },

        rememberPrint(v) {
            try { localStorage.setItem('sissiman-print-kitchen', v ? '1' : '0'); } catch (e) { /* stockage indisponible */ }
        },

        // ---- options ----

        openOptions(menuId, lineId) {
            const m = App.data.menuItems.find(x => x.id === menuId);
            if (!m) return;
            const line = lineId ? this.lines.find(l => l.lineId === lineId) : null;
            const o = m.options || {};
            this.opt = {
                menuId, lineId: line ? line.lineId : null,
                side: line ? line.side || null : (o.sides && o.sides[0]) || null,
                extras: new Set(line && line.extras ? line.extras.map(e => e.name) : []),
                prefs: new Set(line && line.prefs ? line.prefs : []),
                comment: line ? line.comment || '' : '',
                qty: line ? line.qty : 1
            };
            const group = (title, html) => html ? `<div class="opt-group"><div class="opt-title">${title}</div><div class="opt-chips">${html}</div></div>` : '';
            document.getElementById('optTitle').textContent = m.name;
            document.getElementById('optBody').innerHTML =
                group('Accompagnement', (o.sides || []).map((s, i) =>
                    `<button class="opt-chip ${this.opt.side === s ? 'on' : ''}" data-kind="side" data-i="${i}" aria-pressed="${this.opt.side === s}" onclick="App.pos.toggleOpt(this)">${App.esc(s)}</button>`).join('')) +
                group('Supplements', (o.extras || []).map((e, i) =>
                    `<button class="opt-chip ${this.opt.extras.has(e.name) ? 'on' : ''}" data-kind="extra" data-i="${i}" aria-pressed="${this.opt.extras.has(e.name)}" onclick="App.pos.toggleOpt(this)">${App.esc(e.name)} <small>+${App.fmt(e.price)}</small></button>`).join('')) +
                group('Preparation', (o.prefs || []).map((p, i) =>
                    `<button class="opt-chip ${this.opt.prefs.has(p) ? 'on' : ''}" data-kind="pref" data-i="${i}" aria-pressed="${this.opt.prefs.has(p)}" onclick="App.pos.toggleOpt(this)">${App.esc(p)}</button>`).join('')) +
                `<div class="form-group opt-comment"><label>Commentaire pour la cuisine</label>
                    <input type="text" id="optComment" maxlength="120" placeholder="Ex: sauce a part" value="${App.esc(this.opt.comment)}" oninput="App.pos.opt.comment = this.value"></div>`;
            this.updateOptFooter();
            document.getElementById('modalItemOptions').classList.add('open');
        },

        toggleOpt(btn) {
            const m = App.data.menuItems.find(x => x.id === this.opt.menuId);
            const o = m.options || {};
            const i = parseInt(btn.dataset.i, 10);
            if (btn.dataset.kind === 'side') {
                const v = o.sides[i];
                this.opt.side = this.opt.side === v ? null : v;
                btn.parentElement.querySelectorAll('.opt-chip').forEach(b => {
                    const on = b === btn && this.opt.side === v;
                    b.classList.toggle('on', on);
                    b.setAttribute('aria-pressed', on);
                });
            } else {
                const set = btn.dataset.kind === 'extra' ? this.opt.extras : this.opt.prefs;
                const v = btn.dataset.kind === 'extra' ? o.extras[i].name : o.prefs[i];
                if (set.has(v)) set.delete(v); else set.add(v);
                btn.classList.toggle('on', set.has(v));
                btn.setAttribute('aria-pressed', set.has(v));
            }
            this.updateOptFooter();
        },

        optQty(d) {
            this.opt.qty = Math.max(1, Math.min(999, this.opt.qty + d));
            this.updateOptFooter();
        },

        optLine() {
            const m = App.data.menuItems.find(x => x.id === this.opt.menuId);
            const extras = ((m.options || {}).extras || []).filter(e => this.opt.extras.has(e.name));
            const prefs = ((m.options || {}).prefs || []).filter(p => this.opt.prefs.has(p));
            return this.buildLine({
                lineId: this.opt.lineId, menuId: m.id, qty: this.opt.qty, side: this.opt.side,
                extras, prefs, comment: (this.opt.comment || '').trim()
            });
        },

        updateOptFooter() {
            document.getElementById('optQty').textContent = this.opt.qty;
            const line = this.optLine();
            document.getElementById('optAdd').textContent = `${this.opt.lineId ? 'Mettre a jour' : 'Ajouter'} · ${App.fmt(line.unitPrice * line.qty)}`;
        },

        confirmOptions() {
            const line = this.optLine();
            if (this.opt.lineId) {
                const idx = this.lines.findIndex(l => l.lineId === this.opt.lineId);
                if (idx >= 0) this.lines[idx] = line;
                this.renderCart();
                this.renderGrid();
            } else {
                this.addLine({ ...line });
            }
            this.closeOptions();
        },

        closeOptions() {
            document.getElementById('modalItemOptions').classList.remove('open');
        },

        // ---- envoi ----

        async send() {
            if (this.sending || !this.lines.length) return;
            if (!this.takeaway && !this.tableId) { App.toast('Choisissez une table ou « A emporter »', 'error'); return; }
            const target = this.target();
            const note = document.getElementById('posNote').value.trim();
            const lines = this.lines.map(l => {
                const copy = { ...l };
                delete copy.lineId;
                return copy;
            });
            const total = this.newTotal();
            this.sending = true;
            this.updateSend();
            try {
                if (target) {
                    const addedAt = new Date().toISOString();
                    target.items = [...target.items, ...lines.map(l => ({ ...l, addedAt }))];
                    target.total += total;
                    target.status = 'en_cours';
                    if (note) target.note = target.note ? `${target.note} | ${note}` : note;
                    App.saveData();
                    App.toast(`Ajoute a la commande #${String(target.number).padStart(3, '0')}`);
                    if (document.getElementById('posPrintKitchen').checked) App.tickets.kitchen(target.id, addedAt);
                } else {
                    if (App.data.orders.some(o => o.id === this.pendingId)) { this.close(true); return; }
                    if (!this.pendingNumber) {
                        const maxLocal = App.data.orders.reduce((m, o) => Math.max(m, o.number || 0), 0);
                        // Kept across retries so a re-click after a network error reuses the same number and id.
                        this.pendingNumber = (await App.api('/orders/next-number', { method: 'POST', body: { min: maxLocal + 1 } })).number;
                    }
                    const order = {
                        id: this.pendingId, number: this.pendingNumber, tableId: this.takeaway ? '' : this.tableId,
                        covers: this.covers, items: lines, total, note, status: 'en_cours', createdAt: new Date().toISOString()
                    };
                    App.data.orders.push(order);
                    const table = App.data.tables.find(t => t.id === order.tableId);
                    if (table) table.status = 'occupee';
                    App.saveData();
                    App.toast(`Commande #${String(order.number).padStart(3, '0')} envoyee en cuisine`);
                    if (document.getElementById('posPrintKitchen').checked) App.tickets.kitchen(order.id);
                }
                this.lines = [];
                this.close(true);
                App.render();
            } catch (e) {
                App.toast(e.status ? e.message : 'Connexion impossible : commande NON envoyee, reessayez', 'error');
            } finally {
                this.sending = false;
                this.updateSend();
            }
        }
    },

    // MENU
    menu: {
        editingItemId: null,
        selectedCat: 'all',
        photo: null,

        render() {
            const sidebar = document.getElementById('menuCatsSidebar');
            sidebar.innerHTML = `<div class="menu-cat-item ${this.selectedCat === 'all' ? 'active' : ''}" onclick="App.menu.selectCat('all')">
                <span class="cat-icon">📋</span> Tous
                <span class="cat-count">${App.data.menuItems.length}</span>
            </div>` + App.data.categories.map(c => {
                const count = App.data.menuItems.filter(m => m.category === c.id).length;
                return `<div class="menu-cat-item ${this.selectedCat === c.id ? 'active' : ''}" onclick="App.menu.selectCat('${c.id}')">
                    <span class="cat-icon">${App.esc(c.icon)}</span> ${App.esc(c.name)}
                    <span class="cat-count">${count}</span>
                </div>`;
            }).join('');

            const items = this.selectedCat === 'all' ? App.data.menuItems : App.data.menuItems.filter(m => m.category === this.selectedCat);
            const list = document.getElementById('menuItemsList');

            if (items.length === 0) {
                list.innerHTML = '<p class="empty-state">Aucun plat dans cette categorie</p>';
                return;
            }

            list.innerHTML = items.map(m => {
                const cat = App.data.categories.find(c => c.id === m.category);
                const opts = m.options || {};
                const optText = [
                    opts.sides && opts.sides.length ? `${opts.sides.length} accompagnement(s)` : '',
                    opts.extras && opts.extras.length ? `${opts.extras.length} supplement(s)` : '',
                    opts.prefs && opts.prefs.length ? `${opts.prefs.length} preference(s)` : '',
                    m.recipe && m.recipe.length && App.can('menu.manage')
                        ? `cout ${App.fmt(Math.round(this.recipeCostOf(m.recipe)))} · marge ${m.price ? Math.round((m.price - this.recipeCostOf(m.recipe)) / m.price * 100) : 0} %` : ''
                ].filter(Boolean).join(' · ');
                return `<div class="menu-item-card ${m.available ? '' : 'unavailable'}">
                    <div class="menu-item-thumb">${m.photo ? `<img src="${m.photo}" alt="" loading="lazy">` : App.esc(cat ? cat.icon : '🍽️')}</div>
                    <div style="flex:1;min-width:0">
                        <div class="menu-item-name">${App.esc(m.name)}</div>
                        <div class="menu-item-desc">${App.esc(m.desc || '')}</div>
                        ${optText ? `<div class="menu-item-opts">${App.esc(optText)}</div>` : ''}
                    </div>
                    <div class="menu-item-price">${App.fmt(m.price)}</div>
                    <div class="menu-item-actions">
                        ${App.can('menu.availability') ? `<button class="btn btn-small ${m.available ? 'btn-warning' : 'btn-success'}" onclick="App.menu.toggleAvail('${m.id}')">${m.available ? 'Indispo' : 'Dispo'}</button>` : ''}
                        ${!App.can('menu.manage') && App.can('stock.manage') ? `<button class="btn btn-small btn-secondary" onclick="App.menu.editItem('${m.id}')">Recette</button>` : ''}
                        ${App.can('menu.manage') ? `<button class="btn btn-small btn-secondary" onclick="App.menu.editItem('${m.id}')">Modifier</button>
                        <button class="btn btn-small btn-danger" onclick="App.menu.removeItem('${m.id}')">Suppr</button>` : ''}
                    </div>
                </div>`;
            }).join('');
        },

        selectCat(catId) {
            this.selectedCat = catId;
            this.render();
        },

        toggleAvail(id) {
            const m = App.data.menuItems.find(x => x.id === id);
            if (m) { m.available = !m.available; App.saveData(); App.render(); }
        },

        fillForm(m) {
            const o = (m && m.options) || {};
            document.getElementById('menuItemName').value = m ? m.name : '';
            document.getElementById('menuItemPrice').value = m ? m.price : '';
            document.getElementById('menuItemDesc').value = m ? m.desc || '' : '';
            document.getElementById('menuItemAvailable').checked = m ? m.available !== false : true;
            document.getElementById('menuItemSides').value = (o.sides || []).join(', ');
            document.getElementById('menuItemExtras').value = (o.extras || []).map(e => `${e.name}:${e.price}`).join(', ');
            document.getElementById('menuItemPrefs').value = (o.prefs || []).join(', ');
            document.querySelector('.options-editor').open = !!(o.sides || o.extras || o.prefs);
            document.getElementById('menuItemPhotoInput').value = '';
            this.setPhoto(m ? m.photo || null : null);
            this.recipe = m && m.recipe ? m.recipe.map(r => ({ ingredientId: r.ingredientId, qty: String(r.qty) })) : [];
            document.getElementById('recipeEditor').open = this.recipe.length > 0;
            document.getElementById('recipeEditor').style.display = App.data.ingredients.length || this.recipe.length ? '' : 'none';
            this.renderRecipe();
            this.populateCategorySelect(m ? m.category : undefined);
            document.getElementById('modalMenuItem').classList.add('open');
        },

        openAddModal() {
            this.editingItemId = null;
            document.getElementById('modalMenuItemTitle').textContent = 'Ajouter un plat';
            this.fillForm(null);
        },

        editItem(id) {
            const m = App.data.menuItems.find(x => x.id === id);
            if (!m) return;
            this.editingItemId = id;
            document.getElementById('modalMenuItemTitle').textContent = 'Modifier le plat';
            this.fillForm(m);
        },

        setPhoto(dataUrl) {
            this.photo = dataUrl;
            document.getElementById('menuItemPhotoPreview').innerHTML = dataUrl ? `<img src="${dataUrl}" alt="Photo du plat">` : '<span>Aucune photo</span>';
            document.getElementById('menuItemPhotoRemove').style.display = dataUrl ? '' : 'none';
        },

        // Phone photos are several MB; they are shrunk to a small JPEG so they fit in the synced menu record.
        pickPhoto(input) {
            const file = input.files && input.files[0];
            if (!file) return;
            if (!file.type.startsWith('image/')) { App.toast('Choisissez une image', 'error'); return; }
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                const encode = (maxSide, quality) => {
                    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.round(img.width * scale);
                    canvas.height = Math.round(img.height * scale);
                    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                    return canvas.toDataURL('image/jpeg', quality);
                };
                let data = encode(360, 0.72);
                if (data.length > 44000) data = encode(300, 0.6);
                if (data.length > 44000) data = encode(240, 0.5);
                if (data.length > 44000) { App.toast('Photo trop lourde, essayez une autre image', 'error'); return; }
                this.setPhoto(data);
            };
            img.onerror = () => { URL.revokeObjectURL(url); App.toast('Image illisible', 'error'); };
            img.src = url;
        },

        recipeCostOf(recipe) {
            return (recipe || []).reduce((s, r) => {
                const i = App.data.ingredients.find(x => x.id === r.ingredientId);
                return s + (i ? (parseFloat(r.qty) || 0) * (i.avgCost || 0) : 0);
            }, 0);
        },

        renderRecipe() {
            document.getElementById('recipeLines').innerHTML = this.recipe.length ? this.recipe.map((r, i) => {
                const ing = App.data.ingredients.find(x => x.id === r.ingredientId);
                return `<div class="recipe-line">
                    <select onchange="App.menu.setRecipe(${i}, 'ingredientId', this.value)" aria-label="Ingredient">${App.stocks.options(r.ingredientId)}</select>
                    <input type="number" min="0" step="any" value="${App.esc(r.qty)}" placeholder="Qte" aria-label="Quantite par portion" oninput="App.menu.setRecipe(${i}, 'qty', this.value)">
                    <span class="recipe-unit">${ing ? App.esc(ing.unit) : ''}</span>
                    <button type="button" class="pay-line-remove" onclick="App.menu.removeRecipeLine(${i})" aria-label="Retirer">&times;</button>
                </div>`;
            }).join('') : '<p class="form-hint">Aucun ingredient : les ventes de ce plat ne toucheront pas le stock.</p>';
            this.updateRecipeCost();
        },

        updateRecipeCost() {
            const cost = Math.round(this.recipeCostOf(this.recipe));
            const price = parseInt(document.getElementById('menuItemPrice').value, 10) || 0;
            const el = document.getElementById('recipeCost');
            if (!this.recipe.length) { el.innerHTML = ''; return; }
            const margin = price - cost;
            el.innerHTML = `Cout de revient estime : <strong>${App.fmt(cost)}</strong>` +
                (price ? ` · Marge : <strong class="${margin < 0 ? 'neg' : ''}">${App.fmt(margin)} (${Math.round(margin / price * 100)} %)</strong>` : '');
        },

        setRecipe(i, field, value) {
            this.recipe[i][field] = value;
            if (field === 'ingredientId') this.renderRecipe(); else this.updateRecipeCost();
        },

        addRecipeLine() {
            if (!App.data.ingredients.length) { App.toast("Creez d'abord des ingredients dans Stocks", 'error'); return; }
            this.recipe.push({ ingredientId: '', qty: '' });
            this.renderRecipe();
        },

        removeRecipeLine(i) {
            this.recipe.splice(i, 1);
            this.renderRecipe();
        },

        parseList(id) {
            return document.getElementById(id).value.split(',').map(s => s.trim()).filter(Boolean).slice(0, 12).map(s => s.slice(0, 40));
        },

        populateCategorySelect(selected) {
            const sel = document.getElementById('menuItemCategory');
            sel.innerHTML = App.data.categories.map(c =>
                `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${App.esc(c.icon)} ${App.esc(c.name)}</option>`
            ).join('');
        },

        closeItemModal() {
            document.getElementById('modalMenuItem').classList.remove('open');
        },

        saveItem() {
            const name = document.getElementById('menuItemName').value.trim();
            const category = document.getElementById('menuItemCategory').value;
            const price = parseInt(document.getElementById('menuItemPrice').value, 10);
            const desc = document.getElementById('menuItemDesc').value.trim();
            const available = document.getElementById('menuItemAvailable').checked;

            if (!name || !(price >= 0)) { App.toast('Remplissez le nom et le prix', 'error'); return; }

            const extras = [];
            for (const part of this.parseList('menuItemExtras')) {
                const m = part.match(/^(.+?)\s*:\s*(\d+)$/);
                if (!m) { App.toast(`Supplement « ${part} » : ecrivez nom:prix (ex: Oeuf:200)`, 'error'); return; }
                extras.push({ name: m[1].trim(), price: parseInt(m[2], 10) });
            }
            const sides = this.parseList('menuItemSides');
            const prefs = this.parseList('menuItemPrefs');
            const options = {};
            if (sides.length) options.sides = sides;
            if (extras.length) options.extras = extras;
            if (prefs.length) options.prefs = prefs;

            const recipe = [];
            for (const r of this.recipe || []) {
                if (!r.ingredientId && !r.qty) continue;
                const q = parseFloat(r.qty);
                if (!r.ingredientId || !(q > 0)) { App.toast('Recette : chaque ligne doit avoir un ingredient et une quantite', 'error'); return; }
                recipe.push({ ingredientId: r.ingredientId, qty: q });
            }

            if (!App.can('menu.manage')) {
                // Stock managers may only change the recipe; everything else on the dish stays as it is.
                const m = App.data.menuItems.find(x => x.id === this.editingItemId);
                if (!m) return;
                if (recipe.length) m.recipe = recipe; else delete m.recipe;
                App.saveData();
                this.closeItemModal();
                App.render();
                App.toast('Recette enregistree');
                return;
            }

            const fields = { name, category, price, desc, available };
            if (this.editingItemId) {
                const m = App.data.menuItems.find(x => x.id === this.editingItemId);
                if (m) {
                    Object.assign(m, fields);
                    if (Object.keys(options).length) m.options = options; else delete m.options;
                    if (this.photo) m.photo = this.photo; else delete m.photo;
                    if (recipe.length) m.recipe = recipe; else delete m.recipe;
                }
                App.toast('Plat modifie');
            } else {
                const m = { id: App.genId(), ...fields };
                if (Object.keys(options).length) m.options = options;
                if (this.photo) m.photo = this.photo;
                if (recipe.length) m.recipe = recipe;
                App.data.menuItems.push(m);
                App.toast('Plat ajoute');
            }
            App.saveData();
            this.closeItemModal();
            App.render();
        },

        removeItem(id) {
            if (!confirm('Supprimer ce plat ?')) return;
            App.data.menuItems = App.data.menuItems.filter(m => m.id !== id);
            App.saveData();
            App.toast('Plat supprime');
            App.render();
        },

        openCategoryModal() {
            document.getElementById('categoryName').value = '';
            document.querySelectorAll('.icon-option').forEach(o => o.classList.remove('selected'));
            document.querySelector('.icon-option').classList.add('selected');
            document.getElementById('modalCategory').classList.add('open');
        },

        closeCategoryModal() {
            document.getElementById('modalCategory').classList.remove('open');
        },

        saveCategory() {
            const name = document.getElementById('categoryName').value.trim();
            const icon = document.querySelector('.icon-option.selected')?.dataset.icon || '🍽️';
            if (!name) { App.toast('Entrez un nom de categorie', 'error'); return; }
            App.data.categories.push({ id: App.genId(), name, icon });
            App.saveData();
            this.closeCategoryModal();
            App.toast('Categorie ajoutee');
            App.render();
        }
    },

    // CAISSE
    caisse: {
        selectedOrderId: null,
        lines: [],
        pendingId: null,
        busy: false,
        refundPaymentId: null,
        pendingRefundId: null,

        payableOrders() {
            return App.data.orders
                .filter(o => ['en_cours', 'prete', 'servie'].includes(o.status) && App.balance(o).remaining > 0)
                .sort((a, b) => a.number - b.number);
        },

        render() {
            App.cash.renderBar();
            const orders = this.payableOrders();
            const today = new Date().toDateString();
            const todayPayments = App.data.payments.filter(p => new Date(p.paidAt).toDateString() === today);
            const todayRefunds = App.data.refunds.filter(r => new Date(r.at).toDateString() === today);
            const net = todayPayments.reduce((s, p) => s + p.amount, 0) - todayRefunds.reduce((s, r) => s + r.amount, 0);

            document.getElementById('caissePending').textContent = orders.length;
            document.getElementById('caisseTodayTotal').textContent = App.fmt(net);
            document.getElementById('caisseTodayCount').textContent = todayPayments.length;

            const container = document.getElementById('caisseOrders');
            container.innerHTML = orders.length === 0 ? '<p class="empty-state">Aucune commande a encaisser</p>' : orders.map(o => {
                const table = App.data.tables.find(t => t.id === o.tableId);
                const b = App.balance(o);
                return `<div class="caisse-order-card ${this.selectedOrderId === o.id ? 'selected' : ''}" onclick="App.caisse.selectOrder('${o.id}')">
                    <div class="caisse-order-header">
                        <strong>#${String(o.number).padStart(3, '0')} - Table ${table ? table.number : '?'}</strong>
                        <strong>${App.fmt(o.total)}</strong>
                    </div>
                    <div class="caisse-order-items">${o.items.map(it => `${it.qty}x ${App.esc(it.name)}`).join(', ')}</div>
                    ${b.paid > 0 ? `<div class="caisse-order-partial">Deja paye ${App.fmt(b.paid)} · Reste <strong>${App.fmt(b.remaining)}</strong></div>` : ''}
                </div>`;
            }).join('');

            const selected = App.data.orders.find(o => o.id === this.selectedOrderId);
            if (!selected) {
                this.selectedOrderId = null;
                document.getElementById('caisseTicket').innerHTML = '<p class="empty-state">Selectionnez une commande</p>';
                document.getElementById('caisseActions').style.display = 'none';
            } else {
                this.renderOrderState();
            }

            this.renderOperations();
            App.cash.renderHistory();
        },

        selectOrder(id) {
            const o = App.data.orders.find(x => x.id === id);
            if (!o) return;
            this.selectedOrderId = id;
            this.pendingId = App.genId();
            this.lines = [{ method: 'especes', amount: String(App.balance(o).remaining), received: '' }];
            this.renderTicketPreview(o);
            document.getElementById('caisseActions').style.display = 'block';
            this.renderLines();
            this.render();
        },

        renderTicketPreview(o) {
            const table = App.data.tables.find(t => t.id === o.tableId);
            document.getElementById('caisseTicket').innerHTML = `
                <div class="ticket-header">
                    <h3>Restaurant Sissiman</h3>
                    <div>Commande #${String(o.number).padStart(3, '0')}</div>
                    <div>Table ${table ? table.number : '?'} - ${o.covers || 1} couvert(s)</div>
                    <div>${new Date(o.createdAt).toLocaleString('fr-FR')}</div>
                </div>
                <div class="ticket-items">
                    ${o.items.map(it => `
                        <div class="ticket-row">
                            <span>${it.qty}x ${App.esc(it.name)}${App.itemDetailHtml(it)}</span>
                            <span>${App.fmt(App.lineTotal(it))}</span>
                        </div>
                    `).join('')}
                </div>
                <div class="ticket-total">
                    <span>TOTAL</span>
                    <span>${App.fmt(o.total)}</span>
                </div>
                ${o.note ? `<div style="margin-top:0.5rem;font-size:0.8rem;color:var(--text-secondary)">Note: ${App.esc(o.note)}</div>` : ''}
            `;
        },

        renderOrderState() {
            const o = App.data.orders.find(x => x.id === this.selectedOrderId);
            if (!o) return;
            const b = App.balance(o);
            document.getElementById('payBalance').innerHTML = `
                <div><span>Total</span><strong>${App.fmt(o.total)}</strong></div>
                <div><span>Deja paye</span><strong>${App.fmt(b.paid)}</strong></div>
                ${b.refunded ? `<div><span>Rembourse</span><strong class="neg">-${App.fmt(b.refunded)}</strong></div>` : ''}
                <div class="pay-rest ${b.remaining === 0 ? 'done' : ''}"><span>${b.remaining === 0 ? 'Commande soldee' : 'Reste a payer'}</span><strong>${App.fmt(b.remaining)}</strong></div>`;
            document.getElementById('payForm').style.display = b.remaining > 0 && o.status !== 'annulee' && App.can('payments.create') ? '' : 'none';
            document.getElementById('printReceiptBtn').style.display = b.paid > 0 ? '' : 'none';

            const payments = App.data.payments.filter(p => p.orderId === o.id);
            document.getElementById('payHistory').innerHTML = payments.length === 0 ? '' : `
                <div class="pay-history-title">Paiements de cette commande</div>
                ${payments.map(p => this.paymentRow(p)).join('')}`;
            this.updateSummary();
        },

        paymentRow(p) {
            const refunded = App.refundedOf(p.id);
            const time = new Date(p.paidAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
            return `<div class="pay-history-row">
                <span>${App.esc(time)} · ${App.methodLabel(p.method)}</span>
                <span>${App.fmt(p.amount)}${refunded ? ` <em class="neg">(-${App.fmt(refunded)})</em>` : ''}</span>
                ${App.can('refunds.create') && refunded < p.amount ? `<button class="btn btn-small btn-secondary" onclick="App.caisse.openRefund('${p.id}')">Rembourser</button>` : '<span></span>'}
            </div>`;
        },

        renderLines() {
            const methods = [['especes', 'Especes'], ['mobile', 'Mobile Money'], ['carte', 'Carte']];
            document.getElementById('payLines').innerHTML = this.lines.map((l, i) => `
                <div class="pay-line">
                    <select onchange="App.caisse.setLine(${i}, 'method', this.value)" aria-label="Moyen de paiement">
                        ${methods.map(([v, t]) => `<option value="${v}" ${l.method === v ? 'selected' : ''}>${t}</option>`).join('')}
                    </select>
                    <input type="number" min="1" step="25" inputmode="numeric" value="${App.esc(l.amount)}" placeholder="Montant" aria-label="Montant"
                        oninput="App.caisse.setLine(${i}, 'amount', this.value)">
                    ${l.method === 'especes' ? `<input type="number" min="0" step="25" inputmode="numeric" value="${App.esc(l.received)}" placeholder="Recu du client" aria-label="Montant recu"
                        oninput="App.caisse.setLine(${i}, 'received', this.value)">` : '<span class="pay-line-spacer"></span>'}
                    ${this.lines.length > 1 ? `<button class="pay-line-remove" title="Retirer" onclick="App.caisse.removeLine(${i})">&times;</button>` : ''}
                </div>`).join('');
            document.getElementById('payAddLine').style.display = this.lines.length < 4 ? '' : 'none';
        },

        setLine(i, field, value) {
            if (!this.lines[i]) return;
            this.lines[i][field] = value;
            if (field === 'method') {
                if (value !== 'especes') this.lines[i].received = '';
                this.renderLines();
            }
            this.updateSummary();
        },

        addLine() {
            const o = App.data.orders.find(x => x.id === this.selectedOrderId);
            if (!o || this.lines.length >= 4) return;
            const left = App.balance(o).remaining - this.lineSum();
            this.lines.push({ method: 'mobile', amount: left > 0 ? String(left) : '', received: '' });
            this.renderLines();
            this.updateSummary();
        },

        removeLine(i) {
            this.lines.splice(i, 1);
            this.renderLines();
            this.updateSummary();
        },

        lineSum() {
            return this.lines.reduce((s, l) => s + (parseInt(l.amount, 10) || 0), 0);
        },

        lineError(remaining) {
            if (!App.myCashSession()) return 'Ouvrez votre caisse pour encaisser';
            for (const l of this.lines) {
                const a = parseInt(l.amount, 10);
                if (!(a > 0)) return 'Indiquez un montant pour chaque moyen de paiement';
                if (l.method === 'especes' && l.received !== '' && (parseInt(l.received, 10) || 0) < a) return 'Le montant recu est inferieur au montant en especes';
            }
            const sum = this.lineSum();
            if (sum > remaining) return `Le total depasse le reste a payer (${App.fmt(remaining)})`;
            return null;
        },

        updateSummary() {
            const o = App.data.orders.find(x => x.id === this.selectedOrderId);
            if (!o) return;
            const remaining = App.balance(o).remaining;
            const sum = this.lineSum();
            const change = this.lines.reduce((s, l) => {
                const r = parseInt(l.received, 10), a = parseInt(l.amount, 10);
                return l.method === 'especes' && r > a ? s + (r - a) : s;
            }, 0);
            const error = this.lineError(remaining);
            const after = Math.max(0, remaining - sum);
            document.getElementById('paySummary').innerHTML = error
                ? `<span class="pay-error">${App.esc(error)}</span>`
                : `<span>Encaisse : <strong>${App.fmt(sum)}</strong></span>
                   <span>${after > 0 ? `Reste apres : <strong>${App.fmt(after)}</strong>` : 'Commande soldee'}</span>
                   ${change > 0 ? `<span class="pay-change">Monnaie a rendre : <strong>${App.fmt(change)}</strong></span>` : ''}`;
            const btn = document.getElementById('payButton');
            btn.disabled = !!error || this.busy || sum <= 0;
            btn.textContent = this.busy ? 'Enregistrement...' : sum < remaining && sum > 0 ? `Encaisser ${App.fmt(sum)} (partiel)` : `Encaisser ${App.fmt(sum)}`;
        },

        async processPayment() {
            const o = App.data.orders.find(x => x.id === this.selectedOrderId);
            if (!o || this.busy) return;
            const error = this.lineError(App.balance(o).remaining);
            if (error) { App.toast(error, 'error'); return; }
            const lines = this.lines.map(l => {
                const line = { method: l.method, amount: parseInt(l.amount, 10) };
                if (l.method === 'especes' && l.received !== '') line.received = parseInt(l.received, 10);
                return line;
            });
            this.busy = true;
            this.updateSummary();
            try {
                await App.serverAction('/payments', { id: this.pendingId, orderId: o.id, lines });
                this.pendingId = App.genId();
                const updated = App.data.orders.find(x => x.id === o.id);
                const b = App.balance(updated);
                App.toast(b.remaining === 0 ? 'Paiement enregistre : commande soldee' : `Paiement partiel enregistre · reste ${App.fmt(b.remaining)}`);
                this.lines = [{ method: 'especes', amount: b.remaining ? String(b.remaining) : '', received: '' }];
                this.renderLines();
            } catch (e) {
                // Same pendingId is kept so a retry after a network error cannot create a second payment.
                App.toast(e.status ? e.message : 'Connexion impossible : paiement NON enregistre, reessayez', 'error');
            } finally {
                this.busy = false;
                this.render();
            }
        },

        renderOperations() {
            const today = new Date().toDateString();
            const ops = [
                ...App.data.payments.filter(p => new Date(p.paidAt).toDateString() === today).map(p => ({ kind: 'p', at: p.paidAt, x: p })),
                ...App.data.refunds.filter(r => new Date(r.at).toDateString() === today).map(r => ({ kind: 'r', at: r.at, x: r }))
            ].sort((a, b) => b.at.localeCompare(a.at));
            const tbody = document.getElementById('paymentsBody');
            if (ops.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-secondary)">Aucune operation aujourd\'hui</td></tr>';
                return;
            }
            tbody.innerHTML = ops.map(({ kind, at, x }) => {
                const time = new Date(at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
                const num = `#${String(x.orderNumber).padStart(3, '0')}`;
                if (kind === 'r') {
                    return `<tr class="op-refund">
                        <td>${App.esc(time)}</td><td>${App.esc(num)}</td>
                        <td>Remboursement — ${App.esc(x.reason)}</td>
                        <td><strong class="neg">-${App.fmt(x.amount)}</strong></td>
                        <td>${App.methodLabel(x.method)}</td><td>${App.esc(x.staffName || '')}</td><td></td>
                    </tr>`;
                }
                const refundable = x.amount - App.refundedOf(x.id);
                return `<tr>
                    <td>${App.esc(time)}</td><td>${App.esc(num)}</td><td>Paiement</td>
                    <td><strong>${App.fmt(x.amount)}</strong></td>
                    <td>${App.methodLabel(x.method)}</td><td>${App.esc(x.staffName || '')}</td>
                    <td class="op-actions">
                        <button class="btn btn-small btn-secondary" onclick="App.tickets.receipt('${App.esc(x.orderId)}')">Recu</button>
                        ${App.can('refunds.create') && refundable > 0 ? `<button class="btn btn-small btn-secondary" onclick="App.caisse.openRefund('${App.esc(x.id)}')">Rembourser</button>` : ''}
                    </td>
                </tr>`;
            }).join('');
        },

        openRefund(paymentId) {
            const p = App.data.payments.find(x => x.id === paymentId);
            if (!p) return;
            const max = p.amount - App.refundedOf(p.id);
            this.refundPaymentId = paymentId;
            this.pendingRefundId = App.genId();
            document.getElementById('refundInfo').textContent =
                `Commande #${String(p.orderNumber).padStart(3, '0')} · ${App.methodLabel(p.method)} · ${App.fmt(p.amount)} encaisse le ` +
                `${new Date(p.paidAt).toLocaleString('fr-FR')}. Remboursable : ${App.fmt(max)}.`;
            document.getElementById('refundAmount').value = max;
            document.getElementById('refundAmount').max = max;
            document.getElementById('refundReason').value = '';
            document.getElementById('modalRefund').classList.add('open');
        },

        closeRefund() {
            document.getElementById('modalRefund').classList.remove('open');
        },

        async submitRefund() {
            const btn = document.getElementById('refundBtn');
            if (btn.disabled) return;
            const amount = parseInt(document.getElementById('refundAmount').value, 10);
            const reason = document.getElementById('refundReason').value.trim();
            if (!(amount > 0)) { App.toast('Montant invalide', 'error'); return; }
            if (reason.length < 3) { App.toast('Le motif est obligatoire', 'error'); return; }
            btn.disabled = true;
            try {
                await App.serverAction('/refunds', { id: this.pendingRefundId, paymentId: this.refundPaymentId, amount, reason });
                this.closeRefund();
                App.toast(`Remboursement de ${App.fmt(amount)} enregistre`);
            } catch (e) {
                App.toast(e.status ? e.message : 'Connexion impossible : remboursement NON enregistre', 'error');
            } finally {
                btn.disabled = false;
            }
        }
    },

    cash: {
        barKey: null,
        busy: false,
        pendingOpenId: null,
        closingId: null,

        totals(sessionId) {
            const t = { payments: { especes: 0, mobile: 0, carte: 0 }, refunds: { especes: 0, mobile: 0, carte: 0 }, count: 0 };
            App.data.payments.filter(p => p.sessionId === sessionId).forEach(p => { t.payments[p.method] += p.amount; t.count++; });
            App.data.refunds.filter(r => r.sessionId === sessionId).forEach(r => { t.refunds[r.method] += r.amount; });
            return t;
        },

        expected(s) {
            const t = this.totals(s.id);
            return s.openingFloat + t.payments.especes - t.refunds.especes;
        },

        renderBar() {
            const bar = document.getElementById('cashSessionBar');
            if (!App.can('cash.session')) { bar.innerHTML = ''; this.barKey = null; return; }
            const s = App.myCashSession();
            if (!s) {
                if (this.barKey === 'closed') return;
                this.barKey = 'closed';
                bar.innerHTML = `<div class="cash-bar closed">
                    <div class="cash-bar-text"><strong>Caisse fermee</strong><span>Comptez le fonds de caisse puis ouvrez la caisse pour encaisser.</span></div>
                    <div class="cash-bar-form">
                        <input type="number" id="openFloat" min="0" step="25" inputmode="numeric" placeholder="Fonds initial (FCFA)" aria-label="Fonds de caisse initial">
                        <button class="btn btn-primary" id="openCashBtn" onclick="App.cash.open()">Ouvrir la caisse</button>
                    </div>
                </div>`;
                return;
            }
            const t = this.totals(s.id);
            const key = `open:${s.id}:${this.expected(s)}:${t.count}`;
            if (this.barKey === key) return;
            this.barKey = key;
            const since = new Date(s.openedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
            bar.innerHTML = `<div class="cash-bar open">
                <div class="cash-bar-text">
                    <strong>Caisse ouverte depuis ${App.esc(since)}</strong>
                    <span>Fonds ${App.fmt(s.openingFloat)} · ${t.count} paiement(s) · Especes attendues dans le tiroir : <strong>${App.fmt(this.expected(s))}</strong></span>
                </div>
                <button class="btn btn-secondary" onclick="App.cash.openCloseModal('${App.esc(s.id)}')">Cloturer la caisse</button>
            </div>`;
        },

        async open() {
            if (this.busy) return;
            const raw = document.getElementById('openFloat').value;
            const openingFloat = parseInt(raw, 10);
            if (raw === '' || !(openingFloat >= 0)) { App.toast('Indiquez le fonds de caisse (0 si vide)', 'error'); return; }
            this.pendingOpenId = this.pendingOpenId || App.genId();
            this.busy = true;
            document.getElementById('openCashBtn').disabled = true;
            try {
                await App.serverAction('/cash/open', { id: this.pendingOpenId, openingFloat });
                this.pendingOpenId = null;
                App.toast('Caisse ouverte');
            } catch (e) {
                App.toast(e.status ? e.message : 'Connexion impossible', 'error');
                const btn = document.getElementById('openCashBtn');
                if (btn) btn.disabled = false;
            } finally {
                this.busy = false;
            }
        },

        openCloseModal(sessionId) {
            const s = App.data.cashSessions.find(x => x.id === sessionId);
            if (!s || s.status !== 'ouverte') return;
            this.closingId = sessionId;
            const t = this.totals(s.id);
            const row = (label, v, cls = '') => `<div class="close-row ${cls}"><span>${label}</span><strong>${v}</strong></div>`;
            document.getElementById('closeRecap').innerHTML = `
                ${row('Caissier', App.esc(s.staffName))}
                ${row('Ouverture', App.esc(new Date(s.openedAt).toLocaleString('fr-FR')))}
                ${row('Fonds initial', App.fmt(s.openingFloat))}
                ${row('Ventes en especes', '+' + App.fmt(t.payments.especes))}
                ${row('Remboursements en especes', '-' + App.fmt(t.refunds.especes))}
                ${row('Especes attendues', App.fmt(this.expected(s)), 'total')}
                ${row('Mobile Money', App.fmt(t.payments.mobile - t.refunds.mobile), 'muted')}
                ${row('Carte', App.fmt(t.payments.carte - t.refunds.carte), 'muted')}`;
            document.getElementById('closeCounted').value = '';
            document.getElementById('closeNote').value = '';
            document.getElementById('closeDiff').innerHTML = '';
            document.getElementById('modalCloseCash').classList.add('open');
            document.getElementById('closeCounted').focus();
        },

        updateDiff() {
            const s = App.data.cashSessions.find(x => x.id === this.closingId);
            const raw = document.getElementById('closeCounted').value;
            const el = document.getElementById('closeDiff');
            if (!s || raw === '') { el.innerHTML = ''; return; }
            const diff = (parseInt(raw, 10) || 0) - this.expected(s);
            el.className = 'close-diff ' + (diff === 0 ? 'ok' : diff > 0 ? 'plus' : 'minus');
            el.textContent = diff === 0 ? 'Caisse juste' : diff > 0 ? `Excedent de ${App.fmt(diff)}` : `Manque de ${App.fmt(-diff)}`;
        },

        closeModal() {
            document.getElementById('modalCloseCash').classList.remove('open');
        },

        async close() {
            const s = App.data.cashSessions.find(x => x.id === this.closingId);
            if (!s || this.busy) return;
            const raw = document.getElementById('closeCounted').value;
            const countedCash = parseInt(raw, 10);
            const note = document.getElementById('closeNote').value.trim();
            if (raw === '' || !(countedCash >= 0)) { App.toast('Saisissez le montant compte', 'error'); return; }
            if (countedCash !== this.expected(s) && note.length < 3) { App.toast("Expliquez l'ecart dans le commentaire", 'error'); return; }
            this.busy = true;
            document.getElementById('closeCashBtn').disabled = true;
            try {
                await App.serverAction('/cash/close', { sessionId: s.id, countedCash, note });
                this.closeModal();
                const closed = App.data.cashSessions.find(x => x.id === s.id);
                App.toast(closed && closed.diff ? `Caisse cloturee · ecart ${App.fmt(closed.diff)}` : 'Caisse cloturee · caisse juste');
                App.tickets.closing(s.id);
            } catch (e) {
                App.toast(e.status ? e.message : 'Connexion impossible : caisse NON cloturee', 'error');
            } finally {
                this.busy = false;
                document.getElementById('closeCashBtn').disabled = false;
            }
        },

        renderHistory() {
            const tbody = document.getElementById('cashSessionsBody');
            if (!App.can('cash.history')) return;
            const sessions = [...App.data.cashSessions].sort((a, b) => b.openedAt.localeCompare(a.openedAt)).slice(0, 30);
            if (sessions.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-secondary)">Aucune session</td></tr>';
                return;
            }
            const dt = iso => new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
            tbody.innerHTML = sessions.map(s => {
                const open = s.status === 'ouverte';
                const diffCls = open ? '' : s.diff === 0 ? 'diff-ok' : 'diff-bad';
                return `<tr>
                    <td>${App.esc(s.staffName)}</td>
                    <td>${App.esc(dt(s.openedAt))}</td>
                    <td>${open ? '<span class="order-status en_cours">ouverte</span>' : App.esc(dt(s.closedAt))}</td>
                    <td>${App.fmt(open ? this.expected(s) : s.expectedCash)}</td>
                    <td>${open ? '—' : App.fmt(s.countedCash)}</td>
                    <td class="${diffCls}">${open ? '—' : (s.diff > 0 ? '+' : '') + App.fmt(s.diff)}${!open && s.note ? `<div class="diff-note">${App.esc(s.note)}</div>` : ''}</td>
                    <td>${open
                        ? `<button class="btn btn-small btn-secondary" onclick="App.cash.openCloseModal('${App.esc(s.id)}')">Cloturer</button>`
                        : `<button class="btn btn-small btn-secondary" onclick="App.tickets.closing('${App.esc(s.id)}')">Imprimer</button>`}</td>
                </tr>`;
            }).join('');
        }
    },

    tickets: {
        print(html, layout = 'ticket-print') {
            const area = document.getElementById('printArea');
            area.innerHTML = `<div class="${layout}">${html}</div>`;
            document.body.classList.add('printing');
            const cleanup = () => {
                document.body.classList.remove('printing');
                area.innerHTML = '';
            };
            window.addEventListener('afterprint', cleanup, { once: true });
            window.print();
        },

        head(title) {
            return `<div class="tp-center">
                <div class="tp-name">Restaurant Sissiman</div>
                <div>Bobo-Dioulasso, Burkina Faso</div>
                <div class="tp-title">${title}</div>
            </div>`;
        },

        row(left, right, cls = '') {
            return `<div class="tp-row ${cls}"><span>${left}</span><span>${right}</span></div>`;
        },

        orderMeta(o) {
            const table = App.data.tables.find(t => t.id === o.tableId);
            return `<div class="tp-meta">
                <div>Commande #${String(o.number).padStart(3, '0')} · Table ${table ? table.number : '?'} · ${o.covers || 1} couvert(s)</div>
                <div>${App.esc(new Date().toLocaleString('fr-FR'))}</div>
            </div>`;
        },

        items(o) {
            return `<div class="tp-sep"></div>${o.items.map(it => this.row(`${it.qty} x ${App.esc(it.name)}`, App.fmt(App.lineTotal(it))) +
                (App.itemDetails(it).length ? `<div class="tp-small">&nbsp;&nbsp;${App.esc(App.itemDetails(it).join(', '))}</div>` : '')).join('')}
                <div class="tp-sep"></div>${this.row('TOTAL', App.fmt(o.total), 'tp-big')}`;
        },

        bill(orderId) {
            const o = App.data.orders.find(x => x.id === orderId);
            if (!o) return;
            const b = App.balance(o);
            this.print(`${this.head('ADDITION')}${this.orderMeta(o)}${this.items(o)}
                ${b.paid ? this.row('Deja paye', '-' + App.fmt(b.paid)) : ''}
                ${this.row('RESTE A PAYER', App.fmt(b.remaining), 'tp-big')}
                <div class="tp-sep"></div><div class="tp-center">Merci de votre visite !</div>`);
        },

        receipt(orderId) {
            const o = App.data.orders.find(x => x.id === orderId);
            if (!o) return;
            const b = App.balance(o);
            const payments = App.data.payments.filter(p => p.orderId === o.id);
            const refunds = App.data.refunds.filter(r => r.orderId === o.id);
            const t = iso => new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
            this.print(`${this.head('RECU DE PAIEMENT')}${this.orderMeta(o)}${this.items(o)}
                <div class="tp-sep"></div>
                ${payments.map(p => this.row(`${App.esc(t(p.paidAt))} ${App.methodLabel(p.method)}`, App.fmt(p.amount)) +
                    (p.received ? this.row('&nbsp;&nbsp;Recu / rendu', `${App.fmt(p.received)} / ${App.fmt(p.change || 0)}`, 'tp-small') : '')).join('')}
                ${refunds.map(r => this.row(`${App.esc(t(r.at))} Remboursement`, '-' + App.fmt(r.amount)) + `<div class="tp-small">Motif : ${App.esc(r.reason)}</div>`).join('')}
                <div class="tp-sep"></div>
                ${this.row('TOTAL PAYE', App.fmt(b.paid - b.refunded), 'tp-big')}
                ${b.remaining ? this.row('RESTE A PAYER', App.fmt(b.remaining), 'tp-big') : '<div class="tp-center tp-title">SOLDE</div>'}
                <div class="tp-sep"></div>
                <div class="tp-center tp-small">Caissier : ${App.esc((payments[payments.length - 1] || {}).staffName || '')}</div>
                <div class="tp-center">Merci de votre visite !</div>`);
        },

        kitchen(orderId, onlyAddedAt) {
            const o = App.data.orders.find(x => x.id === orderId);
            if (!o) return;
            const table = App.data.tables.find(t => t.id === o.tableId);
            const items = onlyAddedAt ? o.items.filter(it => it.addedAt === onlyAddedAt) : o.items;
            const at = onlyAddedAt || o.createdAt;
            this.print(`<div class="tp-center tp-title">${onlyAddedAt ? 'CUISINE · AJOUT' : 'CUISINE'}</div>
                <div class="tp-kitchen-head">#${String(o.number).padStart(3, '0')} · ${table ? 'TABLE ' + table.number : 'A EMPORTER'}</div>
                <div class="tp-center">Recue a ${App.esc(new Date(at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }))}</div>
                <div class="tp-sep"></div>
                ${items.map(it => `<div class="tp-kitchen-item"><strong>${it.qty} x</strong> ${App.esc(it.name)}</div>` +
                    (App.itemDetails(it).length ? `<div class="tp-kitchen-opts">${App.esc(App.itemDetails(it).join(' · '))}</div>` : '')).join('')}
                ${o.note ? `<div class="tp-sep"></div><div class="tp-kitchen-note">NOTE : ${App.esc(o.note)}</div>` : ''}`);
        },

        closing(sessionId) {
            const s = App.data.cashSessions.find(x => x.id === sessionId);
            if (!s || s.status !== 'fermee') return;
            const t = s.totals;
            const dt = iso => App.esc(new Date(iso).toLocaleString('fr-FR'));
            this.print(`${this.head('RAPPORT DE CLOTURE')}
                <div class="tp-meta"><div>Caissier : ${App.esc(s.staffName)}</div><div>Ouverture : ${dt(s.openedAt)}</div>
                <div>Cloture : ${dt(s.closedAt)} par ${App.esc(s.closedByName)}</div></div>
                <div class="tp-sep"></div>
                ${this.row('Fonds initial', App.fmt(s.openingFloat))}
                ${this.row('Ventes especes', App.fmt(t.payments.especes))}
                ${this.row('Ventes Mobile Money', App.fmt(t.payments.mobile))}
                ${this.row('Ventes carte', App.fmt(t.payments.carte))}
                ${this.row('Nombre de paiements', t.paymentCount)}
                ${this.row('Remboursements especes', '-' + App.fmt(t.refunds.especes))}
                ${this.row('Remboursements autres', '-' + App.fmt(t.refunds.mobile + t.refunds.carte))}
                <div class="tp-sep"></div>
                ${this.row('Especes attendues', App.fmt(s.expectedCash))}
                ${this.row('Especes comptees', App.fmt(s.countedCash))}
                ${this.row('ECART', (s.diff > 0 ? '+' : '') + App.fmt(s.diff), 'tp-big')}
                ${s.note ? `<div class="tp-small">Commentaire : ${App.esc(s.note)}</div>` : ''}
                <div class="tp-sep"></div>
                <div class="tp-sign">Signature caissier :</div><div class="tp-sign">Signature gerant :</div>`);
        }
    },

    // STOCKS
    stocks: {
        tab: 'etat',
        editingId: null,
        lossId: null,
        pending: null,
        purLines: [],
        busy: false,
        KIND_LABELS: { achat: 'Achat', vente: 'Vente', annulation: 'Annulation', perte: 'Perte', inventaire: 'Inventaire' },

        qty(n) {
            const v = Math.round((n || 0) * 1000) / 1000;
            return v.toLocaleString('fr-FR', { maximumFractionDigits: 3 });
        },

        level(i) {
            const s = i.stock || 0;
            if (s <= 0) return 'rupture';
            if (i.threshold > 0 && s <= i.threshold) return 'bas';
            return 'ok';
        },

        // A brand-new ingredient that was never bought is not an alert yet; anything with a threshold or a purchase history is.
        alerts() {
            return App.data.ingredients.filter(i => this.level(i) !== 'ok' && (i.threshold > 0 || (i.stock || 0) < 0 || i.avgCost > 0));
        },

        setTab(tab) {
            this.tab = tab;
            document.querySelectorAll('.stock-tab').forEach(b => {
                const on = b.dataset.tab === tab;
                b.classList.toggle('active', on);
                b.setAttribute('aria-selected', on);
            });
            document.querySelectorAll('.stock-pane').forEach(p => { p.hidden = p.dataset.pane !== tab; });
        },

        render() {
            if (!document.getElementById('stockSummary')) return;
            const ings = App.data.ingredients;
            const value = ings.reduce((s, i) => s + Math.max(0, i.stock || 0) * (i.avgCost || 0), 0);
            const low = ings.filter(i => this.level(i) === 'bas').length;
            const out = ings.filter(i => this.level(i) === 'rupture').length;
            const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
            const spent = App.data.purchases.filter(p => new Date(p.date) >= monthStart).reduce((s, p) => s + p.total, 0);
            document.getElementById('stockSummary').innerHTML = `
                <div class="kpi"><span class="kpi-label">Valeur du stock</span><span class="kpi-value">${App.fmt(Math.round(value))}</span><span class="kpi-sub">${ings.length} ingredient(s)</span></div>
                <div class="kpi"><span class="kpi-label">Stock bas</span><span class="kpi-value">${low}</span><span class="kpi-sub">Sous le seuil d'alerte</span></div>
                <div class="kpi"><span class="kpi-label">En rupture</span><span class="kpi-value">${out}</span><span class="kpi-sub">Stock nul ou negatif</span></div>
                <div class="kpi"><span class="kpi-label">Achats du mois</span><span class="kpi-value">${App.fmt(spent)}</span><span class="kpi-sub">Depenses fournisseurs</span></div>`;
            this.renderList();
            this.renderPurchases();
            this.renderInventories();
        },

        renderList() {
            const q = (document.getElementById('stockSearch').value || '').trim().toLowerCase();
            const order = { rupture: 0, bas: 1, ok: 2 };
            const ings = App.data.ingredients.filter(i => !q || i.name.toLowerCase().includes(q))
                .sort((a, b) => order[this.level(a)] - order[this.level(b)] || a.name.localeCompare(b.name));
            const body = document.getElementById('stockBody');
            if (!ings.length) {
                body.innerHTML = `<tr><td colspan="7" class="empty-cell">${App.data.ingredients.length ? 'Aucun ingredient ne correspond' : 'Aucun ingredient. Commencez par en ajouter un, puis enregistrez un achat.'}</td></tr>`;
                return;
            }
            const labels = { ok: 'OK', bas: 'Stock bas', rupture: 'Rupture' };
            body.innerHTML = ings.map(i => {
                const lv = this.level(i);
                return `<tr>
                    <td><strong>${App.esc(i.name)}</strong></td>
                    <td class="num">${this.qty(i.stock)} ${App.esc(i.unit)}</td>
                    <td class="num">${i.threshold ? this.qty(i.threshold) + ' ' + App.esc(i.unit) : '—'}</td>
                    <td><span class="stock-badge ${lv}">${labels[lv]}</span></td>
                    <td class="num">${i.avgCost ? App.fmt(Math.round(i.avgCost)) + ' / ' + App.esc(i.unit) : '—'}</td>
                    <td class="num">${App.fmt(Math.round(Math.max(0, i.stock || 0) * (i.avgCost || 0)))}</td>
                    <td class="op-actions">
                        <button class="btn btn-small btn-secondary" onclick="App.stocks.openMoves('${i.id}')">Historique</button>
                        ${App.can('stock.loss') ? `<button class="btn btn-small btn-secondary" onclick="App.stocks.openLoss('${i.id}')">Perte</button>` : ''}
                        ${App.can('stock.manage') ? `<button class="btn btn-small btn-secondary" onclick="App.stocks.openIngredient('${i.id}')">Modifier</button>` : ''}
                    </td>
                </tr>`;
            }).join('');
        },

        renderPurchases() {
            const body = document.getElementById('purchasesBody');
            const list = [...App.data.purchases].sort((a, b) => (b.date + b.at).localeCompare(a.date + a.at)).slice(0, 100);
            body.innerHTML = list.length ? list.map(p => `<tr>
                    <td>${App.esc(new Date(p.date + 'T12:00:00').toLocaleDateString('fr-FR'))}</td>
                    <td>${App.esc(p.supplier)}${p.note ? `<div class="diff-note">${App.esc(p.note)}</div>` : ''}</td>
                    <td>${App.esc(p.lines.map(l => `${this.qty(l.qty)} ${l.unit} ${l.name}`).join(', '))}</td>
                    <td class="num"><strong>${App.fmt(p.total)}</strong></td>
                    <td>${App.esc(p.staffName || '')}</td>
                </tr>`).join('')
                : '<tr><td colspan="5" class="empty-cell">Aucun achat enregistre</td></tr>';
        },

        renderInventories() {
            const body = document.getElementById('inventoriesBody');
            const list = [...App.data.inventories].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
            body.innerHTML = list.length ? list.map(inv => `<tr>
                    <td>${App.esc(new Date(inv.at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</td>
                    <td>${App.esc(inv.staffName || '')}</td>
                    <td class="num">${inv.lines.length}</td>
                    <td class="num">${inv.lines.filter(l => l.diff).length}</td>
                    <td class="num ${inv.totalValue < 0 ? 'diff-bad' : inv.totalValue > 0 ? '' : 'diff-ok'}">${inv.totalValue > 0 ? '+' : ''}${App.fmt(inv.totalValue)}</td>
                    <td><button class="btn btn-small btn-secondary" onclick="App.stocks.showInventory('${inv.id}')">Detail</button></td>
                </tr>`).join('')
                : '<tr><td colspan="6" class="empty-cell">Aucun inventaire realise</td></tr>';
        },

        closeModal(id) {
            document.getElementById(id).classList.remove('open');
        },

        // ---- ingredients ----

        openIngredient(id) {
            const i = id ? App.data.ingredients.find(x => x.id === id) : null;
            this.editingId = i ? i.id : null;
            document.getElementById('ingredientTitle').textContent = i ? `Modifier « ${i.name} »` : 'Nouvel ingredient';
            document.getElementById('ingName').value = i ? i.name : '';
            document.getElementById('ingUnit').value = i ? i.unit : 'kg';
            document.getElementById('ingThreshold').value = i ? i.threshold : '';
            document.getElementById('ingDelete').style.display = i ? '' : 'none';
            document.getElementById('modalIngredient').classList.add('open');
            document.getElementById('ingName').focus();
        },

        saveIngredient() {
            const name = document.getElementById('ingName').value.trim();
            const unit = document.getElementById('ingUnit').value.trim();
            const threshold = parseFloat(document.getElementById('ingThreshold').value) || 0;
            if (!name || !unit) { App.toast("Indiquez le nom et l'unite", 'error'); return; }
            if (App.data.ingredients.some(i => i.id !== this.editingId && i.name.toLowerCase() === name.toLowerCase())) {
                App.toast('Cet ingredient existe deja', 'error');
                return;
            }
            if (this.editingId) {
                const i = App.data.ingredients.find(x => x.id === this.editingId);
                Object.assign(i, { name, unit, threshold });
            } else {
                App.data.ingredients.push({ id: App.genId(), name, unit, threshold, stock: 0, avgCost: 0 });
            }
            App.saveData();
            this.closeModal('modalIngredient');
            App.render();
            App.toast('Ingredient enregistre');
        },

        deleteIngredient() {
            const i = App.data.ingredients.find(x => x.id === this.editingId);
            if (!i) return;
            const used = App.data.menuItems.find(m => (m.recipe || []).some(r => r.ingredientId === i.id));
            if (used) { App.toast(`Utilise dans la recette « ${used.name} » : retirez-le d'abord`, 'error'); return; }
            if (!confirm(`Supprimer « ${i.name} » ?`)) return;
            App.data.ingredients = App.data.ingredients.filter(x => x.id !== i.id);
            App.saveData();
            this.closeModal('modalIngredient');
            App.render();
        },

        options(selected) {
            return '<option value="">Choisir...</option>' + [...App.data.ingredients].sort((a, b) => a.name.localeCompare(b.name))
                .map(i => `<option value="${i.id}" ${i.id === selected ? 'selected' : ''}>${App.esc(i.name)} (${App.esc(i.unit)})</option>`).join('');
        },

        // ---- achats ----

        openPurchase() {
            if (!App.data.ingredients.length) { App.toast("Ajoutez d'abord vos ingredients", 'error'); return; }
            this.pending = App.genId();
            this.purLines = [{ ingredientId: '', qty: '', unitPrice: '' }];
            document.getElementById('purSupplier').value = '';
            document.getElementById('purNote').value = '';
            const d = new Date();
            document.getElementById('purDate').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            document.getElementById('purSuppliers').innerHTML = [...new Set(App.data.purchases.map(p => p.supplier))].map(s => `<option value="${App.esc(s)}">`).join('');
            this.renderPurchaseLines();
            document.getElementById('modalPurchase').classList.add('open');
        },

        renderPurchaseLines() {
            document.getElementById('purLines').innerHTML = `<div class="pur-head"><span>Ingredient</span><span>Quantite</span><span>Prix unitaire</span><span>Total</span><span></span></div>` +
                this.purLines.map((l, i) => {
                    const ing = App.data.ingredients.find(x => x.id === l.ingredientId);
                    return `<div class="pur-line">
                        <select onchange="App.stocks.setPurLine(${i}, 'ingredientId', this.value)" aria-label="Ingredient">${this.options(l.ingredientId)}</select>
                        <input type="number" min="0" step="any" value="${App.esc(l.qty)}" placeholder="${ing ? App.esc(ing.unit) : 'Qte'}" aria-label="Quantite" oninput="App.stocks.setPurLine(${i}, 'qty', this.value)">
                        <input type="number" min="0" step="25" value="${App.esc(l.unitPrice)}" placeholder="FCFA / ${ing ? App.esc(ing.unit) : 'unite'}" aria-label="Prix unitaire" oninput="App.stocks.setPurLine(${i}, 'unitPrice', this.value)">
                        <span class="pur-line-total" data-i="${i}">${App.fmt(Math.round((parseFloat(l.qty) || 0) * (parseInt(l.unitPrice, 10) || 0)))}</span>
                        <button class="pay-line-remove" onclick="App.stocks.removePurLine(${i})" aria-label="Retirer la ligne">&times;</button>
                    </div>`;
                }).join('');
            this.updatePurTotal();
        },

        setPurLine(i, field, value) {
            this.purLines[i][field] = value;
            if (field === 'ingredientId') { this.renderPurchaseLines(); return; }
            const l = this.purLines[i];
            const cell = document.querySelector(`.pur-line-total[data-i="${i}"]`);
            if (cell) cell.textContent = App.fmt(Math.round((parseFloat(l.qty) || 0) * (parseInt(l.unitPrice, 10) || 0)));
            this.updatePurTotal();
        },

        addPurchaseLine() {
            this.purLines.push({ ingredientId: '', qty: '', unitPrice: '' });
            this.renderPurchaseLines();
        },

        removePurLine(i) {
            this.purLines.splice(i, 1);
            if (!this.purLines.length) this.purLines.push({ ingredientId: '', qty: '', unitPrice: '' });
            this.renderPurchaseLines();
        },

        updatePurTotal() {
            const total = this.purLines.reduce((s, l) => s + Math.round((parseFloat(l.qty) || 0) * (parseInt(l.unitPrice, 10) || 0)), 0);
            document.getElementById('purTotal').textContent = App.fmt(total);
        },

        async savePurchase() {
            if (this.busy) return;
            const supplier = document.getElementById('purSupplier').value.trim();
            const date = document.getElementById('purDate').value;
            const lines = this.purLines.filter(l => l.ingredientId || l.qty || l.unitPrice);
            if (!supplier) { App.toast('Indiquez le fournisseur', 'error'); return; }
            if (!lines.length) { App.toast('Ajoutez au moins une ligne', 'error'); return; }
            for (const l of lines) {
                if (!l.ingredientId || !(parseFloat(l.qty) > 0) || l.unitPrice === '' || !(parseInt(l.unitPrice, 10) >= 0)) {
                    App.toast('Chaque ligne doit avoir un ingredient, une quantite et un prix', 'error');
                    return;
                }
            }
            this.busy = true;
            document.getElementById('purSave').disabled = true;
            try {
                await App.serverAction('/purchases', {
                    id: this.pending, supplier, date, note: document.getElementById('purNote').value.trim(),
                    lines: lines.map(l => ({ ingredientId: l.ingredientId, qty: parseFloat(l.qty), unitPrice: parseInt(l.unitPrice, 10) }))
                });
                this.closeModal('modalPurchase');
                App.toast('Achat enregistre : stocks mis a jour');
            } catch (e) {
                App.toast(e.status ? e.message : 'Connexion impossible : achat NON enregistre', 'error');
            } finally {
                this.busy = false;
                document.getElementById('purSave').disabled = false;
            }
        },

        // ---- pertes ----

        openLoss(id) {
            const i = App.data.ingredients.find(x => x.id === id);
            if (!i) return;
            this.lossId = id;
            this.pending = App.genId();
            document.getElementById('lossTitle').textContent = `Perte : ${i.name}`;
            document.getElementById('lossQtyLabel').textContent = `Quantite perdue (${i.unit})`;
            document.getElementById('lossQty').value = '';
            document.getElementById('lossReason').value = '';
            document.getElementById('modalLoss').classList.add('open');
            document.getElementById('lossQty').focus();
        },

        async saveLoss() {
            if (this.busy) return;
            const qty = parseFloat(document.getElementById('lossQty').value);
            const reason = document.getElementById('lossReason').value.trim();
            if (!(qty > 0)) { App.toast('Indiquez la quantite perdue', 'error'); return; }
            if (reason.length < 3) { App.toast('Indiquez le motif', 'error'); return; }
            this.busy = true;
            document.getElementById('lossSave').disabled = true;
            try {
                await App.serverAction('/stock/loss', { id: this.pending, ingredientId: this.lossId, qty, reason });
                this.closeModal('modalLoss');
                App.toast('Perte enregistree');
            } catch (e) {
                App.toast(e.status ? e.message : 'Connexion impossible : perte NON enregistree', 'error');
            } finally {
                this.busy = false;
                document.getElementById('lossSave').disabled = false;
            }
        },

        // ---- inventaire ----

        openInventory() {
            if (!App.data.ingredients.length) { App.toast("Ajoutez d'abord vos ingredients", 'error'); return; }
            this.pending = App.genId();
            const ings = [...App.data.ingredients].sort((a, b) => a.name.localeCompare(b.name));
            document.getElementById('invTitle').textContent = 'Nouvel inventaire';
            document.getElementById('invFooter').style.display = '';
            document.getElementById('invBody').innerHTML = `<p class="form-hint">Comptez ce qui est reellement en reserve et saisissez les quantites. Laissez vide les ingredients non comptes.</p>
                <table class="data-table inv-table">
                    <thead><tr><th>Ingredient</th><th>Theorique</th><th>Compte</th><th>Ecart</th><th>Valeur</th></tr></thead>
                    <tbody>${ings.map(i => `<tr data-id="${i.id}">
                        <td>${App.esc(i.name)}</td>
                        <td class="num">${this.qty(i.stock)} ${App.esc(i.unit)}</td>
                        <td><input type="number" min="0" step="any" class="inv-input" aria-label="Quantite comptee ${App.esc(i.name)}" oninput="App.stocks.updateInventory()"></td>
                        <td class="num inv-diff">—</td>
                        <td class="num inv-value">—</td>
                    </tr>`).join('')}</tbody>
                </table>`;
            this.updateInventory();
            document.getElementById('modalInventory').classList.add('open');
        },

        inventoryLines() {
            return [...document.querySelectorAll('#invBody tr[data-id]')].map(tr => {
                const v = tr.querySelector('.inv-input').value;
                return v === '' ? null : { tr, ingredientId: tr.dataset.id, counted: parseFloat(v) };
            }).filter(Boolean);
        },

        updateInventory() {
            let total = 0, counted = 0;
            document.querySelectorAll('#invBody tr[data-id]').forEach(tr => {
                const i = App.data.ingredients.find(x => x.id === tr.dataset.id);
                const v = tr.querySelector('.inv-input').value;
                const diffCell = tr.querySelector('.inv-diff'), valCell = tr.querySelector('.inv-value');
                if (v === '' || !i) { diffCell.textContent = '—'; valCell.textContent = '—'; diffCell.className = 'num inv-diff'; return; }
                const diff = parseFloat(v) - (i.stock || 0);
                const value = Math.round(diff * (i.avgCost || 0));
                counted++;
                total += value;
                diffCell.textContent = `${diff > 0 ? '+' : ''}${this.qty(diff)} ${i.unit}`;
                diffCell.className = 'num inv-diff ' + (Math.abs(diff) < 1e-9 ? 'diff-ok' : 'diff-bad');
                valCell.textContent = `${value > 0 ? '+' : ''}${App.fmt(value)}`;
            });
            document.getElementById('invTotal').textContent = counted ? `${counted} compte(s) · ecart ${total > 0 ? '+' : ''}${App.fmt(total)}` : '';
        },

        async saveInventory() {
            if (this.busy) return;
            const lines = this.inventoryLines();
            if (!lines.length) { App.toast('Saisissez au moins une quantite comptee', 'error'); return; }
            if (lines.some(l => !(l.counted >= 0))) { App.toast('Quantite invalide', 'error'); return; }
            if (!confirm(`Valider l'inventaire de ${lines.length} ingredient(s) ? Les stocks seront remplaces par les quantites comptees.`)) return;
            this.busy = true;
            document.getElementById('invSave').disabled = true;
            try {
                const res = await App.serverAction('/inventories', { id: this.pending, lines: lines.map(l => ({ ingredientId: l.ingredientId, counted: l.counted })) });
                this.closeModal('modalInventory');
                const inv = res.records && res.records[0] && JSON.parse(res.records[0].data);
                App.toast(inv ? `Inventaire valide · ecart ${inv.totalValue > 0 ? '+' : ''}${App.fmt(inv.totalValue)}` : 'Inventaire valide');
                this.setTab('inventaires');
            } catch (e) {
                App.toast(e.status ? e.message : 'Connexion impossible : inventaire NON enregistre', 'error');
            } finally {
                this.busy = false;
                document.getElementById('invSave').disabled = false;
            }
        },

        showInventory(id) {
            const inv = App.data.inventories.find(x => x.id === id);
            if (!inv) return;
            document.getElementById('invTitle').textContent = `Inventaire du ${new Date(inv.at).toLocaleString('fr-FR')}`;
            document.getElementById('invFooter').style.display = 'none';
            document.getElementById('invBody').innerHTML = `<p class="form-hint">Realise par ${App.esc(inv.staffName || '')}${inv.note ? ' · ' + App.esc(inv.note) : ''}</p>
                <table class="data-table inv-table">
                    <thead><tr><th>Ingredient</th><th>Theorique</th><th>Compte</th><th>Ecart</th><th>Valeur</th></tr></thead>
                    <tbody>${inv.lines.map(l => `<tr>
                        <td>${App.esc(l.name)}</td>
                        <td class="num">${this.qty(l.theoretical)} ${App.esc(l.unit)}</td>
                        <td class="num">${this.qty(l.counted)} ${App.esc(l.unit)}</td>
                        <td class="num ${l.diff ? 'diff-bad' : 'diff-ok'}">${l.diff > 0 ? '+' : ''}${this.qty(l.diff)}</td>
                        <td class="num">${l.value > 0 ? '+' : ''}${App.fmt(l.value)}</td>
                    </tr>`).join('')}</tbody>
                    <tfoot><tr><td colspan="4"><strong>Total des ecarts</strong></td><td class="num"><strong>${inv.totalValue > 0 ? '+' : ''}${App.fmt(inv.totalValue)}</strong></td></tr></tfoot>
                </table>`;
            document.getElementById('modalInventory').classList.add('open');
        },

        // ---- historique ----

        async openMoves(id) {
            const i = App.data.ingredients.find(x => x.id === id);
            if (!i) return;
            document.getElementById('movesTitle').textContent = `Historique : ${i.name}`;
            const body = document.getElementById('movesBody');
            body.innerHTML = '<p class="empty-state">Chargement...</p>';
            document.getElementById('modalMoves').classList.add('open');
            try {
                const { moves } = await App.api('/stock/moves?ingredientId=' + encodeURIComponent(id) + '&limit=150');
                const refLabel = m => {
                    const o = App.data.orders.find(x => x.id === m.ref);
                    if (o) return 'Commande #' + String(o.number).padStart(3, '0');
                    return m.note || '';
                };
                body.innerHTML = moves.length ? `<table class="data-table"><thead><tr><th>Date</th><th>Type</th><th>Quantite</th><th>Detail</th><th>Par</th></tr></thead><tbody>
                    ${moves.map(m => `<tr>
                        <td>${App.esc(new Date(m.at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}</td>
                        <td>${this.KIND_LABELS[m.kind] || App.esc(m.kind)}</td>
                        <td class="num ${m.qty < 0 ? 'neg' : ''}">${m.qty > 0 ? '+' : ''}${this.qty(m.qty)} ${App.esc(i.unit)}</td>
                        <td>${App.esc(refLabel(m))}${m.kind === 'achat' && m.unit_cost != null ? ` · ${App.fmt(m.unit_cost)}/${App.esc(i.unit)}` : ''}</td>
                        <td>${App.esc(m.staff_name || '')}</td>
                    </tr>`).join('')}</tbody></table>` : '<p class="empty-state">Aucun mouvement</p>';
            } catch (e) {
                body.innerHTML = '<p class="empty-state">Historique indisponible hors connexion</p>';
            }
        }
    },

    // CUISINE
    cuisine: {
        seen: null,
        flash: {},
        sound: true,
        audioCtx: null,
        wakeLock: null,
        ticker: null,
        LATE_MIN: 20,
        WARN_MIN: 10,

        init() {
            try { this.sound = localStorage.getItem('sissiman-kitchen-sound') !== '0'; } catch (e) { /* stockage indisponible */ }
            this.updateSoundBtn();
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden && document.body.classList.contains('kitchen-mode')) this.requestWakeLock();
            });
            let remembered = false;
            try { remembered = localStorage.getItem('sissiman-kitchen-mode') === '1'; } catch (e) { /* stockage indisponible */ }
            if (remembered && App.can('page.cuisine')) this.enterKitchenMode(false);
        },

        isActive() {
            return document.getElementById('page-cuisine').classList.contains('active');
        },

        render() {
            const now = Date.now();
            const orders = App.data.orders
                .filter(o => o.status === 'en_cours' || o.status === 'prete')
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            const fresh = orders.filter(o => o.status === 'en_cours' && !o.startedAt);
            const prep = orders.filter(o => o.status === 'en_cours' && o.startedAt);
            const ready = orders.filter(o => o.status === 'prete')
                .sort((a, b) => (a.readyAt || a.createdAt).localeCompare(b.readyAt || b.createdAt));

            // A new order, or new lines on an existing one, rings once and stays highlighted for a while.
            const keys = orders.filter(o => o.status === 'en_cours').map(o => o.id + ':' + o.items.length);
            if (this.seen) {
                const arrivals = keys.filter(k => !this.seen.has(k));
                if (arrivals.length) {
                    arrivals.forEach(k => { this.flash[k.split(':')[0]] = now + 20000; });
                    if (this.sound && (this.isActive() || document.body.classList.contains('kitchen-mode'))) this.playNotif();
                }
            }
            this.seen = new Set(keys);

            document.getElementById('cuisineNew').textContent = fresh.length;
            document.getElementById('cuisinePrep').textContent = prep.length;
            document.getElementById('cuisineReady').textContent = ready.length;

            const col = (title, cls, list, empty) => `<section class="kcol ${cls}">
                <h3 class="kcol-title">${title} <span>${list.length}</span></h3>
                <div class="kcol-list">${list.length ? list.map(o => this.card(o, now)).join('') : `<p class="kcol-empty">${empty}</p>`}</div>
            </section>`;
            document.getElementById('cuisineBoard').innerHTML =
                col('Nouvelles', 'k-new', fresh, 'Aucune nouvelle commande') +
                col('En preparation', 'k-prep', prep, 'Rien en preparation') +
                col('Pretes a servir', 'k-ready', ready, 'Aucune commande en attente du serveur');
            this.renderStatus();
            this.ensureTicker();
        },

        card(o, now) {
            const table = App.data.tables.find(t => t.id === o.tableId);
            const mins = iso => Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
            const age = mins(o.createdAt);
            const level = o.status === 'prete' ? 'ok' : age >= this.LATE_MIN ? 'late' : age >= this.WARN_MIN ? 'warn' : 'ok';
            const received = new Date(o.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
            const flashing = this.flash[o.id] && this.flash[o.id] > now;
            const num = '#' + String(o.number).padStart(3, '0');
            let timer, actions;
            if (o.status === 'prete') {
                timer = `<span class="ktimer ${o.readyAt && mins(o.readyAt) >= 5 ? 'warn' : 'ok'}">Prete depuis ${mins(o.readyAt || o.createdAt)} min</span>`;
                actions = App.can('orders.serve')
                    ? `<button class="kbtn kbtn-serve" onclick="App.orders.updateStatus('${o.id}','servie')">SERVIE</button>`
                    : '<span class="kwait">En attente du serveur</span>';
            } else {
                timer = `<span class="ktimer ${level}">${age} min</span>`;
                const ready = App.can('orders.ready') ? `<button class="kbtn kbtn-ready" onclick="App.cuisine.markReady('${o.id}')">COMMANDE PRETE</button>` : '';
                actions = !o.startedAt && App.can('kitchen.start')
                    ? `<button class="kbtn kbtn-start" onclick="App.cuisine.start('${o.id}')">COMMENCER</button>${ready.replace('kbtn-ready', 'kbtn-ready secondary').replace('COMMANDE PRETE', 'PRETE')}`
                    : ready;
            }
            return `<article class="kcard ${level} ${flashing ? 'flash' : ''}" aria-label="Commande ${num}, ${table ? 'table ' + table.number : 'a emporter'}">
                <header class="kcard-head">
                    <div>
                        <div class="kcard-num">${num} <span>${table ? 'TABLE ' + table.number : 'A EMPORTER'}</span></div>
                        <div class="kcard-meta">Recue a ${App.esc(received)}${o.covers ? ` · ${o.covers} couvert(s)` : ''}</div>
                    </div>
                    ${timer}
                </header>
                <ul class="kcard-items">
                    ${o.items.map(it => `<li class="${it.addedAt ? 'added' : ''}">
                        <span class="kqty">${it.qty}</span>
                        <span class="kname">${App.esc(it.name)}${it.addedAt ? ' <span class="added-badge">AJOUT</span>' : ''}${App.itemDetailHtml(it)}</span>
                    </li>`).join('')}
                </ul>
                ${o.note ? `<div class="kcard-note">${App.esc(o.note)}</div>` : ''}
                <footer class="kcard-actions">
                    ${actions}
                    <button class="kbtn-icon" title="Imprimer le ticket cuisine" aria-label="Imprimer le ticket cuisine" onclick="App.tickets.kitchen('${o.id}')">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                    </button>
                </footer>
            </article>`;
        },

        start(id) {
            const o = App.data.orders.find(x => x.id === id);
            if (!o || o.status !== 'en_cours' || o.startedAt) return;
            o.startedAt = new Date().toISOString();
            App.saveData();
            App.render();
        },

        markReady(id) {
            App.orders.updateStatus(id, 'prete');
            App.toast('Commande prete : le serveur est prevenu');
        },

        // Re-render every 15 s so timers move, and refresh the connection line every second.
        ensureTicker() {
            if (this.ticker) return;
            let n = 0;
            this.ticker = setInterval(() => {
                if (!this.isActive()) return;
                document.getElementById('kitchenClock').textContent = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
                this.renderStatus();
                if (++n % 15 === 0) this.render();
            }, 1000);
        },

        renderStatus() {
            const el = document.getElementById('kitchenConn');
            document.getElementById('kitchenClock').textContent = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
            const s = App.sync;
            const pending = s.pendingCount();
            const since = s.lastOk ? Math.round((Date.now() - s.lastOk) / 1000) : null;
            if (!s.online) {
                const down = s.offlineSince ? Math.max(1, Math.round((Date.now() - s.offlineSince) / 60000)) : 1;
                el.className = 'kitchen-conn offline';
                el.textContent = `Hors ligne depuis ${down} min : les nouvelles commandes n'arrivent plus.` +
                    (pending ? ` ${pending} action(s) seront envoyees au retour du reseau.` : '');
            } else {
                el.className = 'kitchen-conn online';
                el.textContent = since === null ? 'Connexion...' : `En ligne · mis a jour il y a ${since} s` + (pending ? ` · ${pending} envoi(s) en cours` : '');
            }
        },

        async enterKitchenMode(fromClick) {
            document.body.classList.add('kitchen-mode');
            if (!this.isActive()) App.navigateTo('cuisine');
            try { localStorage.setItem('sissiman-kitchen-mode', '1'); } catch (e) { /* stockage indisponible */ }
            if (fromClick) {
                this.unlockAudio();
                try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen(); } catch (e) { /* plein ecran refuse */ }
            }
            this.requestWakeLock();
            this.render();
        },

        async exitKitchenMode() {
            document.body.classList.remove('kitchen-mode');
            try { localStorage.setItem('sissiman-kitchen-mode', '0'); } catch (e) { /* stockage indisponible */ }
            try { if (document.fullscreenElement) await document.exitFullscreen(); } catch (e) { /* ignore */ }
            if (this.wakeLock) { try { await this.wakeLock.release(); } catch (e) { /* ignore */ } this.wakeLock = null; }
        },

        // Keeps a wall-mounted tablet from going to sleep while the kitchen screen is shown.
        async requestWakeLock() {
            if (!('wakeLock' in navigator) || this.wakeLock) return;
            try {
                this.wakeLock = await navigator.wakeLock.request('screen');
                this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
            } catch (e) { /* refuse par le navigateur */ }
        },

        toggleSound() {
            this.sound = !this.sound;
            try { localStorage.setItem('sissiman-kitchen-sound', this.sound ? '1' : '0'); } catch (e) { /* stockage indisponible */ }
            this.updateSoundBtn();
            if (this.sound) { this.unlockAudio(); this.playNotif(); }
        },

        updateSoundBtn() {
            const b = document.getElementById('kitchenSoundBtn');
            if (!b) return;
            b.textContent = this.sound ? 'Son : active' : 'Son : coupe';
            b.setAttribute('aria-pressed', this.sound ? 'true' : 'false');
        },

        // Browsers only allow audio after a user gesture; creating the context on a click keeps later beeps working.
        unlockAudio() {
            try {
                if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
            } catch (e) { /* audio indisponible */ }
        },

        playNotif(soft) {
            try {
                if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                const ctx = this.audioCtx;
                const notes = soft ? [660, 880] : [880, 1100, 880, 1100];
                notes.forEach((f, i) => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.connect(gain);
                    gain.connect(ctx.destination);
                    osc.type = 'sine';
                    const t = ctx.currentTime + i * 0.18;
                    osc.frequency.setValueAtTime(f, t);
                    gain.gain.setValueAtTime(soft ? 0.15 : 0.3, t);
                    gain.gain.exponentialRampToValueAtTime(0.01, t + 0.16);
                    osc.start(t);
                    osc.stop(t + 0.17);
                });
            } catch (e) { /* audio indisponible */ }
        }
    },

    // RAPPORTS
    // Each report builds one model (kpis + sections); the screen, the PDF and the Excel export all read that model.
    rapports: {
        type: 'jour',
        date: null,
        month: null,
        model: null,
        loading: 0,
        tipsBound: false,
        KINDS: { achat: 'Achats', vente: 'Consommation (ventes)', annulation: 'Retours (annulations)', perte: 'Pertes', inventaire: "Ecarts d'inventaire" },

        ymd(d) {
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        },

        ensurePeriod() {
            const now = new Date();
            if (!this.date) this.date = this.ymd(now);
            if (!this.month) this.month = this.date.slice(0, 7);
        },

        setType(type) {
            this.type = type;
            document.querySelectorAll('.report-tabs .stock-tab').forEach(b => {
                const on = b.dataset.report === type;
                b.classList.toggle('active', on);
                b.setAttribute('aria-selected', on);
            });
            this.render();
        },

        setPeriod(v) {
            if (!v) return;
            if (v.length === 7) { this.month = v; this.date = v + '-01'; } else { this.date = v; this.month = v.slice(0, 7); }
            this.render();
        },

        range() {
            this.ensurePeriod();
            const [y, m, d] = this.date.split('-').map(Number);
            if (this.type === 'jour') {
                const a = new Date(y, m - 1, d);
                return [a.getTime(), new Date(y, m - 1, d + 1).getTime()];
            }
            if (this.type === 'semaine') {
                const day = new Date(y, m - 1, d);
                const monday = new Date(y, m - 1, d - (day.getDay() + 6) % 7);
                return [monday.getTime(), new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7).getTime()];
            }
            const [my, mm] = this.month.split('-').map(Number);
            return [new Date(my, mm - 1, 1).getTime(), new Date(my, mm, 1).getTime()];
        },

        inR(iso, r) {
            const t = new Date(iso).getTime();
            return t >= r[0] && t < r[1];
        },

        sum(list, f) {
            return list.reduce((s, x) => s + (f(x) || 0), 0);
        },

        dt(iso) {
            return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        },

        num(o) {
            return '#' + String(o.number || o.orderNumber).padStart(3, '0');
        },

        tableNum(id) {
            const t = App.data.tables.find(x => x.id === id);
            return t ? 'T' + t.number : 'A emporter';
        },

        dishStats(orders) {
            const agg = {};
            orders.forEach(o => o.items.forEach(it => {
                const a = agg[it.menuId || it.name] || (agg[it.menuId || it.name] = { menuId: it.menuId, name: it.name, qty: 0, amount: 0 });
                a.qty += it.qty;
                a.amount += App.lineTotal(it);
            }));
            return Object.values(agg).sort((a, b) => b.qty - a.qty || b.amount - a.amount);
        },

        sales(r) {
            const orders = App.data.orders.filter(o => this.inR(o.createdAt, r));
            const valid = orders.filter(o => o.status !== 'annulee');
            const payments = App.data.payments.filter(p => this.inR(p.paidAt, r));
            const refunds = App.data.refunds.filter(x => this.inR(x.at, r));
            const revenue = this.sum(valid, o => o.total);
            return {
                orders, valid, payments, refunds, revenue,
                cancelled: orders.filter(o => o.status === 'annulee'),
                cash: this.sum(payments, p => p.amount) - this.sum(refunds, x => x.amount),
                avg: valid.length ? Math.round(revenue / valid.length) : 0,
                covers: this.sum(valid, o => o.covers || 1)
            };
        },

        methodsTable(payments, refunds) {
            const methods = ['especes', 'mobile', 'carte'];
            const totalNet = this.sum(payments, p => p.amount) - this.sum(refunds, x => x.amount);
            const rows = methods.map(m => {
                const ps = payments.filter(p => p.method === m), rs = refunds.filter(x => x.method === m);
                const net = this.sum(ps, p => p.amount) - this.sum(rs, x => x.amount);
                return [App.methodLabel(m), ps.length, this.sum(ps, p => p.amount), this.sum(rs, x => x.amount), net, totalNet ? net / totalNet * 100 : 0];
            });
            return {
                columns: [{ label: 'Mode', type: 'text' }, { label: 'Paiements', type: 'int' }, { label: 'Encaisse', type: 'money' },
                    { label: 'Rembourse', type: 'money' }, { label: 'Net', type: 'money' }, { label: 'Part', type: 'pct' }],
                rows,
                total: ['Total', payments.length, this.sum(payments, p => p.amount), this.sum(refunds, x => x.amount), totalNet, totalNet ? 100 : 0]
            };
        },

        dishTable(orders, limit) {
            const dishes = this.dishStats(orders).slice(0, limit || 1000);
            return {
                columns: [{ label: 'Plat', type: 'text' }, { label: 'Quantite', type: 'int' }, { label: "Chiffre d'affaires", type: 'money' }],
                rows: dishes.map(d => [d.name, d.qty, d.amount]),
                total: limit ? null : ['Total', this.sum(dishes, d => d.qty), this.sum(dishes, d => d.amount)]
            };
        },

        refundsTable(refunds) {
            return {
                columns: [{ label: 'Date', type: 'text' }, { label: 'Commande', type: 'text' }, { label: 'Mode', type: 'text' },
                    { label: 'Montant', type: 'money' }, { label: 'Motif', type: 'text' }, { label: 'Par', type: 'text' }],
                rows: refunds.map(x => [this.dt(x.at), this.num(x), App.methodLabel(x.method), x.amount, x.reason, x.staffName || ''])
            };
        },

        // ---------- modeles ----------

        dayModel() {
            const r = this.range();
            const s = this.sales(r);
            const byHour = {};
            s.valid.forEach(o => {
                const h = new Date(o.createdAt).getHours();
                const b = byHour[h] || (byHour[h] = { n: 0, amount: 0 });
                b.n++; b.amount += o.total;
            });
            const hours = Object.keys(byHour).map(Number);
            const groups = [];
            if (hours.length) for (let h = Math.min(8, ...hours); h <= Math.max(22, ...hours); h++) {
                groups.push({ label: h + 'h', title: `${h}h - ${h + 1}h`, values: [byHour[h] ? byHour[h].amount : 0] });
            }
            const sections = [
                { title: 'Encaissements par moyen de paiement', table: this.methodsTable(s.payments, s.refunds) },
                {
                    title: 'Ventes par heure', chart: groups.length ? { groups, series: [{ name: "Chiffre d'affaires" }] } : null,
                    table: {
                        columns: [{ label: 'Heure', type: 'text' }, { label: 'Commandes', type: 'int' }, { label: "Chiffre d'affaires", type: 'money' }],
                        rows: hours.sort((a, b) => a - b).map(h => [`${h}h - ${h + 1}h`, byHour[h].n, byHour[h].amount])
                    }
                },
                { title: 'Plats vendus', table: this.dishTable(s.valid) }
            ];
            if (s.cancelled.length) sections.push({
                title: 'Commandes annulees',
                table: {
                    columns: [{ label: 'Commande', type: 'text' }, { label: 'Heure', type: 'text' }, { label: 'Table', type: 'text' }, { label: 'Montant', type: 'money' }],
                    rows: s.cancelled.map(o => [this.num(o), this.dt(o.createdAt), this.tableNum(o.tableId), o.total]),
                    total: ['Total', '', '', this.sum(s.cancelled, o => o.total)]
                }
            });
            if (s.refunds.length) sections.push({ title: 'Remboursements', table: this.refundsTable(s.refunds) });
            return {
                title: 'Rapport journalier',
                period: new Date(r[0]).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
                kpis: [
                    { label: "Chiffre d'affaires", value: s.revenue, type: 'money', sub: `${s.valid.length} commande(s)` },
                    { label: 'Encaisse net', value: s.cash, type: 'money', sub: `Remboursements ${App.fmt(this.sum(s.refunds, x => x.amount))}` },
                    { label: 'Annulations', value: s.cancelled.length, type: 'int', sub: App.fmt(this.sum(s.cancelled, o => o.total)) },
                    { label: 'Panier moyen', value: s.avg, type: 'money', sub: `${s.covers} couvert(s)` }
                ],
                sections
            };
        },

        weekModel() {
            const r = this.range();
            const s = this.sales(r);
            const prev = this.sales([r[0] - 7 * 86400000, r[0]]);
            const days = [];
            for (let i = 0; i < 7; i++) {
                const a = new Date(r[0]); a.setDate(a.getDate() + i);
                const b = new Date(a); b.setDate(b.getDate() + 1);
                const d = this.sales([a.getTime(), b.getTime()]);
                days.push({ date: a, label: a.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }), full: a.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }), ...d });
            }
            const delta = prev.revenue ? Math.round((s.revenue - prev.revenue) / prev.revenue * 100) : null;
            const best = [...days].sort((a, b) => b.revenue - a.revenue)[0];
            const end = new Date(r[1] - 1);
            return {
                title: 'Rapport hebdomadaire',
                period: `Semaine du ${new Date(r[0]).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })} au ${end.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}`,
                kpis: [
                    { label: "Chiffre d'affaires", value: s.revenue, type: 'money', sub: delta === null ? 'Pas de comparaison' : `${delta > 0 ? '+' : ''}${delta} % vs semaine precedente` },
                    { label: 'Encaisse net', value: s.cash, type: 'money', sub: `${s.payments.length} paiement(s)` },
                    { label: 'Commandes', value: s.valid.length, type: 'int', sub: `${s.cancelled.length} annulee(s)` },
                    { label: 'Panier moyen', value: s.avg, type: 'money', sub: best && best.revenue ? `Meilleur jour : ${best.full}` : '' }
                ],
                sections: [
                    {
                        title: 'Ventes par jour',
                        chart: { groups: days.map(d => ({ label: d.label, title: d.full, values: [d.revenue, d.cash] })), series: [{ name: "Chiffre d'affaires" }, { name: 'Encaisse' }] },
                        table: {
                            columns: [{ label: 'Jour', type: 'text' }, { label: 'Commandes', type: 'int' }, { label: "Chiffre d'affaires", type: 'money' },
                                { label: 'Encaisse net', type: 'money' }, { label: 'Panier moyen', type: 'money' }],
                            rows: days.map(d => [d.full, d.valid.length, d.revenue, d.cash, d.avg]),
                            total: ['Total', s.valid.length, s.revenue, s.cash, s.avg]
                        }
                    },
                    {
                        title: 'Jours les plus rentables',
                        table: {
                            columns: [{ label: 'Rang', type: 'int' }, { label: 'Jour', type: 'text' }, { label: "Chiffre d'affaires", type: 'money' }, { label: 'Part', type: 'pct' }],
                            rows: [...days].sort((a, b) => b.revenue - a.revenue).map((d, i) => [i + 1, d.full, d.revenue, s.revenue ? d.revenue / s.revenue * 100 : 0])
                        }
                    },
                    { title: 'Plats les plus vendus', table: this.dishTable(s.valid, 15) }
                ]
            };
        },

        stockCache: {},

        // Cached for a minute: the page re-renders on every sync and must not refetch each time.
        async stockData(r) {
            const key = r.join('-');
            const c = this.stockCache[key];
            if (c && Date.now() - c.at < 60000) return c.data;
            try {
                const data = await App.api(`/reports/stock?from=${r[0]}&to=${r[1]}`);
                this.stockCache[key] = { at: Date.now(), data };
                return data;
            } catch (e) {
                return c ? c.data : null;
            }
        },

        async monthModel() {
            const r = this.range();
            const s = this.sales(r);
            const st = await this.stockData(r);
            const kind = k => st ? this.sum(st.byKind.filter(x => x.kind === k), x => x.value) : 0;
            const materialCost = st ? -(kind('vente') + kind('annulation')) || 0 : null;
            const losses = st ? -kind('perte') : null;
            const invAdj = st ? kind('inventaire') : null;
            const margin = materialCost === null ? null : s.revenue - materialCost;
            const purchases = App.data.purchases.filter(p => p.date.slice(0, 7) === this.month);
            const spent = this.sum(purchases, p => p.total);

            const days = [];
            const cursor = new Date(r[0]);
            while (cursor.getTime() < r[1]) {
                const b = new Date(cursor); b.setDate(b.getDate() + 1);
                const d = this.sales([cursor.getTime(), b.getTime()]);
                days.push({ label: String(cursor.getDate()), title: cursor.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }), ...d });
                cursor.setDate(cursor.getDate() + 1);
            }

            const recipeCost = m => App.menu.recipeCostOf(m && m.recipe);
            const dishes = this.dishStats(s.valid).map(d => {
                const m = App.data.menuItems.find(x => x.id === d.menuId);
                const cost = m && m.recipe ? Math.round(recipeCost(m) * d.qty) : null;
                return [d.name, d.qty, d.amount, cost, cost === null ? null : d.amount - cost, cost === null || !d.amount ? null : (d.amount - cost) / d.amount * 100];
            });
            const bySupplier = {};
            purchases.forEach(p => { const b = bySupplier[p.supplier] || (bySupplier[p.supplier] = { n: 0, amount: 0 }); b.n++; b.amount += p.total; });

            const monthLabel = new Date(r[0]).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
            return {
                title: 'Rapport mensuel',
                period: monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1),
                kpis: [
                    { label: "Chiffre d'affaires", value: s.revenue, type: 'money', sub: `${s.valid.length} commande(s) · panier ${App.fmt(s.avg)}` },
                    { label: 'Encaisse net', value: s.cash, type: 'money', sub: `Remboursements ${App.fmt(this.sum(s.refunds, x => x.amount))}` },
                    { label: 'Cout matiere estime', value: materialCost, type: 'money', sub: materialCost === null ? 'Indisponible hors connexion' : 'Ingredients consommes par les ventes' },
                    { label: 'Marge brute estimee', value: margin, type: 'money', sub: margin === null || !s.revenue ? '' : `${(margin / s.revenue * 100).toFixed(1).replace('.', ',')} % du chiffre d'affaires` },
                    { label: 'Achats fournisseurs', value: spent, type: 'money', sub: `${purchases.length} achat(s)` },
                    { label: 'Pertes', value: losses, type: 'money', sub: invAdj === null ? '' : `Ecarts d'inventaire ${invAdj > 0 ? '+' : ''}${App.fmt(Math.round(invAdj))}` }
                ],
                sections: [
                    {
                        title: 'Compte de resultat simplifie',
                        note: 'Le cout matiere est calcule a partir des recettes des plats et du cout moyen des ingredients au moment de chaque vente.',
                        table: {
                            columns: [{ label: 'Poste', type: 'text' }, { label: 'Montant', type: 'money' }],
                            rows: [
                                ["Chiffre d'affaires", s.revenue],
                                ['Cout matiere consomme', materialCost === null ? null : -materialCost],
                                ['Marge brute', margin],
                                ['Pertes declarees', losses === null ? null : -losses],
                                ["Ecarts d'inventaire", invAdj],
                                ['Marge apres pertes et ecarts', margin === null ? null : margin - losses + invAdj]
                            ]
                        }
                    },
                    {
                        title: 'Evolution journaliere',
                        chart: { groups: days.map(d => ({ label: d.label, title: d.title, values: [d.revenue] })), series: [{ name: "Chiffre d'affaires" }] },
                        table: {
                            columns: [{ label: 'Jour', type: 'text' }, { label: 'Commandes', type: 'int' }, { label: "Chiffre d'affaires", type: 'money' }, { label: 'Encaisse net', type: 'money' }],
                            rows: days.filter(d => d.orders.length || d.payments.length).map(d => [d.title, d.valid.length, d.revenue, d.cash]),
                            total: ['Total', s.valid.length, s.revenue, s.cash]
                        }
                    },
                    {
                        title: 'Marge par plat',
                        note: 'Estimation avec les recettes et les couts moyens actuels. Les plats sans recette n\'ont pas de cout.',
                        table: {
                            columns: [{ label: 'Plat', type: 'text' }, { label: 'Quantite', type: 'int' }, { label: "Chiffre d'affaires", type: 'money' },
                                { label: 'Cout estime', type: 'money' }, { label: 'Marge', type: 'money' }, { label: 'Taux', type: 'pct' }],
                            rows: dishes
                        }
                    },
                    {
                        title: 'Depenses par fournisseur',
                        table: {
                            columns: [{ label: 'Fournisseur', type: 'text' }, { label: 'Achats', type: 'int' }, { label: 'Montant', type: 'money' }],
                            rows: Object.entries(bySupplier).sort((a, b) => b[1].amount - a[1].amount).map(([k, v]) => [k, v.n, v.amount]),
                            total: ['Total', purchases.length, spent]
                        }
                    }
                ]
            };
        },

        async stockModel() {
            const r = this.range();
            const st = await this.stockData(r);
            const ings = [...App.data.ingredients].sort((a, b) => a.name.localeCompare(b.name));
            const labels = { ok: 'OK', bas: 'Stock bas', rupture: 'Rupture' };
            const value = this.sum(ings, i => Math.max(0, i.stock || 0) * (i.avgCost || 0));
            const purchases = App.data.purchases.filter(p => p.date.slice(0, 7) === this.month);
            const kindVal = k => st ? this.sum(st.byKind.filter(x => x.kind === k), x => x.value) : null;
            const monthLabel = new Date(r[0]).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
            const sections = [{
                title: 'Etat du stock (aujourd\'hui)',
                table: {
                    columns: [{ label: 'Ingredient', type: 'text' }, { label: 'Stock', type: 'qty' }, { label: 'Unite', type: 'text' }, { label: 'Seuil', type: 'qty' },
                        { label: 'Etat', type: 'text' }, { label: 'Cout moyen', type: 'money' }, { label: 'Valeur', type: 'money' }],
                    rows: ings.map(i => [i.name, i.stock || 0, i.unit, i.threshold || 0, labels[App.stocks.level(i)], Math.round(i.avgCost || 0), Math.round(Math.max(0, i.stock || 0) * (i.avgCost || 0))]),
                    total: ['Total', '', '', '', '', '', Math.round(value)]
                }
            }];
            if (st) {
                sections.push({
                    title: 'Mouvements du mois',
                    table: {
                        columns: [{ label: 'Type', type: 'text' }, { label: 'Mouvements', type: 'int' }, { label: 'Valeur', type: 'money' }],
                        rows: st.byKind.map(k => [this.KINDS[k.kind] || k.kind, k.n, Math.round(k.value)])
                    }
                });
                sections.push({
                    title: 'Consommation et pertes par ingredient',
                    table: {
                        columns: [{ label: 'Ingredient', type: 'text' }, { label: 'Consomme', type: 'qty' }, { label: 'Unite', type: 'text' },
                            { label: 'Valeur consommee', type: 'money' }, { label: 'Perdu', type: 'qty' }, { label: 'Valeur perdue', type: 'money' }],
                        rows: st.byIngredient.filter(x => x.name).sort((a, b) => a.consumedValue - b.consumedValue)
                            .map(x => [x.name, -x.consumed, x.unit, Math.round(-x.consumedValue), -x.lost, Math.round(-x.lostValue)])
                    }
                });
                if (st.losses.length) sections.push({
                    title: 'Pertes declarees',
                    table: {
                        columns: [{ label: 'Date', type: 'text' }, { label: 'Ingredient', type: 'text' }, { label: 'Quantite', type: 'qty' },
                            { label: 'Unite', type: 'text' }, { label: 'Valeur', type: 'money' }, { label: 'Motif', type: 'text' }, { label: 'Par', type: 'text' }],
                        rows: st.losses.map(l => [this.dt(l.at), l.name || '?', -l.qty, l.unit || '', Math.round(-l.value), l.note || '', l.staff_name || ''])
                    }
                });
            }
            sections.push({
                title: 'Achats du mois',
                table: {
                    columns: [{ label: 'Date', type: 'text' }, { label: 'Fournisseur', type: 'text' }, { label: 'Articles', type: 'text' }, { label: 'Montant', type: 'money' }],
                    rows: purchases.sort((a, b) => a.date.localeCompare(b.date)).map(p => [
                        new Date(p.date + 'T12:00:00').toLocaleDateString('fr-FR'), p.supplier,
                        p.lines.map(l => `${App.stocks.qty(l.qty)} ${l.unit} ${l.name}`).join(', '), p.total]),
                    total: ['Total', '', '', this.sum(purchases, p => p.total)]
                }
            });
            const low = ings.filter(i => App.stocks.level(i) === 'bas').length;
            const out = ings.filter(i => App.stocks.level(i) === 'rupture').length;
            return {
                title: 'Rapport des stocks',
                period: monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1),
                kpis: [
                    { label: 'Valeur du stock', value: Math.round(value), type: 'money', sub: `${ings.length} ingredient(s), a ce jour` },
                    { label: 'Ruptures / stock bas', value: out + low, type: 'int', sub: `${out} rupture(s), ${low} stock(s) bas` },
                    { label: 'Achats du mois', value: this.sum(purchases, p => p.total), type: 'money', sub: `${purchases.length} achat(s)` },
                    { label: 'Pertes du mois', value: st ? Math.round(-kindVal('perte')) : null, type: 'money', sub: st ? `Ecarts d'inventaire ${App.fmt(Math.round(kindVal('inventaire')))}` : 'Indisponible hors connexion' }
                ],
                sections
            };
        },

        cashModel() {
            const r = this.range();
            const sessions = App.data.cashSessions.filter(x => this.inR(x.openedAt, r)).sort((a, b) => a.openedAt.localeCompare(b.openedAt));
            const closed = sessions.filter(x => x.status === 'fermee');
            const payments = App.data.payments.filter(p => this.inR(p.paidAt, r));
            const refunds = App.data.refunds.filter(x => this.inR(x.at, r));
            const gaps = closed.filter(x => x.diff);
            const byStaff = {};
            payments.forEach(p => { const b = byStaff[p.staffName || '?'] || (byStaff[p.staffName || '?'] = { n: 0, amount: 0 }); b.n++; b.amount += p.amount; });
            const monthLabel = new Date(r[0]).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
            return {
                title: 'Rapport de caisse',
                period: monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1),
                kpis: [
                    { label: 'Sessions de caisse', value: sessions.length, type: 'int', sub: `${sessions.length - closed.length} encore ouverte(s)` },
                    { label: 'Encaisse', value: this.sum(payments, p => p.amount), type: 'money', sub: `${payments.length} paiement(s)` },
                    { label: 'Remboursements', value: this.sum(refunds, x => x.amount), type: 'money', sub: `${refunds.length} remboursement(s)` },
                    { label: 'Ecart cumule', value: this.sum(closed, x => x.diff), type: 'money', sub: `${gaps.length} session(s) avec ecart` }
                ],
                sections: [
                    {
                        title: 'Sessions de caisse',
                        table: {
                            columns: [{ label: 'Caissier', type: 'text' }, { label: 'Ouverture', type: 'text' }, { label: 'Cloture', type: 'text' },
                                { label: 'Fonds', type: 'money' }, { label: 'Attendu', type: 'money' }, { label: 'Compte', type: 'money' },
                                { label: 'Ecart', type: 'money' }, { label: 'Commentaire', type: 'text' }],
                            rows: sessions.map(x => [x.staffName, this.dt(x.openedAt), x.closedAt ? this.dt(x.closedAt) : 'Ouverte',
                                x.openingFloat, x.status === 'fermee' ? x.expectedCash : App.cash.expected(x), x.status === 'fermee' ? x.countedCash : null,
                                x.status === 'fermee' ? x.diff : null, x.note || '']),
                            total: ['Total', '', '', '', this.sum(closed, x => x.expectedCash), this.sum(closed, x => x.countedCash), this.sum(closed, x => x.diff), '']
                        }
                    },
                    { title: 'Encaissements par moyen de paiement', table: this.methodsTable(payments, refunds) },
                    {
                        title: 'Encaissements par caissier',
                        table: {
                            columns: [{ label: 'Caissier', type: 'text' }, { label: 'Paiements', type: 'int' }, { label: 'Montant', type: 'money' }],
                            rows: Object.entries(byStaff).sort((a, b) => b[1].amount - a[1].amount).map(([k, v]) => [k, v.n, v.amount])
                        }
                    },
                    { title: 'Remboursements', table: this.refundsTable(refunds) }
                ]
            };
        },

        async build() {
            if (this.type === 'jour') return this.dayModel();
            if (this.type === 'semaine') return this.weekModel();
            if (this.type === 'mois') return this.monthModel();
            if (this.type === 'stocks') return this.stockModel();
            return this.cashModel();
        },

        // ---------- rendu ----------

        fmtCell(v, type) {
            if (v === '') return '';
            if (v === null || v === undefined) return type === 'text' ? '' : '—';
            if (type === 'money') return App.fmt(Math.round(v) || 0);
            if (type === 'int') return (Math.round(v) || 0).toLocaleString('fr-FR');
            if (type === 'qty') return App.stocks.qty(v);
            if (type === 'pct') return `${v.toFixed(1).replace('.', ',')} %`;
            return String(v);
        },

        tableHtml(t) {
            if (!t.rows.length) return '<p class="report-empty">Aucune donnee sur la periode</p>';
            const cls = c => c.type === 'text' ? '' : ' class="num"';
            return `<div class="table-scroll"><table class="data-table report-table">
                <thead><tr>${t.columns.map(c => `<th${cls(c)}>${App.esc(c.label)}</th>`).join('')}</tr></thead>
                <tbody>${t.rows.map(r => `<tr>${r.map((v, i) => `<td${cls(t.columns[i])}>${App.esc(this.fmtCell(v, t.columns[i].type))}</td>`).join('')}</tr>`).join('')}</tbody>
                ${t.total ? `<tfoot><tr>${t.total.map((v, i) => `<td${cls(t.columns[i])}><strong>${App.esc(i === 0 ? v : this.fmtCell(v, t.columns[i].type))}</strong></td>`).join('')}</tr></tfoot>` : ''}
            </table></div>`;
        },

        kpiHtml(k) {
            return `<div class="kpi"><span class="kpi-label">${App.esc(k.label)}</span><span class="kpi-value">${App.esc(this.fmtCell(k.value, k.type))}</span>${k.sub ? `<span class="kpi-sub">${App.esc(k.sub)}</span>` : ''}</div>`;
        },

        async render() {
            const view = document.getElementById('reportView');
            if (!view || !document.getElementById('page-rapports').classList.contains('active')) return;
            this.ensurePeriod();
            const monthly = this.type !== 'jour' && this.type !== 'semaine';
            document.getElementById('reportDate').hidden = monthly;
            document.getElementById('reportMonth').hidden = !monthly;
            document.getElementById('reportDate').value = this.date;
            document.getElementById('reportMonth').value = this.month;
            document.getElementById('reportPeriodLabel').textContent = this.type === 'jour' ? 'Jour' : this.type === 'semaine' ? 'Semaine du' : 'Mois';
            if (!this.tipsBound) { App.dashboard.bindTips(document.getElementById('page-rapports')); this.tipsBound = true; }
            const ticket = ++this.loading;
            view.classList.add('loading');
            const model = await this.build();
            if (ticket !== this.loading) return;
            view.classList.remove('loading');
            const signature = JSON.stringify(model) + view.clientWidth;
            if (signature === this.signature && view.querySelector('.report-head')) return;
            this.signature = signature;
            this.model = model;
            view.innerHTML = `<div class="report-head"><h2>${App.esc(model.title)}</h2><span>${App.esc(model.period)}</span></div>
                <div class="kpi-grid report-kpis">${model.kpis.map(k => this.kpiHtml(k)).join('')}</div>
                ${model.sections.map((s, i) => `<section class="panel report-section">
                    <div class="chart-head"><div><h3>${App.esc(s.title)}</h3>${s.note ? `<p class="chart-sub">${App.esc(s.note)}</p>` : ''}</div></div>
                    ${s.chart ? `${s.chart.series.length > 1 ? `<div class="chart-legend">${s.chart.series.map((x, j) => `<span class="legend-item"><span class="legend-swatch s${j + 1}"></span>${App.esc(x.name)}</span>`).join('')}</div>` : ''}<div class="report-chart" data-i="${i}"></div>` : ''}
                    ${this.tableHtml(s.table)}
                </section>`).join('')}`;
            view.querySelectorAll('.report-chart').forEach(el => {
                const s = model.sections[el.dataset.i];
                el.innerHTML = App.dashboard.columns(el, s.chart);
            });
        },

        // ---------- exports ----------

        fileName(ext) {
            const p = this.type === 'jour' || this.type === 'semaine' ? this.date : this.month;
            return `sissiman-rapport-${this.type}-${p}.${ext}`;
        },

        async exportPdf() {
            const m = this.model || await this.build();
            const charts = m.sections.map(s => s.chart ? App.dashboard.columns({ clientWidth: 680 }, s.chart) : '');
            App.tickets.print(`<header class="rp-head">
                    <div><div class="rp-name">Restaurant Sissiman</div><div>Bobo-Dioulasso, Burkina Faso</div></div>
                    <div class="rp-title"><strong>${App.esc(m.title)}</strong><span>${App.esc(m.period)}</span></div>
                </header>
                <div class="rp-kpis">${m.kpis.map(k => `<div><span>${App.esc(k.label)}</span><strong>${App.esc(this.fmtCell(k.value, k.type))}</strong>${k.sub ? `<small>${App.esc(k.sub)}</small>` : ''}</div>`).join('')}</div>
                ${m.sections.map((s, i) => `<section class="rp-section"><h3>${App.esc(s.title)}</h3>${s.note ? `<p class="rp-note">${App.esc(s.note)}</p>` : ''}${charts[i]}${this.tableHtml(s.table)}</section>`).join('')}
                <footer class="rp-foot">Edite le ${App.esc(new Date().toLocaleString('fr-FR'))} par ${App.esc(App.currentUser ? App.currentUser.name : '')}</footer>`, 'report-print');
        },

        async exportExcel() {
            const m = this.model || await this.build();
            const cell = (v, type) => v === null || v === undefined ? '' : type === 'pct' ? Math.round(v * 10) / 10 : type === 'money' ? Math.round(v) : v;
            const sheets = [{
                name: 'Resume',
                widths: [34, 20, 50],
                rows: [
                    [{ v: 'Restaurant Sissiman - ' + m.title, bold: true }],
                    [m.period],
                    [],
                    [{ v: 'Indicateur', bold: true }, { v: 'Valeur', bold: true }, { v: 'Detail', bold: true }],
                    ...m.kpis.map(k => [k.label, cell(k.value, k.type), k.sub || ''])
                ]
            }];
            m.sections.forEach(s => {
                const t = s.table;
                sheets.push({
                    name: s.title,
                    widths: t.columns.map(c => c.type === 'text' ? 28 : 16),
                    rows: [
                        [{ v: s.title, bold: true }],
                        ...(s.note ? [[s.note]] : []),
                        [],
                        t.columns.map(c => ({ v: c.label + (c.type === 'money' ? ' (FCFA)' : c.type === 'pct' ? ' (%)' : ''), bold: true })),
                        ...t.rows.map(r => r.map((v, i) => cell(v, t.columns[i].type))),
                        ...(t.total ? [t.total.map((v, i) => ({ v: i === 0 ? v : cell(v, t.columns[i].type), bold: true }))] : [])
                    ]
                });
            });
            const blob = App.xlsx.build(sheets);
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = this.fileName('xlsx');
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
            App.toast('Fichier Excel telecharge');
        }
    },

    // Minimal XLSX writer (stored ZIP + SpreadsheetML), so exports need no third-party library or network access.
    xlsx: {
        crcTable: null,

        crc32(bytes) {
            if (!this.crcTable) {
                this.crcTable = new Uint32Array(256);
                for (let n = 0; n < 256; n++) {
                    let c = n;
                    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
                    this.crcTable[n] = c >>> 0;
                }
            }
            let crc = 0xFFFFFFFF;
            for (let i = 0; i < bytes.length; i++) crc = this.crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
            return (crc ^ 0xFFFFFFFF) >>> 0;
        },

        zip(files) {
            const enc = new TextEncoder();
            const parts = [], central = [];
            let offset = 0;
            const u16 = n => [n & 0xFF, (n >>> 8) & 0xFF];
            const u32 = n => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];
            for (const f of files) {
                const name = enc.encode(f.name);
                const data = enc.encode(f.data);
                const crc = this.crc32(data);
                const head = [0x50, 0x4B, 0x03, 0x04, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
                    ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)];
                parts.push(new Uint8Array(head), name, data);
                central.push(new Uint8Array([0x50, 0x4B, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
                    ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
                    ...u32(0), ...u32(offset)]), name);
                offset += head.length + name.length + data.length;
            }
            const centralSize = central.reduce((s, p) => s + p.length, 0);
            const end = new Uint8Array([0x50, 0x4B, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
                ...u32(centralSize), ...u32(offset), ...u16(0)]);
            return new Blob([...parts, ...central, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        },

        esc(s) {
            return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
                .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
        },

        col(i) {
            let s = '';
            for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s;
            return s;
        },

        sheetXml(sheet) {
            const rows = sheet.rows.map((row, r) => `<row r="${r + 1}">${row.map((c, i) => {
                const cell = c && typeof c === 'object' ? c : { v: c };
                const ref = this.col(i) + (r + 1);
                if (cell.v === '' || cell.v === null || cell.v === undefined) return '';
                if (typeof cell.v === 'number' && Number.isFinite(cell.v)) {
                    const style = cell.bold ? 4 : Number.isInteger(cell.v) ? 2 : 3;
                    return `<c r="${ref}" s="${style}"><v>${cell.v}</v></c>`;
                }
                return `<c r="${ref}" t="inlineStr"${cell.bold ? ' s="1"' : ''}><is><t xml:space="preserve">${this.esc(cell.v)}</t></is></c>`;
            }).join('')}</row>`).join('');
            const cols = (sheet.widths || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
            return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${rows}</sheetData></worksheet>`;
        },

        build(sheets) {
            const used = new Set();
            const names = sheets.map(s => {
                let base = s.name.replace(/[\[\]:*?\/\\]/g, ' ').slice(0, 28).trim() || 'Feuille';
                let name = base, n = 2;
                while (used.has(name.toLowerCase())) name = `${base.slice(0, 26)} ${n++}`;
                used.add(name.toLowerCase());
                return name;
            });
            const files = [
                { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
                { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
                { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${this.esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
                { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
                { name: 'xl/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
                ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: this.sheetXml(s) }))
            ];
            return this.zip(files);
        }
    },

    // PERSONNEL
    personnel: {
        editingId: null,

        render() {
            const grid = document.getElementById('personnelGrid');
            const staffList = App.staff;
            const canManage = App.can('staff.manage');
            const owner = App.currentUser && App.currentUser.role === 'proprietaire';

            grid.innerHTML = staffList.map(s => {
                const initials = s.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
                const touchable = canManage && (owner || s.role !== 'proprietaire');
                return `<div class="personnel-card">
                    <div class="personnel-card-header">
                        <div class="personnel-avatar">${App.esc(initials)}</div>
                        <div class="personnel-info">
                            <h4>${App.esc(s.name)}</h4>
                            <span class="role-badge ${App.esc(s.role)}">${App.esc(App.roleLabel(s.role))}</span>
                        </div>
                    </div>
                    <div class="personnel-details">
                        <span>Identifiant : <strong>${App.esc(s.username)}</strong></span>
                    </div>
                    ${touchable ? `<div class="personnel-actions">
                        <button class="btn btn-small btn-secondary" onclick="App.personnel.edit(${s.id})">Modifier</button>
                        ${s.id !== App.currentUser.id ? `<button class="btn btn-small btn-danger" onclick="App.personnel.remove(${s.id})">Supprimer</button>` : ''}
                    </div>` : ''}
                </div>`;
            }).join('');
        },

        openModal() {
            this.editingId = null;
            document.getElementById('modalPersonnelTitle').textContent = 'Ajouter un membre';
            document.getElementById('staffName').value = '';
            document.getElementById('staffUsername').value = '';
            document.getElementById('staffPassword').value = '';
            document.getElementById('staffPassword').placeholder = 'Mot de passe provisoire (8 caracteres min.)';
            this.prepareRoleSelect(null);
            document.getElementById('staffRole').value = 'serveur';
            document.getElementById('modalPersonnel').classList.add('open');
        },

        // Only an owner may hand out the owner role; nobody can change their own role.
        prepareRoleSelect(member) {
            const sel = document.getElementById('staffRole');
            const owner = App.currentUser.role === 'proprietaire';
            sel.querySelector('option[value="proprietaire"]').hidden = !owner;
            sel.querySelector('option[value="proprietaire"]').disabled = !owner;
            sel.disabled = !!member && member.id === App.currentUser.id;
        },

        edit(id) {
            const s = App.staff.find(x => x.id === id);
            if (!s) return;
            this.editingId = id;
            document.getElementById('modalPersonnelTitle').textContent = 'Modifier le membre';
            document.getElementById('staffName').value = s.name;
            document.getElementById('staffUsername').value = s.username;
            document.getElementById('staffPassword').value = '';
            document.getElementById('staffPassword').placeholder = 'Laisser vide pour ne pas changer';
            this.prepareRoleSelect(s);
            document.getElementById('staffRole').value = s.role;
            document.getElementById('modalPersonnel').classList.add('open');
        },

        closeModal() {
            document.getElementById('modalPersonnel').classList.remove('open');
        },

        async save() {
            const name = document.getElementById('staffName').value.trim();
            const username = document.getElementById('staffUsername').value.trim();
            const password = document.getElementById('staffPassword').value;
            const role = document.getElementById('staffRole').value;

            if (!name || !username || (!this.editingId && !password)) { App.toast('Remplissez tous les champs', 'error'); return; }

            try {
                if (this.editingId) {
                    const res = await App.api('/staff/' + this.editingId, { method: 'PUT', body: { name, username, password, role } });
                    if (res.staff.id === App.currentUser.id) {
                        App.currentUser = { ...App.currentUser, ...res.staff };
                        localStorage.setItem('sissiman-user', JSON.stringify(App.currentUser));
                    }
                    App.toast('Membre modifie');
                } else {
                    await App.api('/staff', { method: 'POST', body: { name, username, password, role } });
                    App.toast('Membre ajoute : il choisira son mot de passe a la 1re connexion');
                }
            } catch (e) {
                App.toast(e.status ? e.message : 'Connexion impossible', 'error');
                return;
            }
            await App.loadStaff();
            this.closeModal();
            App.render();
        },

        async remove(id) {
            if (!confirm('Supprimer ce membre ?')) return;
            try {
                await App.api('/staff/' + id, { method: 'DELETE' });
            } catch (e) {
                App.toast(e.status ? e.message : 'Connexion impossible', 'error');
                return;
            }
            await App.loadStaff();
            App.toast('Membre supprime');
            App.render();
        }
    }
};

document.addEventListener('DOMContentLoaded', () => App.init());
