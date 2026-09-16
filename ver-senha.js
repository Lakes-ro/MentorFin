/**
 * VER-SENHA.JS — Olhinho de "mostrar senha" nos campos de login e
 * cadastro (index.html / client.html).
 *
 * Por que existe: sem isto, errar a senha num teclado de celular é uma
 * aposta às cegas — a pessoa só descobre o erro de digitação depois do
 * "credenciais inválidas", e na tela de cadastro o erro só aparece na
 * confirmação, obrigando a redigitar as duas.
 *
 * Delegação de evento no documento: as telas de login/cadastro trocam
 * de visibilidade por classe (não são recriadas), mas a delegação
 * também cobre qualquer campo de senha adicionado depois — basta
 * envolvê-lo em `.input-senha` com um botão `.btn-ver-senha` apontando
 * para o id do input via `data-alvo`.
 */

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-ver-senha');
  if (!btn) return;

  const input = document.getElementById(btn.dataset.alvo);
  if (!input) return;

  const revelando = input.type === 'password';
  input.type = revelando ? 'text' : 'password';
  btn.textContent = revelando ? '🙈' : '👁️';
  btn.title = revelando ? 'Ocultar senha' : 'Mostrar senha';
  btn.setAttribute('aria-label', btn.title);
  btn.setAttribute('aria-pressed', revelando ? 'true' : 'false');

  // Devolve o cursor ao fim do texto: sem isto, o clique no olhinho
  // tira o foco do campo e a pessoa tem de clicar de novo pra continuar
  // digitando.
  input.focus();
  const fim = input.value.length;
  try { input.setSelectionRange(fim, fim); } catch (_) { /* type=email etc. */ }
});

console.log('✅ ver-senha.js carregado');
