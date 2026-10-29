/**
 * APP.JS - ORQUESTRADOR DO PAINEL DO CLIENTE
 * ================================================
 * Este ficheiro (usado por index.html e client.html) cuida
 * SOMENTE do fluxo do cliente (login, cadastro, onboarding,
 * dashboard do cliente). O painel do administrador vive
 * exclusivamente em admin.html + admin.js.
 *
 * DEPENDÊNCIAS OBRIGATÓRIAS (devem ser carregadas ANTES deste
 * ficheiro no HTML): config.js, ui.js, auth.js, database.js,
 * dashboard.js, transactions.js, goals.js, planning.js, client.js
 *
 * ATENÇÃO: o módulo ClientModule (estado do cliente logado,
 * addTransaction, addGoal) NÃO está definido aqui — vive em
 * client.js.
 *
 * ATUALIZAÇÃO — SMART DATE + SMART INPUT (smart-input.js):
 * 1) switchClientView() chama initForm() sempre que a aba
 *    "Transações" é aberta.
 * 2) handleAddTransaction() garante que qualquer classificação
 *    automática em andamento termine antes de validar.
 *
 * ATUALIZAÇÃO — DASHBOARD FILTRÁVEL POR PERÍODO:
 * O "Resumo do Mês"/"Análise Financeira" agora tem uma barra de
 * filtro de período (igual à do Histórico: Todos/Hoje/7 dias/Este
 * mês/Personalizado — ver client.html/index.html, bloco
 * `#dashboardFilters`). getFiltroDashboardAtual() lê esses controles
 * e initDashboardFilters() liga os listeners; trocar o período
 * re-renderiza SÓ o dashboard (não recarrega metas/histórico/
 * planejamento inteiros, para ficar rápido).
 *
 * ATUALIZAÇÃO — HISTÓRICO RECOLHÍVEL:
 * O card "📋 Histórico" agora pode ser fechado/aberto via
 * toggleHistoricoCard() (botão-cabeçalho, reaproveitando as classes
 * genéricas .btn-collapse/.collapse-icon/.collapse-content que já
 * existiam em style.css sem uso).
 *
 * ATUALIZAÇÃO — AVISOS (out/2026): NotificacoesModule.inicializar()
 * (notifications.js) passou a ser chamado após o login/onboarding — o
 * arquivo existia mas não era carregado nem iniciado.
 *
 * ATUALIZAÇÃO — CICLO FINANCEIRO PERSONALIZADO (ciclo.js):
 * O cliente escolhe (Perfil → "Meu ciclo financeiro") em que dia o "mês"
 * dele começa — ex.: recebe dia 27 → ciclo 27/05 a 26/06. Dashboard e
 * Histórico ganham "Meu ciclo atual" e "Ciclo anterior" (só aparecem
 * quando o ciclo não é o mês normal). O dashboard abre já no ciclo
 * atual. Gravação via RPC definir_ciclo_financeiro (o cliente não tem
 * UPDATE direto em `clientes`).
 *
 * ATUALIZAÇÃO — CADASTRO E NOMES (phase1_identity_signup_and_names):
 * - Cadastro: o front só chama signUp com nome/apelido nos metadados.
 *   O trigger `on_auth_user_created` cria usuarios + perfil 'client' +
 *   clientes no banco. Antes eram 3 inserts + 1 RPC feitos pelo front,
 *   que falhavam em silêncio com a confirmação de e-mail ligada (sem
 *   sessão, a RLS barrava) e ainda gravavam perfil 'client' num CHECK
 *   que só aceitava 'cliente'.
 * - Onboarding: uma única RPC, `complete_signup(p_full_name,
 *   p_nickname)`.
 * - O e-mail NUNCA é usado como nome: sem nome, o usuário vai para o
 *   onboarding. validarNomesUsuario() (auth.js) + trigger
 *   `trg_validate_user_names` no banco garantem isso.
 */

// ================================================
// UTILITÁRIOS GLOBAIS
// ================================================

function toggleScreen(screenId) {
    UIModule.showScreen(screenId);
}

function closeModal(modalId) {
    UIModule.closeModal(modalId);
}

function toggleAddMetaForm() {
    document.getElementById('addMetaForm')?.classList.toggle('hidden');
}

/**
 * Abre/fecha o corpo do card "Histórico" (filtros + lista de
 * transações). O ícone (▾/▸) gira via CSS (.collapse-icon já suporta
 * rotação, ver style.css) — aqui só alternamos uma classe no ícone
 * para indicar estado recolhido, e a classe .hidden no conteúdo.
 */
function toggleHistoricoCard() {
    const conteudo = document.getElementById('historicoConteudo');
    const icone    = document.getElementById('historicoCollapseIcon');
    if (!conteudo) return;

    const estaEscondido = conteudo.classList.toggle('hidden');
    if (icone) icone.textContent = estaEscondido ? '▸' : '▾';
}

/**
 * Ativa uma secção do painel do cliente e executa os efeitos colaterais
 * associados a ela (ex: carregar categorias ao abrir Transações).
 * Compartilhada entre switchClientView() (clique real num item do
 * menu, com `event`) e navegarParaSecaoCliente() (navegação
 * programática, ex: botão "Definir Meta de Gastos" dentro do
 * Dashboard — não existe nenhum `event` de clique de menu nesse caso).
 */
function ativarSecaoCliente(sectionId) {
    document.querySelectorAll('.view-section').forEach(s => s.classList.remove('active'));
    document.getElementById(sectionId)?.classList.add('active');

    if (sectionId === 'cli-transactions') {
        garantirCategoriasCarregadas();

        if (typeof initForm === 'function') {
            initForm(false);
        }
    }

    if (sectionId === 'cli-mensagens' && typeof MensagensModule !== 'undefined') {
        MensagensModule.abrirConversa();
    }
}

function switchClientView(sectionId, event) {
    event.preventDefault();
    document.querySelectorAll('.sidebar__nav-item').forEach(b => b.classList.remove('active'));
    event.currentTarget.classList.add('active');
    ativarSecaoCliente(sectionId);
}

/**
 * Navega para uma secção do painel do cliente sem depender de um
 * clique real no menu lateral (ex: CTA "Definir Meta de Gastos" no
 * Dashboard). Sincroniza o item ativo do menu lateral pelo atributo
 * onclick, para o destaque visual continuar correto.
 */
function navegarParaSecaoCliente(sectionId) {
    document.querySelectorAll('.sidebar__nav-item').forEach(b => {
        const alvo = b.getAttribute('onclick') || '';
        b.classList.toggle('active', alvo.includes(`'${sectionId}'`));
    });
    ativarSecaoCliente(sectionId);
}

// ================================================
// PERFIL DO USUÁRIO LOGADO (nome completo + apelido)
// ================================================

let perfilUsuarioCache = null; // { nome_completo, apelido }

async function carregarPerfilUsuario(userId) {
    try {
        const { data } = await supabaseClient
            .from(CONFIG.TABLES.USUARIOS)
            .select('nome_completo, apelido')
            .eq('id', userId)
            .maybeSingle();
        perfilUsuarioCache = data || null;
    } catch (_) {
        perfilUsuarioCache = null;
    }
    return perfilUsuarioCache;
}

/** Nome para saudação: apelido → primeiro nome → vazio. Nunca o e-mail. */
function nomeParaSaudacao(perfil) {
    if (perfil?.apelido) return perfil.apelido;
    if (perfil?.nome_completo) return perfil.nome_completo.split(' ')[0];
    return '';
}

// ================================================
// ROTEAMENTO PÓS-LOGIN (RBAC)
// ================================================

// ================================================
// CICLO FINANCEIRO DO CLIENTE (dia em que o "mês" dele começa)
// ================================================
// Quem recebe dia 27 tem um mês de 27/05 a 26/06. O ciclo vem de
// clientes.ciclo_tipo/ciclo_dia (ver ciclo.js). Padrão = mês-calendário
// (nesse caso as opções "Meu ciclo" nem aparecem — "Este mês" já serve).
const IDS_CICLO_PERFIL = { tipo: 'cicloTipo', dia: 'cicloDia', label: 'cicloDiaLabel', preview: 'cicloPreview' };
let cicloClienteAtual = { tipo: 'dia_mes', dia: 1 };

