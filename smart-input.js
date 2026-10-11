
// ══════════════════════════════════════════════════════════════
// ESTADO DO FORMULÁRIO
// ══════════════════════════════════════════════════════════════
const TransactionFormState = {
    data:          null, // 'YYYY-MM-DD'
    descricao:     '',
    tipo:          null, // 'receita' | 'despesa'
    categoriaId:   null,
    categoriaNome: null
};

function resetTransactionFormState() {
    TransactionFormState.data          = null;
    TransactionFormState.descricao     = '';
    TransactionFormState.tipo          = null;
    TransactionFormState.categoriaId   = null;
    TransactionFormState.categoriaNome = null;
}

// ── Estado interno do módulo (cache/controle de chamadas) ──────
let smartInputCategoriasCache = null; // cache local das categorias (evita refetch a cada blur)
let smartInputUltimaDescricao = null; // evita reclassificar o mesmo texto repetidamente
let smartInputPromisePendente = null; // permite ao handleAddTransaction esperar uma classificação em andamento

const GRUPOS_VALIDOS = ['essencial', 'estilo_de_vida', 'investimento', 'renda'];

// Tamanho mínimo de palavra para entrar na regra de match por RADICAL
// (evita falso positivo tipo "carro" casando com "carta" só porque os
// 3 primeiros caracteres batem — com um piso de 5 caracteres, o
// radical comparado já carrega significado suficiente).
const RADICAL_MIN_LEN = 5;

