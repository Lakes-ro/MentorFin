/**
 * REGRAS-ADMIN.JS — Central de Regras de Classificação (admin.html)
 * ================================================
 * Padrão: script global. Sem import/export.
 * Depende de: supabaseClient, allClientes, loadAllClientes, showToast
 *             (admin.js), escaparHtml (seguranca.js), normalizarTexto
 *             (smart-input.js), RegrasGlobaisModule (regras-aprendidas.js).
 *
 * PENSADO PARA 50–100 CLIENTES: o admin não revisa regra por regra.
 *   1) 🚀 Candidatas a regra global — o banco (view v_regras_promocao)
 *      junta sozinho os termos que 3+ clientes diferentes classificaram
 *      igual numa categoria global. Um clique promove.
 *   2) 🌐 Regras globais — valem para TODOS os clientes (ex: "uber" →
 *      Transporte Público). Maior prioridade vence.
 *   3) ⚠️ Regras suspeitas — detecta sozinho regras lixo (CPF/CNPJ no
 *      termo, descrição inteira de PIX, categoria de outro cliente,
 *      tipo divergente) e limpa em lote.
 *   4) 👤 Regras por cliente — consulta/remoção pontual.
 *
 * Renderiza só quando a seção "Regras" é aberta (evento section:change),
 * por isso não depende de nenhuma mudança em admin.js.
 */

const regrasAdminEstado = {
    iniciado: false,
    globais: [],
    catsGlobais: [],
    catsPorId: new Map(),
    regras: [],
    promocao: [],
    clienteSelecionado: ''
};

const REGRAS_LIMITE_LISTA = 300;

function _rgEsc(t) { return typeof escaparHtml === 'function' ? escaparHtml(t) : String(t ?? ''); }

function initRegrasAdmin() {
    if (regrasAdminEstado.iniciado) return;
    regrasAdminEstado.iniciado = true;

    const secao = document.getElementById('section-regras');
    if (!secao) return;

    secao.addEventListener('click', tratarCliqueRegras);
    secao.addEventListener('change', tratarMudancaRegras);
}

window.addEventListener('section:change', ({ detail }) => {
    if (detail.section !== 'regras') return;
    initRegrasAdmin();
    renderRegrasAdmin();
});

// ══════════════════════════════════════════════════════════════
// CARGA + RENDER
// ══════════════════════════════════════════════════════════════

async function renderRegrasAdmin() {
    if (!allClientes.length) await loadAllClientes();

    ['regras-resumo', 'regras-promocao-lista', 'regras-globais-lista', 'regras-suspeitas-lista', 'regras-cliente-lista']
        .forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '<p class="empty-state">Carregando...</p>';
        });

    const [cg, rg, pr, ra, ct] = await Promise.all([
        supabaseClient.from('categorias').select('id, nome, tipo, cliente_id').is('cliente_id', null).order('nome').limit(5000),
        supabaseClient.from('regras_globais').select('id, termo, tipo, categoria_id, prioridade, ativo, origem').order('termo').limit(5000),
        supabaseClient.from('v_regras_promocao').select('termo, tipo, categoria_id, categoria_nome, qtd_clientes').order('qtd_clientes', { ascending: false }).limit(200),
        supabaseClient.from('regras_aprendidas').select('id, cliente_id, termo_busca, categoria_id, tipo, updated_at').order('updated_at', { ascending: false }).limit(5000),
        supabaseClient.from('categorias').select('id, nome, tipo, cliente_id').limit(5000)
    ]);

    const erro = [cg, rg, pr, ra, ct].find(r => r.error);
    if (erro) {
        showToast('Erro ao carregar regras: ' + erro.error.message, 'error');
        console.error('❌ renderRegrasAdmin:', erro.error.message);
    }

    regrasAdminEstado.catsGlobais = cg.data || [];
    regrasAdminEstado.globais     = rg.data || [];
    regrasAdminEstado.promocao    = pr.data || [];
    regrasAdminEstado.regras      = ra.data || [];
    regrasAdminEstado.catsPorId   = new Map((ct.data || []).map(c => [c.id, c]));

    renderResumoRegras();
    renderPromocaoRegras();
    renderFormGlobal();
    renderGlobaisRegras();
    renderSuspeitasRegras();
    renderClienteSeletor();
    renderRegrasDoCliente();
}

