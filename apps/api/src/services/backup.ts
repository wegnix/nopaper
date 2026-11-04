import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import { and, desc, eq, gt } from 'drizzle-orm';
import { backupConfigSchema, todayISO, type BackupConfig } from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { latestMigration } from '../db/migrate.js';
import { env } from '../env.js';
import { decryptSecret } from '../lib/secrets.js';
import { getSystemSetting, setSystemSetting } from '../lib/settings.js';
import { APP_VERSION } from '../lib/version.js';

/** Como fica guardado: segredos cifrados (…Enc) no lugar dos campos em texto. */
export interface StoredBackup extends Omit<BackupConfig, 'remote'> {
  remote: Omit<BackupConfig['remote'], 'sftp' | 'rcloneConfig'> & {
    sftp: Omit<BackupConfig['remote']['sftp'], 'password' | 'privateKey'> & { passwordEnc: string | null; privateKeyEnc: string | null };
    rcloneConfigEnc: string | null;
  };
  lastRunOn?: string | null;
}

export async function loadBackupConfig(): Promise<StoredBackup> {
  const raw = await getSystemSetting<StoredBackup>('backup');
  const base = backupConfigSchema.parse({});
  return {
    ...base, ...raw,
    remote: {
      ...base.remote, ...raw?.remote,
      sftp: { ...base.remote.sftp, passwordEnc: null, privateKeyEnc: null, ...raw?.remote?.sftp },
      rcloneConfigEnc: raw?.remote?.rcloneConfigEnc ?? null,
    },
  } as StoredBackup;
}
export const saveBackupConfig = (c: StoredBackup) => setSystemSetting('backup', c);

export const BACKUP_FILE_RE = /^nopaper-\d{8}-\d{6}\.tar\.gz$/;
export const backupDir = () => path.resolve(env.BACKUP_DIR);
export const storageDir = () => path.resolve(env.STORAGE_DIR);

/** Conteúdo do manifest.json dentro de cada backup. */
export interface BackupManifest {
  app: 'nopaper';
  /** 2 = com checksum do dump e versão do banco. Backups antigos (sem campo) são aceitos. */
  format?: number;
  createdAt: string;
  trigger?: string;
  includesUploads: boolean;
  uploadsCount?: number;
  dumpSha256?: string;
  dumpBytes?: number;
  migration?: { tag: string; when: number };
  /** Versão do NoPaper que gerou o backup (a partir da 1.0.0). */
  appVersion?: string;
}

// ------------------------------------------------------------------ trava de operação
/** Backup e restauração nunca rodam ao mesmo tempo (processo único). */
let operation: 'backup' | 'restore' | 'update' | null = null;
export const currentOperation = () => operation;
export function acquireOperation(op: 'backup' | 'restore' | 'update') {
  if (operation === 'restore') throw new Error('Há uma restauração em andamento');
  if (operation === 'backup') throw new Error('Já existe um backup em andamento');
  if (operation === 'update') throw new Error('Há uma atualização do sistema em andamento');
  operation = op;
}
export function releaseOperation(op: 'backup' | 'restore' | 'update') { if (operation === op) operation = null; }

// ------------------------------------------------------------------ processos
export function run(cmd: string, args: string[], opts: { stdin?: string; stdoutFile?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'], cwd: opts.cwd });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${path.basename(cmd)}: tempo esgotado`)); }, opts.timeoutMs ?? 30 * 60_000);
    // com arquivo de saída, só resolve depois que o arquivo terminou de ser gravado
    const fileDone = opts.stdoutFile
      ? new Promise<void>((res, rej) => { const ws = createWriteStream(opts.stdoutFile!, { mode: 0o600 }); ws.on('finish', res); ws.on('error', rej); p.stdout.pipe(ws); })
      : Promise.resolve();
    if (!opts.stdoutFile) p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; if (err.length > 8000) err = err.slice(-8000); });
    p.on('error', (e) => { clearTimeout(timer); reject(new Error((e as NodeJS.ErrnoException).code === 'ENOENT' ? `${cmd} não encontrado no servidor` : e.message)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) fileDone.then(() => resolve(out.trim()), reject);
      else {
        // ignora avisos informativos do rclone; mostra só o erro de verdade
        const lines = err.trim().split('\n').filter((l) => l && !/ NOTICE: /.test(l)).map((l) => l.replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d (CRITICAL|ERROR) ?: ?/, ''));
        reject(new Error(`${path.basename(cmd)} saiu com código ${code}: ${lines.slice(-2).join(' ')}`));
      }
    });
    if (opts.stdin !== undefined) p.stdin.end(opts.stdin); else p.stdin.end();
  });
}

