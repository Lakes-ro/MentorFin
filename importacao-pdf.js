/**
 * IMPORTACAO-PDF.JS — Leitura de extrato bancário em PDF
 * ================================================
 * Transforma o PDF do extrato (ex.: Santander) nas MESMAS linhas que os
 * parsers de OFX/CSV produzem — { dataValida, data, descricao, valorAbs,
 * tipo, importHash } — e daí em diante o fluxo é o de sempre em
 * importacao-extrato.js (classificação, revisão, deduplicação, gravação).
 *
 * Como funciona:
 *   1. pdf.js (Mozilla) é baixado SOB DEMANDA do cdnjs, só quando alguém
 *      escolhe um PDF — quem importa OFX/CSV não paga nada a mais.
 *   2. O texto de cada página é lido com a POSIÇÃO de cada palavra e
 *      remontado em linhas visuais (mesma altura = mesma linha).
 *   3. Se houver cabeçalho de tabela (Data | Descrição | Crédito |
 *      Débito | Saldo — padrão Santander), cada valor é atribuído à
 *      coluna mais próxima: crédito = receita, débito = despesa, saldo =
 *      só para conferência.
 *   4. Sem colunas separadas, o sinal vem de: "-" antes/depois do valor,
 *      sufixo D/C, variação do saldo da linha e, por último, palavras da
 *      descrição ("recebido", "salário", "estorno"...). Na dúvida vira
 *      despesa — o cliente confere o Tipo na tabela de revisão.
 *   5. Linhas sem data herdam a data da anterior (o Santander agrupa
 *      vários lançamentos sob a mesma data). Linhas sem valor logo abaixo
 *      de um lançamento são a continuação da descrição (ex.: o nome de
 *      quem recebeu o PIX) e são coladas nela.
 *   6. Linhas de saldo ("SALDO ANTERIOR", "SALDO DO DIA"...) não viram
 *      lançamento — servem para conferir se a soma bate com o saldo.
 *
 * Limitações honestas:
 *   - PDF escaneado (foto/imagem) não tem texto — pedimos OFX/CSV.
 *   - PDF com senha: pedimos a senha ao usuário (nada é guardado).
 *
 * Padrão: script global (sem import/export). É carregado SOB DEMANDA por
 * importacao-extrato.js (carregarLeitorPdfExtrato), então não precisa de
 * <script> nos HTMLs. As funções puras também são exportadas para Node
 * (testes) pelo bloco no fim do arquivo.
 */

const PDFJS_VERSAO     = '3.11.174';
const PDFJS_URL        = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSAO}/pdf.min.js`;
const PDFJS_WORKER_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSAO}/pdf.worker.min.js`;

// ══════════════════════════════════════════════════════════════
// UTILITÁRIOS
// ══════════════════════════════════════════════════════════════

function normPdf(t) {
    return String(t || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/\s+/g, ' ').trim();
}

const REGEX_VALOR_PDF = /^[-+]?(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}[-+]?$/;
const REGEX_DATA_PDF  = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/;

function ehValorPdf(str) { return REGEX_VALOR_PDF.test(str); }

/** "1.234,56-" → -1234.56 ; "-50,00" → -50 ; "50,00" → 50 */
function converterValorPdf(str) {
    const s = String(str).trim();
    const negativo = /^-|-$/.test(s);
    const n = parseFloat(s.replace(/[-+]/g, '').replace(/\./g, '').replace(',', '.'));
    return negativo ? -n : n;
}

// ══════════════════════════════════════════════════════════════
// 1) CARREGAR pdf.js E LER O TEXTO COM POSIÇÕES
// ══════════════════════════════════════════════════════════════

let promessaPdfJs = null;

function carregarPdfJs() {
    if (typeof window !== 'undefined' && window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (promessaPdfJs) return promessaPdfJs;

    promessaPdfJs = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = PDFJS_URL;
        s.async = true;
        s.onload = () => {
            if (!window.pdfjsLib) { reject(new Error('Leitor de PDF não carregou.')); return; }
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
            resolve(window.pdfjsLib);
        };
        s.onerror = () => {
            promessaPdfJs = null; // deixa tentar de novo
            reject(new Error('Não foi possível baixar o leitor de PDF. Verifique a internet e tente de novo.'));
        };
        document.head.appendChild(s);
    });
    return promessaPdfJs;
}

