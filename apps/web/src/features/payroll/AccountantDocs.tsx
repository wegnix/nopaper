import { FileText } from 'lucide-react';
import { addMonthsRef, refLabelPT } from '@nopaper/shared';
import { useCan } from '@/lib/session';
import { cn } from '@/lib/utils';
import { useAccountingDocs, type AccountingDoc } from '@/features/accounting/data';

/**
 * PDFs de holerites que o contador já enviou pela área do contador, para usar direto na folha
 * (importar os valores ou enviar para assinatura) sem baixar e subir o mesmo arquivo de novo.
 * Aparecem primeiro os do mês desta folha; só para quem confere os documentos do contador.
 */
export function AccountantPayslipDocs({ enabled, folhaRef, payMonth, onPick, busy, action }: {
  enabled: boolean; folhaRef: string; payMonth: 'same' | 'next'; onPick: (doc: AccountingDoc) => void; busy?: string | null; action: string;
}) {
  const can = useCan();
  const q = useAccountingDocs('to_client', enabled && can('accounting.review'));
  // o holerite da competência C entra na folha C+1 quando a folha é contada pelo mês do pagamento
  const folhaOf = (competence: string) => (payMonth === 'same' ? addMonthsRef(competence, 1) : competence);
  const docs = (q.data ?? []).filter((d) => d.kind === 'payslip' && d.mime === 'application/pdf' && d.status !== 'dismissed' && !d.hiddenAt)
    .map((d) => ({ d, comp: d.detected?.slipsRef ?? d.competence ?? null }))
    .map((x) => ({ ...x, here: !!x.comp && folhaOf(x.comp) === folhaRef }))
    .sort((a, b) => Number(b.here) - Number(a.here) || b.d.createdAt.localeCompare(a.d.createdAt)).slice(0, 4);
  if (!docs.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px] font-medium text-muted">Enviados pelo contador</p>
      <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
        {docs.map(({ d, comp, here }) => (
          <li key={d.id}>
            <button type="button" disabled={!!busy} onClick={() => onPick(d)}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-surface-2 disabled:opacity-60">
              <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', here ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-faint')}><FileText className="size-4" /></span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2">
                  <span className="truncate text-sm font-medium">{d.originalName}</span>
                  {here && <span className="rounded-full bg-accent px-2 py-px text-[11px] font-semibold text-accent-ink">desta folha</span>}
                </span>
                <span className="block text-xs text-muted">
                  {comp ? `Holerites de ${refLabelPT(comp)}` : 'Holerites'}{d.detected?.slips ? ` · ${d.detected.slips} funcionário(s)` : ''} · enviado em {new Date(d.createdAt).toLocaleDateString('pt-BR')}{d.uploadedByName ? ` por ${d.uploadedByName}` : ''}
                </span>
              </span>
              <span className="shrink-0 text-[13px] font-medium text-accent">{busy === d.id ? 'Lendo…' : action}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
