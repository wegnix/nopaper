/**
 * Restauração de backup pela web.
 *
 * Ordem (cada passo só começa se o anterior deu certo):
 *   download   (só remoto) baixa o arquivo para a pasta de backups
 *   validate   confere o pacote: conteúdo, manifesto, checksum do dump, versão, pg_restore --list
 *   database   restaura num banco TEMPORÁRIO, aplica as migrations e valida (há superadmin?)
 *              → até aqui o sistema segue no ar, sem nenhuma alteração
 *   maintenance  bloqueia as requisições (503), espera as que estão em andamento e para os jobs
 *   safety     backup completo do estado atual (com anexos) — sempre dá para voltar
 *   switch     prepara o banco novo (sessões, config de backup, histórico) e troca por rename
 *   uploads    troca os anexos (pasta temporária → STORAGE_DIR)
 *   finish     apaga o banco/anexos antigos, religa os jobs e sai da manutenção
 *
 * Qualquer falha desfaz o que foi feito. Se o processo morrer no meio, `recoverInterruptedRestore`
 * (no boot, antes das migrations) usa o estado gravado em disco para voltar ao estado anterior.
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import pg from 'pg';
import { pool } from '../db/client.js';
import { latestMigration, migrateDatabase } from '../db/migrate.js';
import { env } from '../env.js';
import { drainRequests, enterMaintenance, exitMaintenance } from '../lib/maintenance.js';
import { decryptSecret } from '../lib/secrets.js';
import { getSystemSetting } from '../lib/settings.js';
import { startJobs, stopJobs } from '../jobs/index.js';
import {
  BACKUP_FILE_RE, acquireOperation, backupDir, fetchRemoteBackup, loadBackupConfig, localBackupPath, pgConn, pgRestoreBin,
  releaseOperation, run, runBackup, sha256File, stamp, storageDir, type BackupManifest,
} from './backup.js';

export type RestoreStep = 'download' | 'validate' | 'database' | 'maintenance' | 'safety' | 'switch' | 'uploads' | 'finish';

interface RestoreState {
  id: string;
  state: 'running' | 'done' | 'error';
  source: 'local' | 'remote';
  file: string;
  steps: RestoreStep[];
  step: RestoreStep;
  startedAt: string;
  finishedAt: string | null;
  byName: string | null;
  error: string | null;
  /** untouched = nada foi alterado · rolled_back = o sistema voltou ao estado anterior */
  outcome: 'untouched' | 'rolled_back' | null;
  warnings: string[];
  safetyBackup: string | null;
  backupCreatedAt: string | null;
  // controle de recuperação (gravado em disco a cada mudança)
  /** gravado antes dos renames: com ele, o boot sabe que um banco *_pre_restore é desta restauração */
  swapStarted: boolean;
  dbSwapped: boolean;
  uploadsPhase: 'none' | 'out' | 'in' | 'done';
}

let current: RestoreState | null = null;
const statusFile = () => path.join(backupDir(), '.restore-status.json');

async function persist() {
  if (!current) return;
  await mkdir(backupDir(), { recursive: true });
  const tmp = `${statusFile()}.tmp`;
  await writeFile(tmp, JSON.stringify(current, null, 2), { mode: 0o600 });
  await rename(tmp, statusFile());
}
async function loadState(): Promise<RestoreState | null> {
  try { return JSON.parse(await readFile(statusFile(), 'utf8')) as RestoreState; } catch { return null; }
}

/** O que a tela vê (público: a tela consulta durante a manutenção, quando ninguém está logado). */
export function restoreStatus() {
  const s = current;
  const recent = s && (s.state === 'running' || (s.finishedAt && Date.now() - Date.parse(s.finishedAt) < 30 * 60_000));
  if (!s || !recent) return { state: 'idle' as const };
  return {
    id: s.id, state: s.state, step: s.step, steps: s.steps, file: s.file, startedAt: s.startedAt, finishedAt: s.finishedAt,
    error: s.error, outcome: s.outcome, warnings: s.warnings, safetyBackup: s.safetyBackup, backupCreatedAt: s.backupCreatedAt,
  };
}
export const isRestoring = () => current?.state === 'running';

