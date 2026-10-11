/**
 * CATEGORIAS.JS — Módulo: Categorias (admin.html)
 * Padrão: script global. Sem import/export.
 * Depende de: supabaseClient, allClientes, loadAllClientes, openModal,
 *             closeModal, showToast (definidos em admin.js),
 *             obterCodigoGrupo (definido em contabilidade.js —
 *             carregado ANTES deste ficheiro).
 *
 * ATUALIZAÇÃO — PLANO DE CONTAS ROBUSTO (PALAVRAS-CHAVE/SINÔNIMOS):
 * Cada categoria tem uma coluna `palavras_chave` (text[]), editável no
 * modal de categoria como uma lista separada por vírgula. Usado pelo
 * Smart Input, pela importação de extrato e pela criação de categoria
 * personalizada do cliente pra reconhecer a descrição digitada e
 * sugerir a categoria certa.
 *
 * ATUALIZAÇÃO — PERFORMANCE DO "CONFIRMAR" (Pendentes de
 * Contabilização): a mudança é aplicada de forma OTIMISTA na UI antes
 * de confirmar no servidor, revertendo só se o servidor recusar.
 *
 * ATUALIZAÇÃO — "RECEITA ANTES DE DESPESA": Receita sempre aparece
 * antes de Despesa em toda consulta/lista/select.
 *
 * ATUALIZAÇÃO — CÓDIGO CONTÁBIL REAL DO BANCO (`categorias.codigo_contabil`):
 * A grade prioriza o código real quando ele existe; categorias sem
 * código caem no código de GRUPO calculado (obterCodigoGrupo, de
 * contabilidade.js) como fallback.
 *
 * ATUALIZAÇÃO — MESCLAR CATEGORIAS (RESOLVE DUPLICATAS/PROLIFERAÇÃO):
 * O botão "🔀 Mesclar" move TODAS as transações, regras aprendidas e
 * regras globais da categoria de origem para a de destino, junta os
 * sinônimos e apaga a origem. Pede confirmação dupla.
 *
 * ATUALIZAÇÃO — EXCLUIR CATEGORIA EM USO (out/2026):
 * Antes, "🗑️ Deletar" numa categoria com lançamentos estourava o erro
 * do banco ("violates foreign key constraint transacoes_categoria_id_fkey").
 * Agora o sistema conta os lançamentos primeiro:
 *   - nenhum lançamento → exclui direto (com confirmação);
 *   - com lançamentos   → abre o mesmo modal da mesclagem, em modo
 *     "Excluir categoria em uso": o admin escolhe para qual categoria os
 *     lançamentos vão, e só então a categoria é excluída.
 * A mesclagem também passou a mover as REGRAS GLOBAIS (antes elas eram
 * apagadas junto com a categoria, por causa do ON DELETE CASCADE).
 */

let categoriaEmEdicao = null;
let categoriasCache   = [];

const GRUPOS_POR_TIPO = {
  despesa: [
    { value: 'essencial',      label: 'Essencial (sobrevivência)' },
    { value: 'estilo_de_vida', label: 'Estilo de Vida' },
    { value: 'investimento',   label: 'Investimento (poupança/reserva)' },
    { value: 'divida',         label: 'Dívidas e Financiamentos' },
    { value: 'transferencia',  label: 'Transferência Interna (não conta como gasto)' },
  ],
  receita: [
    { value: 'renda',         label: 'Renda' },
    { value: 'transferencia', label: 'Transferência Interna (não conta como ganho)' },
  ],
};

const GRUPO_LABEL = {
  essencial:      '🟠 Essencial',
  estilo_de_vida: '🎯 Estilo de Vida',
  investimento:   '💰 Investimento',
  divida:         '💳 Dívidas e Financiamentos',
  transferencia:  '🔄 Transferência Interna',
  renda:          '📈 Renda',
};

// Ordem contábil das seções do Plano de Contas — mesma numeração usada
// no Balancete (1.x Receitas, 2.x Despesas). Ver obterCodigoGrupo() em
// contabilidade.js, a fonte única de verdade pro código de GRUPO
// (usado só como fallback pra categorias sem codigo_contabil próprio).
const ORDEM_PLANO_DE_CONTAS = [
  { tipo: 'receita', grupo: 'renda' },
  { tipo: 'receita', grupo: 'transferencia' },
  { tipo: 'despesa', grupo: 'essencial' },
  { tipo: 'despesa', grupo: 'estilo_de_vida' },
  { tipo: 'despesa', grupo: 'investimento' },
  { tipo: 'despesa', grupo: 'divida' },
  { tipo: 'despesa', grupo: 'transferencia' },
];

