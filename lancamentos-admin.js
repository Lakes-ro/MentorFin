/**
 * LANCAMENTOS-ADMIN.JS — Lançamento Manual e Importação de Extrato
 * PELO ADMIN, em nome de um cliente específico.
 * ================================================
 * Padrão: script global. Sem import/export.
 *
 * POR QUE ESTE ARQUIVO EXISTE:
 * O formulário de transação e a importação de extrato (OFX/CSV) já
 * existem prontos no painel do CLIENTE (smart-input.js +
 * importacao-extrato.js) — com toda a inteligência de classificação
 * automática (sinônimos cadastrados, nome da categoria, radical,
 * grupos semânticos, regras Nubank pré-classificadas). Só que esses
 * dois arquivos são escritos pra rodar dentro da SESSÃO do próprio
 * cliente: dependem de três globals que só existem em
 * client.html/index.html — `ClientModule` (sabe o id do cliente
 * logado), `DatabaseModule` (camada de acesso ao banco) e `UIModule`
 * (toasts/mensagens). Nenhum dos três existe no admin.
 *
 * Em vez de duplicar centenas de linhas de lógica de classificação,
 * este arquivo cria uma versão MÍNIMA desses três objetos — apontando
 * sempre pro CLIENTE SELECIONADO no modal, em vez do cliente logado
 * — e reaproveita smart-input.js/importacao-extrato.js SEM modificar
 * nenhum dos dois. O modal de importação em admin.html usa
 * PROPOSITALMENTE os MESMOS ids de elemento que o painel do cliente
 * (#importFileInput, #btnProcessarImportacao, #importReviewTableBody
 * etc.) — é assim que importacao-extrato.js (carregado sem alteração
 * nenhuma) encontra e liga os eventos certos sozinho, sem precisar de
 * nenhuma gambiarra de integração.
 *
 * O Lançamento Manual, por outro lado, é uma implementação PRÓPRIA
 * (mais simples, com um <select> nativo agrupado em vez do dropdown
 * customizado do painel do cliente) — o dropdown customizado
 * (custom-select) e sua navegação por teclado vivem em app.js, que
 * tem efeitos colaterais perigosos demais pra carregar dentro do
 * admin (ex: redireciona sozinho pra admin.html se detectar sessão de
 * admin, o que causaria loop de reload). Mesmo assim, o Lançamento
 * Manual AQUI reaproveita a mesma função pura de sugestão de
 * categoria (`encontrarCategoriaPorPalavraChave`, de smart-input.js)
 * pra sugerir automaticamente, então o admin ganha a mesma
 * inteligência, só que numa UI mais simples.
 *
 * ⚠️ ORDEM DE CARREGAMENTO NO admin.html (crítica): este arquivo deve
 * vir DEPOIS de smart-input.js, regras-aprendidas.js e
 * importacao-extrato.js — embora funções sejam hoisted e só executem
 * no clique do utilizador (quando todos os scripts já carregaram),
 * manter essa ordem deixa a dependência explícita e evita confusão
 * futura.
 */

// ══════════════════════════════════════════════════════════════
// SHIMS — versões mínimas de ClientModule/DatabaseModule/UIModule
// ══════════════════════════════════════════════════════════════

let adminClienteSelecionadoId = null; // cliente atualmente selecionado no modal

/**
 * Substituto mínimo do ClientModule (o de verdade vive em client.js,
 * que o admin.html não carrega) — só os métodos que
 * importacao-extrato.js realmente chama. `getClientId()` aponta
 * sempre pro cliente escolhido no seletor do modal, não pra sessão
 * logada (aqui é sempre o admin).
 */
const ClientModule = {
    getClientId: () => adminClienteSelecionadoId,

    async addTransaction(transactionData) {
        const { data, error } = await supabaseClient.from('transacoes').insert([marcarComoLancamentoDoAdmin(transactionData)]).select();
        if (error) throw error;
        return data?.[0];
    },

    async updateTransaction(transactionId, updates) {
        const { data, error } = await supabaseClient.from('transacoes').update(updates).eq('id', transactionId).select();
        if (error) throw error;
        return data?.[0];
    },

    async deleteTransaction(transactionId) {
        const { error } = await supabaseClient.from('transacoes').delete().eq('id', transactionId);
        if (error) throw error;
        return true;
    }
};

/**
 * Substituto mínimo do DatabaseModule (o de verdade vive em
 * database.js) — só os métodos que importacao-extrato.js/
 * smart-input.js realmente chamam.
 */
