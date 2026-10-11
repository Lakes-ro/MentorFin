/**
 * MENSAGENS-CLIENTE.JS — Fale com o Administrador (painel do cliente)
 * ================================================
 * Padrão: script global (IIFE `MensagensModule`). Sem import/export.
 * Depende de: supabaseClient, UIModule, ClientModule (config.js, ui.js,
 * client.js — carregados ANTES deste ficheiro).
 *
 * Tabela `mensagens_cliente`:
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
 *
 * ATUALIZAÇÃO — CONVERSA MAIS LEGÍVEL:
 *   - Separadores de dia ("Hoje", "Ontem", data).
 *   - "✓ Lida" nas mensagens do cliente que o admin já abriu.
 *   - Conversa vazia mostra sugestões de pergunta clicáveis, que
 *     preenchem o campo de texto.
 *
 * ATUALIZAÇÃO — SOM: resposta do admin toca som (som.js), vibra no
 * Android, mostra "(n)" no título da aba e, com a aba em segundo
 * plano, uma notificação do sistema (se a pessoa permitiu).
 */

const MensagensModule = (() => {
    let clienteIdAtual    = null;
    let canalRealtime     = null;
    let conversaCarregada = false;

    const SUGESTOES = [
        'Pode revisar meus lançamentos deste mês?',
        'Não sei em qual categoria colocar um gasto.',
        'Quero ajuda para montar minha reserva de emergência.'
    ];

    function escaparHtml(texto) {
        return (texto || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function formatarHora(dataStr) {
        try {
            return new Date(dataStr).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        } catch (_) { return ''; }
    }

    function rotuloDia(dataStr) {
        const d     = new Date(dataStr);
        const hoje  = new Date();
        const ontem = new Date(); ontem.setDate(hoje.getDate() - 1);
        const mesmoDia = (a, b) => a.toDateString() === b.toDateString();
        if (mesmoDia(d, hoje))  return 'Hoje';
        if (mesmoDia(d, ontem)) return 'Ontem';
        return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
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
            // "(2) Gestor Financeiro" na aba do navegador enquanto houver mensagem não lida
            if (typeof SomModule !== 'undefined') SomModule.contadorTitulo(count || 0);
        } catch (err) {
            console.warn('⚠️ MensagensModule.atualizarBadge:', err.message);
        }
    }

    function renderVazio(lista) {
        lista.innerHTML = `
            <div class="mensagens-vazio">
                <p class="mensagens-vazio__titulo">Nenhuma mensagem ainda</p>
                <p class="mensagens-vazio__texto">Escreva abaixo ou toque numa sugestão para começar:</p>
                <div class="mensagens-sugestoes">
                    ${SUGESTOES.map(s => `<button type="button" class="mensagens-sugestao">${escaparHtml(s)}</button>`).join('')}
                </div>
            </div>
        `;

        lista.querySelectorAll('.mensagens-sugestao').forEach(btn => {
            btn.addEventListener('click', () => {
                const campo = document.getElementById('mensagemTexto');
                if (!campo) return;
                campo.value = btn.textContent;
                campo.dispatchEvent(new Event('input')); // ajusta a altura (app.js)
                campo.focus();
            });
        });
    }

    function renderConversa(mensagens) {
        const lista = document.getElementById('mensagensLista');
        if (!lista) return;

        if (!mensagens.length) {
            renderVazio(lista);
            return;
        }

        let diaAnterior = '';
        lista.innerHTML = mensagens.map(m => {
            const dia = rotuloDia(m.created_at);
            const separador = dia !== diaAnterior ? `<div class="mensagem-dia">${dia}</div>` : '';
            diaAnterior = dia;

            const autor = m.remetente === 'admin' ? '👤 Consultor · ' : '';
            const lida  = m.remetente === 'cliente' && m.lida ? ' · ✓ Lida' : '';
            return `${separador}
            <div class="mensagem-bolha mensagem-bolha--${m.remetente}">
                <p class="mensagem-bolha__texto">${escaparHtml(m.texto)}</p>
                <span class="mensagem-bolha__hora">${autor}${formatarHora(m.created_at)}${lida}</span>
            </div>`;
        }).join('');

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
            if (lista) lista.innerHTML = `<p class="empty-state">Erro ao carregar mensagens: ${escaparHtml(err.message)}</p>`;
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

                // Som + vibração (Android) + notificação do sistema se a aba
                // estiver em segundo plano. Ver som.js.
                if (typeof SomModule !== 'undefined') {
                    SomModule.tocar('mensagem');
                    SomModule.avisoSistema('💬 Nova mensagem do seu consultor', (nova.texto || '').slice(0, 140), 'mentorfin-mensagem');
                }

                const secaoMensagensAtiva = document.getElementById('cli-mensagens')?.classList.contains('active');
                if (secaoMensagensAtiva) {
                    abrirConversa();
                } else {
                    atualizarBadge();
                    if (typeof UIModule !== 'undefined') {
                        UIModule.showMessage('💬 Nova mensagem do seu consultor', 'info', 4000);
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
    if (btn?.disabled) return; // evita duplo envio
    if (btn) { btn.disabled = true; btn.textContent = 'Enviando...'; }

    try {
        await MensagensModule.enviarMensagem(texto);
        if (campo) {
            campo.value = '';
            campo.dispatchEvent(new Event('input')); // volta à altura mínima
        }
    } catch (err) {
        console.error('❌ handleEnviarMensagemCliente:', err.message);
        if (typeof UIModule !== 'undefined') {
            UIModule.showError('Não foi possível enviar a mensagem: ' + err.message);
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Enviar'; }
        campo?.focus();
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
