import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { ArrowRight, CheckCircle2, Download, Eraser, FileSignature, FileText, Lock, ShieldCheck } from 'lucide-react';
import { ESIGN_TERM_DECLARATION, ESIGN_TERM_TITLE, esignDeclaration, formatBRL, formatDocument, refLabelPT, type EsignOpened, type EsignPublicInfo } from '@nopaper/shared';
import { Button, Checkbox, Field, Input } from '@/components/ui/base';
import { Logo } from '@/components/layout/Logo';
import { LogoLoader } from '@/components/brand/Brand';
import { cn } from '@/lib/utils';

/** Página pública (sem login): o funcionário abre o link pessoal, confirma o CPF, confere o holerite e assina. */
class CallError extends Error { constructor(msg: string, public status: number, public code?: string) { super(msg); } }
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  try { r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new CallError('Sem conexão. Confira a internet e tente de novo.', 0); }
  const data = await r.json().catch(() => ({})) as { error?: string; code?: string };
  if (!r.ok) throw new CallError(data.error || (r.status === 429 ? 'Muitas tentativas. Espere um minuto e tente de novo.' : `Erro ${r.status}`), r.status, data.code);
  return data as T;
}
const when = (iso: string) => { const d = new Date(iso); return `${d.toLocaleDateString('pt-BR')} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`; };

/** O que uma tela passa para a outra (termo → holerite) sem pôr na URL: o CPF já digitado e para onde seguir. */
interface FlowState { cpf?: string; next?: string }

export function SignPage() {
  const { token = '' } = useParams();
  const state = (useLocation().state ?? {}) as FlowState;
  return <SignFlow key={token} token={token} cpf0={state.cpf ?? ''} next={state.next ?? null} />;
}

