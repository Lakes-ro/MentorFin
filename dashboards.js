/**
 * DASHBOARDS.JS — Módulo: Dashboards dos Clientes (admin.html)
 * Padrão: script global. Sem import/export.
 * Depende de: supabaseClient, allClientes, loadAllClientes,
 *             openModal, closeModal, showToast, formatCurrency,
 *             ligarBuscaClientes/aplicarBuscaClientes/textoBuscaCliente
 *             (admin.js), calcularDRE/renderDRE/calcularBalancete/
 *             renderBalancete/exportarParaPDF/abrirBalanceteAmpliado
 *             (contabilidade.js — carregado ANTES deste ficheiro).
 *
 * ATUALIZAÇÃO — ABAS DRE / BALANCETE NO MODAL "VER DASHBOARD":
 * O modal de dashboard de cada cliente (aberto pelo botão "📊 Ver
 * Dashboard" na grade de clientes) agora tem 3 abas: Resumo (o que já
 * existia: KPIs + gráficos + análise detalhada, tudo INTACTO), DRE
 * (Demonstração do Resultado) e Balancete (Balancete de Verificação).
 * `dashboardContextoAtual` guarda as transações e o nome do cliente do
 * dashboard aberto no momento — usado pelos botões de exportar PDF e
 * pelo Balancete Ampliado (contabilidade.js), evitando refazer a
 * consulta ao banco pra cada uma dessas ações.
 *
 * ATUALIZAÇÃO — CICLO FINANCEIRO DO CLIENTE: clientes que não recebem no dia 1
 * (ex.: dia 27 → 27/05 a 26/06) ganham "Ciclo atual" / "Ciclo anterior" no
 * filtro de período e o dashboard já abre no ciclo atual. Como Resumo, DRE,
 * Balancete e Balancete Ampliado leem o mesmo recorte, todos seguem o ciclo.
 *
 * ATUALIZAÇÃO — BUSCA: campo "Buscar cliente" acima da grade filtra
 * os cards por apelido, nome, e-mail, telefone ou CPF (ver admin.js).
 *
 * ATUALIZAÇÃO — LANÇAMENTOS PELO ADMIN: aba "📒 Lançamentos" e botões ✏️/🗑️
 * no painel "O que tem em …" (lancamentos-gestao.js). Depois de salvar,
 * recarregarDashboardAtual() busca tudo de novo mantendo período e filtros.
 *
 * ATUALIZAÇÃO — GRÁFICOS INTERATIVOS (filtro cruzado):
 * - Clicar numa fatia da rosca (ou na legenda) filtra pelo GRUPO
 *   (Essencial, Estilo de Vida, Investimentos, Dívidas): as barras passam a
 *   mostrar só as categorias daquele grupo, a Análise Detalhada mostra os
 *   números do grupo, o card de KPI correspondente fica em destaque e o
 *   painel "🔎 O que tem em …" lista as categorias e os lançamentos.
 * - Clicar numa barra filtra pela CATEGORIA: a rosca destaca o grupo dela,
 *   a barra fica em destaque e o painel lista os lançamentos da categoria.
 * - As barras usam a cor do grupo da categoria (mesma cor da rosca).
 * - Clicar de novo no mesmo item, no ✕ da faixa "Filtrando" ou em
 *   "Limpar" desfaz. Trocar o período mantém a seleção quando ainda há
 *   dados para ela. KPIs gerais, régua e dicas continuam sobre o total.
 */

let chartDonut = null;
let chartBar   = null;

// Contexto do dashboard atualmente aberto no modal — alimenta as abas
// DRE/Balancete, os botões "Exportar PDF" e o Balancete Ampliado
// (ver contabilidade.js) sem precisar reconsultar o banco.
// `transacoesTodas` = tudo que veio do banco; `transacoes` = só o que
// está dentro do período escolhido na barra de filtro. Todo o resto do
// sistema (Resumo, DRE, Balancete, Balancete Ampliado, exportar PDF)
// lê `transacoes`, portanto todos respeitam o período automaticamente.
let dashboardContextoAtual = {
  transacoes: [], transacoesTodas: [], clienteNome: '',
  periodoLabel: 'Todos os lançamentos'
};

let dashboardPeriodoAtual = { preset: 'todos', inicio: null, fim: null };

// Filtro cruzado dos gráficos (clique na rosca / nas barras)
let filtroGraficoDash = { grupo: null, categoria: null };
// Números do período atual usados pelos gráficos interativos
let baseGraficosDash = null;

function initDashboards() {
  window.addEventListener('section:change', ({ detail }) => {
    if (detail.section === 'dashboards') renderDashboards();
  });
  initModalDashboardTabs();
  initFiltroPeriodoDashboard();
  ligarBuscaClientes('dashboards-busca', 'dashboards-grid', 'dashboards-busca-contador');
  renderDashboards();
}

async function renderDashboards() {
  const grid = document.getElementById('dashboards-grid');
  if (!grid) return;
  grid.innerHTML = '<p class="empty-state">Carregando...</p>';

  if (!allClientes.length) await loadAllClientes();

  if (!allClientes.length) {
    grid.innerHTML = '<p class="empty-state">Nenhum cliente cadastrado.</p>';
    return;
  }

  const clienteIds = allClientes.map(c => c.id);
  const riscos     = await calcularRiscosPorCliente(clienteIds);

  grid.innerHTML = allClientes.map(c => {
    const risco = riscos[c.id] || classificarRisco([]);
    // O badge de risco tem uma FAIXA PRÓPRIA, sempre no mesmo lugar em
    // todos os cards (antes dividia a linha com o nome e mudava de
    // altura conforme o tamanho do nome).
    return `
    <div class="card card--uniforme" data-busca="${textoBuscaCliente(c)}">
      <div class="card-identidade">
        <div class="card-identidade__texto">
          <p class="card-name dado-sensivel">${escaparHtml(c.nome)}</p>
          <p class="card-sub dado-sensivel">${escaparHtml(c.email) || 'Sem email'}</p>
        </div>
        <button type="button" class="btn-olho" data-olho-card
          title="Mostrar/ocultar nome e email deste cliente"
          aria-label="Mostrar ou ocultar dados deste cliente">👁️</button>
      </div>
      <div class="card-faixa-badge">
        <span class="risk-badge ${risco.classe}" title="Classificação de risco financeiro">${risco.emoji} ${risco.label}</span>
      </div>
      <div class="card-espacador"></div>
      <div class="card-actions card-actions--full">
        <button class="btn-card ver-dashboard" data-id="${c.id}" data-nome="${escaparHtml(c.nome)}">
          📊 Ver Dashboard
        </button>
      </div>
    </div>
  `;
  }).join('');

  if (typeof aplicarPrivacidadeNaGrade === 'function') aplicarPrivacidadeNaGrade(grid);

  // Mantém o filtro digitado quando a grade é redesenhada.
  aplicarBuscaClientes('dashboards-busca', 'dashboards-grid', 'dashboards-busca-contador');

  grid.querySelectorAll('.btn-card.ver-dashboard').forEach(btn => {
    btn.addEventListener('click', () => abrirDashboard(btn.dataset.id, btn.dataset.nome));
  });
}

async function calcularRiscosPorCliente(clienteIds) {
  const riscos = {};
  clienteIds.forEach(id => { riscos[id] = classificarRisco([]); });

  if (!clienteIds.length) return riscos;

  const { data, error } = await supabaseClient
    .from('transacoes')
    .select('valor, tipo, client_id, categorias(grupo)')
    .in('client_id', clienteIds);

  if (error) {
    console.error('❌ calcularRiscosPorCliente:', error.message);
    return riscos;
  }

  const porCliente = {};
  (data || []).forEach(t => {
    if (!porCliente[t.client_id]) porCliente[t.client_id] = [];
    porCliente[t.client_id].push(t);
  });

  clienteIds.forEach(id => {
    riscos[id] = classificarRisco(porCliente[id] || []);
  });

  return riscos;
}

