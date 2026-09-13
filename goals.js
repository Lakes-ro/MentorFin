/**
 * GOALS.JS - LÓGICA DE METAS (painel do CLIENTE)
 * ================================================
 * ATUALIZAÇÃO — EDITAR/EXCLUIR META (CLIENTE):
 * Antes, o cliente conseguia CRIAR uma meta mas nunca editar/excluir —
 * só o admin tinha essa opção. Agora cada cartão tem botões ✏️/🗑️, que
 * abrem o modal #modalEditarMeta (client.html/index.html) — ver
 * abrirModalEditarMeta()/handleSalvarEdicaoMeta()/handleExcluirMeta()
 * no final deste ficheiro (funções globais, fora do IIFE).
 *
 * Os dados de cada meta ficam gravados como data-attributes no
 * próprio cartão (data-id/nome/necessario/economizado) — assim o
 * modal de edição não depende de nenhum cache interno do módulo (útil
 * porque renderGoals() aqui é chamado com uma lista EXPLÍCITA vinda de
 * loadClientGoals(), sem nunca preencher `allGoals`).
 *
 * NOTA: o "valor_economizado" já é sincronizado automaticamente pelo
 * banco quando uma transação de Investimento é vinculada à meta (ver
 * comentário no topo de dashboard.js sobre os triggers
 * trg_validar_meta_id/trg_sync_valor_economizado_meta) — a edição
 * manual aqui serve para ajustes pontuais, sem afetar esse mecanismo.
 */

const GoalsModule = (() => {
    let allGoals = [];

    const escapar = (str) => (str == null ? '' : String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));

    const formatGoal = (goal) => {
        const necessario   = parseFloat(goal.valor_necessario || 0);
        const economizado  = parseFloat(goal.valor_economizado || 0);
        const progress      = necessario > 0 ? (economizado / necessario) * 100 : 0;
        const progressColor = progress >= 100 ? '#64ff7a' : progress >= 50 ? '#ffd700' : '#6495ff';

        return `
            <div class="meta-card"
                 data-id="${goal.id}"
                 data-nome="${escapar(goal.nome)}"
                 data-necessario="${necessario}"
                 data-economizado="${economizado}">
                <div class="meta-header">
                    <div>
                        <div class="meta-nome">${escapar(goal.nome)}</div>
                        <div class="meta-client">${escapar(goal.clientes?.nome || '')}</div>
                    </div>
                    <div class="meta-card-actions">
                        <button type="button" class="btn-meta-mini editar" data-id="${goal.id}" title="Editar meta">✏️</button>
                        <button type="button" class="btn-meta-mini excluir" data-id="${goal.id}" title="Excluir meta">🗑️</button>
                    </div>
                </div>
                <div class="meta-progress-bar">
                    <div class="meta-progress-fill" style="width: ${Math.min(progress, 100)}%; background: ${progressColor};"></div>
                </div>
                <div class="meta-info">
                    <div class="meta-info-item">
                        <div class="meta-info-label">Economizado</div>
                        <div class="meta-info-value">${UIModule.formatCurrency(economizado)}</div>
                    </div>
                    <div class="meta-info-item">
                        <div class="meta-info-label">Necessário</div>
                        <div class="meta-info-value">${UIModule.formatCurrency(necessario)}</div>
                    </div>
                    <div class="meta-info-item">
                        <div class="meta-info-label">Progresso</div>
                        <div class="meta-info-value">${progress.toFixed(1)}%</div>
                    </div>
                </div>
            </div>
        `;
    };

    return {
        async loadAllGoals(adminId) {
            try {
                allGoals = await DatabaseModule.getMetasByAdmin(adminId);
                return allGoals;
            } catch (error) {
                console.error('❌ Erro ao carregar metas:', error);
                throw error;
            }
        },

        async loadClientGoals(clientId) {
            try {
                const goals = await DatabaseModule.getMetasByClient(clientId);
                return goals;
            } catch (error) {
                console.error('❌ Erro ao carregar metas do cliente:', error);
                throw error;
            }
        },

        async addGoal(goalData) {
            try {
                const result = await DatabaseModule.addMeta(goalData);
                allGoals.push(result);
                return result;
            } catch (error) {
                console.error('❌ Erro ao adicionar meta:', error);
                throw error;
            }
        },

        async updateGoal(goalId, updates) {
            try {
                const result = await DatabaseModule.updateMeta(goalId, updates);
                const index = allGoals.findIndex(g => g.id === goalId);
                if (index !== -1) {
                    allGoals[index] = result;
                }
                return result;
            } catch (error) {
                console.error('❌ Erro ao atualizar meta:', error);
                throw error;
            }
        },

        async deleteGoal(goalId) {
            try {
                await DatabaseModule.deleteMeta(goalId);
                allGoals = allGoals.filter(g => g.id !== goalId);
                return true;
            } catch (error) {
                console.error('❌ Erro ao deletar meta:', error);
                throw error;
            }
        },

        renderGoals(containerId, goals = null) {
            const container = document.getElementById(containerId);
            if (!container) return;

            const goalsToRender = goals || allGoals;
            const html = goalsToRender
                .map(g => formatGoal(g))
                .join('');

            UIModule.setHTML(containerId, html || '<p class="empty-state">Nenhuma meta</p>');
            ligarBotoesDeAcaoDaMeta(container);
        },

        getGoals: () => allGoals
    };
})();

