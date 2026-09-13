/**
 * DASHBOARD.JS - LÓGICA DO DASHBOARD
 * ================================================
 * ATUALIZAÇÃO — CAIXINHAS/METAS (ALOCAÇÃO DE SALDO):
 * A matemática do saldo NÃO mudou — ela já estava correta. Despesas de
 * categoria 'investimento' (Aporte em Investimentos, Previdência
 * Privada, Reserva de Emergência) já eram do tipo 'despesa' e já
 * entravam em totalDespesas, então o dinheiro alocado a elas já era
 * subtraído do saldo. O que estava faltando era o VÍNCULO entre essa
 * despesa e uma Meta específica (ver transacoes.meta_id e os triggers
 * `trg_validar_meta_id`/`trg_sync_valor_economizado_meta` no banco,
 * mais o seletor "Vincular a uma Meta" em app.js) — isso é o que agora
 * mantém `metas.valor_economizado` sincronizado automaticamente.
 *
 * ATUALIZAÇÃO — GRUPOS 'divida' E 'transferencia':
 *   - 'divida' (Dívidas e Financiamentos): despesa real, dinheiro que
 *     sai de verdade do controle da pessoa — continua contando em
 *     totalDespesas/saldo normalmente. A diferença é só de EXIBIÇÃO:
 *     ganha um bucket próprio (custoDivida), isolado de
 *     custoDeSobrevivencia/custoDeVida, para não distorcer essas duas
 *     métricas com pagamento de empréstimo/financiamento.
 *   - 'transferencia' (Transferências Internas): dinheiro que só MUDOU
 *     DE LUGAR entre contas da mesma pessoa — não é receita nem
 *     despesa de verdade. Fica de FORA do totalReceitas/totalDespesas/
 *     saldoDisponivel por completo (soma à parte, em
 *     totalTransferencias, só para efeito informativo).
 *
 * ATUALIZAÇÃO — DASHBOARD FILTRÁVEL POR PERÍODO:
 * Antes, o "Resumo do Mês"/"Análise Financeira" sempre somava TODAS as
 * transações do cliente desde o início (apesar do título dizer "do
 * Mês"). Agora load()/renderClientDashboard() aceitam um `filtro`
 * opcional ({ dataInicio, dataFim }, mesmo formato usado pelo filtro
 * do Histórico em app.js) — os totais/BI passam a refletir só o
 * período escolhido no novo seletor acima do Resumo (ver
 * initDashboardFilters()/getFiltroDashboardAtual() em app.js). Sem
 * filtro (dataInicio/dataFim ausentes), o comportamento é idêntico ao
 * anterior — todas as transações.
 *
 * ATUALIZAÇÃO — MOEDA NO PADRÃO BRASILEIRO:
 * Todo valor monetário exibido agora passa por
 * `UIModule.formatCurrency()` (separador de milhar "." e decimal ",",
 * ex: "R$ 150.132.456,00") em vez de `R$ ${valor.toFixed(2)}`
 * ("R$ 150132456.00").
 */