/**
 * Tudo o que o ADMIN grava pelo painel (lançamento manual OU importação
 * de extrato para um cliente) sai com origem 'lancamento_admin'. A
 * gamificação usa isso para não contar o trabalho do admin como esforço
 * do cliente (semanas em dia, conquistas, missões). Os números
 * financeiros continuam usando esses lançamentos normalmente.
 */
function marcarComoLancamentoDoAdmin(linha) {
    return linha && linha.origem === 'importacao' ? { ...linha, origem: 'lancamento_admin' } : linha;
}

const DatabaseModule = {
    async getCategorias() {
        // CORREÇÃO DE VAZAMENTO: o admin enxerga TODAS as categorias (RLS), inclusive as
        // pessoais de outros clientes — que apareciam na importação e viravam regras
        // apontando para categoria de outra pessoa. Agora: globais + as do cliente selecionado.
        let consulta = supabaseClient.from('categorias').select('*');
        consulta = adminClienteSelecionadoId
            ? consulta.or(`cliente_id.is.null,cliente_id.eq.${adminClienteSelecionadoId}`)
            : consulta.is('cliente_id', null);

        const { data, error } = await consulta
            .order('tipo', { ascending: false })
            .order('grupo')
            .order('nome');
        if (error) throw error;
        return data || [];
    },

    async addTransaction(transactionData) {
        const { data, error } = await supabaseClient.from('transacoes').insert([marcarComoLancamentoDoAdmin(transactionData)]).select();
        if (error) throw error;
        return data?.[0];
    },

    async addTransactionsBulk(transactionsData) {
        const { data, error } = await supabaseClient.from('transacoes').insert(transactionsData.map(marcarComoLancamentoDoAdmin)).select();
        if (error) throw error;
        return data || [];
    }
};

/**
 * Substituto mínimo do UIModule (o de verdade vive em ui.js) — só os
 * métodos que importacao-extrato.js chama, redirecionados pro
 * showToast() que já existe em admin.js.
 */
const UIModule = {
    showError(msg)   { showToast(msg || 'Erro', 'error'); },
    showSuccess(msg) { showToast(msg || 'Sucesso', 'success'); },
    showMessage(msg, tipo) { showToast(msg, tipo === 'error' ? 'error' : 'success'); }
};

/**
 * importacao-extrato.js chama `await loadClientDashboard()` ao final
 * de uma importação bem-sucedida — no painel do cliente isso
 * recarrega o dashboard dele; aqui, atualiza só a lista de "Últimos
 * Lançamentos" do cliente selecionado, dentro do próprio modal.
 */
async function loadClientDashboard() {
    if (adminClienteSelecionadoId) {
        await carregarUltimosLancamentosDoCliente(adminClienteSelecionadoId);
    }
}

// ══════════════════════════════════════════════════════════════
// MODAL: SELEÇÃO DE CLIENTE + ABAS (Manual / Importar Extrato)
// ══════════════════════════════════════════════════════════════

let categoriasCacheLancamentoManual = [];

function initLancamentosAdmin() {
    document.getElementById('lancamentos-cliente-select')
        ?.addEventListener('change', (e) => selecionarClienteParaLancamento(e.target.value));

    document.querySelectorAll('.lancamentos-admin__tab').forEach(tab => {
        tab.addEventListener('click', () => ativarAbaLancamentosAdmin(tab.dataset.tab));
    });

    document.getElementById('lancamento-manual-form')
        ?.addEventListener('submit', handleLancamentoManualAdmin);

    document.getElementById('lancamento-manual-descricao')
        ?.addEventListener('blur', sugerirCategoriaLancamentoManual);
}

/**
 * Abre o modal já com um cliente pré-selecionado (chamado pelo botão
 * "📥 Lançamentos" de cada card em clientes.js). Se nenhum id for
 * passado, abre com o seletor vazio pra o admin escolher.
 */
