import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  billPerm, dupKey, importCheckSchema, importCommitSchema, normText, sumMoney, type BillType, type ImportCell, type ImportSheet,
} from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { env } from '../env.js';
import { parse } from '../lib/validate.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { createBills, deleteBillsWithFiles, assertFolder } from '../services/bills.js';

const MAX_ROWS = 5000;
const MAX_COLS = 40;
const pad = (n: number) => String(n).padStart(2, '0');

function cellValue(v: ExcelJS.CellValue): ImportCell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    // exceljs entrega datas como UTC meia-noite (às vezes com resíduo de fuso): arredonda para o dia mais próximo
    const d = new Date(Math.round(v.getTime() / 86400000) * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 'sim' : 'não';
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object') {
    if ('result' in v) return cellValue((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join('').trim() || null;
    if ('text' in v) return String((v as ExcelJS.CellHyperlinkValue).text).trim() || null;
    if ('error' in v) return null;
  }
  return String(v);
}

async function readXlsx(buf: Buffer): Promise<ImportSheet[]> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as unknown as ArrayBuffer); } catch { throw badRequest('Não foi possível ler a planilha. Confira se o arquivo é um .xlsx válido.'); }
  const sheets: ImportSheet[] = [];
  wb.eachSheet((ws) => {
    if (ws.state && ws.state !== 'visible') return;
    const rows: ImportCell[][] = [];
    const last = Math.min(ws.rowCount, MAX_ROWS);
    for (let r = 1; r <= last; r++) {
      const row = ws.getRow(r);
      const cells: ImportCell[] = [];
      const n = Math.min(row.cellCount, MAX_COLS);
      for (let c = 1; c <= n; c++) cells.push(cellValue(row.getCell(c).value));
      while (cells.length && cells[cells.length - 1] === null) cells.pop();
      rows.push(cells);
    }
    while (rows.length && !rows[rows.length - 1].length) rows.pop();
    if (rows.length) sheets.push({ name: ws.name.slice(0, 60), rows });
  });
  return sheets;
}

function readCsv(buf: Buffer, name: string): ImportSheet[] {
  let text = buf.toString('utf8');
  if (text.includes('�')) text = buf.toString('latin1');
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = [';', '\t', ','].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: ImportCell[][] = [];
  let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      rows.push(row.slice(0, MAX_COLS).map((c) => c.trim() || null));
      row = [];
      if (rows.length >= MAX_ROWS) break;
    } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row.slice(0, MAX_COLS).map((c) => c.trim() || null)); }
  return [{ name: name.replace(/\.[^.]+$/, '').slice(0, 60) || 'CSV', rows }];
}

