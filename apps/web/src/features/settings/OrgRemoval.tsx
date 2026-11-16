import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Archive, ArchiveRestore, CalendarClock, FileDown, Trash2, TriangleAlert, Undo2, UserX } from 'lucide-react';
import { ORG_REMOVAL_DAYS, billNames, orgNameMatches } from '@nopaper/shared';
import { Button, Card, Checkbox, Field, Input, Segmented, Spinner } from '@/components/ui/base';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { del, errMsg, get, post, put, refreshSession } from '@/lib/api';
import { useOrg, useSession } from '@/lib/session';
import { cn, plural } from '@/lib/utils';

/**
 * Arquivar e remover espaço (ver `services/orgRemoval.ts` na API).
 * Remover nunca é na hora: pede nome + senha + caixa marcada, e o espaço só é apagado depois de
 * `ORG_REMOVAL_DAYS` dias — até lá, só o dono vê (só consulta) e pode cancelar.
 */

export interface RemovalImpact {
  payable: number; receivable: number; attachments: number; storageBytes: number;
  cards: number; cardTransactions: number; bankTransactions: number;
  employees: number; payrollPeriods: number; signatures: number; accountingDocs: number;
  members: number; apiTokens: number; pendingSignatures: number; unreviewedAccounting: number;
}
interface Deletion { requestedAt: string; dueAt: string; byName: string | null; byPlatform: boolean }
interface RemovalState { days: number; isOwner: boolean; isAdmin: boolean; archivedAt: string | null; deletion: Deletion | null; impact: RemovalImpact | null }

