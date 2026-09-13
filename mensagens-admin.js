/**
 * MENSAGENS-ADMIN.JS — Conversa com o Cliente (admin.html)
 * ================================================
 * Padrão: script global. Sem import/export.
 * Depende de: supabaseClient, currentAdmin, allClientes, loadAllClientes,
 *             openModal, closeModal, showToast (admin.js).
 *
 * Aberto pelo botão "💬 Mensagens" em qualquer card de cliente
 * (clientes.js). Diferente do modal "💬 Comentários": comentários são
 * notas PRIVADAS do admin sobre o cliente; mensagens são uma conversa
 * de mão dupla que o cliente vê e responde no próprio painel dele.
 */

let mensagensAdminClienteId = null;

function initMensagensAdmin() {
    document.getElementById('btn-enviar-mensagem-admin')
        ?.addEventListener('click', handleEnviarMensagemAdmin);

    document.getElementById('mensagem-admin-texto')
        ?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleEnviarMensagemAdmin();
            }
        });
}

function escaparHtmlMensagemAdmin(texto) {
    return (texto || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatarHoraMensagemAdmin(dataStr) {
    try {
        return new Date(dataStr).toLocaleString('pt-BR', {
            day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
        });
    } catch (_) { return ''; }
}

async function abrirModalMensagensCliente(clienteId, nome) {
    mensagensAdminClienteId = clienteId;

    document.getElementById('modal-mensagens-cliente-title').textContent = `💬 Mensagens — ${nome}`;
    document.getElementById('mensagem-admin-texto').value = '';

    await carregarConversaAdmin(clienteId);
    await marcarMensagensClienteComoLidas(clienteId);

    openModal('modal-mensagens-cliente');
}

async function carregarConversaAdmin(clienteId) {
    const lista = document.getElementById('mensagens-admin-lista');
    if (!lista) return;
    lista.innerHTML = '<p class="empty-state">Carregando conversa...</p>';

    const { data, error } = await supabaseClient
        .from('mensagens_cliente')
        .select('id, remetente, texto, created_at')
        .eq('client_id', clienteId)
        .order('created_at', { ascending: true });

    if (error) {
        lista.innerHTML = `<p class="empty-state">Erro ao carregar mensagens: ${error.message}</p>`;
        console.error('❌ carregarConversaAdmin:', error.message);
        return;
    }

    if (!data?.length) {
        lista.innerHTML = '<p class="empty-state">Nenhuma mensagem ainda. Este cliente ainda não escreveu nada.</p>';
        return;
    }

    lista.innerHTML = data.map(m => `
        <div class="mensagem-admin-bolha mensagem-admin-bolha--${m.remetente}">
            <p class="mensagem-admin-bolha__texto">${escaparHtmlMensagemAdmin(m.texto)}</p>
            <span class="mensagem-admin-bolha__hora">${formatarHoraMensagemAdmin(m.created_at)}</span>
        </div>
    `).join('');

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

        // Zera o selo no card assim que a conversa é aberta/lida
        const badge = document.querySelector(`.mensagens-nao-lidas[data-client-id="${clienteId}"]`);
        badge?.classList.add('hidden');
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
    }
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

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMensagensAdmin);
} else {
    initMensagensAdmin();
}

console.log('✅ mensagens-admin.js carregado');
