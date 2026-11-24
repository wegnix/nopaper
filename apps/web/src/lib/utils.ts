import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...v: ClassValue[]) => twMerge(clsx(v));

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Tela de toque (celular/tablet): troca textos como "arraste" e "clique" por "toque". */
export const isTouch = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

/**
 * Para onde ir depois de entrar: a tela pedida antes do login (guardada pelo `RequireAuth`), inclusive
 * os links do e-mail de alertas (`/pagar?codigo=…`) e as telas abertas pelo modo embutido. Só aceita
 * caminho interno (começa com "/", mas não "//" nem "/\", que levariam a outro site); sem tela pedida → Início.
 * A permissão da tela é conferida depois pelo `AppShell` (`screenAllowed` → `NoAccess`).
 */
export function afterLoginPath(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  return typeof from === 'string' && /^\/(?![\/\\])/.test(from) && !/^\/login(?:[/?#]|$)/.test(from) ? from : '/';
}
