/**
 * SERVICE-WORKER.JS — MentorFin Push Notifications
 * ================================================
 * Roda em segundo plano, independente de o app estar aberto.
 * Registrado por notifications.js via navigator.serviceWorker.register().
 *
 * Eventos tratados:
 *   install   — ativa imediatamente via skipWaiting (sem esperar abas fecharem)
 *   activate  — NÃO chama clients.claim() deliberadamente: claim() assumiria
 *               controle de todas as abas abertas no momento do registro,
 *               interrompendo as conexões Supabase em andamento e gerando
 *               dezenas de "Uncaught (in promise) Object" no console.
 *               O SW passa a controlar NOVOS carregamentos de página, o que
 *               é suficiente para receber push notifications em segundo plano.
 *   push      — exibe a notificação recebida da Edge Function
 *   notificationclick — abre/foca o app quando o usuário toca na notificação
 */

// Caminhos relativos ao próprio service worker: funcionam na raiz e em
// subpastas (ex.: GitHub Pages em /usuario.github.io/mentorfin/).
const APP_ICON  = new URL('logo.png', self.registration.scope).href;
const APP_BADGE = APP_ICON;
const APP_HOME  = self.registration.scope;

// ── Ciclo de vida ──────────────────────────────────────────────
// skipWaiting: instala o SW atualizado imediatamente
// sem clients.claim(): não interrompe conexões Supabase da aba atual
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', () => { /* intencional: sem clients.claim() */ });

// ── Recebe push da Edge Function e exibe notificação ──────────
self.addEventListener('push', event => {
    let payload = {
        title: 'MentorFin',
        body:  'Você tem novidades no MentorFin!',
        url:   APP_HOME,
        tag:   'mentorfin-lembrete'
    };

    try {
        if (event.data) Object.assign(payload, event.data.json());
    } catch (_) {
        payload.body = event.data?.text() || payload.body;
    }

    const options = {
        body:               payload.body,
        icon:               APP_ICON,
        badge:              APP_BADGE,
        tag:                payload.tag,
        renotify:           true,
        requireInteraction: false,
        vibrate:            [200, 100, 200],
        // url pode vir relativa ('admin.html', './') — resolve pela pasta do app
        data:               { url: new URL(payload.url || './', APP_HOME).href }
    };

    event.waitUntil(
        self.registration.showNotification(payload.title, options)
    );
});

// ── Toque na notificação → abre ou foca o app ─────────────────
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const url = event.notification.data?.url || APP_HOME;

    event.waitUntil(
        self.clients
            .matchAll({ type: 'window', includeUncontrolled: true })
            .then(clientList => {
                const alvo = new URL(url);
                const ehAdmin = alvo.pathname.endsWith('admin.html');
                // Foca uma aba do mesmo painel (admin ou cliente), se já houver
                for (const client of clientList) {
                    const mesmaArea = new URL(client.url).pathname.endsWith('admin.html') === ehAdmin;
                    if (mesmaArea && 'focus' in client) return client.focus();
                }
                if (self.clients.openWindow) return self.clients.openWindow(url);
            })
    );
});
