import { useCallback, useSyncExternalStore } from 'react';

/** Acompanha uma media query (ex.: `(min-width: 1280px)`) para montar só o layout que está na tela. */
export function useMedia(query: string) {
  const subscribe = useCallback((cb: () => void) => {
    const m = window.matchMedia(query);
    m.addEventListener('change', cb);
    return () => m.removeEventListener('change', cb);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}
