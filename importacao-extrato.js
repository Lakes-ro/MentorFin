/**
 * IMPORTACAO-EXTRATO.JS — Importação de Extrato Bancário (OFX/CSV)
 * ================================================
 * Fluxo completo:
 *   1. Cliente escolhe um arquivo .ofx ou .csv e clica "Processar Arquivo".
 *   2. O arquivo é normalizado em linhas { data, descricao, valor, tipo }.
 *   3. Cada linha passa primeiro pelas REGRAS DE NEGÓCIO ESPECÍFICAS DO
 *      PADRÃO NUBANK (ver preClassificarTransacao(), abaixo) — RDB/
 *      Caixinhas, Pagamento de fatura, Reembolso recebido e a limpeza
 *      visual de "Compra no débito - ". Só depois disso é que entra o
 *      pipeline de classificação normal, na ordem:
 *        a) regras_aprendidas (RegrasAprendidasModule.buscarRegra) —
 *           se o cliente já classificou esse termo antes, usa direto;
 *        b) palavras-chave/sinônimos cadastrados pelo ADMIN em
 *           `categorias.palavras_chave` (encontrarCategoriaPorPalavraChave,
 *           de smart-input.js) — plano de contas curado manualmente,
 *           mais confiável que a heurística fixa no código. Distingue
 *           match EXATO (alta confiança) de match por RADICAL/raiz
 *           comum (confiança aproximada — ver nota abaixo);
 *        c) classificador local por palavras-chave FIXAS
 *           (classificarLocalmente, de smart-input.js) — cobre termos
 *           comuns mesmo sem nenhuma curadoria feita pelo admin ainda;
 *        d) se nada reconhecer, fica em aberto para seleção manual.
 *      NENHUMA chamada de rede é feita por linha nesta etapa (nem ao
 *      endpoint /api/classify, que é só placeholder) — com um extrato de
 *      centenas de linhas, esperar N requisições que sempre falham (404)
 *      seria lento e inútil.
 *   4. Uma tabela de revisão aparece — NADA foi salvo no banco ainda.
 *      O cliente confere/corrige cada linha (data, descrição, valor,
 *      tipo, categoria) e pode desmarcar linhas que não quer importar.
 *   5. Só ao clicar "Confirmar Importação" é que os dados são gravados
 *      (em lote, numa única chamada de rede) — e a partir daí o sistema
 *      aprende cada classificação confirmada/corrigida, exatamente como
 *      já acontece no formulário manual de transação.
 *
 * Padrão: script global (sem import/export), igual ao resto do projeto.
 * Depende de (devem estar carregados ANTES): config.js, database.js,
 * ui.js, client.js, app.js, smart-input.js, regras-aprendidas.js, e a
 * biblioteca externa PapaParse (CDN, só usada para o parser de CSV).
 *
 * ATUALIZAÇÃO — "RECEITA ANTES DE DESPESA": o <select> nativo de tipo
 * de cada linha (import-select-tipo) listava Despesa antes de Receita.
 * Trocado para respeitar a mesma convenção usada no resto do sistema.
 *
 * ATUALIZAÇÃO — REGRAS NUBANK (preClassificarTransacao):
 * Antes de qualquer classificação normal, cada linha passa por
 * preClassificarTransacao(descricao, valorComSinal), que resolve 4
 * casos especiais do extrato do Nubank:
 *   1) "Aplicação RDB" / "Resgate RDB" — dinheiro só mudou de conta
 *      (foi pra uma caixinha/investimento e volta), NÃO é receita nem
 *      despesa de verdade -> vira Transferência Interna, categoria
 *      pré-preenchida automaticamente.
 *   2) "Pagamento de fatura" — evita contar a fatura do cartão como
 *      despesa duplicada (as despesas reais já entram pelo extrato do
 *      cartão em si) -> também vira Transferência Interna.
 *   3) "Reembolso recebido" — não é salário/renda nova, é devolução de
 *       um gasto que já tinha sido contabilizado -> Transferência
 *       Interna também, para não inflar a receita do mês.
 *   4) "Compra no débito - " — só uma limpeza visual: remove esse
 *      prefixo da descrição pra tabela ficar mais legível, mas NÃO
 *      força nenhuma categoria (o cliente/importador escolhe
 *      normalmente, e a descrição já limpa ainda ajuda o classificador
 *      por palavra-chave a reconhecer melhor o termo real).
 * Para os casos 1-3 (bloquearCategoria=true), o sistema tenta achar
 * automaticamente uma categoria REAL já cadastrada com
 * grupo='transferencia' e o tipo certo (receita/despesa) — ver
 * encontrarCategoriaDeTransferencia(). Se não existir nenhuma
 * categoria de Transferência Interna cadastrada ainda, a linha cai de
 * volta no pipeline normal de classificação, sem quebrar nada.
 *
 * ATUALIZAÇÃO — SELO DE CONFIANÇA NA TABELA DE REVISÃO:
 * `encontrarCategoriaPorPalavraChave` (smart-input.js) agora devolve
 * também se o match foi de ALTA confiança (sinônimo/nome bateu como
 * substring exato) ou APROXIMADA (só a raiz da palavra bateu — ver
 * nota completa em smart-input.js). A tabela de revisão reflete isso:
 * o selo "🔑 Sinônimo" só aparece pra match de alta confiança; um
 * match aproximado aparece como "🔎 Sugestão aproximada" — um alerta
 * visual pra você prestar atenção extra naquela linha específica antes
 * de confirmar a importação. NADA impede a importação por causa disso
 * — é só um aviso, a decisão final continua sendo sua.
 *
 * ⚠️ SOBRE O DROPDOWN DE CATEGORIA NESTA TABELA:
 * Esta tabela usa <select> NATIVO (sem <optgroup>) por performance
 * numa tabela potencialmente com centenas de linhas — ver explicação
 * completa na versão anterior deste comentário; nada mudou aqui.
 */