function lerArquivoComoArrayBuffer(arquivo) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = (e) => resolve(e.target.result);
        reader.onerror = () => reject(new Error('Não foi possível ler o arquivo. Tente novamente.'));
        reader.readAsArrayBuffer(arquivo);
    });
}

/**
 * Abre o PDF; se tiver senha, pergunta ao usuário (até 3 tentativas).
 * `pedirSenha(mensagem)` → string | null (null = desistiu).
 */
async function abrirDocumentoPdf(pdfjsLib, dados, pedirSenha) {
    let senha;
    for (let tentativa = 0; tentativa < 4; tentativa++) {
        try {
            const params = { data: new Uint8Array(dados.slice(0)), isEvalSupported: false };
            if (senha) params.password = senha;
            return await pdfjsLib.getDocument(params).promise;
        } catch (err) {
            if (err?.name !== 'PasswordException') throw err;
            if (!pedirSenha || tentativa === 3) throw new Error('PDF protegido por senha — não foi possível abrir.');
            const msg = err.code === 2
                ? 'Senha incorreta. Digite a senha do PDF de novo:'
                : 'Este PDF tem senha (muitos bancos usam parte do CPF). Digite a senha para abrir:';
            senha = pedirSenha(msg);
            if (senha === null || senha === undefined || senha === '') {
                throw new Error('Importação cancelada: o PDF precisa de senha para ser lido.');
            }
        }
    }
    throw new Error('PDF protegido por senha — não foi possível abrir.');
}

/**
 * Lê todas as páginas e devolve linhas visuais:
 *   [{ pagina, y, altura, tokens: [{ x, x2, str }] }]
 * Cada "token" é uma palavra, com posição horizontal estimada.
 */
async function extrairLinhasVisuaisPdf(doc) {
    const linhas = [];
    for (let p = 1; p <= doc.numPages; p++) {
        const pagina   = await doc.getPage(p);
        const conteudo = await pagina.getTextContent();

        const itens = conteudo.items
            .filter(it => it.str && it.str.trim())
            .map(it => ({
                str:    it.str,
                x:      it.transform[4],
                y:      it.transform[5],
                largura: it.width || 0,
                altura: Math.abs(it.height || it.transform[3] || 8)
            }));

        linhas.push(...agruparItensEmLinhas(itens, p));
        pagina.cleanup?.();
    }
    return linhas;
}

/** Função pura (testável): itens com x/y → linhas ordenadas de cima p/ baixo. */
function agruparItensEmLinhas(itens, numPagina) {
    const ordenados = [...itens].sort((a, b) => (b.y - a.y) || (a.x - b.x));
    const linhas = [];

    for (const it of ordenados) {
        const tolerancia = Math.max(2, it.altura * 0.45);
        let linha = linhas.find(l => Math.abs(l.y - it.y) <= tolerancia);
        if (!linha) {
            linha = { pagina: numPagina, y: it.y, altura: it.altura, tokens: [] };
            linhas.push(linha);
        }
        linha.tokens.push(...quebrarItemEmPalavras(it));
    }

    linhas.forEach(l => l.tokens.sort((a, b) => a.x - b.x));
    linhas.sort((a, b) => b.y - a.y);
    return linhas;
}

function quebrarItemEmPalavras(it) {
    const texto = it.str;
    const larguraPorChar = texto.length ? it.largura / texto.length : 0;
    const tokens = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(texto))) {
        const x = it.x + m.index * larguraPorChar;
        tokens.push({ str: m[0], x, x2: x + m[0].length * larguraPorChar });
    }
    return tokens;
}

// ══════════════════════════════════════════════════════════════
// 2) INTERPRETAR AS LINHAS COMO EXTRATO (função pura, testável)
// ══════════════════════════════════════════════════════════════

const PALAVRAS_RECEITA_PDF = [
    'recebid', 'receb ', 'credito em conta', 'cred ', 'deposito', 'dep ', 'salario', 'sal ', 'proventos',
    'estorno', 'devolucao', 'rendimento', 'resgate', 'reembolso', 'remuneracao', 'juros recebidos', 'ted receb', 'doc receb'
];

