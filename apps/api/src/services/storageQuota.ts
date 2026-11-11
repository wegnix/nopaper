import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { env } from '../env.js';
import { HttpError } from '../lib/errors.js';

/**
 * Cota de armazenamento por espaço: soma dos arquivos guardados (anexos de contas, documentos do
 * contador nos dois sentidos, holerites e termos para assinatura). Sem cota, um envio repetido —
 * de propósito ou por defeito — encheria o disco de todos os espaços.
 * Padrão `STORAGE_QUOTA_MB` (5 GB); o administrador da plataforma ajusta por espaço.
 */
export async function storageUsage(orgId: string): Promise<number> {
  const r = await db.execute<{ n: string }>(sql`
    select (
      coalesce((select sum(size) from attachments where org_id = ${orgId}), 0) +
      coalesce((select sum(size) from accounting_documents where org_id = ${orgId}), 0) +
      coalesce((select sum(size + coalesce(signed_size, 0)) from payslip_signatures where org_id = ${orgId}), 0)
    )::text as n`);
  return Number(r.rows[0]?.n ?? 0);
}

export async function quotaBytes(orgId: string): Promise<number> {
  const [o] = await db.select({ q: schema.organizations.storageQuotaMb }).from(schema.organizations).where(eq(schema.organizations.id, orgId));
  return (o?.q ?? env.STORAGE_QUOTA_MB) * 1024 * 1024;
}

const size = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB` : `${Math.round(b / 1024 ** 2).toLocaleString('pt-BR')} MB`);

/** Recusa o envio se, com `incoming` bytes a mais, o espaço passa da cota. */
export async function assertStorageRoom(orgId: string, incoming = 0) {
  const [used, quota] = await Promise.all([storageUsage(orgId), quotaBytes(orgId)]);
  if (used + incoming > quota) {
    throw new HttpError(413, `O espaço chegou ao limite de armazenamento (${size(used)} de ${size(quota)} usados). Apague arquivos que não usa mais ou peça ao administrador da plataforma para aumentar o limite.`, 'storage_quota');
  }
}

/** Para a tela avisar quando está perto do limite. */
export async function storageInfo(orgId: string) {
  const [used, quota] = await Promise.all([storageUsage(orgId), quotaBytes(orgId)]);
  return { used, quota, near: used >= quota * 0.9 };
}