// ------------------------------------------------------------------ banco
const dbName = () => decodeURIComponent(new URL(env.DATABASE_URL).pathname.slice(1));
const tmpDbName = () => `${dbName()}_restore`;
const prevDbName = () => `${dbName()}_pre_restore`;
const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;
function dbUrl(name: string) {
  const u = new URL(env.DATABASE_URL);
  u.pathname = `/${encodeURIComponent(name)}`;
  return u.toString();
}
async function withClient<T>(name: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: dbUrl(name) });
  c.on('error', () => { /* erro aparece na consulta */ });
  await c.connect();
  try { return await fn(c); } finally { await c.end().catch(() => null); }
}
/** Conexão de administração: banco "postgres" (não dá para renomear o banco em que se está conectado). */
const withAdmin = <T>(fn: (c: pg.Client) => Promise<T>) => withClient('postgres', fn);

async function dbExists(c: pg.Client, name: string) {
  return (await c.query('select 1 from pg_database where datname = $1', [name])).rowCount === 1;
}
async function terminate(c: pg.Client, name: string) {
  await c.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [name]);
}
async function dropDb(c: pg.Client, name: string) {
  if (!(await dbExists(c, name))) return;
  await terminate(c, name);
  await c.query(`drop database if exists ${qi(name)}`);
}
/** Renomeia, derrubando conexões que ainda estejam abertas (tenta algumas vezes). */
async function renameDb(c: pg.Client, from: string, to: string) {
  for (let i = 1; ; i++) {
    await terminate(c, from);
    try { await c.query(`alter database ${qi(from)} rename to ${qi(to)}`); return; } catch (e) {
      if ((e as { code?: string }).code !== '55006' || i >= 15) throw e; // 55006 = banco em uso
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

async function restoreIntoTemp(dump: string, warnings: string[]) {
  const tmp = tmpDbName();
  await withAdmin(async (c) => {
    await dropDb(c, tmp);
    await c.query(`create database ${qi(tmp)} template template0 encoding 'UTF8'`);
  });
  const conn = pgConn(tmp);
  try {
    await run(pgRestoreBin(), ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', `--dbname=${conn.url}`, dump], { env: conn.env, timeoutMs: 2 * 3600_000 });
  } catch (e) {
    throw new Error(`O banco do backup não pôde ser restaurado: ${(e as Error).message}`);
  }
  // versão do banco: o código precisa conhecer todas as migrations que o backup já tem
  const latest = latestMigration();
  await withClient(tmp, async (c) => {
    let when: number;
    try {
      when = Number((await c.query('select max(created_at) as w from drizzle.__drizzle_migrations')).rows[0]?.w ?? 0);
    } catch {
      throw new Error('O backup não parece ser do NoPaper: falta o histórico de versões do banco.');
    }
    if (when > latest.when) throw new Error('Este backup foi feito por uma versão mais nova do NoPaper. Atualize o sistema antes de restaurá-lo.');
  });
  // backup de versão anterior: traz o banco para a versão atual
  try { await migrateDatabase(dbUrl(tmp)); } catch (e) {
    throw new Error(`Falha ao atualizar o banco do backup para a versão atual: ${(e as Error).message}`);
  }
  await withClient(tmp, async (c) => {
    const { rows } = await c.query('select count(*)::int as n from users where is_superadmin and active');
    if (!rows[0]?.n) throw new Error('O backup não tem nenhum administrador da plataforma ativo: depois de restaurar ninguém conseguiria gerenciar o sistema.');
    // segredos (SMTP, Telegram) cifrados com outra chave não poderão ser lidos aqui
    const settings = await c.query<{ key: string; value: unknown }>(`select key, value from system_settings where key <> 'backup'`);
    const bad = settings.rows.filter((r) => hasUnreadableSecret(r.value)).map((r) => r.key);
    if (bad.length) warnings.push(`Alguns segredos do backup (${bad.join(', ')}) foram cifrados com outra SECRETS_KEY e não podem ser lidos neste servidor: cadastre-os de novo em Plataforma.`);
  });
}
function hasUnreadableSecret(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  return Object.entries(v as Record<string, unknown>).some(([k, x]) =>
    (k.endsWith('Enc') && typeof x === 'string' && x && decryptSecret(x) === null) || hasUnreadableSecret(x));
}

// ------------------------------------------------------------------ arquivo
interface ArchiveInfo { manifest: BackupManifest; dump: string; uploadFiles: number }

/** Confere um pacote de backup sem alterar nada. Extrai o dump e o manifesto em `work`. */
export async function inspectArchive(file: string, work: string): Promise<ArchiveInfo> {
  let names: string[], verbose: string[];
  try {
    names = (await run('tar', ['-tzf', file], { timeoutMs: 30 * 60_000 })).split('\n').filter(Boolean);
    verbose = (await run('tar', ['-tvzf', file], { timeoutMs: 30 * 60_000 })).split('\n').filter(Boolean);
  } catch {
    throw new Error('O arquivo está corrompido ou não é um backup do NoPaper (.tar.gz).');
  }
  for (const n of names) {
    const clean = n.replace(/^\.\//, '');
    const ok = clean === 'manifest.json' || clean === 'database.dump' || clean === 'uploads/' || clean.startsWith('uploads/');
    if (!ok || clean.startsWith('/') || clean.split('/').includes('..')) throw new Error(`Conteúdo inesperado no backup: ${n}`);
  }
  if (verbose.some((l) => l[0] === 'l' || l[0] === 'h')) throw new Error('O backup contém links, o que não é permitido.');
  if (!names.includes('database.dump')) throw new Error('O arquivo não contém o banco de dados (database.dump).');
  if (!names.includes('manifest.json')) throw new Error('O arquivo não contém o manifesto: não parece um backup do NoPaper.');

  await run('tar', ['-xzf', file, '-C', work, 'manifest.json', 'database.dump'], { timeoutMs: 30 * 60_000 });
  let manifest: BackupManifest;
  try { manifest = JSON.parse(await readFile(path.join(work, 'manifest.json'), 'utf8')); } catch { throw new Error('Manifesto do backup ilegível.'); }
  if (manifest.app !== 'nopaper') throw new Error('O arquivo não é um backup do NoPaper.');
  const dump = path.join(work, 'database.dump');
  if (manifest.dumpSha256 && (await sha256File(dump)) !== manifest.dumpSha256) throw new Error('O banco dentro do backup está corrompido (checksum não confere).');
  if (manifest.migration && manifest.migration.when > latestMigration().when) {
    throw new Error(`Este backup foi feito por uma versão mais nova do NoPaper${manifest.appVersion ? ` (${manifest.appVersion})` : ''}. Atualize o sistema antes de restaurá-lo.`);
  }
  try {
    const toc = await run(pgRestoreBin(), ['--list', dump], { timeoutMs: 5 * 60_000 });
    if (!/TABLE DATA public users\b/.test(toc)) throw new Error('sem a tabela de usuários');
  } catch (e) { throw new Error(`O banco dentro do backup é inválido (${(e as Error).message}).`); }
  const uploadFiles = names.filter((n) => n.startsWith('uploads/') && !n.endsWith('/')).length;
  return { manifest, dump, uploadFiles };
}

// ------------------------------------------------------------------ anexos
const visible = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter((n) => !n.startsWith('.'));
const newUploadsDir = () => path.join(storageDir(), '.restore-new');
const prevUploadsDir = () => path.join(storageDir(), '.restore-prev');

async function assertNoLinks(dir: string) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if ((await lstat(p)).isSymbolicLink()) throw new Error('O backup contém links, o que não é permitido.');
    if (e.isDirectory()) await assertNoLinks(p);
  }
}

async function swapUploads(file: string) {
  const s = current!;
  const S = storageDir(), NEW = newUploadsDir(), PREV = prevUploadsDir();
  await rm(NEW, { recursive: true, force: true });
  await rm(PREV, { recursive: true, force: true });
  await mkdir(NEW, { recursive: true });
  // extrai o pacote inteiro no mesmo disco dos anexos (rename instantâneo depois)
  await run('tar', ['-xzf', file, '-C', NEW], { timeoutMs: 2 * 3600_000 });
  const src = path.join(NEW, 'uploads');
  await mkdir(src, { recursive: true });
  await assertNoLinks(src);
  await mkdir(PREV, { recursive: true });
  s.uploadsPhase = 'out'; await persist();
  for (const n of await visible(S)) await rename(path.join(S, n), path.join(PREV, n));
  s.uploadsPhase = 'in'; await persist();
  for (const n of await visible(src)) await rename(path.join(src, n), path.join(S, n));
  s.uploadsPhase = 'done'; await persist();
  await rm(NEW, { recursive: true, force: true });
}

/** Volta os anexos anteriores (PREV) para o lugar, conforme a fase em que parou. */
async function rollbackUploads(phase: RestoreState['uploadsPhase']) {
  const S = storageDir(), PREV = prevUploadsDir();
  if (phase === 'in' || phase === 'done') {
    // todos os antigos já tinham saído: o que está em S é do backup
    for (const n of await visible(S)) await rm(path.join(S, n), { recursive: true, force: true });
  }
  if (phase !== 'none') for (const n of await visible(PREV)) await rename(path.join(PREV, n), path.join(S, n));
  await rm(PREV, { recursive: true, force: true });
  await rm(newUploadsDir(), { recursive: true, force: true });
}

// ------------------------------------------------------------------ execução
export async function startRestore(input: { source: 'local' | 'remote'; name: string }, by: { id: string; name: string }, log: FastifyBaseLogger) {
  if (!BACKUP_FILE_RE.test(input.name)) throw new Error('Nome de backup inválido');
  if (isRestoring()) throw new Error('Já existe uma restauração em andamento');
  if (input.source === 'local') {
    const p = localBackupPath(input.name);
    if (!p || !(await stat(p).catch(() => null))) throw new Error('Arquivo de backup não encontrado no servidor');
  } else if ((await loadBackupConfig()).remote.mode === 'none') {
    throw new Error('Nenhum destino remoto configurado');
  }
  acquireOperation('restore');
  current = {
    id: randomUUID(), state: 'running', source: input.source, file: input.name,
    steps: [...(input.source === 'remote' ? ['download' as const] : []), 'validate', 'database', 'maintenance', 'safety', 'switch', 'uploads', 'finish'],
    step: input.source === 'remote' ? 'download' : 'validate',
    startedAt: new Date().toISOString(), finishedAt: null, byName: by.name, error: null, outcome: null, warnings: [],
    safetyBackup: null, backupCreatedAt: null, swapStarted: false, dbSwapped: false, uploadsPhase: 'none',
  };
  try { await persist(); } catch (e) { releaseOperation('restore'); current = null; throw e; }
  void execute(by, log).finally(() => releaseOperation('restore'));
  return restoreStatus();
}

async function execute(by: { id: string; name: string }, log: FastifyBaseLogger) {
  const s = current!;
  const step = async (st: RestoreStep) => { s.step = st; await persist(); log.info({ restore: s.id, step: st }, 'restauração'); };
  let work: string | null = null;
  let maintenance = false, jobsStopped = false, succeeded = false;
  try {
    let file: string;
    if (s.source === 'remote') {
      await step('download');
      file = await fetchRemoteBackup(s.file).catch((e) => { throw new Error(`Falha ao baixar do destino remoto: ${(e as Error).message}`); });
    } else file = localBackupPath(s.file)!;

    await step('validate');
    work = await mkdtemp(path.join(backupDir(), '.restore-work-'));
    const info = await inspectArchive(file, work);
    s.backupCreatedAt = info.manifest.createdAt;
    if (!info.manifest.includesUploads) s.warnings.push('Este backup foi feito sem anexos: os anexos atuais foram mantidos.');

    await step('database');
    // sobra de uma restauração anterior: o *_pre_restore só pode existir durante a troca
    await withAdmin((c) => dropDb(c, prevDbName()));
    await restoreIntoTemp(info.dump, s.warnings);
    await rm(info.dump, { force: true }); // libera espaço antes da cópia de segurança

    await step('maintenance');
    enterMaintenance(); maintenance = true;
    if (!(await drainRequests())) log.warn('restauração: requisições ainda abertas após 30 s, seguindo');
    await stopJobs(30_000); jobsStopped = true;

    await step('safety');
    const safety = await runBackup('pre_restore', { forceUploads: true, skipRetention: true, skipRemote: true, insideRestore: true });
    if (safety.status !== 'ok' || !safety.fileName) throw new Error(`Não foi possível fazer a cópia de segurança do estado atual (${safety.error ?? 'erro desconhecido'}). Nada foi alterado.`);
    s.safetyBackup = safety.fileName; await persist();

    await step('switch');
    const fileSize = (await stat(file)).size;
    const currentBackupCfg = await getSystemSetting<unknown>('backup');
    await withClient(tmpDbName(), async (c) => {
      // todos entram de novo (as sessões do backup não valem mais)
      await c.query('delete from sessions');
      // a configuração de backup é do servidor (destino, credenciais): mantém a atual
      if (currentBackupCfg) {
        await c.query(`insert into system_settings (key, value, updated_at) values ('backup', $1, now())
          on conflict (key) do update set value = excluded.value, updated_at = now()`, [JSON.stringify(currentBackupCfg)]);
      }
      // o dump é tirado com a própria execução "em andamento": ela é justamente o backup restaurado
      await c.query(`update backup_runs set status = 'ok', file_name = coalesce(file_name, $1), size_bytes = coalesce(size_bytes, $2),
        finished_at = coalesce(finished_at, $3) where status = 'running'`, [s.file, fileSize, s.backupCreatedAt]);
      await c.query(`insert into backup_runs (trigger, status, file_name, size_bytes, remote_status, started_at, finished_at)
        values ('pre_restore', 'ok', $1, $2, 'none', $3, $4)`, [safety.fileName, safety.sizeBytes, safety.startedAt, safety.finishedAt]);
      await c.query(`insert into audit_logs (user_id, user_name, action, entity_type, description, details)
        values ((select id from users where id = $1), $2, 'system.restore', 'system', $3, $4)`, [
        by.id, by.name, `Restaurou o backup ${s.file}`,
        JSON.stringify({ file: s.file, source: s.source, backupCreatedAt: s.backupCreatedAt, safetyBackup: s.safetyBackup }),
      ]);
    });
    s.swapStarted = true; await persist();
    await withAdmin(async (c) => {
      await terminate(c, tmpDbName());
      await renameDb(c, dbName(), prevDbName());
      try { await renameDb(c, tmpDbName(), dbName()); } catch (e) {
        await renameDb(c, prevDbName(), dbName());
        throw e;
      }
    });
    s.dbSwapped = true; await persist();
    // o pool reconecta sozinho no banco novo (as conexões antigas foram derrubadas)
    await retry(() => pool.query('select count(*) from users'));

    await step('uploads');
    if (info.manifest.includesUploads) await swapUploads(file);

    await step('finish');
    // ponto sem volta: gravado ANTES de apagar o antigo. Daqui em diante nada desfaz
    // (nem a recuperação no boot), e falhas na limpeza viram só avisos.
    s.swapStarted = false; s.uploadsPhase = 'none'; await persist();
    succeeded = true;
    await rm(prevUploadsDir(), { recursive: true, force: true }).catch((e) => log.warn({ err: e }, 'restauração: não apagou os anexos anteriores'));
    await withAdmin((c) => dropDb(c, prevDbName())).catch((e) => log.warn({ err: e }, 'restauração: não apagou o banco anterior'));
    log.info({ restore: s.id, file: s.file, safety: s.safetyBackup }, 'restauração concluída');
  } catch (e) {
    if (succeeded) { log.warn({ err: e }, 'restauração: erro na limpeza final'); return; }
    const msg = (e as Error).message;
    log.error({ err: e, restore: s.id, step: s.step }, 'restauração falhou');
    s.error = msg;
    s.outcome = s.dbSwapped || s.uploadsPhase !== 'none' ? 'rolled_back' : 'untouched';
    try {
      await rollbackUploads(s.uploadsPhase);
      s.uploadsPhase = 'none';
      if (s.dbSwapped) {
        await withAdmin(async (c) => {
          await renameDb(c, dbName(), tmpDbName());
          await renameDb(c, prevDbName(), dbName());
        });
        s.dbSwapped = false;
      }
      s.swapStarted = false;
    } catch (re) {
      s.outcome = null;
      s.error = `${msg} — e não foi possível desfazer automaticamente (${(re as Error).message}).${s.safetyBackup ? ` Restaure a cópia de segurança ${s.safetyBackup}.` : ''}`;
      log.error({ err: re }, 'restauração: falha ao desfazer');
    }
    await withAdmin((c) => dropDb(c, tmpDbName())).catch(() => null);
  } finally {
    if (work) await rm(work, { recursive: true, force: true }).catch(() => null);
    if (jobsStopped) await startJobs(log).catch((err) => { log.error({ err }, 'restauração: falha ao religar os jobs'); s.warnings.push('Os jobs agendados não religaram: reinicie a API.'); });
    if (maintenance) exitMaintenance();
    // o estado final só é gravado com o sistema já de volta (a tela leva ao login em seguida)
    s.state = succeeded ? 'done' : 'error';
    s.finishedAt = new Date().toISOString();
    await persist().catch((err) => log.error({ err }, 'restauração: falha ao gravar o status'));
  }
}

async function retry<T>(fn: () => Promise<T>, times = 10): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) { if (i >= times) throw e; await new Promise((r) => setTimeout(r, 300)); }
  }
}

