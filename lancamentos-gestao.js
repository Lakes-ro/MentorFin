/**
 * LANCAMENTOS-GESTAO.JS — Admin: criar, editar e excluir lançamentos
 * de um cliente (admin.html)
 * ================================================
 * Padrão: script global (IIFE `GestaoLancamentosAdmin`). Sem import/export.
 * Depende de: supabaseClient, showToast, formatCurrency, escaparHtml
 * (admin.js) e de dashboards.js (dashboardContextoAtual,
 * recarregarDashboardAtual). Carregar DEPOIS de dashboards.js.
 *
 * Onde aparece:
 *   1. Aba "📒 Lançamentos" do dashboard do cliente: lista TODOS os
 *      lançamentos do período escolhido (com busca e filtro por tipo),
 *      cada um com ✏️ Editar e 🗑️ Excluir, e o botão "➕ Novo lançamento".
 *   2. Painel "🔎 O que tem em …" do Resumo: ✏️/🗑️ em cada linha.
 *
 * O modal de edição é criado por este arquivo (não precisa de HTML).
 * Categorias oferecidas: globais + as pessoais DESTE cliente, só do tipo
 * escolhido (receita/despesa) — a mesma regra da importação.
 * Lançamento novo feito aqui é gravado com origem 'lancamento_admin'
 * (não conta como atividade do cliente na gamificação). Editar não muda
 * a origem. As metas se ajustam sozinhas (gatilho no banco).
 * Depois de salvar/excluir o dashboard inteiro é recarregado.
 *
 * Permissão: política RLS `transacoes_admin_all` (admin do cliente).
 */

