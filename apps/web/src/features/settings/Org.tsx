import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { documentError } from '@nopaper/shared';
import { Button, Card, Field, Segmented, Select, Input } from '@/components/ui/base';
import { DocumentField } from '@/components/ui/document-input';
import { get, put, errMsg } from '@/lib/api';
import { useSession } from '@/lib/session';

interface Org { id: string; name: string; kind: 'personal' | 'company'; document: string | null; timezone: string }

const BR_ZONES: Array<[string, string]> = [
  ['America/Sao_Paulo', 'Brasília (SP, RJ, MG, Sul, GO, DF, BA, Nordeste…)'],
  ['America/Manaus', 'Amazonas (AM) e RR, RO, MT, MS'],
  ['America/Cuiaba', 'Mato Grosso (MT)'],
  ['America/Campo_Grande', 'Mato Grosso do Sul (MS)'],
  ['America/Porto_Velho', 'Rondônia (RO)'],
  ['America/Boa_Vista', 'Roraima (RR)'],
  ['America/Rio_Branco', 'Acre (AC)'],
  ['America/Belem', 'Pará (PA) e Amapá (AP)'],
  ['America/Fortaleza', 'Ceará (CE), MA, PI, RN, PB'],
  ['America/Recife', 'Pernambuco (PE)'],
  ['America/Maceio', 'Alagoas (AL) e Sergipe (SE)'],
  ['America/Bahia', 'Bahia (BA)'],
  ['America/Araguaina', 'Tocantins (TO)'],
  ['America/Noronha', 'Fernando de Noronha'],
];

export function OrgPage() {
  const orgId = useSession((s) => s.orgId);
  const q = useQuery({ queryKey: ['org', orgId], queryFn: () => get<{ org: Org }>('/api/org').then((r) => r.org) });
  const [f, setF] = useState<Org | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) setF(q.data); }, [q.data]);
  const zones = useMemo(() => (f && !BR_ZONES.some(([z]) => z === f.timezone) ? [[f.timezone, f.timezone] as [string, string], ...BR_ZONES] : BR_ZONES), [f]);
  if (!f) return null;
  const docErr = documentError(f.document);
  const save = async () => {
    setBusy(true);
    try {
      const r = await put<{ org: Org }>('/api/org', { name: f.name, kind: f.kind, document: f.document, timezone: f.timezone });
      setF(r.org);
      const s = useSession.getState();
      useSession.setState({ orgs: s.orgs.map((o) => (o.id === f.id ? { ...o, name: f.name, kind: f.kind } : o)) });
      toast.success('Espaço atualizado');
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Card className="p-5">
      <h2 className="font-display text-lg font-semibold">Dados do espaço</h2>
      <div className="mt-4 grid sm:grid-cols-2 gap-4">
        <Field label="Nome"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <DocumentField label={f.kind === 'personal' ? 'CPF (ou CNPJ, se MEI)' : 'CNPJ (ou CPF)'} value={f.document ?? ''} onChange={(document) => setF({ ...f, document })} />
        <Field label="Tipo"><Segmented value={f.kind} onChange={(kind) => setF({ ...f, kind })} options={[{ value: 'personal', label: 'Pessoal' }, { value: 'company', label: 'Empresa' }]} /></Field>
        <Field label="Fuso horário" hint="Define o que é “hoje” para vencimentos e alertas.">
          <Select value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>
            {zones.map(([z, label]) => <option key={z} value={z}>{label}</option>)}
          </Select>
        </Field>
      </div>
      <Button className="mt-4" variant="primary" loading={busy} disabled={!!docErr || f.name.trim().length < 2} onClick={save}>Salvar</Button>
    </Card>
  );
}
