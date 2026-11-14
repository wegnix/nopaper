/**
 * PDFs protegidos por senha: tenta as regras do espaço (e a senha digitada na hora) e devolve o
 * arquivo já sem senha, para o leitor de documentos entender e o anexo abrir em qualquer lugar.
 * Usa o `qpdf` instalado na imagem da API; sem ele, tudo segue como antes (o arquivo fica como veio).
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { PDF_RULES_MAX, pdfRulePassword, type PdfPasswordRuleInput, type PdfRulePart, type PdfRuleSource } from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { decryptSecret, encryptSecret } from '../lib/secrets.js';
import { getOrgSetting, setOrgSetting } from '../lib/settings.js';
import { storedFilePath } from '../lib/storage.js';

interface StoredRule { id: string; name: string; source: PdfRuleSource; part: PdfRulePart; length: number; /** Outro documento ou senha fixa, cifrado. */ valueEnc: string | null }
const KEY = 'pdfPasswords';

async function stored(orgId: string): Promise<StoredRule[]> {
  return (await getOrgSetting<{ rules?: StoredRule[] }>(orgId, KEY))?.rules ?? [];
}
const orgDocument = async (orgId: string) => (await db.select({ d: schema.organizations.document }).from(schema.organizations).where(eq(schema.organizations.id, orgId)))[0]?.d ?? null;

/** Regras para a tela: o valor guardado (outro CPF/CNPJ, senha fixa) nunca volta, só `hasValue`. */
export async function listPdfRules(orgId: string) {
  const [rules, doc] = await Promise.all([stored(orgId), orgDocument(orgId)]);
  return {
    orgHasDocument: !!doc,
    rules: rules.map((r) => ({
      id: r.id, name: r.name, source: r.source, part: r.part, length: r.length, hasValue: !!r.valueEnc,
      // a senha tirada do documento do próprio espaço pode aparecer (quem vê esta tela já vê o documento)
      preview: r.source === 'org_document' ? pdfRulePassword(r, { orgDocument: doc }) : null,
    })),
  };
}

export async function savePdfRules(orgId: string, input: PdfPasswordRuleInput[]) {
  const cur = new Map((await stored(orgId)).map((r) => [r.id, r]));
  const rules: StoredRule[] = input.slice(0, PDF_RULES_MAX).map((r) => {
    const old = r.id ? cur.get(r.id) : undefined;
    const needsValue = r.source !== 'org_document';
    const typed = r.value?.trim() ? r.value.trim() : null;
    // valor novo digitado → cifra; vazio numa regra do mesmo tipo → mantém o que já estava
    const valueEnc = !needsValue ? null : typed ? encryptSecret(typed) : old && old.source === r.source ? old.valueEnc : null;
    return { id: old?.id ?? randomUUID(), name: r.name, source: r.source, part: r.part, length: r.length, valueEnc };
  });
  await setOrgSetting(orgId, KEY, { rules });
  return rules;
}

/** Guarda uma senha digitada na hora como regra de senha fixa (se ainda não existir igual). */
export async function rememberPdfPassword(orgId: string, name: string, password: string) {
  const rules = await stored(orgId);
  if (rules.length >= PDF_RULES_MAX || rules.some((r) => r.source === 'fixed' && decryptSecret(r.valueEnc) === password)) return false;
  rules.push({ id: randomUUID(), name: name.slice(0, 60), source: 'fixed', part: 'first', length: 4, valueEnc: encryptSecret(password) });
  await setOrgSetting(orgId, KEY, { rules });
  return true;
}

/** Senhas a tentar, na ordem das regras, sem repetir. */
async function candidates(orgId: string): Promise<Array<{ name: string; password: string }>> {
  const [rules, doc] = await Promise.all([stored(orgId), orgDocument(orgId)]);
  const out: Array<{ name: string; password: string }> = [];
  for (const r of rules) {
    const password = pdfRulePassword(r, { orgDocument: doc, value: decryptSecret(r.valueEnc) });
    if (password && !out.some((o) => o.password === password)) out.push({ name: r.name, password });
  }
  return out;
}