// ── Estado do módulo ────────────────────────────────────────────
let linhasImportacao        = [];  // linhas normalizadas + classificadas, ainda não salvas
let categoriasCacheImportacao = null; // cache local das categorias (evita refetch por linha)
let hashesJaImportadosCache  = new Set(); // import_hash já existentes no banco para este cliente (dedup)

const GRUPO_LABEL_IMPORTACAO = {
    essencial:      '🟠 Essencial',
    estilo_de_vida: '🎯 Estilo de Vida',
    investimento:   '💰 Investimento',
    divida:         '💳 Dívida/Financiamento',
    transferencia:  '🔄 Transferência Interna',
    renda:          '📈 Renda'
};

// ══════════════════════════════════════════════════════════════
// REGRAS DE NEGÓCIO ESPECÍFICAS DO PADRÃO NUBANK
// ══════════════════════════════════════════════════════════════
/**
 * Recebe a descrição bruta de uma linha do extrato e o valor NUMÉRICO
 * COM SINAL (negativo = saída/despesa, positivo = entrada/receita) e
 * devolve como essa linha deve ser tratada, ANTES de qualquer
 * classificação por palavra-chave.
 *
 * @param {string} descricao - descrição original da linha do extrato
 * @param {number} valor - valor com sinal (negativo = despesa)
 * @returns {{ tipo: string, grupo: string|null, descricaoLimpa: string, bloquearCategoria: boolean }}
 *   tipo: 'Receita' | 'Despesa' | 'Transferência Interna'
 *   grupo: rótulo do grupo (ou null quando não é um caso especial)
 *   descricaoLimpa: descrição já sem prefixos técnicos (ex: "Compra no débito - ")
 *   bloquearCategoria: true quando o sistema já decidiu que isso NÃO é
 *     receita/despesa de verdade e a categoria deve ser preenchida
 *     automaticamente com uma de Transferência Interna, sem passar
 *     pelo classificador normal.
 */
function preClassificarTransacao(descricao, valor) {
    const desc = (descricao || '').toLowerCase();
    const tipoPorValor = valor >= 0 ? 'Receita' : 'Despesa';

    // 1) Gestão de Patrimônio (RDB / Caixinhas)
    if (desc.includes('aplicação rdb') || desc.includes('aplicacao rdb') ||
        desc.includes('resgate rdb')) {
        return {
            tipo: tipoPorValor,
            grupo: 'Transferência Interna (não conta como ganho)',
            descricaoLimpa: descricao,
            bloquearCategoria: true
        };
    }

    // 2) Gestão de Cartão de Crédito
    if (desc.includes('pagamento de fatura')) {
        return {
            tipo: 'Transferência Interna',
            grupo: 'Transferência Interna (não conta como ganho)',
            descricaoLimpa: descricao,
            bloquearCategoria: true
        };
    }

    // 3) Reembolsos e Estornos
    if (desc.includes('reembolso recebido')) {
        return {
            tipo: 'Receita',
            grupo: 'Transferência Interna (não conta como ganho)',
            descricaoLimpa: descricao,
            bloquearCategoria: true
        };
    }

    // 4) Limpeza Visual (UX)
    const prefixoCompraDebito = 'compra no débito - ';
    const prefixoCompraDebitoSemAcento = 'compra no debito - ';
    if (desc.startsWith(prefixoCompraDebito) || desc.startsWith(prefixoCompraDebitoSemAcento)) {
        const tamanhoPrefixo = desc.startsWith(prefixoCompraDebito)
            ? prefixoCompraDebito.length
            : prefixoCompraDebitoSemAcento.length;

        return {
            tipo: tipoPorValor,
            grupo: null,
            descricaoLimpa: descricao.slice(tamanhoPrefixo),
            bloquearCategoria: false
        };
    }

    // 5) Fallback (Padrão)
    return {
        tipo: tipoPorValor,
        grupo: null,
        descricaoLimpa: descricao,
        bloquearCategoria: false
    };
}

/**
 * Procura, entre as categorias JÁ CADASTRADAS (categoriasCacheImportacao),
 * uma categoria real do grupo 'transferencia' com o `tipo` pedido —
 * usada para pré-preencher automaticamente linhas que
 * preClassificarTransacao() identificou como "não é receita/despesa de
 * verdade" (RDB, fatura, reembolso). Se não existir nenhuma categoria
 * de Transferência Interna cadastrada ainda para esse tipo, retorna
 * null — a linha cai de volta no pipeline normal de classificação,
 * sem quebrar nada.
 */