/** Motivo pelo qual uma regra aprendida é suspeita — ou null se está saudável. */
function motivoSuspeitaRegra(regra) {
    const termo = regra.termo_busca || '';
    const cat   = regrasAdminEstado.catsPorId.get(regra.categoria_id);

    if (!cat)                                         return 'a categoria não existe mais';
    if (/\d{4,}/.test(termo))                         return 'termo com número longo (CPF/CNPJ/conta)';
    if (termo.length > 40)                            return 'termo longo demais (descrição inteira do extrato)';
    if (/^(transferencia|pix)\b/.test(termo))         return 'descrição inteira de PIX/transferência';
    if (termo.length < 3)                             return 'termo curto demais';
    if (cat.cliente_id && cat.cliente_id !== regra.cliente_id) return 'aponta para categoria de OUTRO cliente';
    if (cat.tipo !== regra.tipo)                      return 'tipo diverge do tipo da categoria';
    return null;
}

function nomeClienteRegra(clienteId) {
    return allClientes.find(c => c.id === clienteId)?.nome || 'Cliente removido';
}

function linhaRegraAprendida(regra, motivo) {
    const cat = regrasAdminEstado.catsPorId.get(regra.categoria_id);
    return `
      <div class="regras-linha">
        <div class="regras-linha__main">
          <span class="regras-termo" title="${_rgEsc(regra.termo_busca)}">${_rgEsc(regra.termo_busca)}</span>
          <span class="regras-meta">→ ${_rgEsc(cat?.nome || '—')} · ${_rgEsc(regra.tipo)} · <span class="dado-sensivel">${_rgEsc(nomeClienteRegra(regra.cliente_id))}</span></span>
          ${motivo ? `<span class="regras-motivo">⚠️ ${_rgEsc(motivo)}</span>` : ''}
        </div>
        <button type="button" class="btn-card deletar regras-btn" data-acao="regra-del" data-id="${regra.id}" title="Apagar esta regra">🗑️</button>
      </div>`;
}

function renderResumoRegras() {
    const el = document.getElementById('regras-resumo');
    if (!el) return;
    const { regras, globais, promocao } = regrasAdminEstado;
    const suspeitas = regras.filter(r => motivoSuspeitaRegra(r)).length;
    const clientes  = new Set(regras.map(r => r.cliente_id)).size;

    el.innerHTML = `
      <div class="kpi-card kpi-blue"><span class="kpi-label">Regras aprendidas</span><span class="kpi-value">${regras.length}</span><span class="kpi-sub">de ${clientes} cliente(s)</span></div>
      <div class="kpi-card kpi-green"><span class="kpi-label">Regras globais ativas</span><span class="kpi-value">${globais.filter(g => g.ativo).length}</span><span class="kpi-sub">valem para todos</span></div>
      <div class="kpi-card kpi-yellow"><span class="kpi-label">Candidatas a promover</span><span class="kpi-value">${promocao.length}</span><span class="kpi-sub">3+ clientes concordam</span></div>
      <div class="kpi-card kpi-orange"><span class="kpi-label">Regras suspeitas</span><span class="kpi-value">${suspeitas}</span><span class="kpi-sub">${suspeitas ? 'precisam de limpeza' : 'tudo certo'}</span></div>`;
}

// ── 1) Promoção automática ──────────────────────────────────────
function renderPromocaoRegras() {
    const el = document.getElementById('regras-promocao-lista');
    if (!el) return;
    const lista = regrasAdminEstado.promocao;

    if (!lista.length) {
        el.innerHTML = '<p class="empty-state">Nenhuma candidata ainda. Quando 3 ou mais clientes classificarem o mesmo termo na mesma categoria, ele aparece aqui.</p>';
        return;
    }

    el.innerHTML = lista.map(p => `
      <div class="regras-linha">
        <div class="regras-linha__main">
          <span class="regras-termo">${_rgEsc(p.termo)}</span>
          <span class="regras-meta">→ ${_rgEsc(p.categoria_nome)} · ${_rgEsc(p.tipo)} · ${p.qtd_clientes} clientes concordam</span>
        </div>
        <button type="button" class="btn-card confirmar regras-btn" data-acao="promover"
          data-termo="${_rgEsc(p.termo)}" data-tipo="${_rgEsc(p.tipo)}" data-categoria="${p.categoria_id}">🚀 Promover</button>
      </div>`).join('');
}

