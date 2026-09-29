/**
 * MENSAGENS-ADMIN.JS — Conversa com o Cliente (admin.html)
 * ================================================
 * Padrão: script global. Sem import/export.
 * Depende de: supabaseClient, currentAdmin, allClientes, loadAllClientes,
 *             openModal, closeModal, showToast (admin.js),
 *             escaparHtml (seguranca.js).
 *
 * Aberto pelo botão "💬 Mensagens" em qualquer card de cliente
 * (clientes.js). Diferente do modal "💬 Comentários": comentários são
 * notas PRIVADAS do admin sobre o cliente; mensagens são uma conversa
 * de mão dupla que o cliente vê e responde no próprio painel dele.
 *
 * ATUALIZAÇÃO:
 * - initMensagensAdmin() agora só liga os eventos UMA vez. Ele era
 *   chamado tanto por este arquivo quanto por admin.js, o que faria
 *   cada Enter/clique enviar a mensagem duas vezes.
 * - Conversa em tempo real: mensagem nova do cliente aparece na hora
 *   se o modal estiver aberto, e aumenta o selo do card se não estiver.
 * - Mensagens separadas por dia ("Hoje", "Ontem", data) e marca "✓ Lida"
 *   nas respostas do admin que o cliente já viu.
 */

let mensagensAdminClienteId  = null;
let mensagensAdminIniciado   = false;
let mensagensAdminCanal      = null;

function initMensagensAdmin() {
    if (mensagensAdminIniciado) return;
    mensagensAdminIniciado = true;

    document.getElementById('btn-enviar-mensagem-admin')
        ?.addEventListener('click', handleEnviarMensagemAdmin);

    document.getElementById('mensagem-admin-texto')
        ?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleEnviarMensagemAdmin();
            }
        });

    ligarRealtimeMensagensAdmin();
}

function formatarHoraMensagemAdmin(dataStr) {
    try {
        return new Date(dataStr).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    } catch (_) { return ''; }
}

