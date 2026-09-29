/**
 * ADMIN.JS — LÓGICA CENTRAL DO PAINEL ADMIN
 * =====================================================
 * Expõe globals usados pelos sub-módulos:
 *   currentAdmin, allClientes, loadAllClientes, nomeExibicaoCliente,
 *   openModal, closeModal, showToast,
 *   formatCurrency, formatDate
 * Padrão: script global (sem import/export ES module).
 *
 * NOTA: este ficheiro só deve ser incluído em admin.html.
 * Foi adicionada uma guarda no final (verifica document.body
 * .app-body, classe exclusiva do admin.html) para que, mesmo que
 * alguém volte a incluir este script noutra página por engano,
 * ele não tente redirecionar/auto-executar e cause loops.
 *
 * ATUALIZAÇÃO — APELIDOS, PAPEL E MÓDULOS ESQUECIDOS:
 * - loadAllClientes() lê a view `clients_admin_view` (clientes +
 *   apelido). Cada cliente ganha `nomeCompleto`, `apelido` e `nome`
 *   = rótulo de exibição ("Apelido (Nome Completo)"), para que todas
 *   as telas que já usam `c.nome` passem a mostrar o apelido sem
 *   precisar mexer em cada uma.
 * - O acesso ao painel é decidido pelo perfil 'admin' em
 *   usuarios_perfis (banco), não mais pelo e-mail no código.
 * - initNotificacoesAdmin() e initMensagensAdmin() existiam mas nunca
 *   eram chamadas — o sino e o envio de mensagens não funcionavam.
 */

// ── Estado compartilhado ──────────────────────────────────────
let currentAdmin = null;   // { id, email, nome }
let allClientes  = [];     // cache dos clientes do admin

// ── Helpers globais ───────────────────────────────────────────

function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

/**
 * ⚠️ CORREÇÃO — TOAST ILEGÍVEL POR TRÁS DO MODAL DE IMPORTAÇÃO:
 * o .toast ficava em z-index 9999, ABAIXO de .modal-overlay (10050).
 * Com o modal de importação aberto, a mensagem que explica qual linha
 * está impedindo a gravação era pintada atrás do pop-up. O z-index foi
 * corrigido no admin.css; aqui o erro passa a ficar 9s na tela (a
 * mensagem de impedimento é longa e precisa ser lida por inteiro) e
 * pode ser fechado no clique.
 */
function showToast(msg, type = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) return;

  toast.textContent = msg;
  toast.className   = `toast ${type}`;
  toast.classList.remove('hidden');
  toast.title = 'Clique para fechar';

  if (!toast._fecharLigado) {
    toast.addEventListener('click', () => toast.classList.add('hidden'));
    toast._fecharLigado = true;
  }

  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.add('hidden'), type === 'error' ? 9000 : 3000);
}

function formatCurrency(val) {
  const n = parseFloat(val) || 0;
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + (dateStr.length === 10 ? 'T00:00:00' : ''));
  return d.toLocaleDateString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric'
  });
}

/**
 * Rótulo do cliente em listas, selects e títulos:
 * "Apelido (Nome Completo)" — ou só o nome, quando não há apelido ou
 * ele é igual ao nome.
 */
function nomeExibicaoCliente(nomeCompleto, apelido) {
  const nome = (nomeCompleto || '').trim();
  const apel = (apelido || '').trim();
  if (!apel || apel.toLowerCase() === nome.toLowerCase()) return nome || apel || 'Cliente';
  return nome ? `${apel} (${nome})` : apel;
}

