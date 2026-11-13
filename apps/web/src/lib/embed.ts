/**
 * Modo embutido: o NoPaper aberto dentro de outro sistema (iframe), que já tem o próprio menu.
 * Vale quando a página está num quadro ou quando o endereço chegou com `?embed=1` (fica guardado
 * na aba, então sobrevive à navegação, ao recarregar e ao login; `?embed=0` desliga).
 * Quem pode embutir é decidido no servidor (`EMBED_ALLOWED_ORIGINS`), não aqui.
 */
const KEY = 'np:embed';

function detect(): boolean {
  let framed = false;
  try { framed = window.self !== window.top; } catch { framed = true; }
  let stored = false;
  try {
    const q = new URLSearchParams(window.location.search).get('embed');
    if (q === '1') sessionStorage.setItem(KEY, '1');
    if (q === '0') sessionStorage.removeItem(KEY);
    stored = sessionStorage.getItem(KEY) === '1';
  } catch { /* sem armazenamento: vale só o quadro */ }
  return framed || stored;
}

export const EMBEDDED = typeof window !== 'undefined' && detect();

/**
 * Avisa a página de fora em que tela o NoPaper está, para ela marcar o item certo no próprio menu.
 * Vai só o caminho (nada de dados), e só chega a quem o servidor deixou embutir.
 */
export function notifyHost(path: string) {
  if (!EMBEDDED) return;
  try { if (window.parent !== window) window.parent.postMessage({ source: 'nopaper', type: 'route', path }, '*'); } catch { /* sem página de fora */ }
}