function classificarRisco(transacoes) {
  // Transferências internas não são receita nem despesa de verdade —
  // excluídas antes de qualquer cálculo (mesma regra do resto do app).
  const semTransferencias = transacoes.filter(t => t.categorias?.grupo !== 'transferencia');

  if (!semTransferencias.length) {
    return { classe: 'cinza', emoji: '⚪', label: 'Sem dados' };
  }

  let totalReceita = 0, totalDespesa = 0;

  semTransferencias.forEach(t => {
    const valor = Math.abs(parseFloat(t.valor) || 0);
    if (t.tipo === 'receita') totalReceita += valor;
    else                      totalDespesa += valor;
  });

  const saldo        = totalReceita - totalDespesa;
  const taxaPoupanca  = totalReceita > 0 ? (saldo / totalReceita) * 100 : 0;

  if (saldo < 0)           return { classe: 'vermelho', emoji: '🔴', label: 'Risco Alto' };
  if (taxaPoupanca < 10)   return { classe: 'amarelo',  emoji: '🟡', label: 'Atenção'    };
  return                          { classe: 'verde',    emoji: '🟢', label: 'Saudável'   };
}

async function abrirDashboard(clienteId, nome) {
  document.getElementById('modal-dashboard-title').textContent = `📊 Dashboard: ${nome}`;
  // "kpi-dividas" incluído aqui — sem ele o valor do CLIENTE ANTERIOR
  // continuava visível enquanto a busca nova terminava.
  ['kpi-sobrevivencia','kpi-estilo','kpi-investimentos','kpi-dividas','kpi-poupanca'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '...';
  });

  const resumoEl = document.getElementById('insights-dashboard-resumo');
  const listaEl  = document.getElementById('insights-dashboard-lista');
  if (resumoEl) resumoEl.textContent = '';
  if (listaEl)  listaEl.innerHTML = '<p class="empty-state">Carregando...</p>';

  // Sempre volta pra aba "Resumo" ao abrir um novo cliente, e limpa o
  // conteúdo anterior de DRE/Balancete.
  ativarAbaModalDashboard('resumo');
  document.getElementById('dre-container').innerHTML = '<p class="empty-state">Carregando...</p>';
  document.getElementById('balancete-container').innerHTML = '<p class="empty-state">Carregando...</p>';

  // Novo cliente: nenhum filtro de gráfico ativo
  filtroGraficoDash = { grupo: null, categoria: null };
  baseGraficosDash = null;

  openModal('modal-dashboard');

  if (chartDonut) { chartDonut.destroy(); chartDonut = null; }
  if (chartBar)   { chartBar.destroy();   chartBar   = null; }

  ['dash-engajamento', 'dash-503020'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<p class="empty-state">Carregando...</p>';
  });

  if (typeof GestaoLancamentosAdmin !== 'undefined') GestaoLancamentosAdmin.reiniciar();

  const ok = await carregarDadosDashboard(clienteId, nome);
  if (!ok) return;

  // Ao trocar de cliente o filtro volta para "Todos os lançamentos".
  resetarFiltroPeriodoDashboard();
  aplicarPeriodoDashboard();
}

/**
 * Depois que o admin cria/edita/exclui um lançamento (lancamentos-gestao.js):
 * busca tudo de novo e redesenha, mantendo período e filtro dos gráficos.
 */
async function recarregarDashboardAtual() {
  const { clienteId, clienteNome } = dashboardContextoAtual;
  if (!clienteId) return;
  const ok = await carregarDadosDashboard(clienteId, clienteNome);
  if (ok) aplicarPeriodoDashboard();
}

/** Busca transações/metas/gamificação do cliente e monta o contexto. */
async function carregarDadosDashboard(clienteId, nome) {
  // Transações (com as colunas que a gamificação usa) + metas + semanas
  // marcadas e XP guardado do cliente (gamificação v2), em paralelo.
  // As duas últimas falham em silêncio se a migração ainda não rodou.
  const [{ data: transacoes, error }, { data: metas }, { data: semanasMarcadas }, { data: estadoGami }] = await Promise.all([
    supabaseClient
      .from('transacoes')
      .select('id, client_id, categoria_id, valor, tipo, descricao, data_competencia, created_at, meta_id, origem, categorias(nome, grupo)')
      .eq('client_id', clienteId)
      .order('data_competencia', { ascending: false }),
    supabaseClient
      .from('metas')
      .select('id, nome, valor_necessario, valor_economizado')
      .eq('client_id', clienteId),
    supabaseClient.from('gamificacao_semanas').select('semana').eq('client_id', clienteId),
    supabaseClient.from('gamificacao_estado').select('xp_max').eq('client_id', clienteId).maybeSingle()
  ]);

  if (error) { showToast('Erro ao carregar dados: ' + error.message, 'error'); return false; }

  const cicloCliente = (typeof CicloModule !== 'undefined')
    ? CicloModule.deLinha(allClientes.find(c => c.id === clienteId))
    : { tipo: 'dia_mes', dia: 1 };

  dashboardContextoAtual = {
    clienteId,
    transacoes:      transacoes || [],
    transacoesTodas: transacoes || [],
    metas:           metas || [],
    ciclo:           cicloCliente,
    gamificacao:     { checkins: semanasMarcadas || [], xpGuardado: estadoGami?.xp_max || 0, ciclo: cicloCliente },
    clienteNome:     nome,
    periodoLabel:    'Todos os lançamentos'
  };

  // Blocos que olham o histórico INTEIRO (não mudam com o filtro de período)
  try { renderEngajamentoCliente(dashboardContextoAtual.transacoesTodas, dashboardContextoAtual.metas, dashboardContextoAtual.gamificacao); }
  catch (e) { console.error('❌ renderEngajamentoCliente:', e); }
  try { renderEvolucaoAdmin(dashboardContextoAtual.transacoesTodas, cicloCliente); }
  catch (e) { console.error('❌ renderEvolucaoAdmin:', e); }

  return true;
}

// ══════════════════════════════════════════════════════════════
// FILTRO DE PERÍODO (Resumo + DRE + Balancete, de uma vez só)
// ══════════════════════════════════════════════════════════════

/**
 * Converte o preset escolhido em um intervalo [inicio, fim] de datas
 * (strings AAAA-MM-DD, comparáveis direto com data_competencia — sem
 * converter para Date, o que evita o erro de fuso horário deslocando o
 * dia 01 para o dia 31 do mês anterior).
 */