async function loadAllClientes() {
  if (!currentAdmin?.id) return;
  try {
    const { data, error } = await supabaseClient
      .from('clients_admin_view')
      .select('id, nome, apelido, email, cpf, telefone, risco_atual')
      .eq('admin_id', currentAdmin.id)
      .order('nome');

    if (error) throw error;

    const clientes = (data || []).map(c => ({
      ...c,
      nomeCompleto: c.nome,
      nome:         nomeExibicaoCliente(c.nome, c.apelido)
    }));

    // Muta o array compartilhado em vez de reatribuir
    allClientes.splice(0, allClientes.length, ...clientes);
  } catch (err) {
    console.error('❌ loadAllClientes:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════
// BUSCA DE CLIENTES (seções Clientes e Dashboards)
// ══════════════════════════════════════════════════════════════
// Cada card de cliente leva um atributo `data-busca` com apelido,
// nome, e-mail, telefone e CPF já normalizados (sem acento, minúsculo,
// com a versão só-dígitos do telefone/CPF). A busca só esconde/mostra
// cards já renderizados — nenhuma consulta nova ao banco.

function normalizarBusca(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Texto pesquisável de um cliente — vai no atributo data-busca do card. */
function textoBuscaCliente(c) {
  const digitos = `${c.telefone || ''} ${c.cpf || ''}`.replace(/\D/g, '');
  return escaparHtml(normalizarBusca(
    [c.apelido, c.nomeCompleto, c.email, c.telefone, c.cpf, digitos].filter(Boolean).join(' ')
  ));
}

/**
 * Aplica o termo atual do campo de busca na grade: todas as palavras
 * digitadas precisam aparecer (em qualquer ordem). Mostra "x de y" no
 * contador e um aviso quando nada bate.
 */
function aplicarBuscaClientes(inputId, gridId, contadorId) {
  const grid = document.getElementById(gridId);
  if (!grid) return;

  const termo   = normalizarBusca(document.getElementById(inputId)?.value);
  const palavras = termo.split(/\s+/).filter(Boolean);
  const termoDigitos = termo.replace(/\D/g, '');
  const cards   = [...grid.querySelectorAll('[data-busca]')];

  let visiveis = 0;
  cards.forEach(card => {
    const alvo = card.dataset.busca || '';
    const bate = !palavras.length
      || palavras.every(p => alvo.includes(p))
      || (termoDigitos.length >= 3 && alvo.includes(termoDigitos));
    card.classList.toggle('hidden', !bate);
    if (bate) visiveis++;
  });

  let aviso = grid.querySelector('.busca-sem-resultado');
  if (palavras.length && !visiveis && cards.length) {
    if (!aviso) {
      aviso = document.createElement('p');
      aviso.className = 'empty-state busca-sem-resultado';
      grid.appendChild(aviso);
    }
    aviso.textContent = `Nenhum cliente encontrado para "${document.getElementById(inputId).value.trim()}".`;
  } else {
    aviso?.remove();
  }

  const contador = document.getElementById(contadorId);
  if (contador) {
    contador.textContent = palavras.length && cards.length
      ? `${visiveis} de ${cards.length} cliente(s)`
      : '';
  }
}

/** Liga o campo de busca (digitar filtra na hora; Esc limpa). */
function ligarBuscaClientes(inputId, gridId, contadorId) {
  const input = document.getElementById(inputId);
  if (!input || input._buscaLigada) return;
  input._buscaLigada = true;

  input.addEventListener('input', () => aplicarBuscaClientes(inputId, gridId, contadorId));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      aplicarBuscaClientes(inputId, gridId, contadorId);
    }
  });
}

// ── Fechar modais ao clicar no overlay ou no botão ✕ ─────────
document.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('[data-modal]');
  if (closeBtn) {
    closeModal(closeBtn.dataset.modal);
    return;
  }
  if (e.target.classList.contains('modal-overlay')) {
    closeModal(e.target.id);
  }
});

// ══════════════════════════════════════════════════════════════
// MÓDULO ADMIN — Navegação e inicialização do SPA
// ══════════════════════════════════════════════════════════════

