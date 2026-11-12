import { Fragment, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, Download, Globe, ListTree, Monitor, Search, X } from 'lucide-react';
import { PERMISSIONS, formatBRL, formatDateBR, isPermission } from '@nopaper/shared';
import { Button, Card, Input, Segmented, Select, Spinner, Switch } from '@/components/ui/base';
import { get } from '@/lib/api';
import { useCategories, useFolders } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { cn, downloadBlob } from '@/lib/utils';

interface Log {
  id: number; orgId: string | null; orgName: string | null; userId: string | null; userName: string | null; action: string;
  entityType: string | null; entityId: string | null; description: string | null; details: Record<string, unknown> | null;
  ip: string | null; userAgent: string | null; createdAt: string;
}
interface Page { items: Log[]; nextBefore: string | null }

const ORG_AREAS: Array<[string, string]> = [
  ['payable', 'Contas a pagar'], ['receivable', 'Contas a receber'], ['bills', 'Baixa em massa e exportação'], ['card', 'Cartões'], ['payroll', 'Folha de pagamento'], ['accounting', 'Área do contador'],
  ['category,folder', 'Categorias e pastas'], ['import', 'Importação'], ['member,group', 'Membros e grupos'], ['org,alerts', 'Espaço e alertas'],
];
const PLATFORM_AREAS: Array<[string, string]> = [['auth', 'Acessos e perfil'], ['platform', 'Usuários da plataforma'], ['system', 'Backups, e-mail e Telegram']];

const FIELD: Record<string, string> = {
  description: 'Descrição', amount: 'Valor', dueDate: 'Vencimento', categoryId: 'Categoria', folderId: 'Pasta', status: 'Situação',
  paidAt: 'Data da baixa', paidAmount: 'Valor pago', notes: 'Observações', relatedPerson: 'Pessoa', paymentMethod: 'Forma de pagamento',
  barcode: 'Código de barras', pixKey: 'PIX', name: 'Nome', kind: 'Tipo', document: 'CPF/CNPJ', timezone: 'Fuso horário', active: 'Ativo',
  bankCode: 'Banco', bankBranch: 'Agência', bankAccount: 'Conta', bankAccountKind: 'Tipo de conta', bankInfo: 'Banco (anotação antiga)',
  groups: 'Grupos', isAdmin: 'Administrador', email: 'E-mail', username: 'Usuário', isSuperadmin: 'Admin da plataforma', canCreateOrgs: 'Pode criar espaços',
};
const MONEY = new Set(['amount', 'paidAmount']);
const DATE = new Set(['dueDate', 'paidAt']);
const VALUE: Record<string, string> = { paid: 'paga', pending: 'pendente', personal: 'pessoal', company: 'empresa' };

