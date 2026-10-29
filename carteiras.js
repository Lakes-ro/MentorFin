/**
 * CARTEIRAS.JS — Carteiras visuais, saldo inicial e patrimônio consolidado
 * ================================================
 * Padrão: script global (IIFE `CarteirasModule`). Sem import/export.
 * Depende de (carregados ANTES): config.js (supabaseClient), seguranca.js
 * (escaparHtml), ui.js (UIModule), client.js (ClientModule).
 * Requer a migração MIGRACAO-carteiras.sql (tabela `carteiras`, view
 * `v_carteiras_saldo`, RPCs `transferir_entre_carteiras` e
 * `definir_carteira_padrao`, colunas `transacoes.carteira_id` /
 * `transferencia_id`).
 *
 * COMO O SALDO É CALCULADO (tudo no banco, ver v_carteiras_saldo):
 *   saldo_atual = saldo_inicial
 *               + receitas efetivadas  (data_competencia >= data_saldo_inicial)
 *               − despesas efetivadas  (data_competencia >= data_saldo_inicial)
 * O saldo inicial NÃO é receita: não entra em DRE, dashboard nem gamificação.
 * Transferência entre carteiras = 2 transações (saída + entrada) de categoria
 * "Transferência", que o resto do sistema já ignora em receitas/despesas e que
 * somam zero no patrimônio consolidado.
 *
 * SE A MIGRAÇÃO AINDA NÃO RODOU: o módulo detecta (tabela/view ausente), esconde
 * o painel e o restante do app continua funcionando como antes.
 *
 * GUIA "QUANTO VOCÊ TEM HOJE?" (pop-up passo a passo): abre sozinho quando o cliente
 * não tem carteira ou tem alguma com saldo inicial não informado (espera o tour fechar;
 * "Agora não" adia por 2 dias). Pode ser reaberto pelo botão do aviso.
 *
 * SALDO "HOJE": o cliente sempre informa quanto tem HOJE (como no app do banco). O módulo
 * converte isso em saldo_inicial = saldo_hoje − (entradas − saídas já lançadas), assim o
 * histórico continua somando e o saldo atual bate com o valor informado.
 *
 * CAIXINHAS / INVESTIMENTOS: dinheiro investido dentro de um banco é uma carteira própria
 * (tipo 'investimento', mesmo banco/logo). Patrimônio = disponível em contas + investido.
 * Aplicação/Resgate RDB do extrato gera a ponta espelho na carteira de investimentos do banco.
 *
 * API pública:
 *   render(clientId)                         → carrega + desenha painel + selects
 *   atualizarSelects()                       → #transCarteira e #importCarteira
 *   preencherSelect(selectId, wrapperId, id) → usado pelo modal de edição
 *   nomeDaCarteira(id)                       → nome (só quando há 2+ carteiras)
 *   abrirNova() / abrirTransferencia(id) / abrirGuia()
 *   carteiraDeDestino(id) / irmaInvestimento(carteiraId)   → usados pela importação de extrato
 *   estaDisponivel()
 */