const PADRAO_LINHA_IGNORAR = /^(total|subtotal|resumo|pagina \d|pag\.? \d|central de atendimento|sac\b|ouvidoria|deficiente auditivo|extrato (de|consolidado)|agencia\b|conta corrente\b|cliente\b|periodo\b|emitido|data de emissao|lancamentos futuros|limite\b|santander\b|\(?r\$\)?$)/;

/**
 * @param {Array} linhas  saída de extrairLinhasVisuaisPdf/agruparItensEmLinhas
 * @param {Object} opcoes { hoje?: Date }
 * @returns {{ linhas: Array, banco: string|null, conferencia: Object|null, agendados: number }}
 */
function interpretarLinhasExtratoPdf(linhas, opcoes = {}) {
    const textoTodo = linhas.map(l => l.tokens.map(t => t.str).join(' ')).join('\n');
    const textoNorm = normPdf(textoTodo);
    const banco = /santander/.test(textoNorm) ? 'santander' : null;
    const referencia = descobrirAnoReferencia(textoTodo, opcoes.hoje || new Date());

    // O extrato marca as saídas com "-" (ou "D")? Então valor SEM sinal é entrada.
    const documentoUsaSinal = linhas.some(l => juntarSinaisSoltos(l.tokens).some((t, i, arr) =>
        ehValorPdf(t.str) && (/^-|-$/.test(t.str) || /^D$/i.test(arr[i + 1]?.str || ''))));

    let colunas = null;          // { credito, debito, saldo, valor, docto, descricao } (x central)
    let dataAtual = null;
    let saldoAnterior = null;
    let ultimoSaldo = null;
    const registros = [];        // { tipo: 'mov'|'texto', ... }
    let ignoradosAgendados = 0;  // lançamentos futuros (agendados) não entram

    for (const linha of linhas) {
        const tokens = juntarSinaisSoltos(linha.tokens);
        if (!tokens.length) continue;
        const textoLinha = normPdf(tokens.map(t => t.str).join(' '));

        // Cabeçalho da tabela: guarda a posição das colunas (repete por página)
        const cab = detectarCabecalho(tokens, textoLinha);
        if (cab) { colunas = cab; continue; }

        // Data no começo da linha?
        let idxInicio = 0;
        let dataDaLinha = null;
        const mData = tokens[0].str.match(REGEX_DATA_PDF);
        if (mData) {
            dataDaLinha = montarData(mData, referencia);
            if (dataDaLinha) { dataAtual = dataDaLinha; idxInicio = 1; }
        }

        // Separa valores (com o sinal/sufixo D-C que vier colado) do texto
        const valores = [];
        const palavras = [];
        for (let i = idxInicio; i < tokens.length; i++) {
            const t = tokens[i];
            if (ehValorPdf(t.str)) {
                let v = converterValorPdf(t.str);
                const prox = tokens[i + 1];
                if (prox && /^[DC]$/i.test(prox.str)) {
                    v = prox.str.toUpperCase() === 'D' ? -Math.abs(v) : Math.abs(v);
                    i++;
                }
                valores.push({ valor: v, explicito: /^-|-$/.test(t.str) || (prox && /^[DC]$/i.test(prox.str)), x: (t.x + t.x2) / 2, x2: t.x2 });
            } else if (!/^r\$$/i.test(t.str)) {
                palavras.push(t);
            }
        }

        // Coluna "Situação" (Internet Banking Santander): Efetivado some da
        // descrição; Agendado/Pendente ainda não aconteceu → não importa.
        let agendado = false;
        for (let i = palavras.length - 1; i >= 0; i--) {
            const n = normPdf(palavras[i].str);
            if (/^(efetivad[oa]s?|confirmad[oa]s?|realizad[oa]s?)$/.test(n)) palavras.splice(i, 1);
            else if (/^(agendad[oa]s?|pendentes?|programad[oa]s?)$/.test(n)) { agendado = true; palavras.splice(i, 1); }
        }

        const descricaoBruta = limparTokensDescricao(palavras, colunas, valores).trim();
        const descNorm = normPdf(descricaoBruta);

        // Linhas de SALDO: não são lançamentos, mas alimentam a conferência
        if (/^saldo\b|\bsaldo (anterior|do dia|em \d|final|inicial|disponivel|total|bloqueado|atual)/.test(descNorm) || /^s ?a ?l ?d ?o\b/.test(descNorm)) {
            if (valores.length) {
                const v = valores[valores.length - 1].valor;
                if (/anterior|inicial/.test(descNorm) && saldoAnterior === null && !registros.some(r => r.tipo === 'mov')) saldoAnterior = v;
                ultimoSaldo = v;
            }
            continue;
        }

        if (!valores.length) {
            if (!descricaoBruta || PADRAO_LINHA_IGNORAR.test(descNorm) || PADRAO_LINHA_IGNORAR.test(textoLinha)) continue;
            registros.push({ tipo: 'texto', texto: descricaoBruta, pagina: linha.pagina, y: linha.y, altura: linha.altura, comData: !!dataDaLinha, data: dataAtual });
            continue;
        }

        if (/^(total|subtotal|resumo)\b/.test(descNorm) && !dataDaLinha) continue;
        if (agendado) { ignoradosAgendados++; continue; }

        // Classifica cada valor pela coluna
        let valorMov = null;
        let saldoDaLinha = null;
        let sinalDefinido = false;

        if (colunas && (colunas.credito != null || colunas.debito != null || colunas.saldo != null)) {
            for (const v of valores) {
                const col = colunaMaisProxima(v.x, colunas);
                if (col === 'saldo') saldoDaLinha = v.valor;
                else if (col === 'credito' && valorMov === null) { valorMov = Math.abs(v.valor); sinalDefinido = true; }
                else if (col === 'debito'  && valorMov === null) { valorMov = -Math.abs(v.valor); sinalDefinido = true; }
                else if (valorMov === null) { valorMov = v.valor; sinalDefinido = v.explicito || v.valor < 0; }
            }
        } else {
            valorMov = valores[0].valor;
            sinalDefinido = valores[0].explicito || valorMov < 0;
            if (valores.length >= 2) saldoDaLinha = valores[valores.length - 1].valor;
        }

        if (valorMov === null) {           // só tinha saldo na linha
            if (saldoDaLinha !== null) ultimoSaldo = saldoDaLinha;
            continue;
        }

        // Sinal ainda incerto: tenta pela variação do saldo, depois por palavras
        if (!sinalDefinido) {
            const abs = Math.abs(valorMov);
            if (saldoDaLinha !== null && ultimoSaldo !== null) {
                if (Math.abs(ultimoSaldo + abs - saldoDaLinha) < 0.01) { valorMov = abs; sinalDefinido = true; }
                else if (Math.abs(ultimoSaldo - abs - saldoDaLinha) < 0.01) { valorMov = -abs; sinalDefinido = true; }
            }
            if (!sinalDefinido && documentoUsaSinal) {
                valorMov = abs;
                sinalDefinido = !!colunas; // com cabeçalho de tabela, é certeza
            } else if (!sinalDefinido) {
                const pareceReceita = PALAVRAS_RECEITA_PDF.some(p => (` ${descNorm} `).includes(p.endsWith(' ') ? ` ${p}` : p));
                valorMov = pareceReceita ? abs : -abs;
            }
        }

        if (saldoDaLinha !== null) ultimoSaldo = saldoDaLinha;
        else if (ultimoSaldo !== null) ultimoSaldo = Math.round((ultimoSaldo + valorMov) * 100) / 100;

        registros.push({
            tipo: 'mov', data: dataAtual, descricao: descricaoBruta, valor: valorMov,
            pagina: linha.pagina, y: linha.y, altura: linha.altura, sinalDefinido
        });
    }

    // 2º passe: linhas só de texto viram parte de um lançamento vizinho
    for (let i = 0; i < registros.length; i++) {
        const r = registros[i];
        if (r.tipo !== 'texto') continue;

        const proximoMov = registros.slice(i + 1).find(x => x.tipo === 'mov');
        const anteriorMov = [...registros.slice(0, i)].reverse().find(x => x.tipo === 'mov');

        // Texto com data no começo, ou o próximo lançamento está sem descrição → é do próximo
        if (proximoMov && (r.comData || !proximoMov.descricao)) {
            proximoMov.descricao = `${r.texto} ${proximoMov.descricao}`.trim();
            if (r.comData && r.data) proximoMov.data = proximoMov.data || r.data;
            continue;
        }

        // Senão é continuação do lançamento de cima (mesma página, logo abaixo)
        if (anteriorMov && anteriorMov.pagina === r.pagina &&
            (anteriorMov.y - r.y) <= Math.max(anteriorMov.altura, 8) * 3.2 &&
            (anteriorMov._continuacoes || 0) < 2 && r.texto.length <= 80) {
            anteriorMov.descricao = `${anteriorMov.descricao} ${r.texto}`.trim();
            anteriorMov._continuacoes = (anteriorMov._continuacoes || 0) + 1;
        }
    }

    const movimentos = registros.filter(r => r.tipo === 'mov');
    const saida = movimentos.map(m => {
        const descricao = (m.descricao || '(sem descrição)').replace(/\s+/g, ' ').trim().slice(0, 140);
        return {
            dataValida: !!m.data && !isNaN(m.valor) && m.valor !== 0,
            data:       m.data,
            descricao,
            valorAbs:   Math.abs(m.valor),
            tipo:       m.valor < 0 ? 'despesa' : 'receita',
            importHash: null,
            sinalIncerto: !m.sinalDefinido
        };
    });

    // Conferência: saldo anterior + lançamentos = último saldo?
    let conferencia = null;
    if (saldoAnterior !== null && ultimoSaldo !== null && movimentos.length) {
        const soma = movimentos.reduce((s, m) => s + m.valor, 0);
        const diferenca = Math.round((saldoAnterior + soma - ultimoSaldo) * 100) / 100;
        conferencia = { saldoAnterior, saldoFinal: ultimoSaldo, bate: Math.abs(diferenca) < 0.01, diferenca };
    }

    return { linhas: saida, banco, conferencia, agendados: ignoradosAgendados };
}

