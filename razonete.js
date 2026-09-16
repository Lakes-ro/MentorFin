/**
 * RAZONETE.JS — Módulo: Razonete Consolidado (admin.html)
 * Padrão: script global. Sem import/export.
 * Depende de: supabaseClient, allClientes, loadAllClientes,
 *             showToast, formatCurrency, formatDate (admin.js)
 *
 * ═══════════════════════════════════════════════════════════════
 * CORREÇÃO — OS PILLS DE PERÍODO NÃO FUNCIONAVAM:
 * ═══════════════════════════════════════════════════════════════
 * Os botões "Hoje / Ontem / 7 dias / Este mês / Mês passado / Tudo"
 * já existiam em admin.html (`.razonete-periodo-pill`), mas este
 * arquivo nunca registrava NENHUM listener de clique neles — a lista
 * sempre mostrava tudo, independente do pill "ativo" visualmente.
 * Agora cada clique: (1) marca o pill como `.active`, (2) calcula o
 * intervalo de datas correspondente, (3) re-renderiza a lista.
 *
 * NOVO — PERÍODO "PERSONALIZADO": adicionado um pill extra
 * "Personalizado" que revela dois campos de data (`#razonete-data-
 * inicio`/`#razonete-data-fim`, ver admin.html) para o admin escolher
 * livremente o intervalo, sem ficar preso às opções fixas.
 */

let razonetePeriodoAtual = 'tudo';

function initRazonete() {
  document.getElementById('razonete-filter-cliente')
    ?.addEventListener('change', renderRazonete);
  document.getElementById('razonete-filter-tipo')
    ?.addEventListener('change', renderRazonete);

  document.querySelectorAll('.razonete-periodo-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.razonete-periodo-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');

      razonetePeriodoAtual = pill.dataset.periodo;

      const linhaPersonalizada = document.getElementById('razonete-periodo-personalizado-row');
      linhaPersonalizada?.classList.toggle('hidden', razonetePeriodoAtual !== 'personalizado');

      // Se acabou de abrir "Personalizado" e ainda não há datas
      // escolhidas, não refiltra ainda (evita mostrar 0 resultados por
      // um instante) — só aplica quando o admin escolher uma data.
      if (razonetePeriodoAtual === 'personalizado') {
        const temDatas = document.getElementById('razonete-data-inicio')?.value ||
                          document.getElementById('razonete-data-fim')?.value;
        if (!temDatas) return;
      }

      renderRazonete();
    });
  });

  document.getElementById('razonete-data-inicio')?.addEventListener('change', () => {
    if (razonetePeriodoAtual === 'personalizado') renderRazonete();
  });
  document.getElementById('razonete-data-fim')?.addEventListener('change', () => {
    if (razonetePeriodoAtual === 'personalizado') renderRazonete();
  });

  window.addEventListener('section:change', ({ detail }) => {
    if (detail.section === 'razonete') {
      popularFiltroClientes();
      renderRazonete();
    }
  });
}

async function popularFiltroClientes() {
  if (!allClientes.length) await loadAllClientes();

  const select = document.getElementById('razonete-filter-cliente');
  if (!select) return;
  const valorAtual = select.value;

  select.innerHTML = '<option value="">Todos</option>' +
    allClientes.map(c =>
      `<option value="${c.id}" ${valorAtual === c.id ? 'selected' : ''}>${escaparHtml(c.nome)}</option>`
    ).join('');
}

// ── Cálculo de intervalo de datas por período ───────────────────
function formatarDataLocalAdmin(d) {
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

function calcularIntervaloPeriodo(periodo) {
  const hoje    = new Date();
  const hojeStr = formatarDataLocalAdmin(hoje);

  switch (periodo) {
    case 'hoje':
      return { inicio: hojeStr, fim: hojeStr };

    case 'ontem': {
      const ontem = new Date(hoje);
      ontem.setDate(ontem.getDate() - 1);
      const s = formatarDataLocalAdmin(ontem);
      return { inicio: s, fim: s };
    }

    case '7dias': {
      const seteDiasAtras = new Date(hoje);
      seteDiasAtras.setDate(seteDiasAtras.getDate() - 6); // inclui hoje = 7 dias no total
      return { inicio: formatarDataLocalAdmin(seteDiasAtras), fim: hojeStr };
    }

    case 'mes': {
      const primeiroDia = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
      return { inicio: formatarDataLocalAdmin(primeiroDia), fim: hojeStr };
    }

    case 'mes_passado': {
      const primeiroDiaMesPassado = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
      const ultimoDiaMesPassado   = new Date(hoje.getFullYear(), hoje.getMonth(), 0);
      return {
        inicio: formatarDataLocalAdmin(primeiroDiaMesPassado),
        fim:    formatarDataLocalAdmin(ultimoDiaMesPassado)
      };
    }

    case 'personalizado': {
      const inicio = document.getElementById('razonete-data-inicio')?.value || null;
      const fim    = document.getElementById('razonete-data-fim')?.value    || null;
      return { inicio, fim };
    }

    case 'tudo':
    default:
      return { inicio: null, fim: null };
  }
}

async function renderRazonete() {
  const lista         = document.getElementById('razonete-list');
  if (!lista) return;
  const filtroCliente = document.getElementById('razonete-filter-cliente')?.value || '';
  const filtroTipo    = document.getElementById('razonete-filter-tipo')?.value    || '';

  lista.innerHTML = '<p class="empty-state">Carregando...</p>';

  if (!allClientes.length) await loadAllClientes();

  const clienteIds = filtroCliente ? [filtroCliente] : allClientes.map(c => c.id);

  if (!clienteIds.length) {
    lista.innerHTML = '<p class="empty-state">Nenhum cliente cadastrado.</p>';
    return;
  }

  const { inicio, fim } = calcularIntervaloPeriodo(razonetePeriodoAtual);

  let query = supabaseClient
    .from('transacoes')
    .select('id, valor, tipo, descricao, data_competencia, client_id, categorias(nome, grupo)')
    .in('client_id', clienteIds)
    .order('data_competencia', { ascending: false })
    .limit(200);

  if (filtroTipo) query = query.eq('tipo', filtroTipo);
  if (inicio)      query = query.gte('data_competencia', inicio);
  if (fim)          query = query.lte('data_competencia', fim);

  const { data, error } = await query;

  if (error) { showToast('Erro ao carregar razonete: ' + error.message, 'error'); return; }

  if (!data?.length) {
    lista.innerHTML = '<p class="empty-state">Nenhuma transação encontrada para o período/filtro selecionado.</p>';
    return;
  }

  lista.innerHTML = data.map(t => {
    const cliente        = allClientes.find(c => c.id === t.client_id);
    const isReceita       = t.tipo === 'receita';
    const valor           = Math.abs(t.valor);
    const categoriaLabel  = t.categorias?.nome || t.descricao || '—';

    return `
      <div class="razonete-item ${t.tipo}">
        <div class="razonete-item-info">
          <span class="razonete-cliente-nome ${isReceita ? '' : 'despesa'}">${cliente?.nome || '—'}</span>
          <span class="razonete-descricao">${categoriaLabel}</span>
          <span class="razonete-data">${formatDate(t.data_competencia)}</span>
        </div>
        <span class="razonete-valor ${isReceita ? 'positivo' : 'negativo'}">
          ${isReceita ? '+' : '-'}${formatCurrency(valor)}
        </span>
      </div>
    `;
  }).join('');
}

console.log('✅ razonete.js carregado');
