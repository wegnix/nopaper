import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, FileText, Landmark, RotateCcw, Trash2, Upload } from 'lucide-react';
import { BANK_ACCOUNT_KINDS, BANK_ACCOUNT_KIND_LABEL, BANK_NAMES, bankName, normBank, formatBRL, formatDateBR, type BankAccountInput } from '@nopaper/shared';
import { Dialog, SaveFooter, useConfirm, useFormState } from '@/components/ui/dialog';
import { Button, Field, Input, Select, Spinner, Switch, Textarea } from '@/components/ui/base';
import { Combobox } from '@/components/ui/combobox';
import { api, del, post, put, errMsg } from '@/lib/api';
import { useCan } from '@/lib/session';
import { cn, plural } from '@/lib/utils';
import { useBankImports, type BankAccount, type ReadStatement } from './data';

const BANKS = Object.entries(BANK_NAMES).sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
const bankText = (code: string | null) => (code ? `${BANK_NAMES[code] ?? 'Banco'} (${code})` : '');
const BANK_OPTIONS = BANKS.map(([code]) => bankText(code));

/**
 * Banco com busca: digite o nome ou o código (3 números). Campo próprio em vez do <select> nativo,
 * que alguns navegadores desenham fora do lugar dentro de diálogos animados.
 */
function BankPicker({ value, onChange }: { value: string | null; onChange: (code: string | null) => void }) {
  const [text, setText] = useState(bankText(value));
  useEffect(() => { setText((t) => (codeOf(t) === value ? t : bankText(value))); }, [value]);
  const codeOf = (t: string): string | null => {
    const v = t.trim();
    if (!v) return null;
    const m = /\((\d{1,4})\)\s*$/.exec(v) ?? /^(\d{1,4})$/.exec(v);
    if (m) return normBank(m[1]);
    const byName = BANKS.find(([, n]) => n.toLowerCase() === v.toLowerCase());
    return byName ? byName[0] : null;
  };
  const code = codeOf(text);
  return (
    <Field label="Banco" hint={text.trim() && !code ? 'Escolha da lista ou digite o código do banco (3 números).' : code ? undefined : 'Digite o nome ou o código.'}>
      <Combobox value={text} options={BANK_OPTIONS} maxLength={60} placeholder="Ex.: Sicoob, Itaú, 756"
        onChange={(t) => { setText(t); const c = codeOf(t); if (c !== value && (c || !t.trim())) onChange(c); }} />
    </Field>
  );
}

