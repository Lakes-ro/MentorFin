/**
 * DASHBOARDS.JS — Módulo: Dashboards dos Clientes (admin.html)
 * Padrão: script global. Sem import/export.
 * Depende de: supabaseClient, allClientes, loadAllClientes,
 *             openModal, closeModal, showToast, formatCurrency
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
 */

let chartDonut = null;
let chartBar   = null;

// Contexto do dashboard atualmente aberto no modal — alimenta as abas
// DRE/Balancete, os botões "Exportar PDF" e o Balancete Ampliado
// (ver contabilidade.js) sem precisar reconsultar o banco.
let dashboardContextoAtual = { transacoes: [], clienteNome: '' };

function initDashboards() {
  window.addEventListener('section:change', ({ detail }) => {
    if (detail.section === 'dashboards') renderDashboards();
  });
  initModalDashboardTabs();
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
    return `
    <div class="card">
      <div class="card-header-row">
        <div>
          <p class="card-name">${c.nome}</p>
          <p class="card-sub">${c.email || 'Sem email'}</p>
        </div>
        <span class="risk-badge ${risco.classe}" title="Classificação de risco financeiro">${risco.emoji} ${risco.label}</span>
      </div>
      <div class="card-actions" style="margin-top:auto;">
        <button class="btn-card ver-dashboard" data-id="${c.id}" data-nome="${c.nome}">
          📊 Ver Dashboard
        </button>
      </div>
    </div>
  `;
  }).join('');

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
  // ⚠️ "kpi-dividas" incluído aqui — antes ficava de fora desta lista e
  // o valor do CLIENTE ANTERIOR continuava visível enquanto os outros
  // 4 KPIs já mostravam "..." esperando a busca nova terminar, dando a
  // falsa impressão de dado incorreto/tela travada ao trocar de cliente.
  ['kpi-sobrevivencia','kpi-estilo','kpi-investimentos','kpi-dividas','kpi-poupanca'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '...';
  });

  const resumoEl = document.getElementById('insights-dashboard-resumo');
  const listaEl  = document.getElementById('insights-dashboard-lista');
  if (resumoEl) resumoEl.textContent = '';
  if (listaEl)  listaEl.innerHTML = '<p class="empty-state">Carregando...</p>';

  // Sempre volta pra aba "Resumo" ao abrir um novo cliente, e limpa o
  // conteúdo anterior de DRE/Balancete (evita mostrar por um instante
  // os números do cliente anterior enquanto a consulta nova carrega).
  ativarAbaModalDashboard('resumo');
  document.getElementById('dre-container').innerHTML = '<p class="empty-state">Carregando...</p>';
  document.getElementById('balancete-container').innerHTML = '<p class="empty-state">Carregando...</p>';

  openModal('modal-dashboard');

  if (chartDonut) { chartDonut.destroy(); chartDonut = null; }
  if (chartBar)   { chartBar.destroy();   chartBar   = null; }

  const { data: transacoes, error } = await supabaseClient
    .from('transacoes')
    .select('valor, tipo, descricao, data_competencia, categorias(nome, grupo)')
    .eq('client_id', clienteId)
    .order('data_competencia', { ascending: false });

  if (error) { showToast('Erro ao carregar dados: ' + error.message, 'error'); return; }

  dashboardContextoAtual = { transacoes: transacoes || [], clienteNome: nome };

  calcularEExibir(transacoes || []);
  renderizarDREEBalanceteNoModal(transacoes || [], nome);
}

function calcularEExibir(transacoes) {
  // Transferências internas (grupo 'transferencia') não são receita
  // nem despesa de verdade — dinheiro só mudou de lugar. Filtradas
  // FORA antes de qualquer cálculo, para não inflar nem distorcer
  // nenhuma métrica abaixo (mesma regra do dashboard.js do cliente).
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
  const taxaPoupanca  = totalReceita > 0 ? Math.max(0, (saldo / totalReceita) * 100) : 0;

  document.getElementById('kpi-sobrevivencia').textContent  = formatCurrency(custoSobrevivencia);
  document.getElementById('kpi-estilo').textContent         = formatCurrency(estiloDeVida);
  document.getElementById('kpi-investimentos').textContent  = formatCurrency(aportesInvestimento);
  document.getElementById('kpi-dividas').textContent         = formatCurrency(custoDivida);
  document.getElementById('kpi-poupanca').textContent       = taxaPoupanca.toFixed(1) + '%';

  renderDonut(custoSobrevivencia, estiloDeVida, aportesInvestimento);

  const categoriaMap = {};
  despesas.forEach(t => {
    const cat = t.categorias?.nome || 'Sem Categoria';
    categoriaMap[cat] = (categoriaMap[cat] || 0) + Math.abs(t.valor);
  });
  const topCats = Object.entries(categoriaMap).sort((a, b) => b[1] - a[1]).slice(0, 8);
  renderBarChart(topCats);

  renderAnalise(totalReceita, totalDespesa, custoSobrevivencia, estiloDeVida, aportesInvestimento, custoDivida, semTransferencias.length);

  renderInsightsDashboard({
    totalReceita, totalDespesa, custoSobrevivencia, estiloDeVida,
    aportesInvestimento, custoDivida, saldo,
    taxaPoupanca: totalReceita > 0 ? (saldo / totalReceita) * 100 : 0,
    totalTransacoes: semTransferencias.length
  });
}

