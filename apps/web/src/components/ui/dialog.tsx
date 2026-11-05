import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Dialog as RDialog } from 'radix-ui';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './base';

const sizes = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' };

export function Dialog({
  open, onClose, title, description, children, footer, size = 'md', className,
}: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode;
  footer?: ReactNode; size?: keyof typeof sizes; className?: string;
}) {
  return (
    <RDialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
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
