/**
 * PLANEJAMENTOS.JS — Módulo: Planejamentos (admin.html)
 * Padrão: script global. Sem import/export.
 * Depende de: supabaseClient, currentAdmin, allClientes,
 *             loadAllClientes, openModal, closeModal,
 *             showToast, formatCurrency, formatDate (admin.js)
 *
 * ═══════════════════════════════════════════════════════════════
 * CORREÇÃO CRÍTICA — `planejamentos.admin_id` NÃO EXISTE:
 * ═══════════════════════════════════════════════════════════════
 * A versão anterior filtrava/gravava `planejamentos` usando uma
 * coluna `admin_id` — confirmado ao vivo via Supabase MCP
 * (information_schema): essa coluna NUNCA existiu na tabela. A tabela
 * só tem `client_id`. Isso causava o erro 400 "column
 * planejamentos.admin_id does not exist" reportado no console, que
 * travava a aba inteira em "Carregando..." para sempre.
 *
 * A RLS de `planejamentos` (`planejamentos_admin_all`) também nunca
 * checou uma coluna admin_id — ela sempre validou via JOIN:
 *   EXISTS (SELECT 1 FROM clientes c WHERE c.id = planejamentos.client_id
 *           AND c.admin_id = auth.uid())
 * ou seja, o "dono" de um planejamento é definido por QUEM É O DONO DO
 * CLIENTE (clientes.admin_id), nunca por uma coluna direta em
 * planejamentos. A correção segue exatamente esse mesmo modelo usado
 * por metas.js: carrega os clientes do admin primeiro, e filtra
 * planejamentos por `client_id IN (clientIds)` — nunca por admin_id.
 *
 * ═══════════════════════════════════════════════════════════════
 * NOVO — RESOLVER "SOLICITAÇÕES PENDENTES":
 * ═══════════════════════════════════════════════════════════════
 * O bloco "📩 Solicitações Pendentes" já existia no HTML (admin.html)
 * mas nunca foi de fato implementado neste arquivo — ficava preso em
 * "Carregando..." também. Agora:
 *   - renderSolicitacoesPendentes() busca em `solicitacoes_planejamento`
 *     (status = 'pendente') e mostra um card por cliente com a
 *     mensagem que ele mandou (se houver).
 *   - "📋 Criar Planejamento" abre o modal já com aquele cliente
 *     pré-selecionado, e guarda o id da solicitação; ao salvar o
 *     planejamento com sucesso, a solicitação é marcada como
 *     'atendida' automaticamente.
 *   - "✕ Descartar" marca a solicitação como 'atendida' sem criar
 *     nenhum planejamento (ex: pedido duplicado, ou já resolvido por
 *     fora).
 */

let planejamentoSolicitacaoIdAtual = null; // solicitação sendo resolvida pelo modal aberto no momento (ou null)

function initPlanejamentos() {
  document.getElementById('btn-add-planejamento')
    ?.addEventListener('click', () => abrirModalPlanejamento(null));

  document.getElementById('btn-salvar-planejamento')
    ?.addEventListener('click', salvarPlanejamento);

  document.getElementById('planejamento-cliente-select')
    ?.addEventListener('change', (e) => carregarResumoFinanceiro(e.target.value));

  window.addEventListener('section:change', ({ detail }) => {
    if (detail.section === 'planejamentos') {
      renderSolicitacoesPendentes();
      renderPlanejamentos();
    }
  });

  renderSolicitacoesPendentes();
  renderPlanejamentos();
}

// ── Solicitações Pendentes ──────────────────────────────────────
async function renderSolicitacoesPendentes() {
  const grid = document.getElementById('solicitacoes-planejamento-grid');
  if (!grid) return;
  grid.innerHTML = '<p class="empty-state">Carregando...</p>';

  if (!allClientes.length) await loadAllClientes();

  const { data, error } = await supabaseClient
    .from('solicitacoes_planejamento')
    .select('id, client_id, mensagem, status, created_at')
    .eq('status', 'pendente')
    .order('created_at', { ascending: false });

  if (error) {
    grid.innerHTML = `<p class="empty-state">Erro ao carregar: ${error.message}</p>`;
    console.error('❌ renderSolicitacoesPendentes:', error.message);
    return;
  }

  if (!data?.length) {
    grid.innerHTML = '<p class="empty-state">Nenhuma solicitação pendente. 🎉</p>';
    return;
  }

  grid.innerHTML = data.map(s => {
    const cliente = allClientes.find(c => c.id === s.client_id);
    return `
      <div class="card card--pendente">
        <div class="card-header-row">
          <div>
            <p class="card-name dado-sensivel">${escaparHtml(cliente?.nome) || 'Cliente desconhecido'}</p>
            <p class="card-sub">Solicitado em ${formatDate(s.created_at)}</p>
            ${s.mensagem ? `<p class="card-sub" style="margin-top:6px; font-style:italic;">"${escaparHtml(s.mensagem)}"</p>` : ''}
          </div>
        </div>
        <div class="card-actions">
          <button class="btn-card confirmar btn-atender-solicitacao" data-id="${s.id}" data-client-id="${s.client_id}">📋 Criar Planejamento</button>
          <button class="btn-card deletar btn-descartar-solicitacao" data-id="${s.id}">✕ Descartar</button>
        </div>
      </div>
    `;
  }).join('');

  if (typeof aplicarPrivacidadeNaGrade === 'function') aplicarPrivacidadeNaGrade(grid);

  grid.querySelectorAll('.btn-atender-solicitacao').forEach(btn => {
    btn.addEventListener('click', () => {
      abrirModalPlanejamento(null, {
        clientIdPreSelecionado: btn.dataset.clientId,
        solicitacaoId: btn.dataset.id
      });
    });
  });

  grid.querySelectorAll('.btn-descartar-solicitacao').forEach(btn => {
    btn.addEventListener('click', () => descartarSolicitacao(btn.dataset.id));
  });
}