async function abrirModalLancamentosAdmin(clienteIdPreSelecionado) {
    if (!allClientes.length) await loadAllClientes();

    const select = document.getElementById('lancamentos-cliente-select');
    if (select) {
        select.innerHTML = '<option value="">Selecione um cliente...</option>' +
            allClientes
                .slice()
                .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
                .map(c => `<option value="${c.id}" ${c.id === clienteIdPreSelecionado ? 'selected' : ''}>${escaparHtml(c.nome)}</option>`)
                .join('');
    }

    // Limpa qualquer importação pendente de uma sessão anterior do
    // modal (função já existe em importacao-extrato.js, reaproveitada
    // sem alteração).
    if (typeof cancelarImportacao === 'function') cancelarImportacao();

    ativarAbaLancamentosAdmin('manual');
    document.getElementById('lancamento-manual-form')?.reset();

    if (clienteIdPreSelecionado) {
        await selecionarClienteParaLancamento(clienteIdPreSelecionado);
    } else {
        adminClienteSelecionadoId = null;
        document.getElementById('lancamentos-conteudo')?.classList.add('hidden');
    }

    openModal('modal-lancamentos-admin');
}

async function selecionarClienteParaLancamento(clienteId) {
    adminClienteSelecionadoId = clienteId || null;

    const conteudo = document.getElementById('lancamentos-conteudo');
    const select   = document.getElementById('lancamentos-cliente-select');
    if (select && select.value !== (clienteId || '')) select.value = clienteId || '';

    if (!adminClienteSelecionadoId) {
        conteudo?.classList.add('hidden');
        return;
    }

    conteudo?.classList.remove('hidden');

    categoriasCacheLancamentoManual = await DatabaseModule.getCategorias();
    popularSelectCategoriaManual(categoriasCacheLancamentoManual);

    const campoData = document.getElementById('lancamento-manual-data');
    if (campoData && !campoData.value) campoData.value = getDataDeHojeFormatoInputAdmin();

    await carregarUltimosLancamentosDoCliente(adminClienteSelecionadoId);
}

function ativarAbaLancamentosAdmin(nomeAba) {
    document.querySelectorAll('.lancamentos-admin__tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === nomeAba);
    });
    document.querySelectorAll('.lancamentos-admin__tab-content').forEach(c => {
        c.classList.toggle('active', c.id === `lancamentos-tab-${nomeAba}`);
    });
}