async function promoverRegra(termo, tipo, categoriaId) {
    const { error } = await supabaseClient.from('regras_globais')
        .insert({ termo, tipo, categoria_id: categoriaId, origem: 'promovida', prioridade: 100 });
    if (error) { showToast('Erro ao promover: ' + traduzirErroRegra(error), 'error'); return; }
    if (typeof RegrasGlobaisModule !== 'undefined') RegrasGlobaisModule.invalidar();
    showToast(`"${termo}" agora é uma regra global.`);
    renderRegrasAdmin();
}

// ── 2) Regras globais ───────────────────────────────────────────
function renderFormGlobal() {
    const selTipo = document.getElementById('regra-global-tipo');
    const selCat  = document.getElementById('regra-global-categoria');
    if (!selTipo || !selCat) return;

    const tipo = selTipo.value || 'despesa';
    selCat.innerHTML = regrasAdminEstado.catsGlobais
        .filter(c => c.tipo === tipo)
        .map(c => `<option value="${c.id}">${_rgEsc(c.nome)}</option>`)
        .join('') || '<option value="">Nenhuma categoria global deste tipo</option>';
}

function renderGlobaisRegras() {
    const el = document.getElementById('regras-globais-lista');
    if (!el) return;
    const lista = regrasAdminEstado.globais;

    if (!lista.length) {
        el.innerHTML = '<p class="empty-state">Nenhuma regra global cadastrada. Exemplo: termo "uber" → Transporte Público.</p>';
        return;
    }

    el.innerHTML = lista.map(g => {
        const cat = regrasAdminEstado.catsPorId.get(g.categoria_id);
        return `
      <div class="regras-linha ${g.ativo ? '' : 'regras-linha--inativa'}">
        <div class="regras-linha__main">
          <span class="regras-termo">${_rgEsc(g.termo)}</span>
          <span class="regras-meta">→ ${_rgEsc(cat?.nome || '—')} · ${_rgEsc(g.tipo)} · ${g.origem === 'promovida' ? 'promovida' : 'manual'}</span>
        </div>
        <label class="regras-prioridade" title="Maior número vence">prioridade
          <input type="number" min="0" max="999" value="${g.prioridade}" data-acao="global-prioridade" data-id="${g.id}">
        </label>
        <button type="button" class="btn-card editar regras-btn" data-acao="global-toggle" data-id="${g.id}">${g.ativo ? '⏸️ Pausar' : '▶️ Ativar'}</button>
        <button type="button" class="btn-card deletar regras-btn" data-acao="global-del" data-id="${g.id}" data-termo="${_rgEsc(g.termo)}">🗑️</button>
      </div>`;
    }).join('');
}

async function adicionarRegraGlobal() {
    const termoBruto = document.getElementById('regra-global-termo')?.value || '';
    const tipo        = document.getElementById('regra-global-tipo')?.value;
    const categoriaId = document.getElementById('regra-global-categoria')?.value;
    const prioridade  = parseInt(document.getElementById('regra-global-prioridade')?.value, 10);

    const termo = (typeof normalizarTexto === 'function' ? normalizarTexto(termoBruto) : termoBruto.toLowerCase()).replace(/\s+/g, ' ').trim();
    const numerico = /^\d+$/.test(termo);

    if (!termo)                                  { showToast('Informe o termo da regra.', 'error'); return; }
    if (termo.length < (numerico ? 2 : 3))       { showToast('Termo curto demais — use pelo menos 3 letras.', 'error'); return; }
    if (/\d{4,}/.test(termo))                    { showToast('Não use CPF/CNPJ ou números longos no termo.', 'error'); return; }
    if (!categoriaId)                            { showToast('Escolha a categoria.', 'error'); return; }

    const { error } = await supabaseClient.from('regras_globais').insert({
        termo, tipo, categoria_id: categoriaId,
        prioridade: Number.isFinite(prioridade) ? prioridade : 100,
        origem: 'manual'
    });
    if (error) { showToast('Erro ao salvar: ' + traduzirErroRegra(error), 'error'); return; }

    if (typeof RegrasGlobaisModule !== 'undefined') RegrasGlobaisModule.invalidar();
    document.getElementById('regra-global-termo').value = '';
    showToast('Regra global criada!');
    renderRegrasAdmin();
}

