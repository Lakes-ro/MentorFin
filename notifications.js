/**
 * NOTIFICATIONS.JS — Avisos do cliente: lembrete semanal, notificações
 * do sistema e Web Push
 * ================================================
 * Padrão: script global. Sem import/export.
 * Depende de: supabaseClient, UIModule; usa SomModule (som.js) e
 * GamificacaoModule (gamificacao.js) quando existirem.
 * Iniciado por app.js (routeByRole / handleOnboarding):
 *     NotificacoesModule.inicializar(clienteId)
 *
 * REVISÃO (out/2026):
 * - Este arquivo NÃO estava carregado no index.html/client.html nem era
 *   chamado pelo app.js — nenhum lembrete chegava a ninguém. Agora está.
 * - Lembrete deixou de ser "3 dias sem lançar" (cobrava registro em dia
 *   sem gasto). Passa a seguir a regra semanal da gamificação:
 *     · sexta a domingo, se a semana atual não está em dia;
 *     · segunda e terça, se a semana passada ficou sem registro (ainda
 *       dá para marcar como revisada).
 *   No máximo um lembrete por dia.
 * - Service worker registrado com caminho RELATIVO (funciona também
 *   quando o site fica numa subpasta, como no GitHub Pages).
 * - Convite de notificações: pede uma vez; se a pessoa disser "Agora
 *   não", só volta a perguntar depois de 14 dias.
 * - Novo: aviso (toast + som) quando o consultor publica um planejamento.
 *
 * WEB PUSH COM O APP FECHADO (out/2026):
 *    A inscrição do aparelho fica em push.js (PushModule) e é salva na
 *    tabela push_inscricoes. Quem envia é a função "mentorfin-avisos" do
 *    Supabase, agendada pelo banco (sexta 18h e segunda 9h). Ver
 *    MIGRACAO-notificacoes-ciclo.sql.
 */

/** Frases do lembrete semanal (in-app e push) — edite à vontade. */
const FRASES_LEMBRETE = [
    { title: 'MentorFin 📅', body: 'Seus gastos desta semana ainda não foram lançados. Se não teve nenhum, é só tocar em “Não tive gastos”.' },
    { title: 'MentorFin 📥', body: 'Que tal importar o extrato da semana? Leva um minuto e deixa tudo em dia.' },
    { title: 'MentorFin 🔥', body: 'Falta só esta semana para manter sua sequência. Lance seus gastos!' },
    { title: 'MentorFin 🎯', body: 'Fim de semana chegando: confira quanto foi com lazer, delivery e compras esta semana.' },
];

const LEMBRETE_PASSADA = {
    title: 'MentorFin 📅',
    body:  'A semana passada ficou sem lançamentos. Ainda dá tempo: lance os gastos ou toque em “Não tive gastos” no painel.'
};

const CONVITE_PAUSA_DIAS = 14;

function sortearFrase() {
    return FRASES_LEMBRETE[Math.floor(Math.random() * FRASES_LEMBRETE.length)];
}

