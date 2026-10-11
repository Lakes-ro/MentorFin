/**
 * PLANEJAMENTOS.JS — Módulo: Planejamentos (admin.html)
 * Padrão: script global. Sem import/export.
 * Depende de: supabaseClient, currentAdmin, allClientes,
 *             loadAllClientes, openModal, closeModal,
 *             showToast, formatCurrency, formatDate (admin.js),
 *             gerarInsightsDashboard (dashboards.js — carregado ANTES).
 *
 * ═══════════════════════════════════════════════════════════════
 * CORREÇÃO CRÍTICA — `planejamentos.admin_id` NÃO EXISTE:
 * ═══════════════════════════════════════════════════════════════
 * A tabela só tem `client_id`. O "dono" de um planejamento é definido
 * por QUEM É O DONO DO CLIENTE (clientes.admin_id). Carrega os
 * clientes do admin primeiro e filtra planejamentos por
 * `client_id IN (clientIds)` — nunca por admin_id.
 *
 * ═══════════════════════════════════════════════════════════════
 * SOLICITAÇÕES PENDENTES:
 * ═══════════════════════════════════════════════════════════════
 *   - renderSolicitacoesPendentes() busca em `solicitacoes_planejamento`
 *     (status = 'pendente') e mostra um card por cliente.
 *   - "📋 Criar Planejamento" abre o modal com o cliente
 *     pré-selecionado; ao salvar, a solicitação vira 'atendida'.
 *   - "✕ Descartar" marca como 'atendida' sem criar planejamento.
 *
 * ═══════════════════════════════════════════════════════════════
 * ATUALIZAÇÃO — DICAS DE VOLTA NO MODAL DE PLANEJAMENTO:
 * ═══════════════════════════════════════════════════════════════
 * O resumo do modal agora usa as MESMAS regras do dashboard do admin
 * (transferências fora, essencial/estilo de vida/investimento/dívida
 * separados) e mostra as mesmas "💡 Observações e Dicas" de
 * gerarInsightsDashboard(). O botão "Usar nas recomendações" copia
 * essas dicas para o campo de texto, como ponto de partida.
 * Período: últimos 3 meses (mais representativo que o histórico todo).
 */

let planejamentoSolicitacaoIdAtual = null; // solicitação sendo resolvida pelo modal aberto no momento (ou null)
let planejamentoDicasAtuais        = null; // { resumo, itens } do cliente selecionado no modal

const PLANEJAMENTO_MESES_ANALISE = 3;

