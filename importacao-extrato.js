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
 *        b) regras globais do admin (RegrasGlobaisModule);
 *        c) palavras-chave/sinônimos cadastrados pelo ADMIN em
 *           `categorias.palavras_chave` (encontrarCategoriaPorPalavraChave,
 *           de smart-input.js);
 *        d) classificador local por palavras-chave FIXAS
 *           (classificarLocalmente, de smart-input.js);
 *        e) se nada reconhecer, fica em aberto para seleção manual.
 *      NENHUMA chamada de rede é feita por linha nesta etapa.
 *   4. Uma tabela de revisão aparece — NADA foi salvo no banco ainda.
 *      O cliente confere/corrige cada linha (data, descrição, valor,
 *      tipo, categoria) e pode desmarcar linhas que não quer importar.
 *   5. Só ao clicar "Confirmar Importação" é que os dados são gravados
 *      (em lote, numa única chamada de rede) — e a partir daí o sistema
 *      aprende cada classificação confirmada/corrigida.
 *
 * Padrão: script global (sem import/export), igual ao resto do projeto.
 * Depende de (devem estar carregados ANTES): config.js, database.js,
 * ui.js, client.js, app.js, smart-input.js, regras-aprendidas.js, e a
 * biblioteca externa PapaParse (CDN, só usada para o parser de CSV).
 * No admin, os shims de lancamentos-admin.js fazem o papel de
 * ClientModule/DatabaseModule/UIModule.
 *
 * ATUALIZAÇÃO — TABELA DE REVISÃO REFEITA (sem rolagem lateral + busca):
 *  - CATEGORIA POR BUSCA: o <select> nativo com centenas de opções foi
 *    trocado por um campo de texto com painel de sugestões (combobox).
 *    Digite parte do nome, de um sinônimo, do código contábil ou do
 *    grupo; só aparecem categorias do MESMO TIPO da linha (receita/
 *    despesa), que é a regra que a confirmação já exigia. Navegação por
 *    teclado: ↑ ↓ Enter Esc Tab. O painel é um único elemento fixo no
 *    <body> (não é cortado pela rolagem da tabela nem do modal).
 *  - LAYOUT: cada lançamento ocupa 2 linhas (dados + categoria/origem),
 *    sem rolagem horizontal. O CSS está no bloco
 *    "IMPORTAÇÃO — layout sem rolagem horizontal" de admin.css e
 *    style.css.
 *  - Ao escolher a categoria, o selo de origem vira "Escolhida por você".
 *  - Mudar o Tipo da linha limpa a categoria se ela for do outro tipo.
 *  - Linhas ainda sem categoria ganham uma marca lateral âmbar.
 */

// ── Estado do módulo ────────────────────────────────────────────
let linhasImportacao        = [];  // linhas normalizadas + classificadas, ainda não salvas
let categoriasCacheImportacao = null; // cache local das categorias (evita refetch por linha)
let hashesJaImportadosCache  = new Set(); // import_hash já existentes no banco para este cliente (dedup)
let regrasClienteCacheImportacao = null; // Map termo → regra aprendida do cliente (1 consulta por arquivo)

const GRUPO_LABEL_IMPORTACAO = {
    essencial:      '🟠 Essencial',
    estilo_de_vida: '🎯 Estilo de Vida',
    investimento:   '💰 Investimento',
    divida:         '💳 Dívida/Financiamento',
    transferencia:  '🔄 Transferência Interna',
    renda:          '📈 Renda'
};

// Ordem dos grupos no painel de categorias (quando não há texto digitado)
const ORDEM_GRUPOS_COMBO = ['renda', 'essencial', 'estilo_de_vida', 'investimento', 'divida', 'transferencia'];

