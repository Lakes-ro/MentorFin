/**
 * METAS.JS — Módulo: Metas dos Clientes (admin.html)
 * Padrão: script global. Sem import/export.
 * Depende de: supabaseClient, currentAdmin, allClientes,
 *             loadAllClientes, openModal, closeModal,
 *             showToast, formatCurrency (admin.js)
 *
 * CORREÇÃO DE SCHEMA: a tabela `metas` usa `client_id`/`nome` (não
 * `cliente_id`/`titulo`). Sem ordenação por data (nenhuma coluna de
 * data confirmada existir em `metas`).
 *
 * ATUALIZAÇÃO — FILTROS (cliente + faixa de progresso):
 * A grid de metas não tinha nenhuma forma de filtrar — com muitos
 * clientes/metas, ficava difícil achar rapidamente "quem está com a
 * meta zerada" ou "as metas de um cliente específico". Agora existe:
 *   - `#metas-filter-cliente`: mostra só as metas de um cliente, ou
 *     "Todos".
 *   - `#metas-filter-progresso`: "Todas", "Sem progresso (0%)",
 *     "Baixo progresso (< 25%)", "Em andamento (25% a 99%)",
 *     "Concluídas (100%+)".
 * `metasCache` guarda a última lista carregada do banco — trocar de
 * filtro NÃO refaz a consulta, só reaplica o filtro em memória (mesmo
 * padrão já usado em categorias.js/razonete.js).
 */

let metasCache = [];

function initMetas() {
  document.getElementById('btn-add-meta')
    ?.addEventListener('click', () => abrirModalMeta(null));

  document.getElementById('btn-salvar-meta')
    ?.addEventListener('click', salvarMeta);

  document.getElementById('metas-filter-cliente')
    ?.addEventListener('change', renderMetasFiltradas);

  document.getElementById('metas-filter-progresso')
    ?.addEventListener('change', renderMetasFiltradas);

  window.addEventListener('section:change', ({ detail }) => {
    if (detail.section === 'metas') renderMetas();
  });

  renderMetas();
}

function popularFiltroClientesMetas() {
  const select = document.getElementById('metas-filter-cliente');
  if (!select) return;
  const valorAtual = select.value;

  select.innerHTML = '<option value="">Todos os clientes</option>' +
    allClientes.map(c =>
      `<option value="${c.id}" ${valorAtual === c.id ? 'selected' : ''}>${escaparHtml(c.nome)}</option>`
    ).join('');
}

function calcularProgressoMeta(meta) {
  return meta.valor_necessario > 0
    ? (meta.valor_economizado / meta.valor_necessario) * 100
    : 0;
}

// ── Carrega do banco ──────────────────────────────────────────
async function renderMetas() {
  const grid = document.getElementById('metas-grid');
  if (!grid) return;
  grid.innerHTML = '<p class="empty-state">Carregando...</p>';

  if (!allClientes.length) await loadAllClientes();
  popularFiltroClientesMetas();

  const clienteIds = allClientes.map(c => c.id);
  if (!clienteIds.length) {
    grid.innerHTML = '<p class="empty-state">Nenhum cliente cadastrado ainda.</p>';
    return;
  }

  const { data, error } = await supabaseClient
    .from('metas')
    .select('id, nome, valor_necessario, valor_economizado, client_id')
    .in('client_id', clienteIds);

  if (error) { showToast('Erro ao carregar metas: ' + error.message, 'error'); return; }

  metasCache = data || [];
  renderMetasFiltradas();
}

