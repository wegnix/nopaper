import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, ShieldAlert } from 'lucide-react';
import type { SpaceCheck } from '@nopaper/shared';
import { useOrg, useSession } from '@/lib/session';
import { Button, Checkbox } from '@/components/ui/base';

/**
 * Trava de "espaço errado" das importações: o servidor leu o arquivo e ele não parece ser do espaço
 * aberto (holerites de outra empresa, extrato de outra conta). `useSpaceGuard` guarda se a pessoa
 * decidiu continuar; enquanto não decidir, a janela mostra só o `WrongSpaceAlert` e o botão de
 * importar fica desligado (`blocked`).
 */
export function useSpaceGuard(check: SpaceCheck | null | undefined) {
  const [accepted, setAccepted] = useState(false);
  useEffect(() => { setAccepted(false); }, [check]);
  return { check: check ?? null, blocked: !!check && !accepted, accepted: !!check && accepted, accept: () => setAccepted(true) };
}

/** Faixa que fica na janela depois de "continuar mesmo assim": lembra, até o fim, que o arquivo é de outro lugar. */
export function WrongSpaceNote({ check }: { check: SpaceCheck }) {
  const org = useOrg();
  return (
    <p className="flex items-start gap-2 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">
      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
      <span>Você escolheu continuar em <b>{org?.name}</b> com um arquivo que {check.space ? <>é do espaço <b>{check.space.name}</b></> : 'não parece ser deste espaço'}.</span>
    </p>
  );
}

export function WrongSpaceAlert({ check, subject, risk, onOtherFile, onContinue, busy }: {
  check: SpaceCheck;
  /** "Estes holerites", "Este extrato", "Esta fatura". */
  subject: string;
  /** O que acontece se continuar (ex.: "os valores entram na folha deste espaço"). */
  risk: string;
  onOtherFile: () => void; onContinue: () => void; busy?: boolean;
}) {
  const org = useOrg();
  const setOrg = useSession((s) => s.setOrg);
  const qc = useQueryClient();
  const nav = useNavigate();
  const loc = useLocation();
  const [sure, setSure] = useState(false);
  const other = check.space;
  const goThere = () => { if (!other) return; setOrg(other.id); qc.clear(); nav(loc.pathname); };
  return (
    <div role="alert" className="flex flex-col gap-4 rounded-2xl border-2 border-danger bg-danger/10 p-5 sm:p-6">
      <div className="flex items-start gap-3.5">
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-danger text-white"><ShieldAlert className="size-6" /></span>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-danger">Espaço errado?</p>
          <h3 className="font-display text-xl font-semibold leading-tight">
            {other ? <>{subject} {subject.startsWith('Estes') ? 'são' : 'é'} do espaço {other.name}</> : <>{subject} não {subject.startsWith('Estes') ? 'parecem' : 'parece'} ser deste espaço</>}
          </h3>
          <p className="mt-1 text-sm text-muted">Você está em <b className="text-ink">{org?.name}</b>. Se continuar, {risk}</p>
        </div>
      </div>
      <dl className="grid gap-x-4 gap-y-2 rounded-xl border border-danger/30 bg-surface px-4 py-3 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted">No arquivo</dt>
        <dd className="min-w-0 break-words font-medium">{check.found}</dd>
        {check.expected && <>
          <dt className="text-muted">Neste espaço ({org?.name})</dt>
          <dd className="min-w-0 break-words font-medium">{check.expected}</dd>
        </>}
        {other && check.match && <>
          <dt className="text-muted">Em {other.name}</dt>
          <dd className="min-w-0 break-words">{check.match}</dd>
        </>}
      </dl>
      <div className="flex flex-wrap gap-2 max-sm:flex-col">
        {other && <Button variant="primary" icon={<ArrowRightLeft className="size-4" />} disabled={busy} onClick={goThere}>Ir para o espaço {other.name}</Button>}
        <Button variant={other ? 'secondary' : 'primary'} disabled={busy} onClick={onOtherFile}>Escolher outro arquivo</Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-danger/30 pt-4">
        <Checkbox className="min-w-0 flex-1 basis-64 text-sm" checked={sure} onChange={setSure} disabled={busy}
          label={<>Conferi: o arquivo é mesmo de <b>{org?.name}</b> e quero continuar aqui.</>} />
        <Button variant="danger" disabled={!sure} loading={busy} onClick={onContinue}>Continuar em {org?.name}</Button>
      </div>
    </div>
  );
}