/** URL do banco sem senha (a senha vai por PGPASSWORD e não aparece na lista de processos). */
export function pgConn(dbName?: string) {
  const url = new URL(env.DATABASE_URL);
  const password = decodeURIComponent(url.password);
  url.password = '';
  if (dbName) url.pathname = `/${encodeURIComponent(dbName)}`;
  return { url: url.toString(), env: { PGPASSWORD: password } };
}

export function sha256File(file: string) {
  return new Promise<string>((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

// ------------------------------------------------------------------ destino remoto (rclone)
export interface Remote { configFile: string; target: string; cleanup: () => Promise<void> }

export async function prepareRemote(cfg: StoredBackup): Promise<Remote | null> {
  const r = cfg.remote;
  if (r.mode === 'none') return null;
  await mkdir(backupDir(), { recursive: true });
  const dir = await mkdtemp(path.join(backupDir(), '.rclone-'));
  const configFile = path.join(dir, 'rclone.conf');
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    let conf: string, target: string;
    if (r.mode === 'sftp') {
      if (!r.sftp.host || !r.sftp.user) throw new Error('Informe servidor e usuário do SFTP');
      const lines = ['[np]', 'type = sftp', `host = ${r.sftp.host}`, `user = ${r.sftp.user}`, `port = ${r.sftp.port}`];
      const pass = decryptSecret(r.sftp.passwordEnc);
      const key = decryptSecret(r.sftp.privateKeyEnc);
      if (!pass && !key) throw new Error('Informe a senha ou a chave privada do SFTP');
      if (pass) lines.push(`pass = ${await run(env.RCLONE_BIN, ['obscure', '-'], { stdin: pass, timeoutMs: 15_000 })}`);
      if (key) lines.push(`key_pem = ${key.trim().replace(/\r?\n/g, '\\n')}`);
      conf = lines.join('\n') + '\n';
      target = `np:${r.sftp.path.replace(/\/+$/, '')}`;
    } else {
      conf = decryptSecret(r.rcloneConfigEnc) ?? '';
      if (!conf.trim()) throw new Error('Cole o conteúdo do rclone.conf');
      if (!/^[\w.-]+:/.test(r.rcloneTarget)) throw new Error('Destino deve ser remoto:caminho, ex.: gdrive:Backups/nopaper');
      target = r.rcloneTarget.replace(/\/+$/, '');
    }
    await writeFile(configFile, conf, { mode: 0o600 });
    await chmod(configFile, 0o600);
    return { configFile, target, cleanup };
  } catch (e) { await cleanup(); throw e; }
}

export const rclone = (rem: Remote, args: string[], timeoutMs?: number) =>
  run(env.RCLONE_BIN, [...args, '--config', rem.configFile, '--contimeout', '20s', '--retries', '2'], { timeoutMs });

export async function testRemote(cfg: StoredBackup) {
  const rem = await prepareRemote(cfg);
  if (!rem) throw new Error('Nenhum destino remoto configurado');
  try {
    await rclone(rem, ['mkdir', rem.target], 60_000);
    const out = await rclone(rem, ['lsf', rem.target, '--max-depth', '1'], 60_000);
    return { ok: true, files: out ? out.split('\n').length : 0 };
  } finally { await rem.cleanup(); }
}

/** Backups disponíveis no destino remoto (mais novos primeiro). */
export async function listRemoteBackups() {
  const rem = await prepareRemote(await loadBackupConfig());
  if (!rem) throw new Error('Nenhum destino remoto configurado');
  try {
    const out = await rclone(rem, ['lsf', rem.target, '--files-only', '--max-depth', '1', '--format', 'sp', '--separator', ';'], 2 * 60_000);
    return out.split('\n').filter(Boolean).map((l) => { const [s, name] = l.split(';'); return { name: name!, size: Number(s) }; })
      .filter((f) => BACKUP_FILE_RE.test(f.name)).sort((a, b) => b.name.localeCompare(a.name));
  } finally { await rem.cleanup(); }
}

/** Baixa um backup do destino remoto para a pasta local (se ainda não estiver lá). */
export async function fetchRemoteBackup(name: string) {
  if (!BACKUP_FILE_RE.test(name)) throw new Error('Nome de backup inválido');
  const final = path.join(backupDir(), name);
  if (await stat(final).catch(() => null)) return final;
  const rem = await prepareRemote(await loadBackupConfig());
  if (!rem) throw new Error('Nenhum destino remoto configurado');
  const tmp = path.join(backupDir(), `.fetch-${Date.now()}-${name}`);
  try {
    await rclone(rem, ['copyto', `${rem.target}/${name}`, tmp], 2 * 3600_000);
    await rename(tmp, final);
    return final;
  } finally {
    await rem.cleanup();
    await rm(tmp, { force: true });
  }
}

// ------------------------------------------------------------------ backup
export const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export async function listLocalBackups() {
  await mkdir(backupDir(), { recursive: true });
  const names = (await readdir(backupDir())).filter((n) => BACKUP_FILE_RE.test(n)).sort().reverse();
  const out = await Promise.all(names.map(async (name) => {
    const st = await stat(path.join(backupDir(), name)).catch(() => null);
    return st ? { name, size: st.size } : null;
  }));
  return out.filter((x): x is { name: string; size: number } => !!x);
}
export const localBackupPath = (name: string) => (BACKUP_FILE_RE.test(name) ? path.join(backupDir(), name) : null);

/** Anexos guardados: tudo em STORAGE_DIR menos pastas/arquivos ocultos (temporários da restauração). */
async function countUploads(dir: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) n += await countUploads(path.join(dir, e.name));
    else if (e.isFile()) n++;
  }
  return n;
}

