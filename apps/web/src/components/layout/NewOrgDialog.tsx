import { useState } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Dialog } from '@/components/ui/dialog';
import { Button, Field, Input, Segmented } from '@/components/ui/base';
import { post, errMsg } from '@/lib/api';
import { useSession, type SessionOrg } from '@/lib/session';
import { DocumentField } from '@/components/ui/document-input';
import { documentError } from '@nopaper/shared';

export function NewOrgDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'personal' | 'company'>('company');
  const [doc, setDoc] = useState('');
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  const submit = async () => {
    setBusy(true);
    try {
      const r = await post<{ org: { id: string }; orgs: SessionOrg[] }>('/api/orgs', { name, kind, document: doc });
      const s = useSession.getState();
      useSession.setState({ orgs: r.orgs });
      s.setOrg(r.org.id);
      qc.clear();
      toast.success('Espaço criado');
      setName(''); setDoc('');
      onClose();
      nav('/');
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Novo espaço" description="Cada espaço tem contas, categorias e membros separados. Use um para as finanças pessoais e outro para cada empresa." size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={name.trim().length < 2 || !!documentError(doc)} onClick={submit}>Criar espaço</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Nome"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Padaria Central" /></Field>
        <Field label="Tipo"><Segmented value={kind} onChange={setKind} options={[{ value: 'personal', label: 'Pessoal' }, { value: 'company', label: 'Empresa' }]} /></Field>
        <DocumentField label={kind === 'personal' ? 'CPF (opcional)' : 'CNPJ (opcional)'} value={doc} onChange={setDoc} />
      </div>
    </Dialog>
  );
}