const DashboardModule = (() => {
    let cachedData = null;

    // Ícone por categoria — comparação simples por palavra-chave no
    // nome da categoria. Puramente decorativo (não afeta nenhum
    // cálculo); usado só pelos cartões de "Maiores Gastos" abaixo.
    const ICONES_CATEGORIA = [
        [/mercado|supermercado|feira|a[çc]ougue|hortifruti|sacol[aã]o/i, '🛒'],
        [/aluguel|condom[ií]nio|iptu|financiamento imobili[aá]rio|moradia/i, '🏠'],
        [/luz|energia/i, '💡'],
        [/[aá]gua|esgoto/i, '🚿'],
        [/g[aá]s\b|botij[aã]o/i, '🔥'],
        [/internet|wifi|banda larga|telefonia/i, '📶'],
        [/combust[ií]vel|gasolina|posto|uber|99\b|[oô]nibus|metr[oô]|transporte/i, '🚗'],
        [/oficina|mec[aâ]nico|pneu|revis[aã]o do carro|ipva|seguro (do carro|auto)/i, '🔧'],
        [/farm[aá]cia|rem[eé]dio|medicamento|plano de sa[uú]de|m[eé]dico|dentista|consulta|exame|sa[uú]de/i, '💊'],
        [/restaurante|delivery|ifood|rappi|lanche|bar\b|cafe|padaria/i, '🍔'],
        [/streaming|netflix|spotify|assinatura/i, '🎬'],
        [/viagem|hotel|passagem|airbnb/i, '✈️'],
        [/academia|personal|crossfit|pilates/i, '💪'],
        [/cinema|show|teatro|balada|festa/i, '🎉'],
        [/roupa|sapato|t[eê]nis|cal[çc]ado|moda|bolsa/i, '👕'],
        [/celular|smartphone|eletr[oô]nico|notebook|gadget|computador/i, '📱'],
        [/sal[aã]o|beleza|manicure|pedicure|est[eé]tica|cabelo/i, '💅'],
        [/escola|faculdade|curso|mensalidade|educa[çc][aã]o|livro/i, '📚'],
        [/pet\b|veterin[aá]rio|ra[çc][aã]o/i, '🐾'],
        [/investimento|aporte|reserva|previd[eê]ncia|poupan[çc]a/i, '💰'],
        [/d[íi]vida|financiamento|empr[eé]stimo|fatura|cart[aã]o de cr[eé]dito/i, '💳'],
        [/doa[çc][aã]o|d[íi]zimo|oferta|caridade|presente/i, '🎁'],
    ];

    function iconeParaCategoria(nome) {
        const alvo = (nome || '').toLowerCase();
        for (const [regex, icone] of ICONES_CATEGORIA) {
            if (regex.test(alvo)) return icone;
        }
        return '🧩';
    }

    const calculateMetrics = (transactions) => {
        const metrics = {
            custoDeSobrevivencia: 0,
            custoDeVida:          0,
            custoDivida:          0, // categorias.grupo === 'divida' — empréstimos/financiamentos, isolado
            aportesInvestimento:  0, // categorias.grupo === 'investimento' — dinheiro já protegido/alocado
            totalTransferencias:  0, // categorias.grupo === 'transferencia' — NÃO entra em receita/despesa/saldo
            rendaPassiva:         0, // categorias não distingue ativa/passiva hoje — fica sempre 0 (ver nota abaixo)
            rendaAtiva:           0,
            totalReceitas:        0,
            totalDespesas:        0, // essencial + estilo_de_vida + investimento + divida (transferencia NUNCA entra aqui)
            saldo:                0, // ALIAS de saldoDisponivel — mantido para não quebrar quem já lê `.saldo`
            saldoDisponivel:      0, // = totalReceitas - totalDespesas (já exclui o alocado, pois investimento é uma despesa)
            totalAlocado:         0, // ALIAS de aportesInvestimento — nome explícito p/ exibição no dashboard
            cobertura:            0
        };

        // NOTA: a tabela `categorias` (correta, com RLS liberado pro
        // cliente) usa um único campo `grupo` para receitas: todas as
        // categorias de receita hoje vêm marcadas como 'renda', sem
        // separar renda ativa de passiva (diferente da extinta
        // `plano_de_contas`, que tinha `tipo_renda`). Por isso toda
        // receita entra como rendaAtiva; rendaPassiva fica em 0 até
        // que exista uma forma de marcar isso em `categorias`.
        transactions.forEach(t => {
            const valor = parseFloat(t.valor || 0);
            const grupo = t.categorias?.grupo;

            // Transferência interna: dinheiro só mudou de lugar — não é
            // receita nem despesa de verdade. Registrada à parte, fora
            // do cálculo de saldo, para não inflar nem distorcer nada
            // (independe do tipo ser 'receita' ou 'despesa').
            if (grupo === 'transferencia') {
                metrics.totalTransferencias += valor;
                return;
            }

            if (t.tipo === 'receita') {
                metrics.totalReceitas += valor;
                metrics.rendaAtiva    += valor;
            } else {
                metrics.totalDespesas += valor;
                if (grupo === 'essencial') {
                    metrics.custoDeSobrevivencia += valor;
                } else if (grupo === 'investimento') {
                    metrics.aportesInvestimento += valor;
                } else if (grupo === 'divida') {
                    metrics.custoDivida += valor;
                } else {
                    metrics.custoDeVida += valor;
                }
            }
        });

        // saldoDisponivel = tudo que entrou menos tudo que saiu (fora
        // transferências, que não passam por aqui — ver return acima).
        // Como 'investimento' e 'divida' já são despesas somadas em
        // totalDespesas, o dinheiro alocado em metas/caixinhas e o
        // pagamento de dívidas JÁ estão excluídos aqui — não subtraímos
        // de novo (isso duplicaria o desconto).
        metrics.saldoDisponivel = metrics.totalReceitas - metrics.totalDespesas;
        metrics.saldo           = metrics.saldoDisponivel; // alias retrocompatível
        metrics.totalAlocado    = metrics.aportesInvestimento; // alias com nome explícito

        if (metrics.custoDeSobrevivencia > 0) {
            metrics.cobertura = (metrics.rendaPassiva / metrics.custoDeSobrevivencia) * 100;
        }

        return metrics;
    };

    const getCategoryBreakdown = (transactions) => {
        const breakdown = {};

        transactions
            .filter(t => t.tipo === 'despesa' && t.categorias?.grupo !== 'transferencia')
            .forEach(t => {
                const category = t.categorias?.nome || 'Sem Categoria';
                breakdown[category] = (breakdown[category] || 0) + parseFloat(t.valor || 0);
            });

        return Object.entries(breakdown)
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 10);
    };

    /**
     * Filtra transações por `data_competencia` dentro do intervalo
     * [dataInicio, dataFim] (ambos opcionais, formato 'YYYY-MM-DD').
     * Sem filtro (objeto vazio/undefined), retorna a lista inteira —
     * é isso que preserva o comportamento antigo (dashboard sem
     * período nenhum aplicado) quando ninguém mexeu no seletor novo.
     */
    const filterByPeriod = (transactions, filtro = {}) => {
        if (!filtro || (!filtro.dataInicio && !filtro.dataFim)) return transactions;
        return transactions.filter(t => {
            if (!t.data_competencia) return false;
            if (filtro.dataInicio && t.data_competencia < filtro.dataInicio) return false;
            if (filtro.dataFim && t.data_competencia > filtro.dataFim) return false;
            return true;
        });
    };

    /**
     * "🏆 Maiores Gastos do Período" — cartões com ícone por categoria.
     * Reaproveita getCategoryBreakdown(), que já vem ordenado. Só
     * renderiza se o HTML tiver o container (#dashTopGastosGrid) —
     * senão não faz nada, sem lançar erro (permite que este módulo
     * continue funcionando em qualquer página que não tenha esse bloco).
     */
    function renderMaioresGastos(categories, totalReceitas) {
        const container = document.getElementById('dashTopGastosGrid');
        if (!container) return;

        const top5 = categories.slice(0, 5);

        if (!top5.length) {
            container.innerHTML = '<p class="empty-state">Nenhuma despesa registrada neste período ainda.</p>';
            return;
        }

        container.innerHTML = top5.map(cat => {
            const percentual = totalReceitas > 0 ? (cat.value / totalReceitas) * 100 : null;
            return `
                <div class="gasto-icon-card">
                    <span class="gasto-icon-card__icone">${iconeParaCategoria(cat.name)}</span>
                    <div class="gasto-icon-card__corpo">
                        <span class="gasto-icon-card__nome">${cat.name}</span>
                        <span class="gasto-icon-card__valor">${UIModule.formatCurrency(cat.value)}</span>
                        ${percentual !== null ? `<span class="gasto-icon-card__percentual">${percentual.toFixed(1)}% da renda</span>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    }

    /**
     * "💡 Observações sobre o seu período" — linguagem simples, sem
     * jargão técnico, usando os rótulos que já aparecem na tela
     * (Custo de Sobrevivência, Estilo de Vida, Investimentos, Dívidas).
     * Só renderiza se o HTML tiver os containers correspondentes.
     */
    function gerarObservacoesCliente(m) {
        const itens = [];
        const totalTransacoes = (m.totalReceitas > 0 || m.totalDespesas > 0) ? 1 : 0; // presença de dados

        if (!totalTransacoes) {
            return { resumo: 'Ainda não há lançamentos neste período.', itens: [
                { tipo: 'info', texto: 'Registe suas receitas e despesas para ver a sua análise financeira aqui.' }
            ] };
        }

        if (m.saldoDisponivel < 0) {
            itens.push({ tipo: 'alerta', texto: `Você gastou mais do que recebeu neste período (saldo de ${UIModule.formatCurrency(m.saldoDisponivel)}). Vale revisar os maiores gastos abaixo antes de qualquer outra decisão.` });
        } else {
            const taxaPoupanca = m.totalReceitas > 0 ? (m.saldoDisponivel / m.totalReceitas) * 100 : 0;
            if (taxaPoupanca < 10) {
                itens.push({ tipo: 'atencao', texto: `Sua taxa de poupança está em ${taxaPoupanca.toFixed(1)}%. Tentar guardar entre 10% e 20% da renda é uma boa meta para começar.` });
            } else if (taxaPoupanca >= 20) {
                itens.push({ tipo: 'positivo', texto: `Ótimo! Você guardou ${taxaPoupanca.toFixed(1)}% da sua renda neste período. Continue assim.` });
            }
        }

        const percSobrevivencia = m.totalReceitas > 0 ? (m.custoDeSobrevivencia / m.totalReceitas) * 100 : 0;
        if (percSobrevivencia > 50) {
            itens.push({ tipo: 'atencao', texto: `O Custo de Sobrevivência está consumindo ${percSobrevivencia.toFixed(1)}% da sua renda — acima do recomendado (até 50%). Vale revisar contas fixas como moradia e alimentação.` });
        }

        const percEstilo = m.totalReceitas > 0 ? (m.custoDeVida / m.totalReceitas) * 100 : 0;
        if (percEstilo > 30) {
            itens.push({ tipo: 'atencao', texto: `O Estilo de Vida representa ${percEstilo.toFixed(1)}% da sua renda. Se quer sobrar mais dinheiro no fim do mês, este é o grupo com mais espaço para cortar.` });
        }

        if (m.aportesInvestimento <= 0) {
            itens.push({ tipo: 'alerta', texto: 'Você ainda não guardou nada em Investimentos neste período. Mesmo um valor pequeno todo mês já faz diferença no longo prazo.' });
        }

        if (m.custoDivida > 0) {
            const percDivida = m.totalReceitas > 0 ? (m.custoDivida / m.totalReceitas) * 100 : 0;
            itens.push({
                tipo: percDivida > 20 ? 'alerta' : 'atencao',
                texto: `${percDivida.toFixed(1)}% da sua renda está comprometida com dívidas e financiamentos.` +
                       (percDivida > 20 ? ' Priorizar a quitação pode liberar bastante espaço no seu orçamento.' : '')
            });
        }

        const resumo = m.saldoDisponivel >= 0
            ? `Neste período você recebeu ${UIModule.formatCurrency(m.totalReceitas)} e gastou ${UIModule.formatCurrency(m.totalDespesas)}, ficando com um saldo positivo de ${UIModule.formatCurrency(m.saldoDisponivel)}.`
            : `Neste período você recebeu ${UIModule.formatCurrency(m.totalReceitas)} e gastou ${UIModule.formatCurrency(m.totalDespesas)}, resultando em um saldo negativo de ${UIModule.formatCurrency(Math.abs(m.saldoDisponivel))}.`;

        return { resumo, itens };
    }

    function renderObservacoes(m) {
        const container = document.getElementById('dashInsightsLista');
        const resumoEl   = document.getElementById('dashInsightsResumo');
        if (!container) return;

        const { resumo, itens } = gerarObservacoesCliente(m);
        if (resumoEl) resumoEl.textContent = resumo;

        const ICONE = { alerta: '🔴', atencao: '🟡', positivo: '🟢', info: 'ℹ️' };

        container.innerHTML = itens.length
            ? itens.map(item => `
                <div class="insight-item insight-item--${item.tipo}">
                    <span class="insight-item__icone">${ICONE[item.tipo] || 'ℹ️'}</span>
                    <span class="insight-item__texto">${item.texto}</span>
                </div>
            `).join('')
            : '<p class="empty-state">Sem observações específicas para este período.</p>';
    }

    /**
     * CTA "🎯 Definir Meta de Gastos" — só aparece se o cliente ainda
     * não tem nenhuma meta cadastrada. Só age se o HTML tiver o bloco
     * (#dashMetaCta).
     */
    async function renderCtaMeta(clientId) {
        const bloco = document.getElementById('dashMetaCta');
        if (!bloco) return;

        try {
            const metas = await DatabaseModule.getMetasByClient(clientId);
            bloco.classList.toggle('hidden', !!(metas && metas.length));
        } catch (_) {
            bloco.classList.add('hidden');
        }
    }

    return {
        async load(clientId, filtro = {}) {
            try {
                const todasTransacoes = await DatabaseModule.getTransactionsByClient(clientId);
                const transactions    = filterByPeriod(todasTransacoes, filtro);

                cachedData = {
                    metrics: calculateMetrics(transactions),
                    categories: getCategoryBreakdown(transactions),
                    transactions,
                    todasTransacoes // mantém a lista completa disponível (ex: outros módulos que não usam filtro)
                };
                return cachedData;
            } catch (error) {
                console.error('❌ Erro ao carregar dashboard:', error);
                throw error;
            }
        },

        async renderClientDashboard(clientId, filtro = {}) {
            try {
                const data = await this.load(clientId, filtro);
                const m = data.metrics;

                UIModule.setText('totalReceitas', UIModule.formatCurrency(m.totalReceitas));
                UIModule.setText('totalDespesas', UIModule.formatCurrency(m.totalDespesas));
                UIModule.setText('saldo', UIModule.formatCurrency(m.saldoDisponivel));

                // Subtexto opcional sob o Saldo, mostrando quanto já
                // está protegido em metas/investimentos — só aparece se
                // o elemento existir no HTML (ver client.html/index.html,
                // classe .bi-detail reaproveitada dentro do resume-item
                // do saldo). Não quebra nada se o elemento não existir.
                UIModule.setText('saldoAlocadoDetalhe',
                    m.totalAlocado > 0 ? `já descontado ${UIModule.formatCurrency(m.totalAlocado)} em Metas/Investimentos` : '');

                UIModule.setText('biSurvivalCost', UIModule.formatCurrency(m.custoDeSobrevivencia));
                UIModule.setText('biLifestyleCost', UIModule.formatCurrency(m.custoDeVida));
                UIModule.setText('biInvestments', UIModule.formatCurrency(m.aportesInvestimento));
                UIModule.setText('biDebt', UIModule.formatCurrency(m.custoDivida));
                UIModule.setText('biPassiveIncome', UIModule.formatCurrency(m.rendaPassiva));
                UIModule.setText('biCoverage', `${m.cobertura.toFixed(1)}%`);

                // ── Blocos novos, cada um isolado do resto: uma falha aqui
                // nunca deve derrubar os KPIs que já renderizaram acima. ──
                try { renderMaioresGastos(data.categories, m.totalReceitas); }
                catch (e) { console.error('❌ renderMaioresGastos:', e); }

                try { renderObservacoes(m); }
                catch (e) { console.error('❌ renderObservacoes:', e); }

                try { await renderCtaMeta(clientId); }
                catch (e) { console.error('❌ renderCtaMeta:', e); }

                return data;
            } catch (error) {
                UIModule.showError('Erro ao carregar dashboard');
                throw error;
            }
        },

        getData: () => cachedData
    };
})();

console.log('✅ dashboard.js carregado');