// ══════════════════════════════════════════════════════════════
// MÓDULO PRINCIPAL
// ══════════════════════════════════════════════════════════════
const NotificacoesModule = (() => {

    let clienteAtual   = null;
    let canalPlanejamento = null;

    const lerLS = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
    const gravarLS = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };

    // ─────────────────────────────────────────────────────────
    // LEMBRETE SEMANAL (chamado pela gamificação depois de calcular)
    // ─────────────────────────────────────────────────────────
    function lembreteSemanal(estado) {
        if (!estado || !clienteAtual) return;
        const hoje = new Date();
        const chaveHoje = `mentorfin_lembrete_${clienteAtual}`;
        const diaKey = hoje.toISOString().slice(0, 10);
        if (lerLS(chaveHoje) === diaKey) return; // já lembrou hoje

        const dow = hoje.getDay(); // 0 dom … 6 sáb
        let frase = null;
        if (!estado.semanaAtualEmDia && (dow === 5 || dow === 6 || dow === 0)) frase = sortearFrase();
        else if (estado.podeMarcarSemanaPassada && (dow === 1 || dow === 2)) frase = LEMBRETE_PASSADA;
        if (!frase) return;

        gravarLS(chaveHoje, diaKey);
        setTimeout(() => exibirToastLembrete(frase.body), 2800);
    }

    function exibirToastLembrete(mensagem, icone = '📅') {
        if (document.getElementById('mf-lembrete-inapp')) return;

        const el = document.createElement('div');
        el.id = 'mf-lembrete-inapp';
        el.setAttribute('role', 'status');
        el.style.cssText = `
            position:fixed;bottom:calc(80px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);
            width:calc(100% - 32px);max-width:440px;
            background:rgba(26,26,46,.97);backdrop-filter:blur(12px);
            border:1px solid rgba(100,149,255,.3);border-radius:14px;
            padding:14px 16px;z-index:9998;
            box-shadow:0 8px 32px rgba(0,0,0,.55);
            display:flex;align-items:center;gap:12px;
            font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;
            animation:slideUp .3s ease;
        `;
        const texto = document.createElement('p');
        texto.style.cssText = 'margin:0;font-size:13px;color:#e0e0e0;line-height:1.45;flex:1';
        texto.textContent = mensagem;
        el.innerHTML = `<span style="font-size:22px;flex-shrink:0">${icone}</span>`;
        el.appendChild(texto);
        const fechar = document.createElement('button');
        fechar.setAttribute('aria-label', 'Fechar lembrete');
        fechar.textContent = '✕';
        fechar.style.cssText = 'background:none;border:none;color:#a0a0b0;font-size:20px;cursor:pointer;padding:0 4px;flex-shrink:0;line-height:1;';
        fechar.addEventListener('click', () => el.remove());
        el.appendChild(fechar);

        document.body.appendChild(el);
        setTimeout(() => el.remove(), icone === '📅' ? 12000 : 25000);
    }

    // ─────────────────────────────────────────────────────────
    // PLANEJAMENTO NOVO → aviso com som (Realtime em `planejamentos`;
    // ver MIGRACAO-gamificacao-v2.sql, parte 3)
    // ─────────────────────────────────────────────────────────
    function ligarAvisoPlanejamento(clienteId) {
        if (canalPlanejamento || typeof supabaseClient === 'undefined' || !supabaseClient) return;
        canalPlanejamento = supabaseClient
            .channel(`planejamentos-cliente-${clienteId}`)
            .on('postgres_changes', {
                event: 'INSERT', schema: 'public', table: 'planejamentos', filter: `client_id=eq.${clienteId}`
            }, (payload) => {
                const titulo = payload.new?.titulo || 'Novo planejamento';
                if (typeof UIModule !== 'undefined') UIModule.showMessage(`📋 Seu consultor publicou um planejamento: ${titulo}`, 'success', 6000);
                if (typeof SomModule !== 'undefined') {
                    SomModule.tocar('notificacao');
                    SomModule.avisoSistema('📋 Novo planejamento', titulo, 'mentorfin-planejamento');
                }
                if (typeof loadClientPlanning === 'function') loadClientPlanning();
            })
            .subscribe();
    }

    // ─────────────────────────────────────────────────────────
    // PERMISSÃO + SERVICE WORKER + WEB PUSH
    // ─────────────────────────────────────────────────────────
    function conviteEmPausa() {
        const ate = Number(lerLS('mentorfin_convite_notif_ate') || 0);
        return Date.now() < ate;
    }

    /** Espera o tour do primeiro acesso fechar (até 2 min) antes de convidar. */
    async function esperarTourFechar() {
        for (let i = 0; i < 240; i++) {
            const tour = document.getElementById('modalTour');
            if (!tour || tour.classList.contains('hidden')) return;
            await new Promise(r => setTimeout(r, 500));
        }
    }

    async function mostrarBannerConvite() {
        await esperarTourFechar();
        return new Promise(resolve => {
            if (!('Notification' in window) || Notification.permission !== 'default' || conviteEmPausa()) { resolve(false); return; }

            const banner = document.createElement('div');
            banner.id = 'mf-notif-banner';
            banner.style.cssText = `
                position:fixed;bottom:calc(80px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);
                width:calc(100% - 32px);max-width:440px;
                background:rgba(26,26,46,.97);backdrop-filter:blur(12px);
                border:1px solid rgba(100,149,255,.35);border-radius:16px;
                padding:18px;z-index:9999;
                box-shadow:0 8px 40px rgba(0,0,0,.6);
                display:flex;flex-direction:column;gap:14px;
                font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;
                animation:slideUp .3s ease;
            `;
            banner.innerHTML = `
                <div style="display:flex;align-items:flex-start;gap:14px;">
                    <span style="font-size:30px;line-height:1;flex-shrink:0">🔔</span>
                    <div>
                        <p style="margin:0;font-size:14px;font-weight:700;color:#e0e0e0;">Ativar avisos do MentorFin?</p>
                        <p style="margin:5px 0 0;font-size:12.5px;color:#a0a0b0;line-height:1.45;">
                            Saiba na hora quando seu consultor responder ou publicar um planejamento —
                            e receba um lembrete por semana, não todo dia.
                        </p>
                    </div>
                </div>
                <div style="display:flex;gap:8px;justify-content:flex-end;">
                    <button id="mf-notif-nao" style="padding:9px 18px;background:transparent;cursor:pointer;
                        border:1px solid rgba(100,149,255,.3);border-radius:8px;color:#a0a0b0;font-size:13px;font-family:inherit;">Agora não</button>
                    <button id="mf-notif-sim" style="padding:9px 22px;cursor:pointer;
                        background:linear-gradient(135deg,#6495ff,#4a7dff);border:none;border-radius:8px;
                        color:#fff;font-size:13px;font-weight:700;font-family:inherit;">✓ Ativar avisos</button>
                </div>`;

            document.body.appendChild(banner);

            const fechar = ok => {
                banner.remove();
                if (!ok) gravarLS('mentorfin_convite_notif_ate', String(Date.now() + CONVITE_PAUSA_DIAS * 864e5));
                resolve(ok);
            };
            // A permissão precisa ser pedida DENTRO do toque (exigência do iPhone/Safari)
            document.getElementById('mf-notif-sim')?.addEventListener('click', () => { banner.remove(); ativarAvisos().then(r => resolve(r === 'granted')); });
            document.getElementById('mf-notif-nao')?.addEventListener('click', () => fechar(false));
            setTimeout(() => { if (document.getElementById('mf-notif-banner')) { banner.remove(); resolve(false); } }, 20000);
        });
    }

    async function inscreverAparelho({ avisarErro = false } = {}) {
        if (typeof PushModule === 'undefined') return { ok: false, motivo: 'sem_push_js' };
        const r = await PushModule.inscrever('cliente');
        if (!r.ok && avisarErro && r.motivo !== 'sem_suporte') {
            console.warn('Push não ativado:', r);
            UIModule?.showError?.('Não consegui ativar os avisos com o app fechado neste aparelho. Tente de novo mais tarde.');
        }
        return r;
    }

    /** Pedido explícito (botão no Perfil ou "Ativar" no convite). Precisa vir de um toque. */
    async function ativarAvisos() {
        if (typeof PushModule !== 'undefined' && PushModule.suporte() === 'ios_instalar') {
            UIModule?.showMessage?.(PushModule.DICA_IOS, 'info', 12000);
            atualizarBotaoAvisos();
            return 'ios_instalar';
        }
        const resultado = typeof SomModule !== 'undefined'
            ? await SomModule.pedirPermissaoSistema()
            : ('Notification' in window ? await Notification.requestPermission() : 'unsupported');
        atualizarBotaoAvisos();
        if (resultado === 'granted') {
            const r = await inscreverAparelho({ avisarErro: true });
            if (r.ok) UIModule?.showSuccess?.('🔔 Avisos ativados neste aparelho.');
            atualizarBotaoAvisos();
        } else if (resultado === 'denied') {
            UIModule?.showError?.('Os avisos estão bloqueados. Libere as notificações do MentorFin nas configurações do navegador/celular.');
        }
        return resultado;
    }

    /** Botão "Enviar aviso de teste" do Perfil. */
    async function testarAvisos() {
        const btn = document.getElementById('btnTestarAvisos');
        if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }
        try {
            const r0 = await inscreverAparelho();
            if (!r0.ok) {
                UIModule?.showError?.('Ative os avisos neste aparelho primeiro.');
                return;
            }
            const r = await PushModule.testar();
            if (r.ok) UIModule?.showSuccess?.('Aviso de teste enviado! Ele deve aparecer em alguns segundos.');
            else UIModule?.showError?.('O aviso de teste não saiu. Avise seu consultor para conferir a configuração.' + (r.detalhe ? ` (${r.detalhe})` : ''));
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '📨 Enviar aviso de teste'; }
        }
    }

    function atualizarBotaoAvisos() {
        const btn   = document.getElementById('btnAtivarAvisos');
        const teste = document.getElementById('btnTestarAvisos');
        const dica  = document.getElementById('avisosDicaIOS');
        const sup   = typeof PushModule !== 'undefined' ? PushModule.suporte()
                    : ('Notification' in window ? 'ok' : 'sem_suporte');
        const perm  = 'Notification' in window ? Notification.permission : 'unsupported';

        if (dica) {
            dica.textContent = typeof PushModule !== 'undefined' ? PushModule.DICA_IOS : '';
            dica.classList.toggle('hidden', sup !== 'ios_instalar');
        }
        if (teste) teste.classList.toggle('hidden', !(sup === 'ok' && perm === 'granted'));
        if (!btn) return;
        btn.classList.toggle('hidden', sup === 'sem_suporte');
        btn.disabled = sup === 'ok' && perm === 'granted';
        btn.textContent = sup === 'ios_instalar' ? '📲 Como ativar avisos no iPhone'
            : perm === 'granted' ? '🔔 Avisos neste aparelho: ativados'
            : perm === 'denied' ? '🔕 Avisos bloqueados — toque para ver como liberar'
            : '🔔 Ativar avisos neste aparelho';
        if (perm === 'denied') btn.disabled = false;
    }

    // ─────────────────────────────────────────────────────────
    // PONTO DE ENTRADA
    // ─────────────────────────────────────────────────────────
    async function inicializar(clienteId) {
        if (!clienteId || clienteAtual === clienteId) return;
        clienteAtual = clienteId;

        ligarAvisoPlanejamento(clienteId);
        atualizarBotaoAvisos();

        // Se a gamificação já calculou antes de chegarmos aqui, lembra agora.
        if (typeof GamificacaoModule !== 'undefined' && GamificacaoModule.estadoAtual?.()) {
            lembreteSemanal(GamificacaoModule.estadoAtual());
        }

        if (typeof PushModule !== 'undefined') {
            // iPhone fora da Tela de Início: explica como instalar (no máximo a cada 14 dias)
            if (PushModule.suporte() === 'ios_instalar') {
                if (!conviteEmPausa()) {
                    await new Promise(r => setTimeout(r, 6000));
                    await esperarTourFechar();
                    gravarLS('mentorfin_convite_notif_ate', String(Date.now() + CONVITE_PAUSA_DIAS * 864e5));
                    exibirToastLembrete('📲 ' + PushModule.DICA_IOS, '🔔');
                }
                return;
            }
            await PushModule.registrarSW();
        }
        if (!('Notification' in window)) return;
        if (Notification.permission === 'denied') return;

        if (Notification.permission === 'granted') {
            // Renova a inscrição a cada login (o aparelho pode ter trocado de conta ou de chave)
            await inscreverAparelho();
            return;
        }

        // Permissão ainda não pedida: convite gentil depois de a pessoa se ambientar
        await new Promise(r => setTimeout(r, 6000));
        await mostrarBannerConvite();
        atualizarBotaoAvisos();
    }

    return { inicializar, lembreteSemanal, ativarAvisos, testarAvisos, atualizarBotaoAvisos, frases: FRASES_LEMBRETE };
})();

console.log('✅ notifications.js carregado');