/** Código de saída do qpdf (null = não rodou). 0 = ok; 3 = ok com avisos. */
const qpdf = (args: string[]) => new Promise<number | null>((resolve) => {
  execFile('qpdf', args, { timeout: 20_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' }, (err) => {
    if (!err) resolve(0);
    else resolve(typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null);
  });
});

export interface Unlocked {
  /** O arquivo a usar daqui em diante (sem senha, se alguma abriu). */
  buf: Buffer;
  /** `locked` = tem senha e nenhuma abriu; `unlocked` = abriu com uma senha; `open` = não precisava. */
  state: 'open' | 'unlocked' | 'locked';
  /** Nome da regra que abriu (ou "senha informada"). */
  by: string | null;
}

/**
 * Se o PDF pede senha, tenta a senha digitada (`typed`) e depois as regras do espaço. Qualquer
 * problema (sem qpdf, arquivo estranho, demora) devolve o arquivo como veio, com `open`.
 */
export async function unlockPdf(orgId: string, buf: Buffer, typed?: string | null): Promise<Unlocked> {
  const same: Unlocked = { buf, state: 'open', by: null };
  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(tmpdir(), 'np-pdf-'));
    const src = path.join(dir, 'in.pdf'), out = path.join(dir, 'out.pdf'), pw = path.join(dir, 'pw');
    await writeFile(src, buf, { mode: 0o600 });
    // 0 = precisa de senha; 2 = não é protegido; 3 = protegido, mas abre sem senha
    if ((await qpdf(['--requires-password', src])) !== 0) return same;
    const list = [...(typed ? [{ name: 'senha informada', password: typed }] : []), ...(await candidates(orgId))];
    for (const c of list) {
      // a senha vai por arquivo (não aparece na lista de processos)
      await writeFile(pw, c.password, { mode: 0o600 });
      const rc = await qpdf([`--password-file=${pw}`, '--decrypt', src, out]);
      if (rc === 0 || rc === 3) {
        const open = await readFile(out).catch(() => null);
        if (open?.length && open.subarray(0, 5).toString('latin1') === '%PDF-') return { buf: open, state: 'unlocked', by: c.name };
      }
      await rm(out, { force: true });
    }
    return { buf, state: 'locked', by: null };
  } catch {
    return same;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const applying = new Set<string>();

/**
 * Passa as regras nos anexos de contas JÁ guardados: o PDF que ainda pede senha e abre com alguma
 * regra é trocado pela cópia sem senha (mesmo lugar; tamanho e sha256 atualizados). Serve para regra
 * criada depois do anexo — ex.: histórico migrado de outro sistema antes de as regras existirem.
 * `null` = já há uma passada em andamento neste espaço.
 */
export async function unlockStoredPdfs(orgId: string): Promise<{ checked: number; unlocked: number; stillLocked: number } | null> {
  if (applying.has(orgId)) return null;
  applying.add(orgId);
  try {
    const t = schema.attachments;
    const rows = await db.select({ id: t.id, key: t.storageKey }).from(t).where(and(eq(t.orgId, orgId), eq(t.mime, 'application/pdf')));
    let unlocked = 0, stillLocked = 0;
    for (const r of rows) {
      const file = storedFilePath(r.key);
      // pergunta ao qpdf direto no arquivo guardado (0 = pede senha); só esses são lidos e tentados
      if ((await qpdf(['--requires-password', file])) !== 0) continue;
      const buf = await readFile(file).catch(() => null);
      if (!buf) continue;
      const u = await unlockPdf(orgId, buf);
      if (u.state === 'locked') stillLocked++;
      if (u.state !== 'unlocked') continue;
      const tmp = `${file}.unlock-${randomUUID()}`;
      try {
        await writeFile(tmp, u.buf, { mode: 0o600 });
        await rename(tmp, file);
        await db.update(t).set({ size: u.buf.length, sha256: createHash('sha256').update(u.buf).digest('hex') }).where(eq(t.id, r.id));
        unlocked++;
      } catch { await rm(tmp, { force: true }).catch(() => undefined); stillLocked++; }
    }
    return { checked: rows.length, unlocked, stillLocked };
  } finally { applying.delete(orgId); }
}
