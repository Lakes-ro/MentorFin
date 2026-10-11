/**
 * PUSH.JS — Inscrição do aparelho para avisos push (cliente e admin)
 * ================================================
 * Padrão: script global (`PushModule`). Sem import/export.
 * Usado por: notifications.js (cliente) e notificacoes-admin.js (admin).
 * Depende de: supabaseClient; service-worker.js na mesma pasta.
 *
 * Fluxo:
 *   1. A pessoa permite as notificações (precisa vir de um toque/clique).
 *   2. inscrever('cliente' | 'admin') cria a inscrição do aparelho com a
 *      chave pública VAPID e salva no banco pela função registrar_push.
 *   3. A função do Supabase "mentorfin-avisos" (agendada pelo banco)
 *      envia os avisos para os aparelhos inscritos — mesmo com o app
 *      fechado.
 *
 * iPhone/iPad: o Safari só entrega push quando o MentorFin está
 * instalado na Tela de Início (iOS 16.4+). suporte() devolve
 * 'ios_instalar' nesse caso, para a tela explicar como instalar.
 */

// Chave PÚBLICA (pode ficar no código). A privada fica só nos segredos do Supabase.
const MENTORFIN_VAPID_PUBLIC_KEY = 'BPOXdr8-TlZbm6fOCDM6Sl--JhUWRGNvu-BbhQXL4TvpkQQmokSRtX0fE6W0eslBjmnj3QYs4kvgQNVYj6d27xo';

const PushModule = (() => {
    let registro = null;

    const ehIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const instalado = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

    /** 'ok' | 'ios_instalar' | 'sem_suporte' */
    function suporte() {
        const temTudo = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
        if (ehIOS() && !instalado()) return 'ios_instalar';
        return temTudo ? 'ok' : 'sem_suporte';
    }

    function permissao() {
        return 'Notification' in window ? Notification.permission : 'unsupported';
    }

    function chaveEmBytes(base64) {
        const pad = '='.repeat((4 - base64.length % 4) % 4);
        const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
        return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    }

    function mesmaChave(buffer, esperada) {
        if (!buffer) return false;
        const a = new Uint8Array(buffer);
        if (a.length !== esperada.length) return false;
        return a.every((v, i) => v === esperada[i]);
    }

    async function registrarSW() {
        if (!('serviceWorker' in navigator)) return null;
        if (registro) return registro;
        try {
            // Caminho relativo: funciona na raiz e em subpastas (GitHub Pages).
            registro = await navigator.serviceWorker.register('service-worker.js');
            return registro;
        } catch (err) {
            console.warn('⚠️ Service worker não registrado:', err.message);
            return null;
        }
    }

    /** Espera o service worker ficar ativo (no máximo ~8 s). */
    async function swPronto() {
        const reg = await registrarSW();
        if (!reg) return null;
        if (reg.active) return reg;
        return Promise.race([
            navigator.serviceWorker.ready,
            new Promise(r => setTimeout(() => r(reg.active ? reg : null), 8000))
        ]);
    }

    /**
     * Inscreve este aparelho. Só funciona com a permissão já concedida.
     * Devolve { ok: true } ou { ok: false, motivo }.
     */
    async function inscrever(papel = 'cliente') {
        if (suporte() !== 'ok') return { ok: false, motivo: suporte() };
        if (permissao() !== 'granted') return { ok: false, motivo: 'sem_permissao' };
        if (typeof supabaseClient === 'undefined' || !supabaseClient) return { ok: false, motivo: 'sem_conexao' };

        try {
            const reg = await swPronto();
            if (!reg) return { ok: false, motivo: 'sem_service_worker' };

            const chave = chaveEmBytes(MENTORFIN_VAPID_PUBLIC_KEY);
            let sub = await reg.pushManager.getSubscription();

            // Inscrição antiga feita com outra chave: refaz
            if (sub && !mesmaChave(sub.options?.applicationServerKey, chave)) {
                await sub.unsubscribe().catch(() => {});
                sub = null;
            }
            if (!sub) {
                sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chave });
            }

            const j = sub.toJSON();
            const { error } = await supabaseClient.rpc('registrar_push', {
                p_endpoint: j.endpoint,
                p_p256dh:   j.keys?.p256dh,
                p_auth:     j.keys?.auth,
                p_papel:    papel,
                p_ua:       navigator.userAgent
            });
            if (error) {
                console.warn('⚠️ registrar_push:', error.message);
                return { ok: false, motivo: 'banco', detalhe: error.message };
            }
            console.log(`🔔 Push ativo neste aparelho (${papel})`);
            return { ok: true };
        } catch (err) {
            console.warn('⚠️ Falha ao inscrever push:', err.message);
            return { ok: false, motivo: 'navegador', detalhe: err.message };
        }
    }

    /** Pede à função do Supabase um aviso de teste para os aparelhos desta conta. */
    async function testar() {
        if (typeof supabaseClient === 'undefined' || !supabaseClient?.functions) {
            return { ok: false, detalhe: 'sem conexão' };
        }
        const { data, error } = await supabaseClient.functions.invoke('mentorfin-avisos', { body: { acao: 'teste' } });
        if (error) return { ok: false, detalhe: error.message };
        return { ok: (data?.enviados || 0) > 0, ...data };
    }

    /** Texto curto explicando como instalar no iPhone. */
    const DICA_IOS = 'No iPhone, os avisos só funcionam com o MentorFin na Tela de Início: '
        + 'toque em Compartilhar (□↑) → “Adicionar à Tela de Início”, abra o app pelo ícone e ative os avisos.';

    return { suporte, permissao, registrarSW, inscrever, testar, ehIOS, instalado, DICA_IOS };
})();

console.log('✅ push.js carregado');