// ------------------------------------------------------------------ cadastro da conta bancária
export function AccountDialog({ open, account, onClose, onSaved }: { open: boolean; account: BankAccount | null; onClose: () => void; onSaved: (a: BankAccount) => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const blank: BankAccountInput = { name: '', bankCode: null, branch: null, accountNumber: null, kind: 'checking', color: 'sky', active: true, notes: null };
  const [f, setF, form] = useFormState<BankAccountInput>(blank);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    form.load(account ? { name: account.name, bankCode: account.bankCode, branch: account.branch, accountNumber: account.accountNumber, kind: account.kind, color: account.color, active: account.active, notes: account.notes } : blank);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, account?.id]);
  const save = async () => {
    setBusy(true);
    try {
      const r = account ? await put<BankAccount>(`/api/bank/accounts/${account.id}`, f) : await post<BankAccount>('/api/bank/accounts', f);
      qc.invalidateQueries({ queryKey: ['bills'] });
      toast.success(account ? 'Conta bancária salva' : 'Conta bancária cadastrada');
      form.markSaved(f);
      onSaved({ ...(account ?? { pending: 0, transactions: 0, lastDate: null, balance: null, balanceDate: null }), ...r } as BankAccount);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!account) return;
    if (!(await confirm({ title: `Apagar ${account.name}?`, tone: 'danger', confirmLabel: 'Apagar', body: 'Apaga a conta e os extratos importados dela. As contas a pagar e a receber não são apagadas. Conta com lançamentos conciliados não pode ser apagada: desative.' }))) return;
    try { await del(`/api/bank/accounts/${account.id}`); qc.invalidateQueries({ queryKey: ['bills'] }); toast.success('Conta bancária apagada'); onClose(); } catch (e) { toast.error(errMsg(e)); }
  };
  const text = (k: 'branch' | 'accountNumber' | 'notes') => (v: string) => setF((p) => ({ ...p, [k]: v || null }));
  return (
    <Dialog open={open} onClose={onClose} dirty={form.dirty} title={account ? account.name : 'Nova conta bancária'}
      description="Banco, agência e conta servem para reconhecer a conta quando você importa o extrato."
      footer={<SaveFooter dirty={form.dirty} isNew={!account} saving={busy} canSave={!!f.name.trim()} onSave={save} onClose={onClose}
        left={account && <Button variant="ghost" className="mr-auto text-danger hover:text-danger" icon={<Trash2 className="size-4" />} onClick={remove}>Apagar</Button>} />}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nome" required className="sm:col-span-2"><Input autoFocus={!account} maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Ex.: Sicoob loja, Nubank pessoal" /></Field>
        <BankPicker value={f.bankCode} onChange={(bankCode) => setF((p) => ({ ...p, bankCode }))} />
        <Field label="Tipo">
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as BankAccountInput['kind'] })}>
            {BANK_ACCOUNT_KINDS.map((k) => <option key={k} value={k}>{BANK_ACCOUNT_KIND_LABEL[k]}</option>)}
          </Select>
        </Field>
        <Field label="Agência"><Input inputMode="numeric" maxLength={20} value={f.branch ?? ''} onChange={(e) => text('branch')(e.target.value)} placeholder="0000-0" /></Field>
        <Field label="Conta"><Input inputMode="numeric" maxLength={30} value={f.accountNumber ?? ''} onChange={(e) => text('accountNumber')(e.target.value)} placeholder="00000-0" /></Field>
        <Field label="Observações" className="sm:col-span-2"><Textarea maxLength={1000} rows={2} value={f.notes ?? ''} onChange={(e) => text('notes')(e.target.value)} /></Field>
        {account && <div className="sm:col-span-2"><Switch checked={f.active} onChange={(active) => setF({ ...f, active })} label="Conta ativa" hint="Desativada, some da lista principal, mas os extratos e as conciliações continuam." /></div>}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ importar o OFX
interface ReadResult { fileName: string; statements: ReadStatement[]; warnings: string[] }
type Target = { mode: 'existing'; accountId: string } | { mode: 'new'; name: string };