// ══════════════════════════════════════════════════════════════
// REGRAS DE NEGÓCIO ESPECÍFICAS DO PADRÃO NUBANK
// ══════════════════════════════════════════════════════════════
/**
 * @param {string} descricao - descrição original da linha do extrato
 * @param {number} valor - valor com sinal (negativo = despesa)
 * @returns {{ tipo: string, grupo: string|null, descricaoLimpa: string, bloquearCategoria: boolean }}
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
 * Procura, entre as categorias JÁ CADASTRADAS, uma categoria real do
 * grupo 'transferencia' com o `tipo` pedido. Se não existir, retorna
 * null e a linha cai no pipeline normal.
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

/**
 * Lê um arquivo como texto via FileReader — substitui File.text() para
 * compatibilidade com iOS Safari, onde esse método nativo falha dentro
 * de modais com position:fixed ou em PWA standalone.
 */
function lerArquivoComoTexto(arquivo) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = (e) => resolve(e.target.result);
        reader.onerror = ()  => reject(new Error('Não foi possível ler o arquivo. Tente novamente.'));
        reader.readAsText(arquivo, 'UTF-8');
    });
}

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
// CLASSIFICAÇÃO POR LINHA (regra aprendida -> global -> sinônimo -> heurística)
// ══════════════════════════════════════════════════════════════

/**
 * Classifica uma linha já normalizada, na ordem:
 *   1) regra aprendida do próprio cliente (só se o tipo bater);
 *   2) regra GLOBAL do admin (todos os clientes);
 *   3) sinônimos/nome da categoria (JÁ filtrados pelo tipo da linha);
 *   4) heurística local fixa;
 *   5) nada reconheceu → "pessoa" (PIX/transferência) ou "manual".
 * Nunca chuta categoria para PIX entre pessoas — o cliente escolhe.
 */
