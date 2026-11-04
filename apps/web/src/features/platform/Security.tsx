import { useEffect, useState } from 'react';
import { Navigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Lock, Timer } from 'lucide-react';
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
          <li>5 senhas erradas para o mesmo usuário bloqueiam esse login por 15 minutos.</li>
          <li>Limite de tentativas de login por endereço IP.</li>
          <li>Acesso por token de 15 minutos, renovado com troca a cada uso; token roubado e reutilizado derruba a sessão.</li>
          <li>Trocar a senha encerra as outras sessões; sessões podem ser encerradas em Meu perfil.</li>
          <li>Sair numa aba sai de todas.</li>
        </ul>
      </Card>
    </div>
  );
}