async function carregarCicloDoCliente(userId) {
    try {
        const { data, error } = await supabaseClient
            .from(CONFIG.TABLES.CLIENTES)
            .select('ciclo_tipo, ciclo_dia')
            .eq('id', userId)
            .maybeSingle();
        if (error) throw error;
        cicloClienteAtual = CicloModule.deLinha(data);
    } catch (err) {
        console.warn('⚠️ carregarCicloDoCliente (usando mês normal):', err.message);
        cicloClienteAtual = CicloModule.normalizar(null);
    }
    return cicloClienteAtual;
}

function criarOpcaoDeCiclo(valor, texto) {
    const o = document.createElement('option');
    o.value = valor;
    o.textContent = texto;
    o.dataset.ciclo = '1';
    return o;
}

/**
 * (Re)monta as opções "Meu ciclo atual / Ciclo anterior" nos filtros de
 * período do Dashboard e do Histórico. Só aparecem quando o ciclo do
 * cliente não é o mês normal.
 */
function configurarOpcoesDeCiclo({ selecionarCicloAtual = false } = {}) {
    const personalizado = !CicloModule.ehMesCalendario(cicloClienteAtual);
    const hoje     = new Date();
    const atual    = CicloModule.cicloPorOffset(cicloClienteAtual, hoje, 0);
    const anterior = CicloModule.cicloPorOffset(cicloClienteAtual, hoje, -1);

    [
        { selectId: 'dashPeriodoRapido', linhaId: 'dashPeriodoPersonalizadoRow', padrao: 'mes' },
        { selectId: 'histPeriodoRapido', linhaId: 'histPeriodoPersonalizadoRow', padrao: 'todos' }
    ].forEach(({ selectId, linhaId, padrao }) => {
        const sel = document.getElementById(selectId);
        if (!sel) return;

        const valorAntes = sel.value;
        sel.querySelectorAll('option[data-ciclo]').forEach(o => o.remove());

        if (personalizado) {
            const a = criarOpcaoDeCiclo('ciclo', `Meu ciclo atual (${atual.rotuloCurto})`);
            const b = criarOpcaoDeCiclo('ciclo_anterior', `Ciclo anterior (${anterior.rotuloCurto})`);
            const ref = sel.querySelector('option[value="todos"]');
            if (ref) ref.after(a, b); else sel.prepend(a, b);
        }

        const aindaExiste = [...sel.options].some(o => o.value === valorAntes);
        sel.value = aindaExiste ? valorAntes : padrao;
        if (selecionarCicloAtual && personalizado && selectId === 'dashPeriodoRapido') sel.value = 'ciclo';

        document.getElementById(linhaId)?.classList.toggle('hidden', sel.value !== 'personalizado');
    });
}

async function prepararCicloDoCliente(userId) {
    await carregarCicloDoCliente(userId);
    configurarOpcoesDeCiclo({ selecionarCicloAtual: true });
}

/** Período do ciclo no mesmo formato dos outros filtros, ou null se não for um filtro de ciclo. */
function filtroDeCiclo(periodo) {
    if (periodo !== 'ciclo' && periodo !== 'ciclo_anterior') return null;
    const c = CicloModule.cicloPorOffset(cicloClienteAtual, new Date(), periodo === 'ciclo' ? 0 : -1);
    return { dataInicio: c.inicio, dataFim: c.fim };
}

/** Mostra, ao lado de "Resumo do Período", as datas exatas que estão sendo somadas. */
function atualizarInfoPeriodoDashboard() {
    const el = document.getElementById('dashPeriodoInfo');
    if (!el) return;
    const f = getFiltroDashboardAtual();
    const fmt = (iso) => iso ? iso.split('-').reverse().join('/') : '';
    if (f.dataInicio && f.dataFim)  el.textContent = `${fmt(f.dataInicio)} a ${fmt(f.dataFim)}`;
    else if (f.dataInicio)          el.textContent = `desde ${fmt(f.dataInicio)}`;
    else if (f.dataFim)             el.textContent = `até ${fmt(f.dataFim)}`;
    else                            el.textContent = 'desde o primeiro lançamento';
}

function preencherCamposDeCicloNoPerfil() {
    CicloModule.ligarCampos(IDS_CICLO_PERFIL);
    CicloModule.preencherCampos(IDS_CICLO_PERFIL, cicloClienteAtual);
}

async function handleSalvarCiclo() {
    let cfg;
    try {
        cfg = CicloModule.lerCampos(IDS_CICLO_PERFIL);
    } catch (e) {
        UIModule.showError(e.message);
        return;
    }

    const btn = document.getElementById('btnSalvarCiclo');
    if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }

    try {
        const { error } = await supabaseClient.rpc('definir_ciclo_financeiro', { p_tipo: cfg.tipo, p_dia: cfg.dia });
        if (error) throw error;

        cicloClienteAtual = cfg;
        configurarOpcoesDeCiclo({ selecionarCicloAtual: true });
        UIModule.closeModal('clientProfileModal');
        UIModule.showSuccess(`Ciclo salvo: seu mês ${CicloModule.descricao(cfg)}.`);
        await loadClientDashboard();
    } catch (error) {
        console.error('❌ handleSalvarCiclo:', error);
        UIModule.showError(/definir_ciclo_financeiro|schema cache|does not exist/i.test(error.message || '')
            ? 'Este recurso ainda não está disponível. Avise o seu consultor.'
            : (error.message || 'Não foi possível salvar o ciclo.'));
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Salvar meu ciclo'; }
    }
}

async function routeByRole(user, role) {
    if (role === 'admin') {
        window.location.href = 'admin.html';
        return;
    }

    const needsOnboarding = await checkOnboarding(user, role);
    if (needsOnboarding) {
        preencherOnboardingComMetadados(user);
        UIModule.showScreen('onboardingScreen');
        return;
    }

    await garantirClienteProvisionado(user);
    await prepararCicloDoCliente(user.id);

    UIModule.setText('clientNameDisplay', nomeParaSaudacao(perfilUsuarioCache));

    ClientModule.setClientId(user.id);
    await populateCategorySelect();
    UIModule.showScreen('clientScreen');
    await loadClientDashboard();

    // Primeiro acesso: tour de 4 passos explicando o painel (tour.js)
    if (typeof TourModule !== 'undefined') TourModule.mostrarSeNecessario(user.id);

    if (typeof MensagensModule !== 'undefined') {
        MensagensModule.inicializar(user.id).catch(() => {});
    }
    if (typeof NotificacoesModule !== 'undefined') {
        NotificacoesModule.inicializar(user.id).catch(() => {});
    }
}

/**
 * Rede de segurança para contas antigas: se o usuário já tem nome em
 * `usuarios` mas falta a linha em `clientes` (ou o perfil 'client'),
 * a RPC complete_signup completa tudo de uma vez no banco.
 */
async function garantirClienteProvisionado(user) {
    try {
        const { data: jaExiste, error } = await supabaseClient
            .from(CONFIG.TABLES.CLIENTES)
            .select('id')
            .eq('id', user.id)
            .maybeSingle();

        if (error) throw error;
        if (jaExiste) return;

        const perfil = perfilUsuarioCache || await carregarPerfilUsuario(user.id);
        if (!perfil?.nome_completo) return;

        const { error: rpcError } = await supabaseClient.rpc('complete_signup', {
            p_full_name: perfil.nome_completo,
            p_nickname:  perfil.apelido || ''
        });
        if (rpcError) throw rpcError;

        console.log('✅ garantirClienteProvisionado: cadastro completado para', user.email);
    } catch (error) {
        console.error('❌ garantirClienteProvisionado:', error.message);
    }
}

// ================================================
// LOGIN UNIFICADO
// ================================================