function traduzirErroRegra(error) {
    const msg = error?.message || '';
    if (error?.code === '23505' || /duplicate key/i.test(msg)) return 'já existe uma regra global com esse termo e tipo.';
    if (msg.includes('regra_global_categoria_pessoal'))       return 'regras globais só podem usar categorias globais.';
    if (msg.includes('regra_global_tipo_divergente'))         return 'o tipo da regra precisa ser igual ao tipo da categoria.';
    return msg;
}

async function atualizarRegraGlobal(id, campos) {
    const { error } = await supabaseClient.from('regras_globais').update(campos).eq('id', id);
    if (error) { showToast('Erro ao atualizar: ' + error.message, 'error'); return false; }
    if (typeof RegrasGlobaisModule !== 'undefined') RegrasGlobaisModule.invalidar();
    return true;
}

async function apagarRegraGlobal(id, termo) {
    if (!confirm(`Apagar a regra global "${termo}"?`)) return;
    const { data, error } = await supabaseClient.from('regras_globais').delete().eq('id', id).select('id');
    if (error || !data?.length) { showToast('Não foi possível apagar a regra.', 'error'); return; }
    if (typeof RegrasGlobaisModule !== 'undefined') RegrasGlobaisModule.invalidar();
    showToast('Regra global removida.');
    renderRegrasAdmin();
}

// ── 3) Regras suspeitas ─────────────────────────────────────────
function renderSuspeitasRegras() {
    const el = document.getElementById('regras-suspeitas-lista');
    const botao = document.getElementById('btn-limpar-suspeitas');
    if (!el) return;

    const suspeitas = regrasAdminEstado.regras
        .map(r => ({ r, motivo: motivoSuspeitaRegra(r) }))
        .filter(x => x.motivo);

    botao?.classList.toggle('hidden', !suspeitas.length);
    if (botao) botao.textContent = `🧹 Apagar todas (${suspeitas.length})`;

    if (!suspeitas.length) {
        el.innerHTML = '<p class="empty-state">Nenhuma regra suspeita. 🎉</p>';
        return;
    }

    const visiveis = suspeitas.slice(0, REGRAS_LIMITE_LISTA);
    el.innerHTML = visiveis.map(x => linhaRegraAprendida(x.r, x.motivo)).join('') +
        (suspeitas.length > visiveis.length
            ? `<p class="empty-state">Mostrando ${visiveis.length} de ${suspeitas.length}. "Apagar todas" remove todas as ${suspeitas.length}.</p>` : '');
}

async function apagarRegrasAprendidasPorIds(ids) {
    let apagadas = 0;
    for (let i = 0; i < ids.length; i += 100) {
        const lote = ids.slice(i, i + 100);
        const { data, error } = await supabaseClient.from('regras_aprendidas').delete().in('id', lote).select('id');
        if (error) throw error;
        apagadas += data?.length || 0;
    }
    return apagadas;
}

async function limparRegrasSuspeitas() {
    const ids = regrasAdminEstado.regras.filter(r => motivoSuspeitaRegra(r)).map(r => r.id);
    if (!ids.length) return;
    if (!confirm(`Apagar ${ids.length} regra(s) suspeita(s)? As transações já lançadas NÃO são alteradas — só deixam de existir essas regras aprendidas.`)) return;

    try {
        const apagadas = await apagarRegrasAprendidasPorIds(ids);
        if (apagadas < ids.length) showToast(`Só ${apagadas} de ${ids.length} foram apagadas (verifique as permissões).`, 'error');
        else showToast(`${apagadas} regra(s) suspeita(s) apagada(s).`);
    } catch (err) {
        showToast('Erro ao limpar: ' + err.message, 'error');
    }
    renderRegrasAdmin();
}

async function apagarRegraAprendida(id) {
    try {
        const apagadas = await apagarRegrasAprendidasPorIds([id]);
        if (!apagadas) { showToast('Não foi possível apagar a regra.', 'error'); return; }
        showToast('Regra removida.');
    } catch (err) {
        showToast('Erro ao apagar: ' + err.message, 'error');
    }
    renderRegrasAdmin();
}

// ── 4) Regras por cliente ───────────────────────────────────────
function renderClienteSeletor() {
    const sel = document.getElementById('regras-cliente-select');
    if (!sel) return;
    const atual = regrasAdminEstado.clienteSelecionado;

    const contagem = {};
    regrasAdminEstado.regras.forEach(r => { contagem[r.cliente_id] = (contagem[r.cliente_id] || 0) + 1; });

    sel.innerHTML = '<option value="">Selecione um cliente...</option>' +
        allClientes.slice().sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
            .map(c => `<option value="${c.id}" ${c.id === atual ? 'selected' : ''}>${_rgEsc(c.nome)} (${contagem[c.id] || 0})</option>`).join('');
}