const AdminModule = (() => {

  // ── Navegação entre secções ─────────────────────────────────
  function initNavigation() {
    document.querySelectorAll('.nav-item[data-section]').forEach(btn => {
      btn.addEventListener('click', () => {
        const section = btn.dataset.section;

        document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
        const target = document.getElementById(`section-${section}`);
        if (target) target.classList.add('active');

        window.dispatchEvent(new CustomEvent('section:change', { detail: { section } }));
      });
    });
  }

  // ── Logout ──────────────────────────────────────────────────
  function initLogout() {
    const btn = document.getElementById('btn-sair');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!confirm('Deseja sair?')) return;
      await supabaseClient.auth.signOut();
      window.location.href = 'index.html';
    });
  }

  // ── Papel: decidido pelo banco (usuarios_perfis) ────────────
  async function isAdmin(userId) {
    const { data, error } = await supabaseClient
      .from('usuarios_perfis')
      .select('perfil')
      .eq('usuario_id', userId)
      .eq('perfil', 'admin')
      .maybeSingle();
    return !error && !!data;
  }

  async function carregarNomeAdmin(userId) {
    try {
      const { data } = await supabaseClient
        .from('usuarios')
        .select('nome_completo, apelido')
        .eq('id', userId)
        .maybeSingle();
      return data?.apelido || data?.nome_completo || 'Administrador';
    } catch (_) {
      return 'Administrador';
    }
  }

  // ── Inicialização ────────────────────────────────────────────
  async function init() {
    // Aguarda Supabase
    let tries = 0;
    while (!supabaseClient && tries++ < 20) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (!supabaseClient) {
      console.error('❌ Supabase não disponível');
      return;
    }

    // Verifica sessão (agora persistida — ver config.js)
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) {
      window.location.href = 'index.html';
      return;
    }

    const user = session.user;

    if (!(await isAdmin(user.id))) {
      showToast('Acesso não autorizado.', 'error');
      await supabaseClient.auth.signOut();
      window.location.href = 'index.html';
      return;
    }

    // Define admin global — nome vem de `usuarios`, nunca do e-mail
    currentAdmin = { id: user.id, email: user.email, nome: await carregarNomeAdmin(user.id) };

    // Preenche header
    const subtitle = document.getElementById('admin-subtitle');
    if (subtitle) subtitle.textContent = `Bem-vindo, ${currentAdmin.nome}`;

    // Preenche perfil
    const pfNome  = document.getElementById('perfil-nome');
    const pfEmail = document.getElementById('perfil-email');
    if (pfNome)  pfNome.textContent  = currentAdmin.nome;
    if (pfEmail) pfEmail.textContent = currentAdmin.email;

    // Pré-carrega clientes
    await loadAllClientes();

    // Inicia navegação e logout
    initNavigation();
    initLogout();

    // Modo privacidade PRIMEIRO: se estiver ligado no localStorage, o
    // blur já precisa estar valendo quando as grades renderizarem —
    // senão os nomes aparecem por uma fração de segundo antes de sumir.
    if (typeof initPrivacidade   === 'function') initPrivacidade();

    // Inicia sub-módulos (definidos nos outros scripts)
    if (typeof initClientes          === 'function') initClientes();
    if (typeof initCategorias        === 'function') initCategorias();
    if (typeof initDashboards        === 'function') initDashboards();
    if (typeof initMetas             === 'function') initMetas();
    if (typeof initPlanejamentos     === 'function') initPlanejamentos();
    if (typeof initRazonete          === 'function') initRazonete();
    if (typeof initMensagensAdmin    === 'function') initMensagensAdmin();
    if (typeof initNotificacoesAdmin === 'function') initNotificacoesAdmin();

    console.log('✅ Admin inicializado:', currentAdmin.email);
  }

  return { init };
})();

// ── Arranca apenas dentro de admin.html ──────────────────────
// Guarda: admin.html é a única página com <body class="app-body">.
// Se este script acabar incluído noutra página por engano, ele
// simplesmente não faz nada, em vez de redirecionar em loop.
function bootAdminModuleIfOnAdminPage() {
  if (document.body.classList.contains('app-body')) {
    AdminModule.init();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootAdminModuleIfOnAdminPage);
} else {
  bootAdminModuleIfOnAdminPage();
}

console.log('✅ admin.js carregado');
