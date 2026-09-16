/**
 * PRIVACIDADE.JS — Modo Privacidade (os "olhinhos")
 * Padrão: script global. Sem import/export.
 *
 * PROBLEMA QUE RESOLVE: o admin abre o painel em reunião, aula,
 * apresentação ou com a tela compartilhada, e nome + email de TODOS os
 * clientes ficam expostos. Este módulo embaça (blur) esses dados sem
 * remover nada do sistema — é só camada visual, o dado continua ali e
 * volta com um clique.
 *
 * DOIS NÍVEIS, PROPOSITALMENTE:
 *   1) Botão global (👁️ no cabeçalho): liga/desliga o blur de TODOS os
 *      cards de uma vez. O estado fica salvo em localStorage, então
 *      sobrevive a F5 — quem ligou o modo antes de apresentar não
 *      corre o risco de a tela voltar aberta sozinha.
 *   2) Olhinho de cada card: exceção individual. Com o modo global
 *      LIGADO, revela só aquele card (para conferir um cliente sem
 *      expor os outros). Com o modo global DESLIGADO, esconde só
 *      aquele card.
 *
 * Qualquer elemento que receba a classe `.dado-sensivel` entra no
 * esquema automaticamente — para cobrir uma tela nova, basta marcar o
 * elemento com essa classe.
 */

const PRIVACIDADE_CHAVE = 'mentorfin:privacidade';

let privacidadeAtiva = false;

function initPrivacidade() {
  privacidadeAtiva = localStorage.getItem(PRIVACIDADE_CHAVE) === '1';
  aplicarEstadoPrivacidadeGlobal();

  document.getElementById('btn-privacidade')
    ?.addEventListener('click', alternarPrivacidadeGlobal);

  // Delegação no documento: os cards são recriados a cada render
  // (renderClientes/renderDashboards), então prender o listener em cada
  // botão exigiria relembrar de religar depois de todo render — e é
  // exatamente esse tipo de esquecimento que faz o olhinho "sumir".
  // As secções renderizam de forma assíncrona (consulta ao banco) e o
  // conteúdo entra DEPOIS do clique na sidebar. Sem reaplicar aqui, o
  // admin trocava de secção e via os dados sem blur até dar F5.
  //
  // ⚠️ Havia aqui um MutationObserver "de segurança" que foi REMOVIDO:
  // ele observava toda a .main-content e, dentro do próprio callback,
  // reescrevia btn.textContent — o que por si só é uma mutação DENTRO
  // da árvore observada. Isso disparava o observer de novo, que
  // reescrevia de novo, num loop infinito e síncrono que consumia a
  // CPU inteira e travava a aba/navegador (e o computador junto). A
  // rede de segurança fica só nos timeouts abaixo, que são finitos.
  window.addEventListener('section:change', () => {
    aplicarEstadoPrivacidadeGlobal();
    setTimeout(aplicarEstadoPrivacidadeGlobal, 400);
    setTimeout(aplicarEstadoPrivacidadeGlobal, 1200);
  });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-olho-card]');
    if (!btn) return;
    const card = btn.closest('.card');
    if (!card) return;
    card.classList.toggle(privacidadeAtiva ? 'card--revelado' : 'card--ocultado');
    atualizarIconeOlho(card);
  });
}

function alternarPrivacidadeGlobal() {
  privacidadeAtiva = !privacidadeAtiva;
  localStorage.setItem(PRIVACIDADE_CHAVE, privacidadeAtiva ? '1' : '0');

  // As exceções individuais são zeradas ao virar a chave global: elas
  // valem para o estado em que foram criadas, e mantê-las produziria
  // um resultado invertido do esperado.
  document.querySelectorAll('.card--revelado, .card--ocultado')
    .forEach(c => c.classList.remove('card--revelado', 'card--ocultado'));

  aplicarEstadoPrivacidadeGlobal();

  if (typeof showToast === 'function') {
    showToast(privacidadeAtiva
      ? '🙈 Modo privacidade ligado — nomes e emails ocultos.'
      : '👁️ Modo privacidade desligado.');
  }
}

function aplicarEstadoPrivacidadeGlobal() {
  document.body.classList.toggle('privacidade-on', privacidadeAtiva);

  const btn = document.getElementById('btn-privacidade');
  if (btn) {
    btn.textContent = privacidadeAtiva ? '🙈' : '👁️';
    btn.classList.toggle('active', privacidadeAtiva);
    btn.title = privacidadeAtiva
      ? 'Modo privacidade LIGADO — clique para mostrar nomes e emails'
      : 'Modo privacidade desligado — clique para ocultar nomes e emails';
    btn.setAttribute('aria-pressed', privacidadeAtiva ? 'true' : 'false');
  }

  document.querySelectorAll('.card').forEach(atualizarIconeOlho);
}

function atualizarIconeOlho(card) {
  const btn = card.querySelector('[data-olho-card]');
  if (!btn) return;
  const oculto = privacidadeAtiva
    ? !card.classList.contains('card--revelado')
    :  card.classList.contains('card--ocultado');
  btn.textContent = oculto ? '🙈' : '👁️';
  btn.setAttribute('aria-pressed', oculto ? 'true' : 'false');
}

/**
 * Chamada pelas telas logo depois de reescrever o innerHTML da grade
 * (clientes.js / dashboards.js): os cards nasceram sem estado nenhum,
 * então só precisam receber o ícone certo do olhinho.
 */
function aplicarPrivacidadeNaGrade(grid) {
  (grid || document).querySelectorAll('.card').forEach(atualizarIconeOlho);
}

console.log('✅ privacidade.js carregado (olhinhos + blur de nomes/emails)');