function renderRegrasDoCliente() {
    const el = document.getElementById('regras-cliente-lista');
    const botao = document.getElementById('btn-limpar-cliente');
    if (!el) return;
    const id = regrasAdminEstado.clienteSelecionado;

    if (!id) {
        botao?.classList.add('hidden');
        el.innerHTML = '<p class="empty-state">Escolha um cliente para ver as regras que ele ensinou.</p>';
        return;
    }

    const lista = regrasAdminEstado.regras.filter(r => r.cliente_id === id);
    botao?.classList.toggle('hidden', !lista.length);
    if (botao) botao.textContent = `🗑️ Apagar todas as regras deste cliente (${lista.length})`;

    if (!lista.length) {
        el.innerHTML = '<p class="empty-state">Este cliente ainda não tem regras aprendidas.</p>';
        return;
    }

    const visiveis = lista.slice(0, REGRAS_LIMITE_LISTA);
    el.innerHTML = visiveis.map(r => linhaRegraAprendida(r, motivoSuspeitaRegra(r))).join('') +
        (lista.length > visiveis.length ? `<p class="empty-state">Mostrando ${visiveis.length} de ${lista.length} (as mais recentes).</p>` : '');
}

async function limparRegrasDoCliente() {
    const id = regrasAdminEstado.clienteSelecionado;
    const ids = regrasAdminEstado.regras.filter(r => r.cliente_id === id).map(r => r.id);
    if (!ids.length) return;
    if (!confirm(`Apagar TODAS as ${ids.length} regras aprendidas de ${nomeClienteRegra(id)}? As transações já lançadas não mudam.`)) return;

    try {
        const apagadas = await apagarRegrasAprendidasPorIds(ids);
        showToast(`${apagadas} regra(s) apagada(s).`);
    } catch (err) {
        showToast('Erro ao apagar: ' + err.message, 'error');
    }
    renderRegrasAdmin();
}

// ══════════════════════════════════════════════════════════════
// EVENTOS (delegação — a seção é re-renderizada o tempo todo)
// ══════════════════════════════════════════════════════════════

async function tratarCliqueRegras(e) {
    const alvo = e.target.closest('[data-acao], #btn-add-regra-global, #btn-limpar-suspeitas, #btn-limpar-cliente');
    if (!alvo) return;

    if (alvo.id === 'btn-add-regra-global') return adicionarRegraGlobal();
    if (alvo.id === 'btn-limpar-suspeitas')  return limparRegrasSuspeitas();
    if (alvo.id === 'btn-limpar-cliente')    return limparRegrasDoCliente();

    switch (alvo.dataset.acao) {
        case 'promover':      return promoverRegra(alvo.dataset.termo, alvo.dataset.tipo, alvo.dataset.categoria);
        case 'global-toggle': {
            const g = regrasAdminEstado.globais.find(x => x.id === alvo.dataset.id);
            if (g && await atualizarRegraGlobal(g.id, { ativo: !g.ativo })) renderRegrasAdmin();
            return;
        }
        case 'global-del':    return apagarRegraGlobal(alvo.dataset.id, alvo.dataset.termo);
        case 'regra-del':     return apagarRegraAprendida(alvo.dataset.id);
        default: return;
    }
}

async function tratarMudancaRegras(e) {
    const alvo = e.target;

    if (alvo.id === 'regra-global-tipo') { renderFormGlobal(); return; }

    if (alvo.id === 'regras-cliente-select') {
        regrasAdminEstado.clienteSelecionado = alvo.value;
        renderRegrasDoCliente();
        return;
    }

    if (alvo.dataset?.acao === 'global-prioridade') {
        const valor = parseInt(alvo.value, 10);
        if (!Number.isFinite(valor)) return;
        if (await atualizarRegraGlobal(alvo.dataset.id, { prioridade: valor })) {
            const g = regrasAdminEstado.globais.find(x => x.id === alvo.dataset.id);
            if (g) g.prioridade = valor;
            showToast('Prioridade atualizada.');
        }
    }
}

console.log('✅ regras-admin.js carregado (regras globais + promoção + limpeza)');
