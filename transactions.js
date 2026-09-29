/**
 * TRANSACTIONS.JS - LÓGICA DE TRANSAÇÕES
 * ================================================
 * ATUALIZAÇÃO — HISTÓRICO FILTRÁVEL + EDIÇÃO/EXCLUSÃO:
 * - renderTransactions() agora aceita `filter.dataInicio` e
 *   `filter.dataFim` ('YYYY-MM-DD', comparação inclusiva sobre
 *   `data_competencia`), usados pelos filtros de período do painel do
 *   cliente (ver app.js: getFiltroHistoricoAtual/renderClientTransactionHistory).
 * - Cada transação renderizada agora tem botões ✏️ (editar) e 🗑️
 *   (excluir), ligados via ligarBotoesDeAcaoDaTransacao() logo após o
 *   HTML ser inserido no container. Os cliques delegam para
 *   abrirModalEditarTransacao()/handleDeletarTransacaoRapido(), ambos
 *   definidos em app.js — daí a checagem `typeof === 'function'`, para
 *   este módulo não quebrar se um dia for usado numa página sem esses
 *   handlers (ex: uma futura tela de admin só-leitura).
 * - updateTransaction()/deleteTransaction() foram adicionados ao
 *   módulo espelhando o padrão já usado por addTransaction (delega pro
 *   DatabaseModule e mantém o cache interno `allTransactions`
 *   sincronizado, para quem usar esse cache — hoje em dia o fluxo do
 *   cliente usa seu próprio cache em app.js, `clienteTransacoesCache`,
 *   e passa a lista explicitamente como 3º argumento, então este
 *   cache interno só importa para quem chamar loadAllTransactions()).
 *
 * ATUALIZAÇÃO — MOEDA NO PADRÃO BRASILEIRO:
 * `formatTransaction()` usa `UIModule.formatCurrency()` (separador de
 * milhar "." e decimal ",").
 *
 * ATUALIZAÇÃO — SEGURANÇA: descrição, categoria e nome do cliente
 * passam por escaparHtml() (seguranca.js) antes de irem para o HTML.
 */