// ── Utilitários de texto (comparação tolerante a acento/caixa) ─
function normalizarTexto(txt) {
    return (txt || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

/**
 * Compara dois textos já normalizados e devolve { match, confiancaAlta }:
 *   - match=true, confiancaAlta=true  → um é substring do outro
 *     (correspondência exata de texto — o nível de certeza mais alto).
 *   - match=true, confiancaAlta=false → só bateram os primeiros
 *     RADICAL_MIN_LEN caracteres (raiz comum) — ex: "cabelo" vs
 *     "cabeleireiro".
 *   - match=false → nenhuma correspondência.
 */
function avaliarCorrespondencia(a, b) {
    if (!a || !b) return { match: false, confiancaAlta: false };
    if (a.includes(b) || b.includes(a)) return { match: true, confiancaAlta: true };

    const menorTamanho = Math.min(a.length, b.length);
    if (menorTamanho < RADICAL_MIN_LEN) return { match: false, confiancaAlta: false };

    const radicalBate = a.slice(0, RADICAL_MIN_LEN) === b.slice(0, RADICAL_MIN_LEN);
    return { match: radicalBate, confiancaAlta: false };
}

// Wrapper booleano simples — usado onde só interessa saber SE bateu,
// sem precisar do nível de confiança (ex: encontrarCategoriaCorrespondente).
function textoContemOuEhContido(a, b) {
    return avaliarCorrespondencia(a, b).match;
}

// ══════════════════════════════════════════════════════════════
// MATCH SEGURO — palavra inteira, só o favorecido, sem radical
// ══════════════════════════════════════════════════════════════
/**
 * CAUSA RAIZ DO "TUDO VIRA TRANSPORTE": avaliarCorrespondencia() comparava
 * os 5 primeiros caracteres da DESCRIÇÃO INTEIRA com os do termo. Toda
 * linha do Nubank começa com "Transferência…" ("trans") e a categoria
 * "Transporte" também — então tudo era sugerido como Transporte. Também
 * casava "99" dentro de CPF/CNPJ, "bar" dentro de "Barbosa", "pai" dentro
 * de "Paiva" e "mercado" dentro de "MERCADO PAGO" (o banco).
 *
 * Agora: (1) o texto comparado é só o FAVORECIDO (sem "Transferência
 * enviada pelo Pix", sem CPF/CNPJ, sem banco/agência/conta); (2) o termo
 * precisa aparecer como PALAVRA INTEIRA (aceita plural s/es em termos de
 * 4+ letras); (3) não existe mais match por radical.
 */
const PREFIXO_BANCARIO_COMPLETO = /^(transferencia( enviada| recebida)?( pelo pix| via pix| pix)?|pix( enviado| recebido)?|compra (no|com) (debito|credito)|pagamento( de)?( fatura| boleto| conta)?|debito automatico|deposito|saque)$/;
const PREFIXO_BANCARIO_INICIO   = /^(transferencia( enviada| recebida)?( pelo pix| via pix| pix)?|pix( enviado| recebido)?|compra (no|com) (debito|credito))\s+/;

/** "Transferência enviada pelo Pix - NOME - •••.123.456-•• - BANCO (0001) Agência…" → "NOME" */
function extrairFavorecido(descricao) {
    const original = String(descricao || '').trim();
    if (!original) return '';

    const partes = original.split(/\s+-\s+/).map(p => p.trim()).filter(Boolean);
    const ehDocumento = (p) => /•{2,}|\*{3,}/.test(p) || /\d{3}\.\d{3}\.\d{3}-\d{2}/.test(p) || /\d{2}\.\d{3}\.\d{3}\/\d{4}/.test(p) || /^[\d.\-\/\s]+$/.test(p);
    const ehBanco     = (p) => /ag[eê]ncia|conta:|\(\d{4}\)/i.test(p);

    if (partes.length > 1) {
        const mantidas = [];
        for (const parte of partes) {
            if (ehDocumento(parte) || ehBanco(parte)) {
                if (mantidas.length) break;
                continue;
            }
            if (!mantidas.length && PREFIXO_BANCARIO_COMPLETO.test(normalizarTexto(parte))) continue;
            mantidas.push(parte);
        }
        if (mantidas.length) return mantidas.join(' ');
    }

    return normalizarTexto(original).replace(PREFIXO_BANCARIO_INICIO, '');
}

/** Texto limpo e normalizado usado em TODA comparação (sem números longos/documentos). */
function textoParaMatch(descricao) {
    return normalizarTexto(extrairFavorecido(descricao))
        .replace(/[•*]+/g, ' ')
        .replace(/\d[\d.,\-\/]{2,}\d/g, ' ')
        .replace(/\b\d{3,}\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Chave estável de uma regra aprendida: o favorecido, não a descrição inteira. */
function chaveRegra(descricao) {
    const t = textoParaMatch(descricao).slice(0, 60).trim();
    return t || normalizarTexto(descricao).slice(0, 60);
}

function escaparRegex(txt) {
    return String(txt).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** O termo aparece como palavra inteira no texto? (plural s/es aceito em termos de 4+ letras) */
function palavraInteira(texto, termo) {
    if (!texto || !termo) return false;
    const sufixo = termo.length >= 4 ? '(?:s|es)?' : '';
    return new RegExp('(?:^|[^a-z0-9])' + escaparRegex(termo) + sufixo + '(?![a-z0-9])').test(texto);
}

/**
 * Avalia um termo (sinônimo/nome) contra o texto já limpo.
 *  - confiancaAlta=true : termo é palavra inteira dentro do texto.
 *  - confiancaAlta=false: o texto digitado é parte inteira do termo
 *    (ex: digitou "aluguel", termo "aluguel ganho") — só sugestão.
 */
function avaliarTermoNoTexto(texto, termoBruto) {
    const termo = normalizarTexto(termoBruto).replace(/\s+/g, ' ');
    if (!termo) return { match: false, confiancaAlta: false };
    const numerico = /^\d+$/.test(termo);
    if (termo.length < (numerico ? 2 : 3)) return { match: false, confiancaAlta: false };

    if (palavraInteira(texto, termo)) return { match: true, confiancaAlta: true };
    if (texto.length >= 4 && palavraInteira(termo, texto)) return { match: true, confiancaAlta: false };
    return { match: false, confiancaAlta: false };
}

// Heurística local: acrescenta borda de palavra à esquerda em cada regra
// (impede "luz" dentro de "Luzia", "curso" dentro de "recurso" etc.).
const _cacheRegexBorda = new Map();
function regexComBordaEsquerda(regex) {
    let r = _cacheRegexBorda.get(regex);
    if (!r) {
        r = new RegExp('(?:^|[^a-z0-9])(?:' + regex.source + ')', 'i');
        _cacheRegexBorda.set(regex, r);
    }
    return r;
}

// ══════════════════════════════════════════════════════════════
// GRUPOS SEMÂNTICOS — VÁRIOS TERMOS DIFERENTES, UMA SÓ CATEGORIA
// ══════════════════════════════════════════════════════════════
/**
 * Resolve o caso de itens que são conceitualmente a mesma coisa mas
 * não compartilham NENHUM texto em comum (ex: "Celular" e
 * "Smartwatch"). Cada grupo tem um nome de categoria CANÔNICO/
 * "guarda-chuva" e uma lista de termos que pertencem a ele. Quando a
 * descrição bate com um desses termos, o sistema procura se já existe
 * uma categoria REAL cadastrada com esse nome canônico (ou algo bem
 * parecido, via substring) e usa ela — nunca inventa nada.
 *
 * Os nomes canônicos abaixo foram escolhidos pra baterem (por
 * substring) com os nomes reais já cadastrados no banco a partir do
 * plano de contas aplicado — ver nota completa no cabeçalho do
 * arquivo.
 */
const GRUPOS_SEMANTICOS_CATEGORIA = [
    {
        categoria: 'Eletrônicos',
        tipo: 'despesa',
        grupo: 'estilo_de_vida',
        termos: [
            'celular', 'smartphone', 'smartwatch', 'relogio inteligente',
            'fone de ouvido', 'fone bluetooth', 'fone sem fio', 'headset',
            'notebook', 'laptop', 'computador', 'tablet', 'ipad',
            'impressora', 'caixa de som', 'caixa de som portatil',
            'video game', 'videogame', 'console', 'carregador',
            'mouse', 'teclado', 'monitor', 'hd externo', 'pendrive'
        ]
    },
    {
        categoria: 'Beleza e Estética',
        tipo: 'despesa',
        grupo: 'estilo_de_vida',
        termos: [
            'manicure', 'pedicure', 'unha', 'maquiagem', 'sobrancelha',
            'depilacao', 'estetica', 'spa', 'massagem', 'salao de beleza',
            'cilios', 'design de sobrancelha', 'skincare', 'cosmetico'
        ]
    },
    {
        categoria: 'Roupas e Calçados',
        tipo: 'despesa',
        grupo: 'estilo_de_vida',
        termos: [
            'roupa', 'sapato', 'tenis', 'calcado', 'vestido', 'camisa',
            'camiseta', 'calca', 'jaqueta', 'casaco', 'bolsa', 'mochila',
            'mala de viagem', 'cinto', 'meia', 'sunga', 'biquini'
        ]
    },
    {
        categoria: 'Manutenção Preventiva do Veículo',
        tipo: 'despesa',
        grupo: 'essencial',
        termos: [
            'oficina', 'mecanico', 'revisao do carro', 'troca de oleo',
            'pneu', 'alinhamento', 'balanceamento', 'bateria do carro'
        ]
    }
];

/**
 * Procura, na lista curada acima, um grupo semântico cujo termo bata
 * com o texto digitado (substring bidirecional simples — aqui não
 * precisa de radical, porque os termos já são curados e específicos o
 * bastante pra não gerar falso positivo). Retorna o grupo inteiro
 * ({ categoria, tipo, grupo, termos }) ou null.
 */
function encontrarGrupoSemantico(texto) {
    const alvo = textoParaMatch(texto);
    if (!alvo) return null;

    for (const grupoSemantico of GRUPOS_SEMANTICOS_CATEGORIA) {
        const bateu = grupoSemantico.termos.some(termo => palavraInteira(alvo, normalizarTexto(termo)));
        if (bateu) return grupoSemantico;
    }

    return null;
}

// ══════════════════════════════════════════════════════════════
// PLANO DE CONTAS ROBUSTO — MATCH POR PALAVRA-CHAVE/SINÔNIMO
// ══════════════════════════════════════════════════════════════
/**
 * Procura, dentre as categorias REAIS já cadastradas, alguma que
 * reconheça a descrição digitada, em 3 passadas (da mais pra menos
 * confiável):
 *   1. Sinônimo cadastrado pelo admin em `palavras_chave`.
 *   2. Nome da própria categoria.
 *   3. Grupo semântico curado (GRUPOS_SEMANTICOS_CATEGORIA).
 *
 * Retorna a categoria encontrada com um campo extra `_confiancaAlta`.
 * Retorna null se nada bater em nenhuma das 3 passadas.
 */
/**
 * ⚠️ ATUALIZAÇÃO — TRANSPARÊNCIA DO MATCH: além da categoria, agora
 * também devolve `_termoCorrespondente` (o sinônimo/termo exato que
 * bateu com a descrição) e `_origemTermo` ('sinonimo'|'nome'|'grupo
 * semântico') — usado pela tabela de revisão de importação
 * (importacao-extrato.js) para mostrar ao usuário, ao tocar no selo
 * "🔑 Sinônimo", QUAL palavra-chave especificamente reconheceu aquela
 * descrição (antes o selo só dizia "Sinônimo", sem dizer qual).
 */
function encontrarCategoriaPorPalavraChave(categorias, descricao, tipo = null) {
    const texto = textoParaMatch(descricao);
    if (!texto || !categorias || !categorias.length) return null;

    // Tipo na frente: uma entrada nunca é comparada com categorias de saída (e vice-versa).
    const candidatas = tipo ? categorias.filter(c => c.tipo === tipo) : categorias;
    if (!candidatas.length) return null;

    // Entre vários matches de alta confiança vence o termo MAIS ESPECÍFICO (mais longo).
    const melhorPorPassada = (fonteDeTermo) => {
        let melhorAlta = null;
        let melhorAprox = null;
        for (const cat of candidatas) {
            for (const termoBruto of fonteDeTermo(cat)) {
                const r = avaliarTermoNoTexto(texto, termoBruto);
                if (!r.match) continue;
                const tam = normalizarTexto(termoBruto).length;
                if (r.confiancaAlta) {
                    if (!melhorAlta || tam > melhorAlta.tam) melhorAlta = { cat, termoBruto, tam, confiancaAlta: true };
                } else if (!melhorAprox || tam > melhorAprox.tam) {
                    melhorAprox = { cat, termoBruto, tam, confiancaAlta: false };
                }
            }
        }
        return melhorAlta || melhorAprox;
    };

    // 1ª passada: sinônimos cadastrados pelo admin (palavras_chave)
    const porSinonimo = melhorPorPassada(cat => Array.isArray(cat.palavras_chave) ? cat.palavras_chave : []);
    if (porSinonimo) {
        return { ...porSinonimo.cat, _confiancaAlta: porSinonimo.confiancaAlta, _termoCorrespondente: porSinonimo.termoBruto, _origemTermo: 'sinonimo' };
    }

    // 2ª passada: nome da própria categoria
    const porNome = melhorPorPassada(cat => [cat.nome]);
    if (porNome) {
        return { ...porNome.cat, _confiancaAlta: porNome.confiancaAlta, _termoCorrespondente: porNome.termoBruto, _origemTermo: 'nome' };
    }

    // 3ª passada: grupo semântico — só usa categoria REAL já cadastrada.
    const grupoSemantico = encontrarGrupoSemantico(texto);
    if (grupoSemantico && (!tipo || grupoSemantico.tipo === tipo)) {
        const nomeCanonico = normalizarTexto(grupoSemantico.categoria);
        const categoriaCanonica = candidatas.find(c =>
            c.tipo === grupoSemantico.tipo && textoContemOuEhContido(normalizarTexto(c.nome), nomeCanonico)
        );
        if (categoriaCanonica) {
            return { ...categoriaCanonica, _confiancaAlta: false, _termoCorrespondente: grupoSemantico.categoria, _origemTermo: 'grupo semântico' };
        }
    }

    return null;
}

// ══════════════════════════════════════════════════════════════
// CLASSIFICADOR LOCAL POR PALAVRAS-CHAVE (heurística fixa no código)
// ══════════════════════════════════════════════════════════════
const REGRAS_CLASSIFICACAO_LOCAL = [
    // ── Receitas (renda) ──
    [/sal[aá]rio|holerite|pr[oó]-labore/i,                          'receita', 'Salário'],
    [/freelance|freela|bico|consultoria/i,                          'receita', 'Freelance'],
    [/dividendo|jcp|rendimento/i,                                   'receita', 'Dividendos'],
    [/renda extra|extra\b/i,                                        'receita', 'Renda Extra'],
    [/13[oº]|decimo terceiro/i,                                     'receita', '13º Salário'],
    [/restitui[çc][aã]o/i,                                          'receita', 'Restituição de Imposto de Renda'],

    // ── Investimento ──
    [/previd[eê]ncia/i,                                             'despesa', 'Previdência Privada'],
    [/reserva|poupan[çc]a|emerg[eê]ncia|tesouro selic|cdb/i,        'despesa', 'Reserva de Emergência'],
    [/investimento|aporte|a[çc][oõ]es|fii\b/i,                      'despesa', 'Aporte em Investimentos'],

    // ── Essencial ──
    [/luz\b|energia el[eé]trica/i,                                    'despesa', 'Energia Elétrica'],
    [/[aá]gua|esgoto/i,                                              'despesa', 'Água e Esgoto'],
    [/g[aá]s\b|botijao/i,                                            'despesa', 'Gás'],
    [/internet|banda larga|wifi/i,                                   'despesa', 'Internet Banda Larga'],
    [/aluguel|financiamento imobiliario/i,                          'despesa', 'Aluguel ou Financiamento Imobiliário'],
    [/condominio/i,                                                  'despesa', 'Condomínio'],
    [/iptu/i,                                                        'despesa', 'IPTU'],
    [/mercado|supermercado/i,                                        'despesa', 'Supermercado'],
    [/feira|sacolao|hortifruti/i,                                    'despesa', 'Feira e Sacolão'],
    [/a[çc]ougue|peixaria/i,                                         'despesa', 'Açougue e Peixaria'],
    [/farm[aá]cia|rem[eé]dio|medicamento/i,                          'despesa', 'Medicamentos de Uso Contínuo'],
    [/plano de sa[uú]de|convenio medico|odontologico/i,              'despesa', 'Plano de Saúde / Odontológico'],
    [/consulta|exame|m[eé]dico|dentista/i,                           'despesa', 'Consultas e Exames'],
    [/faculdade|mensalidade|pos gradua[çc][aã]o/i,                   'despesa', 'Mensalidade Faculdade'],
    [/curso|livro tecnico/i,                                         'despesa', 'Cursos Livres e Livros Técnicos'],
    [/combust[ií]vel|gasolina|posto|alcool|etanol|gnv/i,             'despesa', 'Combustível'],
    [/seguro do carro|seguro auto/i,                                 'despesa', 'Seguro Auto'],
    [/ipva|licenciamento/i,                                          'despesa', 'IPVA e Licenciamento'],
    [/oficina|mec[aâ]nico|revis[aã]o do carro|troca de [oó]leo|pneu|alinhamento|balanceamento/i, 'despesa', 'Manutenção Preventiva do Veículo'],
    [/[oô]nibus|uber\b|99\b|metr[oô]|passagem de [oô]nibus/i,          'despesa', 'Transporte Público'],
    [/veterinario|racao|vacina do pet/i,                             'despesa', 'Pet: Ração, Veterinário e Vacinas'],

    // ── Estilo de vida ──
    [/restaurante|bar\b/i,                                           'despesa', 'Restaurantes e Bares'],
    [/ifood|delivery|rappi/i,                                        'despesa', 'Delivery'],
    [/cafe\b|cafeteria|padaria/i,                                    'despesa', 'Cafés'],
    [/cinema|show|teatro/i,                                          'despesa', 'Cinema e Shows'],
    [/balada|festa|boate/i,                                          'despesa', 'Baladas'],
    [/streaming|netflix|spotify|assinatura/i,                        'despesa', 'Streaming e Assinaturas'],
    [/viagem|hotel|passagem|airbnb/i,                                'despesa', 'Viagens'],
    [/academia|personal trainer|crossfit|pilates/i,                  'despesa', 'Academia'],
    [/presente|doacao|caridade/i,                                    'despesa', 'Presentes e Doações'],
    [/celular|smartphone|notebook|tablet|fone de ouvido|video ?game/i, 'despesa', 'Eletrônicos e Gadgets'],
    [/manicure|pedicure|unha|maquiagem|sobrancelha|estetica/i,      'despesa', 'Salão de Beleza e Estética'],
    [/roupa|sapato|tenis|cal[çc]ado|mala de viagem/i,                'despesa', 'Roupas e Calçados'],
];

function classificarLocalmente(descricao) {
    const texto = textoParaMatch(descricao);
    if (!texto) return null;
    const regra = REGRAS_CLASSIFICACAO_LOCAL.find(([regex]) => regexComBordaEsquerda(regex).test(texto));

    if (!regra) return null;

    const [, tipo, nomeCategoria] = regra;
    return {
        tipo,
        categoriaNome: nomeCategoria,
        fallback: true,
        local:    true
    };
}

// ══════════════════════════════════════════════════════════════
// SMART DATE
// ══════════════════════════════════════════════════════════════
function getDataDeHojeFormatoInput() {
    const agora = new Date();
    const ano   = agora.getFullYear();
    const mes   = String(agora.getMonth() + 1).padStart(2, '0');
    const dia   = String(agora.getDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}`;
}

function setSmartDate(forcar = false) {
    const campoData = document.getElementById('transDate');
    if (!campoData) return;

    if (forcar || !campoData.value) {
        campoData.value = getDataDeHojeFormatoInput();
    }

    TransactionFormState.data = campoData.value;
}

// ══════════════════════════════════════════════════════════════
// CATEGORIAS: BUSCA COM CACHE + MATCHING SEGURO
// ══════════════════════════════════════════════════════════════

async function getCategoriasParaClassificacao(forcarRecarga = false) {
    if (!forcarRecarga && smartInputCategoriasCache && smartInputCategoriasCache.length) {
        return smartInputCategoriasCache;
    }
    try {
        smartInputCategoriasCache = await DatabaseModule.getCategorias();
    } catch (err) {
        console.error('❌ getCategoriasParaClassificacao:', err.message);
        smartInputCategoriasCache = smartInputCategoriasCache || [];
    }
    return smartInputCategoriasCache;
}

function encontrarCategoriaCorrespondente(categorias, nomeSugerido, tipoSugerido) {
    if (!categorias || !categorias.length) return null;
    const nomeAlvo = normalizarTexto(nomeSugerido);

    let match = categorias.find(c =>
        c.tipo === tipoSugerido && normalizarTexto(c.nome) === nomeAlvo
    );
    if (match) return match;

    match = categorias.find(c => {
        if (c.tipo !== tipoSugerido) return false;
        return textoContemOuEhContido(nomeAlvo, normalizarTexto(c.nome));
    });
    if (match) return match;

    return null;
}

// ══════════════════════════════════════════════════════════════
// FEEDBACK VISUAL NO DROPDOWN DE CATEGORIA
// ══════════════════════════════════════════════════════════════

function setSmartInputEstadoVisual(estado, texto) {
    const trigger     = document.getElementById('transCategoryTrigger');
    const triggerText = document.getElementById('transCategoryTriggerText');
    if (!trigger || !triggerText) return;

    if (estado === 'carregando') {
        triggerText.textContent = '🤖 Analisando descrição...';
        trigger.disabled = true;
    } else if (estado === 'sugestao') {
        triggerText.textContent = `🤖 ${texto}`;
        trigger.disabled = false;
    } else if (estado === 'sem-match') {
        triggerText.textContent = texto || 'Não identifiquei a categoria — selecione manualmente';
        trigger.disabled = false;
    } else {
        trigger.disabled = false;
    }
}

function marcarOpcaoSelecionadaNoPainel(categoriaId) {
    const panel = document.getElementById('transCategoryPanel');
    if (!panel) return;
    panel.querySelectorAll('.custom-select__option.selected')
        .forEach(el => el.classList.remove('selected'));
    panel.querySelector(`.custom-select__option[data-id="${categoriaId}"]`)
        ?.classList.add('selected');
}

async function preencherFormularioComClassificacao(resultado) {
    const hiddenInput = document.getElementById('transCategory');
    if (!hiddenInput) return;

    const categorias = await getCategoriasParaClassificacao();
    const match = encontrarCategoriaCorrespondente(categorias, resultado.categoriaNome, resultado.tipo);

    if (match) {
        hiddenInput.value = match.id;
        marcarOpcaoSelecionadaNoPainel(match.id);

        const nomeExibido = resultado.confiancaAlta === false ? `${match.nome} (confira)` : match.nome;
        setSmartInputEstadoVisual('sugestao', nomeExibido);

        TransactionFormState.tipo          = match.tipo;
        TransactionFormState.categoriaId   = match.id;
        TransactionFormState.categoriaNome = match.nome;

        if (resultado.palavraChave) {
            if (resultado.confiancaAlta === false) {
                UIModule.showMessage(`🔎 Sugestão por semelhança: ${match.nome} — confira antes de salvar`, 'info', 4500);
            } else {
                UIModule.showMessage(`🔑 Categoria reconhecida por sinônimo: ${match.nome}`, 'success', 2500);
            }
        } else if (resultado.local) {
            UIModule.showMessage(`🤖 Categoria sugerida: ${match.nome}`, 'success', 2500);
        } else if (resultado.fallback) {
            UIModule.showMessage(
                'Não consegui identificar a categoria com certeza. Confira antes de salvar.',
                'info',
                4000
            );
        } else {
            UIModule.showMessage(`🤖 Categoria sugerida: ${match.nome}`, 'success', 2500);
        }

        if (typeof atualizarSeletorDeMeta === 'function') {
            atualizarSeletorDeMeta('transCategory', 'transMetaWrapper', 'transMeta');
        }
    } else {
        hiddenInput.value = '';
        setSmartInputEstadoVisual('sem-match');

        TransactionFormState.tipo          = null;
        TransactionFormState.categoriaId   = null;
        TransactionFormState.categoriaNome = null;

        UIModule.showError('Não consegui sugerir uma categoria para essa descrição. Selecione manualmente.');
    }
}

// ══════════════════════════════════════════════════════════════
// AUTOCLASSIFY — núcleo do Smart Input
// ══════════════════════════════════════════════════════════════
async function autoClassify(description) {
    const descricao = (description || '').trim();
    TransactionFormState.descricao = descricao;

    if (descricao.length < 3) {
        return null;
    }

    if (descricao === smartInputUltimaDescricao) {
        return null;
    }

    const execucao = (async () => {
        setSmartInputEstadoVisual('carregando');

        let resultado = null;

        const categoriasDisponiveis = await getCategoriasParaClassificacao();

        // 0) Regras globais definidas pelo admin (valem para todos os clientes)
        if (typeof RegrasGlobaisModule !== 'undefined') {
            try {
                const g = await RegrasGlobaisModule.buscar(descricao, null, categoriasDisponiveis);
                if (g) {
                    resultado = {
                        tipo:          g.categoria.tipo,
                        categoriaNome: g.categoria.nome,
                        fallback:      false,
                        local:         false,
                        palavraChave:  true,
                        confiancaAlta: true
                    };
                }
            } catch (_) { /* regra global é opcional */ }
        }

        // 1) Palavras-chave/sinônimos/nome/grupo semântico
        const categoriaPorSinonimo  = resultado ? null : encontrarCategoriaPorPalavraChave(categoriasDisponiveis, descricao);
        if (categoriaPorSinonimo) {
            resultado = {
                tipo:          categoriaPorSinonimo.tipo,
                categoriaNome: categoriaPorSinonimo.nome,
                fallback:      false,
                local:         false,
                palavraChave:  true,
                confiancaAlta: categoriaPorSinonimo._confiancaAlta
            };
        }

        // 2) Tenta o endpoint de IA real (placeholder por enquanto)
        if (!resultado) {
            try {
                const response = await fetch('/api/classify', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ description: descricao })
                });

                if (!response.ok) {
                    throw new Error(`Endpoint /api/classify retornou HTTP ${response.status}`);
                }

                const data = await response.json();

                const tipoValido     = data?.type === 'receita' || data?.type === 'despesa';
                const grupoValido    = GRUPOS_VALIDOS.includes(data?.group);
                const categoriaOk    = typeof data?.category === 'string' && data.category.trim().length > 0;
                const confiancaBaixa = typeof data?.confidence === 'number' && data.confidence < 0.4;

                if (!tipoValido || !grupoValido || !categoriaOk || confiancaBaixa) {
                    throw new Error('Resposta da IA incompleta ou de baixa confiança.');
                }

                resultado = {
                    tipo:          data.type,
                    categoriaNome: data.category.trim(),
                    fallback:      false,
                    local:         false
                };
            } catch (err) {
                console.warn('⚠️ /api/classify indisponível, tentando classificador local:', err.message);
            }
        }

        // 3) Endpoint falhou (ou ainda não existe) — tenta o classificador local
        if (!resultado) {
            resultado = classificarLocalmente(descricao);
        }

        // 4) Nada reconheceu a descrição — não inventa nada
        if (!resultado) {
            setSmartInputEstadoVisual('sem-match');
            TransactionFormState.tipo          = null;
            TransactionFormState.categoriaId   = null;
            TransactionFormState.categoriaNome = null;
            smartInputUltimaDescricao = descricao;
            return null;
        }

        smartInputUltimaDescricao = descricao;
        await preencherFormularioComClassificacao(resultado);
        return resultado;
    })();

    smartInputPromisePendente = execucao;
    const resultadoFinal = await execucao;
    if (smartInputPromisePendente === execucao) smartInputPromisePendente = null;
    return resultadoFinal;
}

async function autoClassifyTransaction(description) {
    return autoClassify(description);
}

async function aguardarClassificacaoSmartInputPendente() {
    if (smartInputPromisePendente) {
        try { await smartInputPromisePendente; } catch (_) { /* já tratado internamente */ }
    }
}

// ══════════════════════════════════════════════════════════════
// SINCRONIZAÇÃO DO ESTADO COM O DOM (data, descrição, categoria)
// ══════════════════════════════════════════════════════════════

let smartInputSincronizacaoLigada = false;

function ligarSincronizacaoDeEstado() {
    if (smartInputSincronizacaoLigada) return;
    smartInputSincronizacaoLigada = true;

    const campoData = document.getElementById('transDate');
    campoData?.addEventListener('change', () => {
        TransactionFormState.data = campoData.value;
    });

    const campoDescricao = document.getElementById('transDescription');
    campoDescricao?.addEventListener('input', () => {
        TransactionFormState.descricao = campoDescricao.value;
    });

    const panel = document.getElementById('transCategoryPanel');
    panel?.addEventListener('click', async (e) => {
        const opcao = e.target.closest('.custom-select__option');
        if (!opcao) return;

        TransactionFormState.categoriaId   = opcao.dataset.id;
        TransactionFormState.categoriaNome = opcao.dataset.nome;

        const categorias = await getCategoriasParaClassificacao();
        const cat = categorias.find(c => c.id === opcao.dataset.id);
        TransactionFormState.tipo = cat?.tipo || null;
    });
}

// ══════════════════════════════════════════════════════════════
// INITFORM — ponto de entrada do módulo
// ══════════════════════════════════════════════════════════════

function initForm(forcarData = false) {
    setSmartDate(forcarData);

    const campoDescricao = document.getElementById('transDescription');
    if (campoDescricao && !campoDescricao.dataset.smartInputListenerLigado) {
        campoDescricao.addEventListener('blur', () => {
            const valor = campoDescricao.value.trim();
            if (!valor) return;

            if (typeof registerTransaction === 'function' && typeof ClientModule !== 'undefined') {
                registerTransaction({ clienteId: ClientModule.getClientId(), descricao: valor });
            } else {
                autoClassify(valor);
            }
        });
        campoDescricao.dataset.smartInputListenerLigado = 'true';
    }

    ligarSincronizacaoDeEstado();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initForm(false));
} else {
    initForm(false);
}

console.log('✅ smart-input.js carregado (match por palavra inteira + favorecido + tipo na frente)');