export function ImportOfxDialog({ open, onClose, accounts, onDone }: { open: boolean; onClose: () => void; accounts: BankAccount[]; onDone: (accountId: string, ref: string | null) => void }) {
  const qc = useQueryClient();
  const can = useCan();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<ReadResult | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setFile(null); setTargets([]); } }, [open]);
  const pick = async (f: File) => {
    setReading(true);
    try {
      const fd = new FormData(); fd.append('file', f);
      const r = await api<ReadResult>('POST', '/api/bank/read', fd);
      setFile(r);
      setTargets(r.statements.map((s) => (s.account ? { mode: 'existing', accountId: s.account.id } : { mode: 'new', name: s.suggested.name })));
    } catch (e) { toast.error(errMsg(e)); } finally { setReading(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const run = async () => {
    if (!file) return;
    setBusy(true);
    try {
      let last: { accountId: string; to: string | null } | null = null;
      for (const [i, s] of file.statements.entries()) {
        const t = targets[i];
        if (!s.transactions.length) continue;
        const r = await post<{ accountId: string; accountName: string; inserted: number; duplicates: number; to: string | null }>('/api/bank/import', {
          fileName: file.fileName,
          accountId: t.mode === 'existing' ? t.accountId : null,
          newAccount: t.mode === 'new' ? { name: t.name, bankCode: s.suggested.bankCode, branch: s.suggested.branch, accountNumber: s.suggested.accountNumber, kind: s.suggested.kind, color: 'sky', active: true, notes: null } : null,
          statement: { bankId: s.bankId, branchId: s.branchId, accountId: s.accountId, from: s.from, to: s.to, balance: s.balance, balanceDate: s.balanceDate, transactions: s.transactions },
        });
        toast.success(`${r.accountName}: ${plural(r.inserted, 'lançamento novo', 'lançamentos novos')}${r.duplicates ? ` (${r.duplicates} já estavam importados)` : ''}`);
        last = { accountId: r.accountId, to: r.to };
      }
      qc.invalidateQueries({ queryKey: ['bills'] });
      if (last) onDone(last.accountId, last.to?.slice(0, 7) ?? null);
      onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const ok = !!file && file.statements.some((s) => s.transactions.length) && targets.every((t) => (t.mode === 'existing' ? !!t.accountId : !!t.name.trim() && can('bank.manage')));
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Importar extrato (OFX)"
      description="Os lançamentos já importados antes são reconhecidos e não entram de novo."
      footer={file ? <>
        <Button variant="ghost" className="mr-auto" onClick={() => setFile(null)}>Trocar arquivo</Button>
        <Button variant="ghost" onClick={onClose}>Fechar</Button>
        <Button variant="primary" loading={busy} disabled={!ok} onClick={run}>Importar</Button>
      </> : <Button variant="ghost" onClick={onClose}>Fechar</Button>}>
      <input ref={fileRef} type="file" accept=".ofx,.OFX,application/x-ofx,application/ofx" className="hidden" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
      {!file ? (
        <div className="flex flex-col gap-4">
          <button type="button" onClick={() => fileRef.current?.click()} disabled={reading}
            className="flex w-full flex-col items-center gap-3 rounded-xl border-2 border-dashed border-line px-6 py-12 text-center transition hover:border-accent hover:bg-accent-soft/30">
            {reading ? <Spinner className="size-6" /> : <span className="grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent"><Upload className="size-5" /></span>}
            <span className="font-medium">{reading ? 'Lendo o extrato…' : 'Escolher o extrato (.ofx)'}</span>
            <span className="text-xs text-faint">Exportado no internet banking ou no app do banco.</span>
          </button>
          <div className="rounded-xl bg-surface-2/60 px-4 py-3 text-sm text-muted">
            <p className="font-medium text-ink">Como exportar</p>
            <p className="mt-1">No banco, em <b>Extrato → Exportar</b>, escolha <b>OFX</b> (no Sicoob: “OFX Padrão Unix”). Não precisa marcar a opção de datas em ISO 8601: o formato padrão é o mais seguro.</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="flex items-center gap-1.5 text-sm text-muted"><FileText className="size-4 text-faint" />{file.fileName}</p>
          {file.warnings.map((w) => <p key={w} className="flex items-start gap-2 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{w}</p>)}
          {file.statements.map((s, i) => {
            const t = targets[i];
            const fresh = s.transactions.length - s.duplicates;
            const ins = s.transactions.filter((x) => !x.amount.startsWith('-')).reduce((a, x) => a + Number(x.amount), 0);
            const outs = s.transactions.filter((x) => x.amount.startsWith('-')).reduce((a, x) => a + Number(x.amount), 0);
            return (
              <div key={i} className="rounded-xl border border-line p-4">
                <div className="flex items-start gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent"><Landmark className="size-5" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{bankName(s.bankId)}{s.kind === 'creditcard' && ' · cartão'}</p>
                    <p className="text-xs text-faint">{[s.branchId && `ag. ${s.branchId}`, s.accountId && `cc ${s.accountId}`].filter(Boolean).join(' · ') || 'Conta não informada no arquivo'}</p>
                  </div>
                  {s.balance && <div className="text-right"><p className="text-xs text-faint">Saldo{s.balanceDate ? ` em ${formatDateBR(s.balanceDate)}` : ''}</p><p className="font-display font-semibold tnum">{formatBRL(s.balance)}</p></div>}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  <Stat label="Período" value={s.from && s.to ? `${formatDateBR(s.from).slice(0, 5)} a ${formatDateBR(s.to)}` : '—'} />
                  <Stat label="Lançamentos" value={`${s.transactions.length}`} sub={s.duplicates ? `${fresh} novos · ${s.duplicates} já importados` : 'todos novos'} />
                  <Stat label="Entradas" value={formatBRL(ins)} tone="ok" />
                  <Stat label="Saídas" value={formatBRL(Math.abs(outs))} tone="danger" />
                </div>
                <div className="mt-3 border-t border-line pt-3">
                  {s.account && t?.mode === 'existing' && t.accountId === s.account.id ? (
                    <p className="text-sm">Vai para <b>{s.account.name}</b> <span className="text-faint">(reconhecida pelo banco, agência e conta)</span>
                      <button className="ml-2 text-xs font-medium text-accent hover:underline" onClick={() => setTargets(targets.map((x, j) => (j === i ? { mode: 'existing', accountId: '' } : x)))}>trocar</button>
                    </p>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Conta bancária">
                        <Select value={t?.mode === 'existing' ? t.accountId : 'new'} onChange={(e) => setTargets(targets.map((x, j) => (j === i ? (e.target.value === 'new' ? { mode: 'new', name: s.suggested.name } : { mode: 'existing', accountId: e.target.value }) : x)))}>
                          {can('bank.manage') && <option value="new">Cadastrar uma conta nova</option>}
                          {t?.mode === 'existing' && !t.accountId && <option value="">Escolha…</option>}
                          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </Select>
                      </Field>
                      {t?.mode === 'new' && (
                        <Field label="Nome da conta nova" hint="Banco, agência e conta vêm do arquivo.">
                          <Input maxLength={80} value={t.name} onChange={(e) => setTargets(targets.map((x, j) => (j === i ? { mode: 'new', name: e.target.value } : x)))} />
                        </Field>
                      )}
                      {t?.mode === 'new' && !can('bank.manage') && <p className="text-sm text-warn sm:col-span-2">Você não pode cadastrar contas bancárias: escolha uma existente.</p>}
                    </div>
                  )}
                </div>
                {!fresh && s.transactions.length > 0 && <p className="mt-2 text-xs text-muted">Todos os lançamentos deste extrato já foram importados antes — importar de novo só atualiza o saldo.</p>}
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' | 'danger' }) {
  return (
    <div className="min-w-0 rounded-lg bg-surface-2/50 px-3 py-2">
      <p className="text-xs text-faint">{label}</p>
      <p className={cn('truncate font-medium tnum', tone === 'ok' && 'text-ok', tone === 'danger' && 'text-danger')}>{value}</p>
      {sub && <p className="truncate text-[11px] text-faint">{sub}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ histórico de importações
export function ImportsDialog({ open, onClose, account }: { open: boolean; onClose: () => void; account: BankAccount }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const can = useCan();
  const q = useBankImports(account.id, open);
  const undo = async (id: string, name: string) => {
    if (!(await confirm({ title: `Desfazer a importação de "${name}"?`, tone: 'danger', confirmLabel: 'Desfazer', body: 'Apaga os lançamentos que esta importação trouxe. Só é possível se nenhum deles estiver ligado a uma conta.' }))) return;
    try { const r = await del<{ removed: number }>(`/api/bank/imports/${id}`); qc.invalidateQueries({ queryKey: ['bills'] }); toast.success(`Importação desfeita (${plural(r.removed, 'lançamento', 'lançamentos')})`); } catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`Importações · ${account.name}`} footer={<Button variant="ghost" onClick={onClose}>Fechar</Button>}>
      {q.isLoading ? <div className="grid place-items-center py-10"><Spinner /></div> : !q.data?.length ? <p className="py-8 text-center text-sm text-muted">Nenhum extrato importado ainda.</p> : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {q.data.map((b) => (
            <li key={b.id} className="flex items-center gap-3 px-3 py-2.5">
              <FileText className="size-4 shrink-0 text-faint" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{b.fileName}</span>
                <span className="block text-xs text-faint">
                  {b.from && b.to ? `${formatDateBR(b.from)} a ${formatDateBR(b.to)} · ` : ''}{plural(b.newCount, 'novo', 'novos')} de {b.txCount} · {formatDateBR(b.createdAt.slice(0, 10))}{b.createdByName ? ` por ${b.createdByName}` : ''}
                  {b.linked > 0 && ` · ${b.linked} conciliado(s)`}
                </span>
              </span>
              {can('bank.import') && <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} disabled={b.linked > 0} title={b.linked ? 'Desfaça as conciliações antes' : undefined} onClick={() => undo(b.id, b.fileName)}>Desfazer</Button>}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
