/**
 * TOUR.JS — "Como funciona", em linguagem simples (painel do cliente)
 * ================================================
 * Padrão: script global (IIFE `TourModule`). Sem import/export.
 *
 * - Aparece sozinho UMA vez por cliente, no primeiro acesso ao painel
 *   (app.js → TourModule.mostrarSeNecessario(clientId)).
 * - Pode ser reaberto a qualquer momento pelo link "Como funciona?"
 *   (card de Missões da semana) → TourModule.abrir().
 * - Feito para quem nunca usou um controle financeiro: frases curtas,
 *   sem termos técnicos. Edite os PASSOS à vontade.
 *
 * ATUALIZAÇÃO (out/2026) — passo "Avisos no celular":
 * - Último passo explica os avisos e tem o botão "🔔 Ativar avisos",
 *   que pede a permissão DENTRO do toque (exigência do iPhone/Safari) via
 *   NotificacoesModule.ativarAvisos().
 * - iPhone fora da Tela de Início: o botão vira "Como ativar no iPhone"
 *   e mostra o passo a passo de instalação.
 * - Avisos já ativados: mostra "✓ Avisos ativados" no lugar do botão.
 * - Quem já tinha visto o tour antigo (4 passos) vê SÓ este passo novo,
 *   uma vez, como "Novidade".
 * - Se a pessoa passar por este passo sem ativar, o convite automático
 *   (banner de notifications.js) espera 14 dias para não insistir.
 */