export default async function importRoutes(app: FastifyInstance) {
  const guard = { preHandler: requirePerm('bills.import') };
  const assertType = (req: FastifyRequest, type: BillType, action: 'create' | 'delete' = 'create') => {
    if (!req.org!.can(billPerm(type, action))) throw forbidden(action === 'create' ? 'Sem permissão para cadastrar este tipo de conta' : 'Desfazer apaga contas: precisa da permissão de apagar');
  };

  /** Lê o arquivo e devolve as abas com células normalizadas — nada é gravado. */
  app.post('/api/import/read', guard, async (req) => {
    const file = await req.file({ limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });
    if (!file) throw badRequest('Envie um arquivo');
    const buf = await file.toBuffer();
    if (file.file.truncated) throw badRequest(`Arquivo maior que ${env.MAX_UPLOAD_MB} MB`);
    const name = file.filename || 'planilha';
    let sheets: ImportSheet[];
    if (buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) sheets = await readXlsx(buf);
    else if (buf.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) throw badRequest('Formato .xls antigo não é suportado. Abra no Excel/LibreOffice e salve como .xlsx.');
    else if (/\.(csv|txt)$/i.test(name) && !buf.subarray(0, 512).includes(0)) sheets = readCsv(buf, name);
    else throw badRequest('Formato não suportado. Envie .xlsx ou .csv.');
    if (!sheets.length) throw badRequest('A planilha está vazia');
    return { fileName: name.slice(0, 200), sheets };
  });

  /** Duplicatas (mesma descrição + vencimento + valor) e sugestão de categoria pelo histórico. */
  app.post('/api/import/check', guard, async (req) => {
    const body = parse(importCheckSchema, req.body);
    assertType(req, body.type);
    if (!body.rows.length) return { duplicates: [], suggestions: {} };
    const dates = [...new Set(body.rows.map((r) => r.dueDate))];
    const existing = await db.select({ d: schema.bills.description, due: schema.bills.dueDate, a: schema.bills.amount }).from(schema.bills)
      .where(and(eq(schema.bills.orgId, req.org!.id), eq(schema.bills.type, body.type), inArray(schema.bills.dueDate, dates)));
    const keys = new Set(existing.map((e) => dupKey(e.d, e.due, e.a)));
    const duplicates = body.rows.map((r, i) => (keys.has(dupKey(r.description, r.dueDate, r.amount)) ? i : -1)).filter((i) => i >= 0);

    // categoria mais recente usada para cada descrição
    const descs = [...new Set(body.rows.map((r) => normText(r.description)))];
    const hist = await db.execute<{ d: string; category_id: string }>(sql`
      select distinct on (lower(description)) lower(description) as d, category_id
      from bills where org_id = ${req.org!.id} and type = ${body.type}
      order by lower(description), due_date desc`);
    const suggestions: Record<string, string> = {};
    for (const h of hist.rows) { const k = normText(h.d); if (descs.includes(k)) suggestions[k] = h.category_id; }
    return { duplicates, suggestions };
  });

  app.post('/api/import/bills', guard, async (req, reply) => {
    const body = parse(importCommitSchema, req.body);
    assertType(req, body.type);
    await assertFolder(req, body.folderId);
    const catIds = [...new Set(body.rows.map((r) => r.categoryId))];
    const cats = await db.select().from(schema.categories).where(and(eq(schema.categories.orgId, req.org!.id), inArray(schema.categories.id, catIds)));
    if (cats.length !== catIds.length) throw badRequest('Há linhas com categoria inválida');
    for (const c of cats) {
      if (c.isRestricted && !req.org!.can('bills.view_restricted')) throw forbidden('Categoria não permitida');
      if (c.kind !== 'both' && c.kind !== body.type) throw badRequest(`A categoria "${c.label}" não é de ${body.type === 'payable' ? 'contas a pagar' : 'contas a receber'}`);
    }
    const batchId = randomUUID();
    const total = sumMoney(body.rows.map((r) => r.amount));
    await db.transaction(async (tx) => {
      await tx.insert(schema.importBatches).values({
        id: batchId, orgId: req.org!.id, type: body.type, fileName: body.fileName, rowCount: body.rows.length, totalAmount: total, createdBy: req.user!.id,
      });
      for (const r of body.rows) {
        await createBills(tx, req.org!.id, req.user!.id, {
          type: body.type, description: r.description, categoryId: r.categoryId, folderId: body.folderId ?? null,
          amount: r.amount, dueDate: r.dueDate, recurrenceType: 'once', isIndefinite: false,
          paymentMethod: r.paymentMethod ?? null, notes: r.notes ?? null, relatedPerson: r.relatedPerson ?? null,
          paidAt: r.paidAt ?? null, paidAmount: r.paidAt ? (r.paidAmount ?? r.amount) : null, importBatchId: batchId,
        });
      }
    });
    const restricted = cats.some((c) => c.isRestricted);
    await audit(req, {
      action: 'import.bills', entityType: 'import', entityId: batchId,
      description: `Importou ${body.rows.length} ${body.type === 'payable' ? 'conta(s) a pagar' : 'conta(s) a receber'} de "${body.fileName}"`,
      details: { rows: body.rows.length, total, restricted },
    });
    reply.code(201);
    return { batchId, created: body.rows.length, total };
  });

  app.get('/api/import/batches', guard, async (req) => {
    const rows = await db.select({
      b: schema.importBatches, userName: schema.users.name,
      remaining: sql<number>`(select count(*)::int from bills where bills.import_batch_id = ${schema.importBatches.id})`,
    }).from(schema.importBatches)
      .leftJoin(schema.users, eq(schema.users.id, schema.importBatches.createdBy))
      .where(eq(schema.importBatches.orgId, req.org!.id))
      .orderBy(desc(schema.importBatches.createdAt)).limit(50);
    return {
      items: rows.filter((r) => req.org!.can(billPerm(r.b.type as BillType, 'view'))).map((r) => ({
        id: r.b.id, type: r.b.type, fileName: r.b.fileName, rowCount: r.b.rowCount, totalAmount: r.b.totalAmount,
        createdAt: r.b.createdAt, undoneAt: r.b.undoneAt, createdBy: r.userName, remaining: r.remaining,
      })),
    };
  });

  /** Desfaz uma importação: apaga as contas que ainda existem daquele lote. */
  app.delete<{ Params: { id: string } }>('/api/import/batches/:id', guard, async (req) => {
    const [b] = await db.select().from(schema.importBatches).where(and(eq(schema.importBatches.id, req.params.id), eq(schema.importBatches.orgId, req.org!.id), isNull(schema.importBatches.undoneAt)));
    if (!b) throw notFound('Importação não encontrada');
    assertType(req, b.type as BillType, 'delete');
    const removed = await db.transaction(async (tx) => {
      const ids = (await tx.select({ id: schema.bills.id }).from(schema.bills)
        .where(and(eq(schema.bills.orgId, req.org!.id), eq(schema.bills.importBatchId, b.id)))).map((r) => r.id);
      const n = await deleteBillsWithFiles(tx, ids);
      await tx.update(schema.importBatches).set({ undoneAt: new Date() }).where(eq(schema.importBatches.id, b.id));
      return n;
    });
    await audit(req, { action: 'import.undo', entityType: 'import', entityId: b.id, description: `Desfez a importação de "${b.fileName}" (${removed} conta(s) removida(s))`, details: { removed } });
    return { removed };
  });
}
