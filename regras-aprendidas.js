/**
 * REGRAS-APRENDIDAS.JS — Aprendizado de Categorias
 * ================================================
 * Objetivo: o sistema não deve obrigar o cliente a classificar a mesma
 * descrição duas vezes. Da primeira vez que ele lança "BUSE" (ou
 * qualquer termo), o sistema classifica via IA/heurística (ver
 * smart-input.js) e, no momento em que ele clica em "Registar", grava a
 * associação termo→categoria na tabela `regras_aprendidas`. Da próxima
 * vez que ele digitar "BUSE", o sistema já preenche direto — sem
 * chamar IA nenhuma — e se ele corrigir a categoria antes de salvar,
 * essa correção vira a nova regra definitiva (UPDATE, não um registro
 * duplicado).
 *
 * Padrão: script global (sem import/export), igual ao resto do projeto.
 *
 * ORDEM DE CARREGAMENTO NO HTML (crítica):
 *   ... database.js, client.js, app.js, smart-input.js, regras-aprendidas.js, categoria-personalizada.js
 * Este ficheiro depende de funções/variáveis GLOBAIS definidas em
 * smart-input.js (normalizarTexto, getCategoriasParaClassificacao,
 * setSmartInputEstadoVisual, marcarOpcaoSelecionadaNoPainel,
 * TransactionFormState, autoClassify) — por isso deve vir DEPOIS dele.
 *
 * TABELA `regras_aprendidas` (Supabase, já criada via migration):
 *   id            uuid PK
 *   cliente_id    uuid NOT NULL  → FK clientes.id
 *   termo_busca   text NOT NULL  → sempre gravado NORMALIZADO (ver
 *                                  normalizarTexto, de smart-input.js)
 *   categoria_id  uuid NOT NULL  → FK categorias.id
 *   tipo          text NOT NULL  → 'receita' | 'despesa'
 *   created_at / updated_at
 *   UNIQUE (cliente_id, termo_busca)  ← 1 regra por cliente por termo;
 *                                        este índice único composto É o
 *                                        índice de performance da busca
 *                                        "WHERE cliente_id=? AND
 *                                        termo_busca=?" — não precisa de
 *                                        índice manual adicional.
 * RLS: cliente só lê/grava/corrige/apaga as PRÓPRIAS regras
 * (cliente_id = auth.uid()), mesmo padrão de `categorias`.
 */

const RegrasAprendidasModule = (() => {

    /**
     * Consulta se já existe uma regra aprendida para este cliente + termo.
     * Retorna a linha (com categoria_id, tipo) ou null se não existir.
     */
    async function buscarRegra(clienteId, termoBusca) {
        // A chave é o FAVORECIDO limpo (ver chaveRegra em smart-input.js).
        // Também tenta o formato antigo (descrição inteira normalizada)
        // para não perder regras curtas ensinadas antes desta mudança.
        const chave  = chaveRegra(termoBusca);
        const legado = normalizarTexto(termoBusca);
        const termos = [...new Set([chave, legado].filter(t => t && !t.includes('"')))];
        if (!clienteId || !termos.length) return null;

        try {
            const { data, error } = await supabaseClient
                .from('regras_aprendidas')
                .select('id, categoria_id, tipo, termo_busca')
                .eq('cliente_id', clienteId)
                .in('termo_busca', termos);

            if (error) throw error;
            if (!data || !data.length) return null;
            return data.find(r => r.termo_busca === chave) || data[0];
        } catch (err) {
            console.error('❌ RegrasAprendidasModule.buscarRegra:', err.message);
            return null;
        }
    }

    /**
     * Carrega TODAS as regras de um cliente de uma vez (Map termo → regra).
     * Usado pela importação de extrato: com 300 linhas, são 1 consulta
     * em vez de 300.
     */
    async function listarDoCliente(clienteId) {
        const mapa = new Map();
        if (!clienteId) return mapa;
        try {
            const { data, error } = await supabaseClient
                .from('regras_aprendidas')
                .select('id, categoria_id, tipo, termo_busca')
                .eq('cliente_id', clienteId)
                .limit(5000);
            if (error) throw error;
            (data || []).forEach(r => mapa.set(r.termo_busca, r));
        } catch (err) {
            console.error('❌ RegrasAprendidasModule.listarDoCliente:', err.message);
        }
        return mapa;
    }

    async function salvarOuAtualizarRegra({ clienteId, termoBusca, categoriaId, tipo }) {
        const termo = chaveRegra(termoBusca);
        // Termo curto demais ou só número não ensina nada — e poluía a tabela.
        if (!clienteId || !termo || termo.length < 3 || /^\d+$/.test(termo) || !categoriaId || !tipo) {
            console.warn('⚠️ RegrasAprendidasModule.salvarOuAtualizarRegra: parâmetros incompletos, nada foi salvo.');
            return null;
        }

        try {
            const { data, error } = await supabaseClient
                .from('regras_aprendidas')
                .upsert(
                    {
                        cliente_id:   clienteId,
                        termo_busca:  termo,
                        categoria_id: categoriaId,
                        tipo,
                        updated_at:   new Date().toISOString()
                    },
                    { onConflict: 'cliente_id,termo_busca' }
                )
                .select();

            if (error) throw error;
            return data?.[0] || null;
        } catch (err) {
            // Não relançamos o erro para o chamador (app.js): uma falha
            // ao gravar a REGRA aprendida nunca deve impedir nem reverter
            // o registo da TRANSAÇÃO em si, que já foi salva com sucesso
            // antes desta chamada acontecer.
            console.error('❌ RegrasAprendidasModule.salvarOuAtualizarRegra:', err.message);
            return null;
        }
    }

    return { buscarRegra, listarDoCliente, salvarOuAtualizarRegra };
})();

