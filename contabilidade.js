/**
 * CONTABILIDADE.JS — Módulo: DRE, Balancete e Ferramentas Contábeis
 * ================================================
 * Padrão: script global. Sem import/export.
 * Depende de: supabaseClient, showToast, formatCurrency, openModal
 *             (admin.js) — devem ser carregados ANTES deste ficheiro.
 * Consumido por: dashboards.js (aba DRE/Balancete dentro do modal "Ver
 * Dashboard" de cada cliente) e categorias.js (código contábil exibido
 * em cada categoria da grade "Plano de Contas").
 *
 * O QUE ESTE ARQUIVO FAZ:
 *   1. obterCodigoGrupo(tipo, grupo) — dá um "código contábil" pra
 *      cada grupo de categoria (1.1 Renda, 2.1 Essencial, etc.),
 *      reaproveitado tanto no Balancete quanto na grade de Categorias
 *      reorganizada como plano de contas.
 *   2. calcularDRE(transacoes) / renderDRE(container, dre, meta) —
 *      Demonstração do Resultado: Receitas - Despesas (por natureza) =
 *      Resultado do Período. Transferências internas ficam de fora
 *      (não são receita/despesa de verdade — mesma regra já usada em
 *      dashboard.js/dashboards.js).
 *   3. calcularBalancete(transacoes) / renderBalancete(container, ...) —
 *      Balancete de Verificação: cada conta (categoria) com
 *      Débito/Crédito/Saldo. Ao contrário da DRE, aqui as
 *      transferências ENTRAM (um balancete mostra todo o movimento das
 *      contas, não só o resultado do período).
 *   4. exportarParaPDF(elementId, titulo) — usa o diálogo de impressão
 *      nativo do navegador (window.print, destino "Salvar como PDF")
 *      pra exportar DRE/Balancete. Não usa nenhuma biblioteca externa
 *      — mantém a arquitetura 100% Vanilla JS do projeto.
 *   5. Balancete Ampliado: abrirBalanceteAmpliado() abre um modal em
 *      tela cheia com zoom (50%-300%) e uma camada de anotação livre
 *      (canvas por cima da tabela real em HTML — a tabela continua
 *      nítida em qualquer zoom, só o desenho é rasterizado). Ferramentas:
 *      caneta, texto, borracha, desfazer, limpar. Exporta com as
 *      anotações já "coladas" via impressão do próprio modal.
 */

// ══════════════════════════════════════════════════════════════
// CÓDIGO CONTÁBIL POR GRUPO (reaproveitado no Balancete e no Plano de Contas)
// ══════════════════════════════════════════════════════════════
/**
 * Convenção adotada (numeração estilo plano de contas):
 *   1.x — RECEITAS  (1.1 Renda, 1.2 Transferências Internas)
 *   2.x — DESPESAS  (2.1 Essencial, 2.2 Estilo de Vida,
 *                     2.3 Investimentos, 2.4 Dívidas, 2.5 Transferências)
 * Categorias com grupo fora desse mapa (dado legado/inconsistente)
 * caem no código "9" — "Outras / Sem Grupo Definido", pra nunca sumir
 * uma categoria da visualização por causa de um valor inesperado.
 */
function obterCodigoGrupo(tipo, grupo) {
    if (grupo === 'transferencia') {
        return tipo === 'receita'
            ? { codigo: '1.2', label: 'Transferências Internas' }
            : { codigo: '2.5', label: 'Transferências Internas' };
    }

    if (tipo === 'receita') {
        return { codigo: '1.1', label: 'Renda' };
    }

    const mapaDespesa = {
        essencial:      { codigo: '2.1', label: 'Essencial (Sobrevivência)' },
        estilo_de_vida: { codigo: '2.2', label: 'Estilo de Vida' },
        investimento:   { codigo: '2.3', label: 'Investimentos e Reservas' },
        divida:         { codigo: '2.4', label: 'Dívidas e Financiamentos' }
    };

    return mapaDespesa[grupo] || { codigo: '9', label: 'Outras / Sem Grupo Definido' };
}