function normalizarTextoBusca(txt) {
  return (txt || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function initCategorias() {
  document.getElementById('btn-add-categoria')
    ?.addEventListener('click', () => abrirModalCategoria(null));

  document.getElementById('btn-salvar-categoria')
    ?.addEventListener('click', salvarCategoria);

  document.getElementById('categoria-tipo')
    ?.addEventListener('change', atualizarOpcoesDeGrupo);

  document.getElementById('categoria-alcance')
    ?.addEventListener('change', atualizarVisibilidadeCampoCliente);

  document.getElementById('categoria-busca')
    ?.addEventListener('input', (e) => renderCategoriasFiltradas(e.target.value));

  document.getElementById('btn-confirmar-mesclagem')
    ?.addEventListener('click', confirmarMesclagemCategoria);

  window.addEventListener('section:change', ({ detail }) => {
    if (detail.section === 'categorias') renderCategorias();
  });

  renderCategorias();
}

async function renderCategorias() {
  const grid = document.getElementById('categorias-grid');
  if (!grid) return;
  grid.innerHTML = '<p class="empty-state">Carregando...</p>';

  if (!allClientes.length) await loadAllClientes();

  const { data, error } = await supabaseClient
    .from('categorias')
    .select('id, nome, tipo, grupo, cliente_id, revisado, palavras_chave, codigo_contabil')
    .order('tipo', { ascending: false }) // receita antes de despesa
    .order('grupo')
    .order('nome');

  if (error) {
    grid.innerHTML = `<p class="empty-state">Erro ao carregar: ${error.message}</p>`;
    console.error('❌ renderCategorias:', error.message);
    return;
  }

  categoriasCache = data || [];

  renderPendentesRevisao();

  const campoBusca = document.getElementById('categoria-busca');
  renderCategoriasFiltradas(campoBusca?.value || '');
}

// ── Pendentes de Contabilização ─────────────────────────────────
function renderPendentesRevisao() {
  const grid = document.getElementById('pendentes-revisao-grid');
  const bloco = document.getElementById('pendentes-revisao-bloco');
  if (!grid || !bloco) return;

  const pendentes = categoriasCache.filter(c => c.revisado === false);

  if (!pendentes.length) {
    bloco.classList.add('hidden');
    grid.innerHTML = '';
    return;
  }

  bloco.classList.remove('hidden');

  grid.innerHTML = pendentes.map(c => {
    const cliente   = allClientes.find(cl => cl.id === c.cliente_id);
    const isReceita = c.tipo === 'receita';

    // Código/seção contábil pra onde essa categoria provavelmente vai
    // cair assim que for confirmada — só um preview, não altera nada
    // no banco (a confirmação continua exatamente igual a antes).
    const infoGrupo = (typeof obterCodigoGrupo === 'function')
      ? obterCodigoGrupo(c.tipo, c.grupo)
      : null;
    const sugestaoLabel = infoGrupo
      ? `${infoGrupo.codigo} — ${infoGrupo.label}`
      : (GRUPO_LABEL[c.grupo] || c.grupo || 'sem grupo');

    return `
      <div class="card card--pendente" data-cat-id="${c.id}">
        <div class="card-header-row">
          <div>
            <p class="card-name">${escaparHtml(c.nome)}</p>
            <p class="card-sub">Criada por ${escaparHtml(cliente?.nome) || 'cliente desconhecido'}</p>
            <p class="card-sub">Sugestão atual: ${sugestaoLabel}</p>
          </div>
          <span class="risk-badge ${isReceita ? 'verde' : 'cinza'}">${isReceita ? 'Receita' : 'Despesa'}</span>
        </div>
        <div class="card-actions">
          <button class="btn-card editar btn-ajustar-pendente" data-id="${c.id}">✏️ Ajustar</button>
          <button class="btn-card confirmar btn-confirmar-pendente" data-id="${c.id}" data-nome="${escaparHtml(c.nome)}">✓ Confirmar</button>
        </div>
        <div class="card-actions">
          <button class="btn-card mesclar btn-mesclar" data-id="${c.id}" data-nome="${escaparHtml(c.nome)}">🔀 Mesclar em outra categoria</button>
        </div>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.btn-ajustar-pendente').forEach(btn => {
    btn.addEventListener('click', () => {
      const cat = categoriasCache.find(c => c.id === btn.dataset.id);
      if (cat) abrirModalCategoria(cat);
    });
  });

  grid.querySelectorAll('.btn-confirmar-pendente').forEach(btn => {
    btn.addEventListener('click', (e) => confirmarPendenteSemAlterar(btn.dataset.id, btn.dataset.nome, e.currentTarget));
  });

  grid.querySelectorAll('.btn-mesclar').forEach(btn => {
    btn.addEventListener('click', () => abrirModalMesclarCategoria(btn.dataset.id, btn.dataset.nome));
  });
}

/**
 * Aprova a classificação atual (grupo sugerido) sem abrir o modal.
 * ATUALIZAÇÃO DE PERFORMANCE: aplica a mudança primeiro na UI (local,
 * instantâneo) e só depois confirma no servidor — se o servidor
 * recusar, reverte e avisa.
 */
async function confirmarPendenteSemAlterar(id, nome, botaoClicado) {
  const cat = categoriasCache.find(c => c.id === id);
  if (!cat) return;

  if (botaoClicado) { botaoClicado.disabled = true; botaoClicado.textContent = '✓ Confirmando...'; }

  const valorAnterior = cat.revisado;
  cat.revisado = true;
  renderPendentesRevisao();
  renderCategoriasFiltradas(document.getElementById('categoria-busca')?.value || '');
  showToast(`"${nome}" confirmada!`);

  const { error } = await supabaseClient
    .from('categorias')
    .update({ revisado: true })
    .eq('id', id);

  if (error) {
    const catAtual = categoriasCache.find(c => c.id === id);
    if (catAtual) catAtual.revisado = valorAnterior;
    renderPendentesRevisao();
    renderCategoriasFiltradas(document.getElementById('categoria-busca')?.value || '');
    showToast('Erro ao confirmar no servidor: ' + error.message, 'error');
  }
}

/**
 * Renderiza a grade principal de categorias agrupada por SEÇÃO
 * CONTÁBIL (estilo plano de contas real) em vez de uma lista plana.
 */
function renderCategoriasFiltradas(termoBusca) {
  const grid  = document.getElementById('categorias-grid');
  if (!grid) return;

  const termo = normalizarTextoBusca(termoBusca);
  const lista = termo
    ? categoriasCache.filter(c => normalizarTextoBusca(c.nome).includes(termo))
    : categoriasCache;

  if (!categoriasCache.length) {
    grid.innerHTML = `
      <p class="empty-state">
        Nenhuma categoria cadastrada ainda.<br>
        Sem categorias aqui, os clientes NÃO conseguem registrar transações.<br>
        Clique em "+ Adicionar Categoria" para começar.
      </p>`;
    return;
  }

  if (!lista.length) {
    grid.innerHTML = `<p class="empty-state">Nenhuma categoria encontrada para "${escaparHtml(termoBusca)}".</p>`;
    return;
  }

  let html = '';

  ORDEM_PLANO_DE_CONTAS.forEach(({ tipo, grupo }) => {
    const itensDoGrupo = lista.filter(c => c.tipo === tipo && c.grupo === grupo);
    if (!itensDoGrupo.length) return;

    const infoGrupo = (typeof obterCodigoGrupo === 'function')
      ? obterCodigoGrupo(tipo, grupo)
      : { codigo: '', label: GRUPO_LABEL[grupo] || grupo };

    html += montarSecaoPlanoDeContas(infoGrupo, itensDoGrupo);
  });

  const chavesConhecidas = new Set(ORDEM_PLANO_DE_CONTAS.map(g => `${g.tipo}__${g.grupo}`));
  const orfas = lista.filter(c => !chavesConhecidas.has(`${c.tipo}__${c.grupo}`));
  if (orfas.length) {
    html += montarSecaoPlanoDeContas({ codigo: '9', label: 'Outras / Sem Grupo Definido' }, orfas);
  }

  grid.innerHTML = html;

  grid.querySelectorAll('.btn-card.editar').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { data: c, error } = await supabaseClient
        .from('categorias').select('*').eq('id', btn.dataset.id).single();
      if (error) { showToast('Erro ao carregar categoria: ' + error.message, 'error'); return; }
      if (c) abrirModalCategoria(c);
    });
  });

  grid.querySelectorAll('.btn-card.deletar').forEach(btn => {
    btn.addEventListener('click', () => confirmarDeletarCategoria(btn.dataset.id, btn.dataset.nome));
  });

  grid.querySelectorAll('.btn-card.mesclar').forEach(btn => {
    btn.addEventListener('click', () => abrirModalMesclarCategoria(btn.dataset.id, btn.dataset.nome));
  });
}

/**
 * Ordena os itens de uma seção: primeiro pelo `codigo_contabil` REAL
 * (quando existe), com quem não tem código ficando por último e
 * ordenado só por nome.
 */
function montarSecaoPlanoDeContas(infoGrupo, itens) {
  const itensOrdenados = [...itens].sort((a, b) => {
    if (a.codigo_contabil && b.codigo_contabil) {
      return a.codigo_contabil.localeCompare(b.codigo_contabil, 'pt-BR', { numeric: true });
    }
    if (a.codigo_contabil) return -1;
    if (b.codigo_contabil) return 1;
    return a.nome.localeCompare(b.nome, 'pt-BR');
  });

  return `
    <div class="plano-contas-secao">
      <div class="plano-contas-secao__header">
        <span class="plano-contas-secao__codigo">${infoGrupo.codigo}</span>
        <span class="plano-contas-secao__label">${infoGrupo.label}</span>
        <span class="plano-contas-secao__contador">${itens.length} conta${itens.length > 1 ? 's' : ''}</span>
      </div>
      <div class="plano-contas-secao__grid">
        ${itensOrdenados.map((c, idx) => renderCardCategoria(c, infoGrupo.codigo, idx + 1)).join('')}
      </div>
    </div>
  `;
}

/**
 * @param {string} codigoGrupoFallback - código do GRUPO (ex: "2.1"),
 *   usado só se a categoria não tiver `codigo_contabil` próprio salvo.
 * @param {number} indiceFallback - posição dentro da seção, usada só
 *   pra montar o código de fallback (ex: "2.1.03").
 */
function renderCardCategoria(c, codigoGrupoFallback, indiceFallback) {
  const isReceita   = c.tipo === 'receita';
  const cliente      = c.cliente_id ? allClientes.find(cl => cl.id === c.cliente_id) : null;
  const qtdSinonimos = Array.isArray(c.palavras_chave) ? c.palavras_chave.length : 0;

  const codigoConta = c.codigo_contabil
    ? c.codigo_contabil
    : (codigoGrupoFallback ? `${codigoGrupoFallback}.${String(indiceFallback).padStart(2, '0')}` : '');

  return `
    <div class="card">
      <div class="card-header-row">
        <div>
          <p class="card-name">${codigoConta ? `<span class="conta-codigo">${escaparHtml(codigoConta)}</span>` : ''}${escaparHtml(c.nome)}</p>
          <p class="card-sub">${cliente ? `pessoal de ${escaparHtml(cliente.nome)}` : 'Categoria global'}</p>
          ${qtdSinonimos > 0 ? `<p class="card-sub">🔑 ${qtdSinonimos} sinônimo${qtdSinonimos > 1 ? 's' : ''} cadastrado${qtdSinonimos > 1 ? 's' : ''}</p>` : ''}
        </div>
        <span class="risk-badge ${isReceita ? 'verde' : 'cinza'}">${isReceita ? 'Receita' : 'Despesa'}</span>
      </div>
      <div class="card-actions">
        <button class="btn-card editar" data-id="${c.id}">✏️ Editar</button>
        <button class="btn-card deletar" data-id="${c.id}" data-nome="${escaparHtml(c.nome)}">🗑️ Deletar</button>
      </div>
      <div class="card-actions">
        <button class="btn-card mesclar" data-id="${c.id}" data-nome="${escaparHtml(c.nome)}">🔀 Mesclar</button>
      </div>
    </div>
  `;
}

async function abrirModalCategoria(item) {
  categoriaEmEdicao = item;

  if (!allClientes.length) await loadAllClientes();

  document.getElementById('modal-categoria-title').textContent =
    item ? '✏️ Editar Categoria' : '🏷️ Adicionar Categoria';

  document.getElementById('categoria-id').value   = item?.id   || '';
  document.getElementById('categoria-nome').value = item?.nome || '';
  document.getElementById('categoria-tipo').value = item?.tipo || 'receita';

  const campoPalavrasChave = document.getElementById('categoria-palavras-chave');
  if (campoPalavrasChave) {
    campoPalavrasChave.value = Array.isArray(item?.palavras_chave) ? item.palavras_chave.join(', ') : '';
  }

  const campoCodigo = document.getElementById('categoria-codigo-contabil');
  if (campoCodigo) {
    campoCodigo.value = item?.codigo_contabil || '';
  }

  // Alcance: Global (cliente_id nulo) ou Específica de um cliente.
  const campoAlcance = document.getElementById('categoria-alcance');
  if (campoAlcance) {
    campoAlcance.value = item?.cliente_id ? 'pessoal' : 'global';
  }
  popularSelectClienteCategoria(item?.cliente_id || '');
  atualizarVisibilidadeCampoCliente();

  atualizarOpcoesDeGrupo(item?.grupo);
  openModal('modal-categoria');
}

/**
 * Mostra/esconde o seletor de cliente conforme o Alcance escolhido —
 * "Global" não precisa de cliente nenhum; "Específica de um cliente"
 * exige escolher qual (validado em salvarCategoria()).
 */
function atualizarVisibilidadeCampoCliente() {
  const alcance = document.getElementById('categoria-alcance')?.value;
  const wrapper = document.getElementById('categoria-cliente-wrapper');
  wrapper?.classList.toggle('hidden', alcance !== 'pessoal');
}

function popularSelectClienteCategoria(clienteIdSelecionado) {
  const select = document.getElementById('categoria-cliente-select');
  if (!select) return;

  select.innerHTML = allClientes
    .slice()
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
    .map(c => `<option value="${c.id}" ${c.id === clienteIdSelecionado ? 'selected' : ''}>${escaparHtml(c.nome)}</option>`)
    .join('') || '<option value="">Nenhum cliente cadastrado</option>';
}

function atualizarOpcoesDeGrupo(grupoSelecionado) {
  const tipo   = document.getElementById('categoria-tipo').value;
  const select = document.getElementById('categoria-grupo');
  const opcoes = GRUPOS_POR_TIPO[tipo] || [];

  select.innerHTML = opcoes.map(o =>
    `<option value="${o.value}" ${grupoSelecionado === o.value ? 'selected' : ''}>${o.label}</option>`
  ).join('');
}

async function salvarCategoria() {
  const id    = document.getElementById('categoria-id').value;
  const nome  = document.getElementById('categoria-nome').value.trim();
  const tipo  = document.getElementById('categoria-tipo').value;
  const grupo = document.getElementById('categoria-grupo').value;
  const codigoContabil = document.getElementById('categoria-codigo-contabil')?.value.trim() || null;

  const alcance          = document.getElementById('categoria-alcance')?.value || 'global';
  const clienteIdEscolhido = document.getElementById('categoria-cliente-select')?.value || '';

  const palavrasChaveTexto = document.getElementById('categoria-palavras-chave')?.value.trim() || '';
  const palavrasChave = palavrasChaveTexto
    ? [...new Set(palavrasChaveTexto.split(',').map(p => p.trim()).filter(Boolean))]
    : [];

  if (!nome)  { showToast('Informe o nome da categoria.', 'error'); return; }
  if (!grupo) { showToast('Selecione um grupo.', 'error'); return; }
  if (alcance === 'pessoal' && !clienteIdEscolhido) {
    showToast('Selecione o cliente desta categoria específica.', 'error');
    return;
  }

  const payload = {
    nome, tipo, grupo, revisado: true,
    palavras_chave: palavrasChave,
    codigo_contabil: codigoContabil,
    cliente_id: alcance === 'pessoal' ? clienteIdEscolhido : null
  };

  const btn = document.getElementById('btn-salvar-categoria');
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }

  let error;
  if (id) {
    ({ error } = await supabaseClient.from('categorias').update(payload).eq('id', id));
  } else {
    ({ error } = await supabaseClient.from('categorias').insert(payload));
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Salvar'; }

  if (error) {
    showToast('Erro ao salvar: ' + error.message, 'error');
    return;
  }

  showToast(id ? 'Categoria atualizada!' : 'Categoria adicionada!');
  closeModal('modal-categoria');
  renderCategorias();
}

/**
 * Excluir categoria. Se algum lançamento usa a categoria, o banco não
 * deixa apagar (os lançamentos ficariam sem categoria) — então o admin
 * escolhe para onde eles vão, no modal de mesclagem em modo "excluir".
 */
async function confirmarDeletarCategoria(id, nome) {
  const { count, error: errCount } = await supabaseClient
    .from('transacoes')
    .select('id', { count: 'exact', head: true })
    .eq('categoria_id', id);

  if (errCount) {
    showToast('Não consegui verificar os lançamentos desta categoria: ' + errCount.message, 'error');
    return;
  }

  if (count > 0) {
    abrirModalMesclarCategoria(id, nome, { modoExcluir: true, qtdLancamentos: count });
    return;
  }

  if (!confirm(`Excluir a categoria "${nome}"?\n\nNenhum lançamento usa esta categoria. As regras de classificação ligadas a ela também serão apagadas.`)) return;

  const { error } = await supabaseClient.from('categorias').delete().eq('id', id);

  if (error) {
    showToast('Erro ao excluir: ' + error.message, 'error');
    return;
  }

  showToast(`Categoria "${nome}" excluída.`);
  renderCategorias();
}

// ══════════════════════════════════════════════════════════════
// MESCLAR CATEGORIAS (também usado para EXCLUIR categoria em uso)
// ══════════════════════════════════════════════════════════════
/**
 * Consolida duas categorias (ex: "Unha" e "Manicure"). Move TODAS as
 * transações, regras aprendidas e regras globais da ORIGEM para o
 * DESTINO, depois apaga a origem. Só oferece como destino categorias do
 * MESMO tipo (receita/despesa) da origem.
 *
 * opcoes.modoExcluir: mesmo fluxo, com textos de "excluir categoria em
 * uso" (o admin clicou em 🗑️ numa categoria que tem lançamentos).
 */
let modoMesclagemAtual = { modoExcluir: false, qtdLancamentos: 0 };

function abrirModalMesclarCategoria(origemId, origemNome, opcoes = {}) {
  const origemCat = categoriasCache.find(c => c.id === origemId);
  if (!origemCat) { showToast('Categoria não encontrada — recarregue a página.', 'error'); return; }

  modoMesclagemAtual = { modoExcluir: !!opcoes.modoExcluir, qtdLancamentos: opcoes.qtdLancamentos || 0 };

  document.getElementById('mesclar-origem-id').value = origemId;

  const titulo = document.getElementById('modal-mesclar-title');
  const btn    = document.getElementById('btn-confirmar-mesclagem');
  const desc   = document.getElementById('mesclar-origem-descricao');

  if (modoMesclagemAtual.modoExcluir) {
    const n = modoMesclagemAtual.qtdLancamentos;
    if (titulo) titulo.textContent = '🗑️ Excluir categoria em uso';
    if (desc) desc.textContent =
      `"${origemNome}" é usada em ${n} lançamento${n > 1 ? 's' : ''} de clientes. ` +
      `Para excluir, escolha para qual categoria ${n > 1 ? 'esses lançamentos vão' : 'esse lançamento vai'}:`;
    if (btn) btn.textContent = 'Mover lançamentos e excluir';
  } else {
    if (titulo) titulo.textContent = '🔀 Mesclar Categoria';
    if (desc) desc.textContent = `Mover todas as transações de "${origemNome}" para:`;
    if (btn) btn.textContent = 'Mesclar e Deletar Origem';
  }

  const select = document.getElementById('mesclar-destino-select');
  // Destino: mesmo tipo, e global ou pessoal do MESMO cliente — nunca
  // jogar lançamentos de um cliente na categoria pessoal de outro.
  const candidatas = categoriasCache.filter(c =>
    c.id !== origemId && c.tipo === origemCat.tipo &&
    (!c.cliente_id || c.cliente_id === origemCat.cliente_id));

  if (!candidatas.length) {
    select.innerHTML = '<option value="">Nenhuma outra categoria do mesmo tipo disponível</option>';
  } else {
    select.innerHTML = candidatas
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
      .map(c => `<option value="${c.id}">${c.codigo_contabil ? `[${escaparHtml(c.codigo_contabil)}] ` : ''}${escaparHtml(c.nome)}${c.cliente_id ? ' (pessoal)' : ''}</option>`)
      .join('');
  }

  openModal('modal-mesclar-categoria');
}

async function confirmarMesclagemCategoria() {
  const origemId  = document.getElementById('mesclar-origem-id').value;
  const destinoId = document.getElementById('mesclar-destino-select').value;

  if (!origemId || !destinoId) { showToast('Selecione a categoria de destino.', 'error'); return; }
  if (origemId === destinoId)  { showToast('A categoria de destino precisa ser diferente da origem.', 'error'); return; }

  const origemCat  = categoriasCache.find(c => c.id === origemId);
  const destinoCat = categoriasCache.find(c => c.id === destinoId);
  const excluindo  = modoMesclagemAtual.modoExcluir;

  const pergunta = excluindo
    ? `Mover os lançamentos de "${origemCat?.nome}" para "${destinoCat?.nome}" e excluir "${origemCat?.nome}"?\n\nEsta ação não pode ser desfeita.`
    : `Mesclar "${origemCat?.nome}" em "${destinoCat?.nome}"?\n\nTodas as transações e regras serão movidas, e "${origemCat?.nome}" será DELETADA. Esta ação não pode ser desfeita.`;
  if (!confirm(pergunta)) return;

  const btn = document.getElementById('btn-confirmar-mesclagem');
  const textoBotao = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = excluindo ? 'Excluindo...' : 'Mesclando...'; }

  try {
    // Sinônimos da origem (e o próprio nome dela) passam para o destino,
    // para descrições futuras continuarem sendo reconhecidas.
    const palavrasOrigem    = Array.isArray(origemCat?.palavras_chave)  ? origemCat.palavras_chave  : [];
    const palavrasDestino   = Array.isArray(destinoCat?.palavras_chave) ? destinoCat.palavras_chave : [];
    const palavrasMescladas = [...new Set([...palavrasDestino, ...palavrasOrigem, origemCat?.nome].filter(Boolean))];

    const { error: errPalavras } = await supabaseClient
      .from('categorias')
      .update({ palavras_chave: palavrasMescladas })
      .eq('id', destinoId);
    if (errPalavras) throw errPalavras;

    const { error: errTransacoes } = await supabaseClient
      .from('transacoes')
      .update({ categoria_id: destinoId })
      .eq('categoria_id', origemId);
    if (errTransacoes) throw errTransacoes;

    const { error: errRegras } = await supabaseClient
      .from('regras_aprendidas')
      .update({ categoria_id: destinoId })
      .eq('categoria_id', origemId);
    if (errRegras) throw errRegras;

    // Regras globais: antes eram apagadas em cascata junto com a origem
    const { error: errGlobais } = await supabaseClient
      .from('regras_globais')
      .update({ categoria_id: destinoId })
      .eq('categoria_id', origemId);
    if (errGlobais && !/does not exist|schema cache/i.test(errGlobais.message || '')) throw errGlobais;

    // Confere se sobrou algum lançamento preso à origem (ex.: bloqueado
    // por permissão) antes de tentar apagar — evita o erro de FK cru.
    const { count: restantes } = await supabaseClient
      .from('transacoes')
      .select('id', { count: 'exact', head: true })
      .eq('categoria_id', origemId);
    if (restantes > 0) {
      throw new Error(`${restantes} lançamento(s) não puderam ser movidos. Nada foi excluído.`);
    }

    const { error: errDelete } = await supabaseClient
      .from('categorias')
      .delete()
      .eq('id', origemId);
    if (errDelete) throw errDelete;

    showToast(excluindo
      ? `"${origemCat?.nome}" excluída. Lançamentos movidos para "${destinoCat?.nome}".`
      : `"${origemCat?.nome}" mesclada em "${destinoCat?.nome}"!`);
    closeModal('modal-mesclar-categoria');
    renderCategorias();
  } catch (err) {
    showToast((excluindo ? 'Erro ao excluir: ' : 'Erro ao mesclar: ') + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = textoBotao; }
  }
}

console.log('✅ categorias.js carregado (Plano de Contas + Mesclar + Excluir categoria em uso)');