async function handleLogin(event) {
    event.preventDefault();
    const email    = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errorEl  = document.getElementById('loginError');

    if (errorEl) { errorEl.textContent = ''; errorEl.classList.add('hidden'); }

    if (!email || !password) {
        showLoginError('Preencha o e-mail e a senha.');
        return;
    }

    const btn = event.target.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Entrando...'; }

    try {
        const { user, role } = await AuthModule.login(email, password);
        await routeByRole(user, role);
    } catch (error) {
        const msg = error.message || '';

        if (msg.includes('Invalid login credentials') || msg.includes('invalid_credentials')) {
            showLoginError(
                'E-mail não encontrado ou senha incorreta.',
                `Não tem conta? <a href="#" onclick="toggleScreen('registerScreen'); return false;" style="color:#6495ff; font-weight:700;">Criar conta grátis</a>`
            );
        } else if (msg.includes('Email not confirmed')) {
            showLoginError('E-mail ainda não confirmado. Verifique sua caixa de entrada.');
        } else {
            showLoginError(msg || 'Erro ao entrar. Tente novamente.');
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Entrar'; }
    }
}

function showLoginError(msg, extra = '') {
    const errorEl = document.getElementById('loginError');
    if (errorEl) {
        errorEl.innerHTML = '⚠️ ' + msg + (extra ? '<br><span style="font-size:12px; margin-top:6px; display:block;">' + extra + '</span>' : '');
        errorEl.classList.remove('hidden');
    }
}

/** Traduz os erros do trigger de validação de nomes do banco. */
function traduzirErroNomes(msg) {
    if (!msg) return '';
    if (msg.includes('name_equals_email'))     return 'O nome não pode ser igual ao seu e-mail.';
    if (msg.includes('nickname_equals_email')) return 'O apelido não pode ser igual ao seu e-mail.';
    if (msg.includes('name_required'))         return 'Informe o seu nome completo.';
    return msg;
}

// ================================================
// CADASTRO — o banco cria usuarios + perfil + clientes
// (trigger on_auth_user_created)
// ================================================

async function handleRegister(event) {
    event.preventDefault();

    const nome     = document.getElementById('registerNome')?.value.trim() || '';
    const apelido  = document.getElementById('registerApelido')?.value.trim() || '';
    const email    = document.getElementById('registerEmail').value.trim();
    const password = document.getElementById('registerPassword').value;
    const confirm  = document.getElementById('registerPasswordConfirm')?.value || '';
    const errorEl  = document.getElementById('registerError');

    const showErr = (msg) => {
        if (errorEl) { errorEl.textContent = '⚠️ ' + msg; errorEl.classList.remove('hidden'); }
        else UIModule.showError(msg);
    };

    if (errorEl) errorEl.classList.add('hidden');

    if (!nome || !apelido || !email || !password) {
        showErr('Preencha todos os campos.'); return;
    }

    const erroNomes = validarNomesUsuario(nome, apelido, email);
    if (erroNomes) { showErr(erroNomes); return; }

    if (password.length < 6) { showErr('A senha precisa ter no mínimo 6 caracteres.'); return; }
    if (password !== confirm) { showErr('As senhas não coincidem.'); return; }

    const btn = event.target.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Criando conta...'; }

    try {
        const { session } = await AuthModule.register(email, password, { fullName: nome, nickname: apelido });

        if (session) {
            // Confirmação de e-mail desligada: já entra direto.
            UIModule.showSuccess(`Conta criada! Bem-vindo, ${apelido}!`);
            await routeByRole(session.user, 'client');
            return;
        }

        UIModule.showSuccess(`Conta criada, ${apelido}! Confirme seu e-mail e depois faça login.`);
        event.target.reset();
        setTimeout(() => UIModule.showScreen('loginScreen'), 2500);

    } catch (error) {
        const msg = error.message || '';
        if (msg.includes('already registered') || msg.includes('already been registered')) {
            showErr('Este e-mail já tem uma conta. Faça login.');
        } else {
            showErr(traduzirErroNomes(msg) || 'Erro ao criar conta.');
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Criar Conta'; }
    }
}

// ================================================
// ONBOARDING — completa o cadastro de quem entrou sem nome
// ================================================

async function checkOnboarding(user, role) {
    if (role === 'admin') return false;

    const perfil = await carregarPerfilUsuario(user.id);
    return !perfil?.nome_completo || !perfil?.apelido;
}

async function handleOnboarding(event) {
    event.preventDefault();
    const nome    = document.getElementById('onboardingNome').value.trim();
    const apelido = document.getElementById('onboardingApelido').value.trim();
    const user    = AuthModule.getUser();

    if (!nome || !apelido) { UIModule.showError('Preencha todos os campos.'); return; }

    const erroNomes = validarNomesUsuario(nome, apelido, user?.email);
    if (erroNomes) { UIModule.showError(erroNomes); return; }

    const btn = event.target.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }

    try {
        const { error } = await supabaseClient.rpc('complete_signup', {
            p_full_name: nome,
            p_nickname:  apelido
        });
        if (error) throw error;

        await carregarPerfilUsuario(user.id);
        UIModule.showSuccess(`Bem-vindo, ${apelido}! 🎉`);
        await prepararCicloDoCliente(user.id);

        ClientModule.setClientId(user.id);
        UIModule.setText('clientNameDisplay', apelido);
        await populateCategorySelect();
        UIModule.showScreen('clientScreen');
        await loadClientDashboard();

        if (typeof TourModule !== 'undefined') TourModule.mostrarSeNecessario(user.id);

        if (typeof MensagensModule !== 'undefined') {
            MensagensModule.inicializar(user.id).catch(() => {});
        }
        if (typeof NotificacoesModule !== 'undefined') {
            NotificacoesModule.inicializar(user.id).catch(() => {});
        }
    } catch (error) {
        console.error('❌ Erro em handleOnboarding:', error);
        UIModule.showError(traduzirErroNomes(error.message) || 'Erro ao salvar perfil');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Continuar →'; }
    }
}

// ================================================
// LOGOUT
// ================================================

async function handleLogout() {
    if (!confirm('Tem certeza que deseja sair?')) return;

    try {
        await AuthModule.logout();
        window.location.reload();
    } catch (error) {
        UIModule.showError('Erro ao fazer logout');
    }
}

// ================================================
// PAINEL CLIENTE — DASHBOARD
// ================================================

/**
 * "🧭 Para onde foi o dinheiro" — complementa os valores que o
 * DashboardModule já preenche com o % de cada grupo sobre a renda do
 * período e a Taxa de Poupança (substitui os antigos blocos "Renda
 * Passiva"/"Índice de Cobertura", que ficavam sempre zerados porque
 * `categorias` não distingue renda ativa de passiva).
 */
function preencherAnaliseCliente() {
    const m = DashboardModule.getData()?.metrics;
    if (!m) return;
    const renda = m.totalReceitas || 0;
    const pct = (v) => renda > 0 ? `${((v / renda) * 100).toFixed(0)}% da renda` : (v > 0 ? 'sem receitas no período' : '');
    UIModule.setText('biSurvivalPct',    pct(m.custoDeSobrevivencia));
    UIModule.setText('biLifestylePct',   pct(m.custoDeVida));
    UIModule.setText('biInvestmentsPct', pct(m.aportesInvestimento));
    UIModule.setText('biDebtPct',        pct(m.custoDivida));

    const el = document.getElementById('biSavingsRate');
    if (!el) return;
    el.classList.remove('bi-value--bom', 'bi-value--atencao', 'bi-value--ruim');
    if (renda <= 0) {
        el.textContent = '—';
        UIModule.setText('biSavingsRateDetail', 'lance o que você recebe para calcular');
        return;
    }
    // Poupança = o que sobrou + o que foi investido, sobre a renda.
    const taxa = ((m.saldoDisponivel + m.aportesInvestimento) / renda) * 100;
    el.textContent = `${taxa.toFixed(0)}%`;
    el.classList.add(taxa >= 20 ? 'bi-value--bom' : taxa >= 0 ? 'bi-value--atencao' : 'bi-value--ruim');
    UIModule.setText('biSavingsRateDetail',
        taxa >= 20 ? 'ótimo — você guardou 20% ou mais do que recebeu'
        : taxa >= 0 ? `do que você recebeu · o recomendado é guardar 20%`
        : 'você gastou mais do que recebeu');
}

async function loadClientDashboard() {
    const clientId = ClientModule.getClientId();
    const user     = AuthModule.getUser();

    const perfil = perfilUsuarioCache || (user ? await carregarPerfilUsuario(user.id) : null);
    UIModule.setText('clientNameDisplay', nomeParaSaudacao(perfil));

    // ─────────────────────────────────────────────────────────────
    // Cada bloco abaixo tem o seu PRÓPRIO try/catch, isolado dos
    // outros — uma falha num bloco (ex: dashboard) nunca impede os
    // demais (metas/transações/planejamento) de carregar.
    // ─────────────────────────────────────────────────────────────

    try {
        await DashboardModule.renderClientDashboard(clientId, getFiltroDashboardAtual());
        preencherAnaliseCliente();
        atualizarInfoPeriodoDashboard();
    } catch (error) {
        console.error('❌ loadClientDashboard (resumo/KPIs):', error);
    }

    let metasCliente = [];
    try {
        metasCliente = await GoalsModule.loadClientGoals(clientId);
        GoalsModule.renderGoals('clientMetasList', metasCliente);
    } catch (error) {
        console.error('❌ loadClientDashboard (metas):', error);
    }

    // Carteiras + patrimônio consolidado (carteiras.js). Vem ANTES do
    // histórico porque ele mostra o nome da carteira de cada lançamento.
    // Isolado: se a migração de carteiras ainda não rodou, o módulo se
    // desativa sozinho e nada mais é afetado.
    try {
        if (typeof CarteirasModule !== 'undefined') await CarteirasModule.render(clientId);
    } catch (error) {
        console.error('❌ loadClientDashboard (carteiras):', error);
    }

    // Gamificação (nível, semanas em dia, saúde, missões, cofrinhos,
    // evolução, conquistas) — usa TODO o histórico, não o filtro de
    // período do Resumo. Busca as semanas marcadas e o XP guardado no
    // banco antes de desenhar. Ver gamificacao.js (regras v2).
    try {
        if (typeof GamificacaoModule !== 'undefined') {
            const todas = DashboardModule.getData()?.todasTransacoes || [];
            await GamificacaoModule.render(todas, metasCliente, clientId);
        }
    } catch (error) {
        console.error('❌ loadClientDashboard (gamificação):', error);
    }

    try {
        await loadClientTransactions();
    } catch (error) {
        console.error('❌ loadClientDashboard (transações):', error);
    }

    try {
        await loadClientPlanning();
    } catch (error) {
        console.error('❌ loadClientDashboard (planejamento):', error);
    }
}

// ── FILTRO DE PERÍODO DO DASHBOARD ──────────────────────────────
// Espelha getFiltroHistoricoAtual() (abaixo), mas lendo os controles
// #dashPeriodoRapido/#dashDataInicio/#dashDataFim. Trocar o período
// re-renderiza SÓ o dashboard (rápido), sem tocar em metas/histórico/
// planejamento.
function getFiltroDashboardAtual() {
    const filtro  = {};
    const periodo = document.getElementById('dashPeriodoRapido')?.value || 'todos';

    // Ciclo personalizado do cliente (ex.: 27/05 a 26/06)
    const filtroCiclo = filtroDeCiclo(periodo);
    if (filtroCiclo) return filtroCiclo;

    const hojeStr = typeof getDataDeHojeFormatoInput === 'function'
        ? getDataDeHojeFormatoInput()
        : formatarDataLocal(new Date());

    if (periodo === 'hoje') {
        filtro.dataInicio = hojeStr;
        filtro.dataFim    = hojeStr;
    } else if (periodo === '7dias') {
        const seteDiasAtras = new Date();
        seteDiasAtras.setDate(seteDiasAtras.getDate() - 6);
        filtro.dataInicio = formatarDataLocal(seteDiasAtras);
        filtro.dataFim    = hojeStr;
    } else if (periodo === 'mes') {
        const agora       = new Date();
        const primeiroDia = new Date(agora.getFullYear(), agora.getMonth(), 1);
        filtro.dataInicio = formatarDataLocal(primeiroDia);
        filtro.dataFim    = hojeStr;
    } else if (periodo === 'mes_passado') {
        const agora                = new Date();
        const primeiroDiaMesPassado = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);
        const ultimoDiaMesPassado   = new Date(agora.getFullYear(), agora.getMonth(), 0);
        filtro.dataInicio = formatarDataLocal(primeiroDiaMesPassado);
        filtro.dataFim    = formatarDataLocal(ultimoDiaMesPassado);
    } else if (periodo === 'personalizado') {
        const inicio = document.getElementById('dashDataInicio')?.value;
        const fim    = document.getElementById('dashDataFim')?.value;
        if (inicio) filtro.dataInicio = inicio;
        if (fim)    filtro.dataFim    = fim;
    }
    // periodo === 'todos' -> sem filtro nenhum

    return filtro;
}

