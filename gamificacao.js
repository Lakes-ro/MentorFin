/**
 * GAMIFICACAO.JS — Nível, sequência, saúde financeira, missões,
 * cofrinhos, evolução e conquistas (painel do CLIENTE)
 * ================================================
 * Padrão: script global (IIFE `GamificacaoModule`). Sem import/export.
 * Carregado depois de app.js; chamado por loadClientDashboard().
 *
 * TUDO É CALCULADO A PARTIR DO QUE JÁ EXISTE NO BANCO (transacoes +
 * metas) — nenhuma tabela nova. Como o cálculo é determinístico, o
 * cliente vê sempre o mesmo nível/XP em qualquer aparelho, e o admin
 * pode reproduzir os números.
 *
 * REGRAS
 * ------
 * XP (pontos de experiência):
 *   +10 por lançamento registrado (no máximo 5 por dia — importar
 *       um extrato de 200 linhas não vira 2.000 XP)
 *   +40 por aporte vinculado a uma meta
 *   +100 por meta concluída
 *   +50 por mês fechado no azul (meses anteriores, com receita lançada)
 *   +50 por criar a primeira meta
 *   + recompensa de cada missão semanal cumprida (semanas passadas e a
 *     atual — a de "estilo de vida" só conta quando a semana termina)
 *
 * Sequência: dias seguidos (horário local) com pelo menos um
 *   lançamento registrado. Se hoje ainda não teve registro, a sequência
 *   de ontem continua valendo até o fim do dia.
 *
 * Saúde do mês (0–100), sobre o mês corrente até hoje, sem
 * transferências internas:
 *   30 saldo (gastar menos do que ganha)
 *   25 poupança + investimento ≥ 20% da renda
 *   20 essencial ≤ 50% da renda
 *   15 estilo de vida ≤ 30% da renda
 *   10 dívidas ≤ 10% da renda
 *   Sem receita lançada no mês → sem nota (pede para lançar a renda).
 *
 * Missões da semana (segunda a domingo):
 *   A. Registrar 5 lançamentos                      +30 XP
 *   B. Registrar em 4 dias diferentes               +30 XP
 *   C. Gastar menos com estilo de vida que na semana
 *      passada (ou até R$ 100, se ela foi zero)     +40 XP (no fim da semana)
 *   D. Fazer um aporte numa meta (ou criar a 1ª)   +40 XP
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
        LANCAMENTO: 10, LANCAMENTOS_MAX_DIA: 5,
        APORTE_META: 40, META_CONCLUIDA: 100, PRIMEIRA_META: 50, MES_NO_AZUL: 50,
        MISSAO_A: 30, MISSAO_B: 30, MISSAO_C: 40, MISSAO_D: 40
    };

    const LIMITE_ESTILO_SEM_REFERENCIA = 100; // R$ — missão C quando a semana anterior foi zero
    const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

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
    const chaveMes    = (isoDia) => String(isoDia).slice(0, 7);

    function somarDias(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

    // ── Agregados ───────────────────────────────────────────────
    const valorAbs = (t) => Math.abs(parseFloat(t.valor) || 0);
    const grupoDe  = (t) => t.categorias?.grupo || '';

    function agregarMeses(transacoes) {
        const meses = {};
        transacoes.forEach(t => {
            if (!t.data_competencia || grupoDe(t) === 'transferencia') return;
            const k = chaveMes(t.data_competencia);
            const m = meses[k] || (meses[k] = { rec: 0, desp: 0, ess: 0, estilo: 0, inv: 0, div: 0 });
            const v = valorAbs(t);
            if (t.tipo === 'receita') { m.rec += v; return; }
            m.desp += v;
            const g = grupoDe(t);
            if (g === 'essencial') m.ess += v;
            else if (g === 'investimento') m.inv += v;
            else if (g === 'divida') m.div += v;
            else m.estilo += v;
        });
        return meses;
    }

    function notaSaude(m) {
        if (!m || m.rec <= 0) return null;
        const clamp = (x) => Math.max(0, Math.min(1, x));
        const saldo = m.rec - m.desp;
        const pSaldo  = saldo >= 0 ? 1 : clamp(1 - (-saldo / m.rec) * 2);
        const pPoup   = clamp(((m.inv + Math.max(0, saldo)) / m.rec) / 0.20);
        const pEss    = m.ess / m.rec <= 0.5 ? 1 : clamp(1 - (m.ess / m.rec - 0.5) / 0.5);
        const pEstilo = m.estilo / m.rec <= 0.3 ? 1 : clamp(1 - (m.estilo / m.rec - 0.3) / 0.3);
        const pDiv    = m.div / m.rec <= 0.1 ? 1 : clamp(1 - (m.div / m.rec - 0.1) / 0.3);

        const componentes = [
            { chave: 'saldo',  peso: 30, valor: pSaldo },
            { chave: 'poup',   peso: 25, valor: pPoup },
            { chave: 'ess',    peso: 20, valor: pEss },
            { chave: 'estilo', peso: 15, valor: pEstilo },
            { chave: 'div',    peso: 10, valor: pDiv }
        ];
        const nota = Math.round(componentes.reduce((s, c) => s + c.peso * c.valor, 0));
        return { nota, componentes, saldo };
    }

    function faixaSaude(nota) {
        if (nota >= 80) return { label: 'Excelente', classe: 'otima' };
        if (nota >= 60) return { label: 'Boa',       classe: 'boa' };
        if (nota >= 40) return { label: 'Atenção',   classe: 'atencao' };
        return               { label: 'Crítica',    classe: 'critica' };
    }

    const DICA_COMPONENTE = {
        saldo:  'Você está gastando mais do que recebe neste mês — segure os gastos variáveis até o fim do mês.',
        poup:   'Tente separar pelo menos 20% da renda para uma meta ou investimento.',
        ess:    'Os gastos essenciais passaram de 50% da renda — vale revisar contas fixas.',
        estilo: 'Lazer, delivery e compras passaram de 30% da renda — é onde há mais espaço para cortar.',
        div:    'Dívidas e parcelas estão pesando — priorizar a quitação libera espaço no orçamento.'
    };

    // ── Nível ───────────────────────────────────────────────────
    function nivelDoXp(xp) {
        let i = 0;
        while (i + 1 < NIVEIS.length && xp >= NIVEIS[i + 1].xp) i++;
        const atual   = NIVEIS[i];
        const proximo = NIVEIS[i + 1] || null;
        const progresso = proximo ? (xp - atual.xp) / (proximo.xp - atual.xp) : 1;
        return { numero: i + 1, nome: atual.nome, xp, base: atual.xp, proximo, progresso };
    }

    // ── Cálculo principal (puro — sem DOM) ──────────────────────
    function calcular(transacoes = [], metas = [], agora = new Date()) {
        const hojeKey  = chaveDia(agora);
        const semanaAtualKey = chaveSemana(agora);
        const mesAtualKey    = chaveDia(agora).slice(0, 7);

        // Atividade por dia / semana (created_at, horário local)
        const porDia = {};          // dia → quantidade de lançamentos
        const diasPorSemana = {};   // semana → Set de dias
        const lancPorSemana = {};   // semana → quantidade
        const aportesPorSemana = {};// semana → quantidade com meta_id
        let aportesTotal = 0;

        transacoes.forEach(t => {
            const criado = parseCriadoEm(t.created_at) || (t.data_competencia ? dataLocal(t.data_competencia) : null);
            if (!criado) return;
            const dia = chaveDia(criado);
            const sem = chaveSemana(criado);
            porDia[dia] = (porDia[dia] || 0) + 1;
            (diasPorSemana[sem] || (diasPorSemana[sem] = new Set())).add(dia);
            lancPorSemana[sem] = (lancPorSemana[sem] || 0) + 1;
            if (t.meta_id) {
                aportesTotal++;
                aportesPorSemana[sem] = (aportesPorSemana[sem] || 0) + 1;
            }
        });

        // Estilo de vida por semana (data_competencia — quando o gasto aconteceu)
        const estiloPorSemana = {};
        transacoes.forEach(t => {
            if (t.tipo !== 'despesa' || !t.data_competencia) return;
            const g = grupoDe(t);
            if (g && g !== 'estilo_de_vida') return;
            const sem = chaveSemana(dataLocal(t.data_competencia));
            estiloPorSemana[sem] = (estiloPorSemana[sem] || 0) + valorAbs(t);
        });

        // ── Sequência ──
        const diasAtivos = new Set(Object.keys(porDia));
        const registrouHoje = diasAtivos.has(hojeKey);
        let sequencia = 0;
        let cursor = registrouHoje ? new Date(agora) : somarDias(agora, -1);
        while (diasAtivos.has(chaveDia(cursor))) { sequencia++; cursor = somarDias(cursor, -1); }

        let melhorSequencia = 0;
        const ordenados = [...diasAtivos].sort();
        let corrida = 0, anterior = null;
        ordenados.forEach(k => {
            const d = dataLocal(k);
            corrida = anterior && chaveDia(somarDias(anterior, 1)) === k ? corrida + 1 : 1;
            melhorSequencia = Math.max(melhorSequencia, corrida);
            anterior = d;
        });

        // ── Meses ──
        const meses = agregarMeses(transacoes);
        const chavesMeses = Object.keys(meses).sort();
        const mesesPassadosNoAzul = chavesMeses.filter(k => k < mesAtualKey && meses[k].rec > 0 && meses[k].rec - meses[k].desp >= 0);

        let melhorSeqAzul = 0, seqAzul = 0, mesAnteriorKey = null;
        chavesMeses.filter(k => k < mesAtualKey).forEach(k => {
            const noAzul = meses[k].rec > 0 && meses[k].rec - meses[k].desp >= 0;
            const consecutivo = mesAnteriorKey && proximoMes(mesAnteriorKey) === k;
            seqAzul = noAzul ? (consecutivo ? seqAzul + 1 : 1) : 0;
            melhorSeqAzul = Math.max(melhorSeqAzul, seqAzul);
            mesAnteriorKey = k;
        });

        const saudeAtual    = notaSaude(meses[mesAtualKey]);
        const mesPassadoKey = mesAnteriorDe(mesAtualKey);
        const saudePassada  = notaSaude(meses[mesPassadoKey]);
        const melhorNotaMes = chavesMeses.filter(k => k < mesAtualKey)
            .reduce((max, k) => Math.max(max, notaSaude(meses[k])?.nota ?? 0), 0);

        // ── Metas ──
        const metasConcluidas = metas.filter(m => parseFloat(m.valor_necessario) > 0 &&
            parseFloat(m.valor_economizado || 0) >= parseFloat(m.valor_necessario));

        // ── Missões: todas as semanas com atividade + a atual ──
        const semanas = new Set([...Object.keys(lancPorSemana), ...Object.keys(estiloPorSemana), semanaAtualKey]);
        let xpMissoes = 0;
        semanas.forEach(sem => {
            const ehAtual = sem === semanaAtualKey;
            if (sem > semanaAtualKey) return;
            if ((lancPorSemana[sem] || 0) >= 5)                 xpMissoes += XP.MISSAO_A;
            if ((diasPorSemana[sem]?.size || 0) >= 4)           xpMissoes += XP.MISSAO_B;
            if ((aportesPorSemana[sem] || 0) >= 1)              xpMissoes += XP.MISSAO_D;
            if (!ehAtual && missaoCCumprida(sem, estiloPorSemana, lancPorSemana)) xpMissoes += XP.MISSAO_C;
        });

        // ── XP ──
        const xpLancamentos = Object.values(porDia).reduce((s, n) => s + Math.min(n, XP.LANCAMENTOS_MAX_DIA) * XP.LANCAMENTO, 0);
        const xp = xpLancamentos
            + aportesTotal * XP.APORTE_META
            + metasConcluidas.length * XP.META_CONCLUIDA
            + mesesPassadosNoAzul.length * XP.MES_NO_AZUL
            + (metas.length ? XP.PRIMEIRA_META : 0)
            + xpMissoes;

        // ── Missões da semana atual (para exibir) ──
        const estiloSemanaPassada = estiloPorSemana[chaveDia(somarDias(dataLocal(semanaAtualKey), -7))] || 0;
        const limiteEstilo = estiloSemanaPassada > 0 ? estiloSemanaPassada : LIMITE_ESTILO_SEM_REFERENCIA;
        const estiloSemanaAtual = estiloPorSemana[semanaAtualKey] || 0;

        const missoes = [
            {
                id: 'A', icone: '📝', xp: XP.MISSAO_A,
                titulo: 'Registrar 5 lançamentos',
                atual: Math.min(lancPorSemana[semanaAtualKey] || 0, 5), meta: 5,
                cumprida: (lancPorSemana[semanaAtualKey] || 0) >= 5
            },
            {
                id: 'B', icone: '📅', xp: XP.MISSAO_B,
                titulo: 'Registrar em 4 dias diferentes',
                atual: Math.min(diasPorSemana[semanaAtualKey]?.size || 0, 4), meta: 4,
                cumprida: (diasPorSemana[semanaAtualKey]?.size || 0) >= 4
            },
            {
                id: 'C', icone: '🎯', xp: XP.MISSAO_C, noFimDaSemana: true,
                titulo: estiloSemanaPassada > 0
                    ? 'Gastar menos com estilo de vida que na semana passada'
                    : `Gastar até ${formatarMoeda(LIMITE_ESTILO_SEM_REFERENCIA)} com estilo de vida`,
                atualValor: estiloSemanaAtual, limiteValor: limiteEstilo,
                estourou: estiloSemanaPassada > 0 ? estiloSemanaAtual >= limiteEstilo : estiloSemanaAtual > limiteEstilo,
                cumprida: false
            },
            metas.length
                ? {
                    id: 'D', icone: '🐷', xp: XP.MISSAO_D,
                    titulo: 'Fazer um aporte em uma meta',
                    atual: Math.min(aportesPorSemana[semanaAtualKey] || 0, 1), meta: 1,
                    cumprida: (aportesPorSemana[semanaAtualKey] || 0) >= 1
                }
                : {
                    id: 'D', icone: '🐷', xp: XP.PRIMEIRA_META, acao: 'criar-meta',
                    titulo: 'Criar sua primeira meta',
                    atual: 0, meta: 1, cumprida: false
                }
        ];

        // ── Conquistas ──
        const totalLanc = transacoes.length;
        const temInvestimento = transacoes.some(t => grupoDe(t) === 'investimento');
        const temImportacao   = transacoes.some(t => t.origem === 'importacao');
        const conquistas = [
            { id: 'primeiro-passo', icone: '🚀', nome: 'Primeiro passo',   desc: 'Registrou o primeiro lançamento',       ok: totalLanc >= 1 },
            { id: 'mao-na-massa',   icone: '✍️', nome: 'Mão na massa',      desc: '50 lançamentos registrados',            ok: totalLanc >= 50,  prog: `${Math.min(totalLanc, 50)}/50` },
            { id: 'centena',        icone: '💯', nome: 'Centena',           desc: '100 lançamentos registrados',           ok: totalLanc >= 100, prog: `${Math.min(totalLanc, 100)}/100` },
            { id: 'semana-fogo',    icone: '🔥', nome: 'Semana em chamas',  desc: '7 dias seguidos registrando',           ok: melhorSequencia >= 7,  prog: `${Math.min(melhorSequencia, 7)}/7` },
            { id: 'mes-fogo',       icone: '☄️', nome: 'Mês em chamas',     desc: '30 dias seguidos registrando',          ok: melhorSequencia >= 30, prog: `${Math.min(melhorSequencia, 30)}/30` },
            { id: 'sonhador',       icone: '🌱', nome: 'Sonhador',          desc: 'Criou a primeira meta',                 ok: metas.length >= 1 },
            { id: 'meta-batida',    icone: '🏆', nome: 'Meta batida',       desc: 'Concluiu uma meta',                     ok: metasConcluidas.length >= 1 },
            { id: 'investidor',     icone: '📈', nome: 'Investidor',        desc: 'Fez o primeiro aporte em investimento', ok: temInvestimento },
            { id: 'mes-azul',       icone: '💙', nome: 'Mês no azul',       desc: 'Fechou um mês gastando menos do que ganhou', ok: mesesPassadosNoAzul.length >= 1 },
            { id: 'trimestre-azul', icone: '🌊', nome: 'Trimestre no azul', desc: '3 meses seguidos no azul',              ok: melhorSeqAzul >= 3, prog: `${Math.min(melhorSeqAzul, 3)}/3` },
            { id: 'nota-80',        icone: '⭐', nome: 'Saúde de ferro',    desc: 'Fechou um mês com saúde 80 ou mais',    ok: melhorNotaMes >= 80 },
            { id: 'importador',     icone: '📥', nome: 'Automatizado',      desc: 'Importou um extrato do banco',          ok: temImportacao }
        ];

        // ── Evolução: últimos 6 meses (inclui o atual) ──
        const evolucao = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(agora.getFullYear(), agora.getMonth() - i, 1);
            const k = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
            const m = meses[k] || { rec: 0, desp: 0 };
            evolucao.push({ chave: k, rotulo: MESES_CURTOS[d.getMonth()], ano: d.getFullYear(), rec: m.rec, desp: m.desp, saldo: m.rec - m.desp, atual: i === 0 });
        }

        // ── Cofrinhos ──
        const cofrinhos = metas.map(m => {
            const nec = parseFloat(m.valor_necessario) || 0;
            const eco = parseFloat(m.valor_economizado) || 0;
            return { id: m.id, nome: m.nome, necessario: nec, economizado: eco, pct: nec > 0 ? Math.min(eco / nec, 1) : 0 };
        }).sort((a, b) => (a.pct >= 1) - (b.pct >= 1) || b.pct - a.pct);

        // ── Saúde (atual) ──
        let saude = null;
        if (saudeAtual) {
            const faixa = faixaSaude(saudeAtual.nota);
            const pior  = [...saudeAtual.componentes].sort((a, b) => (a.valor * a.peso - a.peso) - (b.valor * b.peso - b.peso))[0];
            saude = {
                nota: saudeAtual.nota, ...faixa,
                delta: saudePassada ? saudeAtual.nota - saudePassada.nota : null,
                dica: pior && pior.peso * (1 - pior.valor) >= 1 ? DICA_COMPONENTE[pior.chave] : 'Tudo dentro das referências neste mês. Continue assim!'
            };
        }

        return {
            nivel: nivelDoXp(xp),
            sequencia, melhorSequencia, registrouHoje,
            saude, missoes, conquistas, evolucao, cofrinhos,
            totalLancamentos: totalLanc
        };
    }

    /**
     * Missão C de uma semana já encerrada. Só vale em semana com algum
     * lançamento (semana parada não rende XP de graça).
     * Com referência: gastou MENOS que na semana anterior.
     * Sem referência (semana anterior zerada): gastou até o limite fixo.
     */
    function missaoCCumprida(sem, estiloPorSemana, lancPorSemana) {
        if (!((lancPorSemana[sem] || 0) > 0)) return false;
        const anterior = estiloPorSemana[chaveDia(somarDias(dataLocal(sem), -7))] || 0;
        const atual    = estiloPorSemana[sem] || 0;
        return anterior > 0 ? atual < anterior : atual <= LIMITE_ESTILO_SEM_REFERENCIA;
    }

    function proximoMes(k) {
        const [a, m] = k.split('-').map(Number);
        const d = new Date(a, m, 1);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    }

    function mesAnteriorDe(k) {
        const [a, m] = k.split('-').map(Number);
        const d = new Date(a, m - 2, 1);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
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

    // ══════════════════════════════════════════════════════════════
    // RENDER
    // ══════════════════════════════════════════════════════════════

    function renderHero(e, nomeCliente) {
        const el = document.getElementById('gamiHero');
        if (!el) return;

        const n = e.nivel;
        const pct = Math.round(n.progresso * 100);
        const faltam = n.proximo ? n.proximo.xp - n.xp : 0;

        const sequenciaTexto = e.sequencia === 1 ? '1 dia' : `${e.sequencia} dias`;
        const sequenciaSub = e.registrouHoje
            ? '✓ Registro de hoje feito'
            : e.sequencia > 0 ? 'Registre algo hoje para não perder' : 'Registre algo hoje para começar';

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
                ? `<span class="gami-delta">= igual ao mês passado</span>`
                : `<span class="gami-delta ${s.delta > 0 ? 'gami-delta--sobe' : 'gami-delta--desce'}">${s.delta > 0 ? '▲' : '▼'} ${Math.abs(s.delta)} vs. mês passado</span>`;

        el.innerHTML = `
            <div class="gami-card gami-nivel">
                <div class="gami-nivel__topo">
                    <div class="gami-nivel__selo" aria-hidden="true">${n.numero}</div>
                    <div>
                        <p class="gami-rotulo">Nível ${n.numero}</p>
                        <p class="gami-titulo">${esc(n.nome)}</p>
                    </div>
                    <span class="gami-xp-total">${n.xp.toLocaleString('pt-BR')} XP</span>
                </div>
                <div class="gami-barra" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Progresso para o próximo nível">
                    <div class="gami-barra__preenchimento" style="width:${pct}%"></div>
                </div>
                <p class="gami-sub">${n.proximo
                    ? `Faltam <strong>${faltam.toLocaleString('pt-BR')} XP</strong> para o nível ${n.numero + 1} · ${esc(n.proximo.nome)}`
                    : 'Você chegou ao nível máximo. Lendário!'}</p>
            </div>

            <div class="gami-card gami-sequencia ${e.registrouHoje ? '' : 'gami-sequencia--pendente'}">
                <p class="gami-rotulo">Sequência</p>
                <p class="gami-sequencia__valor"><span class="gami-sequencia__fogo" aria-hidden="true">🔥</span>${sequenciaTexto}</p>
                <p class="gami-sub">${sequenciaSub}</p>
                <p class="gami-sub gami-sub--discreto">Recorde: ${e.melhorSequencia} ${e.melhorSequencia === 1 ? 'dia' : 'dias'}</p>
            </div>

            <div class="gami-card gami-saude">
                ${anel}
                <div class="gami-saude__texto">
                    <p class="gami-rotulo">Saúde do mês</p>
                    ${s
                        ? `<p class="gami-titulo gami-saude__label gami-saude__label--${s.classe}">${s.label}</p>${delta}
                           <p class="gami-sub">${esc(s.dica)}</p>`
                        : `<p class="gami-titulo">Sem nota ainda</p>
                           <p class="gami-sub">Lance suas receitas deste mês para ver sua nota de 0 a 100.</p>`}
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
                <span class="gami-contador">${feitas}/${e.missoes.length}</span>
            </div>
            <ul class="gami-missoes">
                ${e.missoes.map(m => {
                    let progresso, detalhe;
                    if (m.id === 'C') {
                        const pct = Math.min(m.atualValor / (m.limiteValor || 1), 1) * 100;
                        progresso = pct;
                        detalhe = m.estourou
                            ? `${formatarMoeda(m.atualValor)} — passou de ${formatarMoeda(m.limiteValor)}`
                            : `${formatarMoeda(m.atualValor)} de ${formatarMoeda(m.limiteValor)} · vale no domingo`;
                    } else {
                        progresso = (m.atual / m.meta) * 100;
                        detalhe = `${m.atual}/${m.meta}`;
                    }
                    const estado = m.cumprida ? 'feita' : (m.estourou ? 'falhou' : 'aberta');
                    const acao = m.acao === 'criar-meta'
                        ? `<button type="button" class="gami-missao__acao" onclick="navegarParaSecaoCliente('cli-goals')">Criar</button>` : '';
                    return `
                        <li class="gami-missao gami-missao--${estado}">
                            <span class="gami-missao__icone" aria-hidden="true">${m.cumprida ? '✅' : m.icone}</span>
                            <div class="gami-missao__corpo">
                                <p class="gami-missao__titulo">${esc(m.titulo)}</p>
                                <div class="gami-barra gami-barra--fina ${m.id === 'C' ? 'gami-barra--limite' : ''}">
                                    <div class="gami-barra__preenchimento" style="width:${Math.max(progresso, 3)}%"></div>
                                </div>
                                <p class="gami-missao__detalhe">${detalhe}</p>
                            </div>
                            <span class="gami-missao__xp">+${m.xp} XP</span>
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
                            <p class="gami-cofrinho__valor">${cheio ? 'Concluída!' : `${formatarCompacto(c.economizado)} de ${formatarCompacto(c.necessario)}`}</p>
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
                    <span><i style="background:${COR_RECEITA}"></i>Receitas</span>
                    <span><i style="background:${COR_DESPESA}"></i>Despesas</span>
                </div>
            </div>
            ${temDados
                ? `<div class="gami-grafico"></div>
                   <p class="gami-sub gami-sub--discreto">Abaixo de cada mês: saldo (receitas − despesas). Passe o mouse ou toque numa coluna para ver os valores.</p>`
                : `<div class="gami-vazio"><p>Assim que você lançar receitas e despesas, a evolução mês a mês aparece aqui.</p></div>`}
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
                <strong>${d.rotulo} ${d.ano}${d.atual ? ' · até hoje' : ''}</strong>
                <span><i style="background:${COR_RECEITA}"></i>Receitas <b>${formatarMoeda(d.rec)}</b></span>
                <span><i style="background:${COR_DESPESA}"></i>Despesas <b>${formatarMoeda(d.desp)}</b></span>
                <span>Saldo <b class="${d.saldo >= 0 ? 'pos' : 'neg'}">${formatarMoeda(d.saldo)}</b></span>`;
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
    function chaveStorage(clientId) { return `mentorfin_gami_${clientId}`; }

    function lerAnterior(clientId) {
        try { return JSON.parse(localStorage.getItem(chaveStorage(clientId)) || 'null'); } catch (_) { return null; }
    }

    function salvarAtual(clientId, e) {
        try {
            localStorage.setItem(chaveStorage(clientId), JSON.stringify({
                xp: e.nivel.xp, nivel: e.nivel.numero,
                conquistas: e.conquistas.filter(c => c.ok).map(c => c.id),
                cofrinhosCheios: e.cofrinhos.filter(c => c.pct >= 1).map(c => c.id)
            }));
        } catch (_) { /* navegador sem storage: só não comemora */ }
    }

    function comemorar(clientId, e) {
        const antes = lerAnterior(clientId);
        salvarAtual(clientId, e);
        if (!antes) return; // primeira visita: sem festa por coisas antigas

        const ganhouXp = e.nivel.xp - (antes.xp || 0);
        const novasConquistas = e.conquistas.filter(c => c.ok && !(antes.conquistas || []).includes(c.id));
        const novosCheios = e.cofrinhos.filter(c => c.pct >= 1 && !(antes.cofrinhosCheios || []).includes(c.id));
        const subiuNivel = e.nivel.numero > (antes.nivel || 1);

        if (ganhouXp > 0) mostrarXpFlutuante(ganhouXp);
        if (subiuNivel || novasConquistas.length || novosCheios.length) confete();

        const avisos = [];
        if (subiuNivel) avisos.push(`🎉 Você subiu para o nível ${e.nivel.numero} · ${e.nivel.nome}!`);
        novosCheios.forEach(c => avisos.push(`🐷 Meta "${c.nome}" concluída!`));
        novasConquistas.forEach(c => avisos.push(`${c.icone} Conquista desbloqueada: ${c.nome}`));
        avisos.forEach((texto, i) => setTimeout(() => mostrarBanner(texto), 400 + i * 2200));
    }

    function mostrarXpFlutuante(qtd) {
        const alvo = document.querySelector('.gami-xp-total');
        const el = document.createElement('div');
        el.className = 'gami-xp-flutuante';
        el.textContent = `+${qtd} XP`;
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

    // ── API pública ─────────────────────────────────────────────
    function render(transacoes, metas, clientId) {
        const estado = calcular(transacoes || [], metas || []);
        renderHero(estado);
        renderMissoes(estado);
        renderCofrinhos(estado);
        renderEvolucao(estado);
        renderConquistas(estado);
        if (clientId) comemorar(clientId, estado);
        return estado;
    }

    return { calcular, render, _interno: { notaSaude, nivelDoXp, parseCriadoEm, chaveSemana, NIVEIS, XP } };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = GamificacaoModule;

console.log('✅ gamificacao.js carregado');