function SignFlow({ token, cpf0, next }: { token: string; cpf0: string; next: string | null }) {
  const nav = useNavigate();
  const base = `/api/sign/${encodeURIComponent(token)}`;
  const [info, setInfo] = useState<EsignPublicInfo | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [doc, setDoc] = useState<EsignOpened | null>(null);
  const [cpf, setCpf] = useState(cpf0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = useCallback(async (value: string) => {
    setBusy(true); setError(null);
    try { setDoc(await call<EsignOpened>('POST', `${base}/open`, { cpf: value })); }
    catch (err) { setError((err as CallError).message); } finally { setBusy(false); }
  }, [base]);
  useEffect(() => {
    call<EsignPublicInfo>('GET', base).then((i) => {
      setInfo(i);
      document.title = `${i.kind === 'term' ? 'Termo de aceite' : 'Assinar holerite'} · NoPaper`;
      if (cpf0) open(cpf0); // veio da outra tela com o CPF já conferido
    }).catch((e: CallError) => setFatal(e.message));
  }, [base, cpf0, open]);
  const expired = useCallback(() => { setDoc(null); setError('Por segurança, informe o CPF de novo para continuar.'); }, []);
  const term = info?.kind === 'term';

  return (
    <div className="safe-top safe-bottom safe-x min-h-dvh bg-bg">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-5 px-4 py-6 sm:py-10">
        <Logo scale="md" animated />
        {fatal ? (
          <Panel><div className="flex flex-col items-center gap-3 py-6 text-center"><Lock className="size-8 text-faint" /><p className="font-display text-lg font-semibold">Link indisponível</p><p className="text-sm text-muted">{fatal}</p></div></Panel>
        ) : !info || (cpf0 && busy && !doc) ? (
          <div className="grid place-items-center py-20"><LogoLoader size={96} label="Abrindo" /></div>
        ) : !doc ? (
          <Panel>
            <h1 className="font-display text-2xl font-semibold leading-tight">Olá, {info.firstName}!</h1>
            <p className="mt-1.5 text-sm text-muted">
              {term
                ? (info.status === 'signed'
                  ? <>Você já assinou o termo de aceite de assinatura eletrônica da {info.company}. Informe o seu CPF para ver e baixar a sua via.</>
                  : <>A {info.company} vai passar a enviar os holerites para você assinar pelo celular. Para ler e assinar o <b className="text-ink">termo de aceite</b>, informe o seu CPF.</>)
                : (info.status === 'signed'
                  ? <>Você já assinou o holerite de <b className="text-ink">{refLabelPT(info.competence)}</b> da {info.company}. Informe o seu CPF para ver e baixar a sua via.</>
                  : <>O seu holerite de <b className="text-ink">{refLabelPT(info.competence)}</b> da {info.company} está pronto para conferir e assinar. Para abrir, informe o seu CPF.</>)}
            </p>
            <form onSubmit={(e) => { e.preventDefault(); open(cpf); }} className="mt-5 flex flex-col gap-3">
              <Field label="CPF" error={error}>
                <Input inputMode="numeric" autoComplete="off" autoFocus placeholder="000.000.000-00" maxLength={14} value={cpf}
                  onChange={(e) => { setCpf(formatDocument(e.target.value.replace(/\D/g, '').slice(0, 11))); setError(null); }} className="h-12 text-lg tnum" />
              </Field>
              <Button type="submit" variant="primary" size="lg" loading={busy} disabled={cpf.replace(/\D/g, '').length !== 11}>{term ? 'Abrir o termo' : 'Abrir o holerite'}</Button>
            </form>
            <p className="mt-4 flex items-start gap-2 text-xs text-faint"><ShieldCheck className="mt-px size-4 shrink-0" />Este link é pessoal. Não encaminhe para outras pessoas.</p>
          </Panel>
        ) : doc.status === 'signed' ? (
          <Done doc={doc} base={base} onNext={next ? () => nav(`/assinar/${next}`, { state: { cpf } satisfies FlowState }) : null} />
        ) : doc.termPending ? (
          <>
            <Panel>
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent"><FileSignature className="size-5" /></span>
                <div className="min-w-0">
                  <h2 className="font-display text-lg font-semibold leading-tight">Antes, o termo de aceite</h2>
                  <p className="mt-1 text-sm text-muted">Para assinar holerites pelo celular, primeiro você lê e assina o termo de aceite. É uma vez só; depois você volta direto para este holerite.</p>
                </div>
              </div>
              {doc.termToken
                ? <Button variant="primary" size="lg" className="mt-4 w-full" icon={<ArrowRight className="size-4" />} onClick={() => nav(`/assinar/${doc.termToken}`, { state: { cpf, next: token } satisfies FlowState })}>Ler e assinar o termo</Button>
                : <p className="mt-4 rounded-lg border border-warn/40 bg-warn/10 p-2.5 text-sm">Peça à empresa o link do termo de aceite.</p>}
            </Panel>
            <Slip doc={doc} base={base} />
          </>
        ) : (
          <Review doc={doc} base={base} onSigned={(signedAt) => setDoc({ ...doc, status: 'signed', signedAt })} onExpired={expired} />
        )}
        <p className="text-center text-[11px] text-faint">Assinatura eletrônica pelo NoPaper · MP 2.200-2/2001, art. 10, § 2º</p>
      </div>
    </div>
  );
}

const Panel = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={cn('rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6', className)}>{children}</div>
);

