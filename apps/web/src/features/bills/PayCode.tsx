import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, QrCode, ScanBarcode } from 'lucide-react';
import {
  PIX_KEY_TYPE_LABEL, buildPixBrCode, formatBRL, formatDateBR, itfWidths, parseBoleto, parsePix, pixKeyCandidates,
  type PixKeyType,
} from '@nopaper/shared';
import { cn } from '@/lib/utils';
import { Segmented, Spinner, Switch, Tooltip } from '@/components/ui/base';
import { Dialog } from '@/components/ui/dialog';
import { CopyButton } from './attachments';

/** Símbolo do Pix (losango), no traço dos outros ícones. */
export function PixIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M10.6 3.6a2 2 0 0 1 2.8 0l7 7a2 2 0 0 1 0 2.8l-7 7a2 2 0 0 1-2.8 0l-7-7a2 2 0 0 1 0-2.8z" />
      <path d="M6.9 7.3h1a2.4 2.4 0 0 1 1.7.7l1.6 1.6a1.15 1.15 0 0 0 1.6 0L14.4 8a2.4 2.4 0 0 1 1.7-.7h1" />
      <path d="M6.9 16.7h1a2.4 2.4 0 0 0 1.7-.7l1.6-1.6a1.15 1.15 0 0 1 1.6 0l1.6 1.6a2.4 2.4 0 0 0 1.7.7h1" />
    </svg>
  );
}

/** Botão pequeno (mesmo tamanho do "Copiar") que abre o código para ler com o celular. */
function CodeButton({ label, className, icon, children }: { label: string; className?: string; icon: ReactNode; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    // a janela é filha deste span na árvore do React: o clique dentro dela não pode chegar à linha da lista
    <span className="contents" onClick={(e) => e.stopPropagation()}>
      <Tooltip content={label}>
        <button
          type="button" aria-label={label} onClick={() => setOpen(true)}
          className={cn('inline-grid place-items-center size-6 pointer-coarse:size-8 rounded text-muted hover:bg-surface-2 transition-colors', className)}
        >
          {icon}
        </button>
      </Tooltip>
      {open && children(() => setOpen(false))}
    </span>
  );
}

// ---------------------------------------------------------------- PIX

/** Desenho do QR Code (sempre preto no branco, com a margem que os leitores pedem). */
function QrSvg({ text }: { text: string }) {
  const [path, setPath] = useState<{ d: string; n: number } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setPath(null); setFailed(false);
    import('qrcode-generator').then(({ default: qrcode }) => {
      if (!alive) return;
      try {
        const qr = qrcode(0, 'M');
        qr.addData(text, 'Byte');
        qr.make();
        const n = qr.getModuleCount();
        let d = '';
        for (let r = 0; r < n; r++) {
          for (let c = 0; c < n; c++) {
            if (!qr.isDark(r, c)) continue;
            let w = 1;
            while (c + w < n && qr.isDark(r, c + w)) w++;
            d += `M${c + 4} ${r + 4}h${w}v1h-${w}z`;
            c += w - 1;
          }
        }
        setPath({ d, n: n + 8 });
      } catch { setFailed(true); }
    }).catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [text]);
  return (
    <div className="mx-auto grid aspect-square w-full max-w-[300px] place-items-center rounded-xl bg-white p-1 shadow-card ring-1 ring-black/10">
      {failed ? <p className="px-6 text-center text-sm text-neutral-600">Não deu para desenhar o QR Code. Use o botão de copiar.</p>
        : !path ? <Spinner />
          : (
            <svg viewBox={`0 0 ${path.n} ${path.n}`} className="size-full" shapeRendering="crispEdges" role="img" aria-label="QR Code do PIX">
              <rect width={path.n} height={path.n} fill="#fff" />
              <path d={path.d} fill="#000" />
            </svg>
          )}
    </div>
  );
}

export function PixQrDialog({ pix, amount, name, onClose }: { pix: string; amount?: string | null; name?: string | null; onClose: () => void }) {
  const raw = pix.trim();
  const info = useMemo(() => parsePix(raw), [raw]);
  const types = useMemo(() => (info.isBrCode ? [] : pixKeyCandidates(raw)), [info.isBrCode, raw]);
  const [type, setType] = useState<PixKeyType | null>(null);
  const keyType = type ?? types[0] ?? null;
  const hasAmount = !!amount && Number(amount) > 0;
  const [withAmount, setWithAmount] = useState(true);
  const code = useMemo(() => {
    if (info.isBrCode) return raw;
    if (!keyType) return null;
    return buildPixBrCode({ key: raw, keyType, amount: hasAmount && withAmount ? amount : null, name });
  }, [info.isBrCode, raw, keyType, hasAmount, withAmount, amount, name]);
  const shownAmount = info.isBrCode ? info.amount : hasAmount && withAmount ? amount : null;

  return (
    <Dialog open onClose={onClose} size="sm" title={<span className="inline-flex items-center gap-2"><PixIcon className="size-5 text-teal-600 dark:text-teal-300" />Pagar com PIX</span>} description="Abra o app do banco no celular e aponte a câmera para o código.">
      {!code ? (
        <p className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
          <span>Não reconheci este texto como chave PIX (CPF, CNPJ, e-mail, celular ou chave aleatória) nem como PIX copia e cola. Confira o campo PIX da conta.</span>
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {info.isBrCode && !info.crcValid && (
            <p className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
              <span>Este PIX copia e cola parece incompleto ou alterado: o banco pode recusar.</span>
            </p>
          )}
          <QrSvg text={code} />
          <div className="text-center">
            <p className="font-display text-2xl font-semibold tnum">{shownAmount ? formatBRL(shownAmount) : 'Valor a digitar no banco'}</p>
            <p className="mt-0.5 break-all text-sm text-muted">
              {info.isBrCode
                ? [info.merchantName, info.key && `chave ${info.key}`].filter(Boolean).join(' · ') || 'PIX copia e cola'
                : `${keyType ? PIX_KEY_TYPE_LABEL[keyType] : 'Chave'}: ${raw}`}
            </p>
          </div>
          {!info.isBrCode && types.length > 1 && keyType && (
            <div className="flex flex-col items-center gap-1.5">
              <p className="text-xs text-muted">Este número serve como CPF e como celular. Qual é a chave?</p>
              <Segmented value={keyType} onChange={setType} options={types.map((t) => ({ value: t, label: PIX_KEY_TYPE_LABEL[t] }))} />
            </div>
          )}
          {!info.isBrCode && hasAmount && (
            <Switch checked={withAmount} onChange={setWithAmount} label="Já levar o valor da conta" hint="Desligue para digitar o valor no banco (juros, desconto, pagamento parcial)." />
          )}
          <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-2 py-1.5 pl-3 pr-1.5">
            <span className="min-w-0 truncate font-mono text-xs text-muted">{code}</span>
            <CopyButton text={code} label="Copiar PIX copia e cola" toastMsg="PIX copia e cola copiado" className="size-8 shrink-0" />
          </div>
          <p className="text-center text-xs text-faint">Confira o nome de quem recebe na tela do banco antes de confirmar.</p>
        </div>
      )}
    </Dialog>
  );
}

