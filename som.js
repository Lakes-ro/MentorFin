/**
 * SOM.JS — Sons e avisos das notificações (cliente e admin)
 * ================================================
 * Padrão: script global (IIFE `SomModule`). Sem import/export.
 * Carregar ANTES de mensagens-cliente.js / notificacoes-admin.js /
 * gamificacao.js (todos usam SomModule se ele existir).
 *
 * - Os sons são sintetizados (Web Audio) — nenhum arquivo de áudio.
 * - O navegador só libera som depois do PRIMEIRO toque/clique na
 *   página (regra de autoplay de Chrome/Safari). O módulo destrava o
 *   áudio sozinho nessa primeira interação; antes dela, avisos chegam
 *   só visualmente.
 * - Liga/desliga por aparelho (localStorage). Qualquer botão com o
 *   atributo `data-som-toggle` vira o interruptor (com
 *   `data-som-compacto` mostra só o ícone).
 * - No celular Android, mensagens também vibram.
 * - `contadorTitulo(n)` põe "(n)" no título da aba.
 * - `avisoSistema(...)` mostra a notificação do sistema operacional
 *   quando a aba está em segundo plano (se a pessoa permitiu).
 */

const SomModule = (() => {
    const CHAVE = 'mentorfin_som';
    let ctx = null;
    let desbloqueado = false;
    let ultimoToque = 0;

    // [frequência Hz, início s, duração s]
    const SONS = {
        mensagem:    [[880, 0, 0.12], [1318.5, 0.12, 0.2]],
        notificacao: [[784, 0, 0.12], [1046.5, 0.12, 0.18]],
        alerta:      [[659.25, 0, 0.16], [493.88, 0.18, 0.16], [392, 0.36, 0.24]],
        sucesso:     [[659.25, 0, 0.1], [880, 0.1, 0.18]],
        xp:          [[1046.5, 0, 0.07], [1568, 0.07, 0.12]],
        conquista:   [[523.25, 0, 0.12], [659.25, 0.11, 0.12], [783.99, 0.22, 0.12], [1046.5, 0.33, 0.32]]
    };

    function ligado() {
        try { return localStorage.getItem(CHAVE) !== 'off'; } catch (_) { return true; }
    }

    function contexto() {
        if (!ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return null;
            try { ctx = new AC(); } catch (_) { return null; }
        }
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        return ctx;
    }

    /** Primeira interação: destrava o áudio (no iOS, tocando um buffer mudo). */
    function desbloquear() {
        if (desbloqueado) return;
        const c = contexto();
        if (!c) return;
        try {
            const b = c.createBuffer(1, 1, 22050);
            const s = c.createBufferSource();
            s.buffer = b; s.connect(c.destination); s.start(0);
            desbloqueado = true;
        } catch (_) { /* tenta de novo no próximo toque */ }
    }
    ['pointerdown', 'touchend', 'keydown'].forEach(ev =>
        document.addEventListener(ev, desbloquear, { passive: true, capture: true }));

    /**
     * Toca um som. Tipos: mensagem, notificacao, alerta, sucesso, xp, conquista.
     * Retorna false se não tocou (desligado, sem interação ainda, repetido).
     */
    function tocar(tipo = 'notificacao', { forcar = false } = {}) {
        if (!forcar && !ligado()) return false;
        const agora = Date.now();
        if (!forcar && agora - ultimoToque < 1200) return false; // evita som em rajada
        const c = contexto();
        if (!c || c.state !== 'running') return false;
        ultimoToque = agora;

        const notas = SONS[tipo] || SONS.notificacao;
        const t0 = c.currentTime + 0.02;
        const volume = c.createGain();
        volume.gain.value = tipo === 'xp' ? 0.1 : 0.18;
        volume.connect(c.destination);

        notas.forEach(([freq, ini, dur]) => {
            const osc = c.createOscillator();
            const env = c.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            env.gain.setValueAtTime(0.0001, t0 + ini);
            env.gain.exponentialRampToValueAtTime(1, t0 + ini + 0.015);
            env.gain.exponentialRampToValueAtTime(0.0001, t0 + ini + dur);
            osc.connect(env); env.connect(volume);
            osc.start(t0 + ini);
            osc.stop(t0 + ini + dur + 0.05);
        });

        if ((tipo === 'mensagem' || tipo === 'alerta') && navigator.vibrate) {
            try { navigator.vibrate(tipo === 'alerta' ? [120, 60, 120] : 80); } catch (_) {}
        }
        return true;
    }

    // ── Interruptor ─────────────────────────────────────────────
    function atualizarBotoes() {
        const on = ligado();
        document.querySelectorAll('[data-som-toggle]').forEach(b => {
            b.textContent = b.hasAttribute('data-som-compacto')
                ? (on ? '🔊' : '🔇')
                : (on ? '🔊 Som das notificações: ligado' : '🔇 Som das notificações: desligado');
            b.title = on ? 'Som ligado — clique para silenciar' : 'Som desligado — clique para ligar';
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    function definir(on) {
        try { localStorage.setItem(CHAVE, on ? 'on' : 'off'); } catch (_) {}
        atualizarBotoes();
        if (on) { desbloquear(); setTimeout(() => tocar('notificacao', { forcar: true }), 60); }
    }

    document.addEventListener('click', (e) => {
        const b = e.target.closest('[data-som-toggle]');
        if (!b) return;
        e.preventDefault();
        e.stopPropagation();
        definir(!ligado());
    });

    // ── Título da aba ───────────────────────────────────────────
    let tituloBase = null;
    function contadorTitulo(n) {
        if (tituloBase === null) tituloBase = document.title.replace(/^\(\d+\+?\)\s*/, '');
        document.title = n > 0 ? `(${n > 99 ? '99+' : n}) ${tituloBase}` : tituloBase;
    }

    // ── Notificação do sistema (aba em segundo plano) ──────────
    async function avisoSistema(titulo, corpo = '', tag = 'mentorfin') {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        if (!document.hidden) return;
        try {
            const reg = navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null;
            const opcoes = { body: corpo, icon: 'logo.png', badge: 'logo.png', tag, renotify: true };
            if (reg) await reg.showNotification(titulo, opcoes);
            else new Notification(titulo, opcoes);
        } catch (_) { /* navegador recusou: o aviso visual e o som já foram dados */ }
    }

    /** Pede permissão de notificação do sistema (precisa vir de um clique). */
    async function pedirPermissaoSistema() {
        if (!('Notification' in window)) return 'unsupported';
        if (Notification.permission !== 'default') return Notification.permission;
        try { return await Notification.requestPermission(); } catch (_) { return 'denied'; }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', atualizarBotoes);
    else atualizarBotoes();

    return { tocar, ligado, definir, atualizarBotoes, contadorTitulo, avisoSistema, pedirPermissaoSistema };
})();

console.log('✅ som.js carregado');
