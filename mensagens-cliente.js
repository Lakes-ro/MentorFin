/**
 * MENSAGENS-CLIENTE.JS — Fale com o Administrador (painel do cliente)
 * ================================================
 * Padrão: script global (IIFE `MensagensModule`). Sem import/export.
 * Depende de: supabaseClient, UIModule, ClientModule (config.js, ui.js,
 * client.js — carregados ANTES deste ficheiro).
 *
 * Tabela `mensagens_cliente` (ver MIGRACAO-mensagens-cliente.sql):
 *   id, client_id, remetente ('cliente' | 'admin'), texto, lida, created_at
 *
 * COMPORTAMENTO:
 *   - `inicializar(clientId)`: chamado uma vez após o login — busca
 *     quantas mensagens do ADMIN ainda não foram lidas e liga um canal
 *     Realtime que atualiza o selo (badge) automaticamente sempre que
 *     o admin responder, mesmo com a aba "Mensagens" fechada.
 *   - `abrirConversa()`: chamado ao entrar na aba "Mensagens" — carrega
 *     o histórico completo e marca as mensagens do admin como lidas.
 *   - `handleEnviarMensagemCliente()`: função global (onclick do botão
 *     "Enviar") — insere a mensagem do cliente e recarrega a conversa.
 */

const MensagensModule = (() => {
    let clienteIdAtual    = null;
    let canalRealtime     = null;
    let conversaCarregada = false;

    function escaparHtml(texto) {
        return (texto || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function formatarHora(dataStr) {
        try {
            return new Date(dataStr).toLocaleString('pt-BR', {
                day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
            });
        } catch (_) { return ''; }
    }

    async function atualizarBadge() {
        if (!clienteIdAtual) return;
        const badge = document.getElementById('mensagensBadge');
        if (!badge) return;

        try {
            const { count, error } = await supabaseClient
                .from('mensagens_cliente')
                .select('id', { count: 'exact', head: true })
                .eq('client_id', clienteIdAtual)
                .eq('remetente', 'admin')
                .eq('lida', false);

            if (error) throw error;

            if (count > 0) {
                badge.textContent = count > 99 ? '99+' : String(count);
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
            }
        } catch (err) {
            console.warn('⚠️ MensagensModule.atualizarBadge:', err.message);
        }
    }

    function renderConversa(mensagens) {
        const lista = document.getElementById('mensagensLista');
        if (!lista) return;

        if (!mensagens.length) {
            lista.innerHTML = '<p class="empty-state">Nenhuma mensagem ainda. Escreva abaixo para começar a conversa com o administrador.</p>';
            return;
        }

        lista.innerHTML = mensagens.map(m => `
            <div class="mensagem-bolha mensagem-bolha--${m.remetente}">
                <p class="mensagem-bolha__texto">${escaparHtml(m.texto)}</p>
                <span class="mensagem-bolha__hora">${m.remetente === 'admin' ? '👤 Administrador · ' : ''}${formatarHora(m.created_at)}</span>
            </div>
        `).join('');

        lista.scrollTop = lista.scrollHeight;
    }

    async function marcarComoLidas() {
        if (!clienteIdAtual) return;
        try {
            await supabaseClient
                .from('mensagens_cliente')
                .update({ lida: true })
                .eq('client_id', clienteIdAtual)
                .eq('remetente', 'admin')
                .eq('lida', false);
        } catch (err) {
            console.warn('⚠️ MensagensModule.marcarComoLidas:', err.message);
        } finally {
            atualizarBadge();
        }
    }

    async function abrirConversa() {
        if (!clienteIdAtual) return;
        const lista = document.getElementById('mensagensLista');
        if (lista && !conversaCarregada) lista.innerHTML = '<p class="empty-state">Carregando conversa...</p>';

        try {
            const { data, error } = await supabaseClient
                .from('mensagens_cliente')
                .select('id, remetente, texto, lida, created_at')
                .eq('client_id', clienteIdAtual)
                .order('created_at', { ascending: true });

            if (error) throw error;

            conversaCarregada = true;
            renderConversa(data || []);
            await marcarComoLidas();
        } catch (err) {
            console.error('❌ MensagensModule.abrirConversa:', err.message);
            if (lista) lista.innerHTML = `<p class="empty-state">Erro ao carregar mensagens: ${err.message}</p>`;
        }
    }

    async function enviarMensagem(texto) {
        if (!clienteIdAtual || !texto?.trim()) return;

        const { error } = await supabaseClient
            .from('mensagens_cliente')
            .insert({ client_id: clienteIdAtual, remetente: 'cliente', texto: texto.trim() });

        if (error) throw error;

        await abrirConversa();
    }

    function ligarRealtime() {
        if (!clienteIdAtual || canalRealtime) return;

        canalRealtime = supabaseClient
            .channel(`mensagens-cliente-${clienteIdAtual}`)
            .on('postgres_changes', {
                event:  'INSERT',
                schema: 'public',
                table:  'mensagens_cliente',
                filter: `client_id=eq.${clienteIdAtual}`
            }, (payload) => {
                const nova = payload.new;
                if (nova.remetente !== 'admin') return;

                const secaoMensagensAtiva = document.getElementById('cli-mensagens')?.classList.contains('active');
                if (secaoMensagensAtiva) {
                    abrirConversa();
                } else {
                    atualizarBadge();
                    if (typeof UIModule !== 'undefined') {
                        UIModule.showMessage('💬 Nova mensagem do administrador', 'info', 4000);
                    }
                }
            })
            .subscribe();
    }

    async function inicializar(clientId) {
        clienteIdAtual    = clientId;
        conversaCarregada = false;
        await atualizarBadge();
        ligarRealtime();
    }

    return { inicializar, abrirConversa, enviarMensagem };
})();

async function handleEnviarMensagemCliente() {
    const campo = document.getElementById('mensagemTexto');
    const texto = campo?.value.trim();
    if (!texto) return;

    const btn = document.getElementById('btnEnviarMensagem');
    if (btn) { btn.disabled = true; btn.textContent = 'Enviando...'; }

    try {
        await MensagensModule.enviarMensagem(texto);
        if (campo) campo.value = '';
        campo?.focus();
    } catch (err) {
        console.error('❌ handleEnviarMensagemCliente:', err.message);
        if (typeof UIModule !== 'undefined') {
            UIModule.showError('Não foi possível enviar a mensagem: ' + err.message);
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Enviar'; }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const campo = document.getElementById('mensagemTexto');
    campo?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleEnviarMensagemCliente();
        }
    });
});

console.log('✅ mensagens-cliente.js carregado');