// ── Reaplica os filtros em memória (sem refetch) ────────────────
function renderMetasFiltradas() {
  const grid = document.getElementById('metas-grid');
  if (!grid) return;

  if (!metasCache.length) {
    grid.innerHTML = '<p class="empty-state">Nenhuma meta cadastrada.</p>';
    return;
  }

  const filtroCliente    = document.getElementById('metas-filter-cliente')?.value || '';
  const filtroProgresso  = document.getElementById('metas-filter-progresso')?.value || '';

  let lista = metasCache;

  if (filtroCliente) {
    lista = lista.filter(m => m.client_id === filtroCliente);
  }

  if (filtroProgresso) {
    lista = lista.filter(m => {
      const pct = calcularProgressoMeta(m);
      switch (filtroProgresso) {
        case 'zero':        return pct <= 0;
        case 'baixo':       return pct > 0 && pct < 25;
        case 'andamento':   return pct >= 25 && pct < 100;
        case 'concluida':   return pct >= 100;
        default:            return true;
      }
    });
  }

  if (!lista.length) {
    grid.innerHTML = '<p class="empty-state">Nenhuma meta encontrada para o filtro selecionado.</p>';
    return;
  }

  grid.innerHTML = lista.map(meta => {
    const cliente = allClientes.find(c => c.id === meta.client_id);
    const pct     = Math.min(100, calcularProgressoMeta(meta));
    const barColor = pct >= 100 ? '#00f5a0' : pct >= 25 ? '#f5d623' : '#ff4d6d';

    return `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <p class="card-name">${escaparHtml(meta.nome)}</p>
          <span class="meta-cliente-badge dado-sensivel">${escaparHtml(cliente?.nome) || '—'}</span>
        </div>
        <div class="meta-stats">
          <div>
            <span class="meta-stat-label">Economizado</span>
            <span class="meta-stat-value">${formatCurrency(meta.valor_economizado)}</span>
          </div>
          <div>
            <span class="meta-stat-label">Necessário</span>
            <span class="meta-stat-value">${formatCurrency(meta.valor_necessario)}</span>
          </div>
          <div>
            <span class="meta-stat-label">Progresso</span>
            <span class="meta-stat-value">${calcularProgressoMeta(meta).toFixed(1)}%</span>
          </div>
        </div>
        <div class="meta-progress-bar">
          <div class="meta-progress-fill" style="width:${pct}%;background:${barColor}"></div>
        </div>
        <div class="card-actions">
          <button class="btn-card editar"  data-id="${meta.id}">✏️ Editar</button>
          <button class="btn-card deletar" data-id="${meta.id}" data-nome="${escaparHtml(meta.nome)}">🗑️ Deletar</button>
        </div>
      </div>
    `;
  }).join('');

  if (typeof aplicarPrivacidadeNaGrade === 'function') aplicarPrivacidadeNaGrade(grid);

  grid.querySelectorAll('.btn-card.editar').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { data: m } = await supabaseClient.from('metas').select('*').eq('id', btn.dataset.id).single();
      if (m) abrirModalMeta(m);
    });
  });

  grid.querySelectorAll('.btn-card.deletar').forEach(btn => {
    btn.addEventListener('click', () => deletarMeta(btn.dataset.id, btn.dataset.nome));
  });
}

// ── Modal meta ────────────────────────────────────────────────
async function abrirModalMeta(meta) {
  if (!allClientes.length) await loadAllClientes();

  document.getElementById('modal-meta-title').textContent =
    meta ? '✏️ Editar Meta' : '🎯 Adicionar Meta';

  document.getElementById('meta-id').value          = meta?.id                || '';
  document.getElementById('meta-titulo').value      = meta?.nome              || '';
  document.getElementById('meta-valor').value       = meta?.valor_necessario  || '';
  document.getElementById('meta-economizado').value = meta?.valor_economizado || '';

  const select = document.getElementById('meta-cliente-select');
  select.innerHTML = allClientes.map(c =>
    `<option value="${c.id}" ${meta?.client_id === c.id ? 'selected' : ''}>${escaparHtml(c.nome)}</option>`
  ).join('');

  openModal('modal-meta');
}

async function salvarMeta() {
  const id          = document.getElementById('meta-id').value;
  const nome        = document.getElementById('meta-titulo').value.trim();
  const valor       = parseFloat(document.getElementById('meta-valor').value)       || 0;
  const economizado = parseFloat(document.getElementById('meta-economizado').value) || 0;
  const clienteId   = document.getElementById('meta-cliente-select').value;

  if (!nome)      { showToast('Informe o título da meta.', 'error'); return; }
  if (!clienteId) { showToast('Selecione um cliente.', 'error');    return; }

  const payload = {
    nome,
    valor_necessario:  valor,
    valor_economizado: economizado,
    client_id:         clienteId,
  };

  let error;
  if (id) {
    ({ error } = await supabaseClient.from('metas').update(payload).eq('id', id));
  } else {
    ({ error } = await supabaseClient.from('metas').insert(payload));
  }

  if (error) { showToast('Erro: ' + error.message, 'error'); return; }

  showToast(id ? 'Meta atualizada!' : 'Meta criada!');
  closeModal('modal-meta');
  renderMetas();
}

async function deletarMeta(id, nome) {
  if (!confirm(`Deletar a meta "${nome}"?`)) return;
  const { error } = await supabaseClient.from('metas').delete().eq('id', id);
  if (error) { showToast('Erro: ' + error.message, 'error'); return; }
  showToast('Meta removida.');
  renderMetas();
}

console.log('✅ metas.js carregado');