async function atualizarDashboardComFiltro() {
    const clientId = ClientModule.getClientId();
    if (!clientId) return;
    await DashboardModule.renderClientDashboard(clientId, getFiltroDashboardAtual());
    preencherAnaliseCliente();
    atualizarInfoPeriodoDashboard();
}

function initDashboardFilters() {
    const selectPeriodo      = document.getElementById('dashPeriodoRapido');
    const linhaPersonalizada = document.getElementById('dashPeriodoPersonalizadoRow');
    const inputInicio        = document.getElementById('dashDataInicio');
    const inputFim           = document.getElementById('dashDataFim');

    if (!selectPeriodo) return; // elemento não existe nesta página — não faz nada

    selectPeriodo.addEventListener('change', () => {
        const personalizado = selectPeriodo.value === 'personalizado';
        linhaPersonalizada?.classList.toggle('hidden', !personalizado);
        atualizarDashboardComFiltro();
    });

    inputInicio?.addEventListener('change', atualizarDashboardComFiltro);
    inputFim?.addEventListener('change', atualizarDashboardComFiltro);
}

// ── HISTÓRICO DE TRANSAÇÕES: cache local + filtros por período ──
let clienteTransacoesCache = [];

async function loadClientTransactions() {
    try {
        const clientId = ClientModule.getClientId();
        clienteTransacoesCache = await DatabaseModule.getTransactionsByClient(clientId);
        renderClientTransactionHistory();
    } catch (error) {
        console.error('Erro transações cliente:', error);
    }
}

function getFiltroHistoricoAtual() {
    const filtro  = {};
    const tipo    = document.getElementById('histFiltroTipo')?.value || '';
    const periodo = document.getElementById('histPeriodoRapido')?.value || 'todos';

    if (tipo) filtro.type = tipo;

    const filtroCiclo = filtroDeCiclo(periodo);
    if (filtroCiclo) { Object.assign(filtro, filtroCiclo); return filtro; }

    const hojeStr = typeof getDataDeHojeFormatoInput === 'function'
        ? getDataDeHojeFormatoInput()
        : formatarDataLocal(new Date());

    if (periodo === 'hoje') {
        filtro.dataInicio = hojeStr;
        filtro.dataFim    = hojeStr;
    } else if (periodo === '7dias') {
        const seteDiasAtras = new Date();
        seteDiasAtras.setDate(seteDiasAtras.getDate() - 6);
        filtro.dataInicio = formatarDataLocal(seteDiasAtras);
        filtro.dataFim    = hojeStr;
    } else if (periodo === 'mes') {
        const agora       = new Date();
        const primeiroDia = new Date(agora.getFullYear(), agora.getMonth(), 1);
        filtro.dataInicio = formatarDataLocal(primeiroDia);
        filtro.dataFim    = hojeStr;
    } else if (periodo === 'mes_passado') {
        const agora                = new Date();
        const primeiroDiaMesPassado = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);
        const ultimoDiaMesPassado   = new Date(agora.getFullYear(), agora.getMonth(), 0);
        filtro.dataInicio = formatarDataLocal(primeiroDiaMesPassado);
        filtro.dataFim    = formatarDataLocal(ultimoDiaMesPassado);
    } else if (periodo === 'personalizado') {
        const inicio = document.getElementById('histDataInicio')?.value;
        const fim    = document.getElementById('histDataFim')?.value;
        if (inicio) filtro.dataInicio = inicio;
        if (fim)    filtro.dataFim    = fim;
    }

    return filtro;
}

