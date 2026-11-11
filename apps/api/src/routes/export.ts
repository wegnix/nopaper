import type { FastifyInstance } from 'fastify';
import archiver from 'archiver';
import { and, eq, gte, lte, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { billListQuerySchema, exportSchema, MONTHS_PT, monthRange, formatDateBR, ATTACHMENT_SLOT_LABEL, type AttachmentSlot } from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { parse } from '../lib/validate.js';
import { forbidden } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { fileExists, readStoredFile } from '../lib/storage.js';
import { listBills, orgToday, visibilityCond, viewPerm } from '../services/bills.js';
import { billsCsv, billsWorkbook } from '../services/xlsx.js';

const SLOT_FILE_LABEL: Record<AttachmentSlot, string> = { boleto: 'Boleto', invoice: 'Nota Fiscal', payment_proof: 'Comprovante' };

export function safeComponent(s: string | null | undefined, fallback: string) {
  const v = (s ?? '').replace(/[\\/\x00-\x1f:*?"<>|]/g, '_').replace(/\.\./g, '_').trim().slice(0, 64);
  return v || fallback;
}

export default async function exportRoutes(app: FastifyInstance) {
  app.post('/api/export/zip', { preHandler: requirePerm('bills.export') }, async (req, reply) => {
    const body = parse(exportSchema, req.body);
    if (!req.org!.can(viewPerm(body.type))) throw forbidden();
    const range = body.month ? monthRange(body.year, body.month) : { from: `${body.year}-01-01`, to: `${body.year}-12-31` };
    const bills = await db.select({
      b: schema.bills, folderName: schema.folders.name, categoryLabel: schema.categories.label,
    }).from(schema.bills)
      .innerJoin(schema.categories, eq(schema.categories.id, schema.bills.categoryId))
      .leftJoin(schema.folders, eq(schema.folders.id, schema.bills.folderId))
      .where(and(eq(schema.bills.orgId, req.org!.id), eq(schema.bills.type, body.type),
        gte(schema.bills.dueDate, range.from), lte(schema.bills.dueDate, range.to), await visibilityCond(req)))
      .orderBy(schema.bills.dueDate);
    const atts = bills.length ? await db.select().from(schema.attachments).where(inArray(schema.attachments.billId, bills.map((r) => r.b.id))) : [];

    const typeLabel = body.type === 'payable' ? 'Contas a Pagar' : 'Contas a Receber';
    const periodLabel = body.month ? `${String(body.month).padStart(2, '0')}/${body.year}` : `Ano ${body.year}`;
    const fileBase = `${body.type === 'payable' ? 'contas-pagar' : 'contas-receber'}-${body.year}${body.month ? '-' + String(body.month).padStart(2, '0') : ''}`;

    const zip = archiver('zip', { zlib: { level: 6 } });
    reply.header('Content-Type', 'application/zip').header('Content-Disposition', `attachment; filename="${fileBase}.zip"`);
    const used = new Set<string>();
    let exported = 0, missing = 0;
    const paidWord = body.type === 'payable' ? 'Pago' : 'Recebido';

    for (const { b, folderName } of bills) {
      const [y, m] = b.dueDate.split('-').map(Number);
      const monthDir = `${String(m).padStart(2, '0')} - ${MONTHS_PT[m - 1].toUpperCase()} DE ${y}`;
      const folder = safeComponent(folderName, 'Sem pasta');
      const status = b.status === 'paid' ? (b.paidAt ? `${paidWord} ${formatDateBR(b.paidAt).replace(/\//g, '-')}` : paidWord) : 'Pendente';
      for (const a of atts.filter((x) => x.billId === b.id)) {
        if (!(await fileExists(a.storageKey))) { missing++; continue; }
        const ext = a.storageKey.split('.').pop() ?? 'bin';
        const baseName = `${SLOT_FILE_LABEL[a.slot as AttachmentSlot]} - ${safeComponent(b.description, 'conta')} - ${status}`;
        let path = `${y}/${monthDir}/${folder}/${baseName}.${ext}`;
        for (let i = 2; used.has(path.toLowerCase()); i++) path = `${y}/${monthDir}/${folder}/${baseName} (${i}).${ext}`;
        used.add(path.toLowerCase());
        zip.append(await readStoredFile(a.storageKey), { name: path });
        exported++;
      }
    }
    if (body.includeSpreadsheet) {
      const xlsx = await billsWorkbook(`${typeLabel} — ${periodLabel} — ${req.org!.name}`, bills.map(({ b, folderName, categoryLabel }) => ({
        dueDate: b.dueDate, description: b.description, category: categoryLabel, folder: folderName, amount: b.amount,
        status: b.status === 'pending' && b.dueDate < orgToday(req) ? 'overdue' : b.status, paidAt: b.paidAt, paidAmount: b.paidAmount, paymentMethod: b.paymentMethod,
        installment: b.installmentNumber && b.totalInstallments ? `${b.installmentNumber}/${b.totalInstallments}` : null,
        relatedPerson: b.relatedPerson, notes: b.notes,
        attachments: atts.filter((a) => a.billId === b.id).map((a) => ATTACHMENT_SLOT_LABEL[a.slot as AttachmentSlot]).join(', '),
      })), body.type);
      zip.append(xlsx, { name: `${body.year}/Relatório ${typeLabel} ${periodLabel.replace('/', '-')}.xlsx` });
    }
    const now = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: req.org!.timezone }).format(new Date());
    zip.append([
      `NoPaper — ${typeLabel}`,
      `Organização: ${req.org!.name}`,
      `Período: ${periodLabel}`,
      `Contas no período: ${bills.length}`,
      `Anexos exportados: ${exported}`,
      `Anexos faltando: ${missing}`,
      `Gerado em ${now} por ${req.user!.name}`,
      '',
      `Estrutura: ANO/MÊS/PASTA/[Boleto|Nota Fiscal|Comprovante] - descrição - [${paidWord} dd-mm-aaaa|Pendente].ext`,
    ].join('\r\n'), { name: `${body.year}/LEIA-ME.txt` });
    zip.finalize();
    await audit(req, { action: 'bills.export_zip', entityType: 'export', entityId: `${body.year}-${body.month ?? 'all'}`, description: `Exportou ZIP ${typeLabel} ${periodLabel}`, details: { bills: bills.length, exported, missing } });
    return reply.send(zip);
  });

  /**
   * A lista de contas como planilha (.xlsx) ou CSV, com os mesmos filtros da tela
   * (período, situação, categoria, pasta, busca). Categorias restritas seguem escondidas.
   */
  app.get('/api/export/sheet', { preHandler: requirePerm('bills.export') }, async (req, reply) => {
    const q = parse(billListQuerySchema.extend({ format: z.enum(['xlsx', 'csv']).default('xlsx'), byMonth: z.enum(['0', '1']).default('1') }), req.query);
    if (!req.org!.can(viewPerm(q.type))) throw forbidden();
    const bills = await listBills(req, q);
    const today = orgToday(req);
    const [cats, folders] = await Promise.all([
      // sem as restritas para quem não as vê: nem o nome delas sai no subtítulo/registro
      db.select({ id: schema.categories.id, label: schema.categories.label }).from(schema.categories)
        .where(and(eq(schema.categories.orgId, req.org!.id), req.org!.can('bills.view_restricted') ? undefined : eq(schema.categories.isRestricted, false))),
      db.select({ id: schema.folders.id, label: schema.folders.name }).from(schema.folders).where(eq(schema.folders.orgId, req.org!.id)),
    ]);
    const cat = new Map(cats.map((c) => [c.id, c.label])), fol = new Map(folders.map((f) => [f.id, f.label]));
    const rows = bills.map((b) => ({
      dueDate: b.dueDate, description: b.description, category: cat.get(b.categoryId) ?? '', folder: b.folderId ? fol.get(b.folderId) ?? null : null,
      amount: b.amount, status: b.status === 'pending' && b.dueDate < today ? 'overdue' : b.status, paidAt: b.paidAt, paidAmount: b.paidAmount,
      paymentMethod: b.paymentMethod, relatedPerson: b.relatedPerson, notes: b.notes,
      installment: b.installmentNumber && b.totalInstallments ? `${b.installmentNumber}/${b.totalInstallments}` : null,
      attachments: (Object.keys(b.attachments) as AttachmentSlot[]).map((s) => ATTACHMENT_SLOT_LABEL[s]).join(', '),
    }));

    const typeLabel = q.type === 'payable' ? 'Contas a pagar' : 'Contas a receber';
    const period = q.status === 'overdue' ? 'vencidas (todos os meses)' : q.month && q.year ? `${MONTHS_PT[q.month - 1].toLowerCase()} de ${q.year}` : q.year ? `ano ${q.year}` : 'todos os períodos';
    const statusLabel: Record<string, string> = { pending: 'pendentes', paid: q.type === 'payable' ? 'pagas' : 'recebidas', due_soon: 'próximos 7 dias' };
    const filters = [
      period,
      q.status && q.status !== 'overdue' ? statusLabel[q.status] : null,
      q.categoryId ? `categoria ${cat.get(q.categoryId) ?? '?'}` : null,
      q.folderId === 'none' ? 'sem pasta' : q.folderId ? `pasta ${fol.get(q.folderId) ?? '?'}` : null,
      q.search ? `busca “${q.search}”` : null,
    ].filter(Boolean).join(' · ');
    const now = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: req.org!.timezone }).format(new Date());
    const base = `${q.type === 'payable' ? 'contas-pagar' : 'contas-receber'}-${q.status === 'overdue' ? 'vencidas' : q.month && q.year ? `${q.year}-${String(q.month).padStart(2, '0')}` : q.year ?? 'todas'}`;

    await audit(req, { action: 'bills.export_sheet', entityType: 'export', description: `Exportou ${typeLabel.toLowerCase()} em ${q.format.toUpperCase()} (${rows.length} conta(s), ${filters})`, details: { format: q.format, rows: rows.length, filters } });
    reply.header('cache-control', 'no-store');
    if (q.format === 'csv') {
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${base}.csv"`).send(billsCsv(rows, q.type));
    }
    const buf = await billsWorkbook(`${typeLabel} — ${req.org!.name}`, rows, q.type, `${filters} · gerado em ${now} por ${req.user!.name}`, q.byMonth === '1');
    return reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="${base}.xlsx"`).send(buf);
  });
}
