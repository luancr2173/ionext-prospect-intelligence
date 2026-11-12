/* Aplica o tema antes de pintar a página (evita piscar). Claro/escuro salvo no navegador; padrão = sistema. */
(function () {
  var t = null;
  try { t = localStorage.getItem('ionext-tema'); } catch (e) { /* sem storage */ }
  if (t !== 'light' && t !== 'dark') t = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
})();