function initPlanejamentos() {
  document.getElementById('btn-add-planejamento')
    ?.addEventListener('click', () => abrirModalPlanejamento(null));

  document.getElementById('btn-salvar-planejamento')
    ?.addEventListener('click', salvarPlanejamento);

  document.getElementById('planejamento-cliente-select')
    ?.addEventListener('change', (e) => carregarResumoFinanceiro(e.target.value));

  document.getElementById('btn-usar-dicas-planejamento')
    ?.addEventListener('click', usarDicasNasRecomendacoes);

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
          <h4>${escaparHtml(p.titulo)}</h4>
          <p>Cliente: <span class="dado-sensivel">${escaparHtml(cliente?.nome) || '—'}</span> · Criado em ${formatDate(p.created_at)}</p>
        </div>
        <div class="planejamento-actions">
          <button class="btn-card editar"  data-id="${p.id}">✏️ Editar</button>
          <button class="btn-card deletar" data-id="${p.id}" data-titulo="${escaparHtml(p.titulo)}">🗑️ Deletar</button>
        </div>
      </div>
    `;
  }).join('');

  if (typeof aplicarPrivacidadeNaGrade === 'function') aplicarPrivacidadeNaGrade(lista);

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

// ── Resumo financeiro + dicas do cliente ──────────────────────
function inicioJanelaAnalise(clienteId) {
  const hoje = new Date();

  // Cliente com ciclo próprio (ex.: dia 27): a janela começa no início do
  // ciclo de N-1 períodos atrás, em vez do dia 1 do mês.
  const cliente = allClientes.find(c => c.id === clienteId);
  if (cliente && typeof CicloModule !== 'undefined') {
    const cfg = CicloModule.deLinha(cliente);
    if (!CicloModule.ehMesCalendario(cfg)) {
      return CicloModule.cicloPorOffset(cfg, hoje, -(PLANEJAMENTO_MESES_ANALISE - 1)).inicio;
    }
  }

  const d = new Date(hoje.getFullYear(), hoje.getMonth() - (PLANEJAMENTO_MESES_ANALISE - 1), 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

async function carregarResumoFinanceiro(clienteId) {
  if (!clienteId) { resetResumo(); return; }

  renderDicasPlanejamento(null, 'Carregando análise...');

  const { data: transacoes, error } = await supabaseClient
    .from('transacoes')
    .select('valor, tipo, data_competencia, categorias(grupo)')
    .eq('client_id', clienteId)
    .gte('data_competencia', inicioJanelaAnalise(clienteId));

  if (error) {
    console.error('❌ carregarResumoFinanceiro:', error.message);
    resetResumo();
    renderDicasPlanejamento(null, 'Não foi possível carregar a análise deste cliente.');
    return;
  }

  // Mesmas regras de dashboards.js: transferência não é receita nem despesa.
  const validas  = (transacoes || []).filter(t => t.categorias?.grupo !== 'transferencia');
  const receitas = validas.filter(t => t.tipo === 'receita');
  const despesas = validas.filter(t => t.tipo === 'despesa');
  const soma     = (lista) => lista.reduce((s, t) => s + Math.abs(parseFloat(t.valor) || 0), 0);
  const porGrupo = (g) => soma(despesas.filter(t => t.categorias?.grupo === g));

  const totalReceita        = soma(receitas);
  const totalDespesa        = soma(despesas);
  const custoSobrevivencia  = porGrupo('essencial');
  const aportesInvestimento = porGrupo('investimento');
  const custoDivida         = porGrupo('divida');
  const estiloDeVida        = Math.max(0, totalDespesa - custoSobrevivencia - aportesInvestimento - custoDivida);
  const saldo               = totalReceita - totalDespesa;

  document.getElementById('plan-renda-ativa').textContent   = formatCurrency(totalReceita);
  document.getElementById('plan-renda-passiva').textContent = formatCurrency(0);
  document.getElementById('plan-renda-total').textContent   = formatCurrency(totalReceita);
  document.getElementById('plan-despesa-total').textContent = formatCurrency(totalDespesa);

  if (typeof gerarInsightsDashboard !== 'function') {
    renderDicasPlanejamento(null, 'Módulo de dicas não carregou — recarregue a página.');
    return;
  }

  planejamentoDicasAtuais = gerarInsightsDashboard({
    totalReceita, totalDespesa, custoSobrevivencia, estiloDeVida,
    aportesInvestimento, custoDivida, saldo,
    taxaPoupanca: totalReceita > 0 ? (saldo / totalReceita) * 100 : 0,
    totalTransacoes: validas.length
  });

  renderDicasPlanejamento(planejamentoDicasAtuais);
}

function renderDicasPlanejamento(dicas, mensagem = '') {
  const resumoEl = document.getElementById('planejamento-dicas-resumo');
  const listaEl  = document.getElementById('planejamento-dicas-lista');
  const botao    = document.getElementById('btn-usar-dicas-planejamento');
  if (!resumoEl || !listaEl) return;

  if (!dicas) {
    resumoEl.textContent = '';
    listaEl.innerHTML    = mensagem ? `<p class="empty-state">${mensagem}</p>` : '';
    botao?.classList.add('hidden');
    return;
  }

  const ICONE = { alerta: '🔴', atencao: '🟡', positivo: '🟢', info: 'ℹ️' };
  resumoEl.textContent = `Últimos ${PLANEJAMENTO_MESES_ANALISE} meses: ${dicas.resumo}`;
  listaEl.innerHTML = dicas.itens.length
    ? dicas.itens.map(item => `
        <div class="insight-item insight-item--${item.tipo}">
          <span class="insight-item__icone">${ICONE[item.tipo] || 'ℹ️'}</span>
          <span class="insight-item__texto">${item.texto}</span>
        </div>
      `).join('')
    : '<p class="empty-state">Sem observações específicas para este período.</p>';

  botao?.classList.toggle('hidden', !dicas.itens.length);
}

/**
 * Copia as dicas para o campo "Recomendações", trocando "o cliente"
 * por uma forma direta ("você"), já que o planejamento é lido pelo
 * próprio cliente. Não apaga o que o admin já escreveu.
 */
function usarDicasNasRecomendacoes() {
  if (!planejamentoDicasAtuais?.itens?.length) return;
  const campo = document.getElementById('planejamento-recomendacoes');
  if (!campo) return;

  const paraCliente = (texto) => texto
    .replace(/\bO cliente está\b/g, 'Você está')
    .replace(/\bo cliente está\b/g, 'você está')
    .replace(/\bO cliente\b/g, 'Você')
    .replace(/\bo cliente\b/g, 'você')
    .replace(/\bcom o cliente\b/g, 'entre nós');

  const linhas = planejamentoDicasAtuais.itens.map(i => `• ${paraCliente(i.texto)}`).join('\n');
  campo.value = campo.value.trim() ? `${campo.value.trim()}\n\n${linhas}` : linhas;
  campo.focus();
  showToast('Dicas adicionadas às recomendações — ajuste o texto como preferir.');
}

function resetResumo() {
  ['plan-renda-ativa','plan-renda-passiva','plan-renda-total','plan-despesa-total'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = formatCurrency(0);
  });
  planejamentoDicasAtuais = null;
  renderDicasPlanejamento(null);
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
  // cliente, marca a solicitação como atendida.
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

console.log('✅ planejamentos.js carregado (com dicas no modal)');
