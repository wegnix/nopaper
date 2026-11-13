import { create } from 'zustand';
import { billNames, type BillType, type Permission } from '@nopaper/shared';
import { EMBEDDED } from './embed';

export interface SessionUser {
  id: string; email: string; username: string; name: string; isSuperadmin: boolean; mustChangePassword?: boolean; canCreateOrgs?: boolean;
  /** Admin da instalação no 1º acesso: escolhe o perfil do espaço inicial junto com a senha. */
  needsInitialOrg?: boolean;
  /** Sugestão de nome do espaço inicial (ADMIN_ORG_NAME do .env). */
  initialOrgName?: string;
  telegramChatId: string | null; preferences: Record<string, unknown>;
}
export interface SessionOrg {
  id: string; name: string; kind: 'personal' | 'company'; /** Logo do espaço (data URL) ou null: mostra a inicial do nome. */ logo?: string | null; isOwner: boolean; isAdmin: boolean; permissions: Permission[];
  /** Liberado para aparecer quando o NoPaper está dentro de outro sistema. */
  embedVisible?: boolean;
}
export interface SessionPayload { accessToken?: string; user: SessionUser; orgs: SessionOrg[]; app?: { version: string; embed?: boolean }; security?: { idleTimeoutMinutes: number } }
/** Por que a sessão terminou (mensagem na tela de login). */
export type SessionEnd = 'idle' | 'expired' | null;

interface SessionState {
  status: 'loading' | 'anon' | 'authed';
  accessToken: string | null;
  user: SessionUser | null;
  orgs: SessionOrg[];
  orgId: string | null;
  /** Versão do NoPaper no servidor (pode ser mais nova que este front, em cache). */
  serverVersion: string | null;
  /** A instalação aceita ser exibida dentro de outro sistema (mostra o controle em Dados do espaço). */
  embedEnabled: boolean;
  /** Modo embutido: a pessoa tem espaços, mas nenhum liberado para aparecer aqui. */
  embedBlocked: boolean;
  /** Minutos sem interação até o logoff automático (configuração da plataforma). */
  idleTimeoutMinutes: number;
  endReason: SessionEnd;
  /** Abrindo o app com o servidor fora do ar: mostra "Conectando…" em vez do login. */
  connecting: boolean;
  setConnecting(v: boolean): void;
  setSession(p: SessionPayload): void;
  setOrg(id: string): void;
  clear(reason?: SessionEnd): void;
}

const ORG_KEY = 'np:org';
const readOrg = () => { try { return localStorage.getItem(ORG_KEY); } catch { return null; } };

export const useSession = create<SessionState>((set, get) => ({
  status: 'loading',
  accessToken: null,
  user: null,
  orgs: [],
  orgId: null,
  serverVersion: null,
  embedEnabled: false,
  embedBlocked: false,
  idleTimeoutMinutes: 60,
  endReason: null,
  connecting: false,
  setConnecting(v) { if (get().connecting !== v) set({ connecting: v }); },
  setSession(p) {
    // dentro de outro sistema só entram os espaços liberados para isso (Dados do espaço)
    const orgs = EMBEDDED ? p.orgs.filter((o) => o.embedVisible) : p.orgs;
    const saved = get().orgId ?? readOrg();
    const orgId = orgs.find((o) => o.id === saved)?.id ?? orgs[0]?.id ?? null;
    set({ status: 'authed', accessToken: p.accessToken ?? get().accessToken, user: p.user, orgs, orgId,
      embedEnabled: p.app?.embed ?? get().embedEnabled, embedBlocked: EMBEDDED && p.orgs.length > 0 && orgs.length === 0, serverVersion: p.app?.version ?? get().serverVersion,
      idleTimeoutMinutes: p.security?.idleTimeoutMinutes ?? get().idleTimeoutMinutes, endReason: null });
  },
  setOrg(id) {
    try { localStorage.setItem(ORG_KEY, id); } catch { /* ignore */ }
    set({ orgId: id });
  },
  clear(reason = null) { set({ status: 'anon', accessToken: null, user: null, orgs: [], endReason: reason }); },
}));

export function useOrg() {
  const { orgs, orgId } = useSession();
  return orgs.find((o) => o.id === orgId) ?? null;
}

export function useCan() {
  const org = useOrg();
  return (p: Permission) => !!org?.permissions.includes(p);
}

export interface BillPerms { view: boolean; create: boolean; edit: boolean; pay: boolean; delete: boolean }
/** Nomes das contas no espaço atual (Pessoal: Despesas/Receitas; Empresa: Contas a pagar/receber). */
export function useBillNames() {
  const kind = useOrg()?.kind;
  return (type: BillType) => billNames(type, kind);
}

/** O que a pessoa pode fazer com contas a pagar/receber neste espaço. */
export function useBillPerms(type: 'payable' | 'receivable'): BillPerms {
  const can = useCan();
  return { view: can(`${type}.view`), create: can(`${type}.create`), edit: can(`${type}.edit`), pay: can(`${type}.pay`), delete: can(`${type}.delete`) };
}