/** "Hoje", "Ontem" ou "dd/mm/aaaa" — rótulo do separador de dia. */
function rotuloDiaMensagem(dataStr) {
    const d     = new Date(dataStr);
    const hoje  = new Date();
    const ontem = new Date(); ontem.setDate(hoje.getDate() - 1);
    const mesmoDia = (a, b) => a.toDateString() === b.toDateString();
    if (mesmoDia(d, hoje))  return 'Hoje';
    if (mesmoDia(d, ontem)) return 'Ontem';
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

async function abrirModalMensagensCliente(clienteId, nome) {
    mensagensAdminClienteId = clienteId;

    document.getElementById('modal-mensagens-cliente-title').textContent = `💬 Mensagens — ${nome}`;
    document.getElementById('mensagem-admin-texto').value = '';

    openModal('modal-mensagens-cliente');
    await carregarConversaAdmin(clienteId);
    await marcarMensagensClienteComoLidas(clienteId);
    document.getElementById('mensagem-admin-texto')?.focus();
}

async function carregarConversaAdmin(clienteId) {
    const lista = document.getElementById('mensagens-admin-lista');
    if (!lista) return;
    if (!lista.children.length || lista.querySelector('.empty-state')) {
        lista.innerHTML = '<p class="empty-state">Carregando conversa...</p>';
    }

    const { data, error } = await supabaseClient
        .from('mensagens_cliente')
        .select('id, remetente, texto, lida, created_at')
        .eq('client_id', clienteId)
        .order('created_at', { ascending: true });

    if (error) {
        lista.innerHTML = `<p class="empty-state">Erro ao carregar mensagens: ${escaparHtml(error.message)}</p>`;
        console.error('❌ carregarConversaAdmin:', error.message);
        return;
    }

    if (!data?.length) {
        lista.innerHTML = '<p class="empty-state">Nenhuma mensagem ainda. Escreva abaixo para puxar a conversa com este cliente.</p>';
        return;
    }

    let diaAnterior = '';
    lista.innerHTML = data.map(m => {
        const dia = rotuloDiaMensagem(m.created_at);
        const separador = dia !== diaAnterior ? `<div class="mensagem-dia">${dia}</div>` : '';
        diaAnterior = dia;
        const lida = m.remetente === 'admin' && m.lida ? ' · ✓ Lida' : '';
        return `${separador}
        <div class="mensagem-admin-bolha mensagem-admin-bolha--${m.remetente}">
            <p class="mensagem-admin-bolha__texto">${escaparHtml(m.texto)}</p>
            <span class="mensagem-admin-bolha__hora">${formatarHoraMensagemAdmin(m.created_at)}${lida}</span>
        </div>`;
    }).join('');

    lista.scrollTop = lista.scrollHeight;
}

async function marcarMensagensClienteComoLidas(clienteId) {
    try {
        await supabaseClient
            .from('mensagens_cliente')
            .update({ lida: true })
            .eq('client_id', clienteId)
            .eq('remetente', 'cliente')
            .eq('lida', false);

        // Zera o selo no card assim que a conversa é aberta/lida.
        const badge = document.querySelector(`.mensagens-nao-lidas[data-client-id="${clienteId}"]`);
        if (badge) { badge.textContent = '0'; badge.classList.add('hidden'); }
    } catch (err) {
        console.warn('⚠️ marcarMensagensClienteComoLidas:', err.message);
    }
}

async function handleEnviarMensagemAdmin() {
    if (!mensagensAdminClienteId) return;

    const campo = document.getElementById('mensagem-admin-texto');
    const texto = campo?.value.trim();
    if (!texto) return;

    const btn = document.getElementById('btn-enviar-mensagem-admin');
    if (btn?.disabled) return; // evita duplo envio enquanto o anterior não terminou
    if (btn) { btn.disabled = true; btn.textContent = 'Enviando...'; }

    try {
        const { error } = await supabaseClient
            .from('mensagens_cliente')
            .insert({ client_id: mensagensAdminClienteId, remetente: 'admin', texto });

        if (error) throw error;

        campo.value = '';
        await carregarConversaAdmin(mensagensAdminClienteId);
    } catch (err) {
        showToast('Erro ao enviar mensagem: ' + err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Enviar'; }
        campo?.focus();
    }
}

/**
 * Tempo real: mensagem nova de um cliente.
 * - Se a conversa DESSE cliente está aberta → recarrega e marca como lida.
 * - Senão → soma 1 no selo "💬 Mensagens" do card dele.
 * O sino (notificacoes-admin.js) avisa por conta própria.
 */
function ligarRealtimeMensagensAdmin() {
    if (mensagensAdminCanal || typeof supabaseClient === 'undefined' || !supabaseClient) return;

    mensagensAdminCanal = supabaseClient
        .channel('mensagens-admin-realtime')
        .on('postgres_changes', {
            event:  'INSERT',
            schema: 'public',
            table:  'mensagens_cliente'
        }, async (payload) => {
            const nova = payload.new;
            if (!nova || nova.remetente !== 'cliente') return;

            const modalAberto = !document.getElementById('modal-mensagens-cliente')?.classList.contains('hidden');
            if (modalAberto && nova.client_id === mensagensAdminClienteId) {
                await carregarConversaAdmin(nova.client_id);
                await marcarMensagensClienteComoLidas(nova.client_id);
                return;
            }

            const badge = document.querySelector(`.mensagens-nao-lidas[data-client-id="${nova.client_id}"]`);
            if (badge) {
                badge.textContent = String((parseInt(badge.textContent, 10) || 0) + 1);
                badge.classList.remove('hidden');
            }
        })
        .subscribe();
}

/**
 * Conta quantas mensagens de CADA cliente (na lista fornecida) ainda
 * não foram lidas pelo admin, e devolve um mapa { clienteId: contagem }
 * — usado por clientes.js para exibir o selo no botão "💬 Mensagens"
 * de cada card, numa ÚNICA consulta (em vez de uma por cliente).
 */
async function contarMensagensNaoLidasPorCliente(clienteIds) {
    const mapa = {};
    if (!clienteIds || !clienteIds.length) return mapa;

    try {
        const { data, error } = await supabaseClient
            .from('mensagens_cliente')
            .select('client_id')
            .in('client_id', clienteIds)
            .eq('remetente', 'cliente')
            .eq('lida', false);

        if (error) throw error;

        (data || []).forEach(row => {
            mapa[row.client_id] = (mapa[row.client_id] || 0) + 1;
        });
    } catch (err) {
        console.warn('⚠️ contarMensagensNaoLidasPorCliente:', err.message);
    }

    return mapa;
}

// Os eventos do formulário são ligados por admin.js (initMensagensAdmin)
// depois do login confirmado — não há auto-início aqui, e o guarda
// `mensagensAdminIniciado` impede ligação dupla de qualquer forma.

console.log('✅ mensagens-admin.js carregado');
