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
 * O plano de contas do modelo fornecido (1.0.0 Receitas / 2.0.0
 * Despesas Fixas / 3.0.0 Investimentos / 4.0.0 Estilo de Vida, com
 * contas granulares tipo "2.1.4 Energia Elétrica") foi aplicado
 * direto no banco — cada categoria do modelo agora tem um código real
 * salvo em `codigo_contabil` (ex: "2.1.4"), não mais calculado só na
 * hora de exibir. A grade prioriza esse código real quando ele existe;
 * categorias mais antigas/pessoais que ainda não têm código (ex:
 * "Lazer", "Moradia", categorias criadas por clientes) continuam
 * caindo no código de GRUPO calculado (obterCodigoGrupo, de
 * contabilidade.js) como fallback — nada quebra, nenhuma categoria
 * "some" da tela por falta de código.
 *
 * ATUALIZAÇÃO — MESCLAR CATEGORIAS (RESOLVE DUPLICATAS/PROLIFERAÇÃO):
 * Ferramenta nova pra consolidar categorias que acabam virando
 * sinônimos umas das outras com o tempo (ex: cliente cria "Unha",
 * depois "Manicure" — mesma coisa, duas categorias). O botão
 * "🔀 Mesclar" (em qualquer card, inclusive nos Pendentes de
 * Contabilização) abre um modal pra escolher a categoria de destino;
 * ao confirmar, TODAS as transações e regras aprendidas da categoria
 * de origem são movidas pra categoria de destino, e a origem é
 * apagada. Ação destrutiva e irreversível — por isso pede confirmação
 * dupla (o modal + um `confirm()` nativo do navegador).
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
    .replace(/[\u0300-\u036f]/g, '')
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
    grid.innerHTML = `<p class="empty-state">Nenhuma categoria encontrada para "${termoBusca}".</p>`;
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
 * (quando existe — string compara certo até 2 dígitos por segmento,
 * que é o que o plano de contas atual usa), com quem não tem código
 * ficando por último e ordenado só por nome.
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

  // Prioriza o código REAL salvo no banco (plano de contas do
  // modelo); só usa o código calculado por posição quando a categoria
  // não tem codigo_contabil próprio (ex: categorias mais antigas ou
  // criadas por clientes, que ainda não foram encaixadas no modelo).
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

  // Alcance: Global (cliente_id nulo) ou Específica de um cliente —
  // ver MIGRACAO nenhuma necessária, coluna já existia (categorias.cliente_id).
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

async function confirmarDeletarCategoria(id, nome) {
  if (!confirm(`Tem certeza que deseja deletar a categoria "${nome}"? Transações que já usam essa categoria podem ficar órfãs. Se o objetivo é juntar com outra categoria, use "🔀 Mesclar" em vez de deletar.`)) return;

  const { error } = await supabaseClient.from('categorias').delete().eq('id', id);

  if (error) {
    showToast('Erro ao deletar (pode haver transações usando essa categoria): ' + error.message, 'error');
    return;
  }

  showToast('Categoria removida.');
  renderCategorias();
}

// ══════════════════════════════════════════════════════════════
// MESCLAR CATEGORIAS
// ══════════════════════════════════════════════════════════════
/**
 * Consolida duas categorias que acabaram virando a mesma coisa (ex:
 * "Unha" e "Manicure"). Move TODAS as transações e regras aprendidas
 * da categoria de ORIGEM pra categoria de DESTINO, depois apaga a
 * origem. Só oferece como destino categorias do MESMO tipo
 * (receita/despesa) da origem, pra nunca misturar uma conta de
 * entrada com uma de saída.
 */
function abrirModalMesclarCategoria(origemId, origemNome) {
  const origemCat = categoriasCache.find(c => c.id === origemId);
  if (!origemCat) { showToast('Categoria não encontrada — recarregue a página.', 'error'); return; }

  document.getElementById('mesclar-origem-id').value = origemId;
  document.getElementById('mesclar-origem-descricao').textContent =
    `Mover todas as transações de "${origemNome}" para:`;

  const select = document.getElementById('mesclar-destino-select');
  const candidatas = categoriasCache.filter(c => c.id !== origemId && c.tipo === origemCat.tipo);

  if (!candidatas.length) {
    select.innerHTML = '<option value="">Nenhuma outra categoria do mesmo tipo disponível</option>';
  } else {
    select.innerHTML = candidatas
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
      .map(c => `<option value="${c.id}">${c.codigo_contabil ? `[${escaparHtml(c.codigo_contabil)}] ` : ''}${escaparHtml(c.nome)}</option>`)
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

  if (!confirm(`Mesclar "${origemCat?.nome}" em "${destinoCat?.nome}"?\n\nTodas as transações e regras aprendidas serão movidas, e "${origemCat?.nome}" será DELETADA. Esta ação não pode ser desfeita.`)) {
    return;
  }

  const btn = document.getElementById('btn-confirmar-mesclagem');
  if (btn) { btn.disabled = true; btn.textContent = 'Mesclando...'; }

  try {
    // ⚠️ CORREÇÃO — SINÔNIMOS SE PERDIAM NA MESCLAGEM: antes, só as
    // transações e regras_aprendidas eram movidas pra categoria de
    // destino — os `palavras_chave` (sinônimos) da categoria de
    // ORIGEM eram simplesmente perdidos quando ela era deletada.
    // Também é essencial incluir o NOME da categoria de origem como
    // sinônimo do destino: sem isso, depois da mesclagem, qualquer
    // descrição futura que batesse com o nome da categoria apagada
    // (ex: "Unha", mesclada em "Salão de Beleza") deixaria de ser
    // reconhecida por completo, porque a categoria "Unha" não existe
    // mais pra bater consigo mesma.
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

    const { error: errDelete } = await supabaseClient
      .from('categorias')
      .delete()
      .eq('id', origemId);
    if (errDelete) throw errDelete;

    showToast(`"${origemCat?.nome}" mesclada em "${destinoCat?.nome}"!`);
    closeModal('modal-mesclar-categoria');
    renderCategorias();
  } catch (err) {
    showToast('Erro ao mesclar: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Mesclar e Deletar Origem'; }
  }
}

console.log('✅ categorias.js carregado (Plano de Contas com código real + Mesclar Categorias)');