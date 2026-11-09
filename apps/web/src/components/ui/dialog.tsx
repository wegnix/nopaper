import { createContext, useCallback, useContext, useRef, useState, type ReactNode, type SetStateAction } from 'react';
import { Dialog as RDialog } from 'radix-ui';
import { AnimatePresence, motion } from 'motion/react';
import { Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './base';

const sizes = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' };

/**
 * Janela. `dirty` = há alterações não salvas: fechar (X, Esc, clique fora ou o botão Fechar do
 * `SaveFooter`) pergunta antes de descartar.
 */
export function Dialog({
  open, onClose, title, description, children, footer, size = 'md', className, dirty,
}: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode;
  footer?: ReactNode; size?: keyof typeof sizes; className?: string; dirty?: boolean;
}) {
  const close = useGuardedClose(onClose, !!dirty);
  return (
    <RDialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <AnimatePresence>
        {open && (
          <RDialog.Portal forceMount>
            <RDialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-[5000] bg-[#05070d]/60 backdrop-blur-[3px]"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
              />
            </RDialog.Overlay>
            <div className="fixed inset-0 z-[5001] grid grid-cols-1 place-items-end sm:place-items-center p-0 sm:p-4 pointer-events-none">
              <RDialog.Content asChild forceMount aria-describedby={description ? undefined : undefined}>
                <motion.div
                  className={cn('pointer-events-auto w-full min-w-0 flex flex-col max-h-[calc(100dvh-env(safe-area-inset-top)-12px)] sm:max-h-[92dvh] rounded-t-2xl sm:rounded-2xl border border-line bg-surface shadow-2xl max-sm:pb-[env(safe-area-inset-bottom)]', sizes[size], className)}
                  initial={{ opacity: 0, y: 24, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 16, scale: 0.98 }}
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                >
                  <div className="flex items-start justify-between gap-4 px-4 sm:px-5 pt-4 sm:pt-5 pb-3">
                    <div className="min-w-0">
                      <RDialog.Title className="font-display text-xl font-semibold leading-tight">{title}</RDialog.Title>
                      {description ? <RDialog.Description className="mt-1 text-sm text-muted">{description}</RDialog.Description> : <RDialog.Description className="sr-only">{typeof title === 'string' ? title : 'Diálogo'}</RDialog.Description>}
                    </div>
                    <RDialog.Close className="-mr-2 -mt-2 sm:-mr-1 sm:-mt-1 grid size-10 sm:size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink" aria-label="Fechar">
                      <X className="size-5 sm:size-4" />
                    </RDialog.Close>
                  </div>
                  <div className="px-4 sm:px-5 pb-5 overflow-y-auto overscroll-contain min-h-0">{children}</div>
                  {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 sm:px-5 py-3.5 bg-surface-2/50 sm:rounded-b-2xl">{footer}</div>}
                </motion.div>
              </RDialog.Content>
            </div>
          </RDialog.Portal>
        )}
      </AnimatePresence>
    </RDialog.Root>
  );
}

// ---------------------------------------------------------------- confirmação via promise
interface ConfirmOpts { title: string; body?: ReactNode; confirmLabel?: string; tone?: 'danger' | 'primary' }
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => { state?.resolve(v); setState(null); };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Dialog
        open={!!state} onClose={() => close(false)} title={state?.title ?? ''} size="sm"
        footer={<>
          <Button variant="ghost" onClick={() => close(false)}>Cancelar</Button>
          <Button variant={state?.tone === 'danger' ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>{state?.confirmLabel ?? 'Confirmar'}</Button>
        </>}
      >
        {state?.body && <div className="text-sm text-muted leading-relaxed">{state.body}</div>}
      </Dialog>
    </ConfirmCtx.Provider>
  );
}

// ---------------------------------------------------------------- formulários: salvar sem fechar
const serialize = (v: unknown) => JSON.stringify(v, (_k, x) => (x instanceof Set ? [...x].sort() : x));

/**
 * Estado de formulário que sabe se mudou desde o último salvar/carregar.
 * `load(v)` troca o valor e a base (abrir outro registro); `markSaved(v)` diz que `v` foi gravado
 * (passe o valor enviado: o que for digitado durante o salvamento continua "não salvo").
 */
export function useFormState<T>(initial: T | (() => T)) {
  const [value, setValue] = useState<T>(initial);
  const [base, setBase] = useState(() => serialize(value));
  const load = useCallback((v: T) => { setValue(v); setBase(serialize(v)); }, []);
  const markSaved = useCallback((v: T) => setBase(serialize(v)), []);
  const dirty = serialize(value) !== base;
  return [value, setValue as (v: SetStateAction<T>) => void, { dirty, load, markSaved }] as const;
}

/** Fecha direto, ou pergunta antes se houver alterações não salvas. */
export function useGuardedClose(onClose: () => void, dirty: boolean) {
  const confirm = useConfirm();
  const asking = useRef(false);
  return useCallback(async () => {
    if (!dirty) { onClose(); return; }
    if (asking.current) return;
    asking.current = true;
    const ok = await confirm({ title: 'Descartar as alterações?', body: 'Há alterações que ainda não foram salvas nesta janela.', confirmLabel: 'Descartar', tone: 'danger' });
    asking.current = false;
    if (ok) onClose();
  }, [dirty, onClose, confirm]);
}

/**
 * Rodapé padrão de cadastro: "Salvar" grava e mantém a janela aberta; "Fechar" fecha (perguntando
 * se houver algo não salvo). `left` = ações extras à esquerda (ex.: Apagar).
 */
export function SaveFooter({ dirty, saving, onSave, onClose, canSave = true, saveLabel = 'Salvar', left, readOnly, isNew }: {
  dirty: boolean; saving?: boolean; onSave: () => void; onClose: () => void; canSave?: boolean; saveLabel?: string; left?: ReactNode; readOnly?: boolean; isNew?: boolean;
}) {
  const close = useGuardedClose(onClose, dirty);
  return (
    <>
      {left}
      {!readOnly && !isNew && (
        <span className={cn('inline-flex items-center gap-1.5 text-xs', dirty ? 'text-warn' : 'text-faint', !left && 'mr-auto')} aria-live="polite">
          {dirty ? <><span className="size-1.5 rounded-full bg-warn" />Alterações não salvas</> : <><Check className="size-3.5" />Tudo salvo</>}
        </span>
      )}
      <Button variant="ghost" onClick={close}>Fechar</Button>
      {!readOnly && <Button variant="primary" loading={saving} disabled={!canSave || (!dirty && !isNew)} onClick={onSave}>{saveLabel}</Button>}
    </>
  );
}
