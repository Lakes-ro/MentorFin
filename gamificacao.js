/**
 * GAMIFICACAO.JS — Nível, sequência, saúde financeira, missões,
 * cofrinhos, evolução e conquistas (painel do CLIENTE)
 * ================================================
 * Padrão: script global (IIFE `GamificacaoModule`). Sem import/export.
 * Carregado depois de app.js; chamado por loadClientDashboard().
 * Também usado pelo admin (dashboards.js → calcular) e pela demo.
 *
 * CICLO FINANCEIRO (ciclo.js): "mês" = ciclo do cliente (ex.: dia 27 → 27/05 a 26/06)
 *   em nota de saúde, mês no azul, evolução e limite semanal. Cliente sem ciclo
 *   personalizado = mês-calendário. O ciclo vem de opcoes.ciclo ou, no painel do
 *   cliente, da variável global cicloClienteAtual (app.js).
 *
 * REGRAS v2 (out/2026) — PRINCÍPIO: premiar ORGANIZAÇÃO e RESULTADO,
 * nunca volume de cliques. Nada aqui deve dar motivo para o cliente
 * inventar, dividir ou esconder lançamento.
 *
 * SEMANA EM DIA (segunda a domingo)
 *   Conta quando a semana tem lançamentos DO CLIENTE com data dentro
 *   dela (data do gasto — importar o extrato depois também vale) OU
 *   quando o cliente marca "Nada a registrar / revisei a semana"
 *   (tabela gamificacao_semanas). Dá para marcar a semana atual e a
 *   anterior. Lançamentos feitos pelo admin (origem 'lancamento_admin')
 *   NÃO contam como esforço do cliente. Semanas anteriores à primeira
 *   atividade do cliente não contam (importar 6 meses de histórico no
 *   primeiro dia não vira 6 meses de XP).
 *
 * SEQUÊNCIA: semanas seguidas em dia. A semana atual só entra quando
 *   fica em dia; até domingo ela fica "pendente", sem quebrar nada.
 *
 * XP
 *   +30  semana em dia                               (missão A)
 *   +40  estilo de vida da semana dentro do limite   (missão B — só
 *        semana encerrada e em dia; limite ≈ 7% da renda do mês)
 *   +40  aporte vinculado a uma meta na semana       (missão C — 1x/semana)
 *   +50  primeira meta (de R$ 100 ou mais)
 *   +100 meta concluída PELOS APORTES vinculados (não pelo valor
 *        digitado à mão), meta de R$ 100 ou mais
 *   +50  mês fechado no azul (receitas ≥ gastos; investir não é gasto)
 *   O XP exibido NUNCA diminui: o maior valor já alcançado fica
 *   guardado em gamificacao_estado (corrigir/apagar lançamento não
 *   derruba o nível de ninguém).
 *
 * TEXTOS PARA LEIGOS: na tela, XP aparece como "pontos", saúde como
 *   "nota do mês" e aporte como "guardar dinheiro numa meta".
 *
 * SAÚDE (0–100)
 *   Nota principal = último mês FECHADO. O mês atual aparece como
 *   "prévia" (parcial). Investimento NÃO é despesa — é poupança.
 *   Base de renda = receita do mês; se ela vier abaixo de 50% da média
 *   dos 3 meses anteriores (renda irregular, salário que ainda não
 *   caiu), usa a média.
 *     30 sobra ≥ 0 · 25 poupança (aportes + sobra) ≥ 20% ·
 *     20 essencial ≤ 50% · 15 estilo de vida ≤ 30% · 10 dívidas ≤ 10%
 *   Despesa de categoria sem grupo definido = "não classificado": entra
 *   no gasto total, mas não é contada como estilo de vida.
 */

