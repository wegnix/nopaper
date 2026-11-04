import { useEffect } from 'react';
import { toast } from 'sonner';
import { post } from './api';
import { useSession, type SessionEnd } from './session';

/**
 * Logoff por inatividade.
 * - "Atividade" = interação real (mouse, teclado, toque, rolagem). Consultas automáticas não contam.
 * - A última atividade é compartilhada entre abas (localStorage): mexer numa aba mantém todas abertas.
 * - Enquanto há atividade, um heartbeat a cada ~2 min (`/api/auth/activity`) avisa o servidor,
 *   que também encerra a sessão sozinho se o tempo passar (com 3 min de folga).
 * - 1 minuto antes, um aviso com "Continuar conectado"; no tempo, sai e avisa as outras abas.
 */
const LAST_KEY = 'np:last-activity';
const LOGOUT_KEY = 'np:logout';
const HEARTBEAT_MS = 2 * 60_000;
const WARN_MS = 60_000;
const TOAST_ID = 'np-idle';

const readLast = () => { try { return Number(localStorage.getItem(LAST_KEY)) || 0; } catch { return 0; } };
const writeLast = (t: number) => { try { localStorage.setItem(LAST_KEY, String(t)); } catch { /* modo privado */ } };

/** Sai da conta (revoga a sessão no servidor) e avisa as outras abas abertas. */
export async function endSession(reason: SessionEnd = null) {
  await post('/api/auth/logout').catch(() => null);
  try { localStorage.setItem(LOGOUT_KEY, JSON.stringify({ at: Date.now(), reason })); } catch { /* ignore */ }
  toast.dismiss(TOAST_ID);
  useSession.getState().clear(reason);
}

export function useIdleLogout() {
  const minutes = useSession((s) => s.idleTimeoutMinutes);
  const authed = useSession((s) => s.status === 'authed');

  useEffect(() => {
    if (!authed) return;
    const timeoutMs = minutes * 60_000;
    let last = Math.max(readLast(), Date.now());
    let lastBeat = Date.now();
    let lastWrite = 0;
    let warned = false;

    const beat = () => { lastBeat = Date.now(); post('/api/auth/activity').catch(() => null); };
    const mark = () => {
      const now = Date.now();
      last = now;
      if (now - lastWrite > 5000) { lastWrite = now; writeLast(now); }
      if (warned) { warned = false; toast.dismiss(TOAST_ID); }
      if (now - lastBeat >= HEARTBEAT_MS) beat();
    };
    writeLast(last);

    const check = () => {
      const idle = Date.now() - Math.max(last, readLast());
      if (idle >= timeoutMs) { void endSession('idle'); return; }
      if (idle >= timeoutMs - WARN_MS && !warned) {
        warned = true;
        toast.warning('Sua sessão vai ser encerrada por inatividade em 1 minuto.', {
          id: TOAST_ID, duration: Infinity,
          action: { label: 'Continuar conectado', onClick: () => { mark(); beat(); } },
        });
      }
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === LOGOUT_KEY && e.newValue) {
        let reason: SessionEnd = null;
        try { reason = (JSON.parse(e.newValue) as { reason: SessionEnd }).reason; } catch { /* ignore */ }
        toast.dismiss(TOAST_ID);
        useSession.getState().clear(reason);
      }
      if (e.key === LAST_KEY && warned && readLast() > last) { warned = false; toast.dismiss(TOAST_ID); }
    };
    // voltar para a aba (ou o PC acordar) confere na hora, sem esperar o próximo ciclo
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };

    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
    for (const ev of events) window.addEventListener(ev, mark, { passive: true, capture: true });
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(check, 15_000);
    return () => {
      for (const ev of events) window.removeEventListener(ev, mark, { capture: true });
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
      toast.dismiss(TOAST_ID);
    };
  }, [authed, minutes]);
}
