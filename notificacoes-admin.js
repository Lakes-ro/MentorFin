/**
 * NOTIFICACOES-ADMIN.JS — Central de Notificações do Admin
 * ================================================
 * Padrão: script global. Sem import/export.
 * Depende de: supabaseClient, currentAdmin, allClientes,
 *             loadAllClientes, showToast (admin.js) — carregado
 *             DEPOIS de admin.js. Depende também de abrirDashboard()
 *             (dashboards.js) pra abrir direto o dashboard do cliente
 *             quando a notificação é de risco.
 *
 * O QUE NOTIFICA (gerado automaticamente pelo BANCO via triggers —
 * ver MIGRACAO-notificacoes-admin.sql, que precisa ser rodada uma
 * vez no Supabase antes deste módulo funcionar):
 *   1. 👋 Novo cliente cadastrado
 *   2. 🏷️ Cliente criou uma categoria própria (pendente de revisão)
 *   3. 🟡/🔴 Risco financeiro de um cliente MUDOU pra amarelo/vermelho
 *   4. 💬 Cliente mandou uma mensagem pelo app (ver
 *      MIGRACAO-notificacoes-admin.sql + mensagens-admin.js) — clicar
 *      nesta notificação abre direto o modal de conversa com aquele
 *      cliente, sem navegar para nenhuma seção.
 *
 * COMO FUNCIONA:
 *   - Ao iniciar, busca as últimas 50 notificações do admin logado.
 *   - Assina o Realtime do Supabase na tabela `notificacoes_admin`
 *     filtrada por admin_id — quando o BANCO insere uma notificação
 *     nova (via trigger, mesmo com o admin fora do app no momento em
 *     que o evento aconteceu), ela aparece na hora que o admin estiver
 *     com a tela aberta, com toast + badge atualizando sozinho, sem
 *     precisar dar F5.
 *   - Clicar numa notificação marca ela como lida e navega pra seção
 *     relevante (Clientes / Categorias / Dashboards — já abrindo o
 *     dashboard do cliente certo quando for notificação de risco).
 *   - "Marcar todas como lidas" zera o badge de uma vez.
 */

let notifPainelAberto = false;
let notifCache        = [];

const NOTIF_ICONE = {
  novo_cliente:   '👋',
  nova_categoria: '🏷️',
  risco_amarelo:  '🟡',
  risco_vermelho: '🔴',
  nova_mensagem:  '💬'
};

function initNotificacoesAdmin() {
  document.getElementById('btn-notificacoes')?.addEventListener('click', toggleNotifPainel);
  document.getElementById('btn-marcar-todas-lidas')?.addEventListener('click', marcarTodasComoLidas);

  // Fecha o painel ao clicar fora dele
  document.addEventListener('click', (e) => {
    const wrapper = document.querySelector('.notif-bell-wrapper');
    if (notifPainelAberto && wrapper && !wrapper.contains(e.target)) {
      fecharNotifPainel();
    }
  });

  carregarNotificacoes();
  ligarRealtimeNotificacoes();
}

async function carregarNotificacoes() {
  if (!currentAdmin?.id) return;

  const { data, error } = await supabaseClient
    .from('notificacoes_admin')
    .select('id, tipo, titulo, mensagem, client_id, lida, created_at')
    .eq('admin_id', currentAdmin.id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    // Se a tabela ainda não existir (migração não rodada), falha em
    // silêncio no console em vez de quebrar o resto do painel admin.
    console.warn('⚠️ carregarNotificacoes:', error.message);
    return;
  }

  notifCache = data || [];
  renderNotifLista();
  atualizarBadge();
}