const CarteirasModule = (() => {

    // ── Instituições (marca = texto curto dentro do quadradinho colorido) ──
    const INSTITUICOES = [
        { id: 'nubank',      label: 'Nubank',          cor: '#8A05BE', texto: '#fff',    marca: 'nu' },
        { id: 'itau',        label: 'Itaú',            cor: '#EC7000', texto: '#fff',    marca: 'itaú' },
        { id: 'picpay',      label: 'PicPay',          cor: '#21C25E', texto: '#fff',    marca: 'P' },
        { id: 'bradesco',    label: 'Bradesco',        cor: '#CC092F', texto: '#fff',    marca: 'B' },
        { id: 'inter',       label: 'Inter',           cor: '#FF7A00', texto: '#fff',    marca: 'in' },
        { id: 'santander',   label: 'Santander',       cor: '#EC0000', texto: '#fff',    marca: 'S' },
        { id: 'bb',          label: 'Banco do Brasil', cor: '#F9D71C', texto: '#1d2b53', marca: 'bb' },
        { id: 'caixa',       label: 'Caixa',           cor: '#0070AF', texto: '#fff',    marca: 'cx' },
        { id: 'c6',          label: 'C6 Bank',         cor: '#2B2B2B', texto: '#fff',    marca: 'c6' },
        { id: 'mercadopago', label: 'Mercado Pago',    cor: '#00A1E0', texto: '#fff',    marca: 'mp' },
        { id: 'carteira',    label: 'Carteira Física', cor: '#5B6478', texto: '#fff',    marca: '👛' },
        { id: 'outro',       label: 'Outro',           cor: '#4A5BA8', texto: '#fff',    marca: '🏦' }
    ];

    const TIPOS = {
        conta_corrente: 'Conta corrente',
        poupanca:       'Poupança',
        dinheiro:       'Dinheiro em mãos',
        investimento:   'Investimentos',
        outro:          'Outro'
    };

    // ── Estado ──────────────────────────────────────────────────
    let carteiras      = [];     // linhas de v_carteiras_saldo (ativas e arquivadas)
    let disponivel     = true;   // false quando a migração ainda não foi aplicada
    let clientId       = null;
    let mostrarArquivadas = false;
    let detalheAberto  = false;
    let ultimaUsada    = null;   // última carteira escolhida no formulário de transação
    let eventosGlobais = false;
    let modaisMontados = false;
    let nomeAutomatico = '';     // último nome preenchido sozinho pelo chip de instituição

    // Guia "Quanto você tem hoje?"
    let guiaPasso = 1;           // 1 = introdução · 2 = preencher · 3 = pronto
    let guiaLinhas = [];         // linhas do passo 2 (carteiras existentes + novas)
    let guiaChave = 0;
    let guiaAutoVerificado = false;
    const GUIA_PAUSA_DIAS = 2;

    // ── Utilitários ─────────────────────────────────────────────
    const esc = (t) => (typeof escaparHtml === 'function'
        ? escaparHtml(t)
        : String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));

    const fmt = (v) => (typeof UIModule !== 'undefined' && UIModule.formatCurrency)
        ? UIModule.formatCurrency(v)
        : (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

    const num = (v) => parseFloat(v) || 0;
    const el  = (id) => document.getElementById(id);

    const avisoOk   = (m) => { if (typeof UIModule !== 'undefined') UIModule.showSuccess(m); };
    const avisoErro = (m) => { if (typeof UIModule !== 'undefined') UIModule.showError(m); };
    const avisoInfo = (m) => { if (typeof UIModule !== 'undefined') UIModule.showMessage(m, 'info', 4500); };

    function hojeISO() {
        if (typeof getDataDeHojeFormatoInput === 'function') return getDataDeHojeFormatoInput();
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    const lerLS    = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
    const gravarLS = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* sem storage: só não lembra */ } };
    const arredondar = (v) => Math.round(v * 100) / 100;

    const instituicao = (id) => INSTITUICOES.find(i => i.id === id) || INSTITUICOES[INSTITUICOES.length - 1];
    const ativas      = () => carteiras.filter(c => c.ativa);
    const arquivadas  = () => carteiras.filter(c => !c.ativa);
    const porId       = (id) => carteiras.find(c => c.id === id) || null;

    function tabelaAusente(error) {
        const msg = `${error?.message || ''} ${error?.details || ''}`;
        return error?.code === '42P01' || error?.code === 'PGRST205' || error?.code === 'PGRST200'
            || /does not exist|schema cache|Could not find the (table|relation)/i.test(msg);
    }

    function traduzirErro(error) {
        const msg = `${error?.message || ''}`;
        if (error?.code === '23505' || /duplicate key|uq_carteiras_nome/i.test(msg)) return 'Você já tem uma carteira ativa com esse nome.';
        if (error?.code === '23503' || /foreign key/i.test(msg))                    return 'Esta carteira tem lançamentos e não pode ser excluída. Arquive-a.';
        if (/valor_invalido/.test(msg))                    return 'Informe um valor maior que zero.';
        if (/mesma_carteira/.test(msg))                    return 'Escolha duas carteiras diferentes.';
        if (/carteira_nao_encontrada/.test(msg))           return 'Carteira não encontrada. Atualize a página e tente de novo.';
        if (/categoria_transferencia_ausente/.test(msg))   return 'Falta a categoria de Transferência. Avise o seu consultor.';
        return msg || 'Erro inesperado. Tente de novo.';
    }

    function logoHtml(instId, pequeno = false) {
        const i = instituicao(instId);
        return `<span class="cart-logo ${pequeno ? 'cart-logo--sm' : ''}" style="background:${i.cor};color:${i.texto};" aria-hidden="true">${esc(i.marca)}</span>`;
    }

    // ══════════════════════════════════════════════════════════════
    // CARGA
    // ══════════════════════════════════════════════════════════════
    async function carregar(id) {
        const { data, error } = await supabaseClient
            .from('v_carteiras_saldo')
            .select('*')
            .eq('client_id', id)
            .order('padrao',     { ascending: false })
            .order('created_at', { ascending: true });

        if (error) {
            if (tabelaAusente(error)) { disponivel = false; carteiras = []; return; }
            throw error;
        }

        disponivel = true;
        carteiras = (data || []).map(c => ({
            ...c,
            saldo_inicial:  num(c.saldo_inicial),
            entradas:       num(c.entradas),
            saidas:         num(c.saidas),
            saldo_atual:    num(c.saldo_atual),
            qtd_movimentos: parseInt(c.qtd_movimentos, 10) || 0
        }));
    }

    async function render(id) {
        clientId = id || (typeof ClientModule !== 'undefined' ? ClientModule.getClientId() : null);
        const painel = el('carteirasPainel');
        if (!clientId) return;

        try {
            await carregar(clientId);
        } catch (err) {
            console.error('❌ CarteirasModule.render:', err.message);
            if (painel) {
                painel.innerHTML = `
                    <div class="cart-erro">
                        Não foi possível carregar suas carteiras.
                        <button type="button" class="gami-link" data-acao="recarregar">Tentar de novo</button>
                    </div>`;
                ligarEventosPainel(painel);
            }
            atualizarSelects();
            return;
        }

        montarModais();
        ligarEventosGlobais();
        desenharPainel();
        atualizarSelects();
        agendarGuiaAutomatico();
    }

    // ══════════════════════════════════════════════════════════════
    // PAINEL (patrimônio consolidado + carrossel de carteiras)
    // ══════════════════════════════════════════════════════════════
    function totais() {
        const lista = ativas();
        const soma = (campo) => lista.reduce((s, c) => s + c[campo], 0);
        const investido = lista.filter(c => c.tipo === 'investimento').reduce((s, c) => s + c.saldo_atual, 0);
        const atual = soma('saldo_atual');
        return {
            atual,
            investido,
            emContas: atual - investido,
            inicial:  soma('saldo_inicial'),
            entradas: soma('entradas'),
            saidas:   soma('saidas')
        };
    }

    function cardHtml(c) {
        const negativo = c.saldo_atual < 0;
        return `
            <article class="cart-card ${c.ativa ? '' : 'cart-card--arquivada'}" data-id="${c.id}">
                <div class="cart-card__topo">
                    ${logoHtml(c.instituicao)}
                    <button type="button" class="cart-card__menu" data-acao="menu" data-id="${c.id}"
                            aria-label="Opções da carteira ${esc(c.nome)}" aria-haspopup="true">⋮</button>
                </div>
                <p class="cart-card__nome" title="${esc(c.nome)}">${esc(c.nome)}</p>
                <p class="cart-card__saldo ${negativo ? 'cart-card__saldo--negativo' : ''}">${fmt(c.saldo_atual)}</p>
                <p class="cart-card__sub">
                    ${c.padrao ? '⭐ Principal' : (c.tipo === 'investimento' ? '📈 ' : '') + esc(TIPOS[c.tipo] || '')}${!c.ativa ? ' · Arquivada' : ''}
                </p>
                ${c.ativa && !c.saldo_inicial_definido
                    ? `<button type="button" class="cart-card__alerta" data-acao="editar" data-id="${c.id}">⚠️ Informar saldo inicial</button>`
                    : ''}
            </article>`;
    }

    function bannerPendenteHtml() {
        const pendentes = ativas().filter(c => !c.saldo_inicial_definido);
        if (!pendentes.length) return '';
        const c = pendentes[0];
        return `
            <div class="cart-banner" role="note">
                <span class="cart-banner__icone" aria-hidden="true">💡</span>
                <p>Falta um passo: informe <strong>quanto você tem hoje</strong> (conta, carteira, caixinhas e investimentos) para o seu patrimônio refletir o dinheiro real.</p>
                <button type="button" class="btn btn--secondary" data-acao="guia">Me ajude a preencher</button>
            </div>`;
    }

    function totalHtml() {
        const t = totais();
        const variacao = t.atual - t.inicial;
        const temVariacao = Math.abs(variacao) >= 0.005 && ativas().length > 0;
        return `
            <div class="cart-total">
                <span class="cart-total__icone" aria-hidden="true">👛</span>
                <div class="cart-total__corpo">
                    <p class="cart-total__rotulo">Patrimônio total em mãos</p>
                    <p class="cart-total__valor ${t.atual < 0 ? 'cart-total__valor--negativo' : ''}">
                        ${fmt(t.atual)}
                        ${temVariacao
                            ? `<span class="cart-total__variacao ${variacao >= 0 ? 'cart-total__variacao--sobe' : 'cart-total__variacao--desce'}"
                                     title="Diferença entre o patrimônio de hoje e o saldo inicial informado">${variacao >= 0 ? '▲' : '▼'} ${fmt(Math.abs(variacao))}</span>`
                            : ''}
                    </p>
                </div>
                <button type="button" class="cart-total__seta ${detalheAberto ? 'cart-total__seta--aberta' : ''}"
                        data-acao="detalhe" aria-expanded="${detalheAberto}" aria-label="Ver detalhes do patrimônio">›</button>
            </div>
            ${detalheAberto ? `
            <dl class="cart-detalhe">
                <div><dt>Disponível em contas</dt><dd>${fmt(t.emContas)}</dd></div>
                <div><dt>Guardado em investimentos</dt><dd>${fmt(t.investido)}</dd></div>
                <div><dt>Patrimônio atual</dt><dd>${fmt(t.atual)}</dd></div>
                <div><dt>Saldo inicial informado</dt><dd>${fmt(t.inicial)}</dd></div>
                <div><dt>Entradas desde então</dt><dd class="cart-pos">+ ${fmt(t.entradas)}</dd></div>
                <div><dt>Saídas desde então</dt><dd class="cart-neg">− ${fmt(t.saidas)}</dd></div>
            </dl>
            <p class="cart-detalhe__nota">Transferências entre suas carteiras não alteram o patrimônio total.</p>` : ''}`;
    }

    function desenharPainel() {
        const painel = el('carteirasPainel');
        if (!painel) return;

        if (!disponivel) { painel.innerHTML = ''; return; }

        const lista = mostrarArquivadas ? carteiras : ativas();
        const qtdArquivadas = arquivadas().length;

        let corpo;
        if (!carteiras.length) {
            corpo = `
                <div class="cart-vazio">
                    <p class="cart-vazio__titulo">Quanto dinheiro você tem hoje?</p>
                    <p class="cart-vazio__texto">Cadastre suas contas (Nubank, Itaú, carteira física...) com o saldo de cada uma, incluindo o que está em caixinhas e investimentos.
                        Assim o MentorFin mostra o seu patrimônio real, e não só o que entrou e saiu depois que você começou.</p>
                    <button type="button" class="btn btn--primary" data-acao="guia">+ Cadastrar minhas carteiras</button>
                </div>`;
        } else {
            corpo = `
                ${bannerPendenteHtml()}
                ${totalHtml()}
                <div class="cart-barra">
                    <h3 class="cart-barra__titulo">Carteiras</h3>
                    <div class="cart-barra__acoes">
                        ${qtdArquivadas ? `<button type="button" class="gami-link" data-acao="arquivadas">${mostrarArquivadas ? 'Ocultar' : 'Ver'} arquivadas (${qtdArquivadas})</button>` : ''}
                        <button type="button" class="btn btn--secondary cart-barra__transferir" data-acao="transferir"
                                ${ativas().length < 2 ? 'disabled title="Cadastre pelo menos duas carteiras para transferir"' : ''}>🔄 Transferir</button>
                        <button type="button" class="cart-seta" data-acao="rolar-esq" aria-label="Rolar para a esquerda">‹</button>
                        <button type="button" class="cart-seta" data-acao="rolar-dir" aria-label="Rolar para a direita">›</button>
                    </div>
                </div>
                <div class="cart-trilho" id="cartTrilho">
                    ${lista.map(cardHtml).join('')}
                    <button type="button" class="cart-add" data-acao="nova">
                        <span class="cart-add__mais" aria-hidden="true">+</span>
                        <span>Adicionar banco</span>
                    </button>
                </div>`;
        }

        painel.innerHTML = `
            <div class="painel-grupo"><span>🏦 Seu patrimônio consolidado</span></div>
            ${corpo}`;
        ligarEventosPainel(painel);
    }

    function ligarEventosPainel(painel) {
        if (painel._carteirasLigado) return;
        painel._carteirasLigado = true;

        painel.addEventListener('click', (e) => {
            const alvo = e.target.closest('[data-acao]');
            if (!alvo || alvo.disabled) return;
            const id = alvo.dataset.id;

            switch (alvo.dataset.acao) {
                case 'nova':        abrirNova(); break;
                case 'guia':        abrirGuia(); break;
                case 'editar':      abrirEdicao(id); break;
                case 'transferir':  abrirTransferencia(); break;
                case 'menu':        e.stopPropagation(); abrirMenu(id, alvo); break;
                case 'detalhe':     detalheAberto = !detalheAberto; desenharPainel(); break;
                case 'arquivadas':  mostrarArquivadas = !mostrarArquivadas; desenharPainel(); break;
                case 'rolar-esq':   rolarTrilho(-1); break;
                case 'rolar-dir':   rolarTrilho(1); break;
                case 'recarregar':  render(clientId); break;
                default: break;
            }
        });
    }

    function rolarTrilho(direcao) {
        const trilho = el('cartTrilho');
        if (trilho) trilho.scrollBy({ left: direcao * Math.max(240, trilho.clientWidth * 0.8), behavior: 'smooth' });
    }

    // ══════════════════════════════════════════════════════════════
    // MENU ⋮ (flutuante, fora do trilho com overflow)
    // ══════════════════════════════════════════════════════════════
    function menuEl() {
        let m = el('cartMenu');
        if (!m) {
            m = document.createElement('div');
            m.id = 'cartMenu';
            m.className = 'cart-menu hidden';
            m.setAttribute('role', 'menu');
            document.body.appendChild(m);

            m.addEventListener('click', (e) => {
                const item = e.target.closest('[data-item]');
                if (!item) return;
                const id = m.dataset.id;
                fecharMenu();
                tratarItemMenu(item.dataset.item, id);
            });
        }
        return m;
    }

    function abrirMenu(id, botao) {
        const c = porId(id);
        if (!c) return;
        const m = menuEl();

        // Clicar de novo no mesmo ⋮ fecha
        if (!m.classList.contains('hidden') && m.dataset.id === id) { fecharMenu(); return; }

        const itens = [];
        if (c.ativa) {
            itens.push(['editar', '✏️ Editar']);
            if (ativas().length >= 2) itens.push(['transferir', '🔄 Transferir daqui']);
            if (!c.padrao && c.tipo !== 'investimento') itens.push(['padrao', '⭐ Definir como principal']);
            if (!c.padrao)            itens.push(['arquivar', '🗄️ Arquivar']);
        } else {
            itens.push(['reativar', '♻️ Reativar']);
        }
        if (!c.padrao && c.qtd_movimentos === 0) itens.push(['excluir', '🗑️ Excluir']);

        m.dataset.id = id;
        m.innerHTML = itens.map(([k, t]) =>
            `<button type="button" role="menuitem" class="cart-menu__item ${k === 'excluir' ? 'cart-menu__item--perigo' : ''}" data-item="${k}">${t}</button>`).join('');

        m.classList.remove('hidden');
        const r  = botao.getBoundingClientRect();
        const mw = m.offsetWidth;
        const mh = m.offsetHeight;
        const alturaJanela = window.visualViewport?.height ?? window.innerHeight;
        const left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8));
        const abreParaCima = (alturaJanela - r.bottom) < mh + 12 && r.top > mh + 12;
        m.style.left = `${left}px`;
        m.style.top  = `${abreParaCima ? r.top - mh - 4 : r.bottom + 4}px`;
    }

    function fecharMenu() {
        const m = el('cartMenu');
        if (m) m.classList.add('hidden');
    }

    async function tratarItemMenu(item, id) {
        const c = porId(id);
        if (!c) return;

        switch (item) {
            case 'editar':     abrirEdicao(id); break;
            case 'transferir': abrirTransferencia(id); break;
            case 'padrao':     await definirPadrao(c); break;
            case 'arquivar':   await alterarAtiva(c, false); break;
            case 'reativar':   await alterarAtiva(c, true); break;
            case 'excluir':    await excluir(c); break;
            default: break;
        }
    }

    // ══════════════════════════════════════════════════════════════
    // AÇÕES: padrão / arquivar / excluir
    // ══════════════════════════════════════════════════════════════
    async function atualizarTudo() {
        // loadClientDashboard (app.js) também re-renderiza as carteiras e o histórico
        if (typeof loadClientDashboard === 'function') await loadClientDashboard();
        else await render(clientId);
    }

    async function definirPadrao(c) {
        const { error } = await supabaseClient.rpc('definir_carteira_padrao', { p_id: c.id });
        if (error) { avisoErro(traduzirErro(error)); return; }
        avisoOk(`“${c.nome}” agora é a sua carteira principal.`);
        await atualizarTudo();
    }

    async function alterarAtiva(c, ativa) {
        if (!ativa && Math.abs(c.saldo_atual) >= 0.005) {
            avisoErro(`“${c.nome}” ainda tem ${fmt(c.saldo_atual)}. Transfira o saldo para outra carteira antes de arquivar.`);
            return;
        }
        if (!ativa && !confirm(`Arquivar a carteira “${c.nome}”? Ela some da lista, mas o histórico dela continua salvo e você pode reativá-la.`)) return;

        const { error } = await supabaseClient.from('carteiras').update({ ativa }).eq('id', c.id);
        if (error) { avisoErro(traduzirErro(error)); return; }
        avisoOk(ativa ? `“${c.nome}” reativada.` : `“${c.nome}” arquivada.`);
        await atualizarTudo();
    }

    async function excluir(c) {
        if (!confirm(`Excluir a carteira “${c.nome}”? Esta ação não pode ser desfeita.`)) return;

        // .select() devolve as linhas apagadas: RLS bloqueia sem erro (0 linhas)
        const { data, error } = await supabaseClient.from('carteiras').delete().eq('id', c.id).select('id');
        if (error) { avisoErro(traduzirErro(error)); return; }
        if (!data?.length) { avisoErro('Não foi possível excluir esta carteira.'); return; }
        avisoOk('Carteira excluída.');
        await atualizarTudo();
    }

    // ══════════════════════════════════════════════════════════════
    // MODAIS (injetados uma única vez — o HTML das páginas não precisa deles)
    // ══════════════════════════════════════════════════════════════
    function montarModais() {
        if (modaisMontados) return;
        modaisMontados = true;

        const chips = INSTITUICOES.map(i => `
            <button type="button" class="cart-chip" data-inst="${i.id}" aria-pressed="false">
                ${logoHtml(i.id, true)}<span>${esc(i.label)}</span>
            </button>`).join('');

        const tipos = Object.entries(TIPOS).map(([k, t]) => `<option value="${k}">${esc(t)}</option>`).join('');

        const html = `
        <div id="modalCarteira" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="carteiraTitulo">
            <div class="modal__content" style="max-width:480px;">
                <header class="modal__header">
                    <h2 id="carteiraTitulo">🏦 Nova carteira</h2>
                    <button type="button" class="modal__close-btn" data-fechar="modalCarteira" aria-label="Fechar">✕</button>
                </header>
                <div class="modal__body">
                    <input type="hidden" id="carteiraId">
                    <div class="form-group">
                        <label>Qual é a conta?</label>
                        <div class="cart-chips" id="carteiraChips">${chips}</div>
                    </div>
                    <div class="form-group">
                        <label for="carteiraNome">Nome da carteira</label>
                        <input type="text" id="carteiraNome" maxlength="40" placeholder="Ex: Nubank, Carteira do dia a dia..." autocomplete="off">
                    </div>
                    <div class="form-group">
                        <label for="carteiraTipo">Tipo</label>
                        <select id="carteiraTipo">${tipos}</select>
                    </div>
                    <div class="form-group">
                        <label for="carteiraSaldo">Quanto tem nela hoje? (R$)</label>
                        <input type="number" id="carteiraSaldo" step="0.01" inputmode="decimal" placeholder="0,00">
                    </div>
                    <p class="cart-dica">💡 Digite o saldo de <strong>hoje</strong>, como aparece no app do banco. Ele <strong>não conta como receita nem gasto</strong>: é só o ponto de partida. Conta no negativo? Use sinal de menos. Dinheiro em caixinhas ou investimentos? Cadastre como outra carteira do tipo “Investimentos”.</p>
                    <button type="button" class="btn btn--primary" id="btnSalvarCarteira" style="width:100%;">Salvar carteira</button>
                </div>
            </div>
        </div>

        <div id="modalTransferenciaCarteira" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="transfTitulo">
            <div class="modal__content" style="max-width:460px;">
                <header class="modal__header">
                    <h2 id="transfTitulo">🔄 Transferir entre carteiras</h2>
                    <button type="button" class="modal__close-btn" data-fechar="modalTransferenciaCarteira" aria-label="Fechar">✕</button>
                </header>
                <div class="modal__body">
                    <div class="form-group">
                        <label for="transfOrigem">De</label>
                        <select id="transfOrigem"></select>
                        <p class="cart-dica cart-dica--curta" id="transfSaldoOrigem"></p>
                    </div>
                    <div class="form-group">
                        <label for="transfDestino">Para</label>
                        <select id="transfDestino"></select>
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label for="transfValor">Valor (R$)</label>
                            <input type="number" id="transfValor" step="0.01" min="0.01" inputmode="decimal" placeholder="0,00">
                        </div>
                        <div class="form-group">
                            <label for="transfData">Data</label>
                            <input type="date" id="transfData">
                        </div>
                    </div>
                    <div class="form-group">
                        <label for="transfDescricao">Observação (opcional)</label>
                        <input type="text" id="transfDescricao" maxlength="80" placeholder="Ex: Reserva do mês">
                    </div>
                    <p class="cart-dica">Não é gasto nem ganho: o dinheiro só muda de lugar, e o patrimônio total continua o mesmo.</p>
                    <button type="button" class="btn btn--primary" id="btnConfirmarTransferencia" style="width:100%;">Transferir</button>
                </div>
            </div>
        </div>`;

        const htmlGuia = `
        <div id="modalCarteirasGuia" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="guiaTitulo">
            <div class="modal__content guia">
                <div class="modal__body guia__corpo" id="guiaCorpo"></div>
            </div>
        </div>`;

        const wrap = document.createElement('div');
        wrap.innerHTML = html + htmlGuia;
        while (wrap.firstChild) document.body.appendChild(wrap.firstChild);

        // Chips de instituição
        el('carteiraChips').addEventListener('click', (e) => {
            const chip = e.target.closest('.cart-chip');
            if (chip) selecionarInstituicao(chip.dataset.inst);
        });

        el('btnSalvarCarteira').addEventListener('click', salvarCarteira);
        el('btnConfirmarTransferencia').addEventListener('click', confirmarTransferencia);

        el('transfOrigem').addEventListener('change', () => { montarDestino(); mostrarSaldoOrigem(); });

        ligarEventosGuia();

        // Enter envia (exceto em campos de seleção)
        el('modalCarteira').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); salvarCarteira(); }
        });
        el('modalTransferenciaCarteira').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); confirmarTransferencia(); }
        });
    }

    // ── Criar / editar carteira ─────────────────────────────────
    function selecionarInstituicao(instId, { automatico = true } = {}) {
        const modal = el('modalCarteira');
        modal.dataset.inst = instId;
        modal.querySelectorAll('.cart-chip').forEach(ch => {
            const marcado = ch.dataset.inst === instId;
            ch.classList.toggle('cart-chip--ativo', marcado);
            ch.setAttribute('aria-pressed', marcado ? 'true' : 'false');
        });

        if (!automatico) return;
        const campoNome = el('carteiraNome');
        const label = instituicao(instId).label;
        // Só troca o nome se estiver vazio ou ainda for o que o chip anterior preencheu
        if (!campoNome.value.trim() || campoNome.value.trim() === nomeAutomatico) {
            campoNome.value = instId === 'outro' ? '' : label;
            nomeAutomatico = campoNome.value;
        }
        if (instId === 'carteira') el('carteiraTipo').value = 'dinheiro';
    }

    function abrirNova() {
        if (!disponivel) { avisoErro('Recurso de carteiras ainda não está ativo. Avise o seu consultor.'); return; }
        montarModais();
        nomeAutomatico = '';
        el('carteiraTitulo').textContent = carteiras.length ? '🏦 Nova carteira' : '🏦 Minha primeira carteira';
        el('carteiraId').value    = '';
        el('carteiraNome').value  = '';
        el('carteiraTipo').value  = 'conta_corrente';
        el('carteiraSaldo').value = '';
        selecionarInstituicao('nubank', { automatico: true });
        UIModule.openModal('modalCarteira');
        el('carteiraSaldo').focus();
    }

    function abrirEdicao(id) {
        const c = porId(id);
        if (!c) return;
        montarModais();
        nomeAutomatico = '';
        el('carteiraTitulo').textContent = '✏️ Editar carteira';
        el('carteiraId').value    = c.id;
        el('carteiraNome').value  = c.nome;
        el('carteiraTipo').value  = c.tipo;
        // Mostra o saldo de HOJE (não o inicial): ao salvar, o inicial é recalculado
        el('carteiraSaldo').value = c.saldo_inicial_definido ? c.saldo_atual : '';
        selecionarInstituicao(c.instituicao, { automatico: false });
        UIModule.openModal('modalCarteira');
        el('carteiraSaldo').focus();
    }

    async function salvarCarteira() {
        const id     = el('carteiraId').value;
        const nome   = el('carteiraNome').value.trim();
        const inst   = el('modalCarteira').dataset.inst || 'outro';
        const tipo   = el('carteiraTipo').value;
        const brutoSaldo = el('carteiraSaldo').value;
        const saldo  = brutoSaldo === '' ? 0 : parseFloat(brutoSaldo);

        if (!nome)                    { avisoErro('Dê um nome para a carteira.'); return; }
        if (nome.length > 40)         { avisoErro('O nome pode ter no máximo 40 letras.'); return; }
        if (!Number.isFinite(saldo))  { avisoErro('Informe um saldo válido.'); return; }
        if (!clientId)                { avisoErro('Sessão não identificada. Entre de novo.'); return; }

        const campos = { nome, instituicao: inst, tipo, saldo_inicial_definido: true };
        if (id) {
            // Edição: o cliente informa o saldo de HOJE; o inicial é derivado para o atual bater com ele
            const atual = porId(id);
            campos.saldo_inicial = saldoInicialParaSaldoHoje(atual, saldo);
        } else {
            campos.saldo_inicial = arredondar(saldo);
            campos.data_saldo_inicial = hojeISO();
        }

        const btn = el('btnSalvarCarteira');
        btn.disabled = true; btn.textContent = 'Salvando...';

        try {
            let resposta;
            if (id) {
                resposta = await supabaseClient.from('carteiras').update(campos).eq('id', id).select('id');
            } else {
                resposta = await supabaseClient.from('carteiras')
                    .insert({ ...campos, client_id: clientId, padrao: !carteiras.some(c => c.padrao && c.ativa) })
                    .select('id');
            }
            if (resposta.error) throw resposta.error;
            if (!resposta.data?.length) throw new Error('Não foi possível salvar (sem permissão).');

            UIModule.closeModal('modalCarteira');
            avisoOk(id ? 'Carteira atualizada!' : 'Carteira criada!');
            await atualizarTudo();
        } catch (error) {
            console.error('❌ salvarCarteira:', error);
            avisoErro(traduzirErro(error));
        } finally {
            btn.disabled = false; btn.textContent = 'Salvar carteira';
        }
    }

    // ── Transferência ───────────────────────────────────────────
    function montarDestino(preferido) {
        const origem = el('transfOrigem').value;
        const selDestino = el('transfDestino');
        const anterior = preferido || selDestino.value;
        const opcoes = ativas().filter(c => c.id !== origem);
        selDestino.innerHTML = opcoes.map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join('');
        if (anterior && opcoes.some(c => c.id === anterior)) selDestino.value = anterior;
    }

    function mostrarSaldoOrigem() {
        const c = porId(el('transfOrigem').value);
        el('transfSaldoOrigem').textContent = c ? `Saldo atual: ${fmt(c.saldo_atual)}` : '';
    }

    function abrirTransferencia(origemId) {
        if (!disponivel) return;
        if (ativas().length < 2) { avisoInfo('Cadastre pelo menos duas carteiras para fazer uma transferência.'); return; }
        montarModais();

        const lista = ativas();
        el('transfOrigem').innerHTML = lista.map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join('');
        el('transfOrigem').value = (origemId && lista.some(c => c.id === origemId)) ? origemId : lista[0].id;
        montarDestino();
        mostrarSaldoOrigem();

        el('transfValor').value     = '';
        el('transfData').value      = hojeISO();
        el('transfDescricao').value = '';
        UIModule.openModal('modalTransferenciaCarteira');
        el('transfValor').focus();
    }

    async function confirmarTransferencia() {
        const origem  = el('transfOrigem').value;
        const destino = el('transfDestino').value;
        const valor   = parseFloat(el('transfValor').value);
        const data    = el('transfData').value;
        const obs     = el('transfDescricao').value.trim();

        if (!origem || !destino)          { avisoErro('Escolha a carteira de origem e a de destino.'); return; }
        if (origem === destino)           { avisoErro('Escolha duas carteiras diferentes.'); return; }
        if (!Number.isFinite(valor) || valor <= 0) { avisoErro('Informe um valor maior que zero.'); return; }
        if (!data)                        { avisoErro('Informe a data.'); return; }

        const btn = el('btnConfirmarTransferencia');
        btn.disabled = true; btn.textContent = 'Transferindo...';

        try {
            const { error } = await supabaseClient.rpc('transferir_entre_carteiras', {
                p_origem: origem, p_destino: destino,
                p_valor: Math.round(valor * 100) / 100,
                p_data: data,
                p_descricao: obs || null
            });
            if (error) throw error;

            UIModule.closeModal('modalTransferenciaCarteira');
            avisoOk('Transferência registrada!');
            await atualizarTudo();
        } catch (error) {
            console.error('❌ confirmarTransferencia:', error);
            avisoErro(traduzirErro(error));
        } finally {
            btn.disabled = false; btn.textContent = 'Transferir';
        }
    }

    // ══════════════════════════════════════════════════════════════
    // SELETORES DE CARTEIRA NOS FORMULÁRIOS (transação, edição, importação)
    // Só aparecem com 2+ carteiras ativas — com uma só, não há o que escolher
    // e o banco já usa a principal.
    // ══════════════════════════════════════════════════════════════
    function preencherSelect(selectId, wrapperId, selecionarId, { semInvestimento = false } = {}) {
        const select  = el(selectId);
        const wrapper = wrapperId ? el(wrapperId) : null;
        if (!select) return;

        // Gasto do dia a dia e extrato de conta não vão para a carteira de investimentos
        const lista = ativas().filter(c => !(semInvestimento && c.tipo === 'investimento'));
        const selecionada = selecionarId ? porId(selecionarId) : null;
        const incluirExtra = selecionada && !lista.some(c => c.id === selecionada.id); // arquivada (ou investimento, na edição)

        const mostrar = disponivel && (lista.length >= 2 || incluirExtra);
        if (wrapper) wrapper.classList.toggle('hidden', !mostrar);

        if (!disponivel || !lista.length) { select.innerHTML = ''; return; }

        const opcoes = incluirExtra ? [...lista, selecionada] : lista;
        select.innerHTML = opcoes
            .map(c => `<option value="${c.id}">${esc(c.nome)}${c.ativa ? '' : ' (arquivada)'}</option>`)
            .join('');

        const padrao = lista.find(c => c.padrao) || lista[0];
        select.value = selecionarId && opcoes.some(c => c.id === selecionarId) ? selecionarId : padrao.id;
    }

    function atualizarSelects() {
        const lembrada = ultimaUsada && ativas().some(c => c.id === ultimaUsada && c.tipo !== 'investimento') ? ultimaUsada : null;
        preencherSelect('transCarteira',  'transCarteiraWrapper',  lembrada, { semInvestimento: true });
        preencherSelect('importCarteira', 'importCarteiraWrapper', null,     { semInvestimento: true });
    }

    function nomeDaCarteira(id) {
        if (!disponivel || carteiras.length < 2 || !id) return '';
        return porId(id)?.nome || '';
    }


    // ══════════════════════════════════════════════════════════════
    // SALDO "HOJE" → SALDO INICIAL
    // ══════════════════════════════════════════════════════════════
    /**
     * O cliente informa quanto tem HOJE. Como o saldo atual é
     * saldo_inicial + (entradas − saídas), o inicial que faz o atual bater
     * com o informado é: saldoHoje − (entradas − saídas).
     */
    function saldoInicialParaSaldoHoje(carteira, saldoHoje) {
        const movimento = carteira ? (carteira.entradas - carteira.saidas) : 0;
        return arredondar(saldoHoje - movimento);
    }

    /** Carteira que vai receber um lançamento/extrato: a escolhida, ou a principal. */
    function carteiraDeDestino(id) {
        if (id) return porId(id);
        return ativas().find(c => c.padrao && c.tipo !== 'investimento')
            || ativas().find(c => c.tipo !== 'investimento')
            || null;
    }

    /** Carteira de investimentos do mesmo banco (caixinhas, RDB...), se existir. */
    function irmaInvestimento(carteiraId) {
        const c = porId(carteiraId);
        if (!c || c.tipo === 'investimento' || c.instituicao === 'carteira') return null;
        return ativas().find(x => x.tipo === 'investimento' && x.instituicao === c.instituicao && x.id !== c.id) || null;
    }

    // ══════════════════════════════════════════════════════════════
    // GUIA "QUANTO VOCÊ TEM HOJE?" (pop-up passo a passo)
    // ══════════════════════════════════════════════════════════════
    const chaveGuia = () => `mentorfin_carteiras_guia_${clientId}`;

    function precisaGuia() {
        if (!disponivel) return false;
        const lista = ativas();
        return lista.length === 0 || lista.some(c => !c.saldo_inicial_definido);
    }

    function guiaAdiada() {
        const ate = Number(lerLS(chaveGuia()) || 0);
        return Date.now() < ate;
    }

    /** Abre sozinho (uma vez por carregamento), sem atropelar o tour nem outro pop-up. */
    async function agendarGuiaAutomatico() {
        if (guiaAutoVerificado || !disponivel) return;
        guiaAutoVerificado = true;
        if (!precisaGuia() || guiaAdiada()) return;

        await new Promise(r => setTimeout(r, 1500));
        for (let i = 0; i < 240; i++) { // espera o tour de primeiro acesso fechar (até 2 min)
            const tour = el('modalTour');
            if (!tour || tour.classList.contains('hidden')) break;
            await new Promise(r => setTimeout(r, 500));
        }
        if (!precisaGuia()) return;
        if (document.querySelector('.modal:not(.hidden)')) return;
        abrirGuia();
    }

    function linhasDoGuiaAPartirDoBanco() {
        return ativas().map(c => ({
            chave: ++guiaChave,
            id: c.id,
            instituicao: c.instituicao,
            nome: c.nome,
            tipo: c.tipo,
            valor: c.saldo_inicial_definido ? String(c.saldo_atual) : '',
            pendente: !c.saldo_inicial_definido,
            temMov: c.qtd_movimentos > 0,
            nova: false
        }));
    }

    function abrirGuia() {
        if (!disponivel) { avisoErro('Recurso de carteiras ainda não está ativo. Avise o seu consultor.'); return; }
        montarModais();
        guiaPasso = 1;
        guiaLinhas = linhasDoGuiaAPartirDoBanco();
        desenharGuia();
        UIModule.openModal('modalCarteirasGuia');
    }

    function fecharGuia() {
        UIModule.closeModal('modalCarteirasGuia');
        if (guiaPasso < 3 && precisaGuia()) gravarLS(chaveGuia(), String(Date.now() + GUIA_PAUSA_DIAS * 864e5));
    }

    const guiaTotal = () => guiaLinhas.reduce((s, l) => s + (parseFloat(l.valor) || 0), 0);

    function pontosDoGuia() {
        return [1, 2, 3].map(n => `<span class="tour__ponto ${n === guiaPasso ? 'tour__ponto--ativo' : ''}"></span>`).join('');
    }

    function linhaGuiaHtml(l) {
        const invest = l.tipo === 'investimento';
        const podeInvestir = !invest && l.instituicao !== 'carteira'
            && !guiaLinhas.some(x => x.instituicao === l.instituicao && x.tipo === 'investimento');
        const pergunta = invest ? 'Quanto está investido hoje?' : (l.pendente ? 'Quanto tem aí hoje?' : 'Quanto tem hoje?');
        const textoInvestir = l.instituicao === 'nubank'
            ? '＋ Também tenho dinheiro nas caixinhas deste banco'
            : '＋ Também tenho dinheiro investido neste banco';

        return `
            <div class="guia__bloco ${invest ? 'guia__bloco--invest' : ''}" data-chave="${l.chave}">
                <div class="guia__linha">
                    ${logoHtml(l.instituicao, true)}
                    <div class="guia__linha-corpo">
                        ${l.nova
                            ? `<input type="text" class="guia__nome" maxlength="40" value="${esc(l.nome)}" aria-label="Nome da carteira">`
                            : `<strong>${esc(l.nome)}</strong>`}
                        <small>${pergunta}</small>
                    </div>
                    <label class="guia__valor"><span>R$</span>
                        <input type="number" class="guia__input-valor" step="0.01" inputmode="decimal" placeholder="0,00" value="${esc(l.valor)}" aria-label="${esc(pergunta)}">
                    </label>
                    ${l.nova ? `<button type="button" class="guia__remover" data-guia="remover" data-chave="${l.chave}" aria-label="Remover">✕</button>` : ''}
                </div>
                ${l.pendente && l.temMov ? `<p class="guia__nota">Esta carteira guarda os lançamentos que você fez antes das carteiras. Digite quanto tem nela hoje — ou 0, se esse dinheiro já está nas outras contas.</p>` : ''}
                ${podeInvestir ? `<button type="button" class="guia__investir" data-guia="investir" data-chave="${l.chave}">${textoInvestir}</button>` : ''}
            </div>`;
    }

    function chipsGuiaHtml() {
        return INSTITUICOES.filter(i => i.id !== 'outro').concat(INSTITUICOES.filter(i => i.id === 'outro')).map(i => {
            const jaTem  = guiaLinhas.some(l => !l.nova && l.instituicao === i.id && l.tipo !== 'investimento');
            const noGuia = guiaLinhas.some(l => l.nova && l.instituicao === i.id && l.tipo !== 'investimento');
            return `<button type="button" class="cart-chip ${noGuia ? 'cart-chip--ativo' : ''}" data-guia="chip" data-inst="${i.id}"
                        aria-pressed="${noGuia}" ${jaTem ? 'disabled title="Você já tem essa carteira"' : ''}>
                        ${logoHtml(i.id, true)}<span>${esc(i.label)}${jaTem ? ' ✓' : ''}</span></button>`;
        }).join('');
    }

    function desenharGuia() {
        const corpo = el('guiaCorpo');
        if (!corpo) return;

        if (guiaPasso === 1) {
            corpo.innerHTML = `
                <div class="tour__icone" aria-hidden="true">💰</div>
                <h2 class="tour__titulo" id="guiaTitulo">Quanto dinheiro você tem hoje?</h2>
                <p class="tour__texto">Para o MentorFin mostrar o seu dinheiro <strong>de verdade</strong>, preciso saber com quanto você começa. Leva 1 minuto.</p>
                <ol class="guia__passos">
                    <li><span>1</span><div><strong>Abra o app do seu banco</strong><small>Veja o saldo da conta e também o que está guardado em caixinhas e investimentos. Tem dinheiro em mãos? Conta também.</small></div></li>
                    <li><span>2</span><div><strong>Escolha onde está o dinheiro</strong><small>Nubank, Itaú, PicPay, carteira física... toque nos que você usa.</small></div></li>
                    <li><span>3</span><div><strong>Digite o valor de cada um</strong><small>Não precisa ser exato ao centavo — dá para corrigir depois.</small></div></li>
                </ol>
                <p class="tour__dica">💡 Esse valor <strong>não é receita nem gasto</strong>: é só o ponto de partida. A partir dele, cada lançamento seu mexe no saldo.</p>
                <div class="tour__pontos" aria-hidden="true">${pontosDoGuia()}</div>
                <div class="tour__acoes">
                    <button type="button" class="btn btn--secondary" data-guia="depois">Agora não</button>
                    <button type="button" class="btn btn--primary tour__proximo" data-guia="comecar">Começar</button>
                </div>`;
            corpo.querySelector('[data-guia="comecar"]')?.focus();
            return;
        }

        if (guiaPasso === 2) {
            corpo.innerHTML = `
                <h2 class="guia__titulo" id="guiaTitulo">Onde está o seu dinheiro?</h2>
                <p class="guia__texto">Toque nos bancos que você usa e digite quanto tem em cada um <strong>hoje</strong>. O que está em caixinhas ou investimentos entra pelo botão “＋ Também tenho...” dentro de cada banco.</p>
                <div class="cart-chips guia__chips">${chipsGuiaHtml()}</div>
                <div class="guia__linhas" id="guiaLinhas">
                    ${guiaLinhas.length ? guiaLinhas.map(linhaGuiaHtml).join('') : '<p class="guia__vazio">👆 Toque em um banco acima para começar.</p>'}
                </div>
                <div class="guia__total">Seu patrimônio: <strong id="guiaTotal">${fmt(guiaTotal())}</strong></div>
                <p class="guia__erro hidden" id="guiaErro" role="alert"></p>
                <div class="tour__pontos" aria-hidden="true">${pontosDoGuia()}</div>
                <div class="tour__acoes">
                    <button type="button" class="btn btn--secondary" data-guia="voltar">Voltar</button>
                    <button type="button" class="btn btn--primary tour__proximo" id="btnSalvarGuia" data-guia="salvar">Salvar e continuar</button>
                </div>`;
            return;
        }

        const t = totais();
        corpo.innerHTML = `
            <div class="tour__icone" aria-hidden="true">✅</div>
            <h2 class="tour__titulo" id="guiaTitulo">Tudo pronto!</h2>
            <p class="tour__texto">Seu patrimônio hoje: <strong>${fmt(t.atual)}</strong>${t.investido ? ` <small class="guia__sub">(${fmt(t.emContas)} em contas + ${fmt(t.investido)} investidos)</small>` : ''}</p>
            <ul class="guia__dicas">
                <li>🧾 Ao lançar um gasto, escolha de qual carteira ele saiu (a pergunta aparece quando você tem 2 ou mais).</li>
                <li>🔄 Moveu dinheiro entre contas ou para a caixinha? Use <strong>Transferir</strong> — não conta como gasto nem ganho.</li>
                <li>✏️ Saldo errado? Toque no <strong>⋮</strong> da carteira e em <strong>Editar</strong>.</li>
            </ul>
            <div class="tour__pontos" aria-hidden="true">${pontosDoGuia()}</div>
            <div class="tour__acoes">
                <button type="button" class="btn btn--primary tour__proximo" data-guia="fim">Entendi</button>
            </div>`;
    }

    function mostrarErroGuia(msg, chave) {
        const e = el('guiaErro');
        if (e) { e.textContent = msg; e.classList.remove('hidden'); }
        if (chave) el('guiaLinhas')?.querySelector(`[data-chave="${chave}"] .guia__input-valor`)?.focus();
    }

    function adicionarBancoNoGuia(instId) {
        const existente = guiaLinhas.findIndex(l => l.nova && l.instituicao === instId && l.tipo !== 'investimento');
        if (existente >= 0) { // tocar de novo no chip remove o banco (e o investimento dele)
            guiaLinhas = guiaLinhas.filter(l => !(l.nova && l.instituicao === instId));
        } else {
            const i = instituicao(instId);
            guiaLinhas.push({
                chave: ++guiaChave, id: null, instituicao: instId,
                nome: instId === 'outro' ? '' : i.label,
                tipo: instId === 'carteira' ? 'dinheiro' : 'conta_corrente',
                valor: '', pendente: false, temMov: false, nova: true
            });
        }
        desenharGuia();
        if (existente < 0) el('guiaLinhas')?.querySelector('.guia__bloco:last-child .guia__input-valor')?.focus();
    }

    function adicionarInvestimentoNoGuia(chave) {
        const pos = guiaLinhas.findIndex(l => String(l.chave) === String(chave));
        if (pos < 0) return;
        const base = guiaLinhas[pos];
        const nome = base.instituicao === 'nubank' ? 'Nubank Caixinhas'
            : `${instituicao(base.instituicao).label} Investimentos`;
        const nova = {
            chave: ++guiaChave, id: null, instituicao: base.instituicao,
            nome: base.instituicao === 'outro' ? `${base.nome || 'Banco'} Investimentos` : nome,
            tipo: 'investimento', valor: '', pendente: false, temMov: false, nova: true
        };
        guiaLinhas.splice(pos + 1, 0, nova);
        desenharGuia();
        el('guiaLinhas')?.querySelector(`[data-chave="${nova.chave}"] .guia__input-valor`)?.focus();
    }

    function removerLinhaDoGuia(chave) {
        const alvo = guiaLinhas.find(l => String(l.chave) === String(chave));
        if (!alvo || !alvo.nova) return;
        guiaLinhas = guiaLinhas.filter(l => l !== alvo
            // remover o banco leva junto o investimento novo dele
            && !(alvo.tipo !== 'investimento' && l.nova && l.tipo === 'investimento' && l.instituicao === alvo.instituicao));
        desenharGuia();
    }

    async function salvarGuia() {
        if (!clientId) { mostrarErroGuia('Sessão não identificada. Entre de novo.'); return; }

        // 1) validação (nada é gravado se algo estiver errado)
        const nomes = new Set();
        for (const l of guiaLinhas) {
            const nome = l.nome.trim();
            if (!nome)           { mostrarErroGuia('Dê um nome para a carteira nova.', l.chave); return; }
            if (nome.length > 40){ mostrarErroGuia('O nome pode ter no máximo 40 letras.', l.chave); return; }
            const chaveNome = nome.toLowerCase();
            if (nomes.has(chaveNome)) { mostrarErroGuia(`Você tem duas carteiras chamadas “${nome}”. Mude o nome de uma delas.`, l.chave); return; }
            nomes.add(chaveNome);

            if (l.valor === '' || !Number.isFinite(parseFloat(l.valor))) {
                mostrarErroGuia(`Digite quanto tem em “${nome}” (se não tem nada, digite 0).`, l.chave);
                return;
            }
        }
        if (!guiaLinhas.length) { mostrarErroGuia('Toque em pelo menos um banco para informar o saldo.'); return; }

        const hoje = hojeISO();
        const atualizacoes = [];
        const novas = [];
        let precisaPadrao = !ativas().some(c => c.padrao);

        for (const l of guiaLinhas) {
            const valor = arredondar(parseFloat(l.valor));
            if (!l.nova) {
                const c = porId(l.id);
                if (!c) continue;
                if (l.pendente || Math.abs(valor - c.saldo_atual) >= 0.005) {
                    atualizacoes.push({ id: c.id, saldo_inicial: saldoInicialParaSaldoHoje(c, valor) });
                }
            } else {
                const registro = {
                    client_id: clientId,
                    nome: l.nome.trim(),
                    instituicao: l.instituicao,
                    tipo: l.tipo,
                    saldo_inicial: valor,
                    data_saldo_inicial: hoje,
                    saldo_inicial_definido: true,
                    padrao: false
                };
                if (precisaPadrao && l.tipo !== 'investimento') { registro.padrao = true; precisaPadrao = false; }
                novas.push(registro);
            }
        }

        const btn = el('btnSalvarGuia');
        if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }
        el('guiaErro')?.classList.add('hidden');

        let inseriu = false;
        try {
            // Inserção primeiro (é atômica): se falhar, nada mudou
            if (novas.length) {
                const r = await supabaseClient.from('carteiras').insert(novas).select('id');
                if (r.error) throw r.error;
                if (!r.data?.length) throw new Error('Não foi possível salvar (sem permissão).');
                inseriu = true;
            }
            for (const u of atualizacoes) {
                const r = await supabaseClient.from('carteiras')
                    .update({ saldo_inicial: u.saldo_inicial, saldo_inicial_definido: true })
                    .eq('id', u.id).select('id');
                if (r.error) throw r.error;
                if (!r.data?.length) throw new Error('Não foi possível salvar (sem permissão).');
            }

            await atualizarTudo();   // recarrega painel, selects e histórico
            guiaPasso = 3;
            desenharGuia();
        } catch (error) {
            console.error('❌ salvarGuia:', error);
            if (inseriu) {
                // As carteiras novas já existem: reconstrói a lista a partir do banco para não duplicar numa nova tentativa
                try { await carregar(clientId); guiaLinhas = linhasDoGuiaAPartirDoBanco(); desenharGuia(); } catch (_) { /* mantém tela */ }
            }
            mostrarErroGuia(traduzirErro(error));
            const b = el('btnSalvarGuia');
            if (b) { b.disabled = false; b.textContent = 'Salvar e continuar'; }
        }
    }

    function ligarEventosGuia() {
        const modal = el('modalCarteirasGuia');

        modal.addEventListener('click', (e) => {
            const alvo = e.target.closest('[data-guia]');
            if (!alvo || alvo.disabled) return;

            switch (alvo.dataset.guia) {
                case 'comecar':  guiaPasso = 2; desenharGuia(); break;
                case 'voltar':   guiaPasso = 1; desenharGuia(); break;
                case 'depois':   fecharGuia(); break;
                case 'fim':      UIModule.closeModal('modalCarteirasGuia'); break;
                case 'chip':     adicionarBancoNoGuia(alvo.dataset.inst); break;
                case 'investir': adicionarInvestimentoNoGuia(alvo.dataset.chave); break;
                case 'remover':  removerLinhaDoGuia(alvo.dataset.chave); break;
                case 'salvar':   salvarGuia(); break;
                default: break;
            }
        });

        // Digitação: guarda no estado (sem redesenhar, para não perder o foco) e atualiza o total
        modal.addEventListener('input', (e) => {
            const bloco = e.target.closest('.guia__bloco');
            if (!bloco) return;
            const l = guiaLinhas.find(x => String(x.chave) === bloco.dataset.chave);
            if (!l) return;

            if (e.target.classList.contains('guia__input-valor')) {
                l.valor = e.target.value;
                const total = el('guiaTotal');
                if (total) total.textContent = fmt(guiaTotal());
            } else if (e.target.classList.contains('guia__nome')) {
                l.nome = e.target.value;
            }
        });

        modal.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.tagName === 'INPUT' && guiaPasso === 2) {
                e.preventDefault();
                salvarGuia();
            }
        });
    }

    // ══════════════════════════════════════════════════════════════
    // EVENTOS GLOBAIS (uma vez só)
    // ══════════════════════════════════════════════════════════════
    function ligarEventosGlobais() {
        if (eventosGlobais) return;
        eventosGlobais = true;

        // Fechar modais pelo ✕ ou clicando no fundo escuro
        document.addEventListener('click', (e) => {
            const fechar = e.target.closest('[data-fechar]');
            if (fechar) { UIModule.closeModal(fechar.dataset.fechar); return; }

            if (e.target.id === 'modalCarteira' || e.target.id === 'modalTransferenciaCarteira') {
                UIModule.closeModal(e.target.id);
            }
            if (e.target.id === 'modalCarteirasGuia') fecharGuia();

            // Clique fora do menu ⋮ fecha
            if (!e.target.closest('#cartMenu') && !e.target.closest('[data-acao="menu"]')) fecharMenu();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            fecharMenu();
            ['modalCarteira', 'modalTransferenciaCarteira'].forEach(id => {
                if (el(id) && !el(id).classList.contains('hidden')) UIModule.closeModal(id);
            });
            if (el('modalCarteirasGuia') && !el('modalCarteirasGuia').classList.contains('hidden')) fecharGuia();
        });

        // O menu é fixed: reposicionar seria frágil, então fecha ao rolar/redimensionar
        window.addEventListener('resize', fecharMenu);
        document.addEventListener('scroll', fecharMenu, true);

        // Lembra a última carteira usada ao lançar
        document.addEventListener('change', (e) => {
            if (e.target.id === 'transCarteira') ultimaUsada = e.target.value || null;
        });
    }

    return {
        render,
        atualizarSelects,
        preencherSelect,
        nomeDaCarteira,
        abrirNova,
        abrirTransferencia,
        abrirGuia,
        carteiraDeDestino,
        irmaInvestimento,
        estaDisponivel: () => disponivel,
        getCarteiras:   () => carteiras.slice()
    };
})();

console.log('✅ carteiras.js carregado (carteiras + saldo inicial + patrimônio consolidado)');