function encontrarCategoriaDeTransferencia(tipo) {
    if (!categoriasCacheImportacao) return null;
    const cat = categoriasCacheImportacao.find(c => c.tipo === tipo && c.grupo === 'transferencia');
    if (!cat) return null;
    return { categoriaId: cat.id, categoriaNome: cat.nome, origem: 'pre_classificado' };
}

// ══════════════════════════════════════════════════════════════
// UTILITÁRIOS DE HASH E NORMALIZAÇÃO
// ══════════════════════════════════════════════════════════════

function hashFNV1a(texto) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < texto.length; i++) {
        hash ^= texto.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function gerarImportHashCsv(data, valorAbs, descricao) {
    const chave = `${data}|${valorAbs.toFixed(2)}|${normalizarTexto(descricao)}`;
    return `csv:${hashFNV1a(chave)}`;
}

function normalizarDataImportacao(valorBruto) {
    const v = (valorBruto || '').trim();
    if (!v) return null;

    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;

    const matchBr = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (matchBr) {
        let [, dia, mes, ano] = matchBr;
        if (ano.length === 2) ano = `20${ano}`;
        return `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
    }

    const matchOfx = v.match(/^(\d{4})(\d{2})(\d{2})/);
    if (matchOfx) {
        const [, ano, mes, dia] = matchOfx;
        return `${ano}-${mes}-${dia}`;
    }

    return null;
}

function normalizarValorImportacao(valorBruto) {
    let v = String(valorBruto ?? '').trim();
    if (!v) return NaN;

    v = v.replace(/[^\d,.\-+]/g, '');

    const temVirgula = v.includes(',');
    const temPonto   = v.includes('.');

    if (temVirgula && temPonto) {
        v = v.replace(/\./g, '').replace(',', '.');
    } else if (temVirgula && !temPonto) {
        v = v.replace(',', '.');
    }

    return parseFloat(v);
}

// ══════════════════════════════════════════════════════════════
// PARSER OFX
// ══════════════════════════════════════════════════════════════

function extrairTagOfx(bloco, tag) {
    const regex = new RegExp(`<${tag}>\\s*([^<\\r\\n]*)`, 'i');
    const match = bloco.match(regex);
    return match ? match[1].trim() : '';
}

function parsearOfx(textoOfx) {
    const blocos = textoOfx.match(/<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi) || [];

    if (!blocos.length) {
        throw new Error('Nenhuma transação encontrada no arquivo OFX (tag <STMTTRN> não localizada). Confirme se é um extrato OFX válido.');
    }

    return blocos.map(bloco => {
        const dtposted = extrairTagOfx(bloco, 'DTPOSTED');
        const trnamt   = extrairTagOfx(bloco, 'TRNAMT');
        const memo     = extrairTagOfx(bloco, 'MEMO') || extrairTagOfx(bloco, 'NAME');
        const fitid    = extrairTagOfx(bloco, 'FITID');

        const data      = normalizarDataImportacao(dtposted);
        const valorBrut = parseFloat((trnamt || '').replace(',', '.'));

        return {
            dataValida:  !!data && !isNaN(valorBrut),
            data,
            descricao:   memo || '(sem descrição)',
            valorAbs:    Math.abs(valorBrut),
            tipo:        valorBrut < 0 ? 'despesa' : 'receita',
            importHash:  fitid ? `ofx:${fitid}` : null
        };
    });
}

// ══════════════════════════════════════════════════════════════
// PARSER CSV (via PapaParse, carregado por CDN no HTML)
// ══════════════════════════════════════════════════════════════

const COLUNAS_DATA_ACEITAS      = ['data', 'date', 'dt'];
const COLUNAS_DESCRICAO_ACEITAS = ['descricao', 'descrição', 'historico', 'histórico', 'memo', 'lancamento', 'lançamento', 'title', 'description'];
const COLUNAS_VALOR_ACEITAS     = ['valor', 'amount', 'value', 'montante'];
const COLUNAS_TIPO_ACEITAS      = ['tipo', 'type'];

function encontrarColuna(headers, candidatos) {
    const headersNormalizados = headers.map(h => normalizarTexto(h));
    for (const candidato of candidatos) {
        const idx = headersNormalizados.indexOf(candidato);
        if (idx !== -1) return headers[idx];
    }
    return null;
}

function parsearCsv(textoCsv) {
    if (typeof Papa === 'undefined') {
        throw new Error('Biblioteca de leitura de CSV não carregou (PapaParse). Verifica a conexão e recarrega a página.');
    }

    const resultado = Papa.parse(textoCsv.trim(), { header: true, skipEmptyLines: true });

    if (resultado.errors?.length) {
        console.warn('⚠️ PapaParse relatou avisos:', resultado.errors);
    }

    const headers = resultado.meta?.fields || [];
    const colData      = encontrarColuna(headers, COLUNAS_DATA_ACEITAS);
    const colDescricao = encontrarColuna(headers, COLUNAS_DESCRICAO_ACEITAS);
    const colValor      = encontrarColuna(headers, COLUNAS_VALOR_ACEITAS);
    const colTipo        = encontrarColuna(headers, COLUNAS_TIPO_ACEITAS);

    if (!colData || !colDescricao || !colValor) {
        throw new Error(
            `Não reconheci as colunas do CSV. Encontrado: [${headers.join(', ')}]. ` +
            `Preciso de uma coluna de Data, uma de Descrição e uma de Valor (os nomes podem variar, ex: "Data"/"Date", "Descrição"/"Histórico", "Valor"/"Amount").`
        );
    }

    return resultado.data.map(linha => {
        const data       = normalizarDataImportacao(linha[colData]);
        const valorBruto = normalizarValorImportacao(linha[colValor]);
        const descricao  = (linha[colDescricao] || '(sem descrição)').trim();

        let tipo = valorBruto < 0 ? 'despesa' : 'receita';
        if (colTipo) {
            const tipoTexto = normalizarTexto(linha[colTipo]);
            if (tipoTexto.includes('receita') || tipoTexto.includes('credit')) tipo = 'receita';
            else if (tipoTexto.includes('despesa') || tipoTexto.includes('debit')) tipo = 'despesa';
        }

        return {
            dataValida: !!data && !isNaN(valorBruto),
            data,
            descricao,
            valorAbs:   Math.abs(valorBruto),
            tipo,
            importHash: null
        };
    });
}

// ══════════════════════════════════════════════════════════════
// CLASSIFICAÇÃO POR LINHA (regra aprendida -> sinônimo -> heurística)
// ══════════════════════════════════════════════════════════════

/**
 * Classifica uma linha já normalizada, tentando na ordem: regra
 * aprendida do cliente, palavras-chave/sinônimos cadastrados pelo
 * admin (ou nome da categoria, com distinção de confiança — ver
 * smart-input.js), depois heurística local FIXA por palavras-chave.
 * NÃO chama nenhum endpoint de rede. Retorna { categoriaId,
 * categoriaNome, origem } — categoriaId fica null se nada reconhecer a
 * descrição (precisa de seleção manual). `origem` pode ser
 * 'palavra_chave' (alta confiança) ou 'palavra_chave_aproximada'
 * (confiança por radical — ver ORIGEM_BADGE_LABEL abaixo).
 */
async function classificarLinhaImportacao(clienteId, descricao, tipoSugerido) {
    // 1) Regra aprendida — um termo aprendido vale mesmo que o sinal do
    // valor no extrato pareça contradizer (o cliente já confirmou essa
    // classificação antes).
    if (typeof RegrasAprendidasModule !== 'undefined') {
        const regra = await RegrasAprendidasModule.buscarRegra(clienteId, descricao);
        if (regra) {
            const cat = categoriasCacheImportacao.find(c => c.id === regra.categoria_id);
            if (cat) return { categoriaId: cat.id, categoriaNome: cat.nome, origem: 'aprendida', termoCorrespondente: regra.termo_busca };
        }
    }

    // 2) Palavras-chave/sinônimos cadastrados pelo admin (ou nome da
    // categoria) — plano de contas curado manualmente — só aceita se o
    // tipo bater com o sinal do valor no extrato, pela mesma razão de
    // segurança do passo 3 abaixo (nunca grava uma categoria de tipo
    // inconsistente).
    if (typeof encontrarCategoriaPorPalavraChave === 'function') {
        const catPorSinonimo = encontrarCategoriaPorPalavraChave(categoriasCacheImportacao, descricao);
        if (catPorSinonimo && catPorSinonimo.tipo === tipoSugerido) {
            const origem = catPorSinonimo._confiancaAlta === false ? 'palavra_chave_aproximada' : 'palavra_chave';
            return { categoriaId: catPorSinonimo.id, categoriaNome: catPorSinonimo.nome, origem, termoCorrespondente: catPorSinonimo._termoCorrespondente };
        }
    }

    // 3) Heurística local FIXA — só aceita o match se o tipo sugerido
    // pela regra de palavra-chave BATER com o tipo já inferido pelo
    // sinal do valor no extrato.
    if (typeof classificarLocalmente === 'function') {
        const resultadoLocal = classificarLocalmente(descricao);
        if (resultadoLocal && resultadoLocal.tipo === tipoSugerido) {
            const cat = categoriasCacheImportacao.find(c =>
                c.tipo === resultadoLocal.tipo && normalizarTexto(c.nome) === normalizarTexto(resultadoLocal.categoriaNome)
            );
            if (cat) return { categoriaId: cat.id, categoriaNome: cat.nome, origem: 'local' };
        }
    }

    // 4) Nada reconheceu (ou o tipo não batia) — precisa de seleção manual
    return { categoriaId: null, categoriaNome: null, origem: 'manual' };
}

// ══════════════════════════════════════════════════════════════
// PROCESSAMENTO DO ARQUIVO
// ══════════════════════════════════════════════════════════════

async function processarArquivoImportacao() {
    const input = document.getElementById('importFileInput');
    const arquivo = input?.files?.[0];

    if (!arquivo) {
        UIModule.showError('Escolhe um arquivo .ofx ou .csv primeiro.');
        return;
    }

    const btn = document.getElementById('btnProcessarImportacao');
    if (btn) { btn.disabled = true; btn.textContent = 'Processando...'; }

    exibirStatusImportacao('Lendo e classificando o arquivo...', false);
    esconderTabelaRevisao();

    try {
        const texto      = await arquivo.text();
        const ehOfx       = /\.ofx$|\.qbo$/i.test(arquivo.name) || /<OFX>/i.test(texto);
        const linhasBrutas = ehOfx ? parsearOfx(texto) : parsearCsv(texto);

        const linhasValidas    = linhasBrutas.filter(l => l.dataValida);
        const linhasDescartadas = linhasBrutas.length - linhasValidas.length;

        if (!linhasValidas.length) {
            exibirStatusImportacao('Nenhuma linha válida foi encontrada no arquivo (datas ou valores não reconhecidos).', true);
            return;
        }

        const clienteId = ClientModule.getClientId();
        categoriasCacheImportacao = await DatabaseModule.getCategorias();

        linhasValidas.forEach(l => {
            if (!l.importHash) l.importHash = gerarImportHashCsv(l.data, l.valorAbs, l.descricao);
        });

        const hashesDoArquivo = linhasValidas.map(l => l.importHash);
        hashesJaImportadosCache = await buscarHashesJaImportados(clienteId, hashesDoArquivo);

        linhasImportacao = [];
        let totalPreClassificadas = 0;
        let totalAproximadas      = 0;

        for (const linha of linhasValidas) {
            const duplicada = hashesJaImportadosCache.has(linha.importHash);

            // Regras de negócio específicas do padrão Nubank (RDB,
            // fatura, reembolso, "Compra no débito -") — rodam ANTES do
            // pipeline normal de classificação, porque são casos
            // especiais que não devem contar como receita/despesa de
            // verdade, ou que só precisam de uma limpeza visual na
            // descrição. Ver preClassificarTransacao() no topo do arquivo.
            const valorComSinal   = linha.tipo === 'despesa' ? -linha.valorAbs : linha.valorAbs;
            const preClassificacao = preClassificarTransacao(linha.descricao, valorComSinal);
            const descricaoFinal   = preClassificacao.descricaoLimpa || linha.descricao;

            let classificacao;
            if (duplicada) {
                classificacao = { categoriaId: null, categoriaNome: null, origem: 'duplicada' };
            } else if (preClassificacao.bloquearCategoria) {
                // Tenta achar uma categoria real de Transferência Interna
                // já cadastrada; se não existir, cai de volta no pipeline
                // normal (sem quebrar nada).
                classificacao = encontrarCategoriaDeTransferencia(linha.tipo) ||
                    await classificarLinhaImportacao(clienteId, descricaoFinal, linha.tipo);
                if (classificacao.origem === 'pre_classificado') totalPreClassificadas++;
            } else {
                classificacao = await classificarLinhaImportacao(clienteId, descricaoFinal, linha.tipo);
            }

            if (classificacao.origem === 'palavra_chave_aproximada') totalAproximadas++;

            linhasImportacao.push({
                idTemp:      (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `tmp-${Date.now()}-${Math.random()}`,
                data:        linha.data,
                descricao:   descricaoFinal,
                valor:       linha.valorAbs,
                tipo:        linha.tipo,
                categoriaId: classificacao.categoriaId,
                origem:      classificacao.origem,
                termoCorrespondente: classificacao.termoCorrespondente || null,
                importHash:  linha.importHash,
                duplicada,
                incluir:     !duplicada
            });
        }

        renderizarTabelaRevisao();

        const totalDuplicadas = linhasImportacao.filter(l => l.duplicada).length;
        let mensagem = `${linhasImportacao.length} lançamento(s) encontrado(s) e pronto(s) para revisão.`;
        if (linhasDescartadas > 0) mensagem += ` ${linhasDescartadas} linha(s) foram ignoradas por falta de data/valor reconhecíveis.`;
        if (totalPreClassificadas > 0) mensagem += ` ${totalPreClassificadas} foram pré-classificada(s) automaticamente como Transferência Interna (RDB/fatura/reembolso).`;
        if (totalAproximadas > 0) mensagem += ` ${totalAproximadas} tiveram sugestão APROXIMADA (🔎) — vale a pena conferir essas antes de confirmar.`;
        if (totalDuplicadas > 0)   mensagem += ` ${totalDuplicadas} já tinham sido importado(s) antes e vêm desmarcado(s) por padrão.`;
        exibirStatusImportacao(mensagem, false);

    } catch (err) {
        console.error('❌ processarArquivoImportacao:', err);
        exibirStatusImportacao(err.message || 'Erro ao processar o arquivo.', true);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Processar Arquivo'; }
    }
}

async function buscarHashesJaImportados(clienteId, hashes) {
    if (!hashes.length) return new Set();
    try {
        const { data, error } = await supabaseClient
            .from('transacoes')
            .select('import_hash')
            .eq('client_id', clienteId)
            .in('import_hash', hashes);
        if (error) throw error;
        return new Set((data || []).map(r => r.import_hash));
    } catch (err) {
        console.warn('⚠️ Não foi possível checar duplicados — prosseguindo sem essa checagem:', err.message);
        return new Set();
    }
}

function exibirStatusImportacao(mensagem, ehErro) {
    const el = document.getElementById('importResumoStatus');
    if (!el) return;
    el.textContent = mensagem;
    el.classList.remove('hidden');
    el.classList.toggle('import-status--error', !!ehErro);
}

function esconderTabelaRevisao() {
    document.getElementById('importReviewContainer')?.classList.add('hidden');
}

// ══════════════════════════════════════════════════════════════
// RENDERIZAÇÃO DA TABELA DE REVISÃO
// ══════════════════════════════════════════════════════════════

function montarOpcoesCategoriaImportacao(categoriaSelecionadaId) {
    const porGrupo = {};
    categoriasCacheImportacao.forEach(c => {
        const chave = `${c.tipo}__${c.grupo}`;
        if (!porGrupo[chave]) porGrupo[chave] = [];
        porGrupo[chave].push(c);
    });

    // Receita antes de despesa, mantendo os grupos dentro de cada tipo.
    const ordemGrupos = [
        'receita__renda', 'receita__transferencia',
        'despesa__essencial', 'despesa__estilo_de_vida', 'despesa__investimento',
        'despesa__divida', 'despesa__transferencia'
    ];
    const chaves = [...ordemGrupos.filter(k => porGrupo[k]), ...Object.keys(porGrupo).filter(k => !ordemGrupos.includes(k))];

    let html = '<option value="">Selecione...</option>';
    chaves.forEach(chave => {
        const [, grupo] = chave.split('__');
        const label = GRUPO_LABEL_IMPORTACAO[grupo] || grupo;
        porGrupo[chave]
            .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
            .forEach(c => {
                const selecionado = c.id === categoriaSelecionadaId ? 'selected' : '';
                html += `<option value="${c.id}" data-tipo="${c.tipo}" ${selecionado}>${label} — ${c.nome}</option>`;
            });
    });
    return html;
}

const ORIGEM_BADGE_LABEL = {
    aprendida:                { texto: '🧠 Aprendida',           classe: 'aprendida' },
    palavra_chave:             { texto: '🔑 Sinônimo',            classe: 'local'     },
    palavra_chave_aproximada: { texto: '🔎 Sugestão aproximada', classe: 'manual'    },
    local:                     { texto: '🤖 Sugerida',            classe: 'local'     },
    pre_classificado:         { texto: '🏦 Pré-classificado',    classe: 'aprendida' },
    manual:                    { texto: '✋ Manual',              classe: 'manual'    },
    duplicada:                 { texto: '⚠️ Já importada',        classe: 'duplicada' }
};

function renderizarTabelaRevisao() {
    const corpo = document.getElementById('importReviewTableBody');
    if (!corpo) return;

    corpo.innerHTML = linhasImportacao.map(linha => {
        const badge = ORIGEM_BADGE_LABEL[linha.origem] || ORIGEM_BADGE_LABEL.manual;
        const classeLinha = linha.duplicada ? 'import-row--duplicada' : '';

        // Selos com um termo/sinônimo específico por trás (Sinônimo,
        // Sugestão aproximada, Aprendida) ficam clicáveis — ao tocar,
        // mostra QUAL termo reconheceu aquela descrição. Selos sem
        // termo associado (Manual, Pré-classificado, Já importada)
        // continuam apenas informativos, sem interação.
        const temTermo = !!linha.termoCorrespondente;
        const badgeHtml = temTermo
            ? `<button type="button" class="import-review__origem-badge import-review__origem-badge--${badge.classe} import-review__origem-badge--clicavel"
                       data-termo="${escaparHtmlAtributo(linha.termoCorrespondente)}" title="Toque para ver o termo reconhecido">${badge.texto} 🛈</button>`
            : `<span class="import-review__origem-badge import-review__origem-badge--${badge.classe}">${badge.texto}</span>`;

        return `
            <tr class="${classeLinha}" data-id-temp="${linha.idTemp}">
                <td><input type="checkbox" class="import-check-incluir" ${linha.incluir ? 'checked' : ''} ${linha.duplicada ? 'disabled' : ''}></td>
                <td><input type="date" class="import-input-data" value="${linha.data}"></td>
                <td><input type="text" class="import-input-descricao import-descricao-input" value="${escaparHtmlAtributo(linha.descricao)}"></td>
                <td><input type="number" class="import-input-valor" value="${linha.valor.toFixed(2)}" step="0.01" min="0"></td>
                <td>
                    <select class="import-select-tipo">
                        <option value="receita" ${linha.tipo === 'receita' ? 'selected' : ''}>Receita</option>
                        <option value="despesa" ${linha.tipo === 'despesa' ? 'selected' : ''}>Despesa</option>
                    </select>
                </td>
                <td>
                    <select class="import-select-categoria">
                        ${montarOpcoesCategoriaImportacao(linha.categoriaId)}
                    </select>
                </td>
                <td>${badgeHtml}</td>
            </tr>
        `;
    }).join('');

    document.getElementById('importReviewContainer')?.classList.remove('hidden');
    document.getElementById('importSelecionarTodas').checked = linhasImportacao.some(l => l.incluir);

    corpo.querySelectorAll('.import-review__origem-badge--clicavel').forEach(btn => {
        btn.addEventListener('click', () => {
            const termo = btn.dataset.termo;
            if (typeof UIModule !== 'undefined' && UIModule.showMessage) {
                UIModule.showMessage(`🔑 Reconhecido pelo termo/regra: "${termo}"`, 'info', 4500);
            } else {
                alert(`Reconhecido pelo termo/regra: "${termo}"`);
            }
        });
    });

    ligarEventosLinhasImportacao();
}

function escaparHtmlAtributo(texto) {
    return (texto || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function ligarEventosLinhasImportacao() {
    document.querySelectorAll('#importReviewTableBody tr').forEach(tr => {
        const idTemp = tr.dataset.idTemp;
        const linha  = linhasImportacao.find(l => l.idTemp === idTemp);
        if (!linha) return;

        tr.querySelector('.import-check-incluir')?.addEventListener('change', (e) => {
            linha.incluir = e.target.checked;
        });
        tr.querySelector('.import-input-data')?.addEventListener('change', (e) => {
            linha.data = e.target.value;
        });
        tr.querySelector('.import-input-descricao')?.addEventListener('input', (e) => {
            linha.descricao = e.target.value;
        });
        tr.querySelector('.import-input-valor')?.addEventListener('input', (e) => {
            linha.valor = parseFloat(e.target.value) || 0;
        });
        tr.querySelector('.import-select-tipo')?.addEventListener('change', (e) => {
            linha.tipo = e.target.value;
        });
        tr.querySelector('.import-select-categoria')?.addEventListener('change', (e) => {
            linha.categoriaId = e.target.value || null;
        });
    });
}

async function atualizarCategoriasNaTabelaImportacao() {
    if (!linhasImportacao.length) return;

    categoriasCacheImportacao = await DatabaseModule.getCategorias();

    document.querySelectorAll('#importReviewTableBody tr').forEach(tr => {
        const idTemp = tr.dataset.idTemp;
        const linha  = linhasImportacao.find(l => l.idTemp === idTemp);
        if (!linha) return;

        const select = tr.querySelector('.import-select-categoria');
        if (!select) return;
        select.innerHTML = montarOpcoesCategoriaImportacao(linha.categoriaId);
    });
}

function initImportacaoExtrato() {
    document.getElementById('btnProcessarImportacao')?.addEventListener('click', processarArquivoImportacao);
    document.getElementById('btnCancelarImportacao')?.addEventListener('click', cancelarImportacao);
    document.getElementById('btnConfirmarImportacao')?.addEventListener('click', confirmarImportacao);

    document.getElementById('importSelecionarTodas')?.addEventListener('change', (e) => {
        const marcarTodas = e.target.checked;
        linhasImportacao.forEach(l => { if (!l.duplicada) l.incluir = marcarTodas; });
        document.querySelectorAll('.import-check-incluir:not(:disabled)').forEach(chk => { chk.checked = marcarTodas; });
    });
}

function cancelarImportacao() {
    linhasImportacao = [];
    hashesJaImportadosCache = new Set();
    esconderTabelaRevisao();
    document.getElementById('importResumoStatus')?.classList.add('hidden');
    const input = document.getElementById('importFileInput');
    if (input) input.value = '';
}


// ══════════════════════════════════════════════════════════════
// IMPEDIMENTOS DA IMPORTAÇÃO — aviso DENTRO do modal
// ══════════════════════════════════════════════════════════════
/**
 * O toast nasce no <body>, fora do modal, e por isso era pintado
 * ATRÁS do pop-up de importação — a mensagem que diz exatamente qual
 * linha está travando a gravação ficava ilegível. Aqui o aviso passa a
 * ser mostrado em três lugares ao mesmo tempo:
 *   1) banner fixo no topo do container de revisão (#importAvisoImpedimento);
 *   2) a própria linha da tabela destacada em vermelho;
 *   3) rolagem automática até essa linha.
 * O toast continua sendo disparado, mas já não é a única pista.
 */
function destacarImpedimentoImportacao(linha, mensagem) {
    UIModule.showError(mensagem);

    const aviso = document.getElementById('importAvisoImpedimento');
    if (aviso) {
        aviso.innerHTML = `<span class="import-aviso__icone">⛔</span>
            <span class="import-aviso__texto">${mensagem}</span>
            <button type="button" class="import-aviso__fechar" aria-label="Fechar aviso">✕</button>`;
        aviso.classList.remove('hidden');
        aviso.querySelector('.import-aviso__fechar')
            ?.addEventListener('click', limparImpedimentoImportacao);
    }

    const tr = document.querySelector(`#importReviewTableBody tr[data-id-temp="${linha?.idTemp}"]`);
    if (tr) {
        tr.classList.add('import-row--impedida');
        tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function limparImpedimentoImportacao() {
    document.getElementById('importAvisoImpedimento')?.classList.add('hidden');
    document.querySelectorAll('.import-row--impedida')
        .forEach(tr => tr.classList.remove('import-row--impedida'));
}

// ══════════════════════════════════════════════════════════════
// CONFIRMAÇÃO: SALVA NO BANCO + APRENDE AS CORREÇÕES
// ══════════════════════════════════════════════════════════════
/**
 * GARANTIA DURA antes de qualquer gravação: para CADA linha marcada
 * pra importar, exige categoria selecionada e verifica
 * `cat.tipo === linha.tipo` — se não bater, a importação inteira é
 * bloqueada com uma mensagem apontando exatamente qual linha está
 * inconsistente. Essa checagem NÃO depende de confiança de
 * classificação nenhuma; roda por igual em toda linha, tenha ela vindo
 * de uma regra aprendida, um sinônimo, uma sugestão aproximada ou uma
 * escolha 100% manual.
 */
async function confirmarImportacao() {
    const clientId = ClientModule.getClientId();
    const linhasParaSalvar = linhasImportacao.filter(l => l.incluir && !l.duplicada);

    if (!linhasParaSalvar.length) {
        UIModule.showError('Nenhuma linha selecionada para importar.');
        return;
    }

    limparImpedimentoImportacao();

    for (const linha of linhasParaSalvar) {
        if (!linha.categoriaId) {
            destacarImpedimentoImportacao(linha, `Falta escolher a categoria de "${linha.descricao}" antes de confirmar.`);
            return;
        }
        const cat = categoriasCacheImportacao.find(c => c.id === linha.categoriaId);
        if (!cat) {
            destacarImpedimentoImportacao(linha, `Categoria inválida em "${linha.descricao}". Escolha outra categoria na lista.`);
            return;
        }
        if (cat.tipo !== linha.tipo) {
            destacarImpedimentoImportacao(linha,
                `A categoria "${cat.nome}" é de ${cat.tipo}, mas a linha "${linha.descricao}" está marcada como ${linha.tipo}. ` +
                `Corrija o tipo ou troque a categoria.`);
            return;
        }
    }

    const btn = document.getElementById('btnConfirmarImportacao');
    if (btn) { btn.disabled = true; btn.textContent = 'Importando...'; }

    try {
        const payload = linhasParaSalvar.map(linha => ({
            client_id:        clientId,
            categoria_id:     linha.categoriaId,
            valor:            linha.valor,
            data_competencia: linha.data,
            descricao:        linha.descricao,
            tipo:             linha.tipo,
            origem:           'importacao',
            import_hash:      linha.importHash
        }));

        const { inseridas, duplicadasNoMomentoDeSalvar } = await salvarLoteComTratamentoDeDuplicados(payload);

        if (typeof RegrasAprendidasModule !== 'undefined') {
            for (const linha of linhasParaSalvar) {
                if (!linha.descricao?.trim()) continue;
                try {
                    await RegrasAprendidasModule.salvarOuAtualizarRegra({
                        clienteId:   clientId,
                        termoBusca:  linha.descricao,
                        categoriaId: linha.categoriaId,
                        tipo:        linha.tipo
                    });
                } catch (_) { /* falha ao aprender não deve travar a importação */ }
            }
        }

        let mensagem = `${inseridas} lançamento(s) importado(s) com sucesso!`;
        if (duplicadasNoMomentoDeSalvar > 0) {
            mensagem += ` ${duplicadasNoMomentoDeSalvar} foram ignorado(s) por já existirem (detectados só no momento de salvar).`;
        }
        UIModule.showSuccess(mensagem);

        cancelarImportacao();
        await loadClientDashboard();
    } catch (err) {
        console.error('❌ confirmarImportacao:', err);
        UIModule.showError(err.message || 'Erro ao importar os lançamentos.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '✓ Confirmar Importação'; }
    }
}

async function salvarLoteComTratamentoDeDuplicados(payload) {
    try {
        const inseridas = await DatabaseModule.addTransactionsBulk(payload);
        return { inseridas: inseridas.length, duplicadasNoMomentoDeSalvar: 0 };
    } catch (err) {
        const ehConflitoDeDuplicado = err.code === '23505' || /duplicate key|unique_import_hash/i.test(err.message || '');
        if (!ehConflitoDeDuplicado) throw err;

        console.warn('⚠️ Conflito de duplicado no lote — refazendo linha a linha.');
        let inseridas = 0;
        let duplicadas = 0;

        for (const linha of payload) {
            try {
                await DatabaseModule.addTransaction(linha);
                inseridas++;
            } catch (erroLinha) {
                const duplicada = erroLinha.code === '23505' || /duplicate key|unique_import_hash/i.test(erroLinha.message || '');
                if (duplicada) duplicadas++;
                else throw erroLinha;
            }
        }

        return { inseridas, duplicadasNoMomentoDeSalvar: duplicadas };
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initImportacaoExtrato);
} else {
    initImportacaoExtrato();
}

console.log('✅ importacao-extrato.js carregado (regras Nubank + selo de confiança alta/aproximada)');