async function descartarSolicitacao(id) {
  if (!confirm('Descartar esta solicitação sem criar um planejamento?')) return;

  const { error } = await supabaseClient
    .from('solicitacoes_planejamento')
    .update({ status: 'atendida' })
    .eq('id', id);

  if (error) { showToast('Erro: ' + error.message, 'error'); return; }

  showToast('Solicitação descartada.');
  renderSolicitacoesPendentes();
}

// ── Renderiza lista de planejamentos ────────────────────────────
async function renderPlanejamentos() {
  const lista = document.getElementById('planejamentos-list');
  if (!lista) return;
  lista.innerHTML = '<p class="empty-state">Carregando...</p>';

  if (!allClientes.length) await loadAllClientes();

  const clienteIds = allClientes.map(c => c.id);
  if (!clienteIds.length) {
    lista.innerHTML = '<p class="empty-state">Nenhum cliente cadastrado ainda.</p>';
    return;
  }

  // client_id IN (clientIds) — NUNCA filtrar por admin_id (não existe
  // nesta tabela, ver nota no cabeçalho do arquivo).
  const { data, error } = await supabaseClient
    .from('planejamentos')
    .select('id, titulo, recomendacoes, detalhes, client_id, created_at')
    .in('client_id', clienteIds)
    .order('created_at', { ascending: false });

  if (error) { showToast('Erro ao carregar: ' + error.message, 'error'); return; }

  if (!data?.length) {
    lista.innerHTML = '<p class="empty-state">Nenhum planejamento criado.</p>';
    return;
  }

  lista.innerHTML = data.map(p => {
    const cliente = allClientes.find(c => c.id === p.client_id);
    return `
      <div class="planejamento-card">
        <div class="planejamento-info">
          <h4>${p.titulo}</h4>
          <p>Cliente: ${cliente?.nome || '—'} · Criado em ${formatDate(p.created_at)}</p>
        </div>
        <div class="planejamento-actions">
          <button class="btn-card editar"  data-id="${p.id}">✏️ Editar</button>
          <button class="btn-card deletar" data-id="${p.id}" data-titulo="${p.titulo}">🗑️ Deletar</button>
        </div>
      </div>
    `;
  }).join('');

  lista.querySelectorAll('.btn-card.editar').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { data: p, error: err } = await supabaseClient.from('planejamentos').select('*').eq('id', btn.dataset.id).single();
      if (err) { showToast('Erro ao carregar: ' + err.message, 'error'); return; }
      if (p) abrirModalPlanejamento(p);
    });
  });

  lista.querySelectorAll('.btn-card.deletar').forEach(btn => {
    btn.addEventListener('click', () => deletarPlanejamento(btn.dataset.id, btn.dataset.titulo));
  });
}

// ── Modal planejamento ────────────────────────────────────────
/**
 * @param {Object|null} plan - planejamento existente (edição) ou null (novo)
 * @param {Object} [opts]
 * @param {string} [opts.clientIdPreSelecionado] - cliente já escolhido (vindo de uma solicitação)
 * @param {string} [opts.solicitacaoId] - id da solicitação sendo resolvida por este planejamento
 */