// ══════════════════════════════════════════════════════════════
// EDITAR / EXCLUIR META (CLIENTE) — funções globais, fora do IIFE
// (mesmo padrão de outras ações "ligar após render" já usadas no app)
// ══════════════════════════════════════════════════════════════

function ligarBotoesDeAcaoDaMeta(container) {
    if (!container) return;

    container.querySelectorAll('.btn-meta-mini.editar').forEach(btn => {
        btn.addEventListener('click', () => {
            const card = btn.closest('.meta-card');
            if (card) abrirModalEditarMeta(card.dataset);
        });
    });

    container.querySelectorAll('.btn-meta-mini.excluir').forEach(btn => {
        btn.addEventListener('click', () => {
            const card = btn.closest('.meta-card');
            handleExcluirMeta(btn.dataset.id, card?.dataset.nome || 'esta meta');
        });
    });
}

function abrirModalEditarMeta(dataset) {
    document.getElementById('editMetaId').value          = dataset.id;
    document.getElementById('editMetaNome').value        = dataset.nome;
    document.getElementById('editMetaNecessario').value  = dataset.necessario;
    document.getElementById('editMetaEconomizado').value = dataset.economizado;
    UIModule.openModal('modalEditarMeta');
}

async function handleSalvarEdicaoMeta() {
    const id          = document.getElementById('editMetaId').value;
    const nome        = document.getElementById('editMetaNome').value.trim();
    const necessario  = parseFloat(document.getElementById('editMetaNecessario').value);
    const economizado = parseFloat(document.getElementById('editMetaEconomizado').value);

    if (!nome)                                  { UIModule.showError('Informe o nome da meta.'); return; }
    if (isNaN(necessario) || necessario < 0)    { UIModule.showError('Informe um valor necessário válido.'); return; }
    if (isNaN(economizado) || economizado < 0)  { UIModule.showError('Informe um valor economizado válido.'); return; }

    const btn = document.getElementById('btnSalvarEdicaoMeta');
    if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }

    try {
        await GoalsModule.updateGoal(id, {
            nome,
            valor_necessario:  necessario,
            valor_economizado: economizado
        });

        UIModule.closeModal('modalEditarMeta');
        UIModule.showSuccess('Meta atualizada!');
        await loadClientDashboard();
    } catch (error) {
        UIModule.showError(error.message || 'Erro ao atualizar meta.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Salvar Alterações'; }
    }
}

async function handleExcluirMeta(id, nome) {
    if (!confirm(`Tens a certeza que queres excluir a meta "${nome}"? Esta ação não pode ser desfeita.`)) return;

    try {
        await GoalsModule.deleteGoal(id);
        UIModule.showSuccess('Meta excluída.');
        await loadClientDashboard();
    } catch (error) {
        UIModule.showError(error.message || 'Erro ao excluir meta.');
    }
}

console.log('✅ goals.js carregado (com editar/excluir do lado do cliente)');