// ------------------------------------------------------------------ boot
/**
 * Roda no boot, ANTES das migrations: se o servidor caiu no meio de uma restauração,
 * volta banco e anexos ao estado anterior.
 */
export async function recoverInterruptedRestore(log: FastifyBaseLogger) {
  current = await loadState();
  const s = current;
  if (!s || s.state !== 'running') return;
  log.warn({ restore: s.id, step: s.step }, 'restauração interrompida encontrada: desfazendo');
  try {
    let kept = false;
    await withAdmin(async (c) => {
      const main = await dbExists(c, dbName());
      const prev = s.swapStarted && (await dbExists(c, prevDbName())); // só conta se for desta restauração
      if (!main && prev) await renameDb(c, prevDbName(), dbName()); // caiu entre os dois renames
      else if (main && prev) { await renameDb(c, dbName(), tmpDbName()); await renameDb(c, prevDbName(), dbName()); } // depois dos dois
      else if (s.dbSwapped && !prev) kept = true; // caiu já no fim (banco antigo apagado): o restaurado fica
      await dropDb(c, tmpDbName());
    });
    if (kept) {
      await rm(prevUploadsDir(), { recursive: true, force: true });
      await rm(newUploadsDir(), { recursive: true, force: true });
      Object.assign(s, { state: 'done', uploadsPhase: 'none', finishedAt: new Date().toISOString() });
      s.warnings.push('O servidor reiniciou no fim da restauração, mas ela já estava concluída.');
    } else {
      await rollbackUploads(s.uploadsPhase);
      Object.assign(s, {
        state: 'error', outcome: s.dbSwapped || s.uploadsPhase !== 'none' ? 'rolled_back' : 'untouched',
        swapStarted: false, dbSwapped: false, uploadsPhase: 'none', finishedAt: new Date().toISOString(),
        error: 'O servidor reiniciou durante a restauração. O sistema voltou ao estado anterior; tente de novo.',
      });
    }
  } catch (e) {
    Object.assign(s, { state: 'error', outcome: null, finishedAt: new Date().toISOString(), error: `Restauração interrompida e não foi possível desfazer automaticamente: ${(e as Error).message}` });
    log.error({ err: e }, 'restauração: falha na recuperação');
  }
  await persist();
}