const sizeText = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB` : b >= 1024 ** 2 ? `${Math.round(b / 1024 ** 2).toLocaleString('pt-BR')} MB` : b > 0 ? `${Math.max(1, Math.round(b / 1024)).toLocaleString("pt-BR")} KB` : "nenhum arquivo");
export const whenBR = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
/** "em 6 dias" / "amanhã" / "hoje" até a data. */
export const untilText = (iso: string) => {
  const d = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  return d <= 0 ? 'hoje' : d === 1 ? 'amanhã' : `em ${d} dias`;
};

/** Depois de mudar o estado do espaço: a sessão traz `archived`/`deletionDueAt` de novo (seletor e faixa). */
async function syncSession(qc: ReturnType<typeof useQueryClient>) {
  await refreshSession();
  qc.invalidateQueries({ queryKey: ['org-removal'] });
}

// ---------------------------------------------------------------- lista do que será apagado
function ImpactList({ impact, kind }: { impact: RemovalImpact; kind: string | undefined }) {
  const pay = billNames('payable', kind), rec = billNames('receivable', kind);
  const rows: Array<[string, number]> = [
    [pay.many, impact.payable], [rec.many, impact.receivable], ['anexos', impact.attachments],
    ['cartões', impact.cards], ['compras no cartão', impact.cardTransactions], ['lançamentos de extrato', impact.bankTransactions],
    ['funcionários', impact.employees], ['meses da folha', impact.payrollPeriods], ['holerites assinados', impact.signatures],
    ['documentos do contador', impact.accountingDocs], ['tokens de integração', impact.apiTokens],
  ];
  const shown = rows.filter(([, n]) => n > 0);
  return (
    <div className="rounded-xl border border-danger/30 bg-danger/5 p-3 sm:p-4">
      <p className="text-sm font-medium text-danger">Será apagado de vez:</p>
      {shown.length ? (
        <ul className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {shown.map(([label, n]) => <li key={label} className="flex justify-between gap-3"><span className="text-muted">{label}</span><b className="font-medium tnum">{n.toLocaleString('pt-BR')}</b></li>)}
        </ul>
      ) : <p className="mt-1 text-sm text-muted">O espaço está vazio: nenhuma conta, anexo ou cadastro.</p>}
      <p className="mt-2 text-xs text-muted">
        Arquivos: <b className="font-medium tnum">{sizeText(impact.storageBytes)}</b> · {plural(impact.members, 'membro perde', 'membros perdem')} o acesso (as contas de usuário continuam existindo).
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- janela de confirmação (espaço e plataforma)
export function DeleteOrgDialog({ open, onClose, name, kind, impact, endpoint, platform, pending, onDone }: {
  open: boolean; onClose: () => void; name: string; kind?: string; impact: RemovalImpact | null;
  /** POST com { confirmName, password, understood, now }. */
  endpoint: string; platform?: boolean;
  /** A remoção já está agendada: a janela só serve para apagar agora (antecipar). */
  pending?: boolean;
  /** `deleted` = apagado na hora (o espaço não existe mais). */
  onDone: (deleted: boolean) => void;
}) {
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [when, setWhen] = useState<'later' | 'now'>('later');
  const [busy, setBusy] = useState(false);
  const now = pending || when === 'now';
  const close = () => { setTyped(''); setPassword(''); setUnderstood(false); setWhen('later'); onClose(); };
  const nameOk = orgNameMatches(typed, name);
  const ready = nameOk && !!password && understood;
  const submit = async () => {
    setBusy(true);
    try {
      const r = await post<{ dueAt?: string; deleted?: boolean }>(endpoint, { confirmName: typed, password, understood, now });
      if (r.deleted) toast.success(`O espaço “${name}” foi apagado.`, { duration: 8000 });
      else toast.success(`Remoção agendada para ${whenBR(r.dueAt!)}. Dá para cancelar até lá.`, { duration: 8000 });
      close();
      onDone(!!r.deleted);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const warnings = impact ? [
    impact.pendingSignatures > 0 && `${plural(impact.pendingSignatures, 'holerite ainda espera', 'holerites ainda esperam')} assinatura: o link para de funcionar.`,
    impact.unreviewedAccounting > 0 && `${plural(impact.unreviewedAccounting, 'documento do contador ainda não foi conferido', 'documentos do contador ainda não foram conferidos')}.`,
  ].filter(Boolean) as string[] : [];
  return (
    <Dialog open={open} onClose={close} size="lg" title={pending ? `Apagar “${name}” agora` : `Remover o espaço “${name}”`}
      description={now
        ? 'O espaço e tudo o que está nele são apagados assim que você confirmar. Não há prazo para cancelar.'
        : `O espaço fica fora do ar na hora e é apagado de vez em ${ORG_REMOVAL_DAYS} dias. Até lá, ${platform ? 'a remoção pode ser cancelada aqui na Plataforma' : 'você pode cancelar em Configuração do espaço'}.`}
      footer={<>
        <Button variant="ghost" onClick={close}>Voltar</Button>
        <Button variant="danger" loading={busy} disabled={!ready} icon={<Trash2 className="size-4" />} onClick={submit}>{now ? 'Apagar agora' : 'Agendar remoção'}</Button>
      </>}>
      {!impact ? <div className="grid place-items-center py-10"><Spinner /></div> : (
        <div className="flex flex-col gap-4">
          <ImpactList impact={impact} kind={kind} />
          {!pending && (
            <Field label="Quando apagar">
              <Segmented className="max-sm:w-full" value={when} onChange={setWhen} options={[
                { value: 'later', label: `Em ${ORG_REMOVAL_DAYS} dias (recomendado)` },
                { value: 'now', label: 'Agora' },
              ]} />
            </Field>
          )}
          {now && (
            <p className="flex gap-2 rounded-lg bg-danger/10 px-3 py-2.5 text-sm font-medium text-danger">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              Apagar agora não tem volta: sem prazo para cancelar e sem como recuperar pelo NoPaper.{!pending && ` Se tiver qualquer dúvida, escolha “Em ${ORG_REMOVAL_DAYS} dias”.`}
            </p>
          )}
          {warnings.length > 0 && (
            <ul className="flex flex-col gap-1 rounded-lg bg-warn/10 px-3 py-2.5 text-sm text-warn">
              {warnings.map((w) => <li key={w} className="flex gap-2"><TriangleAlert className="mt-0.5 size-4 shrink-0" />{w}</li>)}
            </ul>
          )}
          {!platform && !now && (
            <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2/50 px-3 py-2.5 text-sm">
              <p className="flex items-center gap-2 font-medium"><FileDown className="size-4 text-accent" />Quer guardar alguma coisa? Baixe antes</p>
              <p className="text-muted">
                Em <Link className="text-accent underline" to="/pagar" onClick={close}>{billNames('payable', kind).title}</Link> e{' '}
                <Link className="text-accent underline" to="/receber" onClick={close}>{billNames('receivable', kind).title}</Link>, o botão <b className="font-medium">Exportar</b> gera
                a planilha e o ZIP com os anexos (ano a ano). Isso continua funcionando durante o prazo de {ORG_REMOVAL_DAYS} dias.
              </p>
            </div>
          )}
          <Field label={<>Para confirmar, digite o nome do espaço: <b className="font-semibold select-all">{name}</b></>}>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={!!typed && !nameOk}
              className={cn(typed && !nameOk && 'border-danger')} />
          </Field>
          <Field label="Sua senha">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
          <Checkbox checked={understood} onChange={setUnderstood}
            label={now
              ? 'Entendo que tudo o que está neste espaço é apagado agora e não dá para recuperar pelo NoPaper.'
              : `Entendo que, depois de ${ORG_REMOVAL_DAYS} dias, tudo o que está neste espaço é apagado e não dá para recuperar pelo NoPaper.`} />
          <p className="text-xs text-faint">Os backups feitos antes da remoção ainda guardam estes dados até saírem do rodízio de backups.</p>
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- cartão em Configuração do espaço
export function RemovalCard() {
  const org = useOrg();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['org-removal', org?.id], queryFn: () => get<RemovalState>('/api/org/removal'), enabled: !!org });
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const s = q.data;
  /** Apagado na hora: o espaço sumiu da sessão; vai para o Início de outro espaço. */
  const afterDelete = async (deleted: boolean) => {
    if (!deleted) return syncSession(qc);
    qc.clear();
    await refreshSession();
    nav('/');
  };
  if (!org || !s || (!s.isAdmin && !s.isOwner && !s.archivedAt)) return null;
  const archived = !!s.archivedAt;
  const toggleArchive = async () => {
    if (!archived && !(await confirm({
      title: `Arquivar “${org.name}”?`, confirmLabel: 'Arquivar',
      body: 'O espaço fica só para consulta (ninguém lança, edita ou apaga nada), sai da lista principal de espaços e para de mandar avisos. Nada é apagado: dá para desarquivar quando quiser.',
    }))) return;
    setBusy(true);
    try {
      await put('/api/org/archive', { archived: !archived });
      toast.success(archived ? 'Espaço desarquivado: tudo volta a funcionar' : 'Espaço arquivado: só consulta');
      await syncSession(qc);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const cancelDeletion = async () => {
    setBusy(true);
    try {
      await del('/api/org/deletion');
      toast.success('Remoção cancelada. O espaço voltou ao normal para todos.');
      await syncSession(qc);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Card className="border-danger/30 p-5 xl:col-span-2">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold"><span className="grid size-7 place-items-center rounded-lg bg-danger/10 text-danger"><Trash2 className="size-4" /></span>Arquivar ou remover o espaço</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">Para um espaço que não é mais usado. Arquivar guarda tudo e deixa só para consulta; remover apaga tudo depois de {s.days} dias.</p>

      {s.deletion ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3">
          <CalendarClock className="size-5 shrink-0 text-danger" />
          <p className="min-w-0 flex-1 basis-64 text-sm">
            <b className="font-semibold text-danger">Remoção agendada para {whenBR(s.deletion.dueAt)}</b> ({untilText(s.deletion.dueAt)}), pedida por {s.deletion.byName ?? 'alguém'} em {whenBR(s.deletion.requestedAt)}.
            Até lá o espaço está fora do ar para os outros membros e só aceita consulta.
          </p>
          {s.isOwner && (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" loading={busy} icon={<Undo2 className="size-4" />} onClick={cancelDeletion}>Cancelar remoção</Button>
              <Button variant="danger" disabled={busy} icon={<Trash2 className="size-4" />} onClick={() => setDeleting(true)}>Apagar agora…</Button>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface-2/50 p-4">
            <p className="flex items-center gap-2 font-medium">{archived ? <ArchiveRestore className="size-4 text-accent" /> : <Archive className="size-4 text-accent" />}{archived ? 'Espaço arquivado' : 'Arquivar'}</p>
            <p className="text-sm text-muted">{archived
              ? `Arquivado em ${whenBR(s.archivedAt!)}. Ninguém consegue lançar, editar ou apagar nada até desarquivar.`
              : 'Só consulta, fora da lista principal de espaços e sem avisos. Nada é apagado e dá para voltar atrás quando quiser.'}</p>
            {s.isAdmin
              ? <Button className="self-start" variant="secondary" loading={busy} icon={archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />} onClick={toggleArchive}>{archived ? 'Desarquivar' : 'Arquivar espaço'}</Button>
              : <p className="text-xs text-faint">Só os administradores do espaço podem mudar isto.</p>}
          </div>
          <div className="flex flex-col gap-3 rounded-xl border border-danger/30 bg-danger/5 p-4">
            <p className="flex items-center gap-2 font-medium text-danger"><Trash2 className="size-4" />Remover espaço</p>
            <p className="text-sm text-muted">Apaga contas, anexos, cartões, folha e documentos. Pede o nome do espaço e a sua senha. Você escolhe: apagar em {s.days} dias (dá para cancelar até lá) ou na hora. Os administradores recebem aviso por e-mail e Telegram.</p>
            {s.isOwner
              ? <Button className="self-start" variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setDeleting(true)}>Remover espaço…</Button>
              : <p className="text-xs text-faint">Só o dono do espaço pode pedir a remoção.</p>}
          </div>
        </div>
      )}
      {s.isOwner && (
        <DeleteOrgDialog open={deleting} onClose={() => setDeleting(false)} name={org.name} kind={org.kind} impact={s.impact}
          endpoint="/api/org/deletion" pending={!!s.deletion} onDone={afterDelete} />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- faixa no topo
/** Faixa acima de todas as telas: espaço arquivado ou com remoção agendada (só consulta). */
export function OrgStateBanner() {
  const org = useOrg();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  if (!org || (!org.archived && !org.deletionDueAt)) return null;
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try { await fn(); toast.success(msg); await syncSession(qc); qc.invalidateQueries(); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const deleting = !!org.deletionDueAt;
  return (
    <div role="status" className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2 text-sm sm:px-4 md:px-6', deleting ? 'border-danger/40 bg-danger/10' : 'border-line bg-surface-2')}>
      {deleting ? <CalendarClock className="size-4 shrink-0 text-danger" /> : <Archive className="size-4 shrink-0 text-muted" />}
      <p className="min-w-0 flex-1 basis-60">
        {deleting
          ? <><b className="font-semibold text-danger">Este espaço será removido {untilText(org.deletionDueAt!)}</b> ({whenBR(org.deletionDueAt!)}). Até lá, só consulta.</>
          : <><b className="font-semibold">Espaço arquivado.</b> Só consulta: nada pode ser lançado, editado ou apagado.</>}
      </p>
      {deleting && org.isOwner && <Button size="sm" variant="secondary" loading={busy} icon={<Undo2 className="size-4" />} onClick={() => run(() => del('/api/org/deletion'), 'Remoção cancelada')}>Cancelar remoção</Button>}
      {!deleting && org.isAdmin && <Button size="sm" variant="secondary" loading={busy} icon={<ArchiveRestore className="size-4" />} onClick={() => run(() => put('/api/org/archive', { archived: false }), 'Espaço desarquivado')}>Desarquivar</Button>}
    </div>
  );
}

// ---------------------------------------------------------------- Plataforma: espaços sem dono
interface OwnerlessRow { id: string; name: string; kind: string; archivedAt: string | null; deletion: Deletion | null; usedBytes: number }

export function OwnerlessSpacesCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['system', 'ownerless'], queryFn: () => get<{ days: number; items: OwnerlessRow[] }>('/api/system/orgs/ownerless') });
  const [target, setTarget] = useState<{ row: OwnerlessRow; impact: RemovalImpact | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const isSuper = useSession((s) => !!s.user?.isSuperadmin);
  if (!isSuper || !q.data) return null;
  const refresh = () => qc.invalidateQueries({ queryKey: ['system', 'ownerless'] });
  const open = async (row: OwnerlessRow) => {
    setTarget({ row, impact: null });
    try {
      const r = await get<{ impact: RemovalImpact }>(`/api/system/orgs/${row.id}/removal`);
      setTarget({ row, impact: r.impact });
    } catch (e) { toast.error(errMsg(e)); setTarget(null); }
  };
  const cancel = async (row: OwnerlessRow) => {
    setBusy(row.id);
    try { await del(`/api/system/orgs/${row.id}/deletion`); toast.success(`Remoção de ${row.name} cancelada`); refresh(); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  };
  return (
    <Card className="p-5">
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-xl bg-danger/10 text-danger"><UserX className="size-5" /></span>
        <div>
          <h2 className="font-display text-lg font-semibold">Espaços sem dono</h2>
          <p className="text-sm text-muted">Espaços cujo dono teve a conta desativada ou removida. Só estes podem ser removidos pela plataforma (nunca um espaço privado); os demais, só o próprio dono remove. A remoção espera {q.data.days} dias e pode ser cancelada aqui.</p>
        </div>
      </div>
      {q.data.items.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">Todos os espaços têm dono ativo.</p>
      ) : (
        <ul className="mt-4 flex flex-col divide-y divide-line rounded-xl border border-line">
          {q.data.items.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
              <div className="min-w-0 flex-1 basis-56">
                <p className="truncate text-sm font-medium">{o.name}</p>
                <p className="text-xs text-muted tnum">
                  {o.kind === 'personal' ? 'Pessoal' : 'Empresa'} · {sizeText(o.usedBytes)}{o.archivedAt ? ' · arquivado' : ''}
                  {o.deletion && <span className="text-danger"> · removido {untilText(o.deletion.dueAt)} ({whenBR(o.deletion.dueAt)})</span>}
                </p>
              </div>
              {o.deletion ? (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" loading={busy === o.id} icon={<Undo2 className="size-4" />} onClick={() => cancel(o)}>Cancelar remoção</Button>
                  <Button size="sm" variant="danger" disabled={busy === o.id} icon={<Trash2 className="size-4" />} onClick={() => open(o)}>Apagar agora…</Button>
                </div>
              ) : <Button size="sm" variant="danger" icon={<Trash2 className="size-4" />} onClick={() => open(o)}>Remover…</Button>}
            </li>
          ))}
        </ul>
      )}
      {target && (
        <DeleteOrgDialog open onClose={() => setTarget(null)} name={target.row.name} kind={target.row.kind} impact={target.impact} platform pending={!!target.row.deletion}
          endpoint={`/api/system/orgs/${target.row.id}/deletion`} onDone={() => { refresh(); qc.invalidateQueries({ queryKey: ['system', 'storage'] }); }} />
      )}
    </Card>
  );
}