async function classificarLinhaImportacao(clienteId, descricao, tipoSugerido) {
    // 1) Regra aprendida
    let regra = null;
    if (regrasClienteCacheImportacao) {
        regra = regrasClienteCacheImportacao.get(chaveRegra(descricao))
             || regrasClienteCacheImportacao.get(normalizarTexto(descricao))
             || null;
    } else if (typeof RegrasAprendidasModule !== 'undefined') {
        regra = await RegrasAprendidasModule.buscarRegra(clienteId, descricao);
    }
    if (regra) {
        const cat = categoriasCacheImportacao.find(c => c.id === regra.categoria_id);
        if (cat && cat.tipo === tipoSugerido) {
            return { categoriaId: cat.id, categoriaNome: cat.nome, origem: 'aprendida', termoCorrespondente: regra.termo_busca };
        }
    }

    // 2) Regra global do admin
    if (typeof RegrasGlobaisModule !== 'undefined') {
        const g = await RegrasGlobaisModule.buscar(descricao, tipoSugerido, categoriasCacheImportacao);
        if (g) return { categoriaId: g.categoria.id, categoriaNome: g.categoria.nome, origem: 'global', termoCorrespondente: g.termo };
    }

    // 3) Sinônimos/nome da categoria — só categorias do MESMO tipo
    if (typeof encontrarCategoriaPorPalavraChave === 'function') {
        const catPorSinonimo = encontrarCategoriaPorPalavraChave(categoriasCacheImportacao, descricao, tipoSugerido);
        if (catPorSinonimo) {
            const origem = catPorSinonimo._confiancaAlta === false ? 'palavra_chave_aproximada' : 'palavra_chave';
            return { categoriaId: catPorSinonimo.id, categoriaNome: catPorSinonimo.nome, origem, termoCorrespondente: catPorSinonimo._termoCorrespondente };
        }
    }

    // 4) Heurística local FIXA (só aceita se o tipo bater)
    if (typeof classificarLocalmente === 'function') {
        const resultadoLocal = classificarLocalmente(descricao);
        if (resultadoLocal && resultadoLocal.tipo === tipoSugerido) {
            const cat = categoriasCacheImportacao.find(c =>
                c.tipo === resultadoLocal.tipo && normalizarTexto(c.nome) === normalizarTexto(resultadoLocal.categoriaNome)
            );
            if (cat) return { categoriaId: cat.id, categoriaNome: cat.nome, origem: 'local' };
        }
    }

    // 5) Nada reconheceu
    const ehPixOuTransferencia = /^(transferencia|pix)/.test(normalizarTexto(descricao));
    return { categoriaId: null, categoriaNome: null, origem: ehPixOuTransferencia ? 'pessoa' : 'manual' };
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
        const texto      = await lerArquivoComoTexto(arquivo);
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

        // Regras do cliente e regras globais: 1 consulta cada, não 1 por linha.
        regrasClienteCacheImportacao = (typeof RegrasAprendidasModule !== 'undefined' && RegrasAprendidasModule.listarDoCliente)
            ? await RegrasAprendidasModule.listarDoCliente(clienteId)
            : null;
        if (typeof RegrasGlobaisModule !== 'undefined') await RegrasGlobaisModule.carregar(true);

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

            // Regras Nubank (RDB, fatura, reembolso, "Compra no débito -")
            const valorComSinal   = linha.tipo === 'despesa' ? -linha.valorAbs : linha.valorAbs;
            const preClassificacao = preClassificarTransacao(linha.descricao, valorComSinal);
            const descricaoFinal   = preClassificacao.descricaoLimpa || linha.descricao;

            let classificacao;
            if (duplicada) {
                classificacao = { categoriaId: null, categoriaNome: null, origem: 'duplicada' };
            } else if (preClassificacao.bloquearCategoria) {
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
                incluir:     !duplicada,
                // Só vira regra aprendida o que o USUÁRIO escolheu/corrigiu na tabela —
                // aceitar uma sugestão automática não ensina nada ao sistema.
                decididaPeloUsuario: false
            });
        }

        renderizarTabelaRevisao();

        const totalDuplicadas = linhasImportacao.filter(l => l.duplicada).length;
        const totalSemCategoria = linhasImportacao.filter(l => !l.duplicada && !l.categoriaId).length;
        let mensagem = `${linhasImportacao.length} lançamento(s) encontrado(s) e pronto(s) para revisão.`;
        if (linhasDescartadas > 0) mensagem += ` ${linhasDescartadas} linha(s) foram ignoradas por falta de data/valor reconhecíveis.`;
        if (totalPreClassificadas > 0) mensagem += ` ${totalPreClassificadas} foram pré-classificada(s) automaticamente como Transferência Interna (RDB/fatura/reembolso).`;
        const totalPessoas = linhasImportacao.filter(l => l.origem === 'pessoa').length;
        if (totalPessoas > 0) mensagem += ` ${totalPessoas} são transferências/PIX para pessoas — escolha a categoria de cada uma (👤).`;
        if (totalAproximadas > 0) mensagem += ` ${totalAproximadas} tiveram sugestão APROXIMADA (🔎) — vale a pena conferir essas antes de confirmar.`;
        if (totalDuplicadas > 0)   mensagem += ` ${totalDuplicadas} já tinham sido importado(s) antes e vêm desmarcado(s) por padrão.`;
        if (totalSemCategoria > 0) mensagem += ` ${totalSemCategoria} ainda estão sem categoria (marcadas com uma barra âmbar) — clique no campo Categoria e digite para buscar.`;
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
// CATEGORIA POR BUSCA (combobox) — substitui o <select> gigante
// ══════════════════════════════════════════════════════════════

let catComboAtivo = null; // { input, linha, itens: [categorias exibidas], indice, termo }

/** Índice de busca (normalizado) guardado na própria categoria — calculado 1 vez. */
function indiceBuscaCategoria(c) {
    if (!c._idx) {
        c._idx = {
            nome:  normalizarTexto(c.nome),
            chaves: normalizarTexto(Array.isArray(c.palavras_chave) ? c.palavras_chave.join(' ') : ''),
            extra: normalizarTexto(`${c.codigo_contabil || ''} ${(c.grupo || '').replace(/_/g, ' ')}`)
        };
    }
    return c._idx;
}

