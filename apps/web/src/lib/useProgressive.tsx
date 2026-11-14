import { useEffect, useRef, useState } from 'react';

/**
 * Lista grande montada aos poucos: começa com `initial` itens e acrescenta `step` cada vez que a
 * pessoa chega perto do fim (a `<Sentinel/>` devolvida vai logo depois da lista, dentro de um
 * elemento `relative`). Somas, seleção e ordenação continuam sobre a lista inteira — só o que é
 * desenhado é que cresce. `resetKey` mudou (outro mês, outro filtro, outra ordem) → volta ao começo.
 */
export function useProgressive<T>(items: T[], resetKey: string, initial = 60, step = 60) {
  const [state, setState] = useState({ key: resetKey, n: initial });
  // troca de filtro: volta ao começo já neste desenho (sem passar por um quadro com a lista inteira)
  const n = state.key === resetKey ? state.n : initial;
  if (state.key !== resetKey) setState({ key: resetKey, n: initial });
  const more = items.length > n;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !more) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setState((s) => ({ key: s.key, n: s.n + step }));
    });
    io.observe(el);
    return () => io.disconnect();
    // `n` entra para observar de novo depois de cada leva (a sentinela pode continuar na tela)
  }, [more, n, step]);
  return {
    visible: more ? items.slice(0, n) : items,
    /** Faixa invisível de 1200 px que termina no fim da lista: encostou nela, vem a próxima leva. */
    sentinel: more ? <div ref={ref} aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[1200px]" /> : null,
    hidden: more ? items.length - n : 0,
  };
}