// ══════════════════════════════════════════════════════════════
// REGRAS GLOBAIS — definidas pelo admin, valem para TODOS os clientes
// ══════════════════════════════════════════════════════════════
// Tabela `regras_globais` (termo, tipo, categoria_id, prioridade, ativo).
// Só aponta para categorias globais. Maior prioridade vence; em empate,
// o termo mais longo (mais específico). Se a tabela ainda não existir
// ou falhar, devolve "sem regra" — nunca quebra a classificação.
const RegrasGlobaisModule = (() => {
    let cache = null;
    let carregadoEm = 0;
    const TTL_MS = 5 * 60 * 1000;

    async function carregar(forcar = false) {
        if (!forcar && cache && (Date.now() - carregadoEm) < TTL_MS) return cache;
        try {
            const { data, error } = await supabaseClient
                .from('regras_globais')
                .select('id, termo, tipo, categoria_id, prioridade')
                .eq('ativo', true);
            if (error) throw error;
            cache = (data || []).sort((a, b) => (b.prioridade - a.prioridade) || (b.termo.length - a.termo.length));
        } catch (err) {
            console.warn('⚠️ RegrasGlobaisModule.carregar:', err.message);
            cache = cache || [];
        }
        carregadoEm = Date.now();
        return cache;
    }

    /** @returns {{regra, categoria, termo}|null} — tipo null = qualquer tipo */
    async function buscar(descricao, tipo, categorias) {
        const regras = await carregar();
        if (!regras.length) return null;
        const texto = textoParaMatch(descricao);
        if (!texto) return null;

        for (const regra of regras) {
            if (tipo && regra.tipo !== tipo) continue;
            if (!palavraInteira(texto, normalizarTexto(regra.termo))) continue;
            const categoria = (categorias || []).find(c => c.id === regra.categoria_id);
            if (!categoria) continue;
            return { regra, categoria, termo: regra.termo };
        }
        return null;
    }

    function invalidar() { cache = null; }

    return { carregar, buscar, invalidar };
})();

