import type { ReactNode } from 'react';

/**
 * Markdown mínimo para as notas das releases (o formato do CHANGELOG): títulos `#`, listas `-`/`*`,
 * parágrafos, **negrito**, `código` e [links](https://…). Gera elementos React — nunca injeta HTML.
 */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+|[^)\s]+\.md[^)\s]*)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[2]) out.push(<strong key={k} className="font-semibold text-ink">{m[2]}</strong>);
    else if (m[3]) out.push(<code key={k} className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em]">{m[3]}</code>);
    else if (m[4]) {
      const href = /^https?:\/\//.test(m[5]) ? m[5] : null;
      out.push(href ? <a key={k} href={href} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">{m[4]}</a> : <span key={k}>{m[4]}</span>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) { blocks.push(<p key={`p${blocks.length}`} className="leading-relaxed">{inline(para.join(' '), `p${blocks.length}`)}</p>); para = []; }
    if (list.length) {
      const items = list;
      blocks.push(<ul key={`u${blocks.length}`} className="ml-5 list-disc space-y-1 marker:text-faint">{items.map((it, j) => <li key={j} className="leading-relaxed">{inline(it, `l${blocks.length}-${j}`)}</li>)}</ul>);
      list = [];
    }
  };
  for (const raw of source.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (!line.trim()) { flush(); continue; }
    if (h) { flush(); blocks.push(<h4 key={`h${blocks.length}`} className="mt-1 font-display text-sm font-semibold text-ink">{inline(h[2], `h${blocks.length}`)}</h4>); continue; }
    if (li) { if (para.length) flush(); list.push(li[1]); continue; }
    if (list.length && /^\s{2,}\S/.test(raw)) { list[list.length - 1] += ` ${line.trim()}`; continue; }
    if (list.length) flush();
    para.push(line.trim());
  }
  flush();
  return <div className={className ?? 'flex flex-col gap-2 text-sm text-muted'}>{blocks}</div>;
}
