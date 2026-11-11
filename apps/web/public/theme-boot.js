// Roda antes do app: aplica o tema salvo (ou o do sistema) para a página não piscar na cor errada.
// Fica em arquivo próprio para a política de conteúdo (CSP) não precisar permitir scripts embutidos.
try {
  var t = localStorage.getItem('np:theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
} catch (e) { document.documentElement.dataset.theme = 'dark'; }