/** 0 = não bate; maior = mais relevante. Todas as palavras digitadas precisam bater. */
function pontuarCategoria(c, palavras) {
    const idx = indiceBuscaCategoria(c);
    let total = 0;
    for (const p of palavras) {
        let s = 0;
        if (idx.nome.startsWith(p))                              s = 100;
        else if (idx.nome.split(' ').some(w => w.startsWith(p))) s = 80;
        else if (idx.nome.includes(p))                           s = 60;
        else if (idx.chaves.includes(p))                         s = 30;
        else if (idx.extra.includes(p))                          s = 10;
        if (!s) return 0;
        total += s;
    }
    return total;
}

function ordenarCategoriasPorGrupo(cats) {
    const pos = (g) => { const i = ORDEM_GRUPOS_COMBO.indexOf(g); return i === -1 ? 99 : i; };
    return [...cats].sort((a, b) => (pos(a.grupo) - pos(b.grupo)) || a.nome.localeCompare(b.nome, 'pt-BR'));
}

function nomeDaCategoria(id) {
    return (categoriasCacheImportacao || []).find(c => c.id === id)?.nome || '';
}

function textoSimples(t) {
    return String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function obterPainelCategoria() {
    let painel = document.getElementById('catComboPanel');
    if (!painel) {
        painel = document.createElement('div');
        painel.id = 'catComboPanel';
        painel.className = 'cat-panel hidden';
        painel.setAttribute('role', 'listbox');
        // mousedown (e não click) + preventDefault: o campo não perde o foco
        // antes da escolha ser registrada.
        painel.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const item = e.target.closest('.cat-panel__item');
            if (item) selecionarCategoriaPorId(item.dataset.id);
        });
        document.body.appendChild(painel);
    }
    return painel;
}

function renderizarPainelCategoria(termo) {
    if (!catComboAtivo) return;
    const { linha } = catComboAtivo;
    const painel = obterPainelCategoria();

    const doTipo   = (categoriasCacheImportacao || []).filter(c => c.tipo === linha.tipo);
    const palavras = normalizarTexto(termo).split(/\s+/).filter(Boolean);

    let itens;
    if (!palavras.length) {
        itens = ordenarCategoriasPorGrupo(doTipo);
    } else {
        itens = doTipo
            .map(c => ({ c, s: pontuarCategoria(c, palavras) }))
            .filter(x => x.s > 0)
            .sort((a, b) => (b.s - a.s) || a.c.nome.localeCompare(b.c.nome, 'pt-BR'))
            .map(x => x.c)
            .slice(0, 60);
    }

    catComboAtivo.itens = itens;
    catComboAtivo.termo = termo;

    const indiceSelecionada = itens.findIndex(c => c.id === linha.categoriaId);
    catComboAtivo.indice = (!palavras.length && indiceSelecionada >= 0) ? indiceSelecionada : 0;

    if (!itens.length) {
        painel.innerHTML = `<p class="cat-panel__vazio">Nenhuma categoria de <strong>${linha.tipo}</strong> encontrada para “${textoSimples(termo)}”.<br>Se for de outro tipo, mude o campo <strong>Tipo</strong> da linha.</p>`;
        return;
    }

    let html = '';
    let grupoAnterior = null;
    itens.forEach((c, i) => {
        if (!palavras.length && c.grupo !== grupoAnterior) {
            html += `<div class="cat-panel__grupo">${textoSimples(GRUPO_LABEL_IMPORTACAO[c.grupo] || c.grupo || 'Outras')}</div>`;
            grupoAnterior = c.grupo;
        }
        const classes = ['cat-panel__item'];
        if (i === catComboAtivo.indice) classes.push('ativo');
        if (c.id === linha.categoriaId)  classes.push('selecionada');
        html += `<div class="${classes.join(' ')}" role="option" data-id="${c.id}" data-i="${i}">
            ${c.codigo_contabil ? `<span class="cat-panel__cod">${textoSimples(c.codigo_contabil)}</span>` : ''}
            <span class="cat-panel__nome">${textoSimples(c.nome)}</span>
            ${palavras.length ? `<span class="cat-panel__tag">${textoSimples(GRUPO_LABEL_IMPORTACAO[c.grupo] || '')}</span>` : ''}
        </div>`;
    });
    painel.innerHTML = html;

    painel.querySelector('.cat-panel__item.ativo')?.scrollIntoView({ block: 'nearest' });
}