function atualizarBadge() {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  const naoLidas = notifCache.filter(n => !n.lida).length;

  if (naoLidas > 0) {
    badge.textContent = naoLidas > 99 ? '99+' : String(naoLidas);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function formatarTempoRelativo(dataStr) {
  const agora   = new Date();
  const data    = new Date(dataStr);
  const diffMin = Math.floor((agora - data) / 60000);

  if (diffMin < 1)  return 'agora mesmo';
  if (diffMin < 60) return `há ${diffMin} min`;

  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `há ${diffH}h`;

  const diffDias = Math.floor(diffH / 24);
  if (diffDias < 7) return `há ${diffDias}d`;

  return data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function escaparHtmlNotif(texto) {
  return (texto || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderNotifLista() {
  const lista = document.getElementById('notif-lista');
  if (!lista) return;

  if (!notifCache.length) {
    lista.innerHTML = '<p class="empty-state">Nenhuma notificação ainda.</p>';
    return;
  }

  lista.innerHTML = notifCache.map(n => `
    <div class="notif-item ${n.lida ? '' : 'notif-item--nao-lida'}"
         data-id="${n.id}" data-client-id="${n.client_id || ''}" data-tipo="${n.tipo}">
      <span class="notif-item__icone">${NOTIF_ICONE[n.tipo] || '🔔'}</span>
      <div class="notif-item__corpo">
        <p class="notif-item__titulo">${escaparHtmlNotif(n.titulo)}</p>
        <p class="notif-item__mensagem">${escaparHtmlNotif(n.mensagem)}</p>
        <p class="notif-item__tempo">${formatarTempoRelativo(n.created_at)}</p>
      </div>
      ${!n.lida ? '<span class="notif-item__ponto" title="Não lida"></span>' : ''}
    </div>
  `).join('');

  lista.querySelectorAll('.notif-item').forEach(el => {
    el.addEventListener('click', () => {
      handleClickNotificacao(el.dataset.id, el.dataset.clientId || null, el.dataset.tipo);
    });
  });
}

async function handleClickNotificacao(id, clientId, tipo) {
  await marcarComoLida(id);
  fecharNotifPainel();

  // Mensagem nova -> abre direto a conversa (é um modal, não uma seção)
  if (tipo === 'nova_mensagem' && clientId) {
    if (!allClientes.length) await loadAllClientes();
    const cliente = allClientes.find(c => c.id === clientId);
    if (cliente && typeof abrirModalMensagensCliente === 'function') {
      abrirModalMensagensCliente(cliente.id, cliente.nome);
    }
    return;
  }

  const secaoAlvo = tipo === 'novo_cliente'   ? 'clientes'
                   : tipo === 'nova_categoria' ? 'categorias'
                   : 'dashboards'; // risco_amarelo / risco_vermelho

  document.querySelector(`.nav-item[data-section="${secaoAlvo}"]`)?.click();

  // Notificação de risco + temos o cliente -> abre o dashboard dele direto
  if ((tipo === 'risco_amarelo' || tipo === 'risco_vermelho') && clientId) {
    if (!allClientes.length) await loadAllClientes();
    const cliente = allClientes.find(c => c.id === clientId);
    if (cliente && typeof abrirDashboard === 'function') {
      setTimeout(() => abrirDashboard(cliente.id, cliente.nome), 150);
    }
  }
}

async function marcarComoLida(id) {
  const item = notifCache.find(n => n.id === id);
  if (!item || item.lida) return;

  item.lida = true; // otimista — atualiza a UI antes da confirmação do servidor
  renderNotifLista();
  atualizarBadge();

  const { error } = await supabaseClient
    .from('notificacoes_admin')
    .update({ lida: true })
    .eq('id', id);

  if (error) console.error('❌ marcarComoLida:', error.message);
}

async function marcarTodasComoLidas() {
  const idsNaoLidas = notifCache.filter(n => !n.lida).map(n => n.id);
  if (!idsNaoLidas.length) return;

  notifCache.forEach(n => { n.lida = true; });
  renderNotifLista();
  atualizarBadge();

  const { error } = await supabaseClient
    .from('notificacoes_admin')
    .update({ lida: true })
    .in('id', idsNaoLidas);

  if (error) {
    console.error('❌ marcarTodasComoLidas:', error.message);
    showToast('Erro ao marcar notificações como lidas.', 'error');
  }
}

function toggleNotifPainel() {
  notifPainelAberto ? fecharNotifPainel() : abrirNotifPainel();
}

function abrirNotifPainel() {
  document.getElementById('notif-painel')?.classList.remove('hidden');
  notifPainelAberto = true;
}

function fecharNotifPainel() {
  document.getElementById('notif-painel')?.classList.add('hidden');
  notifPainelAberto = false;
}

// ══════════════════════════════════════════════════════════════
// REALTIME — notificações novas aparecem na hora, sem precisar de F5
// ══════════════════════════════════════════════════════════════
function ligarRealtimeNotificacoes() {
  if (!currentAdmin?.id) return;

  supabaseClient
    .channel('notificacoes-admin-realtime')
    .on('postgres_changes', {
      event:  'INSERT',
      schema: 'public',
      table:  'notificacoes_admin',
      filter: `admin_id=eq.${currentAdmin.id}`
    }, (payload) => {
      const nova = payload.new;
      notifCache.unshift(nova);
      renderNotifLista();
      atualizarBadge();
      showToast(`${NOTIF_ICONE[nova.tipo] || '🔔'} ${nova.titulo}`, nova.tipo === 'risco_vermelho' ? 'error' : 'success');
    })
    .subscribe();
}

console.log('✅ notificacoes-admin.js carregado');