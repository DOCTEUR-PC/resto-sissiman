const App = {
    data: {
        tables: [],
        categories: [],
        menuItems: [],
        orders: [],
        payments: [],
        refunds: [],
        cashSessions: []
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
            this.uiReady = true;
        }
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

    balance(o) {
        const paid = o.paid || 0;
        return { paid, refunded: o.refunded || 0, remaining: Math.max(0, o.total - paid) };
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
        try {
            this.staff = (await this.api('/staff')).staff;
        } catch (e) { /* garde la liste actuelle */ }
    },

    sync: {
        COLLECTIONS: ['tables', 'categories', 'menuItems', 'orders', 'payments', 'refunds', 'cashSessions'],
        synced: {},
        since: 0,
        ready: false,
        online: true,
        busy: false,
        timer: null,
        pushTimer: null,

        snapshot() {
            const m = {};
            for (const c of this.COLLECTIONS) {
                for (const it of App.data[c]) m[c + '/' + it.id] = JSON.stringify(it);
            }
            return m;
        },

        apply(records) {
            let changed = false;
            for (const r of records) {
                if (!this.COLLECTIONS.includes(r.collection)) continue;
                const key = r.collection + '/' + r.id;
                const list = App.data[r.collection];
                const idx = list.findIndex(x => String(x.id) === r.id);
                if (r.deleted) {
                    if (idx >= 0) { list.splice(idx, 1); changed = true; }
                    delete this.synced[key];
                } else if (this.synced[key] !== r.data || idx < 0) {
                    const item = JSON.parse(r.data);
                    if (idx >= 0) list[idx] = item; else list.push(item);
                    this.synced[key] = r.data;
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
                this.apply(res.records);
            }
            this.ready = true;
        },

        async push() {
            const now = this.snapshot();
            const changes = [];
            for (const [key, data] of Object.entries(now)) {
                if (this.synced[key] !== data) changes.push({ key, data });
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
                    if (c.data === null) delete this.synced[c.key]; else this.synced[c.key] = c.data;
                }
            }
            if (reverted) {
                App.cacheData();
                App.render();
            }
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
                this.synced[key] = r.data;
            }
        },

        async tick() {
            if (this.busy || !App.currentUser) return;
            this.busy = true;
            try {
                if (!this.ready) await this.initial();
                await this.push();
                const res = await App.api('/sync?since=' + this.since);
                this.since = res.now - 5000;
                if (this.apply(res.records)) {
                    App.cacheData();
                    App.render();
                }
                this.setOnline(true);
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
            App.toast(online ? 'Connexion retablie' : 'Connexion perdue : modifications en attente', online ? 'success' : 'error');
        },

        start() {
            this.stop();
            this.timer = setInterval(() => this.tick(), 4000);
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
                document.querySelectorAll('.modal.open:not([data-locked="true"])').forEach(m => m.classList.remove('open'));
            }
        });
    },

    // PERSISTENCE
    loadData() {
        const saved = localStorage.getItem('restoManagerData');
        if (saved) {
            const parsed = JSON.parse(saved);
            Object.assign(this.data, parsed);
        }
    },

    cacheData() {
        localStorage.setItem('restoManagerData', JSON.stringify(this.data));
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
            rapports: 'Rapports & Statistiques',
            personnel: 'Gestion du personnel'
        };
        document.getElementById('pageTitle').textContent = titles[page] || page;
        if (page === 'personnel') this.audit.load();
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

    audit: {
        labels: {
            creation: 'a cree', modification: 'a modifie', suppression: 'a supprime', refus: 'action refusee :',
            login: "s'est connecte", login_echec: 'Echec de connexion', mot_de_passe: 'a change son mot de passe'
        },
        collections: {
            orders: 'commande', payments: 'paiement', menuItems: 'plat', categories: 'categorie', tables: 'table', staff: 'membre'
        },

        async load() {
            const list = document.getElementById('auditList');
            if (!App.can('page.personnel')) return;
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
            if (e.collection && e.action !== 'login' && e.action !== 'mot_de_passe' && e.action !== 'login_echec') {
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
            App.password.close(true);
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
        this.updateBadge();
    },

    // Mirrors the server rules in src/worker.js; the server remains the authority.
    PERMS: {
        'page.dashboard': ['gerant', 'caissier'],
        'page.tables': ['gerant', 'caissier', 'serveur'],
        'page.orders': ['gerant', 'caissier', 'serveur', 'cuisinier'],
        'page.menu': ['gerant', 'caissier', 'serveur', 'cuisinier'],
        'page.caisse': ['gerant', 'caissier'],
        'page.cuisine': ['gerant', 'caissier', 'serveur', 'cuisinier'],
        'page.rapports': ['gerant'],
        'page.personnel': ['gerant'],
        'tables.manage': ['gerant'],
        'menu.manage': ['gerant'],
        'menu.availability': ['gerant', 'cuisinier'],
        'orders.create': ['gerant', 'caissier', 'serveur'],
        'orders.ready': ['gerant', 'cuisinier', 'serveur'],
        'orders.serve': ['gerant', 'caissier', 'serveur'],
        'orders.cancel': ['gerant', 'caissier'],
        'payments.create': ['gerant', 'caissier'],
        'cash.session': ['gerant', 'caissier'],
        'cash.history': ['gerant'],
        'refunds.create': ['gerant']
    },

    can(perm) {
        return !!this.currentUser && (this.PERMS[perm] || []).includes(this.currentUser.role);
    },

    applyPermissions() {
        document.querySelectorAll('[data-perm]').forEach(el => {
            el.style.display = this.can(el.dataset.perm) ? '' : 'none';
        });
        const active = document.querySelector('.nav-item.active');
        if (this.currentUser && active && !this.can('page.' + active.dataset.page)) {
            const first = [...document.querySelectorAll('.nav-item')].find(n => this.can('page.' + n.dataset.page));
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
        render() {
            const orders = App.todayOrders();
            const paid = orders.filter(o => o.status === 'payee');
            const today = new Date().toDateString();
            const revenue = App.data.payments.filter(p => new Date(p.paidAt).toDateString() === today).reduce((s, p) => s + p.amount, 0)
                - App.data.refunds.filter(r => new Date(r.at).toDateString() === today).reduce((s, r) => s + r.amount, 0);
            const covers = paid.reduce((s, o) => s + (o.covers || 1), 0);
            const occupied = App.data.tables.filter(t => t.status === 'occupee').length;

            document.getElementById('statClients').textContent = covers;
            document.getElementById('statRevenue').textContent = App.fmt(revenue);
            document.getElementById('statOrders').textContent = orders.length;
            document.getElementById('statTables').textContent = `${occupied} / ${App.data.tables.length}`;

            const recentEl = document.getElementById('recentOrders');
            const recent = orders.slice(-5).reverse();
            if (recent.length === 0) {
                recentEl.innerHTML = '<p class="empty-state">Aucune commande aujourd\'hui</p>';
            } else {
                recentEl.innerHTML = recent.map(o => {
                    const table = App.data.tables.find(t => t.id === o.tableId);
                    const time = new Date(o.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
                    return `<div class="recent-order-row">
                        <span class="time">${App.esc(time)}</span>
                        <span class="details">Table ${table ? table.number : '?'} - ${o.items.length} article(s)</span>
                        <span class="order-status ${App.esc(o.status)}">${App.esc(o.status.replace('_', ' '))}</span>
                        <span class="amount">${App.fmt(o.total)}</span>
                    </div>`;
                }).join('');
            }

            const popEl = document.getElementById('popularDishes');
            const itemCounts = {};
            orders.forEach(o => {
                o.items.forEach(it => {
                    itemCounts[it.name] = (itemCounts[it.name] || 0) + it.qty;
                });
            });
            const popular = Object.entries(itemCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
            if (popular.length === 0) {
                popEl.innerHTML = '<p class="empty-state">Aucune donnee disponible</p>';
            } else {
                popEl.innerHTML = popular.map(([name, count], i) => `
                    <div class="popular-row">
                        <span class="popular-rank">${i + 1}</span>
                        <span class="name">${App.esc(name)}</span>
                        <span class="count">${count} commande(s)</span>
                    </div>
                `).join('');
            }
        }
    },

    // TABLES
    tables: {
        editingId: null,

        render() {
            const grid = document.getElementById('tablesGrid');
            if (App.data.tables.length === 0) {
                grid.innerHTML = '<p class="empty-state">Aucune table configuree. Ajoutez-en une !</p>';
                return;
            }
            const locationLabels = { interieur: 'Interieur', terrasse: 'Terrasse', vip: 'VIP' };
            grid.innerHTML = App.data.tables.map(t => {
                let mainBtn = '';
                if (t.status === 'libre') {
                    mainBtn = `<button class="btn btn-small btn-success" onclick="event.stopPropagation(); App.tables.setStatus('${t.id}','occupee')">Occuper</button>`;
                } else if (t.status === 'occupee') {
                    mainBtn = `<button class="btn btn-small btn-warning" onclick="event.stopPropagation(); App.tables.setStatus('${t.id}','libre')">Liberer</button>`;
                } else if (t.status === 'reservee') {
                    mainBtn = `<button class="btn btn-small btn-success" onclick="event.stopPropagation(); App.tables.setStatus('${t.id}','libre')">Liberer</button>`;
                }
                return `<div class="table-card ${App.esc(t.status)}">
                    <div class="table-card-header">
                        <div class="table-number">T${t.number}</div>
                        <span class="table-status ${App.esc(t.status)}">${App.esc(t.status)}</span>
                    </div>
                    <div class="table-info">
                        <span class="seats-icon">${t.seats} places</span>
                        <span>${App.esc(locationLabels[t.location] || t.location)}</span>
                    </div>
                    <div class="table-main-action">${mainBtn}</div>
                    <div class="table-actions">
                        ${t.status === 'libre' ? `<button class="btn-icon btn-warning" title="Reserver" onclick="event.stopPropagation(); App.tables.setStatus('${t.id}','reservee')"><svg viewBox="0 0 24 24"><path d="M19 4H5a2 2 0 00-2 2v14l4-4h12a2 2 0 002-2V6a2 2 0 00-2-2z"/></svg></button>` : ''}
                        ${App.can('tables.manage') ? `<button class="btn-icon btn-secondary" title="Modifier" onclick="event.stopPropagation(); App.tables.edit('${t.id}')"><svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                        <button class="btn-icon btn-danger" title="Supprimer" onclick="event.stopPropagation(); App.tables.remove('${t.id}')"><svg viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>` : ''}
                    </div>
                </div>`;
            }).join('');
        },

        setStatus(id, status) {
            const t = App.data.tables.find(x => x.id === id);
            if (t) { t.status = status; App.saveData(); App.render(); }
        },

        openAddModal() {
            this.editingId = null;
            document.getElementById('modalTableTitle').textContent = 'Ajouter une table';
            document.getElementById('tableNumber').value = '';
            document.getElementById('tableSeats').value = 4;
            document.getElementById('tableLocation').value = 'interieur';
            document.getElementById('modalTable').classList.add('open');
        },

        edit(id) {
            const t = App.data.tables.find(x => x.id === id);
            if (!t) return;
            this.editingId = id;
            document.getElementById('modalTableTitle').textContent = 'Modifier la table';
            document.getElementById('tableNumber').value = t.number;
            document.getElementById('tableSeats').value = t.seats;
            document.getElementById('tableLocation').value = t.location;
            document.getElementById('modalTable').classList.add('open');
        },

        closeModal() {
            document.getElementById('modalTable').classList.remove('open');
        },

        save() {
            const number = parseInt(document.getElementById('tableNumber').value);
            const seats = parseInt(document.getElementById('tableSeats').value);
            const location = document.getElementById('tableLocation').value;
            if (!number || !seats) { App.toast('Remplissez tous les champs', 'error'); return; }

            const duplicate = App.data.tables.find(t => t.number === number && t.id !== this.editingId);
            if (duplicate) { App.toast(`La table ${number} existe deja`, 'error'); return; }

            if (this.editingId) {
                const t = App.data.tables.find(x => x.id === this.editingId);
                if (t) { t.number = number; t.seats = seats; t.location = location; }
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
            const hasOrders = App.data.orders.some(o => o.tableId === id && (o.status === 'en_cours' || o.status === 'prete' || o.status === 'servie'));
            if (hasOrders) { App.toast('Impossible : cette table a des commandes actives', 'error'); return; }
            if (!confirm('Supprimer cette table ?')) return;
            App.data.tables = App.data.tables.filter(t => t.id !== id);
            App.saveData();
            App.toast('Table supprimee');
            App.render();
        },

        showActions() {}
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
                const itemsText = o.items.map(it => `${it.qty}x ${App.esc(it.name)}`).join(', ');
                return `<div class="order-card">
                    <span class="order-id">#${String(o.number).padStart(3, '0')}</span>
                    <span class="order-table-badge">T${table ? table.number : '?'}</span>
                    <span class="order-details">${App.esc(time)} - ${itemsText}</span>
                    <span class="order-amount">${App.fmt(o.total)}</span>
                    <span class="order-status ${App.esc(o.status)}">${App.esc(o.status.replace('_', ' '))}</span>
                    <div class="order-actions">
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
            this.currentItems = [];
            this.searchQuery = '';
            document.getElementById('orderCovers').value = 1;
            document.getElementById('orderNote').value = '';

            const select = document.getElementById('orderTable');
            select.innerHTML = App.data.tables.map(t =>
                `<option value="${t.id}">Table ${t.number} (${t.seats}p - ${App.esc(t.location)}) ${t.status !== 'libre' ? '[' + App.esc(t.status) + ']' : ''}</option>`
            ).join('');

            const searchEl = document.getElementById('orderSearch');
            if (searchEl) searchEl.value = '';

            this.renderOrderMenuCategories();
            this.renderOrderItems();
            document.getElementById('modalOrder').classList.add('open');
        },

        searchMenu(query) {
            this.searchQuery = query.toLowerCase();
            this.filterMenuItems(this._currentMenuCat || 'all');
        },

        renderOrderMenuCategories() {
            const container = document.getElementById('orderMenuCategories');
            container.innerHTML = `<button class="menu-cat-btn active" onclick="App.orders.filterMenuItems('all', event)">Tout</button>` +
                App.data.categories.map(c =>
                    `<button class="menu-cat-btn" onclick="App.orders.filterMenuItems('${c.id}', event)">${c.icon} ${c.name}</button>`
                ).join('');
            this.filterMenuItems('all');
        },

        filterMenuItems(catId, e) {
            this._currentMenuCat = catId;
            document.querySelectorAll('#orderMenuCategories .menu-cat-btn').forEach(b => b.classList.remove('active'));
            if (e) e.target.classList.add('active');
            else document.querySelector('#orderMenuCategories .menu-cat-btn')?.classList.add('active');

            let items = catId === 'all' ? App.data.menuItems : App.data.menuItems.filter(m => m.category === catId);
            if (this.searchQuery) {
                items = items.filter(m => m.name.toLowerCase().includes(this.searchQuery));
            }
            const container = document.getElementById('orderMenuItems');
            if (items.length === 0) {
                container.innerHTML = '<p class="empty-state" style="padding:1rem">Aucun resultat</p>';
                return;
            }
            container.innerHTML = items.map(m => `
                <div class="menu-grid-item ${m.available ? '' : 'unavailable'}" onclick="App.orders.addItem('${m.id}')">
                    <div class="item-name">${App.esc(m.name)}</div>
                    <div class="item-price">${App.fmt(m.price)}</div>
                </div>
            `).join('');
        },

        addItem(menuId) {
            const m = App.data.menuItems.find(x => x.id === menuId);
            if (!m || !m.available) return;
            const existing = this.currentItems.find(x => x.menuId === menuId);
            if (existing) {
                existing.qty++;
            } else {
                this.currentItems.push({ menuId, name: m.name, price: m.price, qty: 1 });
            }
            this.renderOrderItems();
        },

        changeQty(menuId, delta) {
            const item = this.currentItems.find(x => x.menuId === menuId);
            if (!item) return;
            item.qty += delta;
            if (item.qty <= 0) {
                this.currentItems = this.currentItems.filter(x => x.menuId !== menuId);
            }
            this.renderOrderItems();
        },

        removeItem(menuId) {
            this.currentItems = this.currentItems.filter(x => x.menuId !== menuId);
            this.renderOrderItems();
        },

        renderOrderItems() {
            const container = document.getElementById('orderItems');
            if (this.currentItems.length === 0) {
                container.innerHTML = '<p class="empty-state">Aucun article ajoute</p>';
                document.getElementById('orderTotal').textContent = '0 FCFA';
                return;
            }
            container.innerHTML = this.currentItems.map(it => `
                <div class="order-item-row">
                    <div class="item-qty">
                        <button onclick="App.orders.changeQty('${it.menuId}', -1)">-</button>
                        <span>${it.qty}</span>
                        <button onclick="App.orders.changeQty('${it.menuId}', 1)">+</button>
                    </div>
                    <span class="name">${App.esc(it.name)}</span>
                    <span class="price">${App.fmt(it.price * it.qty)}</span>
                    <button class="remove" onclick="App.orders.removeItem('${it.menuId}')">&times;</button>
                </div>
            `).join('');
            const total = this.currentItems.reduce((s, it) => s + it.price * it.qty, 0);
            document.getElementById('orderTotal').textContent = App.fmt(total);
        },

        async submitOrder() {
            if (this.currentItems.length === 0) { App.toast('Ajoutez au moins un article', 'error'); return; }
            if (this.submitting) return;
            const tableId = document.getElementById('orderTable').value;
            const covers = parseInt(document.getElementById('orderCovers').value) || 1;
            const note = document.getElementById('orderNote').value;
            const total = this.currentItems.reduce((s, it) => s + it.price * it.qty, 0);

            let number;
            this.submitting = true;
            try {
                const maxLocal = App.data.orders.reduce((m, o) => Math.max(m, o.number || 0), 0);
                number = (await App.api('/orders/next-number', { method: 'POST', body: { min: maxLocal + 1 } })).number;
            } catch (e) {
                App.toast('Connexion impossible : commande non enregistree', 'error');
                return;
            } finally {
                this.submitting = false;
            }

            const order = {
                id: App.genId(),
                number,
                tableId,
                covers,
                items: [...this.currentItems],
                total,
                note,
                status: 'en_cours',
                createdAt: new Date().toISOString()
            };

            App.data.orders.push(order);
            const table = App.data.tables.find(t => t.id === tableId);
            if (table) table.status = 'occupee';

            App.saveData();
            this.closeModal();
            App.render();
            App.toast(`Commande #${String(order.number).padStart(3, '0')} enregistree`);
        },

        closeModal() {
            document.getElementById('modalOrder').classList.remove('open');
        }
    },

    // MENU
    menu: {
        editingItemId: null,
        selectedCat: 'all',

        render() {
            const sidebar = document.getElementById('menuCatsSidebar');
            sidebar.innerHTML = `<div class="menu-cat-item ${this.selectedCat === 'all' ? 'active' : ''}" onclick="App.menu.selectCat('all')">
                <span class="cat-icon">📋</span> Tous
                <span class="cat-count">${App.data.menuItems.length}</span>
            </div>` + App.data.categories.map(c => {
                const count = App.data.menuItems.filter(m => m.category === c.id).length;
                return `<div class="menu-cat-item ${this.selectedCat === c.id ? 'active' : ''}" onclick="App.menu.selectCat('${c.id}')">
                    <span class="cat-icon">${c.icon}</span> ${c.name}
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
                return `<div class="menu-item-card ${m.available ? '' : 'unavailable'}">
                    <div style="flex:1">
                        <div class="menu-item-name">${cat ? cat.icon : ''} ${App.esc(m.name)}</div>
                        <div class="menu-item-desc">${App.esc(m.desc || '')}</div>
                    </div>
                    <div class="menu-item-price">${App.fmt(m.price)}</div>
                    <div class="menu-item-actions">
                        ${App.can('menu.availability') ? `<button class="btn btn-small ${m.available ? 'btn-warning' : 'btn-success'}" onclick="App.menu.toggleAvail('${m.id}')">${m.available ? 'Indispo' : 'Dispo'}</button>` : ''}
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

        openAddModal() {
            this.editingItemId = null;
            document.getElementById('modalMenuItemTitle').textContent = 'Ajouter un plat';
            document.getElementById('menuItemName').value = '';
            document.getElementById('menuItemPrice').value = '';
            document.getElementById('menuItemDesc').value = '';
            document.getElementById('menuItemAvailable').checked = true;
            this.populateCategorySelect();
            document.getElementById('modalMenuItem').classList.add('open');
        },

        editItem(id) {
            const m = App.data.menuItems.find(x => x.id === id);
            if (!m) return;
            this.editingItemId = id;
            document.getElementById('modalMenuItemTitle').textContent = 'Modifier le plat';
            document.getElementById('menuItemName').value = m.name;
            document.getElementById('menuItemPrice').value = m.price;
            document.getElementById('menuItemDesc').value = m.desc || '';
            document.getElementById('menuItemAvailable').checked = m.available;
            this.populateCategorySelect(m.category);
            document.getElementById('modalMenuItem').classList.add('open');
        },

        populateCategorySelect(selected) {
            const sel = document.getElementById('menuItemCategory');
            sel.innerHTML = App.data.categories.map(c =>
                `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${c.icon} ${c.name}</option>`
            ).join('');
        },

        closeItemModal() {
            document.getElementById('modalMenuItem').classList.remove('open');
        },

        saveItem() {
            const name = document.getElementById('menuItemName').value.trim();
            const category = document.getElementById('menuItemCategory').value;
            const price = parseInt(document.getElementById('menuItemPrice').value);
            const desc = document.getElementById('menuItemDesc').value.trim();
            const available = document.getElementById('menuItemAvailable').checked;

            if (!name || !price) { App.toast('Remplissez le nom et le prix', 'error'); return; }

            if (this.editingItemId) {
                const m = App.data.menuItems.find(x => x.id === this.editingItemId);
                if (m) { Object.assign(m, { name, category, price, desc, available }); }
                App.toast('Plat modifie');
            } else {
                App.data.menuItems.push({ id: App.genId(), name, category, price, desc, available });
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
                            <span>${it.qty}x ${App.esc(it.name)}</span>
                            <span>${App.fmt(it.price * it.qty)}</span>
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
        print(html) {
            const area = document.getElementById('printArea');
            area.innerHTML = `<div class="ticket-print">${html}</div>`;
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
            return `<div class="tp-sep"></div>${o.items.map(it => this.row(`${it.qty} x ${App.esc(it.name)}`, App.fmt(it.price * it.qty))).join('')}
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

        kitchen(orderId) {
            const o = App.data.orders.find(x => x.id === orderId);
            if (!o) return;
            const table = App.data.tables.find(t => t.id === o.tableId);
            this.print(`<div class="tp-center tp-title">CUISINE</div>
                <div class="tp-kitchen-head">#${String(o.number).padStart(3, '0')} · TABLE ${table ? table.number : '?'}</div>
                <div class="tp-center">Recue a ${App.esc(new Date(o.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }))}</div>
                <div class="tp-sep"></div>
                ${o.items.map(it => `<div class="tp-kitchen-item"><strong>${it.qty} x</strong> ${App.esc(it.name)}</div>`).join('')}
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

    // CUISINE
    cuisine: {
        _lastCount: 0,

        render() {
            const orders = App.data.orders.filter(o => o.status === 'en_cours' || o.status === 'prete');
            const enCours = orders.filter(o => o.status === 'en_cours');
            const pretes = orders.filter(o => o.status === 'prete');

            document.getElementById('cuisineEnCours').textContent = enCours.length;
            document.getElementById('cuisinePretes').textContent = pretes.length;

            if (enCours.length > this._lastCount) this.playNotif();
            this._lastCount = enCours.length;

            const grid = document.getElementById('cuisineGrid');
            if (orders.length === 0) {
                grid.innerHTML = '<p class="empty-state">Aucune commande en attente</p>';
                return;
            }

            const now = Date.now();
            grid.innerHTML = orders.map(o => {
                const table = App.data.tables.find(t => t.id === o.tableId);
                const mins = Math.floor((now - new Date(o.createdAt).getTime()) / 60000);
                const urgent = mins >= 15;
                return `<div class="cuisine-ticket">
                    <div class="cuisine-ticket-header">
                        <div>
                            <span class="order-num">#${String(o.number).padStart(3, '0')}</span>
                            <span class="table-num"> — Table ${table ? table.number : '?'}</span>
                        </div>
                        <span class="cuisine-ticket-timer ${urgent ? 'urgent' : ''}">${mins} min</span>
                    </div>
                    <div class="cuisine-ticket-items">
                        ${o.items.map(it => `<div class="cuisine-ticket-item"><span><span class="qty">${it.qty}x</span> ${App.esc(it.name)}</span></div>`).join('')}
                    </div>
                    ${o.note ? `<div class="cuisine-ticket-note">${App.esc(o.note)}</div>` : ''}
                    <div class="cuisine-ticket-actions">
                        ${o.status === 'en_cours' && App.can('orders.ready') ? `<button class="btn btn-primary" onclick="App.cuisine.markReady('${o.id}')">Pret !</button>` : ''}
                        ${o.status === 'prete' && App.can('orders.serve') ? `<button class="btn btn-success" onclick="App.orders.updateStatus('${o.id}','servie')">Servie</button>` : ''}
                        <button class="btn btn-secondary" title="Imprimer le ticket cuisine" onclick="App.tickets.kitchen('${o.id}')">Imprimer</button>
                    </div>
                </div>`;
            }).join('');
        },

        markReady(id) {
            App.orders.updateStatus(id, 'prete');
            App.toast('Commande prete a servir !');
        },

        playNotif() {
            try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.type = 'sine';
                osc.frequency.setValueAtTime(880, ctx.currentTime);
                osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
                osc.frequency.setValueAtTime(880, ctx.currentTime + 0.2);
                gain.gain.setValueAtTime(0.3, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
                osc.start(ctx.currentTime);
                osc.stop(ctx.currentTime + 0.4);
            } catch(e) {}
        }
    },

    // RAPPORTS
    rapports: {
        period: 'jour',

        setPeriod(p) {
            this.period = p;
            document.querySelectorAll('.rapports-period .filter-btn').forEach(b => b.classList.toggle('active', b.dataset.period === p));
            this.render();
        },

        inPeriod(iso) {
            const now = new Date();
            const d = new Date(iso);
            if (this.period === 'jour') return d.toDateString() === now.toDateString();
            if (this.period === 'semaine') return d >= new Date(now - 7 * 86400000);
            if (this.period === 'mois') return d >= new Date(now - 30 * 86400000);
            return true;
        },

        // Refunds are folded in as negative entries so every chart shows net cash.
        getFilteredPayments() {
            return [
                ...App.data.payments.filter(p => this.inPeriod(p.paidAt)),
                ...App.data.refunds.filter(r => this.inPeriod(r.at)).map(r => ({ ...r, paidAt: r.at, amount: -r.amount }))
            ];
        },

        getFilteredOrders() {
            const now = new Date();
            const orders = App.data.orders;
            if (this.period === 'jour') {
                const today = now.toDateString();
                return orders.filter(o => new Date(o.createdAt).toDateString() === today);
            } else if (this.period === 'semaine') {
                const week = new Date(now - 7 * 86400000);
                return orders.filter(o => new Date(o.createdAt) >= week);
            } else if (this.period === 'mois') {
                const month = new Date(now - 30 * 86400000);
                return orders.filter(o => new Date(o.createdAt) >= month);
            }
            return orders;
        },

        render() {
            const payments = this.getFilteredPayments();
            const orders = this.getFilteredOrders();
            const total = payments.reduce((s, p) => s + p.amount, 0);
            const paidOrders = orders.filter(o => o.status === 'payee');
            const avgTicket = paidOrders.length > 0 ? Math.round(paidOrders.reduce((s, o) => s + o.total, 0) / paidOrders.length) : 0;
            const covers = paidOrders.reduce((s, o) => s + (o.covers || 1), 0);

            document.getElementById('rapportsSummary').innerHTML = `
                <div class="rapport-card"><div class="label">Encaissements nets</div><div class="value gold">${App.fmt(total)}</div></div>
                <div class="rapport-card"><div class="label">Commandes</div><div class="value">${orders.length}</div></div>
                <div class="rapport-card"><div class="label">Ticket moyen</div><div class="value">${App.fmt(avgTicket)}</div></div>
                <div class="rapport-card"><div class="label">Couverts</div><div class="value">${covers}</div></div>
            `;

            this.renderRevenueChart(payments);
            this.renderTopPlats(orders);
            this.renderPaymentMethods(payments);
        },

        renderRevenueChart(payments) {
            const container = document.getElementById('chartRevenue');
            if (payments.length === 0) {
                container.innerHTML = '<p class="empty-state">Aucune donnee</p>';
                return;
            }
            const byDay = {};
            payments.forEach(p => {
                const day = new Date(p.paidAt).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' });
                byDay[day] = (byDay[day] || 0) + p.amount;
            });
            const entries = Object.entries(byDay).slice(-7);
            const max = Math.max(1, ...entries.map(e => e[1]));

            container.innerHTML = entries.map(([day, val]) => `
                <div class="chart-bar-row">
                    <span class="chart-bar-label">${day}</span>
                    <div class="chart-bar-track"><div class="chart-bar-fill" style="width:${Math.max(0, val / max * 100)}%"></div></div>
                    <span class="chart-bar-value">${App.fmt(val)}</span>
                </div>
            `).join('');
        },

        renderTopPlats(orders) {
            const container = document.getElementById('chartTopPlats');
            const itemCounts = {};
            orders.forEach(o => o.items.forEach(it => {
                itemCounts[it.name] = (itemCounts[it.name] || 0) + it.qty;
            }));
            const top = Object.entries(itemCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
            if (top.length === 0) {
                container.innerHTML = '<p class="empty-state">Aucune donnee</p>';
                return;
            }
            const max = top[0][1];
            container.innerHTML = top.map(([name, count]) => `
                <div class="chart-bar-row">
                    <span class="chart-bar-label">${App.esc(name)}</span>
                    <div class="chart-bar-track"><div class="chart-bar-fill" style="width:${max ? (count/max*100) : 0}%"></div></div>
                    <span class="chart-bar-value">${count}</span>
                </div>
            `).join('');
        },

        renderPaymentMethods(payments) {
            const container = document.getElementById('chartPaiements');
            if (payments.length === 0) {
                container.innerHTML = '<p class="empty-state">Aucune donnee</p>';
                return;
            }
            const methods = {};
            payments.forEach(p => {
                methods[p.method] = (methods[p.method] || 0) + p.amount;
            });
            const colors = { especes: '#16a34a', mobile: '#2563eb', carte: '#d97706' };
            const labels = { especes: 'Especes', mobile: 'Mobile Money', carte: 'Carte' };
            const entries = Object.entries(methods).filter(([, v]) => v > 0);
            const total = entries.reduce((s, [, v]) => s + v, 0);
            if (total <= 0) {
                container.innerHTML = '<p class="empty-state">Aucune donnee</p>';
                return;
            }

            let cumul = 0;
            const segments = entries.map(([method, val]) => {
                const pct = (val / total) * 100;
                const start = cumul;
                cumul += pct;
                return { method, val, pct, start, color: colors[method] || '#9d97a8' };
            });

            const svgParts = segments.map(s => {
                const r = 60;
                const circ = 2 * Math.PI * r;
                const dashLen = (s.pct / 100) * circ;
                const dashOff = -(s.start / 100) * circ;
                return `<circle cx="80" cy="80" r="${r}" fill="none" stroke="${s.color}" stroke-width="20" stroke-dasharray="${dashLen} ${circ - dashLen}" stroke-dashoffset="${dashOff}" />`;
            }).join('');

            container.innerHTML = `<div class="chart-donut">
                <svg class="donut-ring" viewBox="0 0 160 160">${svgParts}</svg>
                <div class="donut-labels">
                    ${entries.map(([method, val]) => `
                        <div class="donut-label-row">
                            <span class="donut-label-dot" style="background:${colors[method] || '#9d97a8'}"></span>
                            <span class="donut-label-text">${labels[method] || method}</span>
                            <span class="donut-label-value">${App.fmt(val)}</span>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        }
    },

    // PERSONNEL
    personnel: {
        editingId: null,

        render() {
            const grid = document.getElementById('personnelGrid');
            const staffList = App.staff;
            const roleLabels = { gerant: 'Gerant', caissier: 'Caissier', serveur: 'Serveur', cuisinier: 'Cuisinier' };
            const isGerant = App.currentUser && App.currentUser.role === 'gerant';

            grid.innerHTML = staffList.map(s => {
                const initials = s.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
                return `<div class="personnel-card">
                    <div class="personnel-card-header">
                        <div class="personnel-avatar">${initials}</div>
                        <div class="personnel-info">
                            <h4>${App.esc(s.name)}</h4>
                            <span class="role-badge ${App.esc(s.role)}">${roleLabels[s.role] || s.role}</span>
                        </div>
                    </div>
                    <div class="personnel-details">
                        <span>Identifiant : <strong>${App.esc(s.username)}</strong></span>
                    </div>
                    ${isGerant ? `<div class="personnel-actions">
                        <button class="btn btn-small btn-secondary" onclick="App.personnel.edit(${s.id})">Modifier</button>
                        ${s.id !== 1 && s.id !== App.currentUser.id ? `<button class="btn btn-small btn-danger" onclick="App.personnel.remove(${s.id})">Supprimer</button>` : ''}
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
            document.getElementById('staffRole').value = 'serveur';
            document.getElementById('modalPersonnel').classList.add('open');
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
                        App.currentUser = res.staff;
                        localStorage.setItem('sissiman-user', JSON.stringify(res.staff));
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