function formatarDataLocal(d) {
    const ano = d.getFullYear();
    const mes = String(d.getMonth() + 1).padStart(2, '0');
    const dia = String(d.getDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}`;
}

function renderClientTransactionHistory() {
    const filtro = getFiltroHistoricoAtual();
    TransactionsModule.renderTransactions('transactionHistoryList', filtro, clienteTransacoesCache);
}

function initHistoryFilters() {
    const selectPeriodo      = document.getElementById('histPeriodoRapido');
    const linhaPersonalizada = document.getElementById('histPeriodoPersonalizadoRow');
    const inputInicio        = document.getElementById('histDataInicio');
    const inputFim           = document.getElementById('histDataFim');
    const selectTipo         = document.getElementById('histFiltroTipo');

    if (!selectPeriodo) return;

    selectPeriodo.addEventListener('change', () => {
        const personalizado = selectPeriodo.value === 'personalizado';
        linhaPersonalizada?.classList.toggle('hidden', !personalizado);
        renderClientTransactionHistory();
    });

    inputInicio?.addEventListener('change', renderClientTransactionHistory);
    inputFim?.addEventListener('change', renderClientTransactionHistory);
    selectTipo?.addEventListener('change', renderClientTransactionHistory);
}

async function loadClientPlanning() {
    try {
        const clientId  = ClientModule.getClientId();
        const plannings = await PlanningModule.loadClientPlannings(clientId);

        const container = document.getElementById('clientPlanningList');
        if (container) {
            if (!plannings || plannings.length === 0) {
                container.innerHTML = '<p class="empty-state">Seu consultor ainda não publicou um planejamento. Toque em “Pedir planejamento” para solicitar.</p>';
            } else {
                container.innerHTML = plannings.map(p => `
                    <div class="card" style="margin-bottom: 15px;">
                        <h3>${p.titulo}</h3>
                        ${p.recomendacoes ? `<p style="color:#a0a0b0; margin-top:10px; white-space:pre-line;">${p.recomendacoes}</p>` : ''}
                        ${p.detalhes      ? `<p style="color:#6b7c8f; margin-top:8px; font-size:13px; white-space:pre-line;">${p.detalhes}</p>` : ''}
                    </div>
                `).join('');
            }
        }

        await atualizarAreaSolicitacaoPlanejamento(clientId);
    } catch (error) {
        console.error('Erro planning cliente:', error);
    }
}

// ================================================
// SOLICITAÇÃO DE PLANEJAMENTO (CLIENTE)
// ================================================

async function atualizarAreaSolicitacaoPlanejamento(clientId) {
    const area = document.getElementById('clientPlanningRequestArea');
    if (!area) return;

    try {
        const { data, error } = await supabaseClient
            .from('solicitacoes_planejamento')
            .select('id, created_at')
            .eq('client_id', clientId)
            .eq('status', 'pendente')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) throw error;

        if (data) {
            const dataFormatada = new Date(data.created_at).toLocaleDateString('pt-BR');
            area.innerHTML = `
                <div class="empty-state" style="padding:16px; font-style:normal; text-align:left; background:rgba(100,150,255,0.06); border-radius:10px; border:1px solid rgba(100,150,255,0.15); margin-bottom:15px;">
                    📨 Você solicitou um planejamento em ${dataFormatada}. Seu consultor foi avisado e vai montar em breve.
                </div>
            `;
        } else {
            area.innerHTML = `
                <button type="button" class="btn btn--secondary" onclick="abrirModalSolicitarPlanejamento()" style="margin-bottom:15px;">
                    📩 Pedir planejamento
                </button>
            `;
        }
    } catch (err) {
        console.error('❌ atualizarAreaSolicitacaoPlanejamento:', err.message);
        area.innerHTML = '';
    }
}

function abrirModalSolicitarPlanejamento() {
    const campoMensagem = document.getElementById('solicitarPlanejamentoMensagem');
    if (campoMensagem) campoMensagem.value = '';
    UIModule.openModal('modalSolicitarPlanejamento');
}

async function handleEnviarSolicitacaoPlanejamento() {
    const clientId = ClientModule.getClientId();
    const mensagem = document.getElementById('solicitarPlanejamentoMensagem')?.value.trim() || '';

    const btn = document.getElementById('btnEnviarSolicitacaoPlanejamento');
    if (btn) { btn.disabled = true; btn.textContent = 'Enviando...'; }

    try {
        const { error } = await supabaseClient
            .from('solicitacoes_planejamento')
            .insert({ client_id: clientId, mensagem: mensagem || null });

        if (error) throw error;

        UIModule.closeModal('modalSolicitarPlanejamento');
        UIModule.showSuccess('Pedido enviado! Seu consultor foi avisado.');
        await loadClientPlanning();
    } catch (err) {
        console.error('❌ handleEnviarSolicitacaoPlanejamento:', err.message);
        UIModule.showError(err.message || 'Erro ao enviar a solicitação.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Enviar pedido'; }
    }
}

// ================================================
// EDIÇÃO E EXCLUSÃO DE TRANSAÇÕES
// ================================================

let transacaoEmEdicaoId = null;

async function abrirModalEditarTransacao(transactionId) {
    const transacao = clienteTransacoesCache.find(t => t.id === transactionId);
    if (!transacao) {
        UIModule.showError('Transação não encontrada — tente recarregar a página.');
        return;
    }

    transacaoEmEdicaoId = transactionId;

    document.getElementById('editTransId').value          = transactionId;
    document.getElementById('editTransDescription').value = transacao.descricao || '';
    document.getElementById('editTransValue').value        = transacao.valor;
    document.getElementById('editTransDate').value          = transacao.data_competencia || '';

    await popularCategoriaEdicao(transacao.categoria_id);

    const seletorMeta = document.getElementById('editTransMeta');
    if (seletorMeta) seletorMeta.value = transacao.meta_id || '';
    await atualizarSeletorDeMeta('editTransCategory', 'editTransMetaWrapper', 'editTransMeta');

    if (typeof CarteirasModule !== 'undefined') {
        CarteirasModule.preencherSelect('editTransCarteira', 'editTransCarteiraWrapper', transacao.carteira_id);
    }

    UIModule.openModal('editTransactionModal');
}

async function popularCategoriaEdicao(categoriaSelecionadaId) {
    const trigger     = document.getElementById('editTransCategoryTrigger');
    const triggerText = document.getElementById('editTransCategoryTriggerText');
    const panel       = document.getElementById('editTransCategoryPanel');
    const hiddenInput = document.getElementById('editTransCategory');
    if (!trigger || !triggerText || !panel || !hiddenInput) return;

    trigger.disabled = true;
    triggerText.textContent = 'Carregando categorias...';

    try {
        const categorias = await DatabaseModule.getCategorias();
        panel.innerHTML = montarPainelAgrupado(categorias);

        const categoriaAtual = categorias.find(c => c.id === categoriaSelecionadaId);
        hiddenInput.value        = categoriaSelecionadaId || '';
        triggerText.textContent  = categoriaAtual?.nome || 'Selecione uma categoria';
        trigger.disabled = false;

        if (categoriaAtual) {
            panel.querySelector(`.custom-select__option[data-id="${categoriaAtual.id}"]`)?.classList.add('selected');
        }

        ligarCliquesDoPainelEdicao();
    } catch (err) {
        console.error('❌ popularCategoriaEdicao:', err.message);
        triggerText.textContent = '⚠️ Falha ao carregar — toque para tentar de novo';
        trigger.disabled = false;
    }
}

function ligarCliquesDoPainelEdicao() {
    const panel = document.getElementById('editTransCategoryPanel');
    if (!panel) return;

    panel.querySelectorAll('.custom-select__option').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('editTransCategory').value = btn.dataset.id;
            document.getElementById('editTransCategoryTriggerText').textContent = btn.dataset.nome;

            panel.querySelectorAll('.custom-select__option.selected').forEach(el => el.classList.remove('selected'));
            btn.classList.add('selected');

            fecharPainelEdicaoCategorias();
            atualizarSeletorDeMeta('editTransCategory', 'editTransMetaWrapper', 'editTransMeta');
        });
    });
}

function abrirPainelEdicaoCategorias() {
    const trigger = document.getElementById('editTransCategoryTrigger');
    const panel   = document.getElementById('editTransCategoryPanel');
    if (!trigger || !panel) return;

    posicionarEReparentarPainel(trigger, panel);
    panel.classList.remove('hidden');
    trigger.classList.add('open');
}

function fecharPainelEdicaoCategorias() {
    document.getElementById('editTransCategoryPanel')?.classList.add('hidden');
    document.getElementById('editTransCategoryTrigger')?.classList.remove('open');
}

function initEditCategoryDropdown() {
    const trigger = document.getElementById('editTransCategoryTrigger');
    const wrapper = document.getElementById('editTransCategoryWrapper');
    if (!trigger || !wrapper) return;

    trigger.addEventListener('click', () => {
        const abrindo = document.getElementById('editTransCategoryPanel')?.classList.contains('hidden');
        if (abrindo) abrirPainelEdicaoCategorias();
        else fecharPainelEdicaoCategorias();
    });

    document.addEventListener('click', (e) => {
        const panel = document.getElementById('editTransCategoryPanel');
        if (!wrapper.contains(e.target) && !(panel && panel.contains(e.target))) {
            fecharPainelEdicaoCategorias();
        }
    });
}

async function handleSalvarEdicaoTransacao() {
    const id          = document.getElementById('editTransId').value;
    const descricao   = document.getElementById('editTransDescription').value;
    const categoriaId = document.getElementById('editTransCategory').value;
    const valor       = parseFloat(document.getElementById('editTransValue').value);
    const data        = document.getElementById('editTransDate').value;
    const metaId      = document.getElementById('editTransMeta')?.value || null;
    const carteiraId  = document.getElementById('editTransCarteira')?.value || null;

    if (!categoriaId)          { UIModule.showError('Selecione uma categoria'); return; }
    if (!data)                 { UIModule.showError('A data é obrigatória'); return; }
    if (!valor || valor <= 0)  { UIModule.showError('Informe um valor válido'); return; }

    const btn = document.getElementById('btnSalvarEdicaoTransacao');
    if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }

    try {
        const categorias = await DatabaseModule.getCategorias();
        const cat        = categorias.find(c => c.id === categoriaId);
        if (!cat) throw new Error('Categoria inválida');

        await ClientModule.updateTransaction(id, {
            categoria_id:     categoriaId,
            valor,
            data_competencia: data,
            descricao,
            tipo: cat.tipo,
            meta_id: cat.grupo === 'investimento' ? (metaId || null) : null,
            ...(carteiraId ? { carteira_id: carteiraId } : {})
        });

        fecharModalEdicaoTransacao();
        UIModule.showSuccess('Transação atualizada!');
        await loadClientDashboard();
    } catch (error) {
        UIModule.showError(error.message || 'Erro ao atualizar transação');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Salvar Alterações'; }
    }
}

function fecharModalEdicaoTransacao() {
    fecharPainelEdicaoCategorias();
    UIModule.closeModal('editTransactionModal');
}

async function handleDeletarTransacao() {
    const id = document.getElementById('editTransId').value;
    if (!id) return;
    await excluirTransacaoComConfirmacao(id, fecharModalEdicaoTransacao);
}

async function handleDeletarTransacaoRapido(transactionId) {
    await excluirTransacaoComConfirmacao(transactionId);
}

async function excluirTransacaoComConfirmacao(transactionId, aoConcluir) {
    const alvo = clienteTransacoesCache.find(t => t.id === transactionId);
    const ehTransferencia = !!alvo?.transferencia_id;
    const pergunta = ehTransferencia
        ? 'Esta transação é uma transferência entre carteiras. Excluir também remove a outra ponta (saída e entrada saem juntas). Continuar?'
        : 'Tem certeza que deseja excluir esta transação? Esta ação não pode ser desfeita.';
    if (!confirm(pergunta)) return;

    try {
        await ClientModule.deleteTransaction(transactionId);
        UIModule.showSuccess('Transação excluída!');
        if (typeof aoConcluir === 'function') aoConcluir();
        await loadClientDashboard();
    } catch (error) {
        UIModule.showError(error.message || 'Erro ao excluir transação');
    }
}

// ── ADICIONAR TRANSAÇÃO (CLIENTE) ──

async function handleAddTransaction(event) {
    event.preventDefault();

    if (typeof aguardarClassificacaoSmartInputPendente === 'function') {
        await aguardarClassificacaoSmartInputPendente();
    }

    if (!document.getElementById('transCategory').value &&
        typeof autoClassify === 'function') {
        const descricaoAtual = document.getElementById('transDescription').value.trim();
        if (descricaoAtual) await autoClassify(descricaoAtual);
    }

    const clientId    = ClientModule.getClientId();
    const categoriaId = document.getElementById('transCategory').value;
    const valor       = parseFloat(document.getElementById('transValue').value);
    const data        = document.getElementById('transDate').value;
    const descricao   = document.getElementById('transDescription').value;
    const metaId      = document.getElementById('transMeta')?.value || null;
    const carteiraId  = document.getElementById('transCarteira')?.value || null;

    if (!categoriaId) { UIModule.showError('Selecione uma categoria'); return; }
    if (!data)         { UIModule.showError('A data é obrigatória'); return; }

    try {
        const categorias = await DatabaseModule.getCategorias();
        const cat        = categorias.find(c => c.id === categoriaId);
        if (!cat) throw new Error('Categoria inválida');

        await ClientModule.addTransaction({
            client_id:        clientId,
            categoria_id:     categoriaId,
            valor,
            data_competencia: data,
            descricao,
            tipo: cat.tipo,
            meta_id: cat.grupo === 'investimento' ? (metaId || null) : null,
            // Sem carteira escolhida (ou migração pendente) o campo nem é enviado:
            // o banco usa a carteira principal.
            ...(carteiraId ? { carteira_id: carteiraId } : {})
        });

        if (typeof RegrasAprendidasModule !== 'undefined' && descricao.trim()) {
            try {
                await RegrasAprendidasModule.salvarOuAtualizarRegra({
                    clienteId:   clientId,
                    termoBusca:  descricao,
                    categoriaId: cat.id,
                    tipo:        cat.tipo
                });
            } catch (regraErr) {
                console.warn('⚠️ Falha ao salvar regra aprendida (transação já foi registrada normalmente):', regraErr.message);
            }
        }

        event.target.reset();

        // reset() volta o seletor de carteira ao primeiro item; restaura a última usada
        if (typeof CarteirasModule !== 'undefined') CarteirasModule.atualizarSelects();

        if (typeof initForm === 'function') {
            initForm(true);
        }

        atualizarSeletorDeMeta('transCategory', 'transMetaWrapper', 'transMeta');

        document.getElementById('transDescription')?.focus();

        UIModule.showSuccess('Transação registrada!');
        await loadClientDashboard();
    } catch (error) {
        UIModule.showError(error.message || 'Erro ao registrar transação');
    }
}

// ================================================
// VÍNCULO OPCIONAL: TRANSAÇÃO → META/CAIXINHA
// ================================================

async function atualizarSeletorDeMeta(idCategoriaHidden, idWrapper, idSelect) {
    const wrapper        = document.getElementById(idWrapper);
    const select          = document.getElementById(idSelect);
    const categoriaAtual  = document.getElementById(idCategoriaHidden)?.value;
    if (!wrapper || !select) return;

    if (!categoriaAtual) {
        wrapper.classList.add('hidden');
        select.value = '';
        return;
    }

    try {
        const categorias = typeof getCategoriasParaClassificacao === 'function'
            ? await getCategoriasParaClassificacao()
            : await DatabaseModule.getCategorias();

        const categoria = categorias.find(c => c.id === categoriaAtual);

        if (!categoria || categoria.grupo !== 'investimento') {
            wrapper.classList.add('hidden');
            select.value = '';
            return;
        }

        const clientId = ClientModule.getClientId();
        const metas    = await DatabaseModule.getMetasByClient(clientId);

        if (!metas.length) {
            wrapper.classList.add('hidden');
            select.value = '';
            return;
        }

        const valorSelecionadoAntes = select.value;

        select.innerHTML = '<option value="">Nenhuma meta</option>' +
            metas.map(m => `<option value="${m.id}">${m.nome}</option>`).join('');

        if (valorSelecionadoAntes && metas.some(m => m.id === valorSelecionadoAntes)) {
            select.value = valorSelecionadoAntes;
        }

        wrapper.classList.remove('hidden');
    } catch (err) {
        console.error('❌ atualizarSeletorDeMeta:', err.message);
        wrapper.classList.add('hidden');
    }
}

// ── ADICIONAR META (CLIENTE) ──

async function handleAddMeta(event) {
    event.preventDefault();
    const clientId = ClientModule.getClientId();
    const nome     = document.getElementById('metaName').value.trim();
    const valor    = parseFloat(document.getElementById('metaValue').value);

    try {
        await ClientModule.addGoal({ client_id: clientId, nome, valor_necessario: valor, valor_economizado: 0 });
        event.target.reset();
        UIModule.showSuccess('Meta criada!');
        await loadClientDashboard();
    } catch (_) { UIModule.showError('Erro ao criar meta'); }
}

// ── PERFIL CLIENTE ──
// Nome completo, apelido e e-mail em linhas separadas — o e-mail
// nunca aparece no lugar do nome.

async function showClientProfile() {
    const user   = AuthModule.getUser();
    const perfil = perfilUsuarioCache || (user ? await carregarPerfilUsuario(user.id) : null);

    UIModule.setText('profileClientName',     perfil?.nome_completo || 'Nome não informado');
    UIModule.setText('profileClientNickname', perfil?.apelido       || '—');
    UIModule.setText('profileClientEmail',    user?.email           || '');
    preencherCamposDeCicloNoPerfil();
    if (typeof NotificacoesModule !== 'undefined') NotificacoesModule.atualizarBotaoAvisos();
    if (typeof SomModule !== 'undefined') SomModule.atualizarBotoes();
    UIModule.openModal('clientProfileModal');
}

// ================================================
// INICIALIZAÇÃO
// ================================================

async function waitForSupabase(maxAttempts = 20) {
    for (let i = 0; i < maxAttempts; i++) {
        if (typeof supabaseClient !== 'undefined' && supabaseClient !== null) return true;
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}

// ================================================
// CATEGORIAS (plano de contas)
// ================================================

let categoriasEstado = 'idle'; // 'idle' | 'carregando' | 'ok' | 'vazio' | 'erro'

const GRUPO_LABEL_SELECT = {
    essencial:      '🏠 Contas obrigatórias (casa, mercado, saúde, transporte)',
    estilo_de_vida: '🎯 Lazer, delivery e compras',
    investimento:   '💰 Guardar dinheiro (reserva e investimentos)',
    divida:         '💳 Parcelas e dívidas',
    transferencia:  '🔄 Entre suas contas (não é gasto)',
    renda:          '📈 Dinheiro que entrou'
};

function setCategorySelectState(state, categorias = []) {
    const trigger     = document.getElementById('transCategoryTrigger');
    const triggerText = document.getElementById('transCategoryTriggerText');
    const panel       = document.getElementById('transCategoryPanel');
    const hiddenInput = document.getElementById('transCategory');
    if (!trigger || !triggerText || !panel || !hiddenInput) return;

    fecharPainelDeCategorias();

    if (state === 'carregando') {
        trigger.disabled = true;
        triggerText.textContent = 'Carregando categorias...';
        panel.innerHTML = '';
        hiddenInput.value = '';
    } else if (state === 'ok') {
        trigger.disabled = false;
        triggerText.textContent = 'Selecione uma categoria';
        hiddenInput.value = '';
        panel.innerHTML = montarPainelAgrupado(categorias);
        ligarCliquesDoPainel();
    } else if (state === 'vazio') {
        trigger.disabled = true;
        triggerText.textContent = 'Nenhuma categoria cadastrada';
        panel.innerHTML = '';
        hiddenInput.value = '';
    } else if (state === 'erro') {
        trigger.disabled = false;
        triggerText.textContent = '⚠️ Falha ao carregar — toque aqui para tentar de novo';
        panel.innerHTML = '';
        hiddenInput.value = '';
    }
}

// Grupos de despesa primeiro (fluxo do dia a dia), renda por último —
// dentro do dropdown do formulário. A convenção "Receita antes de
// Despesa" pedida se aplica aos RESUMOS/LISTAS (Resumo do Mês,
// Histórico, listas do admin); aqui o agrupamento por finalidade
// (essencial/estilo de vida/... /renda) é intencionalmente mantido,
// pois é assim que o cliente naturalmente busca uma categoria de
// GASTO do dia a dia primeiro.
const ORDEM_GRUPOS = ['essencial', 'estilo_de_vida', 'investimento', 'divida', 'transferencia', 'renda'];

function montarPainelAgrupado(categorias) {
    const porGrupo = {};
    categorias.forEach(c => {
        const grupo = c.grupo || 'outros';
        if (!porGrupo[grupo]) porGrupo[grupo] = [];
        porGrupo[grupo].push(c);
    });

    const grupos = [
        ...ORDEM_GRUPOS.filter(g => porGrupo[g]),
        ...Object.keys(porGrupo).filter(g => !ORDEM_GRUPOS.includes(g))
    ];

    return grupos.map(grupo => {
        const label   = GRUPO_LABEL_SELECT[grupo] || grupo;
        const options = porGrupo[grupo]
            .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
            .map(c => `<button type="button" class="custom-select__option" data-id="${c.id}" data-nome="${c.nome}">${c.nome}</button>`)
            .join('');
        return `
            <div class="custom-select__group">
                <div class="custom-select__group-label">${label}</div>
                ${options}
            </div>
        `;
    }).join('');
}

function posicionarEReparentarPainel(trigger, panel) {
    if (panel.parentElement !== document.body) {
        document.body.appendChild(panel);
    }

    const rect            = trigger.getBoundingClientRect();
    const margem           = 10;
    // iOS 27 beta: visualViewport.height reflete a área visível real quando
    // o teclado virtual está aberto — window.innerHeight não é confiável.
    const alturaJanela     = window.visualViewport?.height ?? window.innerHeight;
    const espacoAbaixo      = alturaJanela - rect.bottom - margem;
    const espacoAcima       = rect.top - margem;
    const alturaMaximaBase  = 280;
    const abreParaCima      = espacoAbaixo < 160 && espacoAcima > espacoAbaixo;
    const alturaDisponivel  = abreParaCima ? espacoAcima : espacoAbaixo;

    panel.style.position  = 'fixed';
    panel.style.left      = `${rect.left}px`;
    panel.style.width     = `${rect.width}px`;
    panel.style.maxHeight = `${Math.max(120, Math.min(alturaMaximaBase, alturaDisponivel))}px`;

    if (abreParaCima) {
        panel.style.top    = 'auto';
        panel.style.bottom = `${alturaJanela - rect.top + 6}px`;
    } else {
        panel.style.top    = `${rect.bottom + 6}px`;
        panel.style.bottom = 'auto';
    }
}

function religarReposicionamentoAoRedimensionar() {
    window.addEventListener('resize', () => {
        const combinacoes = [
            ['transCategoryTrigger', 'transCategoryPanel'],
            ['editTransCategoryTrigger', 'editTransCategoryPanel']
        ];
        combinacoes.forEach(([triggerId, panelId]) => {
            const trigger = document.getElementById(triggerId);
            const panel   = document.getElementById(panelId);
            if (trigger && panel && !panel.classList.contains('hidden')) {
                posicionarEReparentarPainel(trigger, panel);
            }
        });
    });
}

function handleScrollGlobalFechaPaineisCategoria(e) {
    const paineis = [
        { id: 'transCategoryPanel',     fechar: fecharPainelDeCategorias },
        { id: 'editTransCategoryPanel', fechar: fecharPainelEdicaoCategorias }
    ];

    paineis.forEach(({ id, fechar }) => {
        const panel = document.getElementById(id);
        if (!panel || panel.classList.contains('hidden')) return;

        const alvo = e.target;
        if (alvo && panel.contains(alvo)) return;

        fechar();
    });
}

function religarFechamentoAoRolar() {
    document.addEventListener('scroll', handleScrollGlobalFechaPaineisCategoria, true);
}

function ligarCliquesDoPainel() {
    const panel = document.getElementById('transCategoryPanel');
    if (!panel) return;

    panel.querySelectorAll('.custom-select__option').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('transCategory').value = btn.dataset.id;
            document.getElementById('transCategoryTriggerText').textContent = btn.dataset.nome;

            panel.querySelectorAll('.custom-select__option.selected').forEach(el => el.classList.remove('selected'));
            btn.classList.add('selected');

            fecharPainelDeCategorias();
            atualizarSeletorDeMeta('transCategory', 'transMetaWrapper', 'transMeta');
        });
    });
}

function abrirPainelDeCategorias() {
    const trigger = document.getElementById('transCategoryTrigger');
    const panel   = document.getElementById('transCategoryPanel');
    if (!trigger || !panel) return;

    posicionarEReparentarPainel(trigger, panel);
    panel.classList.remove('hidden');
    trigger.classList.add('open');
}

function fecharPainelDeCategorias() {
    document.getElementById('transCategoryPanel')?.classList.add('hidden');
    document.getElementById('transCategoryTrigger')?.classList.remove('open');
}

async function populateCategorySelect() {
    categoriasEstado = 'carregando';
    setCategorySelectState('carregando');

    try {
        const categorias = await DatabaseModule.getCategorias();

        if (!categorias || categorias.length === 0) {
            categoriasEstado = 'vazio';
            setCategorySelectState('vazio');
            console.warn('⚠️ categorias retornou vazio (0 categorias).');
            return;
        }

        categoriasEstado = 'ok';
        setCategorySelectState('ok', categorias);
    } catch (err) {
        categoriasEstado = 'erro';
        setCategorySelectState('erro');
        console.error('❌ Erro ao carregar categorias:', err.message);
        UIModule.showError('Não foi possível carregar as categorias. Toque no campo para tentar de novo.');
    }
}

async function garantirCategoriasCarregadas() {
    if (categoriasEstado === 'ok' || categoriasEstado === 'carregando') return;
    await populateCategorySelect();
}

function initTransCategoryRetry() {
    const trigger = document.getElementById('transCategoryTrigger');
    const wrapper = document.getElementById('transCategoryWrapper');
    if (!trigger || !wrapper) return;

    trigger.addEventListener('click', () => {
        if (categoriasEstado === 'erro' || categoriasEstado === 'vazio') {
            populateCategorySelect();
            return;
        }
        const abrindo = document.getElementById('transCategoryPanel')?.classList.contains('hidden');
        if (abrindo) abrirPainelDeCategorias();
        else fecharPainelDeCategorias();
    });

    document.addEventListener('click', (e) => {
        const panel = document.getElementById('transCategoryPanel');
        if (!wrapper.contains(e.target) && !(panel && panel.contains(e.target))) {
            fecharPainelDeCategorias();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') fecharPainelDeCategorias();
    });
}

/**
 * Campo de mensagem: cresce sozinho conforme o texto (até ~6 linhas).
 * Enter envia / Shift+Enter quebra linha já é tratado em
 * mensagens-cliente.js.
 */
function initAutoResizeMensagem() {
    const campo = document.getElementById('mensagemTexto');
    if (!campo) return;
    const ajustar = () => {
        campo.style.height = 'auto';
        campo.style.height = Math.min(campo.scrollHeight, 160) + 'px';
    };
    campo.addEventListener('input', ajustar);
}

// ================================================
// LOGIN COM GOOGLE (Supabase OAuth)
// ================================================
// Requer o provedor Google ATIVO em Supabase → Authentication →
// Sign In / Providers → Google (Client ID + Secret do Google Cloud) e
// a URL deste site em Authentication → URL Configuration → Redirect URLs.
// Na volta do Google, o supabase-js lê o token da URL e o
// initializeApp() → checkSession() segue o fluxo normal: conta nova cai
// no onboarding (nome/apelido), conta existente vai direto ao painel.
async function loginComGoogle() {
    const botoes = document.querySelectorAll('.btn-google');
    botoes.forEach(b => { b.disabled = true; });
    try {
        const { error } = await supabaseClient.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: window.location.origin + window.location.pathname,
                queryParams: { prompt: 'select_account' }
            }
        });
        if (error) throw error;
    } catch (error) {
        botoes.forEach(b => { b.disabled = false; });
        const msg = /provider is not enabled|Unsupported provider/i.test(error.message || '')
            ? 'Login com Google ainda não está ativado. Use e-mail e senha por enquanto.'
            : 'Não foi possível entrar com Google. Tente novamente.';
        mostrarErroLogin(msg);
        console.error('❌ loginComGoogle:', error);
    }
}

function mostrarErroLogin(msg) {
    const el = document.getElementById('loginError');
    if (el) { el.textContent = msg; el.classList.remove('hidden'); }
    else UIModule.showError(msg);
}

/** Se o Google/Supabase devolveu erro na URL (?error=... ou #error=...), mostra no login. */
function tratarRetornoOAuth() {
    const params = new URLSearchParams(window.location.search + '&' + window.location.hash.replace(/^#/, ''));
    const erro = params.get('error_description') || params.get('error');
    if (!erro) return;
    console.error('❌ Retorno OAuth:', erro);
    const msg = /database error/i.test(erro)
        ? 'Sua conta Google foi reconhecida, mas o cadastro não pôde ser concluído. Avise o administrador.'
        : 'Não foi possível entrar com Google: ' + erro.replace(/\+/g, ' ');
    history.replaceState(null, '', window.location.pathname);
    setTimeout(() => mostrarErroLogin(msg), 0);
}

/** Onboarding de conta Google: já sugere o nome que veio do Google. */
function preencherOnboardingComMetadados(user) {
    const meta = user?.user_metadata || {};
    const nome = (meta.full_name || meta.name || '').trim();
    const campoNome = document.getElementById('onboardingNome');
    const campoApelido = document.getElementById('onboardingApelido');
    if (campoNome && !campoNome.value && nome && nome.toLowerCase() !== (user.email || '').toLowerCase()) {
        campoNome.value = nome;
    }
    if (campoApelido && !campoApelido.value && nome) {
        campoApelido.value = (meta.given_name || nome.split(' ')[0] || '').trim();
    }
}

async function initializeApp() {
    initTransCategoryRetry();
    initHistoryFilters();
    initDashboardFilters();
    initEditCategoryDropdown();
    initAutoResizeMensagem();
    religarReposicionamentoAoRedimensionar();
    religarFechamentoAoRolar();

    try {
        const ok = await waitForSupabase();
        if (!ok) throw new Error('Supabase não inicializou');

        tratarRetornoOAuth();

        const user = await AuthModule.checkSession();
        if (user) {
            // Limpa o token do Google que fica no endereço após o login.
            if (/access_token|[?&]code=/.test(window.location.href)) {
                history.replaceState(null, '', window.location.pathname);
            }
            await routeByRole(user, AuthModule.getUserRole());
        } else {
            // "Criar minha conta" vindo da demonstração → abre o cadastro.
            UIModule.showScreen(window.location.hash === '#criar-conta' ? 'registerScreen' : 'loginScreen');
        }

        console.log('✅ App (cliente) inicializado');
    } catch (error) {
        console.error('❌ Erro ao inicializar:', error);
        UIModule.showError('Erro ao inicializar a aplicação');
        UIModule.showScreen('loginScreen');
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}

console.log('✅ app.js (cliente) carregado');
