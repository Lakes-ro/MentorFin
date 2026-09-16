/**
 * UI.JS — UTILITÁRIOS DE INTERFACE
 * ================================================
 * Padrão: script global (IIFE). Sem import/export.
 *
 * ATUALIZAÇÃO — FORMATCURRENCY (padrão brasileiro):
 * Vários pontos do painel do cliente (dashboard.js, transactions.js,
 * goals.js, app.js) formatavam valores manualmente com
 * `R$ ${valor.toFixed(2)}`, o que produz "R$ 2303.00" em vez do
 * padrão brasileiro "R$ 2.303,00" (separador de milhar com ponto,
 * decimal com vírgula). `UIModule.formatCurrency()` centraliza isso
 * usando `toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })`
 * — o mesmo mecanismo que `formatCurrency()` do admin.js já usa
 * corretamente do lado do administrador. Todos os pontos do painel do
 * cliente que exibem dinheiro foram migrados para chamar esta função.
 */

const UIModule = (() => {
    return {
        showScreen(screenId) {
            document.querySelectorAll('.screen').forEach(s => {
                s.classList.remove('active');
            });

            const screen = document.getElementById(screenId);
            if (screen) {
                screen.classList.add('active');
            }

            document.body.classList.add('app-ready');
        },

        showSection(sectionId) {
            document.querySelectorAll('.view-section').forEach(s => {
                s.classList.remove('active');
            });

            const section = document.getElementById(sectionId);
            if (section) {
                section.classList.add('active');
            }
        },

        /**
         * ⚠️ CORREÇÃO — AVISO ESCONDIDO ATRÁS DO MODAL DE IMPORTAÇÃO:
         * este aviso usava z-index 10000, o MESMO valor do modal
         * (.modal em style.css) e MENOS que o modal do admin
         * (.modal-overlay, 10050). Empatado ou abaixo, ele era pintado
         * atrás do pop-up — e justamente a mensagem mais importante do
         * fluxo (a que diz qual linha está impedindo a importação)
         * ficava ilegível. Agora sobe para o topo absoluto da pilha.
         *
         * Junto com isso: erro fica 9s na tela (contra 3s), porque a
         * mensagem de impedimento traz o nome da linha e o motivo — não
         * dá para ler e corrigir em 3 segundos — e qualquer aviso pode
         * ser fechado no clique.
         */
        showMessage(message, type = 'info', duration = null) {
            const tempo = duration ?? (type === 'error' ? 9000 : 3000);
            const msgDiv = document.createElement('div');
            msgDiv.className = `message message--${type}`;
            msgDiv.textContent = message;
            msgDiv.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                left: auto;
                max-width: min(420px, calc(100vw - 40px));
                padding: 15px 20px;
                border-radius: 8px;
                z-index: 2147483000;
                cursor: pointer;
                background: rgba(26,26,46,0.97);
                border: 1px solid rgba(100,150,255,0.3);
                color: #e0e0e0;
                font-family: inherit;
                font-size: 14px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.5);
                animation: slideIn 0.3s ease;
            `;

            if (type === 'error')   { msgDiv.style.borderColor = 'rgba(255,100,100,0.5)'; msgDiv.style.color = '#ff6b6b'; }
            if (type === 'success') { msgDiv.style.borderColor = 'rgba(100,255,122,0.5)'; msgDiv.style.color = '#64ff7a'; }

            msgDiv.title = 'Clique para fechar';
            msgDiv.addEventListener('click', () => msgDiv.remove());

            document.body.appendChild(msgDiv);

            setTimeout(() => {
                msgDiv.style.opacity = '0';
                msgDiv.style.transform = 'translateX(20px)';
                msgDiv.style.transition = 'opacity 0.3s, transform 0.3s';
                setTimeout(() => msgDiv.remove(), 320);
            }, tempo);
        },

        showError(message)   { this.showMessage(message || '❌ Erro', 'error'); },
        showSuccess(message) { this.showMessage(message || '✅ Sucesso', 'success'); },

        openModal(modalId) {
            const modal = document.getElementById(modalId);
            if (modal) modal.classList.remove('hidden');
        },

        closeModal(modalId) {
            const modal = document.getElementById(modalId);
            if (modal) modal.classList.add('hidden');
        },

        setText(elementId, text) {
            const el = document.getElementById(elementId);
            if (el) el.textContent = text;
        },

        setHTML(elementId, html) {
            const el = document.getElementById(elementId);
            if (el) el.innerHTML = html;
        },

        addClass(elementId, className) {
            const el = document.getElementById(elementId);
            if (el) el.classList.add(className);
        },

        removeClass(elementId, className) {
            const el = document.getElementById(elementId);
            if (el) el.classList.remove(className);
        },

        setFormValue(formId, fieldId, value) {
            const form  = document.getElementById(formId);
            const field = form?.querySelector(`[name="${fieldId}"]`);
            if (field) field.value = value;
        },

        getFormData(formId) {
            const form = document.getElementById(formId);
            if (!form) return null;
            return Object.fromEntries(new FormData(form));
        },

        clearForm(formId) {
            const form = document.getElementById(formId);
            if (form) form.reset();
        },

        showLoading(elementId) {
            const el = document.getElementById(elementId);
            if (el) el.innerHTML = '<p class="empty-state">⏳ Carregando...</p>';
        },

        hideLoading(elementId) {
            const el = document.getElementById(elementId);
            if (el) el.innerHTML = '';
        },

        /**
         * Formata um valor numérico no padrão monetário brasileiro:
         * separador de milhar "." e decimal ",", com o símbolo "R$"
         * (ex: 150132456 -> "R$ 150.132.456,00"). Usar SEMPRE esta
         * função em vez de `R$ ${valor.toFixed(2)}` em qualquer lugar
         * que exiba dinheiro no painel do cliente.
         */
        formatCurrency(valor) {
            const n = parseFloat(valor) || 0;
            return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        }
    };
})();

setTimeout(() => document.body.classList.add('app-ready'), 2000);

console.log('✅ ui.js carregado');