function posicionarPainelCategoria() {
    if (!catComboAtivo) return;
    const painel = obterPainelCategoria();
    const rect   = catComboAtivo.input.getBoundingClientRect();
    const alturaJanela  = window.visualViewport?.height ?? window.innerHeight;
    const larguraJanela = window.innerWidth;

    const abaixo = alturaJanela - rect.bottom - 10;
    const acima  = rect.top - 10;
    const subir  = abaixo < 200 && acima > abaixo;
    const largura = Math.min(Math.max(rect.width, 300), larguraJanela - 16);
    const left    = Math.max(8, Math.min(rect.left, larguraJanela - largura - 8));

    painel.style.left      = `${left}px`;
    painel.style.width     = `${largura}px`;
    painel.style.maxHeight = `${Math.max(120, Math.min(300, subir ? acima : abaixo))}px`;

    if (subir) {
        painel.style.top    = 'auto';
        painel.style.bottom = `${alturaJanela - rect.top + 4}px`;
    } else {
        painel.style.bottom = 'auto';
        painel.style.top    = `${rect.bottom + 4}px`;
    }
}

function abrirPainelCategoria(input, linha, termo) {
    catComboAtivo = { input, linha, itens: [], indice: 0, termo: '' };
    renderizarPainelCategoria(termo);
    posicionarPainelCategoria();
    obterPainelCategoria().classList.remove('hidden');
}

/** Fecha o painel e devolve ao campo o nome da categoria realmente escolhida. */
function fecharPainelCategoria() {
    document.getElementById('catComboPanel')?.classList.add('hidden');
    if (catComboAtivo) {
        const { input, linha } = catComboAtivo;
        input.value = nomeDaCategoria(linha.categoriaId);
        catComboAtivo = null;
    }
}

function destacarItemPainel(novoIndice) {
    if (!catComboAtivo || !catComboAtivo.itens.length) return;
    const total = catComboAtivo.itens.length;
    catComboAtivo.indice = Math.max(0, Math.min(total - 1, novoIndice));
    const painel = obterPainelCategoria();
    painel.querySelectorAll('.cat-panel__item.ativo').forEach(el => el.classList.remove('ativo'));
    const alvo = painel.querySelector(`.cat-panel__item[data-i="${catComboAtivo.indice}"]`);
    if (alvo) { alvo.classList.add('ativo'); alvo.scrollIntoView({ block: 'nearest' }); }
}

function selecionarCategoriaPorId(categoriaId) {
    if (!catComboAtivo) return;
    const cat = (categoriasCacheImportacao || []).find(c => c.id === categoriaId);
    if (!cat) return;

    const { input, linha } = catComboAtivo;
    linha.categoriaId = cat.id;
    linha.decididaPeloUsuario = true;
    if (!linha.duplicada) {
        linha.origem = 'usuario';
        linha.termoCorrespondente = null;
    }

    fecharPainelCategoria();      // sincroniza o texto do campo com a escolha
    input.value = cat.nome;
    atualizarEstadoLinhaDom(input.closest('tr'), linha);
}

function limparCategoriaDaLinha(linha, tr) {
    linha.categoriaId = null;
    linha.decididaPeloUsuario = false;
    if (!linha.duplicada) {
        linha.origem = 'manual';
        linha.termoCorrespondente = null;
    }
    const input = tr?.querySelector('.cat-combo__input');
    if (input) input.value = '';
    atualizarEstadoLinhaDom(tr, linha);
}

