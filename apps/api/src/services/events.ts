import { and, asc, eq, gt, inArray, max, sql } from 'drizzle-orm';
import type { Permission } from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { auditAreasFor } from '../lib/audit.js';

/**
 * Fila de eventos da API pública. Não há tabela própria: os eventos são a auditoria do espaço
 * (toda mutação já grava lá), traduzida para nomes estáveis. O cursor é o id do registro.
 * Quem lê só recebe as áreas que pode ver, e nada de categoria restrita sem a permissão.
 * Ação nova na auditoria que deva virar evento → acrescentar em `eventTypeOf`.
 */
const CRUD: Record<string, string> = { create: 'created', update: 'updated', delete: 'deleted' };
const FIXED: Record<string, string> = {
  'bills.bulk_pay': 'bill.paid', 'import.bills': 'bill.imported', 'import.undo': 'bill.import_undone',
  'card.tx.move': 'card.transaction.moved', 'card.import': 'card.import.created', 'card.import.undo': 'card.import.undone',
  'bank.import': 'bank.import.created', 'bank.import_undo': 'bank.import.undone',
  'bank.reconcile': 'bank.transaction.reconciled', 'bank.reconcile_undo': 'bank.transaction.unreconciled',
  'payroll.period.enable_bills': 'payroll.period.updated', 'payroll.payslips': 'payroll.payslips.imported', 'payroll.commissions': 'payroll.commissions.applied',
  'payroll.import': 'payroll.import.created', 'payroll.import_undo': 'payroll.import.undone', 'payroll.rubric.reorder': 'payroll.rubric.updated',
  'payroll.settings': 'payroll.settings.updated', 'payroll.settings.commissions': 'payroll.settings.updated',
  'payroll.esign.send': 'payslip.signature.created', 'payroll.esign.signed': 'payslip.signature.signed', 'payroll.esign.cancel': 'payslip.signature.cancelled',
  'payroll.esign.terms': 'payslip.term.created', 'payroll.esign.accountant': 'accounting.document.sent',
  'accounting.upload': 'accounting.document.received', 'accounting.send': 'accounting.document.sent', 'accounting.handle': 'accounting.document.updated',
};
const BILL: Record<string, string> = { create: 'created', update: 'updated', delete: 'deleted', pay: 'paid', unpay: 'unpaid', restructure: 'series_changed', recurrence_stop: 'series_changed' };

/** Nome público do evento para uma ação da auditoria (null = não vira evento). */
export function eventTypeOf(action: string): string | null {
  if (FIXED[action]) return FIXED[action];
  const p = action.split('.');
  if (p[0] === 'payable' || p[0] === 'receivable') {
    if (p[1] === 'attach') return 'attachment.added';
    if (p[1] === 'detach') return 'attachment.removed';
    return BILL[p[1]!] ? `bill.${BILL[p[1]!]}` : null;
  }
  const verb = CRUD[p.at(-1)!];
  if (!verb) return null;
  const subject = p.slice(0, -1).join('.');
  const NAMES: Record<string, string> = {
    category: 'category', folder: 'folder', card: 'card', 'card.tx': 'card.transaction', 'card.category': 'card.category', 'bank.account': 'bank.account',
    'payroll.employee': 'payroll.employee', 'payroll.entry': 'payroll.entry', 'payroll.period': 'payroll.period', 'payroll.rubric': 'payroll.rubric',
  };
  return NAMES[subject] ? `${NAMES[subject]}.${verb}` : null;
}

export interface ApiEvent {
  id: string;
  type: string;
  occurredAt: string;
  resource: { type: string | null; id: string | null; ids?: string[]; externalId?: string | null };
  billType?: 'payable' | 'receivable';
  actor: { type: 'user' | 'integration' | 'system'; name: string | null };
}

export interface EventReader { orgId: string; isAdmin?: boolean; can(p: Permission): boolean }

/** Maior id de evento do espaço hoje: ponto de partida para quem só quer o que acontecer daqui em diante. */
export async function latestEventCursor(orgId: string) {
  const [r] = await db.select({ id: max(schema.auditLogs.id) }).from(schema.auditLogs).where(eq(schema.auditLogs.orgId, orgId));
  return String(r?.id ?? 0);
}

/**
 * Eventos depois de `after`, em ordem. `nextCursor` avança mesmo sobre registros que não viram
 * evento, então o chamador sempre continua de onde a leitura parou.
 */
export async function listEvents(reader: EventReader, after: string, limit: number, typePrefixes: string[] = []) {
  const t = schema.auditLogs;
  const areas = auditAreasFor({ isAdmin: !!reader.isAdmin, can: reader.can });
  const conds = [eq(t.orgId, reader.orgId), gt(t.id, Number(after) || 0)];
  if (areas) conds.push(areas.length ? inArray(sql<string>`split_part(${t.action}, '.', 1)`, areas) : sql`false`);
  if (!reader.can('bills.view_restricted')) conds.push(sql`coalesce((${t.details}->>'restricted')::boolean, false) = false`);
  // lê um pouco além do pedido: parte dos registros (exportações, configurações) não vira evento
  const scan = Math.min(limit * 3, 1000);
  const rows = await db.select({
    id: t.id, action: t.action, entityType: t.entityType, entityId: t.entityId, details: t.details, createdAt: t.createdAt,
    userId: t.userId, userName: t.userName, isUser: sql<boolean>`exists (select 1 from users u where u.id = ${t.userId})`,
  }).from(t).where(and(...conds)).orderBy(asc(t.id)).limit(scan);

  const events: ApiEvent[] = [];
  let cursor = after;
  let cut = false;
  for (const r of rows) {
    const type = eventTypeOf(r.action);
    if (type && (!typePrefixes.length || typePrefixes.some((p) => type.startsWith(p)))) {
      if (events.length >= limit) { cut = true; break; }
      const d = (r.details ?? {}) as { ids?: unknown; snapshot?: { externalId?: string | null } };
      const area = r.action.split('.')[0];
      const many = r.action === 'bills.bulk_pay' && Array.isArray(d.ids) ? (d.ids as string[]) : undefined;
      events.push({
        id: String(r.id), type, occurredAt: r.createdAt.toISOString(),
        resource: { type: r.entityType, id: many ? many[0] ?? null : r.entityId, ...(many ? { ids: many } : {}), ...(d.snapshot?.externalId ? { externalId: d.snapshot.externalId } : {}) },
        ...(area === 'payable' || area === 'receivable' ? { billType: area } : {}),
        actor: { type: !r.userId ? 'system' : r.isUser ? 'user' : 'integration', name: r.userName },
      });
    }
    cursor = String(r.id);
  }
  // externalId das contas que ainda existem
  const billIds = [...new Set(events.filter((e) => e.resource.type === 'bill' && e.resource.id && e.resource.externalId === undefined).map((e) => e.resource.id!))].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (billIds.length) {
    const ext = new Map((await db.select({ id: schema.bills.id, externalId: schema.bills.externalId }).from(schema.bills)
      .where(and(eq(schema.bills.orgId, reader.orgId), inArray(schema.bills.id, billIds)))).map((b) => [b.id, b.externalId]));
    for (const e of events) if (e.resource.type === 'bill' && e.resource.id && e.resource.externalId === undefined) e.resource.externalId = ext.get(e.resource.id) ?? null;
  }
  return { items: events, nextCursor: cursor, hasMore: cut || rows.length === scan };
}
