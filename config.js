/**
 * CONFIG.JS - CONFIGURAÇÃO CENTRALIZADA
 * ================================================
 * persistSession: true — o sistema tem duas páginas de entrada
 * separadas (index.html/client.html para clientes, admin.html para o
 * administrador). Com a sessão gravada em localStorage ela sobrevive à
 * troca de página e a recarregamentos, permitindo que auth.js
 * (checkSession) restaure o usuário autenticado.
 *
 * ATUALIZAÇÃO — SEM E-MAIL DO ADMIN NO CÓDIGO:
 * O papel de administrador agora vem do banco (usuarios_perfis, perfil
 * 'admin' — ver auth.js e admin.js). O e-mail do admin foi retirado
 * daqui: este arquivo é público (qualquer visitante consegue lê-lo).
 */

const CONFIG = {
    SUPABASE: {
        URL: 'https://aypthqwdugetcnglmopy.supabase.co',
        ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5cHRocXdkdWdldGNuZ2xtb3B5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIzMzM2OTQsImV4cCI6MjA4NzkwOTY5NH0.C3XJI7Ro4tcyEhhxnlZD5FznoN6EOyeheC1Zbp6ZBUM'
    },

    TABLES: {
        USUARIOS:        'usuarios',
        USUARIOS_PERFIS: 'usuarios_perfis',
        CLIENTES:        'clientes',
        TRANSACOES:      'transacoes',
        METAS:           'metas',
        PLANEJAMENTOS:   'planejamentos',
        PLANO_DE_CONTAS: 'plano_de_contas',
        CATEGORIAS:      'categorias'
    },

    UI: {
        MESSAGE_TIMEOUT:       3000,
        ANIMATION_DURATION:    300,
        CHART_UPDATE_INTERVAL: 5000,
        DEBOUNCE_DELAY:        300
    },

    FORMAT: {
        CURRENCY:    'BRL',
        LOCALE:      'pt-BR',
        DATE_FORMAT: 'dd/MM/yyyy'
    },

    VIEWS: {
        CLIENT_DASHBOARD:    'cli-dashboard',
        CLIENT_TRANSACTIONS: 'cli-transactions',
        CLIENT_GOALS:        'cli-goals',
        CLIENT_PLANNING:     'cli-planning',
        ADMIN_CLIENTS:       'admin-clients',
        ADMIN_DASHBOARDS:    'admin-dashboards',
        ADMIN_METAS:         'admin-metas',
        ADMIN_PLANNING:      'admin-planning',
        ADMIN_TRANSACTIONS:  'admin-transactions'
    }
};

let supabaseClient = null;

function initSupabase() {
    if (!window.supabase) {
        console.error('❌ SDK Supabase não carregado');
        return false;
    }

    try {
        supabaseClient = window.supabase.createClient(
            CONFIG.SUPABASE.URL,
            CONFIG.SUPABASE.ANON_KEY,
            {
                auth: {
                    persistSession:     true,
                    autoRefreshToken:   true,
                    detectSessionInUrl: false
                }
            }
        );
        console.log('✅ Supabase conectado (sessão persistida)');
        return true;
    } catch (error) {
        console.error('❌ Erro ao inicializar Supabase:', error);
        return false;
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSupabase);
} else {
    initSupabase();
}

console.log('✅ config.js carregado');