function renderDonut(essencial, estiloVida, investimento) {
  const ctx = document.getElementById('chart-donut');
  if (!ctx) return;
  chartDonut = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Essencial', 'Estilo de Vida', 'Investimentos'],
      datasets: [{ data: [essencial || 0.001, estiloVida || 0.001, investimento || 0.001],
        backgroundColor: ['#ff6384', '#f5d623', '#00f5a0'], borderWidth: 0, hoverOffset: 6 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '65%',
      plugins: {
        legend: { position: 'bottom', labels: { color: '#6b9e84', font: { size: 11 }, padding: 12, usePointStyle: true } },
        tooltip: { callbacks: { label: ctx => ` ${formatCurrency(ctx.parsed)}` } }
      }
    }
  });
}

function renderBarChart(topCats) {
  const ctx = document.getElementById('chart-bar');
  if (!ctx) return;
  chartBar = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: topCats.map(([cat]) => cat),
      datasets: [{ label: 'Valor (R$)', data: topCats.map(([,val]) => val),
        backgroundColor: '#4263eb', borderRadius: 4, borderSkipped: false }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#6b9e84', font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => ` ${formatCurrency(ctx.parsed.x)}` } }
      },
      scales: {
        x: { ticks: { color: '#3d6352', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { ticks: { color: '#6b9e84', font: { size: 11 } }, grid: { display: false } }
      }
    }
  });
}

function renderAnalise(totalReceita, totalDespesa, custoSobrevivencia, estiloDeVida, aportesInvestimento, custoDivida, totalTransacoes) {
  const grid = document.getElementById('analise-grid');
  if (!grid) return;
  const saldo        = totalReceita - totalDespesa;
  const taxaEconomia = totalReceita > 0 ? ((saldo / totalReceita) * 100).toFixed(1) : 0;

  const items = [
    { label: 'Renda Total',       value: formatCurrency(totalReceita),        color: '#00f5a0' },
    { label: 'Custo Essencial',   value: formatCurrency(custoSobrevivencia),  color: '#f5d623' },
    { label: 'Estilo de Vida',    value: formatCurrency(estiloDeVida),        color: '#ff6384' },
    { label: 'Investimentos',     value: formatCurrency(aportesInvestimento), color: '#00f5a0' },
    { label: 'Dívidas',           value: formatCurrency(custoDivida),         color: '#ff9f40' },
    { label: 'Despesa Total',     value: formatCurrency(totalDespesa),        color: '#ff4d6d' },
    { label: 'Saldo',             value: formatCurrency(saldo),               color: saldo >= 0 ? '#00f5a0' : '#ff4d6d' },
    { label: 'Taxa de Poupança',  value: taxaEconomia + '%',                  color: '#7b96ff' },
    { label: 'Transações',        value: totalTransacoes,                     color: '#6b9e84' },
  ];

  grid.innerHTML = items.map(item => `
    <div class="analise-item">
      <span class="analise-item-label">${item.label}</span>
      <span class="analise-item-value" style="color:${item.color}">${item.value}</span>
    </div>
  `).join('');
}

// ══════════════════════════════════════════════════════════════
// OBSERVAÇÕES E DICAS AUTOMÁTICAS (dentro da aba "Resumo")
// ══════════════════════════════════════════════════════════════
/**
 * Gera um resumo em texto + uma lista de observações a partir das
 * métricas já calculadas em calcularEExibir(). Cada observação tem um
 * `tipo` (alerta/atencao/positivo/info) usado só para escolher o ícone
 * e a cor da borda na UI — nenhum julgamento é feito além do que os
 * próprios números já mostram.
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
 * nenhuma consulta extra ao banco. As funções calcularDRE/renderDRE/
 * calcularBalancete/renderBalancete vêm de contabilidade.js.
 */
function renderizarDREEBalanceteNoModal(transacoes, nomeCliente) {
  const periodoLabel = 'Todos os lançamentos';

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
 * initDashboards(), porque os elementos do modal são estáticos no
 * HTML (não são recriados a cada abertura, só o CONTEÚDO interno é
 * regenerado por abrirDashboard()).
 */
function initModalDashboardTabs() {
  document.querySelectorAll('.modal-dashboard__tab').forEach(tab => {
    tab.addEventListener('click', () => ativarAbaModalDashboard(tab.dataset.tab));
  });

  document.getElementById('btn-exportar-dre')?.addEventListener('click', () => {
    exportarParaPDF('dre-container', `DRE — ${dashboardContextoAtual.clienteNome}`);
  });

  document.getElementById('btn-exportar-balancete')?.addEventListener('click', () => {
    exportarParaPDF('balancete-container', `Balancete de Verificação — ${dashboardContextoAtual.clienteNome}`);
  });

  document.getElementById('btn-ampliar-balancete')?.addEventListener('click', () => {
    if (typeof abrirBalanceteAmpliado === 'function') abrirBalanceteAmpliado();
  });
}

console.log('✅ dashboards.js carregado (Resumo + Insights + DRE + Balancete + fix KPI dívidas)');