function tratarTecladoCombo(e, input, linha) {
    const aberto = !!catComboAtivo && catComboAtivo.input === input;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!aberto) abrirPainelCategoria(input, linha, '');
        else destacarItemPainel(catComboAtivo.indice + 1);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (aberto) destacarItemPainel(catComboAtivo.indice - 1);
    } else if (e.key === 'Enter') {
        if (aberto && catComboAtivo.itens[catComboAtivo.indice]) {
            e.preventDefault();
            selecionarCategoriaPorId(catComboAtivo.itens[catComboAtivo.indice].id);
        } else if (aberto) {
            e.preventDefault();
        }
    } else if (e.key === 'Escape') {
        if (aberto) { e.preventDefault(); e.stopPropagation(); fecharPainelCategoria(); }
    } else if (e.key === 'Tab') {
        // Digitou algo e apertou Tab: confirma a opção destacada (fluxo rápido).
        if (aberto && catComboAtivo.termo.trim() && catComboAtivo.itens[catComboAtivo.indice]) {
            selecionarCategoriaPorId(catComboAtivo.itens[catComboAtivo.indice].id);
        }
    }
}

function ligarComboCategoria(tr, linha) {
    const input  = tr.querySelector('.cat-combo__input');
    const limpar = tr.querySelector('.cat-combo__limpar');
    if (!input) return;

    input.addEventListener('focus', () => {
        input.select();
        abrirPainelCategoria(input, linha, '');
    });
    input.addEventListener('input', () => {
        if (!catComboAtivo || catComboAtivo.input !== input) abrirPainelCategoria(input, linha, input.value);
        else { renderizarPainelCategoria(input.value); posicionarPainelCategoria(); }
        obterPainelCategoria().classList.remove('hidden');
    });
    input.addEventListener('keydown', (e) => tratarTecladoCombo(e, input, linha));
    input.addEventListener('blur', () => {
        setTimeout(() => { if (catComboAtivo && catComboAtivo.input === input) fecharPainelCategoria(); }, 120);
    });

    limpar?.addEventListener('mousedown', (e) => e.preventDefault());
    limpar?.addEventListener('click', () => {
        limparCategoriaDaLinha(linha, tr);
        input.focus();
    });
}

function initPainelCategoria() {
    // Rolagem de qualquer container (tabela, modal, página): reposiciona o
    // painel junto do campo, ou fecha se o campo saiu da tela.
    document.addEventListener('scroll', (e) => {
        if (!catComboAtivo) return;
        const painel = document.getElementById('catComboPanel');
        if (painel && painel.contains(e.target)) return;
        const r = catComboAtivo.input.getBoundingClientRect();
        const alturaJanela = window.visualViewport?.height ?? window.innerHeight;
        if (r.bottom < 0 || r.top > alturaJanela) fecharPainelCategoria();
        else posicionarPainelCategoria();
    }, true);

    window.addEventListener('resize', () => { if (catComboAtivo) posicionarPainelCategoria(); });
}

// ══════════════════════════════════════════════════════════════
// RENDERIZAÇÃO DA TABELA DE REVISÃO
// ══════════════════════════════════════════════════════════════

const ORIGEM_BADGE_LABEL = {
    aprendida:                { texto: '🧠 Aprendida',           classe: 'aprendida' },
    palavra_chave:             { texto: '🔑 Sinônimo',            classe: 'local'     },
    palavra_chave_aproximada: { texto: '🔎 Sugestão aproximada', classe: 'manual'    },
    global:                    { texto: '🌐 Regra global',        classe: 'aprendida' },
    pessoa:                    { texto: '👤 Escolha a categoria', classe: 'manual'    },
    local:                     { texto: '🤖 Sugerida',            classe: 'local'     },
    pre_classificado:         { texto: '🏦 Pré-classificado',    classe: 'aprendida' },
    usuario:                   { texto: '✅ Escolhida por você',  classe: 'aprendida' },
    manual:                    { texto: '✋ Manual',              classe: 'manual'    },
    duplicada:                 { texto: '⚠️ Já importada',        classe: 'duplicada' }
};

