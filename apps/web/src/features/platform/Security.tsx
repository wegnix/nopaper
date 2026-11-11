import { useEffect, useState } from 'react';
import { Navigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { HardDrive, Lock, Timer } from 'lucide-react';
import { DEFAULT_IDLE_TIMEOUT_MINUTES, type SecuritySettings } from '@nopaper/shared';
import { Button, Card, Field, Input, Select, Spinner } from '@/components/ui/base';
import { errMsg, get, put } from '@/lib/api';
import { useSession } from '@/lib/session';

const PRESETS = [15, 30, 60, 120, 240, 480];
const label = (m: number) => (m < 60 ? `${m} minutos` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} hora${m > 60 ? 's' : ''}`);

export function SecurityPage() {
  const me = useSession((s) => s.user);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['system', 'security'], queryFn: () => get<SecuritySettings>('/api/system/security'), enabled: !!me?.isSuperadmin });
  const [minutes, setMinutes] = useState(DEFAULT_IDLE_TIMEOUT_MINUTES);
  const [custom, setCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!q.data) return;
    setMinutes(q.data.idleTimeoutMinutes);
    setCustom(!PRESETS.includes(q.data.idleTimeoutMinutes));
  }, [q.data]);
  if (!me?.isSuperadmin) return <Navigate to="/config/perfil" replace />;
  if (!q.data) return <div className="grid place-items-center py-16"><Spinner /></div>;

  const valid = Number.isInteger(minutes) && minutes >= 5 && minutes <= 1440;
  const save = async () => {
    setBusy(true);
    try {
      await put('/api/system/security', { idleTimeoutMinutes: minutes });
      qc.invalidateQueries({ queryKey: ['system', 'security'] });
      useSession.setState({ idleTimeoutMinutes: minutes });
      toast.success(`Logoff por inatividade: ${label(minutes)}`);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted">Regras de acesso que valem para todas as pessoas e todos os espaços.</p>
      <Card className="p-5">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-accent/15 text-accent"><Timer className="size-5" /></span>
          <div>
            <h2 className="font-display text-lg font-semibold">Logoff por inatividade</h2>
            <p className="text-sm text-muted">Sem mexer no sistema (mouse, teclado ou toque) por esse tempo, a sessão é encerrada e é preciso entrar de novo.</p>
          </div>
        </div>
        <div className="mt-5 grid gap-4 sm:grid-cols-2 sm:items-end">
          <Field label="Encerrar após">
            <Select value={custom ? 'custom' : String(minutes)} onChange={(e) => {
              if (e.target.value === 'custom') { setCustom(true); return; }
              setCustom(false); setMinutes(Number(e.target.value));
            }}>
              {PRESETS.map((m) => <option key={m} value={m}>{label(m)}{m === DEFAULT_IDLE_TIMEOUT_MINUTES ? ' (padrão)' : ''}</option>)}
              <option value="custom">Outro tempo…</option>
            </Select>
          </Field>
          {custom && (
            <Field label="Minutos" error={valid ? undefined : 'De 5 a 1440 minutos (24 horas)'}>
              <Input type="number" min={5} max={1440} value={minutes} onChange={(e) => setMinutes(Math.trunc(Number(e.target.value)))} />
            </Field>
          )}
        </div>
        <ul className="mt-4 flex flex-col gap-1 text-xs text-faint">
          <li>1 minuto antes aparece um aviso com o botão "Continuar conectado".</li>
          <li>Vale para todas as abas abertas: mexer em uma mantém as outras ativas.</li>
          <li>O servidor também encerra a sessão sozinho, mesmo com o navegador fechado.</li>
        </ul>
        <div className="mt-5 flex justify-end">
          <Button variant="primary" loading={busy} disabled={!valid || minutes === q.data.idleTimeoutMinutes} onClick={save}>Salvar</Button>
        </div>
      </Card>
      <Card className="p-5">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-surface-2 text-muted"><Lock className="size-5" /></span>
          <div>
            <h2 className="font-display text-lg font-semibold">Proteções sempre ativas</h2>
            <p className="text-sm text-muted">Não precisam de configuração.</p>
          </div>
        </div>
        <ul className="mt-4 grid gap-2 text-sm text-muted sm:grid-cols-2">
          <li>Senhas guardadas com Argon2id (nunca em texto).</li>
          <li>5 senhas erradas bloqueiam aquela conta naquele endereço por 15 minutos (o dono entra de outro lugar).</li>
          <li>Limites gerais de senhas erradas por endereço IP e por conta.</li>
          <li>Acesso por token de 15 minutos, renovado com troca a cada uso; token roubado e reutilizado derruba a sessão.</li>
          <li>Trocar a senha encerra as outras sessões; sessões podem ser encerradas em Meu perfil.</li>
          <li>Sair numa aba sai de todas.</li>
        </ul>
      </Card>
      <StorageCard />
    </div>
  );
}

// ------------------------------------------------------------------ armazenamento por espaço
interface StorageRow { id: string; name: string; quotaMb: number | null; usedBytes: number }
const GB = 1024 ** 3;
const size = (b: number) => (b >= GB ? `${(b / GB).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB` : `${Math.max(b ? 1 : 0, Math.round(b / 1024 ** 2)).toLocaleString('pt-BR')} MB`);

/** Quanto cada espaço usa de arquivos (anexos, documentos do contador, holerites) e a cota dele. */
function StorageCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['system', 'storage'], queryFn: () => get<{ defaultQuotaMb: number; items: StorageRow[] }>('/api/system/storage') });
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  if (!q.data) return null;
  const def = q.data.defaultQuotaMb;
  const save = async (o: StorageRow) => {
    const raw = (edit[o.id] ?? '').trim().replace(',', '.');
    const gb = raw === '' ? null : Number(raw);
    if (gb !== null && (!Number.isFinite(gb) || gb < 0.1)) { toast.error('Informe o limite em GB (mínimo 0,1) ou deixe vazio para usar o padrão'); return; }
    setBusy(o.id);
    try {
      await put(`/api/system/orgs/${o.id}/storage`, { quotaMb: gb === null ? null : Math.round(gb * 1024) });
      toast.success(gb === null ? `${o.name}: limite padrão (${size(def * 1024 ** 2)})` : `${o.name}: limite de ${size(Math.round(gb * 1024) * 1024 ** 2)}`);
      setEdit((e) => { const n = { ...e }; delete n[o.id]; return n; });
      qc.invalidateQueries({ queryKey: ['system', 'storage'] });
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  };
  return (
    <Card className="p-5">
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent"><HardDrive className="size-5" /></span>
        <div>
          <h2 className="font-display text-lg font-semibold">Armazenamento por espaço</h2>
          <p className="text-sm text-muted">Anexos de contas, documentos do contador e holerites. Ao chegar no limite, o espaço não consegue enviar arquivos novos. Padrão: {size(def * 1024 ** 2)}.</p>
        </div>
      </div>
      <ul className="mt-4 flex flex-col divide-y divide-line rounded-xl border border-line">
        {q.data.items.map((o) => {
          const quota = (o.quotaMb ?? def) * 1024 ** 2, pct = Math.min(100, Math.round((o.usedBytes / quota) * 100));
          const value = edit[o.id] ?? (o.quotaMb ? String(+(o.quotaMb / 1024).toFixed(2)).replace('.', ',') : '');
          return (
            <li key={o.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
              <div className="min-w-0 flex-1 basis-56">
                <p className="truncate text-sm font-medium">{o.name}</p>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2"><div className={pct >= 100 ? 'h-full bg-danger' : pct >= 90 ? 'h-full bg-warn' : 'h-full bg-accent'} style={{ width: `${Math.max(pct, o.usedBytes ? 2 : 0)}%` }} /></div>
                <p className="mt-1 text-xs text-muted tnum">{size(o.usedBytes)} de {size(quota)} ({pct}%){pct >= 100 ? ' · no limite: envios bloqueados' : pct >= 90 ? ' · perto do limite' : ''}</p>
              </div>
              <div className="flex items-center gap-2">
                <Input aria-label={`Limite de ${o.name} em GB`} inputMode="decimal" className="h-9 w-24 text-sm tnum" placeholder="padrão" value={value} onChange={(e) => setEdit({ ...edit, [o.id]: e.target.value })} />
                <span className="text-xs text-faint">GB</span>
                <Button size="sm" variant="secondary" loading={busy === o.id} disabled={edit[o.id] === undefined} onClick={() => save(o)}>Salvar</Button>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