/** Navegador e sistema, em poucas palavras. */
function shortUA(ua: string | null) {
  if (!ua) return null;
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|node|undici/i.test(ua) ? 'script' : 'navegador';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} · ${os}` : b;
}

const DETAILED_KEY = 'np:audit-detailed';
const readDetailed = () => { try { return localStorage.getItem(DETAILED_KEY) === '1'; } catch { return false; } };

export function AuditPage() {
  return <AuditView endpoint="/api/audit" usersEndpoint="/api/audit/users" areas={ORG_AREAS} title="Auditoria" subtitle="Tudo o que foi feito neste espaço, do mais recente para o mais antigo." />;
}

export function PlatformAuditPage() {
  const isSuper = useSession((s) => !!s.user?.isSuperadmin);
  const [scope, setScope] = useState<'platform' | 'all'>('platform');
  if (!isSuper) return <Navigate to="/config/perfil" replace />;
  return (
    <AuditView key={scope} endpoint={`/api/system/audit?scope=${scope}`} usersEndpoint={`/api/system/audit/users?scope=${scope}`} showOrg={scope === 'all'}
      areas={scope === 'all' ? [...PLATFORM_AREAS, ...ORG_AREAS] : PLATFORM_AREAS} title="Auditoria da plataforma"
      subtitle={scope === 'platform' ? 'Entradas no sistema, trocas de senha e mudanças na plataforma (usuários, backups, e-mail, Telegram).' : 'Tudo, de todos os espaços.'}
      extra={<Segmented value={scope} onChange={setScope} options={[{ value: 'platform', label: 'Plataforma' }, { value: 'all', label: 'Todos os espaços' }]} />} />
  );
}

function AuditView({ endpoint, usersEndpoint, areas, title, subtitle, showOrg, extra }: {
  endpoint: string; usersEndpoint: string; areas: Array<[string, string]>; title: string; subtitle: string; showOrg?: boolean; extra?: React.ReactNode;
}) {
  const orgId = useSession((s) => s.orgId);
  const [area, setArea] = useState('');
  const [user, setUser] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [detailed, setDetailedState] = useState(readDetailed);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const setDetailed = (v: boolean) => { setDetailedState(v); setOpen(new Set()); try { localStorage.setItem(DETAILED_KEY, v ? '1' : '0'); } catch { /* ignore */ } };
  useEffect(() => { const t = setTimeout(() => setQ(text), 350); return () => clearTimeout(t); }, [text]);

  const users = useQuery({ queryKey: ['audit-users', usersEndpoint, orgId], queryFn: () => get<{ items: Array<{ id: string; name: string }> }>(usersEndpoint).then((r) => r.items) });
  const params = { area, user, from, to, q };
  const list = useInfiniteQuery({
    queryKey: ['audit', endpoint, orgId, params], initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const sp = new URLSearchParams(Object.entries({ ...params, before: pageParam }).filter(([, v]) => v) as Array<[string, string]>);
      return get<Page>(`${endpoint}${endpoint.includes('?') ? '&' : '?'}${sp}`);
    },
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = !!(area || user || from || to || q);
  const clear = () => { setArea(''); setUser(''); setFrom(''); setTo(''); setText(''); setQ(''); };
  const toggle = (id: number) => { const s = new Set(open); if (s.has(id)) s.delete(id); else s.add(id); setOpen(s); };

  const exportCsv = () => {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['data', ...(showOrg ? ['espaço'] : []), 'pessoa', 'ação', 'descrição', 'ip', 'navegador', 'detalhes'];
    const lines = rows.map((r) => [new Date(r.createdAt).toLocaleString('pt-BR'), ...(showOrg ? [r.orgName ?? ''] : []), r.userName ?? 'sistema', r.action, r.description ?? '', r.ip ?? '', shortUA(r.userAgent) ?? '', r.details ? JSON.stringify(r.details) : ''].map(esc).join(';'));
    downloadBlob(new Blob(['﻿' + [head.join(';'), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' }), `auditoria-${new Date().toISOString().slice(0, 10)}.csv`);
  };

  // dia a dia, para agrupar
  let lastDay = '';
  return (
    <Card>
      <div className="flex flex-wrap items-start gap-4 border-b border-line p-5">
        <div className="mr-auto">
          <h2 className="font-display text-lg font-semibold">{title}</h2>
          <p className="text-sm text-muted">{subtitle}</p>
        </div>
        {extra}
      </div>

      <div className="flex flex-col gap-3 border-b border-line px-5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <Input className="h-9 pl-9" placeholder="Buscar na descrição e nos detalhes…" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <Select aria-label="Área" className="h-9 w-auto text-sm" value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="">Todas as áreas</option>
            {areas.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
          <Select aria-label="Pessoa" className="h-9 w-auto max-w-[200px] text-sm" value={user} onChange={(e) => setUser(e.target.value)}>
            <option value="">Todas as pessoas</option>
            <option value="system">Sistema (automático)</option>
            {users.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <Input aria-label="De" type="date" className="h-9 w-[150px] text-sm" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            até
            <Input aria-label="Até" type="date" className="h-9 w-[150px] text-sm" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-auto"><Switch checked={detailed} onChange={setDetailed} label={<span className="inline-flex items-center gap-1.5"><ListTree className="size-4 text-accent" />Modo detalhado</span>} /></div>
          <span className="text-xs text-faint">{detailed ? 'Mostra o que mudou (antes → depois), IP e navegador em todos os registros.' : 'Clique num registro para ver os detalhes.'}</span>
          <div className="ml-auto flex items-center gap-2">
            {filtered && <button type="button" onClick={clear} className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink"><X className="size-3.5" />limpar filtros</button>}
            <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} disabled={!rows.length} onClick={exportCsv}>CSV</Button>
          </div>
        </div>
      </div>

      {list.isLoading ? <div className="grid place-items-center py-12"><Spinner /></div> : !rows.length ? (
        <p className="px-5 py-12 text-center text-sm text-faint">{filtered ? 'Nenhum registro com estes filtros.' : 'Nada registrado ainda.'}</p>
      ) : (
        <ul>
          {rows.map((r) => {
            const d = new Date(r.createdAt);
            const day = d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
            const header = day !== lastDay;
            lastDay = day;
            const isOpen = detailed || open.has(r.id);
            const hasMore = !!(r.details && Object.keys(r.details).length) || !!r.ip;
            return (
              <Fragment key={r.id}>
                {header && <li className="sticky top-0 z-[1] border-b border-line bg-surface-2/95 px-5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint backdrop-blur">{day}</li>}
                <li className="border-b border-line/70 last:border-0">
                  <button type="button" onClick={() => !detailed && hasMore && toggle(r.id)}
                    className={cn('grid w-full grid-cols-[52px_1fr] gap-x-3 px-5 py-2.5 text-left text-sm sm:grid-cols-[52px_150px_1fr_auto]', !detailed && hasMore && 'hover:bg-surface-2/50')}>
                    <span className="text-xs text-faint tnum pt-0.5">{d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
                    <span className="truncate font-medium max-sm:col-start-2">{r.userName ?? <span className="text-faint">sistema</span>}{showOrg && r.orgName && <span className="block truncate text-xs font-normal text-faint">{r.orgName}</span>}</span>
                    <span className="min-w-0 text-muted max-sm:col-start-2">{r.description ?? r.action}</span>
                    {!detailed && hasMore && <ChevronDown className={cn('mt-0.5 size-4 text-faint transition-transform max-sm:hidden', isOpen && 'rotate-180')} />}
                  </button>
                  <AnimatePresence initial={false}>
                    {isOpen && hasMore && (
                      <motion.div initial={detailed ? false : { height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
                        <Details log={r} />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </li>
              </Fragment>
            );
          })}
        </ul>
      )}
      {list.hasNextPage && <div className="border-t border-line p-4 text-center"><Button size="sm" loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>Carregar mais</Button></div>}
    </Card>
  );
}

function Details({ log }: { log: Log }) {
  const { data: cats = [] } = useCategories();
  const { data: folders = [] } = useFolders();
  const names = useMemo(() => new Map([...cats.map((c) => [c.id, c.label] as const), ...folders.map((f) => [f.id, f.label] as const)]), [cats, folders]);
  const det = { ...(log.details ?? {}) } as Record<string, unknown>;
  const changes = (det.changes && typeof det.changes === 'object' && !Array.isArray(det.changes) ? det.changes : null) as Record<string, { from: unknown; to: unknown }> | null;
  const added = Array.isArray(det.permissionsAdded) ? det.permissionsAdded as string[] : [];
  const removed = Array.isArray(det.permissionsRemoved) ? det.permissionsRemoved as string[] : [];
  delete det.changes; delete det.permissionsAdded; delete det.permissionsRemoved; delete det.restricted;
  // listas antigas de campos (antes de guardar antes/depois)
  const legacy = Array.isArray(log.details?.changes) ? (log.details!.changes as string[]) : null;

  const fmt = (k: string, v: unknown): string => {
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v === 'boolean') return v ? 'sim' : 'não';
    if (MONEY.has(k)) return formatBRL(String(v));
    if (DATE.has(k) && typeof v === 'string') return formatDateBR(v.slice(0, 10));
    if ((k === 'categoryId' || k === 'folderId') && typeof v === 'string') return names.get(v) ?? 'item apagado';
    if (Array.isArray(v)) return v.length ? v.join(', ') : 'nenhum';
    if (typeof v === 'string') return VALUE[v] ?? v;
    return JSON.stringify(v);
  };
  const perm = (p: string) => (isPermission(p) ? PERMISSIONS[p].label : p);
  const rest = Object.entries(det).filter(([, v]) => v !== null && v !== undefined);

  return (
    <div className="mx-5 mb-3 ml-[calc(20px+52px+12px)] flex flex-col gap-2.5 rounded-xl border border-line bg-surface-2/50 p-3 text-xs max-sm:ml-5">
      {changes && Object.keys(changes).length > 0 && (
        <table className="w-full max-w-2xl">
          <tbody>
            {Object.entries(changes).map(([k, c]) => (
              <tr key={k} className="align-top">
                <td className="w-40 py-0.5 pr-3 text-faint">{FIELD[k] ?? k}</td>
                <td className="py-0.5"><span className="text-danger/90 line-through decoration-danger/40">{fmt(k, c.from)}</span><span className="mx-1.5 text-faint">→</span><span className="font-medium text-ink">{fmt(k, c.to)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {legacy && <p className="text-muted">Campos alterados: {legacy.map((k) => FIELD[k] ?? k).join(', ')}</p>}
      {(added.length > 0 || removed.length > 0) && (
        <div className="flex flex-col gap-1">
          {added.map((p) => <p key={`+${p}`} className="text-ok">+ {perm(p)}</p>)}
          {removed.map((p) => <p key={`-${p}`} className="text-danger">− {perm(p)}</p>)}
        </div>
      )}
      {rest.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer list-none text-faint hover:text-ink"><span className="group-open:hidden">▸</span><span className="hidden group-open:inline">▾</span> Dados técnicos</summary>
          <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface p-2 font-mono text-[11px] text-muted">{JSON.stringify(Object.fromEntries(rest), null, 2)}</pre>
        </details>
      )}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-faint">
        {log.ip && <span className="inline-flex items-center gap-1"><Globe className="size-3" />{log.ip}</span>}
        {shortUA(log.userAgent) && <span className="inline-flex items-center gap-1" title={log.userAgent ?? ''}><Monitor className="size-3" />{shortUA(log.userAgent)}</span>}
        <span className="font-mono">{log.action}</span>
        {log.entityId && <span className="font-mono">#{log.entityId.slice(0, 8)}</span>}
        <span className="tnum">{new Date(log.createdAt).toLocaleString('pt-BR')}</span>
      </p>
    </div>
  );
}