function getDataDeHojeFormatoInputAdmin() {
    const agora = new Date();
    const ano = agora.getFullYear();
    const mes = String(agora.getMonth() + 1).padStart(2, '0');
    const dia = String(agora.getDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}`;
}

// ══════════════════════════════════════════════════════════════
// ABA: LANÇAMENTO MANUAL
// ══════════════════════════════════════════════════════════════

function popularSelectCategoriaManual(categorias) {
    const select = document.getElementById('lancamento-manual-categoria');
    if (!select) return;

    const porGrupo = {};
    categorias.forEach(c => {
        const chave = `${c.tipo}__${c.grupo}`;
        if (!porGrupo[chave]) porGrupo[chave] = [];
        porGrupo[chave].push(c);
    });

    const ordemGrupos = [
        'receita__renda', 'receita__transferencia',
        'despesa__essencial', 'despesa__estilo_de_vida', 'despesa__investimento',
        'despesa__divida', 'despesa__transferencia'
    ];
    const labelGrupo = {
        renda: '📈 Renda', essencial: '🟠 Essencial', estilo_de_vida: '🎯 Estilo de Vida',
        investimento: '💰 Investimento', divida: '💳 Dívida', transferencia: '🔄 Transferência'
    };

    const chaves = [...ordemGrupos.filter(k => porGrupo[k]), ...Object.keys(porGrupo).filter(k => !ordemGrupos.includes(k))];

    let html = '<option value="">Selecione a categoria...</option>';
    chaves.forEach(chave => {
        const [, grupo] = chave.split('__');
        const label = labelGrupo[grupo] || grupo;
        porGrupo[chave]
            .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
            .forEach(c => {
                html += `<option value="${c.id}" data-tipo="${c.tipo}">${label} — ${escaparHtml(c.nome)}</option>`;
            });
    });

    select.innerHTML = html;
}

/**
 * Ao sair do campo Descrição, tenta sugerir a categoria — reaproveita
 * a MESMA função pura de classificação do painel do cliente
 * (encontrarCategoriaPorPalavraChave, de smart-input.js): sinônimos
 * cadastrados, nome da categoria, radical e grupos semânticos. Só
 * preenche o <select> nativo — nunca cria nem força nada, é só uma
 * sugestão que o admin pode trocar antes de salvar.
 */
function sugerirCategoriaLancamentoManual() {
    const descricao = document.getElementById('lancamento-manual-descricao')?.value.trim();
    if (!descricao || descricao.length < 3) return;
    if (typeof encontrarCategoriaPorPalavraChave !== 'function') return;

    const match = encontrarCategoriaPorPalavraChave(categoriasCacheLancamentoManual, descricao);
    if (!match) return;

    const select = document.getElementById('lancamento-manual-categoria');
    if (select) select.value = match.id;

    const aviso = match._confiancaAlta === false
        ? `🔎 Sugestão por semelhança: ${escaparHtml(match.nome)} — confira antes de salvar`
        : `🤖 Categoria sugerida: ${escaparHtml(match.nome)}`;
    showToast(aviso, match._confiancaAlta === false ? 'error' : 'success');
}

async function handleLancamentoManualAdmin(event) {
    event.preventDefault();

    if (!adminClienteSelecionadoId) { showToast('Selecione um cliente primeiro.', 'error'); return; }

    const descricao   = document.getElementById('lancamento-manual-descricao').value.trim();
    const categoriaId = document.getElementById('lancamento-manual-categoria').value;
    const valor       = parseFloat(document.getElementById('lancamento-manual-valor').value);
    const data        = document.getElementById('lancamento-manual-data').value;

    if (!categoriaId)         { showToast('Selecione uma categoria.', 'error'); return; }
    if (!data)                { showToast('Data é obrigatória.', 'error'); return; }
    if (!valor || valor <= 0) { showToast('Informe um valor válido.', 'error'); return; }

    const cat = categoriasCacheLancamentoManual.find(c => c.id === categoriaId);
    if (!cat) { showToast('Categoria inválida.', 'error'); return; }

    const btn = event.target.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }

    try {
        await ClientModule.addTransaction({
            client_id:        adminClienteSelecionadoId,
            categoria_id:     categoriaId,
            valor,
            data_competencia: data,
            descricao,
            tipo:             cat.tipo,
            origem:           'lancamento_admin'
        });

        // Aprende a classificação pro futuro, igual acontece no painel
        // do cliente — falha ao aprender não deve travar o lançamento
        // em si (já foi salvo com sucesso na linha acima).
        if (typeof RegrasAprendidasModule !== 'undefined' && descricao) {
            try {
                await RegrasAprendidasModule.salvarOuAtualizarRegra({
                    clienteId:   adminClienteSelecionadoId,
                    termoBusca:  descricao,
                    categoriaId: cat.id,
                    tipo:        cat.tipo
                });
            } catch (_) { /* não crítico */ }
        }

        showToast('Lançamento registrado!');
        event.target.reset();
        document.getElementById('lancamento-manual-data').value = getDataDeHojeFormatoInputAdmin();
        document.getElementById('lancamento-manual-descricao')?.focus();

        await carregarUltimosLancamentosDoCliente(adminClienteSelecionadoId);
    } catch (err) {
        showToast('Erro ao registrar: ' + err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '➕ Registrar Lançamento'; }
    }
}

async function carregarUltimosLancamentosDoCliente(clienteId) {
    const container = document.getElementById('lancamentos-admin-recentes');
    if (!container) return;

    container.innerHTML = '<p class="empty-state">Carregando...</p>';

    const { data, error } = await supabaseClient
        .from('transacoes')
        .select('id, valor, tipo, descricao, data_competencia, created_at, categorias(nome)')
        .eq('client_id', clienteId)
        .order('data_competencia', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(8);

    if (error) {
        container.innerHTML = `<p class="empty-state">Erro ao carregar: ${error.message}</p>`;
        return;
    }

    if (!data?.length) {
        container.innerHTML = '<p class="empty-state">Nenhum lançamento ainda.</p>';
        return;
    }

    container.innerHTML = data.map(t => `
        <div class="razonete-item ${t.tipo}">
            <div class="razonete-item-info">
                <span class="razonete-descricao">${escaparHtml(t.categorias?.nome) || 'Sem categoria'}${t.descricao ? ' · ' + escaparHtml(t.descricao) : ''}</span>
                <span class="razonete-data">${formatDate(t.data_competencia)}</span>
            </div>
            <span class="razonete-valor ${t.tipo === 'receita' ? 'positivo' : 'negativo'}">
                ${t.tipo === 'receita' ? '+' : '-'}${formatCurrency(Math.abs(t.valor))}
            </span>
        </div>
    `).join('');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLancamentosAdmin);
} else {
    initLancamentosAdmin();
}

console.log('✅ lancamentos-admin.js carregado (lançamento manual + importação de extrato pelo admin)');