/** "-" ou "+" soltos colados a um valor, e "R$ -" → um token só. */
function juntarSinaisSoltos(tokens) {
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const prox = tokens[i + 1];
        if (/^[-+]$/.test(t.str) && prox && ehValorPdf(prox.str) && (prox.x - t.x2) < 12) {
            out.push({ str: t.str + prox.str, x: t.x, x2: prox.x2 }); i++; continue;
        }
        if (ehValorPdf(t.str) && prox && /^-$/.test(prox.str) && (prox.x - t.x2) < 6) {
            out.push({ str: t.str + '-', x: t.x, x2: prox.x2 }); i++; continue;
        }
        out.push(t);
    }
    return out;
}

function detectarCabecalho(tokens, textoLinha) {
    if (!/\bdata\b/.test(textoLinha)) return null;
    const marcadores = ['credito', 'debito', 'saldo', 'valor', 'movimento', 'historico', 'descricao', 'lancamento', 'entrada', 'saida'];
    const encontrados = marcadores.filter(m => textoLinha.includes(m));
    if (encontrados.length < 2) return null;
    if (!/credito|debito|valor|movimento|entrada|saida/.test(textoLinha)) return null;

    const col = {};
    for (const t of tokens) {
        const n = normPdf(t.str);
        const centro = (t.x + t.x2) / 2;
        if (/^(creditos?|entradas?)\b/.test(n) && col.credito == null) col.credito = centro;
        else if (/^(debitos?|saidas?)\b/.test(n) && col.debito == null) col.debito = centro;
        else if (/^saldos?\b/.test(n) && col.saldo == null) col.saldo = centro;
        else if (/^(valor(es)?|movimentos?|movimentacao)\b/.test(n) && col.valor == null) col.valor = centro;
        else if (/^(docto|documento|doc\.?|n[ºo°]?)$/.test(n) && col.docto == null) col.docto = { x: t.x, x2: t.x2 };
        else if (/^(descricao|historico|lancamento|lancamentos)$/.test(n) && col.descricao == null) col.descricao = t.x;
    }
    if (col.credito == null && col.debito == null && col.valor == null) return null;
    return col;
}