const TransactionsModule = (() => {
    let allTransactions = [];

    // Rótulos legíveis para o campo `categorias.grupo` (essencial |
    // estilo_de_vida | investimento | divida | transferencia | renda).
    const GRUPO_LABEL = {
        essencial:      'Essencial',
        estilo_de_vida: 'Estilo de Vida',
        investimento:   'Investimento',
        divida:         'Dívida/Financiamento',
        transferencia:  'Transferência Interna',
        renda:          'Renda'
    };

    const esc = (texto) => (typeof escaparHtml === 'function' ? escaparHtml(texto) : String(texto ?? ''));

    const formatTransaction = (t) => {
        const data = t.data_competencia
            ? new Date(t.data_competencia + 'T00:00:00').toLocaleDateString('pt-BR')
            : '—';

        const clienteNome   = t.clientes?.nome     || '';
        const categoriaNome = t.categorias?.nome   || 'Sem categoria';
        const grupoLabel    = GRUPO_LABEL[t.categorias?.grupo] || '';
        const descricao     = t.descricao ? ` · ${esc(t.descricao)}` : '';

        const linhaDesc = clienteNome
            ? `${esc(clienteNome)} — ${esc(categoriaNome)}${descricao}`
            : `${esc(categoriaNome)}${descricao}`;

        const valorFormatado = UIModule.formatCurrency(t.valor);

        return `
            <div class="transaction-item ${t.tipo}" data-transaction-id="${t.id}">
                <div class="transaction-info">
                    <div class="transaction-description">${linhaDesc}</div>
                    <div class="transaction-category">${grupoLabel}</div>
                    <div class="transaction-date">${data}</div>
                </div>
                <div class="transaction-value-actions">
                    <div class="transaction-value ${t.tipo}">
                        ${t.tipo === 'receita' ? '+' : '−'} ${valorFormatado}
                    </div>
                    <div class="transaction-actions">
                        <button type="button" class="btn-transaction-edit" data-id="${t.id}" title="Editar transação">✏️</button>
                        <button type="button" class="btn-transaction-delete" data-id="${t.id}" title="Excluir transação">🗑️</button>
                    </div>
                </div>
            </div>
        `;
    };

    return {
        async loadAllTransactions(adminId) {
            try {
                allTransactions = await DatabaseModule.getAllTransactions(adminId);
                return allTransactions;
            } catch (error) {
                console.error('❌ Erro ao carregar transações:', error);
                throw error;
            }
        },

        async addTransaction(transactionData) {
            try {
                const result = await DatabaseModule.addTransaction(transactionData);
                allTransactions.unshift(result);
                return result;
            } catch (error) {
                console.error('❌ Erro ao adicionar transação:', error);
                throw error;
            }
        },

        async updateTransaction(transactionId, updates) {
            try {
                const result = await DatabaseModule.updateTransaction(transactionId, updates);
                const index = allTransactions.findIndex(t => t.id === transactionId);
                if (index !== -1) allTransactions[index] = result;
                return result;
            } catch (error) {
                console.error('❌ Erro ao atualizar transação:', error);
                throw error;
            }
        },

        async deleteTransaction(transactionId) {
            try {
                await DatabaseModule.deleteTransaction(transactionId);
                allTransactions = allTransactions.filter(t => t.id !== transactionId);
                return true;
            } catch (error) {
                console.error('❌ Erro ao excluir transação:', error);
                throw error;
            }
        },

        /**
         * @param {string} containerId  - ID do elemento onde renderizar
         * @param {Object} [filter={}]  - Filtros opcionais:
         *   { clientId, type, dataInicio, dataFim }
         *   dataInicio/dataFim: 'YYYY-MM-DD', comparação inclusiva sobre
         *   `data_competencia`.
         * @param {Array}  [list=null]  - Lista explícita (sobrescreve allTransactions)
         */
        renderTransactions(containerId, filter = {}, list = null) {
            const container = document.getElementById(containerId);
            if (!container) return;

            let source = list || allTransactions;

            if (filter.clientId) {
                source = source.filter(t => t.client_id === filter.clientId);
            }

            if (filter.type && filter.type !== 'all') {
                source = source.filter(t => t.tipo === filter.type);
            }

            if (filter.dataInicio) {
                source = source.filter(t => t.data_competencia && t.data_competencia >= filter.dataInicio);
            }

            if (filter.dataFim) {
                source = source.filter(t => t.data_competencia && t.data_competencia <= filter.dataFim);
            }

            const html = source.map(t => formatTransaction(t)).join('');
            const temFiltroAtivo = !!(filter.type || filter.dataInicio || filter.dataFim);
            const mensagemVazio = temFiltroAtivo
                ? 'Nenhuma transação encontrada para o filtro selecionado'
                : 'Nenhuma transação registrada';

            UIModule.setHTML(containerId, html || `<p class="empty-state">${mensagemVazio}</p>`);
            ligarBotoesDeAcaoDaTransacao(container);
        },

        getTransactions:  () => allTransactions,
        filterByClient:   (clientId) => allTransactions.filter(t => t.client_id === clientId),
        filterByType:     (type)     => allTransactions.filter(t => t.tipo === type)
    };
})();

// ── Ações por transação (editar/excluir) ───────────────────────
// Função global (não faz parte do IIFE) porque precisa ser chamada
// após CADA renderização (o container inteiro é substituído via
// innerHTML a cada render, então os listeners antigos são descartados
// junto com o HTML velho).
function ligarBotoesDeAcaoDaTransacao(container) {
    if (!container) return;

    container.querySelectorAll('.btn-transaction-edit').forEach(btn => {
        btn.addEventListener('click', () => {
            if (typeof abrirModalEditarTransacao === 'function') {
                abrirModalEditarTransacao(btn.dataset.id);
            } else {
                console.warn('⚠️ abrirModalEditarTransacao não está definida (app.js carregado?).');
            }
        });
    });

    container.querySelectorAll('.btn-transaction-delete').forEach(btn => {
        btn.addEventListener('click', () => {
            if (typeof handleDeletarTransacaoRapido === 'function') {
                handleDeletarTransacaoRapido(btn.dataset.id);
            } else {
                console.warn('⚠️ handleDeletarTransacaoRapido não está definida (app.js carregado?).');
            }
        });
    });
}

console.log('✅ transactions.js carregado');
