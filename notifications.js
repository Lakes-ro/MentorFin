/**
 * NOTIFICATIONS.JS v2.0
 * ✅ v1.0 (mantido): aviso de venda em tempo real pro vendedor
 *    (order_items INSERT) com toast + som + selo no botão BI.
 * ✅ v2.0 NOVO:
 *    • Escuta a tabela vendor_notifications (avisos enviados pelo
 *      Admin / sistema ao vendedor — ex: produto esgotado, bloqueio)
 *      em tempo real, e também mostra os avisos não lidos ao entrar.
 *      Antes essa tabela estava no Realtime mas nenhum código a lia.
 *    • Fallback na venda: se o produto não estiver na lista local
 *      (manageProducts ainda carregando), consulta o dono no banco —
 *      antes a venda passava batido nesse caso.
 *
 * LIMITAÇÃO: não é push de celular — só funciona com o site aberto.
 */

const Notifications = {
    channel: null,
    vendorChannel: null,
    unseenCount: 0,

    init() {
        try {
            if (!window.APP?.auth?.isSeller?.()) return;
            if (!window._supabase) return;

            this._subscribeRealtime();
            this._subscribeVendorNotifications();
            this._loadUnreadVendorNotifications();
            log('🔔 Notificações de venda ativadas', 'info');
        } catch (err) {
            log(`⚠️ Erro ao iniciar notificações: ${err.message}`, 'warning');
        }
    },

    _subscribeRealtime() {
        if (this.channel) return;

        this.channel = _supabase
            .channel('vendas-em-tempo-real')
            .on(
                'postgres_changes',
                { event: 'INSERT', schema: 'public', table: 'order_items' },
                (payload) => this._handleNewItem(payload.new)
            )
            .subscribe((status) => {
                if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    log(`⚠️ Realtime (vendas): ${status}`, 'warning');
                }
            });
    },

    async _handleNewItem(item) {
        try {
            const myId = window.APP?.auth?.userId;
            if (!myId) return;

            const myProducts = window.APP?.products?.manageProducts || [];
            let product = myProducts.find(p => p.id === item.product_id);

            // Fallback: lista local ainda não tem o produto
            if (!product) {
                const { data } = await _supabase
                    .from('products')
                    .select('id, name, owner_id')
                    .eq('id', item.product_id)
                    .maybeSingle();
                product = data || null;
            }

            if (!product || product.owner_id !== myId) return;

            this._showSaleToast(product.name, item.quantity || 1, item.unit_price || 0);
            this._bumpBadge();
        } catch (err) {
            log(`⚠️ Erro ao processar aviso de venda: ${err.message}`, 'warning');
        }
    },

    // ===== AVISOS DO ADMIN / SISTEMA (vendor_notifications) =====

    _subscribeVendorNotifications() {
        if (this.vendorChannel) return;
        const myId = window.APP?.auth?.userId;
        if (!myId) return;

        this.vendorChannel = _supabase
            .channel('avisos-do-vendedor')
            .on(
                'postgres_changes',
                { event: 'INSERT', schema: 'public', table: 'vendor_notifications', filter: `vendor_id=eq.${myId}` },
                (payload) => this._handleVendorNotification(payload.new)
            )
            .subscribe((status) => {
                if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    log(`⚠️ Realtime (avisos): ${status}`, 'warning');
                }
            });
    },

    async _loadUnreadVendorNotifications() {
        try {
            const myId = window.APP?.auth?.userId;
            if (!myId) return;

            const { data, error } = await _supabase
                .from('vendor_notifications')
                .select('id, title, message, product_id, created_at')
                .eq('vendor_id', myId)
                .is('read_at', null)
                .order('created_at', { ascending: false })
                .limit(5);

            if (error) throw error;

            (data || []).forEach((n, i) => {
                setTimeout(() => this._handleVendorNotification(n), i * 900);
            });
        } catch (err) {
            log(`⚠️ Erro ao carregar avisos não lidos: ${err.message}`, 'warning');
        }
    },

    _handleVendorNotification(n) {
        try {
            if (!n) return;
            this._showVendorToast(n);
            this._markAsRead(n.id);
        } catch (err) {
            log(`⚠️ Erro ao exibir aviso: ${err.message}`, 'warning');
        }
    },

    async _markAsRead(id) {
        if (!id) return;
        try {
            await _supabase
                .from('vendor_notifications')
                .update({ read_at: new Date().toISOString() })
                .eq('id', id)
                .is('read_at', null);
        } catch (err) {
            log(`⚠️ Erro ao marcar aviso como lido: ${err.message}`, 'warning');
        }
    },

    _getToastContainer() {
        let container = document.getElementById('cart-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'cart-toast-container';
            document.body.appendChild(container);
        }
        return container;
    },

    _showVendorToast(n) {
        const container = this._getToastContainer();
        const esc = window.escapeHtml || ((s) => s);

        const toast = document.createElement('div');
        toast.className = 'cart-toast mod-toast mod-toast-flagged';
        toast.innerHTML = `
            <i data-lucide="bell-ring" class="cart-toast-icon"></i>
            <span>🔔 ${esc(n.title || 'Aviso')}${n.message ? ' — ' + esc(n.message) : ''}</span>
        `;
        toast.addEventListener('click', () => {
            if (n.product_id) window.APP?.navigation?.showTab('seller');
        });
        container.appendChild(toast);

        window.playNotificationSound?.('moderation');
        if (window.lucide) lucide.createIcons();

        requestAnimationFrame(() => toast.classList.add('cart-toast-show'));

        setTimeout(() => {
            toast.classList.remove('cart-toast-show');
            toast.classList.add('cart-toast-hide');
            setTimeout(() => toast.remove(), 300);
        }, 8000);
    },

    // ===== VENDA =====

    _showSaleToast(name, qty, unitPrice) {
        const container = this._getToastContainer();

        const total = (unitPrice || 0) * (qty || 1);
        const safeName = window.escapeHtml ? window.escapeHtml(name) : name;
        const toast = document.createElement('div');
        toast.className = 'cart-toast sale-toast';
        toast.innerHTML = `
            <i data-lucide="party-popper" class="cart-toast-icon"></i>
            <span>🎉 Venda! ${qty > 1 ? qty + 'x ' : ''}${safeName} — R$ ${window.formatBRL(total)} · confirme em até 2h</span>
        `;
        container.appendChild(toast);

        window.playNotificationSound?.('sale');

        if (window.lucide) lucide.createIcons();

        requestAnimationFrame(() => toast.classList.add('cart-toast-show'));

        setTimeout(() => {
            toast.classList.remove('cart-toast-show');
            toast.classList.add('cart-toast-hide');
            setTimeout(() => toast.remove(), 300);
        }, 4500);
    },

    _bumpBadge() {
        this.unseenCount++;
        this._renderBadge();
    },

    _renderBadge() {
        ['bi-nav-btn', 'bnav-bi'].forEach(id => {
            const btn = document.getElementById(id);
            if (!btn) return;

            let badge = btn.querySelector('.sale-badge');
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'sale-badge';
                btn.appendChild(badge);
            }

            badge.textContent = this.unseenCount > 9 ? '9+' : String(this.unseenCount);
            badge.style.display = this.unseenCount > 0 ? 'flex' : 'none';
        });
    },

    clearUnseen() {
        this.unseenCount = 0;
        this._renderBadge();
    },

    teardown() {
        if (this.channel) {
            _supabase.removeChannel(this.channel);
            this.channel = null;
        }
        if (this.vendorChannel) {
            _supabase.removeChannel(this.vendorChannel);
            this.vendorChannel = null;
        }
        this.unseenCount = 0;
    }
};

window.Notifications = Notifications;