// ------------------------------------------------------------------ envio de arquivo
/** Recebe um backup enviado pela tela, confere e guarda na pasta de backups. */
export async function saveUploadedBackup(stream: Readable & { truncated?: boolean }) {
  await mkdir(backupDir(), { recursive: true });
  const id = randomUUID();
  const tmp = path.join(backupDir(), `.upload-${id}.tar.gz`);
  const work = path.join(backupDir(), `.upload-${id}-work`);
  try {
    await pipeline(stream, createWriteStream(tmp, { mode: 0o600 }));
    if (stream.truncated) throw new Error('Arquivo grande demais');
    await mkdir(work);
    const info = await inspectArchive(tmp, work);
    const size = (await stat(tmp)).size;
    const created = new Date(info.manifest.createdAt);
    let name = `nopaper-${stamp(Number.isNaN(created.getTime()) ? new Date() : created)}.tar.gz`;
    const existing = await stat(path.join(backupDir(), name)).catch(() => null);
    if (existing && existing.size === size) return { name, createdAt: info.manifest.createdAt, size, existed: true };
    for (let i = 1; existing && i < 120; i++) {
      const t = new Date(created.getTime() + i * 1000);
      name = `nopaper-${stamp(t)}.tar.gz`;
      if (!(await stat(path.join(backupDir(), name)).catch(() => null))) break;
    }
    await rename(tmp, path.join(backupDir(), name));
    return { name, createdAt: info.manifest.createdAt, size, existed: false };
  } finally {
    await rm(tmp, { force: true });
    await rm(work, { recursive: true, force: true });
  }
}