/** Nome livre na pasta de backups (dois backups no mesmo segundo ganham +1s). */
async function freeName(d: Date) {
  const t = new Date(d);
  for (let i = 0; i < 120; i++) {
    const name = `nopaper-${stamp(t)}.tar.gz`;
    if (!(await stat(path.join(backupDir(), name)).catch(() => null))) return name;
    t.setSeconds(t.getSeconds() + 1);
  }
  throw new Error('Não foi possível escolher um nome para o backup');
}

export type BackupTrigger = 'schedule' | 'manual' | 'pre_restore' | 'pre_update';
interface BackupOpts {
  /** Inclui anexos mesmo se a configuração disser que não (cópia de segurança da restauração). */
  forceUploads?: boolean;
  /** Não apaga backups antigos (a restauração não pode apagar o arquivo que vai restaurar). */
  skipRetention?: boolean;
  skipRemote?: boolean;
  /** A restauração já segura a trava de operação. */
  insideRestore?: boolean;
}

export async function runBackup(trigger: BackupTrigger, opts: BackupOpts = {}) {
  if (!opts.insideRestore) acquireOperation('backup');
  try {
    return await doBackup(trigger, opts);
  } finally {
    if (!opts.insideRestore) releaseOperation('backup');
  }
}

async function doBackup(trigger: BackupTrigger, opts: BackupOpts) {
  // outra instância da API (ex.: duas no mesmo banco) com backup recente em andamento
  const recent = await db.select({ id: schema.backupRuns.id }).from(schema.backupRuns)
    .where(and(eq(schema.backupRuns.status, 'running'), gt(schema.backupRuns.startedAt, new Date(Date.now() - 2 * 3600_000))));
  if (recent.length) throw new Error('Já existe um backup em andamento');

  const cfg = await loadBackupConfig();
  const includeUploads = opts.forceUploads || cfg.includeUploads;
  const [runRow] = await db.insert(schema.backupRuns).values({ trigger, status: 'running' }).returning();
  await mkdir(backupDir(), { recursive: true });
  const work = await mkdtemp(path.join(backupDir(), '.work-'));
  const now = new Date();
  const fileName = await freeName(now);
  const finalPath = path.join(backupDir(), fileName);
  const partPath = path.join(work, 'backup.tar.gz');
  let remoteStatus: 'none' | 'ok' | 'error' = 'none';
  let remoteError: string | null = null;
  try {
    // 1) dump do banco (formato custom: restaura com pg_restore). A fila de jobs (pgboss) fica de fora.
    const dump = path.join(work, 'database.dump');
    const conn = pgConn();
    await run(env.PG_DUMP_BIN, ['--format=custom', '--no-owner', '--no-privileges', '--exclude-schema=pgboss', `--dbname=${conn.url}`], { stdoutFile: dump, env: conn.env });
    const dumpBytes = (await stat(dump)).size;
    if (dumpBytes < 100) throw new Error('pg_dump gerou um arquivo vazio');
    // o dump precisa ser legível e conter as tabelas principais
    const toc = await run(pgRestoreBin(), ['--list', dump], { timeoutMs: 5 * 60_000 });
    if (!/TABLE DATA public users\b/.test(toc)) throw new Error('Verificação falhou: o dump não contém a tabela de usuários');

    // 2) pacote .tar.gz com o dump, os anexos e o manifesto
    const uploadsDir = storageDir();
    const manifest: BackupManifest = {
      app: 'nopaper', format: 2, createdAt: now.toISOString(), trigger, includesUploads: includeUploads,
      uploadsCount: includeUploads ? await countUploads(uploadsDir) : undefined,
      dumpSha256: await sha256File(dump), dumpBytes, migration: latestMigration(), appVersion: APP_VERSION,
    };
    await writeFile(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(partPath, { mode: 0o600 });
      const tar = archiver('tar', { gzip: true, gzipOptions: { level: 6 } });
      out.on('close', () => resolve());
      tar.on('error', reject);
      tar.on('warning', reject);
      out.on('error', reject);
      tar.pipe(out);
      tar.file(path.join(work, 'manifest.json'), { name: 'manifest.json' });
      tar.file(dump, { name: 'database.dump' });
      // ocultos (.restore-*) ficam de fora
      if (includeUploads) tar.glob('**/*', { cwd: uploadsDir, dot: false, nodir: true }, { prefix: 'uploads' });
      void tar.finalize();
    });

    // 3) confere o pacote: abre o .tar.gz inteiro e confere o conteúdo
    const listing = (await run('tar', ['-tzf', partPath], { timeoutMs: 30 * 60_000 })).split('\n');
    if (!listing.includes('database.dump') || !listing.includes('manifest.json')) throw new Error('Verificação falhou: o pacote gerado está incompleto');
    const packedUploads = listing.filter((l) => l.startsWith('uploads/') && !l.endsWith('/')).length;
    if (includeUploads && packedUploads !== manifest.uploadsCount) {
      throw new Error(`Verificação falhou: ${manifest.uploadsCount} anexos no servidor, ${packedUploads} no pacote (algum arquivo mudou durante o backup? tente de novo)`);
    }
    await rename(partPath, finalPath);
    const size = (await stat(finalPath)).size;

    // 4) envio para o destino remoto + limpeza lá
    if (cfg.remote.mode !== 'none' && !opts.skipRemote) {
      let rem: Remote | null = null;
      try {
        rem = await prepareRemote(cfg);
        await rclone(rem!, ['copyto', finalPath, `${rem!.target}/${fileName}`]);
        // confere o tamanho do que chegou lá
        const remoteSize = Number((await rclone(rem!, ['lsf', `${rem!.target}/${fileName}`, '--format', 's'], 60_000)).trim());
        if (remoteSize !== size) throw new Error(`arquivo no destino com tamanho diferente (${remoteSize} ≠ ${size})`);
        if (cfg.remote.keepDays > 0) {
          await rclone(rem!, ['delete', rem!.target, '--min-age', `${cfg.remote.keepDays}d`, '--include', 'nopaper-*.tar.gz', '--max-depth', '1'], 10 * 60_000);
        }
        remoteStatus = 'ok';
      } catch (e) {
        remoteStatus = 'error';
        remoteError = (e as Error).message;
      } finally { await rem?.cleanup(); }
    }

    // 5) retenção local (nunca apaga o que acabou de ser criado)
    if (!opts.skipRetention) {
      const all = await listLocalBackups();
      for (const old of all.slice(cfg.keepLocal)) if (old.name !== fileName) await rm(path.join(backupDir(), old.name), { force: true });
    }

    const [done] = await db.update(schema.backupRuns).set({
      status: 'ok', fileName, sizeBytes: size, remoteStatus, error: remoteError ? `Envio remoto: ${remoteError}`.slice(0, 2000) : null, finishedAt: new Date(),
    }).where(eq(schema.backupRuns.id, runRow.id)).returning();
    return done;
  } catch (e) {
    await rm(finalPath, { force: true });
    const [failed] = await db.update(schema.backupRuns).set({ status: 'error', error: (e as Error).message.slice(0, 2000), finishedAt: new Date() })
      .where(eq(schema.backupRuns.id, runRow.id)).returning();
    return failed;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** pg_restore fica ao lado do pg_dump (mesmo pacote do PostgreSQL). */
export function pgRestoreBin() {
  return env.PG_DUMP_BIN.includes('/') ? path.join(path.dirname(env.PG_DUMP_BIN), 'pg_restore') : 'pg_restore';
}

export async function recentRuns(limit = 20) {
  return db.select().from(schema.backupRuns).orderBy(desc(schema.backupRuns.startedAt)).limit(limit);
}

/**
 * Boot: execuções que ficaram "em andamento" porque o servidor caiu viram erro (senão travam
 * novos backups) e as pastas temporárias são apagadas.
 */
export async function cleanupInterruptedBackups() {
  await db.update(schema.backupRuns).set({ status: 'error', error: 'Interrompido: o servidor reiniciou durante o backup', finishedAt: new Date() })
    .where(eq(schema.backupRuns.status, 'running'));
  await mkdir(backupDir(), { recursive: true });
  for (const n of await readdir(backupDir())) {
    if (/^\.(work|rclone|fetch|upload|restore-work)-/.test(n)) await rm(path.join(backupDir(), n), { recursive: true, force: true });
  }
}

/** Job periódico: roda o backup agendado uma vez por dia, na hora configurada (fuso padrão do servidor). */
export async function runBackupTick() {
  if (currentOperation()) return { skipped: `busy:${currentOperation()}` };
  const cfg = await loadBackupConfig();
  if (!cfg.enabled) return { skipped: 'disabled' };
  const today = todayISO(env.TZ_DEFAULT);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: env.TZ_DEFAULT, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  if (cfg.lastRunOn === today || hour < cfg.hour) return { skipped: 'not-time' };
  await saveBackupConfig({ ...cfg, lastRunOn: today });
  const r = await runBackup('schedule');
  return { status: r.status, file: r.fileName, remote: r.remoteStatus };
}