function colunaMaisProxima(x, colunas) {
    let melhor = null, dist = Infinity;
    for (const nome of ['credito', 'debito', 'saldo', 'valor']) {
        if (colunas[nome] == null) continue;
        const d = Math.abs(colunas[nome] - x);
        if (d < dist) { dist = d; melhor = nome; }
    }
    return melhor;
}

/** Junta as palavras da descrição, descartando o nº do documento. */
function limparTokensDescricao(palavras, colunas, valores) {
    const primeiroValorX = valores.length ? Math.min(...valores.map(v => v.x)) : Infinity;
    const mantidas = palavras.filter((t, i) => {
        const soDigitos = /^\d{4,}$/.test(t.str);
        if (!soDigitos) return true;
        if (colunas?.docto) {
            const centro = (t.x + t.x2) / 2;
            if (centro >= colunas.docto.x - 25 && centro <= colunas.docto.x2 + 60) return false;
        }
        // sem cabeçalho: número comprido logo antes do valor = documento
        const ultimaPalavra = i === palavras.length - 1;
        return !(ultimaPalavra && t.str.length >= 5 && t.x2 <= primeiroValorX);
    });
    return mantidas.map(t => t.str).join(' ');
}

/** Ano/mês de referência para datas "dd/mm" sem ano. */
function descobrirAnoReferencia(texto, hoje) {
    const t = normPdf(texto);
    // "Período: 01/09/2026 a 30/09/2026" (pega a data final)
    const per = t.match(/periodo[^0-9]{0,30}(\d{1,2})\/(\d{1,2})\/(\d{4})[^0-9]{1,15}(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (per) return { ano: +per[6], mes: +per[5] };

    const datasCompletas = [...t.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)]
        .map(m => ({ ano: +m[3], mes: +m[2] }))
        .filter(d => d.mes >= 1 && d.mes <= 12 && d.ano > 2000 && d.ano < 2100);
    if (datasCompletas.length) {
        return datasCompletas.reduce((a, b) => (b.ano * 12 + b.mes > a.ano * 12 + a.mes ? b : a));
    }

    const meses = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
    const mesNome = t.match(/\b(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*\.?\s*(?:\/|de)?\s*(\d{4})\b/);
    if (mesNome) return { ano: +mesNome[2], mes: meses.indexOf(mesNome[1]) + 1 };

    return { ano: hoje.getFullYear(), mes: hoje.getMonth() + 1 };
}

function montarData(m, referencia) {
    const dia = +m[1], mes = +m[2];
    if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
    let ano;
    if (m[3]) ano = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    else ano = mes > referencia.mes ? referencia.ano - 1 : referencia.ano;
    const iso = `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    const d = new Date(`${iso}T12:00:00`);
    return isNaN(d) || d.getDate() !== dia ? null : iso;
}

// ══════════════════════════════════════════════════════════════
// 3) PONTO DE ENTRADA USADO POR importacao-extrato.js
// ══════════════════════════════════════════════════════════════

/**
 * @param {File} arquivo
 * @returns {Promise<{ linhas: Array, banco: string|null, conferencia: Object|null }>}
 */
async function parsearPdfExtrato(arquivo) {
    const pdfjsLib = await carregarPdfJs();
    const dados = await lerArquivoComoArrayBuffer(arquivo);
    const doc = await abrirDocumentoPdf(pdfjsLib, dados, (msg) => window.prompt(msg));

    try {
        const linhasVisuais = await extrairLinhasVisuaisPdf(doc);
        const totalCaracteres = linhasVisuais.reduce((s, l) => s + l.tokens.reduce((a, t) => a + t.str.length, 0), 0);
        if (totalCaracteres < 30) {
            throw new Error('Este PDF parece ser uma imagem (escaneado/foto), sem texto para ler. Baixe o extrato em PDF direto do app/site do banco, ou use OFX/CSV.');
        }

        const resultado = interpretarLinhasExtratoPdf(linhasVisuais);
        if (!resultado.linhas.length) {
            throw new Error('Não encontrei lançamentos neste PDF. Confira se é o EXTRATO da conta (com data, descrição e valor de cada movimentação). Se continuar, use OFX ou CSV.');
        }
        return resultado;
    } finally {
        doc.destroy?.();
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { agruparItensEmLinhas, interpretarLinhasExtratoPdf, extrairLinhasVisuaisPdf, abrirDocumentoPdf, converterValorPdf, descobrirAnoReferencia };
}

if (typeof console !== 'undefined') console.log('✅ importacao-pdf.js carregado (extrato em PDF)');