export function PixQrButton({ pix, amount, name, className }: { pix: string; amount?: string | null; name?: string | null; className?: string }) {
  return (
    <CodeButton label="QR Code do PIX" className={cn('hover:text-teal-600 dark:hover:text-teal-300', className)} icon={<QrCode className="size-4" strokeWidth={2.2} />}>
      {(close) => <PixQrDialog pix={pix} amount={amount} name={name} onClose={close} />}
    </CodeButton>
  );
}

// ---------------------------------------------------------------- boleto

/** Módulo de 2 px e traço largo de 3 módulos: 850 px de largura, do tamanho que os apps leem na tela. */
const MODULE = 2, QUIET = 10, BAR_HEIGHT = 110;

function BarcodeSvg({ digits }: { digits: string }) {
  const { rects, width } = useMemo(() => {
    const out: Array<{ x: number; w: number }> = [];
    let x = QUIET;
    itfWidths(digits).forEach((w, i) => { if (i % 2 === 0) out.push({ x, w }); x += w; });
    return { rects: out, width: x + QUIET };
  }, [digits]);
  return (
    <div className="mx-auto w-full rounded-xl bg-white py-4 shadow-card ring-1 ring-black/10" style={{ maxWidth: width * MODULE }}>
      <svg viewBox={`0 0 ${width} ${BAR_HEIGHT / MODULE}`} preserveAspectRatio="none" className="block w-full" style={{ height: BAR_HEIGHT }} shapeRendering="crispEdges" role="img" aria-label="Código de barras do boleto">
        {rects.map((r) => <rect key={r.x} x={r.x} y={0} width={r.w} height={BAR_HEIGHT / MODULE} fill="#000" />)}
      </svg>
    </div>
  );
}

export function BarcodeDialog({ barcode, onClose }: { barcode: string; onClose: () => void }) {
  const info = useMemo(() => parseBoleto(barcode), [barcode]);
  return (
    <Dialog open onClose={onClose} size="xl" title="Pagar o boleto" description="Abra o app do banco no celular, escolha pagar boleto e aponte a câmera para o código de barras.">
      {!info ? (
        <p className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
          <span>O código desta conta não tem o tamanho de um boleto (44, 47 ou 48 dígitos). Confira o campo de código de barras.</span>
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {!info.valid && (
            <p className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
              <span>Os dígitos verificadores não conferem: o banco pode recusar este código.</span>
            </p>
          )}
          <BarcodeSvg digits={info.barcode} />
          <p className="text-center text-xs text-faint sm:hidden">Em tela pequena as barras ficam finas demais para a câmera: abra no computador ou use a linha digitável.</p>
          <div className="text-center">
            <p className="font-display text-2xl font-semibold tnum">{info.amount ? formatBRL(info.amount) : 'Valor informado no pagamento'}</p>
            <p className="mt-0.5 text-sm text-muted">
              {[info.kind === 'bancario' ? `Boleto bancário${info.bankCode ? ` (banco ${info.bankCode})` : ''}` : 'Boleto de arrecadação', info.dueDate && `vence ${formatDateBR(info.dueDate)}`].filter(Boolean).join(' · ')}
            </p>
          </div>
          <div className="mx-auto flex max-w-full items-center gap-2 rounded-lg border border-line bg-surface-2 py-1.5 pl-3 pr-1.5">
            <span className="min-w-0 break-all font-mono text-xs text-muted">{info.line}</span>
            <CopyButton text={info.line.replace(/\D/g, '')} label="Copiar linha digitável" toastMsg="Linha digitável copiada" className="size-8 shrink-0" />
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function BarcodeButton({ barcode, className }: { barcode: string; className?: string }) {
  return (
    <CodeButton label="Código de barras para ler com o celular" className={cn('hover:text-sky-600 dark:hover:text-sky-300', className)} icon={<ScanBarcode className="size-4" strokeWidth={2.2} />}>
      {(close) => <BarcodeDialog barcode={barcode} onClose={close} />}
    </CodeButton>
  );
}