async function abrirModalPlanejamento(plan, opts = {}) {
  if (!allClientes.length) await loadAllClientes();

  planejamentoSolicitacaoIdAtual = opts.solicitacaoId || null;

  document.getElementById('modal-planejamento-title').textContent =
    plan ? '✏️ Editar Planejamento' : '📋 Criar Planejamento';

  document.getElementById('planejamento-id').value            = plan?.id            || '';
  document.getElementById('planejamento-titulo').value        = plan?.titulo        || 'Planejamento mensal';
  document.getElementById('planejamento-recomendacoes').value = plan?.recomendacoes || '';
  document.getElementById('planejamento-detalhes').value      = plan?.detalhes      || '';

  const select = document.getElementById('planejamento-cliente-select');
  const clienteAlvo = plan?.client_id || opts.clientIdPreSelecionado;
  select.innerHTML = allClientes.map(c =>
    `<option value="${c.id}" ${clienteAlvo === c.id ? 'selected' : ''}>${escaparHtml(c.nome)}</option>`
  ).join('');

  resetResumo();
  const clienteId = clienteAlvo || allClientes[0]?.id;
  if (clienteId) carregarResumoFinanceiro(clienteId);

  openModal('modal-planejamento');
}

// ── Resumo financeiro do cliente ──────────────────────────────
async function carregarResumoFinanceiro(clienteId) {
  if (!clienteId) { resetResumo(); return; }

  const { data: transacoes, error } = await supabaseClient
    .from('transacoes')
    .select('valor, tipo')
    .eq('client_id', clienteId);

  if (error) {
    console.error('❌ carregarResumoFinanceiro:', error.message);
    resetResumo();
    return;
  }

  if (!transacoes?.length) { resetResumo(); return; }

  const receitas = transacoes.filter(t => t.tipo === 'receita');
  const despesas = transacoes.filter(t => t.tipo === 'despesa');

  const totalReceita = receitas.reduce((s, t) => s + Math.abs(t.valor), 0);
  const totalDespesa = despesas.reduce((s, t) => s + Math.abs(t.valor), 0);
  const rendaPassiva = 0;
  const rendaAtiva   = totalReceita;

  document.getElementById('plan-renda-ativa').textContent   = formatCurrency(rendaAtiva);
  document.getElementById('plan-renda-passiva').textContent = formatCurrency(rendaPassiva);
  document.getElementById('plan-renda-total').textContent   = formatCurrency(totalReceita);
  document.getElementById('plan-despesa-total').textContent = formatCurrency(totalDespesa);
}

function resetResumo() {
  ['plan-renda-ativa','plan-renda-passiva','plan-renda-total','plan-despesa-total'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = formatCurrency(0);
  });
}

// ── Salva planejamento ────────────────────────────────────────
async function salvarPlanejamento() {
  const id            = document.getElementById('planejamento-id').value;
  const titulo        = document.getElementById('planejamento-titulo').value.trim();
  const recomendacoes = document.getElementById('planejamento-recomendacoes').value.trim();
  const detalhes      = document.getElementById('planejamento-detalhes').value.trim();
  const clienteId     = document.getElementById('planejamento-cliente-select').value;

  if (!titulo)    { showToast('Informe o título.', 'error');     return; }
  if (!clienteId) { showToast('Selecione um cliente.', 'error'); return; }

  // client_id apenas — NUNCA admin_id (coluna não existe nesta
  // tabela, ver nota no cabeçalho do arquivo).
  const payload = {
    titulo,
    recomendacoes: recomendacoes || null,
    detalhes:      detalhes      || null,
    client_id:     clienteId,
  };

  const btn = document.getElementById('btn-salvar-planejamento');
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }

  let error;
  if (id) {
    ({ error } = await supabaseClient.from('planejamentos').update(payload).eq('id', id));
  } else {
    ({ error } = await supabaseClient.from('planejamentos').insert(payload));
  }

  if (error) {
    showToast('Erro: ' + error.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Salvar'; }
    return;
  }

  // Se este planejamento resolveu uma solicitação pendente do
  // cliente, marca a solicitação como atendida — evita o admin ter
  // que lembrar de ir descartar manualmente depois de já ter criado
  // o planejamento correspondente.
  if (planejamentoSolicitacaoIdAtual) {
    await supabaseClient
      .from('solicitacoes_planejamento')
      .update({ status: 'atendida' })
      .eq('id', planejamentoSolicitacaoIdAtual);
    planejamentoSolicitacaoIdAtual = null;
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Salvar'; }

  showToast(id ? 'Planejamento atualizado!' : 'Planejamento criado!');
  closeModal('modal-planejamento');
  renderPlanejamentos();
  renderSolicitacoesPendentes();
}

async function deletarPlanejamento(id, titulo) {
  if (!confirm(`Deletar o planejamento "${titulo}"?`)) return;
  const { error } = await supabaseClient.from('planejamentos').delete().eq('id', id);
  if (error) { showToast('Erro: ' + error.message, 'error'); return; }
  showToast('Planejamento removido.');
  renderPlanejamentos();
}

console.log('✅ planejamentos.js carregado');