// Fallback local caso formatCurrency (admin.js) não esteja disponível
// por algum motivo — nunca deve acontecer na ordem normal de scripts,
// mas evita que este módulo quebre sozinho se isso mudar no futuro.
function _fmtMoeda(valor) {
    if (typeof formatCurrency === 'function') return formatCurrency(valor);
    const n = parseFloat(valor) || 0;
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// ══════════════════════════════════════════════════════════════
// DRE — DEMONSTRAÇÃO DO RESULTADO DO EXERCÍCIO (PERÍODO)
// ══════════════════════════════════════════════════════════════
/**
 * Recebe a lista de transações do cliente (mesmo formato usado em
 * dashboards.js: { valor, tipo, categorias: { nome, grupo } }) e monta
 * a estrutura da DRE: Receitas detalhadas -> Despesas agrupadas por
 * natureza (com subtotal cada) -> Resultado do Período -> Margem de
 * poupança. Transferências internas (grupo 'transferencia') são
 * excluídas — dinheiro que só mudou de lugar não é receita nem
 * despesa de verdade (mesma regra de negócio já usada em todo o
 * resto do app).
 */
function calcularDRE(transacoes) {
    const semTransferencia = (transacoes || []).filter(t => t.categorias?.grupo !== 'transferencia');
    const receitas = semTransferencia.filter(t => t.tipo === 'receita');
    const despesas = semTransferencia.filter(t => t.tipo === 'despesa');

    const totalReceitas = receitas.reduce((s, t) => s + Math.abs(parseFloat(t.valor) || 0), 0);

    const receitaPorCategoria = {};
    receitas.forEach(t => {
        const nome = t.categorias?.nome || 'Sem categoria';
        receitaPorCategoria[nome] = (receitaPorCategoria[nome] || 0) + Math.abs(parseFloat(t.valor) || 0);
    });
    const linhasReceita = Object.entries(receitaPorCategoria)
        .sort((a, b) => b[1] - a[1])
        .map(([nome, valor]) => ({ nome, valor }));

    const gruposDespesa = ['essencial', 'estilo_de_vida', 'investimento', 'divida'];
    const labelsGrupo = {
        essencial:      'Custo Essencial (Sobrevivência)',
        estilo_de_vida: 'Estilo de Vida',
        investimento:   'Investimentos e Reservas',
        divida:         'Dívidas e Financiamentos'
    };

    const blocosDespesa = gruposDespesa.map(grupo => {
        const transacoesDoGrupo = despesas.filter(t => (t.categorias?.grupo || 'estilo_de_vida') === grupo);
        const subtotal = transacoesDoGrupo.reduce((s, t) => s + Math.abs(parseFloat(t.valor) || 0), 0);

        const porCategoria = {};
        transacoesDoGrupo.forEach(t => {
            const nome = t.categorias?.nome || 'Sem categoria';
            porCategoria[nome] = (porCategoria[nome] || 0) + Math.abs(parseFloat(t.valor) || 0);
        });

        const linhas = Object.entries(porCategoria)
            .sort((a, b) => b[1] - a[1])
            .map(([nome, valor]) => ({ nome, valor }));

        return { grupo, label: labelsGrupo[grupo], subtotal, linhas };
    });

    const totalDespesas = blocosDespesa.reduce((s, b) => s + b.subtotal, 0);
    const resultado      = totalReceitas - totalDespesas;
    const margem         = totalReceitas > 0 ? (resultado / totalReceitas) * 100 : 0;

    return {
        totalReceitas,
        linhasReceita,
        blocosDespesa,
        totalDespesas,
        resultado,
        margem,
        totalTransacoesTransferencia: (transacoes || []).length - semTransferencia.length
    };
}

function renderDRE(container, dre, meta) {
    if (!container) return;

    const linhasReceitaHtml = dre.linhasReceita.map(l => `
        <tr class="dre-linha">
            <td class="dre-linha__nome">${escaparHtml(l.nome)}</td>
            <td>${_fmtMoeda(l.valor)}</td>
        </tr>
    `).join('') || '<tr class="dre-linha"><td colspan="2" class="dre-vazio">Nenhuma receita no período</td></tr>';

    const blocosDespesaHtml = dre.blocosDespesa.map(bloco => `
        <tr class="dre-subtitulo"><td colspan="2">(-) ${bloco.label}</td></tr>
        ${bloco.linhas.map(l => `
            <tr class="dre-linha dre-linha--despesa">
                <td class="dre-linha__nome">${escaparHtml(l.nome)}</td>
                <td>${_fmtMoeda(l.valor)}</td>
            </tr>
        `).join('') || '<tr class="dre-linha"><td colspan="2" class="dre-vazio">Sem lançamentos</td></tr>'}
        <tr class="dre-subtotal">
            <td>Subtotal ${bloco.label}</td>
            <td>${_fmtMoeda(bloco.subtotal)}</td>
        </tr>
    `).join('');

    const corResultado = dre.resultado >= 0 ? 'positivo' : 'negativo';

    container.innerHTML = `
        <div class="dre-header">
            <h4>Demonstração do Resultado — ${escaparHtml(meta.clienteNome)}</h4>
            <p class="dre-periodo">${meta.periodoLabel}</p>
        </div>
        <table class="dre-table">
            <tbody>
                <tr class="dre-secao"><td colspan="2">(+) RECEITAS</td></tr>
                ${linhasReceitaHtml}
                <tr class="dre-subtotal dre-subtotal--receita">
                    <td>TOTAL RECEITAS</td>
                    <td>${_fmtMoeda(dre.totalReceitas)}</td>
                </tr>
                <tr class="dre-secao"><td colspan="2">(-) DESPESAS</td></tr>
                ${blocosDespesaHtml}
                <tr class="dre-subtotal dre-subtotal--despesa">
                    <td>TOTAL DESPESAS</td>
                    <td>${_fmtMoeda(dre.totalDespesas)}</td>
                </tr>
                <tr class="dre-resultado ${corResultado}">
                    <td>= RESULTADO DO PERÍODO</td>
                    <td>${_fmtMoeda(dre.resultado)}</td>
                </tr>
                <tr class="dre-margem">
                    <td>Margem de poupança</td>
                    <td>${dre.margem.toFixed(1)}%</td>
                </tr>
            </tbody>
        </table>
        ${dre.totalTransacoesTransferencia > 0
            ? `<p class="dre-nota">ℹ️ ${dre.totalTransacoesTransferencia} transação(ões) de Transferência Interna não entram neste cálculo — não são receita nem despesa de verdade (dinheiro só mudou de lugar). Elas aparecem no Balancete.</p>`
            : ''}
    `;
}

// ══════════════════════════════════════════════════════════════
// BALANCETE DE VERIFICAÇÃO
// ══════════════════════════════════════════════════════════════
/**
 * Ao contrário da DRE, o Balancete mostra TODO o movimento das contas
 * no período — inclusive Transferências Internas, porque um balancete
 * de verdade precisa fechar (bater) com tudo que se moveu, não só com
 * o que afeta o resultado.
 *
 * Agrupa por (tipo + grupo + nome da categoria) em vez de por ID —
 * a consulta que abastece este módulo (ver dashboards.js:
 * abrirDashboard) traz `categorias(nome, grupo)` via join aninhado,
 * sem o id da categoria selecionado; nome+grupo+tipo já é uma chave
 * suficientemente única pra este relatório agregado.
 */
function calcularBalancete(transacoes) {
    const porConta = {};

    (transacoes || []).forEach(t => {
        const nome  = t.categorias?.nome || 'Sem categoria';
        const grupo = t.categorias?.grupo || null;
        const tipo  = t.tipo;
        const chave = `${tipo}__${grupo}__${nome}`;

        if (!porConta[chave]) {
            porConta[chave] = { nome, tipo, grupo, debito: 0, credito: 0 };
        }

        const valor = Math.abs(parseFloat(t.valor) || 0);
        if (tipo === 'despesa') porConta[chave].debito += valor;
        else porConta[chave].credito += valor;
    });

    const linhas = Object.values(porConta).map(l => {
        const infoGrupo = obterCodigoGrupo(l.tipo, l.grupo || 'estilo_de_vida');
        return {
            ...l,
            codigoGrupo: infoGrupo.codigo,
            labelGrupo:  infoGrupo.label,
            saldo:       l.credito - l.debito
        };
    });

    linhas.sort((a, b) => a.codigoGrupo.localeCompare(b.codigoGrupo) || a.nome.localeCompare(b.nome, 'pt-BR'));

    // Código sequencial da conta dentro do mesmo grupo (ex: 2.1.01, 2.1.02...)
    const contadores = {};
    linhas.forEach(l => {
        contadores[l.codigoGrupo] = (contadores[l.codigoGrupo] || 0) + 1;
        l.codigoConta = `${l.codigoGrupo}.${String(contadores[l.codigoGrupo]).padStart(2, '0')}`;
    });

    const totalDebito  = linhas.reduce((s, l) => s + l.debito, 0);
    const totalCredito = linhas.reduce((s, l) => s + l.credito, 0);

    return { linhas, totalDebito, totalCredito, saldoFinal: totalCredito - totalDebito };
}

function renderBalancete(container, balancete, meta) {
    if (!container) return;

    const linhasHtml = balancete.linhas.map(l => `
        <tr>
            <td class="balancete-codigo">${l.codigoConta}</td>
            <td>${escaparHtml(l.nome)}</td>
            <td class="balancete-grupo">${l.labelGrupo}</td>
            <td class="balancete-valor">${l.debito > 0 ? _fmtMoeda(l.debito) : '—'}</td>
            <td class="balancete-valor">${l.credito > 0 ? _fmtMoeda(l.credito) : '—'}</td>
            <td class="balancete-valor ${l.saldo >= 0 ? 'positivo' : 'negativo'}">${_fmtMoeda(l.saldo)}</td>
        </tr>
    `).join('') || '<tr><td colspan="6" class="dre-vazio">Nenhum lançamento no período</td></tr>';

    container.innerHTML = `
        <div class="dre-header">
            <h4>Balancete de Verificação — ${escaparHtml(meta.clienteNome)}</h4>
            <p class="dre-periodo">${meta.periodoLabel}</p>
        </div>
        <table class="balancete-table">
            <thead>
                <tr>
                    <th>Código</th>
                    <th>Conta</th>
                    <th>Grupo Contábil</th>
                    <th>Débito</th>
                    <th>Crédito</th>
                    <th>Saldo</th>
                </tr>
            </thead>
            <tbody>
                ${linhasHtml}
            </tbody>
            <tfoot>
                <tr class="balancete-total">
                    <td colspan="3">TOTAIS</td>
                    <td>${_fmtMoeda(balancete.totalDebito)}</td>
                    <td>${_fmtMoeda(balancete.totalCredito)}</td>
                    <td class="${balancete.saldoFinal >= 0 ? 'positivo' : 'negativo'}">${_fmtMoeda(balancete.saldoFinal)}</td>
                </tr>
            </tfoot>
        </table>
    `;
}

// ══════════════════════════════════════════════════════════════
// EXPORTAR PARA PDF (via diálogo de impressão nativo do navegador)
// ══════════════════════════════════════════════════════════════
/**
 * Não usa nenhuma biblioteca externa — clona o HTML já renderizado
 * (DRE ou Balancete) pra uma área escondida dedicada, marca o <body>
 * com uma classe que o CSS de @media print usa pra esconder TUDO
 * exceto essa área, e chama window.print(). O utilizador escolhe
 * "Salvar como PDF" como destino no próprio diálogo do navegador —
 * é assim que a maioria dos sistemas de gestão gera PDF sem precisar
 * de backend nem de bibliotecas de renderização de PDF no cliente.
 */
function exportarParaPDF(elementId, tituloDocumento) {
    const conteudo = document.getElementById(elementId);
    if (!conteudo || !conteudo.innerHTML.trim()) {
        if (typeof showToast === 'function') showToast('Nada para exportar ainda.', 'error');
        return;
    }

    const areaImpressao = document.getElementById('areaImpressaoContabil') || criarAreaImpressao();
    areaImpressao.innerHTML = `<h1 class="impressao-titulo">${tituloDocumento}</h1>${conteudo.innerHTML}`;

    document.body.classList.add('modo-impressao-contabil');
    window.print();

    const aoTerminar = () => {
        document.body.classList.remove('modo-impressao-contabil');
        window.removeEventListener('afterprint', aoTerminar);
    };
    window.addEventListener('afterprint', aoTerminar);
}

function criarAreaImpressao() {
    const div = document.createElement('div');
    div.id = 'areaImpressaoContabil';
    document.body.appendChild(div);
    return div;
}

// ══════════════════════════════════════════════════════════════
// BALANCETE AMPLIADO — ZOOM + ANOTAÇÕES (caneta/texto/borracha)
// ══════════════════════════════════════════════════════════════

let balanceteAmpliadoZoom          = 1;
let balanceteAmpliadoFerramenta    = 'caneta';
let balanceteAmpliadoDesenhando    = false;
let balanceteAmpliadoUltimoPonto   = null;
let balanceteAmpliadoHistorico     = []; // pilha de ImageData para "Desfazer"
let balanceteAmpliadoCtx           = null;
let balanceteAmpliadoEventosLigados = false;

/**
 * Abre o Balancete Ampliado do cliente atualmente exibido no modal
 * "Ver Dashboard" (dashboards.js mantém `dashboardContextoAtual`
 * atualizado a cada abertura). Renderiza o balancete DE NOVO dentro
 * do modal ampliado (tabela HTML real — continua nítida em qualquer
 * zoom) e prepara um canvas do mesmo tamanho por cima, pronto pra
 * anotação livre.
 */
function abrirBalanceteAmpliado() {
    const contexto = (typeof dashboardContextoAtual !== 'undefined') ? dashboardContextoAtual : null;
    if (!contexto || !contexto.transacoes) {
        if (typeof showToast === 'function') showToast('Abra o dashboard de um cliente primeiro.', 'error');
        return;
    }

    const tituloEl = document.getElementById('balancete-ampliado-title');
    if (tituloEl) tituloEl.textContent = `📋 Balancete Ampliado — ${contexto.clienteNome}`;

    const balancete = calcularBalancete(contexto.transacoes);
    const tabelaContainer = document.getElementById('balancete-ampliado-tabela');
    // `contexto.transacoes` já vem recortado pelo filtro de período do
    // modal (ver aplicarPeriodoDashboard em dashboards.js) — o ampliado
    // mostra exatamente o mesmo recorte da aba Balancete, senão o admin
    // anotaria em cima de números diferentes dos que estava vendo.
    renderBalancete(tabelaContainer, balancete, {
        clienteNome: contexto.clienteNome,
        periodoLabel: contexto.periodoLabel || 'Todos os lançamentos'
    });

    openModal('modal-balancete-ampliado');

    // offsetWidth/offsetHeight só ficam corretos depois do elemento
    // estar de facto visível no layout — por isso o requestAnimationFrame.
    requestAnimationFrame(() => {
        dimensionarCanvasAnotacao();
        aplicarZoomBalanceteAmpliado(1);
        ligarEventosBalanceteAmpliado();
    });
}

/**
 * Redimensiona o canvas de anotação pro mesmo tamanho NATURAL (sem
 * zoom aplicado — transform CSS não afeta offsetWidth/Height) da
 * tabela renderizada. SEMPRE começa limpo: cada abertura do modal
 * pode ser de um cliente/balancete diferente, então preservar
 * anotações antigas aqui seria misturar anotações de clientes
 * diferentes por engano.
 */
function dimensionarCanvasAnotacao() {
    const tabela = document.getElementById('balancete-ampliado-tabela');
    const canvas = document.getElementById('balancete-ampliado-canvas');
    if (!tabela || !canvas) return;

    canvas.width  = Math.max(1, tabela.offsetWidth);
    canvas.height = Math.max(1, tabela.offsetHeight);
    canvas.style.width  = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;

    balanceteAmpliadoCtx = canvas.getContext('2d');
    balanceteAmpliadoHistorico = [];
}

function aplicarZoomBalanceteAmpliado(novoZoom) {
    balanceteAmpliadoZoom = Math.max(0.5, Math.min(3, novoZoom));

    const wrapper = document.getElementById('balancete-ampliado-wrapper');
    if (wrapper) {
        wrapper.style.transform = `scale(${balanceteAmpliadoZoom})`;
        wrapper.style.transformOrigin = 'top left';
    }

    const label = document.getElementById('balanceteZoomLabel');
    if (label) label.textContent = `${Math.round(balanceteAmpliadoZoom * 100)}%`;
}

/**
 * Converte a posição do rato/dedo (em pixels de TELA) pra coordenadas
 * INTERNAS do canvas — a divisão por canvas.width/rect.width já
 * absorve tanto o zoom aplicado via CSS transform quanto qualquer
 * diferença de densidade de pixels, sem precisar rastrear o fator de
 * escala manualmente.
 */
function obterPosicaoNoCanvas(canvas, evento) {
    const rect    = canvas.getBoundingClientRect();
    const origem  = evento.touches?.[0] || evento;
    const escalaX = canvas.width  / rect.width;
    const escalaY = canvas.height / rect.height;
    return {
        x: (origem.clientX - rect.left) * escalaX,
        y: (origem.clientY - rect.top)  * escalaY
    };
}

function salvarEstadoParaDesfazer() {
    if (!balanceteAmpliadoCtx) return;
    const canvas = balanceteAmpliadoCtx.canvas;
    balanceteAmpliadoHistorico.push(balanceteAmpliadoCtx.getImageData(0, 0, canvas.width, canvas.height));
    // Limite de segurança pra não crescer sem parar numa sessão longa de anotação.
    if (balanceteAmpliadoHistorico.length > 30) balanceteAmpliadoHistorico.shift();
}

function desfazerUltimaAnotacao() {
    if (!balanceteAmpliadoCtx || !balanceteAmpliadoHistorico.length) return;
    const anterior = balanceteAmpliadoHistorico.pop();
    balanceteAmpliadoCtx.putImageData(anterior, 0, 0);
}

function limparAnotacoes() {
    if (!balanceteAmpliadoCtx) return;
    if (!confirm('Apagar todas as anotações deste balancete?')) return;
    salvarEstadoParaDesfazer();
    balanceteAmpliadoCtx.clearRect(0, 0, balanceteAmpliadoCtx.canvas.width, balanceteAmpliadoCtx.canvas.height);
}

function iniciarTraco(evento) {
    if (!balanceteAmpliadoCtx) return;

    if (balanceteAmpliadoFerramenta === 'texto') {
        const texto = prompt('Digite a anotação:');
        if (!texto) return;

        const pos = obterPosicaoNoCanvas(balanceteAmpliadoCtx.canvas, evento);
        salvarEstadoParaDesfazer();

        const cor        = document.getElementById('anotacao-cor')?.value || '#00f5a0';
        const espessura   = parseInt(document.getElementById('anotacao-espessura')?.value || '3', 10);

        balanceteAmpliadoCtx.fillStyle = cor;
        balanceteAmpliadoCtx.font      = `${12 + espessura * 2}px sans-serif`;
        balanceteAmpliadoCtx.fillText(texto, pos.x, pos.y);
        return;
    }

    evento.preventDefault();
    salvarEstadoParaDesfazer();
    balanceteAmpliadoDesenhando  = true;
    balanceteAmpliadoUltimoPonto = obterPosicaoNoCanvas(balanceteAmpliadoCtx.canvas, evento);
}

function continuarTraco(evento) {
    if (!balanceteAmpliadoDesenhando || !balanceteAmpliadoCtx) return;
    evento.preventDefault();

    const pos       = obterPosicaoNoCanvas(balanceteAmpliadoCtx.canvas, evento);
    const cor       = document.getElementById('anotacao-cor')?.value || '#00f5a0';
    const espessura = parseInt(document.getElementById('anotacao-espessura')?.value || '3', 10);

    balanceteAmpliadoCtx.lineJoin  = 'round';
    balanceteAmpliadoCtx.lineCap   = 'round';
    balanceteAmpliadoCtx.lineWidth = balanceteAmpliadoFerramenta === 'borracha' ? espessura * 4 : espessura;
    balanceteAmpliadoCtx.globalCompositeOperation = balanceteAmpliadoFerramenta === 'borracha' ? 'destination-out' : 'source-over';
    balanceteAmpliadoCtx.strokeStyle = cor;

    balanceteAmpliadoCtx.beginPath();
    balanceteAmpliadoCtx.moveTo(balanceteAmpliadoUltimoPonto.x, balanceteAmpliadoUltimoPonto.y);
    balanceteAmpliadoCtx.lineTo(pos.x, pos.y);
    balanceteAmpliadoCtx.stroke();

    balanceteAmpliadoUltimoPonto = pos;
}

function finalizarTraco() {
    balanceteAmpliadoDesenhando  = false;
    balanceteAmpliadoUltimoPonto = null;
}

function ligarEventosBalanceteAmpliado() {
    if (balanceteAmpliadoEventosLigados) return;
    balanceteAmpliadoEventosLigados = true;

    const canvas = document.getElementById('balancete-ampliado-canvas');
    if (!canvas) return;

    canvas.addEventListener('mousedown', iniciarTraco);
    canvas.addEventListener('mousemove', continuarTraco);
    window.addEventListener('mouseup', finalizarTraco);

    canvas.addEventListener('touchstart', iniciarTraco, { passive: false });
    canvas.addEventListener('touchmove', continuarTraco, { passive: false });
    canvas.addEventListener('touchend', finalizarTraco);

    document.querySelectorAll('#modal-balancete-ampliado .toolbar-btn[data-ferramenta]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#modal-balancete-ampliado .toolbar-btn[data-ferramenta]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            balanceteAmpliadoFerramenta = btn.dataset.ferramenta;
        });
    });

    document.getElementById('btn-desfazer-anotacao')?.addEventListener('click', desfazerUltimaAnotacao);
    document.getElementById('btn-limpar-anotacoes')?.addEventListener('click', limparAnotacoes);

    document.getElementById('btn-zoom-mais')?.addEventListener('click', () => aplicarZoomBalanceteAmpliado(balanceteAmpliadoZoom + 0.15));
    document.getElementById('btn-zoom-menos')?.addEventListener('click', () => aplicarZoomBalanceteAmpliado(balanceteAmpliadoZoom - 0.15));
    document.getElementById('btn-zoom-reset')?.addEventListener('click', () => aplicarZoomBalanceteAmpliado(1));

    document.getElementById('btn-exportar-balancete-ampliado')?.addEventListener('click', exportarBalanceteAmpliadoParaPDF);
}

/**
 * Exporta o Balancete Ampliado JÁ COM as anotações desenhadas —
 * como o canvas fica posicionado exatamente por cima da tabela real
 * (ambos dentro do mesmo wrapper), imprimir o próprio modal (em vez
 * de clonar conteúdo pra uma área escondida, como exportarParaPDF
 * faz) preserva a sobreposição visual correta no PDF gerado.
 */
function exportarBalanceteAmpliadoParaPDF() {
    document.body.classList.add('modo-impressao-balancete-ampliado');
    window.print();

    const aoTerminar = () => {
        document.body.classList.remove('modo-impressao-balancete-ampliado');
        window.removeEventListener('afterprint', aoTerminar);
    };
    window.addEventListener('afterprint', aoTerminar);
}

console.log('✅ contabilidade.js carregado (DRE, Balancete, exportação PDF, Balancete Ampliado com anotação)');