const TourModule = (() => {
    const PASSOS = [
        {
            icone: '👋',
            titulo: 'Bem-vindo!',
            texto: 'Aqui você anota o dinheiro que entra e o que sai. Com isso, você descobre para onde ele está indo e onde dá para economizar.',
            dica: 'Leva poucos segundos por gasto — ou um minuto por semana, se você importar o extrato do banco.'
        },
        {
            icone: '📅',
            titulo: 'Uma semana de cada vez',
            texto: 'Não precisa abrir o app todo dia. O importante é que os gastos de cada semana estejam lançados até domingo.',
            dica: 'Semana sem nenhum gasto? Toque em “Não tive gastos”. Cada semana em dia vale pontos e aumenta a sua sequência 🔥.'
        },
        {
            icone: '💯',
            titulo: 'Sua nota do mês',
            texto: 'Todo mês você recebe uma nota de 0 a 100. Ela mostra se o dinheiro foi bem dividido entre contas, lazer e o que você guardou.',
            dica: 'Embaixo da nota aparece uma dica do que melhorar. Dinheiro guardado nunca baixa a nota.'
        },
        {
            icone: '🐷',
            titulo: 'Metas são cofrinhos',
            texto: 'Crie uma meta (uma viagem, uma reserva para emergências, um curso). Quando guardar dinheiro, lance e escolha a meta: o cofrinho enche sozinho.',
            dica: 'Ficou com dúvida? Fale com o seu consultor na aba 💬 Mensagens.'
        },
        {
            id: 'avisos',
            icone: '🔔',
            titulo: 'Avisos no celular',
            texto: 'Ative os avisos e o MentorFin te chama na hora certa — mesmo com o app fechado: quando o consultor responder, quando sair um planejamento novo e um lembrete por semana se faltar lançar algo.',
            dica: 'Nada de mensagem todo dia: no máximo um lembrete na sexta e outro na segunda. Dá para mudar depois em 👤 Perfil.'
        }
    ];
    const IDX_AVISOS = PASSOS.findIndex(p => p.id === 'avisos');

    let passo = 0;
    let modal = null;
    let soNovidade = false;   // true = mostrando só o passo novo (quem já viu o tour antigo)
    let ativouAvisos = false;

    const chave = (clientId) => `mentorfin_tour_v1_${clientId}`;
    const chaveAvisos = (clientId) => `mentorfin_tour_avisos_${clientId}`;
    const lerLS = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
    const gravarLS = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };

    let clienteAtual = null;

    // ── Estado dos avisos neste aparelho ────────────────────────
    /** 'ativos' | 'ios_instalar' | 'bloqueados' | 'sem_suporte' | 'pedir' */
    function estadoAvisos() {
        const sup = typeof PushModule !== 'undefined' ? PushModule.suporte()
                  : ('Notification' in window ? 'ok' : 'sem_suporte');
        if (sup === 'ios_instalar') return 'ios_instalar';
        if (sup === 'sem_suporte' || !('Notification' in window)) return 'sem_suporte';
        if (Notification.permission === 'granted') return 'ativos';
        if (Notification.permission === 'denied') return 'bloqueados';
        return 'pedir';
    }

    function montar() {
        if (modal) return modal;
        modal = document.createElement('div');
        modal.id = 'modalTour';
        modal.className = 'modal hidden';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'tourTitulo');
        modal.innerHTML = `
            <div class="modal__content tour">
                <div class="modal__body tour__corpo">
                    <div class="tour__icone" id="tourIcone" aria-hidden="true"></div>
                    <h2 class="tour__titulo" id="tourTitulo"></h2>
                    <p class="tour__texto" id="tourTexto"></p>
                    <p class="tour__dica" id="tourDica"></p>
                    <div class="tour__avisos hidden" id="tourAvisos" style="display:flex;flex-direction:column;align-items:center;gap:8px;margin:4px 0 14px;">
                        <button type="button" class="btn btn--secondary" id="tourAtivarAvisos" style="width:auto;padding-left:22px;padding-right:22px;"></button>
                        <p id="tourAvisosStatus" style="margin:0;font-size:12.5px;line-height:1.45;color:var(--text-muted, #a0a0b0);text-align:center;"></p>
                    </div>
                    <div class="tour__pontos" id="tourPontos" aria-hidden="true"></div>
                    <div class="tour__acoes">
                        <button type="button" class="btn btn--secondary" id="tourPular">Pular</button>
                        <button type="button" class="btn btn--primary tour__proximo" id="tourProximo">Próximo</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(modal);

        modal.querySelector('#tourPular').addEventListener('click', fechar);
        modal.querySelector('#tourProximo').addEventListener('click', avancar);
        modal.querySelector('#tourAtivarAvisos').addEventListener('click', tocarAtivarAvisos);
        modal.addEventListener('click', (e) => { if (e.target === modal) fechar(); });
        document.addEventListener('keydown', (e) => {
            if (modal.classList.contains('hidden') || soNovidade) return;
            if (e.key === 'Escape') fechar();
            if (e.key === 'ArrowRight' && passo < PASSOS.length - 1) { passo++; desenhar(); }
            if (e.key === 'ArrowLeft' && passo > 0) { passo--; desenhar(); }
        });
        return modal;
    }

    function avancar() {
        if (!soNovidade && passo < PASSOS.length - 1) { passo++; desenhar(); }
        else fechar();
    }

    /** Toque no botão de avisos: a permissão PRECISA ser pedida aqui dentro. */
    async function tocarAtivarAvisos() {
        const estado = estadoAvisos();
        const status = modal.querySelector('#tourAvisosStatus');

        if (estado === 'ios_instalar') {
            status.textContent = (typeof PushModule !== 'undefined' && PushModule.DICA_IOS)
                || 'No iPhone: toque em Compartilhar (□↑) → “Adicionar à Tela de Início”, abra o MentorFin pelo ícone e ative os avisos no Perfil.';
            return;
        }
        if (estado === 'bloqueados') {
            status.textContent = 'Os avisos estão bloqueados neste aparelho. Libere as notificações do MentorFin nas configurações do navegador/celular e depois ative no 👤 Perfil.';
            return;
        }
        if (typeof NotificacoesModule === 'undefined') return;

        const btn = modal.querySelector('#tourAtivarAvisos');
        btn.disabled = true;
        btn.textContent = 'Ativando…';
        try {
            const r = await NotificacoesModule.ativarAvisos();
            if (r === 'granted') ativouAvisos = true;
        } finally {
            desenharAvisos();
        }
    }

    function desenharAvisos() {
        const caixa = modal.querySelector('#tourAvisos');
        const p = PASSOS[passo];
        const mostrar = p.id === 'avisos' && estadoAvisos() !== 'sem_suporte';
        caixa.classList.toggle('hidden', !mostrar);
        caixa.style.display = mostrar ? 'flex' : 'none';
        if (!mostrar) return;

        const btn = modal.querySelector('#tourAtivarAvisos');
        const status = modal.querySelector('#tourAvisosStatus');
        const estado = estadoAvisos();
        btn.disabled = false;
        btn.classList.remove('hidden');
        status.textContent = '';

        if (estado === 'ativos') {
            btn.classList.add('hidden');
            status.textContent = '✅ Avisos ativados neste aparelho.';
        } else if (estado === 'ios_instalar') {
            btn.textContent = '📲 Como ativar no iPhone';
        } else if (estado === 'bloqueados') {
            btn.textContent = '🔕 Avisos bloqueados — ver como liberar';
        } else {
            btn.textContent = '🔔 Ativar avisos';
        }
    }

    function desenhar() {
        const p = PASSOS[passo];
        modal.querySelector('#tourIcone').textContent = p.icone;
        modal.querySelector('#tourTitulo').textContent = soNovidade ? `Novidade: ${p.titulo.toLowerCase()}` : p.titulo;
        modal.querySelector('#tourTexto').textContent = p.texto;
        modal.querySelector('#tourDica').textContent = p.dica;
        modal.querySelector('#tourPontos').innerHTML = soNovidade ? '' : PASSOS
            .map((_, i) => `<span class="tour__ponto ${i === passo ? 'tour__ponto--ativo' : ''}"></span>`).join('');
        const ultimo = soNovidade || passo === PASSOS.length - 1;
        modal.querySelector('#tourProximo').textContent = soNovidade ? 'Entendi' : (ultimo ? 'Começar' : 'Próximo');
        modal.querySelector('#tourPular').classList.toggle('hidden', ultimo);
        desenharAvisos();
    }

    function abrir({ apenasNovidade = false } = {}) {
        montar();
        // O tour já tem o passo dos avisos: some com o convite solto, se aberto.
        document.getElementById('mf-notif-banner')?.remove();
        soNovidade = apenasNovidade;
        passo = apenasNovidade ? IDX_AVISOS : 0;
        desenhar();
        modal.classList.remove('hidden');
        modal.querySelector('#tourProximo').focus();
    }

    function fechar() {
        if (!modal) return;
        const viuAvisos = soNovidade || passo === IDX_AVISOS;
        modal.classList.add('hidden');
        if (clienteAtual) {
            marcarVisto();
            gravarLS(chaveAvisos(clienteAtual), '1');
        }
        // Passou pelo passo dos avisos sem ativar: o banner automático
        // (notifications.js) não insiste por 14 dias.
        if (viuAvisos && !ativouAvisos && estadoAvisos() === 'pedir') {
            gravarLS('mentorfin_convite_notif_ate', String(Date.now() + 14 * 864e5));
        }
        soNovidade = false;
    }

    function marcarVisto() {
        if (clienteAtual) gravarLS(chave(clienteAtual), '1');
    }

    /**
     * Primeiro acesso do cliente: abre o tour uma única vez (por aparelho).
     * Quem já tinha visto o tour antigo vê só o passo novo dos avisos — e
     * só se os avisos ainda não estiverem ativos neste aparelho.
     */
    function mostrarSeNecessario(clientId) {
        if (!clientId) return;
        clienteAtual = clientId;
        if (lerLS(chave(clientId)) !== '1') {
            setTimeout(() => abrir(), 600); // deixa o painel aparecer primeiro
            return;
        }
        if (lerLS(chaveAvisos(clientId)) !== '1') {
            const estado = estadoAvisos();
            if (estado === 'ativos' || estado === 'sem_suporte') {
                gravarLS(chaveAvisos(clientId), '1');
                return;
            }
            setTimeout(() => abrir({ apenasNovidade: true }), 600);
        }
    }

    return { abrir, fechar, mostrarSeNecessario };
})();

console.log('✅ tour.js carregado');
