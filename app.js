/**
 * APP.JS - ORQUESTRADOR DO PAINEL DO CLIENTE
 * ================================================
 * Este ficheiro (usado por index.html e client.html) cuida
 * SOMENTE do fluxo do cliente (login, registo, onboarding,
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
// ROTEAMENTO PÓS-LOGIN (RBAC)
// ================================================

async function routeByRole(user, role) {
    if (role === 'admin') {
        window.location.href = 'admin.html';
        return;
    }

    const needsOnboarding = await checkOnboarding(user, role);
    if (needsOnboarding) {
        UIModule.showScreen('onboardingScreen');
        return;
    }

    await garantirClienteExiste(user);

    try {
        const { data: usuario } = await supabaseClient
            .from(CONFIG.TABLES.USUARIOS)
            .select('apelido')
            .eq('id', user.id)
            .maybeSingle();
        if (usuario?.apelido) {
            UIModule.setText('clientNameDisplay', usuario.apelido);
        }
    } catch (_) {}

    ClientModule.setClientId(user.id);
    await populateCategorySelect();
    UIModule.showScreen('clientScreen');
    await loadClientDashboard();

    if (typeof MensagensModule !== 'undefined') {
        MensagensModule.inicializar(user.id).catch(() => {});
    }
}

async function garantirClienteExiste(user) {
    try {
        const { data: jaExiste, error: selectError } = await supabaseClient
            .from(CONFIG.TABLES.CLIENTES)
            .select('id')
            .eq('id', user.id)
            .maybeSingle();

        if (selectError) throw selectError;
        if (jaExiste) return;

        const { data: usuario } = await supabaseClient
            .from(CONFIG.TABLES.USUARIOS)
            .select('nome_completo, apelido')
            .eq('id', user.id)
            .maybeSingle();

        const nome = usuario?.nome_completo || usuario?.apelido || user.email?.split('@')[0] || 'Cliente';

        const { error: rpcError } = await supabaseClient.rpc('reconciliar_cliente_no_registro', {
            p_nome:  nome,
            p_email: user.email
        });

        if (rpcError) throw rpcError;

        console.log('✅ garantirClienteExiste: linha em clientes criada/reconciliada retroativamente para', user.email);
    } catch (error) {
        console.error('❌ garantirClienteExiste: falha ao verificar/criar linha em clientes:', error.message);
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
        showLoginError('Preenche o email e a senha.');
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
                'Email não encontrado ou senha incorreta.',
                `Não tens conta? <a href="#" onclick="toggleScreen('registerScreen'); return false;" style="color:#6495ff; font-weight:700;">Criar conta grátis</a>`
            );
        } else if (msg.includes('Email not confirmed')) {
            showLoginError('Email ainda não confirmado. Verifica a tua caixa de entrada.');
        } else {
            showLoginError(msg || 'Erro ao entrar. Tenta novamente.');
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

// ================================================
// CADASTRO — USUARIOS + USUARIOS_PERFIS
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
        showErr('Preenche todos os campos.'); return;
    }
    if (password.length < 6) { showErr('Senha mínima de 6 caracteres.'); return; }
    if (password !== confirm) { showErr('As senhas não coincidem.'); return; }

    const btn = event.target.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Criando conta...'; }

    try {
        const user = await AuthModule.register(email, password);

        await supabaseClient.from(CONFIG.TABLES.USUARIOS).insert([{
            id:            user.id,
            nome_completo: nome,
            apelido:       apelido,
            created_at:    new Date().toISOString()
        }]);

        await supabaseClient.from(CONFIG.TABLES.USUARIOS_PERFIS).insert([{
            usuario_id: user.id,
            perfil:     'client',
            created_at: new Date().toISOString()
        }]);

        await supabaseClient.rpc('reconciliar_cliente_no_registro', {
            p_nome:  nome,
            p_email: email
        });

        UIModule.showSuccess(`Conta criada! Bem-vindo, ${apelido}! Faz login agora.`);
        setTimeout(() => UIModule.showScreen('loginScreen'), 2000);

    } catch (error) {
        const msg = error.message || '';
        if (msg.includes('already registered') || msg.includes('already been registered')) {
            showErr('Este email já tem uma conta. Faz login.');
        } else {
            showErr(msg || 'Erro ao criar conta.');
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Criar Conta'; }
    }
}

// ================================================
// ONBOARDING — USUARIOS + USUARIOS_PERFIS
// ================================================

async function checkOnboarding(user, role) {
    if (role === 'admin') return false;

    try {
        const { data } = await supabaseClient
            .from(CONFIG.TABLES.USUARIOS)
            .select('nome_completo, apelido')
            .eq('id', user.id)
            .maybeSingle();

        if (!data || !data.nome_completo || !data.apelido) return true;
        return false;
    } catch (_) {
        return true;
    }
}

async function handleOnboarding(event) {
    event.preventDefault();
    const nome    = document.getElementById('onboardingNome').value.trim();
    const apelido = document.getElementById('onboardingApelido').value.trim();
    const user    = AuthModule.getUser();

    if (!nome || !apelido) { UIModule.showError('Preenche todos os campos'); return; }

    const btn = event.target.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }

    try {
        const { error: usuarioError } = await supabaseClient
            .from(CONFIG.TABLES.USUARIOS)
            .upsert({
                id:            user.id,
                nome_completo: nome,
                apelido:       apelido,
                created_at:    new Date().toISOString()
            });
        if (usuarioError) throw usuarioError;

        const { data: jaTemPerfil, error: selectError } = await supabaseClient
            .from(CONFIG.TABLES.USUARIOS_PERFIS)
            .select('id')
            .eq('usuario_id', user.id)
            .maybeSingle();
        if (selectError) throw selectError;

        if (!jaTemPerfil) {
            const { error: insertError } = await supabaseClient
                .from(CONFIG.TABLES.USUARIOS_PERFIS)
                .insert([{
                    usuario_id: user.id,
                    perfil:     'client',
                    created_at: new Date().toISOString()
                }]);
            if (insertError) throw insertError;
        }

        const { data: jaExisteCliente } = await supabaseClient
            .from(CONFIG.TABLES.CLIENTES)
            .select('id')
            .eq('id', user.id)
            .maybeSingle();

        if (!jaExisteCliente) {
            const { error: rpcError } = await supabaseClient.rpc('reconciliar_cliente_no_registro', {
                p_nome:  nome,
                p_email: user.email
            });
            if (rpcError) throw rpcError;
        }

        UIModule.showSuccess(`Bem-vindo, ${apelido}! 🎉`);

        ClientModule.setClientId(user.id);
        UIModule.setText('clientNameDisplay', apelido);
        await populateCategorySelect();
        UIModule.showScreen('clientScreen');
        await loadClientDashboard();

        if (typeof MensagensModule !== 'undefined') {
            MensagensModule.inicializar(user.id).catch(() => {});
        }
    } catch (error) {
        console.error('❌ Erro em handleOnboarding:', error);
        UIModule.showError(error.message || 'Erro ao salvar perfil');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Continuar →'; }
    }
}

// ================================================
// LOGOUT
// ================================================

async function handleLogout() {
    if (!confirm('Tens a certeza que queres sair?')) return;

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

async function loadClientDashboard() {
    const clientId = ClientModule.getClientId();
    const user     = AuthModule.getUser();

    try {
        const { data: usuario } = await supabaseClient
            .from(CONFIG.TABLES.USUARIOS).select('apelido').eq('id', user.id).maybeSingle();
        UIModule.setText('clientNameDisplay', usuario?.apelido || user?.email?.split('@')[0] || 'Cliente');
    } catch (_) {
        UIModule.setText('clientNameDisplay', user?.email?.split('@')[0] || 'Cliente');
    }

    // ─────────────────────────────────────────────────────────────
    // Cada bloco abaixo tem o seu PRÓPRIO try/catch, isolado dos
    // outros — uma falha num bloco (ex: dashboard) nunca impede os
    // demais (metas/transações/planejamento) de carregar.
    // ─────────────────────────────────────────────────────────────

    try {
        await DashboardModule.renderClientDashboard(clientId, getFiltroDashboardAtual());
    } catch (error) {
        console.error('❌ loadClientDashboard (resumo/KPIs):', error);
    }

    try {
        const goals = await GoalsModule.loadClientGoals(clientId);
        GoalsModule.renderGoals('clientMetasList', goals);
    } catch (error) {
        console.error('❌ loadClientDashboard (metas):', error);
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
                container.innerHTML = '<p class="empty-state">Aguardando planejamento do administrador...</p>';
            } else {
                container.innerHTML = plannings.map(p => `
                    <div class="card" style="margin-bottom: 15px;">
                        <h3>${p.titulo}</h3>
                        ${p.recomendacoes ? `<p style="color:#a0a0b0; margin-top:10px;">${p.recomendacoes}</p>` : ''}
                        ${p.detalhes      ? `<p style="color:#6b7c8f; margin-top:8px; font-size:13px;">${p.detalhes}</p>` : ''}
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
                    📨 Você solicitou um planejamento em ${dataFormatada}. O administrador foi avisado e vai criar em breve.
                </div>
            `;
        } else {
            area.innerHTML = `
                <button type="button" class="btn btn--secondary" onclick="abrirModalSolicitarPlanejamento()" style="margin-bottom:15px;">
                    📩 Solicitar Planejamento
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
        UIModule.showSuccess('Solicitação enviada! O administrador foi avisado.');
        await loadClientPlanning();
    } catch (err) {
        console.error('❌ handleEnviarSolicitacaoPlanejamento:', err.message);
        UIModule.showError(err.message || 'Erro ao enviar a solicitação.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Enviar Solicitação'; }
    }
}

// ================================================
// EDIÇÃO E EXCLUSÃO DE TRANSAÇÕES
// ================================================

let transacaoEmEdicaoId = null;

async function abrirModalEditarTransacao(transactionId) {
    const transacao = clienteTransacoesCache.find(t => t.id === transactionId);
    if (!transacao) {
        UIModule.showError('Transação não encontrada — tenta recarregar a página.');
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

    if (!categoriaId)          { UIModule.showError('Seleciona uma categoria'); return; }
    if (!data)                 { UIModule.showError('Data é obrigatória'); return; }
    if (!valor || valor <= 0)  { UIModule.showError('Informa um valor válido'); return; }

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
            meta_id: cat.grupo === 'investimento' ? (metaId || null) : null
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
    if (!confirm('Tens a certeza que queres excluir esta transação? Esta ação não pode ser desfeita.')) return;

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

    if (!categoriaId) { UIModule.showError('Seleciona uma categoria'); return; }
    if (!data)         { UIModule.showError('Data é obrigatória'); return; }

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
            meta_id: cat.grupo === 'investimento' ? (metaId || null) : null
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

        if (typeof initForm === 'function') {
            initForm(true);
        }

        atualizarSeletorDeMeta('transCategory', 'transMetaWrapper', 'transMeta');

        document.getElementById('transDescription')?.focus();

        UIModule.showSuccess('Transação registada!');
        await loadClientDashboard();
    } catch (error) {
        UIModule.showError(error.message || 'Erro ao registar transação');
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

        select.innerHTML = '<option value="">Não vincular a nenhuma meta</option>' +
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

function showClientProfile() {
    const user = AuthModule.getUser();
    UIModule.setText('profileClientName', user?.user_metadata?.name || user?.email || 'Cliente');
    UIModule.setText('profileClientEmail', user?.email || '');
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
    essencial:      '🟠 Essenciais',
    estilo_de_vida: '🎯 Estilo de Vida',
    investimento:   '💰 Investimentos',
    divida:         '💳 Dívidas e Financiamentos',
    transferencia:  '🔄 Transferências Internas',
    renda:          '📈 Renda'
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
    const espacoAbaixo      = window.innerHeight - rect.bottom - margem;
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
        panel.style.bottom = `${window.innerHeight - rect.top + 6}px`;
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

async function initializeApp() {
    initTransCategoryRetry();
    initHistoryFilters();
    initDashboardFilters();
    initEditCategoryDropdown();
    religarReposicionamentoAoRedimensionar();
    religarFechamentoAoRolar();

    try {
        const ok = await waitForSupabase();
        if (!ok) throw new Error('Supabase não inicializou');

        const user = await AuthModule.checkSession();
        if (user) {
            await routeByRole(user, AuthModule.getUserRole());
        } else {
            UIModule.showScreen('loginScreen');
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