const GamificacaoModule = (() => {

    // ── Constantes ──────────────────────────────────────────────
    const NIVEIS = [
        { xp: 0,    nome: 'Iniciante' },
        { xp: 100,  nome: 'Aprendiz' },
        { xp: 300,  nome: 'Organizado' },
        { xp: 600,  nome: 'Controlado' },
        { xp: 1000, nome: 'Planejador' },
        { xp: 1500, nome: 'Poupador' },
        { xp: 2200, nome: 'Estrategista' },
        { xp: 3000, nome: 'Investidor' },
        { xp: 4000, nome: 'Mestre das Finanças' },
        { xp: 5500, nome: 'Lenda' }
    ];

    const XP = {
        SEMANA_EM_DIA: 30, ESTILO_NO_LIMITE: 40, APORTE_SEMANA: 40,
        PRIMEIRA_META: 50, META_CONCLUIDA: 100, MES_NO_AZUL: 50
    };

    const META_VALOR_MINIMO  = 100;  // R$ — metas menores não rendem XP
    const ESTILO_SEMANAL_PCT = 0.07; // ≈ 30% da renda do mês ÷ 4,3 semanas
    const GRUPOS_CONHECIDOS  = ['renda', 'essencial', 'estilo_de_vida', 'investimento', 'divida', 'transferencia'];
    const ORIGENS_DO_ADMIN   = ['lancamento_admin'];
    const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
    const MESES_LONGOS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

    const COR_RECEITA = '#1f9d8a'; // validado (CVD) contra o fundo escuro do app
    const COR_DESPESA = '#e0663a';

    // ── Datas (sempre no horário local) ─────────────────────────
    const pad = (n) => String(n).padStart(2, '0');
    const chaveDia = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    /** created_at vem como "timestamp without time zone" em UTC — sem o "Z" o navegador leria como hora local. */
    function parseCriadoEm(valor) {
        if (!valor) return null;
        const s = String(valor);
        const temFuso = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
        const d = new Date(temFuso ? s : s.replace(' ', 'T') + 'Z');
        return isNaN(d) ? null : d;
    }

    function dataLocal(isoDia) { // 'YYYY-MM-DD' → Date local à meia-noite
        const [a, m, d] = String(isoDia).slice(0, 10).split('-').map(Number);
        return new Date(a, m - 1, d);
    }

    function inicioSemana(d) { // segunda-feira 00:00
        const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const dia = (r.getDay() + 6) % 7; // 0 = segunda
        r.setDate(r.getDate() - dia);
        return r;
    }

    const chaveSemana = (d) => chaveDia(inicioSemana(d));

    function somarDias(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
    const semanaAnterior = (sem) => chaveDia(somarDias(dataLocal(sem), -7));

    function proximoMes(k) {
        const [a, m] = k.split('-').map(Number);
        const d = new Date(a, m, 1);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    }

    function mesAnteriorDe(k, n = 1) {
        const [a, m] = k.split('-').map(Number);
        const d = new Date(a, m - 1 - n, 1);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    }

    const nomeMes = (k) => MESES_LONGOS[Number(k.slice(5, 7)) - 1] || k;

    // ── Ciclo financeiro (ciclo.js) ─────────────────────────────
    // O "mês" da gamificação é o CICLO do cliente. A chave de um ciclo é o
    // AAAA-MM do dia em que ele COMEÇA (ciclo 27/05 a 26/06 = '2026-05').
    // Sem ciclo personalizado (ou sem ciclo.js, como na demo) a chave é o
    // próprio mês-calendário — comportamento idêntico ao anterior.
    let cicloAtivo = null;
    const cacheChaveCiclo = new Map();

    function resolverCiclo(opcoes) {
        if (typeof CicloModule === 'undefined') return null;
        const bruto = opcoes.ciclo || (typeof cicloClienteAtual !== 'undefined' ? cicloClienteAtual : null);
        return bruto ? CicloModule.normalizar(bruto) : null;
    }

    const cicloCustomizado = () => !!cicloAtivo && !CicloModule.ehMesCalendario(cicloAtivo);

    function chaveMes(isoDia) {
        const dia = String(isoDia).slice(0, 10);
        if (!cicloCustomizado()) return dia.slice(0, 7);
        let k = cacheChaveCiclo.get(dia);
        if (!k) {
            k = CicloModule.cicloQueContem(cicloAtivo, dataLocal(dia)).inicio.slice(0, 7);
            cacheChaveCiclo.set(dia, k);
        }
        return k;
    }

    /** "maio" no mês normal; "27/05 a 26/06" num ciclo personalizado. */
    function rotuloPeriodo(k) {
        if (!cicloCustomizado()) return nomeMes(k);
        const [a, m] = k.split('-').map(Number);
        const ini  = CicloModule.inicioDoMes(cicloAtivo, a, m - 1);
        const fim  = somarDias(CicloModule.inicioDoMes(cicloAtivo, a, m), -1);
        return `${CicloModule.formatarBR(ini)} a ${CicloModule.formatarBR(fim)}`;
    }

    // ── Classificação das transações ────────────────────────────
    const valorAbs = (t) => Math.abs(parseFloat(t.valor) || 0);

    /** Grupo da categoria; qualquer coisa fora dos grupos conhecidos vira 'nao_classificado'. */
    function grupoDe(t) {
        const g = t.categorias?.grupo || '';
        return GRUPOS_CONHECIDOS.includes(g) ? g : 'nao_classificado';
    }

    /** Foi o próprio cliente que lançou/importou? (lançamento do admin não é esforço do cliente) */
    const doCliente = (t) => !ORIGENS_DO_ADMIN.includes(t.origem);

    // ── Agregados por mês ───────────────────────────────────────
    function agregarMeses(transacoes) {
        const meses = {};
        transacoes.forEach(t => {
            if (!t.data_competencia) return;
            const g = grupoDe(t);
            if (g === 'transferencia') return;
            const k = chaveMes(t.data_competencia);
            const m = meses[k] || (meses[k] = { rec: 0, consumo: 0, ess: 0, estilo: 0, inv: 0, div: 0, nc: 0 });
            const v = valorAbs(t);
            if (t.tipo === 'receita') { m.rec += v; return; }
            if (g === 'investimento') { m.inv += v; return; }       // poupança, não gasto
            m.consumo += v;
            if (g === 'essencial')           m.ess += v;
            else if (g === 'estilo_de_vida') m.estilo += v;
            else if (g === 'divida')         m.div += v;
            else                             m.nc += v;               // não classificado
        });
        return meses;
    }

    /** Renda usada como base do mês: a receita dele, ou a média dos 3 anteriores quando ela vem muito abaixo. */
    function rendaBase(meses, k) {
        const rec = meses[k]?.rec || 0;
        const anteriores = [1, 2, 3].map(i => meses[mesAnteriorDe(k, i)]?.rec || 0).filter(v => v > 0);
        const media = anteriores.length ? anteriores.reduce((a, b) => a + b, 0) / anteriores.length : 0;
        if (media > 0 && rec < media * 0.5) return { base: media, usouMedia: true };
        return { base: rec, usouMedia: false };
    }

    function notaSaude(m, baseInfo) {
        const base = baseInfo?.base || 0;
        if (base <= 0) return null;
        m = m || { consumo: 0, ess: 0, estilo: 0, inv: 0, div: 0, nc: 0 };
        const clamp = (x) => Math.max(0, Math.min(1, x));
        const sobra   = base - m.consumo; // inclui o que foi investido
        const pSaldo  = sobra >= 0 ? 1 : clamp(1 - (-sobra / base) * 2);
        const pPoup   = clamp((Math.max(0, sobra) / base) / 0.20);
        const pEss    = m.ess / base <= 0.5 ? 1 : clamp(1 - (m.ess / base - 0.5) / 0.5);
        const pEstilo = m.estilo / base <= 0.3 ? 1 : clamp(1 - (m.estilo / base - 0.3) / 0.3);
        const pDiv    = m.div / base <= 0.1 ? 1 : clamp(1 - (m.div / base - 0.1) / 0.3);

        const componentes = [
            { chave: 'saldo',  peso: 30, valor: pSaldo },
            { chave: 'poup',   peso: 25, valor: pPoup },
            { chave: 'ess',    peso: 20, valor: pEss },
            { chave: 'estilo', peso: 15, valor: pEstilo },
            { chave: 'div',    peso: 10, valor: pDiv }
        ];
        const nota = Math.round(componentes.reduce((s, c) => s + c.peso * c.valor, 0));
        return { nota, componentes, sobra, usouMedia: !!baseInfo.usouMedia };
    }

    function faixaSaude(nota) {
        if (nota >= 80) return { label: 'Excelente', classe: 'otima' };
        if (nota >= 60) return { label: 'Boa',       classe: 'boa' };
        if (nota >= 40) return { label: 'Atenção',   classe: 'atencao' };
        return               { label: 'Crítica',    classe: 'critica' };
    }

    const DICA_COMPONENTE = {
        saldo:  'Você gastou mais do que recebeu. Segure os gastos que não são obrigatórios até o próximo pagamento.',
        poup:   'Tente guardar pelo menos R$ 20 de cada R$ 100 que você recebe — numa meta ou investimento.',
        ess:    'As contas obrigatórias (aluguel, luz, mercado...) passaram da metade do que você recebe. Vale ver o que dá para baratear.',
        estilo: 'Lazer, delivery e compras passaram de 30% do que você recebe. É o lugar mais fácil para economizar.',
        div:    'Parcelas e dívidas estão pesando. Quitar primeiro as de juros mais altos libera dinheiro.'
    };

    function dicaDaNota(n) {
        const pior = [...n.componentes].sort((a, b) => (a.valor * a.peso - a.peso) - (b.valor * b.peso - b.peso))[0];
        return pior && pior.peso * (1 - pior.valor) >= 1 ? DICA_COMPONENTE[pior.chave] : 'Tudo dentro do recomendado. Continue assim!';
    }

    // ── Nível ───────────────────────────────────────────────────
    function nivelDoXp(xp) {
        let i = 0;
        while (i + 1 < NIVEIS.length && xp >= NIVEIS[i + 1].xp) i++;
        const atual   = NIVEIS[i];
        const proximo = NIVEIS[i + 1] || null;
        const progresso = proximo ? (xp - atual.xp) / (proximo.xp - atual.xp) : 1;
        return { numero: i + 1, nome: atual.nome, xp, base: atual.xp, proximo, progresso };
    }

    // ── Cálculo principal (puro — sem DOM, sem banco) ───────────
    /**
     * @param transacoes  todas as transações do cliente
     * @param metas       metas do cliente
     * @param agora       data de referência (testes)
     * @param opcoes      { checkins: [{semana:'YYYY-MM-DD'}], xpGuardado: number }
     */
    function calcular(transacoes = [], metas = [], agora = new Date(), opcoes = {}) {
        if (!(agora instanceof Date)) { opcoes = agora || {}; agora = new Date(); }
        const checkins   = opcoes.checkins || [];
        const xpGuardado = Number(opcoes.xpGuardado) || 0;
        cicloAtivo = resolverCiclo(opcoes);
        cacheChaveCiclo.clear();

        const semanaAtualKey = chaveSemana(agora);
        const semanaPassada  = semanaAnterior(semanaAtualKey);
        const mesAtualKey    = chaveMes(chaveDia(agora));

        const doProprio = transacoes.filter(doCliente);

        // ── Primeira atividade do cliente (o que veio antes não rende XP) ──
        let primeiraAtividade = null;
        doProprio.forEach(t => {
            const d = parseCriadoEm(t.created_at) || (t.data_competencia ? dataLocal(t.data_competencia) : null);
            if (d && (!primeiraAtividade || d < primeiraAtividade)) primeiraAtividade = d;
        });
        checkins.forEach(c => {
            const d = c.semana ? dataLocal(c.semana) : null;
            if (d && (!primeiraAtividade || d < primeiraAtividade)) primeiraAtividade = d;
        });
        const semanaInicial = primeiraAtividade ? chaveSemana(primeiraAtividade) : semanaAtualKey;
        const mesInicial    = primeiraAtividade ? chaveMes(chaveDia(primeiraAtividade)) : mesAtualKey;
        const semanaValida  = (sem) => sem >= semanaInicial && sem <= semanaAtualKey;

        // ── Semanas em dia ──
        const semanasComLancamento = new Set();
        const aportesPorSemana = {};
        doProprio.forEach(t => {
            if (!t.data_competencia) return;
            const sem = chaveSemana(dataLocal(t.data_competencia));
            if (!semanaValida(sem)) return;
            semanasComLancamento.add(sem);
            if (t.meta_id) aportesPorSemana[sem] = (aportesPorSemana[sem] || 0) + 1;
        });
        const semanasMarcadas = new Set(checkins.map(c => String(c.semana).slice(0, 10)).filter(semanaValida));
        const emDia = new Set([...semanasComLancamento, ...semanasMarcadas]);

        // ── Sequência (semanas) ──
        const semanaAtualEmDia = emDia.has(semanaAtualKey);
        let sequencia = 0;
        let cursor = semanaAtualEmDia ? semanaAtualKey : semanaPassada;
        while (emDia.has(cursor)) { sequencia++; cursor = semanaAnterior(cursor); }

        let melhorSequencia = 0, corrida = 0, anterior = null;
        [...emDia].sort().forEach(k => {
            corrida = anterior && semanaAnterior(k) === anterior ? corrida + 1 : 1;
            melhorSequencia = Math.max(melhorSequencia, corrida);
            anterior = k;
        });

        // ── Meses ──
        const meses = agregarMeses(transacoes);
        const chavesMeses = Object.keys(meses).sort();
        const mesNoAzul = (k) => (meses[k]?.rec || 0) > 0 && meses[k].rec - meses[k].consumo >= 0;
        const mesesFechadosValidos = chavesMeses.filter(k => k < mesAtualKey && k >= mesInicial);
        const mesesPassadosNoAzul = mesesFechadosValidos.filter(mesNoAzul);

        let melhorSeqAzul = 0, seqAzul = 0, mesAnteriorKey = null;
        mesesFechadosValidos.forEach(k => {
            const consecutivo = mesAnteriorKey && proximoMes(mesAnteriorKey) === k;
            seqAzul = mesNoAzul(k) ? (consecutivo ? seqAzul + 1 : 1) : 0;
            melhorSeqAzul = Math.max(melhorSeqAzul, seqAzul);
            mesAnteriorKey = k;
        });

        const notaDoMes = (k) => notaSaude(meses[k], rendaBase(meses, k));
        const melhorNotaMes = mesesFechadosValidos.reduce((max, k) => Math.max(max, notaDoMes(k)?.nota ?? 0), 0);

        // ── Estilo de vida por semana (todas as transações: é resultado, não esforço) ──
        const estiloPorSemana = {};
        transacoes.forEach(t => {
            if (t.tipo !== 'despesa' || !t.data_competencia || grupoDe(t) !== 'estilo_de_vida') return;
            const sem = chaveSemana(dataLocal(t.data_competencia));
            estiloPorSemana[sem] = (estiloPorSemana[sem] || 0) + valorAbs(t);
        });
        const limiteEstiloDaSemana = (sem) => {
            const base = rendaBase(meses, chaveMes(sem)).base;
            return base > 0 ? Math.round(base * ESTILO_SEMANAL_PCT) : 0;
        };

        // ── Missões de todas as semanas válidas ──
        let xpMissoes = 0;
        for (let sem = semanaInicial; sem <= semanaAtualKey; sem = chaveDia(somarDias(dataLocal(sem), 7))) {
            const encerrada = sem < semanaAtualKey;
            if (emDia.has(sem)) xpMissoes += XP.SEMANA_EM_DIA;
            if ((aportesPorSemana[sem] || 0) >= 1) xpMissoes += XP.APORTE_SEMANA;
            const limite = limiteEstiloDaSemana(sem);
            if (encerrada && emDia.has(sem) && limite > 0 && (estiloPorSemana[sem] || 0) <= limite) xpMissoes += XP.ESTILO_NO_LIMITE;
        }

        // ── Metas ──
        const metasValidas = metas.filter(m => (parseFloat(m.valor_necessario) || 0) >= META_VALOR_MINIMO);
        const aportesPorMeta = {};
        transacoes.forEach(t => {
            if (!t.meta_id || t.tipo !== 'despesa') return;
            aportesPorMeta[t.meta_id] = (aportesPorMeta[t.meta_id] || 0) + valorAbs(t);
        });
        const metaConcluida = (m) => (parseFloat(m.valor_necessario) || 0) >= META_VALOR_MINIMO
            && (aportesPorMeta[m.id] || 0) >= parseFloat(m.valor_necessario);
        const metasConcluidas = metas.filter(metaConcluida);

        // ── XP ──
        const xpCalculado = xpMissoes
            + (metasValidas.length ? XP.PRIMEIRA_META : 0)
            + metasConcluidas.length * XP.META_CONCLUIDA
            + mesesPassadosNoAzul.length * XP.MES_NO_AZUL;
        const xp = Math.max(xpCalculado, xpGuardado);

        // ── Missões da semana atual (para exibir) ──
        const marcouAtual   = semanasMarcadas.has(semanaAtualKey);
        const limiteAtual   = limiteEstiloDaSemana(semanaAtualKey);
        const estiloAtual   = estiloPorSemana[semanaAtualKey] || 0;
        const aportouAtual  = (aportesPorSemana[semanaAtualKey] || 0) >= 1;

        const missoes = [
            {
                id: 'A', icone: '📅', xp: XP.SEMANA_EM_DIA, acao: semanaAtualEmDia ? null : 'checkin',
                titulo: 'Lançar os gastos desta semana',
                atual: semanaAtualEmDia ? 1 : 0, meta: 1, cumprida: semanaAtualEmDia,
                detalhe: semanaAtualEmDia
                    ? (marcouAtual && !semanasComLancamento.has(semanaAtualKey) ? 'Feito! Você marcou que não teve gastos' : 'Feito! Semana em dia')
                    : 'Lance ou importe o extrato — ou toque em “Não tive gastos”'
            },
            limiteAtual > 0
                ? {
                    id: 'B', icone: '🎯', xp: XP.ESTILO_NO_LIMITE, noFimDaSemana: true,
                    titulo: `Gastar até ${formatarMoeda(limiteAtual)} com lazer, delivery e compras`,
                    atualValor: estiloAtual, limiteValor: limiteAtual,
                    estourou: estiloAtual > limiteAtual, cumprida: false
                }
                : {
                    id: 'B', icone: '🎯', xp: XP.ESTILO_NO_LIMITE, bloqueada: true,
                    titulo: 'Controlar lazer, delivery e compras',
                    atual: 0, meta: 1, cumprida: false,
                    detalhe: 'Lance o que você recebe (salário, vendas...) para liberar'
                },
            metasValidas.length
                ? {
                    id: 'C', icone: '🐷', xp: XP.APORTE_SEMANA,
                    titulo: 'Guardar dinheiro em uma meta',
                    atual: aportouAtual ? 1 : 0, meta: 1, cumprida: aportouAtual,
                    detalhe: aportouAtual ? 'Feito!' : 'Ao lançar, responda “Esse dinheiro vai para qual meta?”'
                }
                : {
                    id: 'C', icone: '🐷', xp: XP.PRIMEIRA_META, acao: 'criar-meta',
                    titulo: 'Criar sua primeira meta',
                    atual: 0, meta: 1, cumprida: false, detalhe: `Ex.: reserva de emergência, viagem, um curso (a partir de ${formatarMoeda(META_VALOR_MINIMO)})`
                }
        ];

        // ── Conquistas ──
        const totalEmDia = emDia.size;
        const temInvestimento = doProprio.some(t => grupoDe(t) === 'investimento');
        const temImportacao   = doProprio.some(t => t.origem === 'importacao');
        const conquistas = [
            { id: 'primeiro-passo', icone: '🚀', nome: 'Primeiro passo',   desc: 'Fez o primeiro lançamento',            ok: doProprio.length >= 1 },
            { id: 'embalado',       icone: '🔥', nome: 'Embalado',         desc: '4 semanas seguidas em dia',                  ok: melhorSequencia >= 4,  prog: `${Math.min(melhorSequencia, 4)}/4` },
            { id: 'imparavel',      icone: '☄️', nome: 'Imparável',        desc: '12 semanas seguidas em dia',                 ok: melhorSequencia >= 12, prog: `${Math.min(melhorSequencia, 12)}/12` },
            { id: 'constante',      icone: '✍️', nome: 'Constante',        desc: '10 semanas em dia no total',                 ok: totalEmDia >= 10, prog: `${Math.min(totalEmDia, 10)}/10` },
            { id: 'veterano',       icone: '💯', nome: 'Veterano',         desc: '26 semanas em dia no total',                 ok: totalEmDia >= 26, prog: `${Math.min(totalEmDia, 26)}/26` },
            { id: 'sonhador',       icone: '🌱', nome: 'Sonhador',         desc: 'Criou a primeira meta',                      ok: metasValidas.length >= 1 },
            { id: 'meta-batida',    icone: '🏆', nome: 'Meta batida',      desc: 'Completou uma meta guardando dinheiro',              ok: metasConcluidas.length >= 1 },
            { id: 'investidor',     icone: '📈', nome: 'Investidor',       desc: 'Guardou dinheiro em investimento pela 1ª vez',      ok: temInvestimento },
            { id: 'mes-azul',       icone: '💙', nome: 'Mês no azul',      desc: 'Fechou um mês gastando menos do que ganhou', ok: mesesPassadosNoAzul.length >= 1 },
            { id: 'trimestre-azul', icone: '🌊', nome: 'Trimestre no azul', desc: '3 meses seguidos no azul',                  ok: melhorSeqAzul >= 3, prog: `${Math.min(melhorSeqAzul, 3)}/3` },
            { id: 'nota-80',        icone: '⭐', nome: 'Saúde de ferro',   desc: 'Tirou nota 80 ou mais em um mês',         ok: melhorNotaMes >= 80 },
            { id: 'importador',     icone: '📥', nome: 'Automatizado',     desc: 'Importou um extrato do banco',               ok: temImportacao }
        ];

        // ── Evolução: últimos 6 períodos (inclui o atual). Investimento não é gasto. ──
        const evolucao = [];
        for (let i = 5; i >= 0; i--) {
            const k = mesAnteriorDe(mesAtualKey, i);
            const [anoK, mesK] = k.split('-').map(Number);
            const m = meses[k] || { rec: 0, consumo: 0, inv: 0 };
            const custom = cicloCustomizado();
            evolucao.push({
                chave: k,
                rotulo: custom ? CicloModule.formatarBR(CicloModule.inicioDoMes(cicloAtivo, anoK, mesK - 1)) : MESES_CURTOS[mesK - 1],
                ano: anoK,
                titulo: custom ? rotuloPeriodo(k) : `${MESES_CURTOS[mesK - 1]} ${anoK}`,
                rec: m.rec, desp: m.consumo, inv: m.inv, saldo: m.rec - m.consumo, atual: i === 0
            });
        }

        // ── Cofrinhos (a barra mostra o valor da meta; "concluída" exige os aportes) ──
        const cofrinhos = metas.map(m => {
            const nec = parseFloat(m.valor_necessario) || 0;
            const eco = parseFloat(m.valor_economizado) || 0;
            return { id: m.id, nome: m.nome, necessario: nec, economizado: eco, pct: nec > 0 ? Math.min(eco / nec, 1) : 0, concluida: metaConcluida(m) };
        }).sort((a, b) => (a.pct >= 1) - (b.pct >= 1) || b.pct - a.pct);

        // ── Saúde: último mês fechado + prévia do atual ──
        const mesFechado = mesAnteriorDe(mesAtualKey);
        const notaFechado = notaDoMes(mesFechado);
        const notaAntes   = notaDoMes(mesAnteriorDe(mesAtualKey, 2));
        const previa      = notaDoMes(mesAtualKey);
        let saude = null;
        if (notaFechado) {
            saude = {
                nota: notaFechado.nota, ...faixaSaude(notaFechado.nota),
                mes: rotuloPeriodo(mesFechado), ehPrevia: false, usouMedia: notaFechado.usouMedia,
                delta: notaAntes ? notaFechado.nota - notaAntes.nota : null,
                mesAnterior: rotuloPeriodo(mesAnteriorDe(mesAtualKey, 2)),
                dica: dicaDaNota(notaFechado),
                previa: previa ? { nota: previa.nota, mes: rotuloPeriodo(mesAtualKey), ...faixaSaude(previa.nota) } : null
            };
        } else if (previa) {
            saude = {
                nota: previa.nota, ...faixaSaude(previa.nota),
                mes: rotuloPeriodo(mesAtualKey), ehPrevia: true, usouMedia: previa.usouMedia,
                delta: null, dica: dicaDaNota(previa), previa: null
            };
        }

        return {
            nivel: nivelDoXp(xp), xpCalculado,
            sequencia, melhorSequencia,
            semanaAtualKey, semanaPassadaKey: semanaPassada,
            semanaAtualEmDia,
            semanaPassadaEmDia: emDia.has(semanaPassada),
            podeMarcarSemanaPassada: !emDia.has(semanaPassada) && semanaPassada >= semanaInicial && !!primeiraAtividade,
            saude, missoes, conquistas, evolucao, cofrinhos,
            totalSemanasEmDia: totalEmDia,
            totalLancamentos: doProprio.length
        };
    }

    // ── Formatação ──────────────────────────────────────────────
    function formatarMoeda(v) {
        if (typeof UIModule !== 'undefined' && UIModule.formatCurrency) return UIModule.formatCurrency(v);
        return (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }

    function formatarCompacto(v) {
        const n = Math.abs(v);
        if (n >= 1000) return `R$ ${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
        return `R$ ${Math.round(v).toLocaleString('pt-BR')}`;
    }

    const esc = (s) => (typeof escaparHtml === 'function' ? escaparHtml(s) : String(s ?? ''));
    const som = (tipo) => { if (typeof SomModule !== 'undefined') SomModule.tocar(tipo); };

    // ══════════════════════════════════════════════════════════════
    // RENDER
    // ══════════════════════════════════════════════════════════════

    function renderHero(e) {
        const el = document.getElementById('gamiHero');
        if (!el) return;

        const n = e.nivel;
        const pct = Math.round(n.progresso * 100);
        const faltam = n.proximo ? n.proximo.xp - n.xp : 0;

        const plural = (q) => q === 1 ? '1 semana' : `${q} semanas`;
        const sequenciaSub = e.semanaAtualEmDia
            ? '✓ Esta semana está em dia'
            : e.sequencia > 0 ? 'Lance os gastos desta semana até domingo para não perder' : 'Lance os gastos desta semana para começar';

        const botaoSemana = e.semanaAtualEmDia ? '' : `
            <button type="button" class="gami-checkin" onclick="GamificacaoModule.marcarSemana('atual')">✅ Não tive gastos esta semana</button>`;
        const linkSemanaPassada = e.podeMarcarSemanaPassada ? `
            <button type="button" class="gami-link gami-link--pequeno" onclick="GamificacaoModule.marcarSemana('passada')">Semana passada ficou vazia? Toque aqui se não teve gastos nela</button>` : '';

        const s = e.saude;
        const R = 34, C = 2 * Math.PI * R;
        const anel = s
            ? `<svg class="gami-anel" viewBox="0 0 84 84" role="img" aria-label="Saúde financeira ${s.nota} de 100">
                   <circle cx="42" cy="42" r="${R}" class="gami-anel__trilho"/>
                   <circle cx="42" cy="42" r="${R}" class="gami-anel__valor gami-anel__valor--${s.classe}"
                       stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - s.nota / 100)).toFixed(1)}"
                       transform="rotate(-90 42 42)"/>
                   <text x="42" y="48" text-anchor="middle" class="gami-anel__numero">${s.nota}</text>
               </svg>`
            : `<div class="gami-anel gami-anel--vazio" aria-hidden="true">—</div>`;

        const delta = !s || s.delta === null ? ''
            : s.delta === 0
                ? `<span class="gami-delta">= mesma nota de ${esc(s.mesAnterior)}</span>`
                : `<span class="gami-delta ${s.delta > 0 ? 'gami-delta--sobe' : 'gami-delta--desce'}">${s.delta > 0 ? '▲' : '▼'} ${Math.abs(s.delta)} ${s.delta > 0 ? 'a mais' : 'a menos'} que ${esc(s.mesAnterior)}</span>`;

        const rotuloSaude = s ? `Nota de ${esc(s.mes)}${s.ehPrevia ? ' (até agora)' : ''}` : 'Nota do mês';
        const linhaPrevia = s?.previa
            ? `<p class="gami-sub gami-sub--discreto">${esc(s.previa.mes.charAt(0).toUpperCase() + s.previa.mes.slice(1))} até agora: <strong>${s.previa.nota}</strong></p>`
            : s?.ehPrevia ? `<p class="gami-sub gami-sub--discreto">A nota final sai quando o mês terminar.</p>` : '';
        const linhaMedia = s?.usouMedia
            ? `<p class="gami-sub gami-sub--discreto">Como o que você recebeu veio menor que o normal, usamos a média dos últimos meses.</p>` : '';

        el.innerHTML = `
            <div class="gami-card gami-nivel">
                <div class="gami-nivel__topo">
                    <div class="gami-nivel__selo" aria-hidden="true">${n.numero}</div>
                    <div>
                        <p class="gami-rotulo">Nível ${n.numero}</p>
                        <p class="gami-titulo">${esc(n.nome)}</p>
                    </div>
                    <span class="gami-xp-total">${n.xp.toLocaleString('pt-BR')} pontos</span>
                </div>
                <div class="gami-barra" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Progresso para o próximo nível">
                    <div class="gami-barra__preenchimento" style="width:${pct}%"></div>
                </div>
                <p class="gami-sub">${n.proximo
                    ? `Faltam <strong>${faltam.toLocaleString('pt-BR')} pontos</strong> para o nível ${n.numero + 1} · ${esc(n.proximo.nome)}`
                    : 'Você chegou ao nível máximo. Lendário!'}</p>
            </div>

            <div class="gami-card gami-sequencia ${e.semanaAtualEmDia ? '' : 'gami-sequencia--pendente'}">
                <p class="gami-rotulo">Semanas em dia</p>
                <p class="gami-sequencia__valor"><span class="gami-sequencia__fogo" aria-hidden="true">🔥</span>${plural(e.sequencia)}</p>
                <p class="gami-sub">${sequenciaSub}</p>
                ${botaoSemana}
                ${linkSemanaPassada}
                <p class="gami-sub gami-sub--discreto">Recorde: ${plural(e.melhorSequencia)}</p>
            </div>

            <div class="gami-card gami-saude">
                ${anel}
                <div class="gami-saude__texto">
                    <p class="gami-rotulo">${rotuloSaude}</p>
                    ${s
                        ? `<p class="gami-titulo gami-saude__label gami-saude__label--${s.classe}">${s.label}</p>${delta}
                           <p class="gami-sub">${esc(s.dica)}</p>${linhaPrevia}${linhaMedia}`
                        : `<p class="gami-titulo">Sem nota ainda</p>
                           <p class="gami-sub">Lance o que você recebe (salário, vendas...) para ver sua nota de 0 a 100.</p>`}
                </div>
            </div>
        `;
    }

    function renderMissoes(e) {
        const el = document.getElementById('gamiMissoes');
        if (!el) return;

        const feitas = e.missoes.filter(m => m.cumprida).length;

        el.innerHTML = `
            <div class="gami-secao-topo">
                <h3>⚡ Missões da semana</h3>
                <span class="gami-secao-topo__dir">
                    <button type="button" class="gami-link" onclick="typeof TourModule !== 'undefined' && TourModule.abrir()">Como funciona?</button>
                    <span class="gami-contador">${feitas}/${e.missoes.length}</span>
                </span>
            </div>
            <ul class="gami-missoes">
                ${e.missoes.map(m => {
                    let progresso, detalhe;
                    if (m.limiteValor) {
                        progresso = Math.min(m.atualValor / (m.limiteValor || 1), 1) * 100;
                        detalhe = m.estourou
                            ? `${formatarMoeda(m.atualValor)} — passou do limite de ${formatarMoeda(m.limiteValor)}`
                            : `${formatarMoeda(m.atualValor)} de ${formatarMoeda(m.limiteValor)} · conta no domingo`;
                    } else {
                        progresso = (m.atual / m.meta) * 100;
                        detalhe = m.detalhe || `${m.atual}/${m.meta}`;
                    }
                    const estado = m.cumprida ? 'feita' : (m.estourou ? 'falhou' : (m.bloqueada ? 'bloqueada' : 'aberta'));
                    const acao = m.acao === 'criar-meta'
                        ? `<button type="button" class="gami-missao__acao" onclick="navegarParaSecaoCliente('cli-goals')">Criar</button>`
                        : m.acao === 'checkin'
                            ? `<button type="button" class="gami-missao__acao gami-missao__acao--sec" onclick="GamificacaoModule.marcarSemana('atual')" title="Toque se você não teve nenhum gasto nem recebimento nesta semana">Não tive gastos</button>`
                            : '';
                    return `
                        <li class="gami-missao gami-missao--${estado}">
                            <span class="gami-missao__icone" aria-hidden="true">${m.cumprida ? '✅' : m.icone}</span>
                            <div class="gami-missao__corpo">
                                <p class="gami-missao__titulo">${esc(m.titulo)}</p>
                                <div class="gami-barra gami-barra--fina ${m.limiteValor ? 'gami-barra--limite' : ''}">
                                    <div class="gami-barra__preenchimento" style="width:${Math.max(progresso, 3)}%"></div>
                                </div>
                                <p class="gami-missao__detalhe">${esc(detalhe)}</p>
                            </div>
                            <span class="gami-missao__xp">+${m.xp} pts</span>
                            ${acao}
                        </li>`;
                }).join('')}
            </ul>
        `;
    }

    function renderCofrinhos(e) {
        const el = document.getElementById('gamiCofrinhos');
        if (!el) return;

        if (!e.cofrinhos.length) {
            el.innerHTML = `
                <div class="gami-secao-topo"><h3>🐷 Seus cofrinhos</h3></div>
                <div class="gami-vazio">
                    <p>Cada meta vira um cofrinho que enche conforme você guarda dinheiro.</p>
                    <button type="button" class="btn btn--secondary" onclick="navegarParaSecaoCliente('cli-goals')">+ Criar primeira meta</button>
                </div>`;
            return;
        }

        const lista = e.cofrinhos.slice(0, 4);
        el.innerHTML = `
            <div class="gami-secao-topo">
                <h3>🐷 Seus cofrinhos</h3>
                <button type="button" class="gami-link" onclick="navegarParaSecaoCliente('cli-goals')">Ver metas →</button>
            </div>
            <div class="gami-cofrinhos">
                ${lista.map(c => {
                    const pct = Math.round(c.pct * 100);
                    const cheio = c.pct >= 1;
                    return `
                        <div class="gami-cofrinho ${cheio ? 'gami-cofrinho--cheio' : ''}" title="${esc(c.nome)}: ${formatarMoeda(c.economizado)} de ${formatarMoeda(c.necessario)}">
                            <div class="gami-cofrinho__pote" role="img" aria-label="${esc(c.nome)} ${pct}%">
                                <div class="gami-cofrinho__liquido" style="height:${Math.max(pct, 4)}%"></div>
                                <span class="gami-cofrinho__pct">${cheio ? '✓' : pct + '%'}</span>
                            </div>
                            <p class="gami-cofrinho__nome">${esc(c.nome)}</p>
                            <p class="gami-cofrinho__valor">${c.concluida ? 'Concluída!' : cheio ? 'Valor atingido' : `${formatarCompacto(c.economizado)} de ${formatarCompacto(c.necessario)}`}</p>
                        </div>`;
                }).join('')}
            </div>
        `;
    }

    let ultimoEstadoEvolucao = null;
    let redimensionamentoLigado = false;

    function renderEvolucao(e) {
        const el = document.getElementById('gamiEvolucao');
        if (!el) return;
        ultimoEstadoEvolucao = e;

        const dados = e.evolucao;
        const temDados = dados.some(d => d.rec > 0 || d.desp > 0);

        el.innerHTML = `
            <div class="gami-secao-topo">
                <h3>📈 Evolução dos últimos 6 meses</h3>
                <div class="gami-legenda">
                    <span><i style="background:${COR_RECEITA}"></i>Entrou</span>
                    <span><i style="background:${COR_DESPESA}"></i>Saiu</span>
                </div>
            </div>
            ${temDados
                ? `<div class="gami-grafico"></div>
                   <p class="gami-sub gami-sub--discreto">O número embaixo de cada mês é quanto sobrou (o que entrou menos o que saiu). Dinheiro guardado em metas e investimentos conta como sobra. Toque numa coluna para ver os valores.</p>`
                : `<div class="gami-vazio"><p>Assim que você lançar o que entra e o que sai, a evolução de cada mês aparece aqui.</p></div>`}
        `;

        if (!temDados) return;
        desenharGraficoEvolucao(el, dados);

        // Redesenha na largura nova quando a tela muda (girar o celular etc.)
        if (!redimensionamentoLigado) {
            redimensionamentoLigado = true;
            let timer = null;
            window.addEventListener('resize', () => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    const alvo = document.getElementById('gamiEvolucao');
                    const grafico = alvo?.querySelector('.gami-grafico');
                    if (grafico && ultimoEstadoEvolucao) desenharGraficoEvolucao(alvo, ultimoEstadoEvolucao.evolucao);
                }, 150);
            });
        }
    }

    /**
     * Desenha o SVG na LARGURA REAL do card (1 unidade = 1 pixel), para
     * o texto sair sempre no mesmo tamanho — sem esticar no computador
     * nem encolher no celular. Em telas estreitas os rótulos ficam
     * mais curtos ("4 mil" → "4k").
     */
    function desenharGraficoEvolucao(el, dados) {
        const grafico = el.querySelector('.gami-grafico');
        if (!grafico) return;

        const W = Math.max(280, Math.round(grafico.clientWidth || 640));
        const estreito = W < 520;
        const H = estreito ? 210 : 240;
        const esq = estreito ? 38 : 64, dir = 8, topo = 12, base = 44;
        const alturaUtil = H - topo - base;
        const colW = (W - esq - dir) / dados.length;
        const barW = Math.max(8, Math.min(28, colW * 0.3));
        const gap  = 3;
        const max  = Math.max(1, ...dados.map(d => Math.max(d.rec, d.desp)));
        const y    = (v) => topo + alturaUtil - (v / max) * alturaUtil;

        const passo = escalaPasso(max);
        const ticks = [];
        for (let v = 0; v <= max + 0.001; v += passo) ticks.push(v);

        const rotuloEixo  = (v) => estreito ? formatarMuitoCompacto(v) : formatarCompacto(v);
        const rotuloSaldo = (v) => (v >= 0 ? '+' : '−') + (estreito ? formatarMuitoCompacto(Math.abs(v)) : formatarCompacto(Math.abs(v)));

        const barra = (x, v, cor) => {
            const h = Math.max((v / max) * alturaUtil, v > 0 ? 2 : 0);
            if (!h) return '';
            const yTop = topo + alturaUtil - h;
            const r = Math.min(4, h / 2);
            // topo arredondado, base reta na linha zero
            return `<path d="M${x},${topo + alturaUtil} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${topo + alturaUtil} Z" fill="${cor}"/>`;
        };

        grafico.innerHTML = `
            <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Receitas e despesas por mês nos últimos 6 meses">
                ${ticks.map(v => `
                    <line x1="${esq}" x2="${W - dir}" y1="${y(v)}" y2="${y(v)}" class="gami-grafico__grade"/>
                    <text x="${esq - 6}" y="${y(v) + 4}" text-anchor="end" class="gami-grafico__eixo">${rotuloEixo(v)}</text>`).join('')}
                ${dados.map((d, i) => {
                    const cx = esq + colW * i + colW / 2;
                    const saldoTxt = d.rec || d.desp ? rotuloSaldo(d.saldo) : '—';
                    return `
                        <g class="gami-grafico__coluna" data-i="${i}">
                            <rect x="${esq + colW * i}" y="${topo}" width="${colW}" height="${alturaUtil + base}" rx="6" class="gami-grafico__alvo"/>
                            ${barra(cx - barW - gap / 2, d.rec, COR_RECEITA)}
                            ${barra(cx + gap / 2, d.desp, COR_DESPESA)}
                            <text x="${cx}" y="${H - base + 18}" text-anchor="middle" class="gami-grafico__mes ${d.atual ? 'gami-grafico__mes--atual' : ''}">${d.rotulo}</text>
                            <text x="${cx}" y="${H - base + 34}" text-anchor="middle" class="gami-grafico__saldo ${d.rec || d.desp ? (d.saldo >= 0 ? 'pos' : 'neg') : ''}">${saldoTxt}</text>
                        </g>`;
                }).join('')}
            </svg>
            <div class="gami-tooltip hidden" role="status"></div>`;

        const tip = grafico.querySelector('.gami-tooltip');
        const mostrar = (g) => {
            const d = dados[+g.dataset.i];
            grafico.querySelectorAll('.gami-grafico__coluna').forEach(c => c.classList.toggle('ativa', c === g));
            tip.innerHTML = `
                <strong>${esc(d.titulo)}${d.atual ? ' · até hoje' : ''}</strong>
                <span><i style="background:${COR_RECEITA}"></i>Entrou <b>${formatarMoeda(d.rec)}</b></span>
                <span><i style="background:${COR_DESPESA}"></i>Saiu <b>${formatarMoeda(d.desp)}</b></span>
                ${d.inv > 0 ? `<span>Guardado <b class="pos">${formatarMoeda(d.inv)}</b></span>` : ''}
                <span>Sobrou <b class="${d.saldo >= 0 ? 'pos' : 'neg'}">${formatarMoeda(d.saldo)}</b></span>`;
            tip.classList.remove('hidden');
            const gb = g.getBoundingClientRect(), cb = grafico.getBoundingClientRect();
            const left = Math.min(Math.max(gb.left - cb.left + gb.width / 2 - tip.offsetWidth / 2, 0), cb.width - tip.offsetWidth);
            tip.style.left = `${left}px`;
        };
        grafico.querySelectorAll('.gami-grafico__coluna').forEach(g => {
            g.addEventListener('mouseenter', () => mostrar(g));
            g.addEventListener('click', () => mostrar(g));
        });
        grafico.addEventListener('mouseleave', () => {
            tip.classList.add('hidden');
            grafico.querySelectorAll('.gami-grafico__coluna').forEach(c => c.classList.remove('ativa'));
        });
    }

    function formatarMuitoCompacto(v) {
        const n = Math.abs(v);
        if (n >= 1000) return `${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}k`;
        return `${Math.round(v)}`;
    }

    function escalaPasso(max) {
        const bruto = max / 4;
        const mag = Math.pow(10, Math.floor(Math.log10(bruto)));
        const n = bruto / mag;
        return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
    }

    function renderConquistas(e) {
        const el = document.getElementById('gamiConquistas');
        if (!el) return;
        const ganhas = e.conquistas.filter(c => c.ok).length;

        el.innerHTML = `
            <div class="gami-secao-topo">
                <h3>🏅 Conquistas</h3>
                <span class="gami-contador">${ganhas} de ${e.conquistas.length}</span>
            </div>
            <div class="gami-conquistas">
                ${[...e.conquistas].sort((a, b) => b.ok - a.ok).map(c => `
                    <div class="gami-conquista ${c.ok ? 'gami-conquista--ok' : ''}" title="${esc(c.desc)}">
                        <span class="gami-conquista__icone" aria-hidden="true">${c.ok ? c.icone : '🔒'}</span>
                        <p class="gami-conquista__nome">${esc(c.nome)}</p>
                        <p class="gami-conquista__desc">${c.ok ? esc(c.desc) : (c.prog ? `${esc(c.desc)} · ${c.prog}` : esc(c.desc))}</p>
                    </div>`).join('')}
            </div>
        `;
    }


    // ── Comemorações (compara com a última vez que o cliente viu) ──
    // Chave "gami2": as regras mudaram em out/2026; a primeira visita
    // depois disso não comemora conquistas "novas" que só mudaram de nome.
    function chaveStorage(clientId) { return `mentorfin_gami2_${clientId}`; }

    function lerAnterior(clientId) {
        try { return JSON.parse(localStorage.getItem(chaveStorage(clientId)) || 'null'); } catch (_) { return null; }
    }

    function salvarAtual(clientId, e) {
        try {
            localStorage.setItem(chaveStorage(clientId), JSON.stringify({
                xp: e.nivel.xp, nivel: e.nivel.numero,
                conquistas: e.conquistas.filter(c => c.ok).map(c => c.id),
                metasConcluidas: e.cofrinhos.filter(c => c.concluida).map(c => c.id)
            }));
        } catch (_) { /* navegador sem storage: só não comemora */ }
    }

    function comemorar(clientId, e) {
        const antes = lerAnterior(clientId);
        salvarAtual(clientId, e);
        if (!antes) return; // primeira visita: sem festa por coisas antigas

        const ganhouXp = e.nivel.xp - (antes.xp || 0);
        const novasConquistas = e.conquistas.filter(c => c.ok && !(antes.conquistas || []).includes(c.id));
        const novasMetas = e.cofrinhos.filter(c => c.concluida && !(antes.metasConcluidas || []).includes(c.id));
        const subiuNivel = e.nivel.numero > (antes.nivel || 1);
        const festa = subiuNivel || novasConquistas.length || novasMetas.length;

        if (ganhouXp > 0) mostrarXpFlutuante(ganhouXp);
        if (festa) { confete(); som('conquista'); }
        else if (ganhouXp > 0) som('xp');

        const avisos = [];
        if (subiuNivel) avisos.push(`🎉 Você subiu para o nível ${e.nivel.numero} · ${e.nivel.nome}!`);
        novasMetas.forEach(c => avisos.push(`🐷 Meta "${c.nome}" concluída!`));
        novasConquistas.forEach(c => avisos.push(`${c.icone} Conquista desbloqueada: ${c.nome}`));
        avisos.forEach((texto, i) => setTimeout(() => mostrarBanner(texto), 400 + i * 2200));
    }

    function mostrarXpFlutuante(qtd) {
        const alvo = document.querySelector('.gami-xp-total');
        const el = document.createElement('div');
        el.className = 'gami-xp-flutuante';
        el.textContent = `+${qtd} pontos`;
        document.body.appendChild(el);
        const r = alvo ? alvo.getBoundingClientRect() : null;
        if (r && r.width > 0 && r.bottom > 0 && r.top < window.innerHeight) {
            el.style.left = `${r.left + r.width / 2}px`;
            el.style.top  = `${r.top}px`;
        } else {
            // Placar fora da tela (outra aba/rolado): mostra no centro-topo.
            el.style.left = '50%';
            el.style.top  = '90px';
        }
        setTimeout(() => el.remove(), 1600);
    }

    function mostrarBanner(texto) {
        const el = document.createElement('div');
        el.className = 'gami-banner';
        el.setAttribute('role', 'status');
        el.textContent = texto;
        document.body.appendChild(el);
        requestAnimationFrame(() => el.classList.add('gami-banner--visivel'));
        setTimeout(() => { el.classList.remove('gami-banner--visivel'); setTimeout(() => el.remove(), 400); }, 2000);
    }

    function confete() {
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
        const cores = ['#6495ff', '#1f9d8a', '#fbbf24', '#e0663a', '#a78bfa', '#ffffff'];
        const camada = document.createElement('div');
        camada.className = 'gami-confete';
        for (let i = 0; i < 90; i++) {
            const p = document.createElement('i');
            p.style.left = `${Math.random() * 100}%`;
            p.style.background = cores[i % cores.length];
            p.style.animationDelay = `${Math.random() * 0.4}s`;
            p.style.animationDuration = `${1.8 + Math.random() * 1.2}s`;
            p.style.setProperty('--desvio', `${(Math.random() - 0.5) * 240}px`);
            p.style.setProperty('--giro', `${Math.random() * 720 - 360}deg`);
            camada.appendChild(p);
        }
        document.body.appendChild(camada);
        setTimeout(() => camada.remove(), 3600);
    }


    // ══════════════════════════════════════════════════════════════
    // BANCO — semanas marcadas e XP guardado (tabelas da migração
    // MIGRACAO-gamificacao-v2.sql). Sem as tabelas, tudo continua
    // funcionando: só não há "nada a registrar" e o XP é recalculado.
    // ══════════════════════════════════════════════════════════════
    const temBanco = (clientId) => clientId && clientId !== 'demo'
        && typeof supabaseClient !== 'undefined' && supabaseClient;

    let contexto = { transacoes: [], metas: [], clientId: null, checkins: [], xpGuardado: 0, ciclo: null };
    let ultimoEstado = null;

    async function carregarDadosDoBanco(clientId) {
        const resultado = { checkins: [], xpGuardado: 0 };
        if (!temBanco(clientId)) return resultado;
        const [sem, est] = await Promise.all([
            supabaseClient.from('gamificacao_semanas').select('semana, tipo').eq('client_id', clientId),
            supabaseClient.from('gamificacao_estado').select('xp_max').eq('client_id', clientId).maybeSingle()
        ]);
        if (!sem.error) resultado.checkins = sem.data || [];
        else console.warn('⚠️ gamificacao_semanas:', sem.error.message);
        if (!est.error) resultado.xpGuardado = est.data?.xp_max || 0;
        return resultado;
    }

    async function guardarXp(clientId, xp) {
        if (!temBanco(clientId)) return;
        const { error } = await supabaseClient.rpc('gamificacao_registrar_xp', { p_xp: xp });
        if (error) console.warn('⚠️ gamificacao_registrar_xp:', error.message);
    }

    function desenhar(estado) {
        renderHero(estado);
        renderMissoes(estado);
        renderCofrinhos(estado);
        renderEvolucao(estado);
        renderConquistas(estado);
    }

    // ── API pública ─────────────────────────────────────────────
    /**
     * Calcula e desenha tudo. Assíncrono: busca as semanas marcadas e o
     * XP guardado do cliente antes de calcular. Erros nunca sobem —
     * a gamificação não pode derrubar o painel.
     */
    async function render(transacoes, metas, clientId, opcoes = {}) {
        try {
            const doBanco = await carregarDadosDoBanco(clientId);
            const checkins = [...doBanco.checkins, ...(opcoes.checkins || [])];
            contexto = { transacoes: transacoes || [], metas: metas || [], clientId, checkins, xpGuardado: doBanco.xpGuardado, ciclo: opcoes.ciclo || null };

            const estado = calcular(contexto.transacoes, contexto.metas, new Date(), { checkins, xpGuardado: doBanco.xpGuardado, ciclo: opcoes.ciclo });
            ultimoEstado = estado;
            desenhar(estado);
            if (clientId) comemorar(clientId, estado);
            if (estado.xpCalculado > doBanco.xpGuardado) guardarXp(clientId, estado.xpCalculado);

            if (clientId && clientId !== 'demo' && typeof NotificacoesModule !== 'undefined' && NotificacoesModule.lembreteSemanal) {
                NotificacoesModule.lembreteSemanal(estado);
            }
            return estado;
        } catch (err) {
            console.error('❌ GamificacaoModule.render:', err);
            return null;
        }
    }

    /**
     * "Nada a registrar / revisei a semana". `qual` = 'atual' | 'passada'.
     * Na demo (clientId 'demo') fica só na memória da página.
     */
    async function marcarSemana(qual = 'atual') {
        if (!ultimoEstado) return;
        const semana = qual === 'passada' ? ultimoEstado.semanaPassadaKey : ultimoEstado.semanaAtualKey;
        const { clientId } = contexto;
        const avisar = (msg, tipo = 'success') => {
            if (typeof UIModule !== 'undefined') {
                if (tipo === 'error' && UIModule.showError) UIModule.showError(msg);
                else if (UIModule.showSuccess) UIModule.showSuccess(msg);
                else if (typeof demoAviso === 'function') demoAviso(msg);
            }
        };

        if (temBanco(clientId)) {
            const { error } = await supabaseClient
                .from('gamificacao_semanas')
                .upsert({ client_id: clientId, semana, tipo: 'revisada' }, { onConflict: 'client_id,semana', ignoreDuplicates: true });
            if (error) {
                console.error('❌ marcarSemana:', error.message);
                avisar(/relation|does not exist|schema cache/i.test(error.message)
                    ? 'Este recurso ainda não está disponível. Avise o seu consultor.'
                    : 'Não foi possível marcar a semana. Tente de novo.', 'error');
                return;
            }
            await render(contexto.transacoes, contexto.metas, clientId, { ciclo: contexto.ciclo });
        } else {
            const extras = [...contexto.checkins, { semana, tipo: 'revisada' }];
            await render(contexto.transacoes, contexto.metas, clientId, { checkins: extras, ciclo: contexto.ciclo });
        }
        avisar(qual === 'passada' ? '✅ Pronto! Semana passada marcada como sem gastos.' : '✅ Pronto! Esta semana está em dia.');
    }

    return {
        calcular, render, marcarSemana,
        estadoAtual: () => ultimoEstado,
        _interno: { notaSaude, rendaBase, agregarMeses, nivelDoXp, parseCriadoEm, chaveSemana, NIVEIS, XP }
    };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = GamificacaoModule;

console.log('✅ gamificacao.js carregado (regras v2: semanas em dia)');