/**
 * Selos com um termo/sinônimo específico por trás (Sinônimo, Sugestão
 * aproximada, Aprendida, Regra global) ficam clicáveis — ao tocar,
 * mostram QUAL termo reconheceu a descrição.
 */
function montarBadgeOrigemHtml(linha) {
    const badge = ORIGEM_BADGE_LABEL[linha.origem] || ORIGEM_BADGE_LABEL.manual;
    if (linha.termoCorrespondente) {
        return `<button type="button" class="import-review__origem-badge import-review__origem-badge--${badge.classe} import-review__origem-badge--clicavel"
                       data-termo="${escaparHtmlAtributo(linha.termoCorrespondente)}" title="Toque para ver o termo reconhecido">${badge.texto} 🛈</button>`;
    }
    return `<span class="import-review__origem-badge import-review__origem-badge--${badge.classe}">${badge.texto}</span>`;
}

function montarComboCategoriaHtml(linha) {
    return `
        <div class="cat-combo">
            <input type="text" class="cat-combo__input import-input-categoria"
                   value="${escaparHtmlAtributo(nomeDaCategoria(linha.categoriaId))}"
                   placeholder="🔎 Digite para buscar a categoria..."
                   autocomplete="off" spellcheck="false" ${linha.duplicada ? 'disabled' : ''}>
            <button type="button" class="cat-combo__limpar" title="Limpar categoria" aria-label="Limpar categoria" tabindex="-1" ${linha.duplicada ? 'disabled' : ''}>✕</button>
        </div>`;
}

/** Atualiza só o que depende da categoria: marca âmbar e selo de origem. */
function atualizarEstadoLinhaDom(tr, linha) {
    if (!tr) return;
    tr.classList.toggle('import-row--sem-categoria', !linha.duplicada && !linha.categoriaId);
    const celulaOrigem = tr.querySelector('.imp-c-origem');
    if (celulaOrigem) celulaOrigem.innerHTML = montarBadgeOrigemHtml(linha);
}

function renderizarTabelaRevisao() {
    const corpo = document.getElementById('importReviewTableBody');
    if (!corpo) return;

    fecharPainelCategoria();

    corpo.innerHTML = linhasImportacao.map(linha => {
        const classes = [];
        if (linha.duplicada) classes.push('import-row--duplicada');
        if (!linha.duplicada && !linha.categoriaId) classes.push('import-row--sem-categoria');

        return `
            <tr class="${classes.join(' ')}" data-id-temp="${linha.idTemp}">
                <td class="imp-c imp-c-check"><input type="checkbox" class="import-check-incluir" ${linha.incluir ? 'checked' : ''} ${linha.duplicada ? 'disabled' : ''}></td>
                <td class="imp-c imp-c-data"><input type="date" class="import-input-data" value="${linha.data}"></td>
                <td class="imp-c imp-c-desc"><input type="text" class="import-input-descricao import-descricao-input" value="${escaparHtmlAtributo(linha.descricao)}" title="${escaparHtmlAtributo(linha.descricao)}"></td>
                <td class="imp-c imp-c-valor"><input type="number" class="import-input-valor" value="${linha.valor.toFixed(2)}" step="0.01" min="0"></td>
                <td class="imp-c imp-c-tipo">
                    <select class="import-select-tipo">
                        <option value="receita" ${linha.tipo === 'receita' ? 'selected' : ''}>Receita</option>
                        <option value="despesa" ${linha.tipo === 'despesa' ? 'selected' : ''}>Despesa</option>
                    </select>
                </td>
                <td class="imp-c imp-c-cat">${montarComboCategoriaHtml(linha)}</td>
                <td class="imp-c imp-c-origem">${montarBadgeOrigemHtml(linha)}</td>
            </tr>
        `;
    }).join('');

    document.getElementById('importReviewContainer')?.classList.remove('hidden');
    document.getElementById('importSelecionarTodas').checked = linhasImportacao.some(l => l.incluir);

    // Delegação única para os selos clicáveis (o selo é redesenhado ao escolher categoria)
    if (!corpo._badgeLigado) {
        corpo._badgeLigado = true;
        corpo.addEventListener('click', (e) => {
            const btn = e.target.closest('.import-review__origem-badge--clicavel');
            if (!btn) return;
            const termo = btn.dataset.termo;
            if (typeof UIModule !== 'undefined' && UIModule.showMessage) {
                UIModule.showMessage(`🔑 Reconhecido pelo termo/regra: "${termo}"`, 'info', 4500);
            } else {
                alert(`Reconhecido pelo termo/regra: "${termo}"`);
            }
        });
    }

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

            // Categoria do outro tipo não vale mais — limpa em vez de travar depois.
            const cat = (categoriasCacheImportacao || []).find(c => c.id === linha.categoriaId);
            if (cat && cat.tipo !== linha.tipo) {
                limparCategoriaDaLinha(linha, tr);
                if (typeof UIModule !== 'undefined' && UIModule.showMessage) {
                    UIModule.showMessage(`Categoria "${cat.nome}" removida: ela é de ${cat.tipo}. Escolha uma categoria de ${linha.tipo}.`, 'info', 4000);
                }
            }
        });

        ligarComboCategoria(tr, linha);
    });
}