function calcularIntervaloPeriodoDashboard(periodo) {
  const hoje = new Date();
  const ano  = hoje.getFullYear();
  const mes  = hoje.getMonth();
  const iso  = (a, m, d) => `${a}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const ultimoDia = (a, m) => new Date(a, m + 1, 0).getDate();
  const nomeMes = (a, m) => new Date(a, m, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

  switch (periodo.preset) {
    case 'mes-atual':
      return { inicio: iso(ano, mes, 1), fim: iso(ano, mes, ultimoDia(ano, mes)), label: nomeMes(ano, mes) };

    case 'mes-anterior': {
      const d = new Date(ano, mes - 1, 1);
      const a = d.getFullYear(), m = d.getMonth();
      return { inicio: iso(a, m, 1), fim: iso(a, m, ultimoDia(a, m)), label: nomeMes(a, m) };
    }

    case '3m': case '6m': case '12m': {
      const qtd = parseInt(periodo.preset, 10);
      const d = new Date(ano, mes - (qtd - 1), 1);
      return {
        inicio: iso(d.getFullYear(), d.getMonth(), 1),
        fim:    iso(ano, mes, ultimoDia(ano, mes)),
        label:  `Últimos ${qtd} meses (${nomeMes(d.getFullYear(), d.getMonth())} a ${nomeMes(ano, mes)})`
      };
    }

    case 'ano-atual':
      return { inicio: `${ano}-01-01`, fim: `${ano}-12-31`, label: `Ano de ${ano}` };

    case 'ciclo-atual':
    case 'ciclo-anterior': {
      if (typeof CicloModule === 'undefined') return { inicio: null, fim: null, label: 'Todos os lançamentos' };
      const c = CicloModule.cicloPorOffset(dashboardContextoAtual.ciclo, hoje, periodo.preset === 'ciclo-anterior' ? -1 : 0);
      return { inicio: c.inicio, fim: c.fim, label: `Ciclo ${c.rotulo}` };
    }

    case 'personalizado': {
      const inicio = periodo.inicio || null;
      const fim    = periodo.fim    || null;
      if (!inicio && !fim) return { inicio: null, fim: null, label: 'Todos os lançamentos' };
      const fmt = s => s ? s.split('-').reverse().join('/') : '…';
      return { inicio, fim, label: `De ${fmt(inicio)} até ${fmt(fim)}` };
    }

    default:
      return { inicio: null, fim: null, label: 'Todos os lançamentos' };
  }
}

function filtrarTransacoesPorPeriodoDashboard(transacoes, intervalo) {
  if (!intervalo.inicio && !intervalo.fim) return transacoes;
  return transacoes.filter(t => {
    const d = (t.data_competencia || '').slice(0, 10);
    if (!d) return false;
    if (intervalo.inicio && d < intervalo.inicio) return false;
    if (intervalo.fim    && d > intervalo.fim)    return false;
    return true;
  });
}

/**
 * Recalcula TUDO (KPIs, gráficos, análise, observações, DRE e
 * Balancete) em cima do recorte de período atual. É o único ponto que
 * escreve em `dashboardContextoAtual.transacoes`.
 */
function aplicarPeriodoDashboard() {
  const intervalo  = calcularIntervaloPeriodoDashboard(dashboardPeriodoAtual);
  const filtradas  = filtrarTransacoesPorPeriodoDashboard(dashboardContextoAtual.transacoesTodas, intervalo);

  dashboardContextoAtual.transacoes   = filtradas;
  dashboardContextoAtual.periodoLabel = intervalo.label;

  const info = document.getElementById('dashboard-periodo-info');
  if (info) {
    const total = dashboardContextoAtual.transacoesTodas.length;
    info.textContent = `${filtradas.length} de ${total} lançamento(s) · ${intervalo.label}`;
  }

  calcularEExibir(filtradas);
  renderizarDREEBalanceteNoModal(filtradas, dashboardContextoAtual.clienteNome, intervalo.label);
  if (typeof GestaoLancamentosAdmin !== 'undefined') GestaoLancamentosAdmin.renderAba();
}

/**
 * Opções "Ciclo do cliente" — só aparecem para clientes cujo ciclo não é
 * o mês normal. Retorna true se o cliente tem ciclo personalizado.
 */
function configurarOpcoesCicloAdmin() {
  const sel = document.getElementById('dashboard-periodo');
  if (!sel) return false;
  sel.querySelectorAll('option[data-ciclo]').forEach(o => o.remove());
  if (typeof CicloModule === 'undefined') return false;

  const cfg = dashboardContextoAtual.ciclo;
  if (CicloModule.ehMesCalendario(cfg)) return false;

  const hoje     = new Date();
  const atual    = CicloModule.cicloPorOffset(cfg, hoje, 0);
  const anterior = CicloModule.cicloPorOffset(cfg, hoje, -1);
  const criar = (valor, texto) => {
    const o = document.createElement('option');
    o.value = valor; o.textContent = texto; o.dataset.ciclo = '1';
    return o;
  };
  const a = criar('ciclo-atual',    `Ciclo atual do cliente (${atual.rotuloCurto})`);
  const b = criar('ciclo-anterior', `Ciclo anterior (${anterior.rotuloCurto})`);
  const ref = sel.querySelector('option[value="todos"]');
  if (ref) ref.after(a, b); else sel.prepend(a, b);
  return true;
}

function resetarFiltroPeriodoDashboard() {
  dashboardPeriodoAtual = { preset: 'todos', inicio: null, fim: null };
  const sel = document.getElementById('dashboard-periodo');
  if (sel) sel.value = 'todos';

  // Cliente com ciclo próprio (ex.: dia 27): já abre no ciclo atual dele.
  if (configurarOpcoesCicloAdmin() && sel) {
    sel.value = 'ciclo-atual';
    dashboardPeriodoAtual.preset = 'ciclo-atual';
  }
  document.getElementById('dashboard-periodo-custom')?.classList.add('hidden');
  const ini = document.getElementById('dashboard-periodo-inicio');
  const fim = document.getElementById('dashboard-periodo-fim');
  if (ini) ini.value = '';
  if (fim) fim.value = '';
}

function initFiltroPeriodoDashboard() {
  const sel = document.getElementById('dashboard-periodo');
  const box = document.getElementById('dashboard-periodo-custom');
  const ini = document.getElementById('dashboard-periodo-inicio');
  const fim = document.getElementById('dashboard-periodo-fim');

  sel?.addEventListener('change', () => {
    dashboardPeriodoAtual.preset = sel.value;
    box?.classList.toggle('hidden', sel.value !== 'personalizado');
    aplicarPeriodoDashboard();
  });

  [ini, fim].forEach(campo => {
    campo?.addEventListener('change', () => {
      dashboardPeriodoAtual.inicio = ini?.value || null;
      dashboardPeriodoAtual.fim    = fim?.value || null;
      aplicarPeriodoDashboard();
    });
  });
}

// Grupos da rosca. "Estilo de Vida" = toda despesa que não é essencial,
// investimento nem dívida (mesma conta dos KPIs).
const GRUPOS_DASH = {
  essencial:    { label: 'Essencial',      kpi: 'kpi-sobrevivencia', ref: 'até 50% da renda' },
  estilo:       { label: 'Estilo de Vida', kpi: 'kpi-estilo',        ref: 'até 30% da renda' },
  investimento: { label: 'Investimentos',  kpi: 'kpi-investimentos', ref: '10% da renda ou mais' },
  divida:       { label: 'Dívidas',        kpi: 'kpi-dividas',       ref: 'até 10% da renda' }
};
const ORDEM_GRUPOS_DASH = ['essencial', 'estilo', 'investimento', 'divida'];

function grupoDashDaTransacao(t) {
  const g = t.categorias?.grupo;
  return (g === 'essencial' || g === 'investimento' || g === 'divida') ? g : 'estilo';
}

function calcularEExibir(transacoes) {
  // Transferências internas (grupo 'transferencia') não são receita
  // nem despesa de verdade — dinheiro só mudou de lugar. Filtradas
  // FORA antes de qualquer cálculo (mesma regra do dashboard.js do cliente).
  const semTransferencias = transacoes.filter(t => t.categorias?.grupo !== 'transferencia');

  const receitas = semTransferencias.filter(t => t.tipo === 'receita');
  const despesas = semTransferencias.filter(t => t.tipo === 'despesa');

  const totalReceita = receitas.reduce((s, t) => s + Math.abs(t.valor), 0);
  const totalDespesa = despesas.reduce((s, t) => s + Math.abs(t.valor), 0);

  const custoSobrevivencia = despesas
    .filter(t => t.categorias?.grupo === 'essencial')
    .reduce((s, t) => s + Math.abs(t.valor), 0);

  const aportesInvestimento = despesas
    .filter(t => t.categorias?.grupo === 'investimento')
    .reduce((s, t) => s + Math.abs(t.valor), 0);

  // Dívidas e Financiamentos: isolado do Custo Essencial e do Estilo
  // de Vida — pagar um empréstimo não é a mesma coisa que sobrevivência
  // nem lazer, e misturar os dois distorce as duas métricas.
  const custoDivida = despesas
    .filter(t => t.categorias?.grupo === 'divida')
    .reduce((s, t) => s + Math.abs(t.valor), 0);

  const estiloDeVida = Math.max(0, totalDespesa - custoSobrevivencia - aportesInvestimento - custoDivida);
  const saldo        = totalReceita - totalDespesa;
  // Taxa de poupança REAL — negativa quando o cliente gasta mais do que
  // ganha (antes era cortada em 0%, escondendo justamente o pior caso).
  const taxaPoupanca  = totalReceita > 0 ? (saldo / totalReceita) * 100 : 0;

  document.getElementById('kpi-sobrevivencia').textContent  = formatCurrency(custoSobrevivencia);
  document.getElementById('kpi-estilo').textContent         = formatCurrency(estiloDeVida);
  document.getElementById('kpi-investimentos').textContent  = formatCurrency(aportesInvestimento);
  document.getElementById('kpi-dividas').textContent         = formatCurrency(custoDivida);

  const kpiPoupanca = document.getElementById('kpi-poupanca');
  if (kpiPoupanca) {
    kpiPoupanca.textContent = totalReceita > 0 ? `${taxaPoupanca.toFixed(1).replace('.', ',')}%` : '—';
    kpiPoupanca.classList.toggle('kpi-value--negativo', taxaPoupanca < 0);
  }

  // Contexto de cada KPI: quanto representa da renda e a referência
  const pct = (v) => totalReceita > 0 ? (v / totalReceita) * 100 : null;
  preencherSubKpi('kpi-sobrevivencia-sub', pct(custoSobrevivencia), 'até 50%', p => p <= 50);
  preencherSubKpi('kpi-estilo-sub',        pct(estiloDeVida),       'até 30%', p => p <= 30);
  preencherSubKpi('kpi-investimentos-sub', pct(aportesInvestimento),'10% ou mais', p => p >= 10);
  preencherSubKpi('kpi-dividas-sub',       pct(custoDivida),        'até 10%', p => p <= 10);
  const subPoup = document.getElementById('kpi-poupanca-sub');
  if (subPoup) {
    subPoup.textContent = totalReceita <= 0
      ? 'Sem receitas no período'
      : saldo < 0 ? `Gastou ${formatCurrency(-saldo)} a mais do que recebeu` : `Sobrou ${formatCurrency(saldo)} · ideal 20%+`;
    subPoup.className = 'kpi-sub ' + (totalReceita <= 0 ? '' : saldo < 0 ? 'kpi-sub--ruim' : taxaPoupanca >= 20 ? 'kpi-sub--bom' : 'kpi-sub--atencao');
  }

  render503020({ totalReceita, custoSobrevivencia, estiloDeVida, aportesInvestimento, custoDivida, saldo });

  // Base dos gráficos interativos: cada despesa já com o grupo da rosca
  const despesasComGrupo = despesas.map(t => ({
    id:        t.id,
    data:     (t.data_competencia || '').slice(0, 10),
    descricao: t.descricao || '',
    categoria: t.categorias?.nome || 'Sem Categoria',
    grupo:     grupoDashDaTransacao(t),
    valor:     Math.abs(parseFloat(t.valor) || 0)
  }));
  baseGraficosDash = {
    despesas: despesasComGrupo,
    totalReceita, totalDespesa,
    porGrupo: { essencial: custoSobrevivencia, estilo: estiloDeVida, investimento: aportesInvestimento, divida: custoDivida },
    totalTransacoes: semTransferencias.length,
    saldo
  };

  // Seleção que deixou de existir no novo período é desfeita
  if (filtroGraficoDash.categoria && !despesasComGrupo.some(d => d.categoria === filtroGraficoDash.categoria)) {
    filtroGraficoDash.categoria = null;
  }
  if (filtroGraficoDash.grupo && !(baseGraficosDash.porGrupo[filtroGraficoDash.grupo] > 0)) {
    filtroGraficoDash = { grupo: null, categoria: null };
  }

  renderGraficosInterativos();

  renderInsightsDashboard({
    totalReceita, totalDespesa, custoSobrevivencia, estiloDeVida,
    aportesInvestimento, custoDivida, saldo,
    taxaPoupanca: totalReceita > 0 ? (saldo / totalReceita) * 100 : 0,
    totalTransacoes: semTransferencias.length
  });
}

// Cores validadas para daltonismo sobre o fundo escuro do admin
// (skill dataviz): ordem fixa essencial → estilo → investimento → dívida.
const CORES_GRUPOS = { essencial: '#d9506e', estilo: '#a88a22', investimento: '#1f9d8a', divida: '#8b6cf0' };

// ══════════════════════════════════════════════════════════════
// GRÁFICOS INTERATIVOS — filtro cruzado rosca ↔ barras ↔ análise
// ══════════════════════════════════════════════════════════════

/** Cor com transparência (para "apagar" o que não está selecionado). */
function corApagada(hex) { return `${hex}40`; }

/** Grupo em foco: o escolhido na rosca ou o da categoria escolhida nas barras. */
function grupoEmFocoDash() {
  if (filtroGraficoDash.grupo) return filtroGraficoDash.grupo;
  if (filtroGraficoDash.categoria && baseGraficosDash) {
    return baseGraficosDash.despesas.find(d => d.categoria === filtroGraficoDash.categoria)?.grupo || null;
  }
  return null;
}

function selecionarGrupoDash(grupo) {
  const mesmo = filtroGraficoDash.grupo === grupo && !filtroGraficoDash.categoria;
  filtroGraficoDash = mesmo ? { grupo: null, categoria: null } : { grupo, categoria: null };
  renderGraficosInterativos();
}

function selecionarCategoriaDash(categoria) {
  if (filtroGraficoDash.categoria === categoria) {
    // 2º clique na mesma barra: volta para o grupo (se havia) ou limpa
    filtroGraficoDash.categoria = null;
  } else {
    filtroGraficoDash.categoria = categoria;
  }
  renderGraficosInterativos();
}

function limparFiltroGraficosDash() {
  filtroGraficoDash = { grupo: null, categoria: null };
  renderGraficosInterativos();
}

function renderGraficosInterativos() {
  if (!baseGraficosDash) return;
  renderDonut();
  renderBarChart();
  renderAnalise();
  renderFaixaFiltroDash();
  renderDetalheSelecaoDash();
  destacarKpiDoGrupo();
}

function renderDonut() {
  const ctx = document.getElementById('chart-donut');
  if (!ctx || !baseGraficosDash) return;
  // "Canvas is already in use": trocar o período redesenha os gráficos,
  // e o Chart.js recusa reutilizar um <canvas> com instância viva.
  if (chartDonut) { chartDonut.destroy(); chartDonut = null; }

  const foco = grupoEmFocoDash();
  const fatias = ORDEM_GRUPOS_DASH
    .map(chave => ({ chave, label: GRUPOS_DASH[chave].label, valor: baseGraficosDash.porGrupo[chave], cor: CORES_GRUPOS[chave] }))
    .filter(f => f.valor > 0);
  const total = fatias.reduce((s, f) => s + f.valor, 0);
  if (!total) return;
  const pctTxt = (v) => `${((v / total) * 100).toFixed(0)}%`;

  chartDonut = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: fatias.map(f => `${f.label} · ${pctTxt(f.valor)}`),
      datasets: [{ data: fatias.map(f => f.valor),
        backgroundColor: fatias.map(f => (!foco || f.chave === foco) ? f.cor : corApagada(f.cor)),
        borderColor: '#0e1512', borderWidth: 2, hoverOffset: 6,
        offset: fatias.map(f => (foco && f.chave === foco) ? 10 : 0) }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '65%',
      onClick: (_evt, elementos) => {
        if (!elementos.length) return;
        selecionarGrupoDash(fatias[elementos[0].index].chave);
      },
      onHover: (evt, elementos) => {
        const alvo = evt.native?.target;
        if (alvo) alvo.style.cursor = elementos.length ? 'pointer' : 'default';
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#9fb8ab', font: { size: 11 }, padding: 12, usePointStyle: true },
          // Clicar na legenda também filtra (em vez de esconder a fatia)
          onClick: (_evt, item) => selecionarGrupoDash(fatias[item.index].chave),
          onHover: (evt) => { const alvo = evt.native?.target; if (alvo) alvo.style.cursor = 'pointer'; }
        },
        tooltip: { callbacks: {
          label: c => ` ${fatias[c.dataIndex].label}: ${formatCurrency(c.parsed)} (${pctTxt(c.parsed)})`,
          footer: () => 'Clique para ver o que tem aqui'
        } }
      }
    }
  });
}

function renderBarChart() {
  const ctx = document.getElementById('chart-bar');
  if (!ctx || !baseGraficosDash) return;
  if (chartBar) { chartBar.destroy(); chartBar = null; }

  const foco = grupoEmFocoDash();
  const universo = foco ? baseGraficosDash.despesas.filter(d => d.grupo === foco) : baseGraficosDash.despesas;

  // Soma por categoria (lembrando o grupo de cada uma para a cor)
  const mapa = {};
  universo.forEach(d => {
    if (!mapa[d.categoria]) mapa[d.categoria] = { valor: 0, grupos: {} };
    mapa[d.categoria].valor += d.valor;
    mapa[d.categoria].grupos[d.grupo] = (mapa[d.categoria].grupos[d.grupo] || 0) + d.valor;
  });
  const limite = foco ? 12 : 8;
  const cats = Object.entries(mapa)
    .map(([nome, x]) => ({ nome, valor: x.valor, grupo: Object.entries(x.grupos).sort((a, b) => b[1] - a[1])[0][0] }))
    .sort((a, b) => b.valor - a.valor)
    .slice(0, limite);

  const titulo = ctx.closest('.chart-card')?.querySelector('h4');
  if (titulo) titulo.textContent = foco ? `📊 Categorias em ${GRUPOS_DASH[foco].label}` : '📊 Top Categorias de Despesa';

  const sel = filtroGraficoDash.categoria;
  const totalUniverso = universo.reduce((s, d) => s + d.valor, 0) || 1;

  chartBar = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: cats.map(c => c.nome),
      datasets: [{ label: 'Valor (R$)', data: cats.map(c => c.valor),
        backgroundColor: cats.map(c => (!sel || c.nome === sel) ? CORES_GRUPOS[c.grupo] : corApagada(CORES_GRUPOS[c.grupo])),
        borderRadius: 4, borderSkipped: false, maxBarThickness: 18 }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      onClick: (_evt, elementos) => {
        if (!elementos.length) return;
        selecionarCategoriaDash(cats[elementos[0].index].nome);
      },
      onHover: (evt, elementos) => {
        const alvo = evt.native?.target;
        if (alvo) alvo.style.cursor = elementos.length ? 'pointer' : 'default';
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          label: c => ` ${formatCurrency(c.parsed.x)} · ${((c.parsed.x / totalUniverso) * 100).toFixed(0)}% ${foco ? 'do grupo' : 'das despesas'}`,
          afterLabel: c => ` Grupo: ${GRUPOS_DASH[cats[c.dataIndex].grupo].label}`,
          footer: () => 'Clique para ver os lançamentos'
        } }
      },
      scales: {
        x: { ticks: { color: '#6b9e84', font: { size: 10 }, callback: v => v >= 1000 ? `${(v / 1000).toLocaleString('pt-BR')} mil` : v.toLocaleString('pt-BR') }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { ticks: { color: '#6b9e84', font: { size: 11 } }, grid: { display: false } }
      }
    }
  });
}

function renderAnalise() {
  const grid = document.getElementById('analise-grid');
  if (!grid || !baseGraficosDash) return;
  const b = baseGraficosDash;

  const titulo = grid.closest('.analise-section')?.querySelector('h4');
  const foco = grupoEmFocoDash();
  const cat  = filtroGraficoDash.categoria;

  let items;
  if (!foco) {
    const custoSobrevivencia = b.porGrupo.essencial, estiloDeVida = b.porGrupo.estilo;
    const aportesInvestimento = b.porGrupo.investimento, custoDivida = b.porGrupo.divida;
    const saldo        = b.totalReceita - b.totalDespesa;
    const taxaEconomia = b.totalReceita > 0 ? ((saldo / b.totalReceita) * 100).toFixed(1) : 0;
    if (titulo) titulo.textContent = '📊 ANÁLISE DETALHADA';
    items = [
      { label: 'Renda Total',       value: formatCurrency(b.totalReceita),      color: '#00f5a0' },
      { label: 'Custo Essencial',   value: formatCurrency(custoSobrevivencia),  color: '#f5d623', grupo: 'essencial' },
      { label: 'Estilo de Vida',    value: formatCurrency(estiloDeVida),        color: '#ff6384', grupo: 'estilo' },
      { label: 'Investimentos',     value: formatCurrency(aportesInvestimento), color: '#00f5a0', grupo: 'investimento' },
      { label: 'Dívidas',           value: formatCurrency(custoDivida),         color: '#ff9f40', grupo: 'divida' },
      { label: 'Despesa Total',     value: formatCurrency(b.totalDespesa),      color: '#ff4d6d' },
      { label: 'Saldo',             value: formatCurrency(saldo),               color: saldo >= 0 ? '#00f5a0' : '#ff4d6d' },
      { label: 'Taxa de Poupança',  value: taxaEconomia + '%',                  color: '#7b96ff' },
      { label: 'Transações',        value: b.totalTransacoes,                   color: '#6b9e84' },
    ];
  } else {
    const lista = b.despesas.filter(d => cat ? d.categoria === cat : d.grupo === foco);
    const total = lista.reduce((s, d) => s + d.valor, 0);
    const maior = lista.reduce((m, d) => (!m || d.valor > m.valor) ? d : m, null);
    const nomeSel = cat || GRUPOS_DASH[foco].label;
    const cor = CORES_GRUPOS[foco];
    const pctDesp  = b.totalDespesa > 0 ? (total / b.totalDespesa) * 100 : 0;
    const pctRenda = b.totalReceita > 0 ? (total / b.totalReceita) * 100 : null;
    const nCats = new Set(lista.map(d => d.categoria)).size;
    if (titulo) titulo.textContent = `📊 ANÁLISE DETALHADA — ${nomeSel.toUpperCase()}`;
    items = [
      { label: `Total em ${nomeSel}`,  value: formatCurrency(total),                       color: cor },
      { label: '% das despesas',       value: `${pctDesp.toFixed(1)}%`,                    color: '#7b96ff' },
      { label: '% da renda',           value: pctRenda === null ? '—' : `${pctRenda.toFixed(1)}%`, color: '#7b96ff' },
      { label: 'Lançamentos',          value: lista.length,                                color: '#6b9e84' },
      { label: 'Média por lançamento', value: formatCurrency(lista.length ? total / lista.length : 0), color: '#9fb8ab' },
      { label: 'Maior lançamento',     value: maior ? formatCurrency(maior.valor) : '—',   color: '#ff9f40' },
      cat
        ? { label: 'Grupo',            value: GRUPOS_DASH[foco].label,                     color: cor }
        : { label: 'Categorias',       value: nCats,                                       color: '#6b9e84' },
      { label: 'Referência do grupo',  value: GRUPOS_DASH[foco].ref,                       color: '#9fb8ab' }
    ];
  }

  grid.innerHTML = items.map(item => `
    <div class="analise-item ${item.grupo ? 'analise-item--clicavel' : ''}" ${item.grupo ? `data-grupo="${item.grupo}" title="Clique para ver o que tem aqui"` : ''}>
      <span class="analise-item-label">${escaparHtml(String(item.label))}</span>
      <span class="analise-item-value" style="color:${item.color}">${escaparHtml(String(item.value))}</span>
    </div>
  `).join('');

  // Cards de grupo da análise também filtram (mesmo efeito da rosca)
  grid.querySelectorAll('.analise-item--clicavel').forEach(el => {
    el.addEventListener('click', () => selecionarGrupoDash(el.dataset.grupo));
  });
}

/** Faixa "Filtrando: Dívidas › Cartão (Parcelamento) ✕". */
function renderFaixaFiltroDash() {
  const el = document.getElementById('dash-filtro-cruzado');
  if (!el) return;
  const foco = grupoEmFocoDash();
  if (!foco) { el.classList.add('hidden'); el.innerHTML = ''; return; }

  const cat = filtroGraficoDash.categoria;
  el.classList.remove('hidden');
  el.innerHTML = `
    <span class="dash-filtro__rotulo">Filtrando:</span>
    <button type="button" class="dash-filtro__chip" data-acao="grupo" style="--cor:${CORES_GRUPOS[foco]}">
      <i></i>${escaparHtml(GRUPOS_DASH[foco].label)}
    </button>
    ${cat ? `<span class="dash-filtro__seta">›</span>
      <span class="dash-filtro__chip dash-filtro__chip--cat" style="--cor:${CORES_GRUPOS[foco]}">${escaparHtml(cat)}</span>` : ''}
    <button type="button" class="dash-filtro__limpar" data-acao="limpar" title="Mostrar tudo de novo">✕ Limpar</button>`;

  el.querySelector('[data-acao="limpar"]').addEventListener('click', limparFiltroGraficosDash);
  // Com categoria escolhida, tocar no grupo volta um nível (grupo inteiro)
  el.querySelector('[data-acao="grupo"]').addEventListener('click', () => {
    filtroGraficoDash = { grupo: foco, categoria: null };
    renderGraficosInterativos();
  });
}

/** Painel "🔎 O que tem em …": categorias do grupo + lançamentos. */
function renderDetalheSelecaoDash() {
  const el = document.getElementById('dash-detalhe');
  if (!el) return;
  const foco = grupoEmFocoDash();
  if (!foco || !baseGraficosDash) { el.classList.add('hidden'); el.innerHTML = ''; return; }

  const b = baseGraficosDash;
  const cat = filtroGraficoDash.categoria;
  const lista = b.despesas.filter(d => cat ? d.categoria === cat : d.grupo === foco);
  const total = lista.reduce((s, d) => s + d.valor, 0);
  const pctRenda = b.totalReceita > 0 ? ` · ${((total / b.totalReceita) * 100).toFixed(0)}% da renda` : '';
  const pctDesp  = b.totalDespesa > 0 ? `${((total / b.totalDespesa) * 100).toFixed(0)}% das despesas` : '';
  const cor = CORES_GRUPOS[foco];
  const fmtData = (iso) => iso ? iso.split('-').reverse().slice(0, 2).join('/') : '—';

  // Categorias dentro do grupo (só quando o filtro é o grupo inteiro)
  let blocoCategorias = '';
  if (!cat) {
    const porCat = {};
    lista.forEach(d => { porCat[d.categoria] = (porCat[d.categoria] || 0) + d.valor; });
    const ordenadas = Object.entries(porCat).sort((a, b2) => b2[1] - a[1]);
    blocoCategorias = `
      <div class="dash-detalhe__cats">
        ${ordenadas.map(([nome, v]) => `
          <button type="button" class="dash-detalhe__cat" data-cat="${escaparHtml(nome)}" title="Ver só ${escaparHtml(nome)}">
            <span class="dash-detalhe__cat-barra" style="width:${total ? (v / total) * 100 : 0}%; background:${cor}"></span>
            <span class="dash-detalhe__cat-nome">${escaparHtml(nome)}</span>
            <span class="dash-detalhe__cat-valor">${formatCurrency(v)} · ${total ? ((v / total) * 100).toFixed(0) : 0}%</span>
          </button>`).join('')}
      </div>`;
  }

  const LIMITE = 12;
  const lancOrdenados = [...lista].sort((a, b2) => b2.valor - a.valor);
  const mostrarTodos = el.dataset.todos === '1';
  const visiveis = mostrarTodos ? lancOrdenados : lancOrdenados.slice(0, LIMITE);

  el.classList.remove('hidden');
  el.style.setProperty('--cor', cor);
  el.innerHTML = `
    <div class="dash-detalhe__topo">
      <div>
        <h4>🔎 O que tem em ${escaparHtml(cat || GRUPOS_DASH[foco].label)}</h4>
        <p class="dash-detalhe__sub">${formatCurrency(total)} · ${pctDesp}${pctRenda} · ${lista.length} lançamento(s)</p>
      </div>
      <button type="button" class="dash-filtro__limpar" data-acao="fechar">✕ Fechar</button>
    </div>
    ${blocoCategorias}
    <div class="dash-detalhe__lista">
      <div class="dash-detalhe__linha dash-detalhe__linha--cab">
        <span>Data</span><span>Descrição</span><span>Categoria</span><span>Valor</span><span></span>
      </div>
      ${visiveis.map(d => `
        <div class="dash-detalhe__linha" data-id="${d.id || ''}">
          <span>${fmtData(d.data)}</span>
          <span title="${escaparHtml(d.descricao)}">${escaparHtml(d.descricao || '—')}</span>
          <span>${escaparHtml(d.categoria)}</span>
          <span class="dash-detalhe__valor">${formatCurrency(d.valor)}</span>
          <span class="lanc-gestao__acoes">${d.id ? `
            <button type="button" class="lanc-gestao__btn" data-acao="editar" title="Editar lançamento">✏️</button>
            <button type="button" class="lanc-gestao__btn" data-acao="excluir" title="Excluir lançamento">🗑️</button>` : ''}
          </span>
        </div>`).join('') || '<p class="empty-state">Nenhum lançamento.</p>'}
    </div>
    ${lancOrdenados.length > LIMITE ? `
      <button type="button" class="dash-detalhe__mais" data-acao="todos">
        ${mostrarTodos ? 'Mostrar só os maiores' : `Ver todos os ${lancOrdenados.length} lançamentos`}
      </button>` : ''}`;

  el.querySelector('[data-acao="fechar"]').addEventListener('click', limparFiltroGraficosDash);
  el.querySelector('[data-acao="todos"]')?.addEventListener('click', () => {
    el.dataset.todos = mostrarTodos ? '0' : '1';
    renderDetalheSelecaoDash();
  });
  el.querySelectorAll('.dash-detalhe__cat').forEach(btn => {
    btn.addEventListener('click', () => {
      filtroGraficoDash = { grupo: foco, categoria: btn.dataset.cat };
      el.dataset.todos = '0';
      renderGraficosInterativos();
    });
  });
}

/** Card de KPI do grupo em foco ganha destaque; os outros ficam normais. */
function destacarKpiDoGrupo() {
  const foco = grupoEmFocoDash();
  ORDEM_GRUPOS_DASH.forEach(g => {
    const card = document.getElementById(GRUPOS_DASH[g].kpi)?.closest('.kpi-card');
    if (card) card.classList.toggle('kpi-card--foco', g === foco);
  });
}

// ══════════════════════════════════════════════════════════════
// CONTEXTO DOS KPIs, RÉGUA 50/30/20, ENGAJAMENTO E EVOLUÇÃO
// ══════════════════════════════════════════════════════════════

let chartEvolucao = null;

/** Linha pequena sob cada KPI: "42% da renda · ref. até 50%", com ✓/⚠. */
function preencherSubKpi(id, pct, referencia, dentroDaReferencia) {
  const el = document.getElementById(id);
  if (!el) return;
  if (pct === null) { el.textContent = 'Sem receitas no período'; el.className = 'kpi-sub'; return; }
  const ok = dentroDaReferencia(pct);
  el.textContent = `${ok ? '✓' : '⚠'} ${pct.toFixed(0)}% da renda · ref. ${referencia}`;
  el.className = `kpi-sub ${ok ? 'kpi-sub--bom' : 'kpi-sub--atencao'}`;
}

/**
 * Régua 50/30/20 (+ dívidas): quanto de cada real que entrou foi para
 * cada destino, com a referência marcada na barra. Escala da barra:
 * 0–100% da renda.
 */
function render503020(m) {
  const el = document.getElementById('dash-503020');
  if (!el) return;

  if (m.totalReceita <= 0) {
    el.innerHTML = `<h4>📏 Para onde foi a renda</h4><p class="empty-state">Sem receitas lançadas neste período — não há como calcular a distribuição.</p>`;
    return;
  }

  const r = m.totalReceita;
  const guardado = m.aportesInvestimento + Math.max(0, m.saldo);
  const linhas = [
    { nome: 'Essenciais',             valor: m.custoSobrevivencia, ref: 50, tipo: 'max', cor: CORES_GRUPOS.essencial,    dica: 'moradia, contas, mercado, saúde, transporte' },
    { nome: 'Estilo de vida',         valor: m.estiloDeVida,       ref: 30, tipo: 'max', cor: CORES_GRUPOS.estilo,       dica: 'lazer, delivery, compras, assinaturas' },
    { nome: 'Guardado / investido',   valor: guardado,             ref: 20, tipo: 'min', cor: CORES_GRUPOS.investimento, dica: 'aportes + o que sobrou no período' },
    { nome: 'Dívidas',                valor: m.custoDivida,        ref: 10, tipo: 'max', cor: CORES_GRUPOS.divida,       dica: 'parcelas, empréstimos, financiamentos' }
  ];

  el.innerHTML = `
    <div class="regua-topo">
      <h4>📏 Para onde foi a renda</h4>
      <span class="regua-legenda"><i class="regua-legenda__marca"></i> referência</span>
    </div>
    ${linhas.map(l => {
      const pct = (l.valor / r) * 100;
      const ok  = l.tipo === 'max' ? pct <= l.ref : pct >= l.ref;
      const refTxt = l.tipo === 'max' ? `até ${l.ref}%` : `${l.ref}% ou mais`;
      return `
        <div class="regua-linha">
          <div class="regua-linha__rotulo">
            <span class="regua-linha__nome">${l.nome}</span>
            <span class="regua-linha__dica">${l.dica}</span>
          </div>
          <div class="regua-linha__barra" title="${formatCurrency(l.valor)} de ${formatCurrency(r)}">
            <div class="regua-linha__preenchimento" style="width:${Math.min(pct, 100)}%; background:${l.cor}"></div>
            <div class="regua-linha__marca" style="left:${l.ref}%"></div>
          </div>
          <div class="regua-linha__valor ${ok ? 'regua--ok' : 'regua--fora'}">
            <strong>${pct.toFixed(0)}%</strong>
            <span>${ok ? '✓' : '⚠'} ${refTxt}</span>
          </div>
        </div>`;
    }).join('')}
  `;
}

/**
 * Engajamento do cliente (histórico inteiro): nível, sequência, último
 * lançamento, saúde do mês, missões e conquistas — mesmos números que o
 * cliente vê no painel dele (GamificacaoModule.calcular).
 */
function renderEngajamentoCliente(transacoes, metas, gamificacao = {}) {
  const el = document.getElementById('dash-engajamento');
  if (!el) return;
  if (typeof GamificacaoModule === 'undefined') { el.innerHTML = ''; return; }

  const e = GamificacaoModule.calcular(transacoes, metas, new Date(), gamificacao);

  // Último lançamento FEITO PELO CLIENTE (created_at) → "há N dias".
  // O que o admin lança/importa pelo painel não conta como atividade dele.
  const datas = transacoes
    .filter(t => t.origem !== 'lancamento_admin')
    .map(t => GamificacaoModule._interno.parseCriadoEm(t.created_at)).filter(Boolean);
  const ultimo = datas.length ? new Date(Math.max(...datas)) : null;
  const diasSem = ultimo ? Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(ultimo).setHours(0, 0, 0, 0)) / 864e5) : null;
  const ultimoTxt = diasSem === null ? 'nunca' : diasSem === 0 ? 'hoje' : diasSem === 1 ? 'ontem' : `há ${diasSem} dias`;
  const inativo = diasSem === null || diasSem >= 15;

  const ganhas = e.conquistas.filter(c => c.ok).length;
  const missoes = e.missoes.filter(m => m.cumprida).length;
  const s = e.saude;

  el.innerHTML = `
    <div class="engaj-item">
      <span class="engaj-item__rotulo">Nível</span>
      <strong>${e.nivel.numero} · ${escaparHtml(e.nivel.nome)}</strong>
      <span class="engaj-item__sub">${e.nivel.xp.toLocaleString('pt-BR')} XP</span>
    </div>
    <div class="engaj-item">
      <span class="engaj-item__rotulo">Semanas em dia</span>
      <strong>🔥 ${e.sequencia} ${e.sequencia === 1 ? 'semana' : 'semanas'}</strong>
      <span class="engaj-item__sub">${e.semanaAtualEmDia ? 'esta semana em dia' : 'esta semana pendente'} · recorde ${e.melhorSequencia}</span>
    </div>
    <div class="engaj-item ${inativo ? 'engaj-item--alerta' : ''}">
      <span class="engaj-item__rotulo">Último lançamento</span>
      <strong>${ultimoTxt}</strong>
      <span class="engaj-item__sub">${inativo ? 'vale mandar uma mensagem' : `${e.totalLancamentos} feitos pelo cliente`}</span>
    </div>
    <div class="engaj-item">
      <span class="engaj-item__rotulo">${s ? `Saúde de ${escaparHtml(s.mes)}${s.ehPrevia ? ' (prévia)' : ''}` : 'Saúde financeira'}</span>
      <strong class="${s ? 'engaj-saude--' + s.classe : ''}">${s ? `${s.nota} · ${s.label}` : 'sem receita'}</strong>
      <span class="engaj-item__sub">${[
        s && s.delta !== null ? (s.delta === 0 ? `igual a ${escaparHtml(s.mesAnterior)}` : `${s.delta > 0 ? '▲' : '▼'} ${Math.abs(s.delta)} vs. ${escaparHtml(s.mesAnterior)}`) : '',
        s?.previa ? `prévia de ${escaparHtml(s.previa.mes)}: ${s.previa.nota}` : ''
      ].filter(Boolean).join(' · ') || (s?.ehPrevia ? 'mês ainda aberto' : '')}</span>
    </div>
    <div class="engaj-item">
      <span class="engaj-item__rotulo">Semana / conquistas</span>
      <strong>${missoes}/${e.missoes.length} missões</strong>
      <span class="engaj-item__sub">${ganhas} de ${e.conquistas.length} conquistas</span>
    </div>
  `;
}

/**
 * Receitas × despesas dos últimos 6 períodos (histórico inteiro, sem
 * transferências). Período = mês-calendário, ou ciclo do cliente quando
 * ele tem ciclo personalizado (ex.: 27/05 a 26/06).
 */
function renderEvolucaoAdmin(transacoes, ciclo) {
  const ctx = document.getElementById('chart-evolucao');
  if (!ctx) return;
  if (chartEvolucao) { chartEvolucao.destroy(); chartEvolucao = null; }

  const hoje   = new Date();
  const custom = typeof CicloModule !== 'undefined' && ciclo && !CicloModule.ehMesCalendario(ciclo);
  const meses  = [];
  for (let i = 5; i >= 0; i--) {
    if (custom) {
      const c = CicloModule.cicloPorOffset(ciclo, hoje, -i);
      meses.push({ chave: c.inicio, inicio: c.inicio, fim: c.fim,
                   rotulo: CicloModule.formatarBR(c.inicioDate), rec: 0, desp: 0 });
    } else {
      const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
      meses.push({ chave: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
                   rotulo: d.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', ''), rec: 0, desp: 0 });
    }
  }
  const porChave = Object.fromEntries(meses.map(m => [m.chave, m]));
  const localizarPeriodo = (dia) => custom
    ? meses.find(p => dia >= p.inicio && dia <= p.fim)
    : porChave[dia.slice(0, 7)];
  transacoes.forEach(t => {
    if (t.categorias?.grupo === 'transferencia' || !t.data_competencia) return;
    const m = localizarPeriodo(t.data_competencia.slice(0, 10));
    if (!m) return;
    const v = Math.abs(parseFloat(t.valor) || 0);
    if (t.tipo === 'receita') m.rec += v; else m.desp += v;
  });

  chartEvolucao = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: meses.map((m, i) => i === meses.length - 1 ? `${m.rotulo} (atual)` : m.rotulo),
      datasets: [
        { label: 'Receitas', data: meses.map(m => m.rec),  backgroundColor: '#1f9d8a', borderRadius: 4, maxBarThickness: 26 },
        { label: 'Despesas', data: meses.map(m => m.desp), backgroundColor: '#e0663a', borderRadius: 4, maxBarThickness: 26 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { color: '#9fb8ab', font: { size: 11 }, usePointStyle: true, boxWidth: 8 } },
        tooltip: { callbacks: {
          label: c => ` ${c.dataset.label}: ${formatCurrency(c.parsed.y)}`,
          footer: items => { const m = meses[items[0].dataIndex]; return `Saldo: ${formatCurrency(m.rec - m.desp)}`; }
        } }
      },
      scales: {
        x: { ticks: { color: '#9fb8ab', font: { size: 11 } }, grid: { display: false } },
        y: { ticks: { color: '#6b9e84', font: { size: 10 }, callback: v => v >= 1000 ? `${(v / 1000).toLocaleString('pt-BR')} mil` : v },
             grid: { color: 'rgba(255,255,255,0.05)' } }
      }
    }
  });
}

// ══════════════════════════════════════════════════════════════
// OBSERVAÇÕES E DICAS AUTOMÁTICAS (dentro da aba "Resumo")
// ══════════════════════════════════════════════════════════════
/**
 * Gera um resumo em texto + uma lista de observações a partir das
 * métricas já calculadas em calcularEExibir(). Cada observação tem um
 * `tipo` (alerta/atencao/positivo/info) usado só para escolher o ícone
 * e a cor da borda na UI. Também usada pelo modal de planejamento
 * (planejamentos.js).
 */
function gerarInsightsDashboard(m) {
  const itens = [];

  const percEssencial     = m.totalReceita > 0 ? (m.custoSobrevivencia   / m.totalReceita) * 100 : 0;
  const percEstiloVida    = m.totalReceita > 0 ? (m.estiloDeVida         / m.totalReceita) * 100 : 0;
  const percInvestimento  = m.totalReceita > 0 ? (m.aportesInvestimento  / m.totalReceita) * 100 : 0;
  const percDivida        = m.totalReceita > 0 ? (m.custoDivida          / m.totalReceita) * 100 : 0;

  if (m.totalTransacoes === 0) {
    itens.push({ tipo: 'info', texto: 'Nenhuma transação registrada neste período ainda.' });
    return { resumo: 'Sem lançamentos neste período.', itens };
  }

  // Saldo / taxa de poupança
  if (m.saldo < 0) {
    itens.push({ tipo: 'alerta', texto: `O cliente está gastando mais do que ganha neste período (saldo de ${formatCurrency(m.saldo)}). É prioridade entender a causa antes de qualquer outra recomendação.` });
  } else if (m.taxaPoupanca < 10) {
    itens.push({ tipo: 'atencao', texto: `A taxa de poupança está baixa (${m.taxaPoupanca.toFixed(1)}%). O ideal é conseguir guardar pelo menos 10% a 20% da renda.` });
  } else if (m.taxaPoupanca >= 20) {
    itens.push({ tipo: 'positivo', texto: `Ótima taxa de poupança (${m.taxaPoupanca.toFixed(1)}%)! O cliente está conseguindo guardar uma boa parte da renda.` });
  }

  // Custo essencial
  if (percEssencial > 50) {
    itens.push({ tipo: 'atencao', texto: `Os gastos essenciais consomem ${percEssencial.toFixed(1)}% da renda — acima da referência de até 50%. Vale revisar moradia, contas fixas e alimentação.` });
  }

  // Estilo de vida
  if (percEstiloVida > 30) {
    itens.push({ tipo: 'atencao', texto: `O estilo de vida representa ${percEstiloVida.toFixed(1)}% da renda. Se a meta é acelerar investimentos, esse é o grupo com mais espaço para cortes.` });
  }

  // Investimentos
  if (m.aportesInvestimento <= 0) {
    itens.push({ tipo: 'alerta', texto: 'Nenhum valor foi direcionado a investimentos ou reserva de emergência neste período. Esse deveria ser o primeiro ponto de conversa com o cliente.' });
  } else if (percInvestimento < 10) {
    itens.push({ tipo: 'atencao', texto: `Os aportes em investimentos representam apenas ${percInvestimento.toFixed(1)}% da renda. Buscar chegar a 10%-20% traria mais segurança financeira.` });
  } else {
    itens.push({ tipo: 'positivo', texto: `O cliente está direcionando ${percInvestimento.toFixed(1)}% da renda a investimentos — um bom hábito a reforçar.` });
  }

  // Dívidas
  if (m.custoDivida > 0) {
    itens.push({
      tipo: percDivida > 20 ? 'alerta' : 'atencao',
      texto: `${percDivida.toFixed(1)}% da renda está comprometida com dívidas/financiamentos.` +
             (percDivida > 20
               ? ' Esse comprometimento está alto — priorizar a quitação pode liberar bastante espaço no orçamento.'
               : ' Vale ficar de olho para que esse valor não cresça.')
    });
  }

  // Volume de dados
  if (m.totalTransacoes < 5) {
    itens.push({ tipo: 'info', texto: `Poucas transações registradas neste histórico (${m.totalTransacoes}). A análise fica mais precisa conforme o cliente for lançando mais dados.` });
  }

  const resumo = m.saldo >= 0
    ? `Neste período, o cliente recebeu ${formatCurrency(m.totalReceita)} e gastou ${formatCurrency(m.totalDespesa)}, ficando com um saldo positivo de ${formatCurrency(m.saldo)} (taxa de poupança de ${m.taxaPoupanca.toFixed(1)}%).`
    : `Neste período, o cliente recebeu ${formatCurrency(m.totalReceita)} e gastou ${formatCurrency(m.totalDespesa)}, resultando em um saldo negativo de ${formatCurrency(Math.abs(m.saldo))}.`;

  return { resumo, itens };
}

function renderInsightsDashboard(m) {
  const container = document.getElementById('insights-dashboard-lista');
  const resumoEl   = document.getElementById('insights-dashboard-resumo');
  if (!container || !resumoEl) return;

  const { resumo, itens } = gerarInsightsDashboard(m);
  resumoEl.textContent = resumo;

  const ICONE = { alerta: '🔴', atencao: '🟡', positivo: '🟢', info: 'ℹ️' };

  container.innerHTML = itens.length
    ? itens.map(item => `
        <div class="insight-item insight-item--${item.tipo}">
          <span class="insight-item__icone">${ICONE[item.tipo] || 'ℹ️'}</span>
          <span class="insight-item__texto">${item.texto}</span>
        </div>
      `).join('')
    : '<p class="empty-state">Sem observações específicas para este período.</p>';
}

// ══════════════════════════════════════════════════════════════
// ABAS DO MODAL "VER DASHBOARD" — Resumo / DRE / Balancete
// ══════════════════════════════════════════════════════════════

/**
 * Monta a DRE e o Balancete do cliente cujo dashboard acabou de abrir,
 * usando as mesmas transações já buscadas em abrirDashboard() — sem
 * nenhuma consulta extra ao banco (funções de contabilidade.js).
 */
function renderizarDREEBalanceteNoModal(transacoes, nomeCliente, periodoLabel = 'Todos os lançamentos') {

  if (typeof calcularDRE === 'function' && typeof renderDRE === 'function') {
    const dre = calcularDRE(transacoes);
    renderDRE(document.getElementById('dre-container'), dre, { clienteNome: nomeCliente, periodoLabel });
  }

  if (typeof calcularBalancete === 'function' && typeof renderBalancete === 'function') {
    const balancete = calcularBalancete(transacoes);
    renderBalancete(document.getElementById('balancete-container'), balancete, { clienteNome: nomeCliente, periodoLabel });
  }
}

function ativarAbaModalDashboard(nomeAba) {
  document.querySelectorAll('.modal-dashboard__tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === nomeAba);
  });
  document.querySelectorAll('.modal-dashboard__tab-content').forEach(c => {
    c.classList.toggle('active', c.id === `tab-${nomeAba}`);
  });
}

/**
 * Liga os cliques das abas (Resumo/DRE/Balancete) e dos botões de
 * exportar PDF / ampliar balancete — chamada uma única vez, dentro de
 * initDashboards().
 */
function initModalDashboardTabs() {
  document.querySelectorAll('.modal-dashboard__tab').forEach(tab => {
    tab.addEventListener('click', () => ativarAbaModalDashboard(tab.dataset.tab));
  });

  document.getElementById('btn-exportar-dre')?.addEventListener('click', () => {
    exportarParaPDF('dre-container', `DRE — ${dashboardContextoAtual.clienteNome} — ${dashboardContextoAtual.periodoLabel}`);
  });

  document.getElementById('btn-exportar-balancete')?.addEventListener('click', () => {
    exportarParaPDF('balancete-container', `Balancete de Verificação — ${dashboardContextoAtual.clienteNome} — ${dashboardContextoAtual.periodoLabel}`);
  });

  document.getElementById('btn-ampliar-balancete')?.addEventListener('click', () => {
    if (typeof abrirBalanceteAmpliado === 'function') abrirBalanceteAmpliado();
  });
}

console.log('✅ dashboards.js carregado (Resumo interativo + Insights + DRE + Balancete + filtro de período + busca)');