function Slip({ doc, base }: { doc: EsignOpened; base: string }) {
  const pdf = (
    <a href={`${base}/file?k=${encodeURIComponent(doc.key)}`} target="_blank" rel="noreferrer"
      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] font-medium text-ink hover:bg-surface-2"><FileText className="size-4" />Ver PDF</a>
  );
  if (doc.kind === 'term') return (
    <Panel>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-faint">Termo de aceite</p>
          <p className="font-display text-lg font-semibold leading-tight">{ESIGN_TERM_TITLE}</p>
          <p className="mt-0.5 text-sm text-muted">{doc.company}</p>
        </div>
        {pdf}
      </div>
      <div className="mt-4 flex flex-col gap-3 text-sm leading-relaxed">{doc.term.map((p) => <p key={p}>{p}</p>)}</div>
    </Panel>
  );
  return (
    <Panel className="!p-0 overflow-hidden">
      <div className="flex items-start justify-between gap-3 p-5 pb-3 sm:p-6 sm:pb-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-faint">Holerite · {refLabelPT(doc.competence)}</p>
          <p className="truncate font-display text-lg font-semibold">{doc.employeeName}</p>
          <p className="truncate text-sm text-muted">{doc.company}</p>
        </div>
        {pdf}
      </div>
      {doc.items.length > 0 && (
        <ul className="border-t border-line text-sm">
          {doc.items.map((i, k) => (
            <li key={k} className="flex items-baseline gap-3 border-b border-line/60 px-5 py-2 last:border-b-0 sm:px-6">
              <span className="min-w-0 flex-1">{i.name}{i.ref && <span className="ml-1.5 text-xs text-faint">{i.ref}</span>}</span>
              <span className={cn('tnum shrink-0 font-medium', i.kind === 'deduction' ? 'text-danger' : 'text-ink')}>{i.kind === 'deduction' ? '− ' : ''}{formatBRL(i.amount)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-2 gap-px border-t border-line bg-line text-sm">
        <div className="bg-surface px-5 py-2.5 sm:px-6"><p className="text-xs text-faint">Vencimentos</p><p className="tnum font-medium">{formatBRL(doc.totalEarnings)}</p></div>
        <div className="bg-surface px-5 py-2.5 sm:px-6"><p className="text-xs text-faint">Descontos</p><p className="tnum font-medium">{formatBRL(doc.totalDeductions)}</p></div>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-line bg-accent-soft px-5 py-3.5 sm:px-6">
        <span className="text-sm font-medium text-accent">Valor líquido</span>
        <span className="tnum font-display text-2xl font-semibold text-accent">{formatBRL(doc.net)}</span>
      </div>
    </Panel>
  );
}

function Review({ doc, base, onSigned, onExpired }: { doc: EsignOpened; base: string; onSigned: (signedAt: string) => void; onExpired: () => void }) {
  const term = doc.kind === 'term';
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pad = useRef<PadHandle>(null);
  const [inked, setInked] = useState(false);
  const sign = async () => {
    const signature = pad.current?.png();
    if (!signature) return;
    setBusy(true); setError(null);
    try {
      const r = await call<{ signedAt: string }>('POST', `${base}/sign`, { key: doc.key, confirm: true, signature });
      onSigned(r.signedAt);
      window.scrollTo({ top: 0 });
    } catch (e) {
      const err = e as CallError;
      if (err.code === 'esign_expired') onExpired(); else setError(err.message);
    } finally { setBusy(false); }
  };
  return (
    <>
      <Slip doc={doc} base={base} />
      <Panel>
        <h2 className="font-display text-lg font-semibold">Assinar</h2>
        <Checkbox className="mt-4" checked={confirm} onChange={setConfirm} label={<span className="text-sm">{term ? ESIGN_TERM_DECLARATION : esignDeclaration(refLabelPT(doc.competence), formatBRL(doc.net))}</span>} />
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[13px] font-medium text-muted">Desenhe a sua assinatura com o dedo</span>
            <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] text-muted hover:bg-surface-2 hover:text-ink disabled:opacity-40" disabled={!inked} onClick={() => pad.current?.clear()}><Eraser className="size-3.5" />Limpar</button>
          </div>
          <SignaturePad ref={pad} onInk={setInked} />
        </div>
        {error && <p className="mt-3 rounded-lg border border-danger/40 bg-danger/10 p-2.5 text-sm">{error}</p>}
        <Button variant="primary" size="lg" className="mt-4 w-full" loading={busy} disabled={!inked || !confirm} onClick={sign}>{term ? 'Assinar o termo' : 'Assinar o holerite'}</Button>
        <p className="mt-3 text-xs text-faint">Ao assinar, ficam registrados a data, a hora e o aparelho usado. Depois você baixa a sua via assinada.</p>
      </Panel>
    </>
  );
}

function Done({ doc, base, onNext }: { doc: EsignOpened; base: string; onNext: (() => void) | null }) {
  const term = doc.kind === 'term';
  const download = (
    <a href={`${base}/file?k=${encodeURIComponent(doc.key)}&download=1`}
      className={cn('inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg px-5 text-[15px] font-medium', onNext ? 'border border-line text-ink hover:bg-surface-2' : 'bg-accent text-accent-ink shadow-[0_6px_20px_-8px_var(--np-accent)] hover:brightness-110')}><Download className="size-4" />Baixar a minha via (PDF)</a>
  );
  return (
    <>
      <Panel>
        <div className="flex flex-col items-center gap-2 py-3 text-center">
          <CheckCircle2 className="size-12 text-ok" />
          <h1 className="font-display text-2xl font-semibold">{term ? 'Termo assinado' : 'Holerite assinado'}</h1>
          <p className="text-sm text-muted">{doc.signedAt ? `Assinado em ${when(doc.signedAt)}.` : ''} A empresa já recebeu a via dela.</p>
          <div className="mt-3 flex w-full flex-col gap-2">
            {onNext && <Button variant="primary" size="lg" className="w-full" icon={<ArrowRight className="size-4" />} onClick={onNext}>Continuar para o holerite</Button>}
            {download}
          </div>
          <p className="mt-2 text-xs text-faint">Guarde o arquivo. Este link continua valendo para baixar de novo, sempre com o seu CPF.</p>
        </div>
      </Panel>
      <Slip doc={doc} base={base} />
    </>
  );
}

// ------------------------------------------------------------------ quadro de assinatura
interface PadHandle { clear: () => void; png: () => string | null }
/** Quadro sempre branco com traço escuro (vai para o PDF), independente do tema. */
function SignaturePad({ ref, onInk }: { ref: React.Ref<PadHandle>; onInk: (has: boolean) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const inked = useRef(false);
  /** Área desenhada (px de tela): a imagem sai recortada nela, para caber bem no campo do holerite. */
  const box = useRef({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
  const grow = (p: { x: number; y: number }) => { const b = box.current; b.x0 = Math.min(b.x0, p.x); b.y0 = Math.min(b.y0, p.y); b.x1 = Math.max(b.x1, p.x); b.y1 = Math.max(b.y1, p.y); };

  const setup = useCallback(() => {
    const c = canvas.current; if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3), r = c.getBoundingClientRect();
    c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 2.4; ctx.strokeStyle = '#141a29'; ctx.fillStyle = '#141a29';
    inked.current = false; onInk(false);
    box.current = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  }, [onInk]);
  useEffect(() => { setup(); }, [setup]);

  const png = () => {
    const c = canvas.current;
    if (!inked.current || !c) return null;
    const k = c.width / c.getBoundingClientRect().width, pad = 6, b = box.current;
    const x = Math.max(0, Math.floor((b.x0 - pad) * k)), y = Math.max(0, Math.floor((b.y0 - pad) * k));
    const w = Math.min(c.width - x, Math.ceil((b.x1 - b.x0 + 2 * pad) * k)), h = Math.min(c.height - y, Math.ceil((b.y1 - b.y0 + 2 * pad) * k));
    const out = document.createElement('canvas');
    out.width = Math.max(1, w); out.height = Math.max(1, h);
    out.getContext('2d')!.drawImage(c, x, y, w, h, 0, 0, w, h);
    return out.toDataURL('image/png');
  };
  const handle: PadHandle = { clear: setup, png };
  useEffect(() => { if (typeof ref === 'function') ref(handle); else if (ref) (ref as React.RefObject<PadHandle | null>).current = handle; });

  const pos = (e: React.PointerEvent) => { const r = canvas.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const down = (e: React.PointerEvent) => {
    e.preventDefault(); try { canvas.current!.setPointerCapture(e.pointerId); } catch { /* ponteiro sem captura */ }
    drawing.current = true; last.current = pos(e); grow(last.current);
    const ctx = canvas.current!.getContext('2d')!; ctx.beginPath(); ctx.arc(last.current.x, last.current.y, 1.2, 0, Math.PI * 2); ctx.fill();
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current || !last.current) return;
    const p = pos(e), ctx = canvas.current!.getContext('2d')!;
    ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    if (!inked.current && Math.hypot(p.x - last.current.x, p.y - last.current.y) > 1) { inked.current = true; onInk(true); }
    last.current = p; grow(p);
  };
  const up = () => { drawing.current = false; last.current = null; };
  return (
    <div className="relative overflow-hidden rounded-xl border-2 border-dashed border-line-strong bg-white">
      <canvas ref={canvas} className="block h-44 w-full touch-none cursor-crosshair" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-label="Quadro para desenhar a assinatura" />
      <span className="pointer-events-none absolute inset-x-6 bottom-9 border-b border-[#c9cfde]" />
      <span className="pointer-events-none absolute inset-x-0 bottom-2.5 text-center text-[11px] text-[#8a93a8]">assine acima da linha</span>
    </div>
  );
}