/**
 * Chamada depois que o cliente cria uma categoria nova (ver
 * categoria-personalizada.js): recarrega a lista e mantém o texto dos
 * campos de categoria coerente. A nova categoria já aparece nas buscas.
 */
async function atualizarCategoriasNaTabelaImportacao() {
    if (!linhasImportacao.length) return;

    categoriasCacheImportacao = await DatabaseModule.getCategorias();

    document.querySelectorAll('#importReviewTableBody tr').forEach(tr => {
        const linha = linhasImportacao.find(l => l.idTemp === tr.dataset.idTemp);
        const input = tr.querySelector('.cat-combo__input');
        if (linha && input && document.activeElement !== input) {
            input.value = nomeDaCategoria(linha.categoriaId);
        }
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

    initPainelCategoria();
}

function cancelarImportacao() {
    fecharPainelCategoria();
    linhasImportacao = [];
    hashesJaImportadosCache = new Set();
    regrasClienteCacheImportacao = null;
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
 * ATRÁS do pop-up de importação. Aqui o aviso é mostrado em três
 * lugares ao mesmo tempo:
 *   1) banner fixo no topo do container de revisão (#importAvisoImpedimento);
 *   2) a própria linha da tabela destacada em vermelho;
 *   3) rolagem automática até essa linha.
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
 * inconsistente.
 */
async function confirmarImportacao() {
    const clientId = ClientModule.getClientId();
    const linhasParaSalvar = linhasImportacao.filter(l => l.incluir && !l.duplicada);

    if (!linhasParaSalvar.length) {
        UIModule.showError('Nenhuma linha selecionada para importar.');
        return;
    }

    limparImpedimentoImportacao();
    fecharPainelCategoria();

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
        // Carteira de destino do extrato (seletor #importCarteira existe só no painel do
        // cliente e só aparece com 2+ carteiras). Sem ele — ex.: admin — o banco usa a principal.
        const carteiraId = document.getElementById('importCarteira')?.value || null;

        const payload = linhasParaSalvar.map(linha => ({
            client_id:        clientId,
            categoria_id:     linha.categoriaId,
            valor:            linha.valor,
            data_competencia: linha.data,
            descricao:        linha.descricao,
            tipo:             linha.tipo,
            origem:           'importacao',
            import_hash:      linha.importHash,
            ...(carteiraId ? { carteira_id: carteiraId } : {})
        }));

        const { inseridas, duplicadasNoMomentoDeSalvar } = await salvarLoteComTratamentoDeDuplicados(payload);

        if (typeof RegrasAprendidasModule !== 'undefined') {
            for (const linha of linhasParaSalvar) {
                if (!linha.decididaPeloUsuario) continue; // aceitou sugestão: não ensina
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

console.log('✅ importacao-extrato.js carregado (categoria por busca + layout sem rolagem lateral)');