// ══════════════════════════════════════════════════════════════
// REGISTERTRANSACTION — o "motor" do fluxo de aprendizado
// ══════════════════════════════════════════════════════════════
// Chamado ao sair do campo Descrição (ver wiring mais abaixo, que
// substitui a chamada direta a autoClassify feita em smart-input.js).
//
// Fluxo:
//   a) consulta regras_aprendidas pelo termo digitado + cliente atual;
//   b) se achar → preenche a categoria direto, sem chamar IA nenhuma;
//   c) se não achar → delega para autoClassify() (pipeline já existente
//      em smart-input.js: tenta /api/classify, cai no classificador
//      local por palavras-chave, ou pede seleção manual).
//
// IMPORTANTE: esta função NÃO grava nada em `regras_aprendidas` — ela
// só CONSULTA e SUGERE. A gravação da regra definitiva só acontece no
// momento do "Registar" (ver handleAddTransaction em app.js), porque só
// nesse momento sabemos a categoria FINAL que o cliente confirmou —
// que pode ser a sugestão aceita como está, ou uma correção manual.
//
// @param {{ clienteId: string, descricao: string }} inputData
// @returns {Promise<{origem: 'aprendida'|'classificada', categoriaId, tipo}|null>}
async function registerTransaction(inputData) {
    const clienteId = inputData?.clienteId;
    const descricao  = (inputData?.descricao || '').trim();

    TransactionFormState.descricao = descricao;

    if (!clienteId || descricao.length < 3) {
        return null;
    }

    // a) Consulta a regra aprendida para este termo + cliente
    const regra = await buscarRegraComFeedbackVisual(clienteId, descricao);

    if (regra) {
        // b) Regra encontrada — precisa confirmar que a categoria que ela
        // aponta ainda existe (pode ter sido apagada pelo admin depois).
        const categorias = await getCategoriasParaClassificacao();
        const categoria  = categorias.find(c => c.id === regra.categoria_id);

        if (categoria) {
            preencherCategoriaNoFormulario(categoria, '🧠 Categoria aprendida');
            return { origem: 'aprendida', categoriaId: categoria.id, tipo: categoria.tipo };
        }

        // Regra aponta para uma categoria que não existe mais — não usa
        // a regra órfã, cai para o pipeline de classificação normal.
        console.warn('⚠️ Regra aprendida aponta para categoria inexistente — reclassificando.');
    }

    // c) Sem regra aprendida (ou regra órfã) — usa o pipeline já existente
    const resultadoClassificacao = await autoClassify(descricao);
    return resultadoClassificacao
        ? { origem: 'classificada', categoriaId: TransactionFormState.categoriaId, tipo: TransactionFormState.tipo }
        : null;
}

// Mostra "Verificando..." enquanto consulta regras_aprendidas — evita
// que o dropdown pareça travado durante a ida ao banco.
async function buscarRegraComFeedbackVisual(clienteId, descricao) {
    setSmartInputEstadoVisual('carregando');
    const regra = await RegrasAprendidasModule.buscarRegra(clienteId, descricao);
    return regra;
}

// Preenche o dropdown de categoria (hidden input + painel visual) com
// uma categoria já resolvida (id real, já existente no banco) — usado
// tanto pelo caminho "regra aprendida" quanto poderia ser reaproveitado
// por outros fluxos futuros que já tenham a categoria certa em mãos.
function preencherCategoriaNoFormulario(categoria, prefixoMensagem) {
    const hiddenInput = document.getElementById('transCategory');
    if (!hiddenInput) return;

    hiddenInput.value = categoria.id;
    marcarOpcaoSelecionadaNoPainel(categoria.id);
    setSmartInputEstadoVisual('sugestao', categoria.nome);

    TransactionFormState.tipo          = categoria.tipo;
    TransactionFormState.categoriaId   = categoria.id;
    TransactionFormState.categoriaNome = categoria.nome;

    UIModule.showMessage(`${prefixoMensagem}: ${categoria.nome}`, 'success', 2500);

    // Vínculo com Meta/Caixinha (app.js): reavalia se a categoria
    // aprendida é do grupo 'investimento' e, se for, mostra o seletor
    // de meta. Guarda por typeof porque este módulo não depende de
    // app.js estar carregado.
    if (typeof atualizarSeletorDeMeta === 'function') {
        atualizarSeletorDeMeta('transCategory', 'transMetaWrapper', 'transMeta');
    }
}

console.log('✅ regras-aprendidas.js carregado');