const GestaoLancamentosAdmin = (() => {
  const GRUPO_ROTULO = {
    renda: '📈 Renda', essencial: '🟠 Essencial', estilo_de_vida: '🎯 Estilo de Vida',
    investimento: '💰 Investimento', divida: '💳 Dívidas e Financiamentos', transferencia: '🔄 Transferência Interna'
  };
  const ORDEM_GRUPOS = ['renda', 'essencial', 'estilo_de_vida', 'investimento', 'divida', 'transferencia'];

  let modal = null;
  let emEdicao = null;          // transação sendo editada (null = nova)
  let categoriasDoCliente = []; // cache por cliente
  let categoriasDeQuem = null;

  const esc = (s) => (typeof escaparHtml === 'function' ? escaparHtml(s) : String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'));
  const moeda = (v) => (typeof formatCurrency === 'function' ? formatCurrency(v) : `R$ ${Number(v).toFixed(2)}`);
  const hojeISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const contexto = () => (typeof dashboardContextoAtual !== 'undefined' ? dashboardContextoAtual : {});

  async function carregarCategorias(clienteId) {
    if (categoriasDeQuem === clienteId && categoriasDoCliente.length) return categoriasDoCliente;
    const { data, error } = await supabaseClient
      .from('categorias')
      .select('id, nome, tipo, grupo, cliente_id')
      .or(`cliente_id.is.null,cliente_id.eq.${clienteId}`)
      .order('nome');
    if (error) throw error;
    categoriasDoCliente = data || [];
    categoriasDeQuem = clienteId;
    return categoriasDoCliente;
  }

  function montarModal() {
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'modal-editar-lancamento';
    modal.className = 'modal-overlay hidden';
    modal.style.zIndex = '1200'; // por cima do modal do dashboard
    modal.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3 id="lanc-ed-titulo">✏️ Editar lançamento</h3>
          <button type="button" class="modal-close" data-acao="fechar" aria-label="Fechar">✕</button>
        </div>
        <div class="modal-body">
          <p class="panel-subtitle" id="lanc-ed-cliente" style="margin-bottom:0.75rem;"></p>
          <div class="form-group">
            <label>Tipo</label>
            <select id="lanc-ed-tipo">
              <option value="despesa">Despesa (saiu dinheiro)</option>
              <option value="receita">Receita (entrou dinheiro)</option>
            </select>
          </div>
          <div class="form-group">
            <label>Descrição</label>
            <input type="text" id="lanc-ed-descricao" maxlength="140" placeholder="Ex: Supermercado, Salário...">
          </div>
          <div class="form-group">
            <label>Categoria</label>
            <select id="lanc-ed-categoria"></select>
          </div>
          <div class="form-row-admin">
            <div class="form-group">
              <label>Valor (R$)</label>
              <input type="number" id="lanc-ed-valor" step="0.01" min="0.01" placeholder="0,00">
            </div>
            <div class="form-group">
              <label>Data</label>
              <input type="date" id="lanc-ed-data">
            </div>
          </div>
          <p class="panel-subtitle" id="lanc-ed-origem" style="font-size:0.72rem;"></p>
        </div>
        <div class="modal-footer" style="display:flex; gap:0.5rem; justify-content:space-between; flex-wrap:wrap;">
          <button type="button" class="btn-card deletar" id="lanc-ed-excluir">🗑️ Excluir</button>
          <div style="display:flex; gap:0.5rem; margin-left:auto;">
            <button type="button" class="btn-secondary" data-acao="fechar">Cancelar</button>
            <button type="button" class="btn-primary-sm" id="lanc-ed-salvar">Salvar</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);

    modal.querySelectorAll('[data-acao="fechar"]').forEach(b => b.addEventListener('click', fechar));
    modal.addEventListener('click', (e) => { if (e.target === modal) fechar(); });
    modal.querySelector('#lanc-ed-tipo').addEventListener('change', () => preencherCategorias(null));
    modal.querySelector('#lanc-ed-salvar').addEventListener('click', salvar);
    modal.querySelector('#lanc-ed-excluir').addEventListener('click', () => emEdicao && excluir(emEdicao));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) fechar();
    });
    return modal;
  }

  function preencherCategorias(selecionada) {
    const tipo = modal.querySelector('#lanc-ed-tipo').value;
    const sel = modal.querySelector('#lanc-ed-categoria');
    const doTipo = categoriasDoCliente.filter(c => c.tipo === tipo);
    const porGrupo = {};
    doTipo.forEach(c => { (porGrupo[c.grupo] = porGrupo[c.grupo] || []).push(c); });
    const grupos = [...ORDEM_GRUPOS, ...Object.keys(porGrupo).filter(g => !ORDEM_GRUPOS.includes(g))];

    sel.innerHTML = '<option value="">Escolha a categoria…</option>' + grupos
      .filter(g => porGrupo[g]?.length)
      .map(g => `<optgroup label="${esc(GRUPO_ROTULO[g] || g || 'Outras')}">${porGrupo[g]
        .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
        .map(c => `<option value="${c.id}">${esc(c.nome)}${c.cliente_id ? ' (pessoal)' : ''}</option>`).join('')}</optgroup>`)
      .join('');
    if (selecionada && doTipo.some(c => c.id === selecionada)) sel.value = selecionada;
  }

  /**
   * Abre o modal. transacao = linha de `transacoes` (com id) para editar,
   * ou null para um lançamento novo do cliente do dashboard aberto.
   */
  async function abrir(transacao = null) {
    const ctx = contexto();
    const clienteId = transacao?.client_id || ctx.clienteId;
    if (!clienteId) { showToast('Abra o dashboard de um cliente primeiro.', 'error'); return; }

    montarModal();
    emEdicao = transacao ? { ...transacao, client_id: clienteId } : null;

    try { await carregarCategorias(clienteId); }
    catch (err) { showToast('Erro ao carregar categorias: ' + err.message, 'error'); return; }

    modal.querySelector('#lanc-ed-titulo').textContent = transacao ? '✏️ Editar lançamento' : '➕ Novo lançamento';
    modal.querySelector('#lanc-ed-cliente').textContent = ctx.clienteNome ? `Cliente: ${ctx.clienteNome}` : '';
    modal.querySelector('#lanc-ed-tipo').value = transacao?.tipo || 'despesa';
    modal.querySelector('#lanc-ed-descricao').value = transacao?.descricao || '';
    modal.querySelector('#lanc-ed-valor').value = transacao ? Math.abs(parseFloat(transacao.valor) || 0).toFixed(2) : '';
    modal.querySelector('#lanc-ed-data').value = (transacao?.data_competencia || hojeISO()).slice(0, 10);
    preencherCategorias(transacao?.categoria_id || null);

    const origem = modal.querySelector('#lanc-ed-origem');
    origem.textContent = !transacao ? 'Será registrado como lançamento feito pelo consultor.'
      : transacao.origem === 'lancamento_admin' ? 'Lançado pelo consultor.'
      : transacao.origem === 'importacao' ? 'Veio de extrato importado.'
      : 'Lançado pelo cliente.';
    modal.querySelector('#lanc-ed-excluir').classList.toggle('hidden', !transacao);

    modal.classList.remove('hidden');
    setTimeout(() => modal.querySelector(transacao ? '#lanc-ed-descricao' : '#lanc-ed-valor')?.focus(), 30);
  }

  function fechar() {
    modal?.classList.add('hidden');
    emEdicao = null;
  }

  async function aposAlterar() {
    if (typeof recarregarDashboardAtual === 'function') await recarregarDashboardAtual();
  }

  async function salvar() {
    const ctx = contexto();
    const tipo = modal.querySelector('#lanc-ed-tipo').value;
    const descricao = modal.querySelector('#lanc-ed-descricao').value.trim();
    const categoriaId = modal.querySelector('#lanc-ed-categoria').value;
    const valor = parseFloat(String(modal.querySelector('#lanc-ed-valor').value).replace(',', '.'));
    const data = modal.querySelector('#lanc-ed-data').value;

    if (!categoriaId) { showToast('Escolha a categoria.', 'error'); return; }
    if (!(valor > 0)) { showToast('Informe um valor maior que zero.', 'error'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) { showToast('Informe a data.', 'error'); return; }
    const cat = categoriasDoCliente.find(c => c.id === categoriaId);
    if (!cat || cat.tipo !== tipo) { showToast('A categoria precisa ser do mesmo tipo do lançamento.', 'error'); return; }

    const btn = modal.querySelector('#lanc-ed-salvar');
    btn.disabled = true; btn.textContent = 'Salvando...';
    try {
      const campos = { tipo, descricao: descricao || null, categoria_id: categoriaId, valor, data_competencia: data };
      let error;
      if (emEdicao) {
        ({ error } = await supabaseClient.from('transacoes').update(campos).eq('id', emEdicao.id));
      } else {
        ({ error } = await supabaseClient.from('transacoes').insert({
          ...campos, client_id: ctx.clienteId, origem: 'lancamento_admin'
        }));
      }
      if (error) throw error;
      showToast(emEdicao ? 'Lançamento atualizado!' : 'Lançamento registrado!');
      fechar();
      await aposAlterar();
    } catch (err) {
      showToast('Erro ao salvar: ' + err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Salvar';
    }
  }

  async function excluir(transacao) {
    const resumo = `${transacao.descricao || '(sem descrição)'} — ${moeda(Math.abs(transacao.valor))} em ${(transacao.data_competencia || '').slice(0, 10).split('-').reverse().join('/')}`;
    if (!confirm(`Excluir este lançamento do cliente?\n\n${resumo}\n\nEsta ação não pode ser desfeita.`)) return;
    const { error } = await supabaseClient.from('transacoes').delete().eq('id', transacao.id);
    if (error) { showToast('Erro ao excluir: ' + error.message, 'error'); return; }
    showToast('Lançamento excluído.');
    fechar();
    await aposAlterar();
  }

  function porId(id) {
    return (contexto().transacoesTodas || []).find(t => t.id === id) || null;
  }

  // ── Aba "📒 Lançamentos" do dashboard ──────────────────────────
  let filtroTexto = '';
  let filtroTipo = '';

  function renderAba() {
    const lista = document.getElementById('lanc-gestao-lista');
    if (!lista) return;
    const ctx = contexto();
    const todas = ctx.transacoes || [];
    const termo = filtroTexto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

    const visiveis = todas.filter(t => {
      if (filtroTipo && t.tipo !== filtroTipo) return false;
      if (!termo) return true;
      const alvo = `${t.descricao || ''} ${t.categorias?.nome || ''}`.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      return alvo.includes(termo);
    });

    const info = document.getElementById('lanc-gestao-info');
    if (info) {
      const tot = (tipo) => visiveis.filter(t => t.tipo === tipo).reduce((s, t) => s + Math.abs(parseFloat(t.valor) || 0), 0);
      info.textContent = `${visiveis.length} de ${todas.length} lançamento(s) · ${ctx.periodoLabel || ''} · entradas ${moeda(tot('receita'))} · saídas ${moeda(tot('despesa'))}`;
    }

    const LIMITE = 300;
    const origemTxt = (o) => o === 'lancamento_admin' ? '👤 consultor' : o === 'importacao' ? '📥 extrato' : '✍️ cliente';
    lista.innerHTML = visiveis.length ? `
      <div class="lanc-gestao__linha lanc-gestao__linha--cab">
        <span>Data</span><span>Descrição</span><span>Categoria</span><span>Origem</span><span>Valor</span><span></span>
      </div>
      ${visiveis.slice(0, LIMITE).map(t => `
        <div class="lanc-gestao__linha" data-id="${t.id}">
          <span>${(t.data_competencia || '').slice(0, 10).split('-').reverse().join('/')}</span>
          <span title="${esc(t.descricao || '')}">${esc(t.descricao || '—')}</span>
          <span>${esc(t.categorias?.nome || 'Sem categoria')}</span>
          <span class="lanc-gestao__origem">${origemTxt(t.origem)}</span>
          <span class="lanc-gestao__valor lanc-gestao__valor--${t.tipo}">${t.tipo === 'receita' ? '+' : '−'} ${moeda(Math.abs(parseFloat(t.valor) || 0))}</span>
          <span class="lanc-gestao__acoes">
            <button type="button" class="lanc-gestao__btn" data-acao="editar" title="Editar">✏️</button>
            <button type="button" class="lanc-gestao__btn" data-acao="excluir" title="Excluir">🗑️</button>
          </span>
        </div>`).join('')}
      ${visiveis.length > LIMITE ? `<p class="empty-state">Mostrando os ${LIMITE} mais recentes — use a busca ou o filtro de período para achar os outros.</p>` : ''}`
      : '<p class="empty-state">Nenhum lançamento neste período.</p>';
  }

  /** Liga os botões ✏️/🗑️ de qualquer container que tenha linhas com data-id. */
  function ligarAcoes(container) {
    if (!container || container._acoesLancLigadas) return;
    container._acoesLancLigadas = true;
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-acao="editar"], [data-acao="excluir"]');
      if (!btn || !container.contains(btn)) return;
      const linha = btn.closest('[data-id]');
      const t = linha && porId(linha.dataset.id);
      if (!t) { showToast('Lançamento não encontrado — recarregue o dashboard.', 'error'); return; }
      if (btn.dataset.acao === 'editar') abrir(t); else excluir(t);
    });
  }

  function init() {
    const busca = document.getElementById('lanc-gestao-busca');
    const tipo  = document.getElementById('lanc-gestao-tipo');
    busca?.addEventListener('input', () => { filtroTexto = busca.value; renderAba(); });
    tipo?.addEventListener('change', () => { filtroTipo = tipo.value; renderAba(); });
    document.getElementById('lanc-gestao-novo')?.addEventListener('click', () => abrir(null));
    ligarAcoes(document.getElementById('lanc-gestao-lista'));
    ligarAcoes(document.getElementById('dash-detalhe'));
  }

  /** Ao abrir outro cliente: limpa busca/filtro e cache de categorias. */
  function reiniciar() {
    filtroTexto = ''; filtroTipo = '';
    categoriasDeQuem = null; categoriasDoCliente = [];
    const busca = document.getElementById('lanc-gestao-busca'); if (busca) busca.value = '';
    const tipo  = document.getElementById('lanc-gestao-tipo');  if (tipo) tipo.value = '';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { abrir, excluir, renderAba, reiniciar };
})();

console.log('✅ lancamentos-gestao.js carregado (admin: criar/editar/excluir lançamentos do cliente)');
