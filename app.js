const App = {
    data: {
        tables: [],
        categories: [],
        menuItems: [],
        orders: [],
        payments: [],
        nextOrderId: 1
    },

    defaultStaff: [
        { id: 1, username: 'admin', password: 'admin123', name: 'Administrateur', role: 'gerant' },
        { id: 2, username: 'caisse1', password: 'caisse123', name: 'Caissier 1', role: 'caissier' },
        { id: 3, username: 'serveur1', password: 'serveur123', name: 'Serveur 1', role: 'serveur' }
    ],

    get staff() {
        const saved = localStorage.getItem('sissiman-staff');
        return saved ? JSON.parse(saved) : this.defaultStaff;
    },

    set staff(val) {
        localStorage.setItem('sissiman-staff', JSON.stringify(val));
    },

    saveStaff() {
        localStorage.setItem('sissiman-staff', JSON.stringify(this.staff));
    },

    currentUser: null,

    init() {
        this.setupTheme();
        if (!this.auth.checkSession()) return;
        this.loadData();
        this.setupNav();
        this.startClock();
        this.setupUserMenu();
        this.setupSidebar();
        this.setupIconPicker();
        this.setupModals();
        this.setupKeyboard();
        this.seedDefaults();
        this.render();
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
                if (e.target === modal) modal.classList.remove('open');
            });
        });
    },

    setupKeyboard() {
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open'));
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

    saveData() {
        localStorage.setItem('restoManagerData', JSON.stringify(this.data));
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
        if (window.innerWidth <= 768) {
            document.getElementById('sidebar').classList.remove('open');
        }
        this.render();
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
            if (saved) {
                try {
                    App.currentUser = JSON.parse(saved);
                    document.getElementById('loginScreen').classList.add('hidden');
                    return true;
                } catch(e) { localStorage.removeItem('sissiman-user'); }
            }
            document.getElementById('loginScreen').classList.remove('hidden');
            App.loginBg.start();
            return false;
        },

        login(e) {
            e.preventDefault();
            const username = document.getElementById('loginUser').value.trim();
            const password = document.getElementById('loginPass').value;
            const user = App.staff.find(u => u.username === username && u.password === password);
            if (!user) {
                document.getElementById('loginError').textContent = 'Identifiant ou mot de passe incorrect';
                return false;
            }
            App.currentUser = { id: user.id, name: user.name, role: user.role };
            localStorage.setItem('sissiman-user', JSON.stringify(App.currentUser));
            document.getElementById('loginScreen').classList.add('hidden');
            App.loginBg.stop();
            document.getElementById('loginUser').value = '';
            document.getElementById('loginPass').value = '';
            document.getElementById('loginError').textContent = '';
            App.loadData();
            App.setupNav();
            App.startClock();
            App.setupUserMenu();
            App.setupSidebar();
            App.setupIconPicker();
            App.setupModals();
            App.setupKeyboard();
            App.seedDefaults();
            App.render();
            return false;
        },

        logout() {
            App.currentUser = null;
            localStorage.removeItem('sissiman-user');
            document.getElementById('loginScreen').classList.remove('hidden');
            document.getElementById('userDropdown').classList.remove('open');
            App.loginBg.start();
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

        const initials = this.currentUser ? this.currentUser.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) : '--';
        document.getElementById('userInitials').textContent = initials;
        document.getElementById('dropdownUserName').textContent = this.currentUser ? this.currentUser.name : '';

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

    render() {
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

    applyPermissions() {
        const role = this.currentUser ? this.currentUser.role : 'serveur';
        document.querySelectorAll('.nav-item[data-role]').forEach(item => {
            item.style.display = (item.dataset.role === role || role === 'gerant') ? '' : 'none';
        });
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
            const revenue = paid.reduce((s, o) => s + o.total, 0);
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
                        <button class="btn-icon btn-secondary" title="Modifier" onclick="event.stopPropagation(); App.tables.edit('${t.id}')"><svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                        <button class="btn-icon btn-danger" title="Supprimer" onclick="event.stopPropagation(); App.tables.remove('${t.id}')"><svg viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
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
                        ${o.status === 'en_cours' ? `<button class="btn btn-small btn-warning" onclick="App.orders.updateStatus('${o.id}','prete')">Prete</button>` : ''}
                        ${o.status === 'prete' ? `<button class="btn btn-small btn-success" onclick="App.orders.updateStatus('${o.id}','servie')">Servir</button>` : ''}
                        ${o.status !== 'payee' && o.status !== 'annulee' ? `<button class="btn btn-small btn-danger" onclick="App.orders.updateStatus('${o.id}','annulee')">Annuler</button>` : ''}
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

        submitOrder() {
            if (this.currentItems.length === 0) { App.toast('Ajoutez au moins un article', 'error'); return; }
            const tableId = document.getElementById('orderTable').value;
            const covers = parseInt(document.getElementById('orderCovers').value) || 1;
            const note = document.getElementById('orderNote').value;
            const total = this.currentItems.reduce((s, it) => s + it.price * it.qty, 0);

            const order = {
                id: App.genId(),
                number: App.data.nextOrderId++,
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
                        <button class="btn btn-small ${m.available ? 'btn-warning' : 'btn-success'}" onclick="App.menu.toggleAvail('${m.id}')">${m.available ? 'Indispo' : 'Dispo'}</button>
                        <button class="btn btn-small btn-secondary" onclick="App.menu.editItem('${m.id}')">Modifier</button>
                        <button class="btn btn-small btn-danger" onclick="App.menu.removeItem('${m.id}')">Suppr</button>
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
        paymentMethod: 'especes',

        render() {
            const orders = App.data.orders.filter(o => o.status === 'servie' || o.status === 'prete');
            const today = new Date().toDateString();
            const todayPayments = App.data.payments.filter(p => new Date(p.paidAt).toDateString() === today);
            const todayTotal = todayPayments.reduce((s, p) => s + p.amount, 0);

            document.getElementById('caissePending').textContent = orders.length;
            document.getElementById('caisseTodayTotal').textContent = App.fmt(todayTotal);
            document.getElementById('caisseTodayCount').textContent = todayPayments.length;

            const container = document.getElementById('caisseOrders');

            if (orders.length === 0) {
                container.innerHTML = '<p class="empty-state">Aucune commande a encaisser</p>';
            } else {
                container.innerHTML = orders.map(o => {
                    const table = App.data.tables.find(t => t.id === o.tableId);
                    return `<div class="caisse-order-card ${this.selectedOrderId === o.id ? 'selected' : ''}" onclick="App.caisse.selectOrder('${o.id}')">
                        <div class="caisse-order-header">
                            <strong>#${String(o.number).padStart(3, '0')} - Table ${table ? table.number : '?'}</strong>
                            <strong>${App.fmt(o.total)}</strong>
                        </div>
                        <div class="caisse-order-items">${o.items.map(it => `${it.qty}x ${App.esc(it.name)}`).join(', ')}</div>
                    </div>`;
                }).join('');
            }

            if (!this.selectedOrderId) {
                document.getElementById('caisseTicket').innerHTML = '<p class="empty-state">Selectionnez une commande</p>';
                document.getElementById('caisseActions').style.display = 'none';
            }

            this.renderPayments();
        },

        selectOrder(id) {
            this.selectedOrderId = id;
            const o = App.data.orders.find(x => x.id === id);
            if (!o) return;
            const table = App.data.tables.find(t => t.id === o.tableId);

            document.getElementById('caisseTicket').innerHTML = `
                <div class="ticket-header">
                    <h3>Restaurant Sissiman</h3>
                    <div>Ticket #${String(o.number).padStart(3, '0')}</div>
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

            document.getElementById('caisseActions').style.display = 'block';
            document.getElementById('cashReceived').value = '';
            document.getElementById('changeDisplay').textContent = 'Monnaie: 0 FCFA';
            this.render();
        },

        setPayment(method) {
            this.paymentMethod = method;
            document.querySelectorAll('.payment-btn').forEach(b => b.classList.toggle('active', b.dataset.method === method));
            document.getElementById('cashSection').style.display = method === 'especes' ? 'block' : 'none';
        },

        calcChange() {
            const o = App.data.orders.find(x => x.id === this.selectedOrderId);
            if (!o) return;
            const received = parseInt(document.getElementById('cashReceived').value) || 0;
            const change = Math.max(0, received - o.total);
            document.getElementById('changeDisplay').textContent = `Monnaie: ${App.fmt(change)}`;
        },

        processPayment() {
            const o = App.data.orders.find(x => x.id === this.selectedOrderId);
            if (!o) return;

            if (this.paymentMethod === 'especes') {
                const received = parseInt(document.getElementById('cashReceived').value) || 0;
                if (received < o.total) {
                    App.toast('Montant insuffisant !', 'error');
                    return;
                }
            }

            o.status = 'payee';
            o.paidAt = new Date().toISOString();
            o.paymentMethod = this.paymentMethod;

            App.data.payments.push({
                id: App.genId(),
                orderId: o.id,
                orderNumber: o.number,
                tableId: o.tableId,
                amount: o.total,
                method: this.paymentMethod,
                paidAt: o.paidAt
            });

            const table = App.data.tables.find(t => t.id === o.tableId);
            const hasOtherActive = App.data.orders.some(x => x.id !== o.id && x.tableId === o.tableId && (x.status === 'en_cours' || x.status === 'prete' || x.status === 'servie'));
            if (table && !hasOtherActive) table.status = 'libre';

            this.selectedOrderId = null;
            App.saveData();
            App.render();
            App.toast('Paiement enregistre !');
        },

        printTicket() {
            window.print();
        },

        renderPayments() {
            const today = new Date().toDateString();
            const payments = App.data.payments.filter(p => new Date(p.paidAt).toDateString() === today).reverse();
            const tbody = document.getElementById('paymentsBody');
            if (payments.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-secondary)">Aucun paiement aujourd\'hui</td></tr>';
                return;
            }
            tbody.innerHTML = payments.map(p => {
                const table = App.data.tables.find(t => t.id === p.tableId);
                const time = new Date(p.paidAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
                const methods = { especes: '💵 Especes', mobile: '📱 Mobile', carte: '💳 Carte' };
                return `<tr>
                    <td>${time}</td>
                    <td>#${String(p.orderNumber).padStart(3, '0')}</td>
                    <td>T${table ? table.number : '?'}</td>
                    <td><strong>${App.fmt(p.amount)}</strong></td>
                    <td>${methods[p.method] || p.method}</td>
                </tr>`;
            }).join('');
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

            const grid = document.getElementById('cuisineGrid');
            if (orders.length === 0) {
                grid.innerHTML = '<p class="empty-state">Aucune commande en attente</p>';
                return;
            }

            if (enCours.length > this._lastCount && this._lastCount >= 0) {
                this.playNotif();
            }
            this._lastCount = enCours.length;

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
                        ${o.status === 'en_cours' ? `<button class="btn btn-primary" onclick="App.cuisine.markReady('${o.id}')">Pret !</button>` : ''}
                        ${o.status === 'prete' ? `<button class="btn btn-success" onclick="App.orders.updateStatus('${o.id}','servie')">Servie</button>` : ''}
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

        getFilteredPayments() {
            const now = new Date();
            const payments = App.data.payments;
            if (this.period === 'jour') {
                const today = now.toDateString();
                return payments.filter(p => new Date(p.paidAt).toDateString() === today);
            } else if (this.period === 'semaine') {
                const week = new Date(now - 7 * 86400000);
                return payments.filter(p => new Date(p.paidAt) >= week);
            } else if (this.period === 'mois') {
                const month = new Date(now - 30 * 86400000);
                return payments.filter(p => new Date(p.paidAt) >= month);
            }
            return payments;
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
            const avgTicket = payments.length > 0 ? Math.round(total / payments.length) : 0;
            const paidOrders = orders.filter(o => o.status === 'payee');
            const covers = paidOrders.reduce((s, o) => s + (o.covers || 1), 0);

            document.getElementById('rapportsSummary').innerHTML = `
                <div class="rapport-card"><div class="label">Chiffre d'affaires</div><div class="value gold">${App.fmt(total)}</div></div>
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
            const max = Math.max(...entries.map(e => e[1]));

            container.innerHTML = entries.map(([day, val]) => `
                <div class="chart-bar-row">
                    <span class="chart-bar-label">${day}</span>
                    <div class="chart-bar-track"><div class="chart-bar-fill" style="width:${max ? (val/max*100) : 0}%"></div></div>
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
            const total = payments.reduce((s, p) => s + p.amount, 0);
            const colors = { especes: '#16a34a', mobile: '#2563eb', carte: '#d97706' };
            const labels = { especes: 'Especes', mobile: 'Mobile Money', carte: 'Carte' };
            const entries = Object.entries(methods);

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
                        ${s.id !== 1 ? `<button class="btn btn-small btn-danger" onclick="App.personnel.remove(${s.id})">Supprimer</button>` : ''}
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
            document.getElementById('staffPassword').value = s.password;
            document.getElementById('staffRole').value = s.role;
            document.getElementById('modalPersonnel').classList.add('open');
        },

        closeModal() {
            document.getElementById('modalPersonnel').classList.remove('open');
        },

        save() {
            const name = document.getElementById('staffName').value.trim();
            const username = document.getElementById('staffUsername').value.trim();
            const password = document.getElementById('staffPassword').value;
            const role = document.getElementById('staffRole').value;

            if (!name || !username || !password) { App.toast('Remplissez tous les champs', 'error'); return; }

            const list = App.staff;
            const dup = list.find(s => s.username === username && s.id !== this.editingId);
            if (dup) { App.toast('Cet identifiant existe deja', 'error'); return; }

            if (this.editingId) {
                const s = list.find(x => x.id === this.editingId);
                if (s) { s.name = name; s.username = username; s.password = password; s.role = role; }
                App.toast('Membre modifie');
            } else {
                const maxId = list.reduce((m, s) => Math.max(m, s.id), 0);
                list.push({ id: maxId + 1, username, password, name, role });
                App.toast('Membre ajoute');
            }
            App.staff = list;
            this.closeModal();
            App.render();
        },

        remove(id) {
            if (!confirm('Supprimer ce membre ?')) return;
            const list = App.staff.filter(s => s.id !== id);
            App.staff = list;
            App.toast('Membre supprime');
            App.render();
        }
    }
};

document.addEventListener('DOMContentLoaded', () => App.init());
