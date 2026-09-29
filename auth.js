/**
 * AUTH.JS - AUTENTICAÇÃO COM RBAC
 * ================================================
 * ALTERAÇÃO: com persistSession:true (config.js), a sessão do
 * Supabase agora é gravada em localStorage e sobrevive a reloads
 * e navegação entre páginas. checkSession() foi reescrito para
 * de facto consultar getSession() e restaurar o usuário,
 * em vez de retornar null sempre.
 *
 * ATUALIZAÇÃO — CADASTRO ATÔMICO (phase1_identity_signup_and_names):
 * register() agora envia nome completo e apelido em options.data.
 * O trigger `on_auth_user_created` (banco) usa esses metadados para
 * criar usuarios + usuarios_perfis ('client') + clientes numa única
 * transação — funciona mesmo com confirmação de e-mail ligada, quando
 * o navegador ainda não tem sessão e a RLS barraria inserts do front.
 */

const AuthModule = (() => {
    let currentUser     = null;
    let userRole        = null; // 'admin' | 'client'
    let currentClientId = null;

    const notifyChange = () => {
        window.dispatchEvent(new CustomEvent('auth-changed', {
            detail: { user: currentUser, role: userRole, clientId: currentClientId }
        }));
    };

    return {
        /**
         * Verifica se existe uma sessão persistida (localStorage).
         * Se existir, restaura currentUser/userRole/currentClientId
         * e retorna o usuário. Caso contrário, retorna null.
         */
        async checkSession() {
            try {
                const { data: { session }, error } = await supabaseClient.auth.getSession();

                if (error || !session) {
                    return null;
                }

                currentUser = session.user;
                const role  = await this.determineUserRole(session.user.id, session.user.email);

                if (!role) {
                    await supabaseClient.auth.signOut();
                    currentUser     = null;
                    userRole        = null;
                    currentClientId = null;
                    return null;
                }

                notifyChange();
                console.log('✅ Sessão restaurada:', session.user.email, '| Role:', role);
                return currentUser;
            } catch (err) {
                console.warn('⚠️ Erro ao verificar sessão:', err.message);
                return null;
            }
        },

        /**
         * Determina o papel pelo BANCO (usuarios_perfis), não pelo
         * e-mail no front:
         * 1. perfil 'admin' em usuarios_perfis → 'admin'
         * 2. qualquer outro caso → 'client' (com ou sem cadastro
         *    completo — o onboarding cuida do que faltar)
         */
        async determineUserRole(userId, email) {
            try {
                const { data, error } = await supabaseClient
                    .from(CONFIG.TABLES.USUARIOS_PERFIS)
                    .select('perfil')
                    .eq('usuario_id', userId);

                if (!error && (data || []).some(p => p.perfil === 'admin')) {
                    userRole        = 'admin';
                    currentClientId = null;
                    console.log('✅ Role: Admin');
                    return userRole;
                }
            } catch (err) {
                console.warn('⚠️ Erro ao consultar perfis:', err.message);
            }

            userRole        = 'client';
            currentClientId = userId;
            console.log('✅ Role: Cliente', userId);
            return userRole;
        },

        async login(email, password) {
            try {
                const { data, error } = await supabaseClient.auth.signInWithPassword({
                    email,
                    password
                });

                if (error) throw error;
                if (!data.user) throw new Error('Nenhum usuário retornado');

                currentUser = data.user;
                const role  = await this.determineUserRole(data.user.id, data.user.email);

                if (!role) {
                    await supabaseClient.auth.signOut();
                    currentUser = null;
                    throw new Error('Acesso não autorizado. Este e-mail não está cadastrado no sistema.');
                }

                notifyChange();
                console.log('✅ Login:', email, '| Role:', role);

                return { user: data.user, role };
            } catch (error) {
                console.error('❌ Erro login:', error);
                throw error;
            }
        },

        /**
         * @param {string} email
         * @param {string} password
         * @param {{ fullName: string, nickname: string }} profile
         * @returns {{ user, session }} session vem null quando a
         *          confirmação de e-mail está ligada no Supabase.
         */
        async register(email, password, profile = {}) {
            try {
                const fullName = (profile.fullName || '').trim();
                const nickname = (profile.nickname || '').trim();

                const { data, error } = await supabaseClient.auth.signUp({
                    email,
                    password,
                    options: {
                        data: {
                            nome_completo: fullName,
                            apelido:       nickname,
                            full_name:     fullName,
                            display_name:  nickname || fullName
                        }
                    }
                });

                if (error) throw error;
                if (!data.user) throw new Error('Nenhum usuário retornado');

                currentUser     = data.user;
                userRole        = 'client';
                currentClientId = data.user.id;

                notifyChange();
                console.log('✅ Cadastro:', email);

                return { user: data.user, session: data.session };
            } catch (error) {
                console.error('❌ Erro no cadastro:', error);
                throw error;
            }
        },

        async logout() {
            try {
                await supabaseClient.auth.signOut();
            } catch (_) {
                // ignora erro de signOut (sessão já expirada)
            }

            currentUser     = null;
            userRole        = null;
            currentClientId = null;
            notifyChange();

            console.log('✅ Logout');
            return true;
        },

        getUser:     () => currentUser,
        getUserRole: () => userRole,
        getClientId: () => currentClientId,
        isLogged:    () => currentUser !== null,
        isAdmin:     () => userRole === 'admin',
        isClient:    () => userRole === 'client'
    };
})();

/**
 * Valida nome completo e apelido antes de enviar ao banco (o trigger
 * `trg_validate_user_names` repete a mesma regra no servidor).
 * Retorna a mensagem de erro, ou null se estiver tudo certo.
 */
function validarNomesUsuario(nomeCompleto, apelido, email) {
    const nome  = (nomeCompleto || '').trim();
    const apel  = (apelido || '').trim();
    const mail  = (email || '').trim().toLowerCase();
    const local = mail.split('@')[0];

    if (nome.length < 3)                 return 'Informe o seu nome completo.';
    if (!/[A-Za-zÀ-ÿ]/.test(nome))       return 'O nome precisa ter letras.';
    if (nome.includes('@'))              return 'O nome não pode ser um e-mail.';
    if (mail && [mail, local].includes(nome.toLowerCase()))
                                         return 'O nome não pode ser igual ao seu e-mail.';
    if (!apel)                           return 'Informe como quer ser chamado.';
    if (apel.includes('@'))              return 'O apelido não pode ser um e-mail.';
    if (mail && [mail, local].includes(apel.toLowerCase()))
                                         return 'O apelido não pode ser igual ao seu e-mail.';
    return null;
}

console.log('✅ auth.js carregado');
