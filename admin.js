/**
 * ADMIN.JS — LÓGICA CENTRAL DO PAINEL ADMIN
 * =====================================================
 * Expõe globals usados pelos sub-módulos:
 *   currentAdmin, allClientes, loadAllClientes,
 *   openModal, closeModal, showToast,
 *   formatCurrency, formatDate
 * Padrão: script global (sem import/export ES module).
 *
 * NOTA: este ficheiro só deve ser incluído em admin.html.
 * Foi adicionada uma guarda no final (verifica document.body
 * .app-body, classe exclusiva do admin.html) para que, mesmo que
 * alguém volte a incluir este script noutra página por engano,
 * ele não tente redirecionar/auto-executar e cause loops.
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

async function loadAllClientes() {
  if (!currentAdmin?.id) return;
  try {
    const { data, error } = await supabaseClient
      .from('clientes')
      .select('id, nome, email, cpf, telefone')
      .eq('admin_id', currentAdmin.id)
      .order('nome');

    if (error) throw error;

    // Muta o array compartilhado em vez de reatribuir
    allClientes.splice(0, allClientes.length, ...(data || []));
  } catch (err) {
    console.error('❌ loadAllClientes:', err.message);
  }
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

    // Verifica se é o admin autorizado
    if (user.email !== CONFIG.ADMIN.EMAIL) {
      showToast('Acesso não autorizado.', 'error');
      await supabaseClient.auth.signOut();
      window.location.href = 'index.html';
      return;
    }

    // Define admin global
    currentAdmin = { id: user.id, email: user.email, nome: user.email.split('@')[0] };

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
    if (typeof initClientes      === 'function') initClientes();
    if (typeof initCategorias    === 'function') initCategorias();
    if (typeof initDashboards    === 'function') initDashboards();
    if (typeof initMetas         === 'function') initMetas();
    if (typeof initPlanejamentos === 'function') initPlanejamentos();
    if (typeof initRazonete      === 'function') initRazonete();

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
