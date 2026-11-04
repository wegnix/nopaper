import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { stat } from 'node:fs/promises';
import { db, schema } from '../db/client.js';
import { env } from '../env.js';
import { parse } from '../lib/validate.js';
import { badRequest, conflict } from '../lib/errors.js';
import { requireAuth, requireSuperadmin } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { APP_VERSION } from '../lib/version.js';
import { acquireOperation, currentOperation, localBackupPath, releaseOperation, runBackup } from '../services/backup.js';
import { availableReleases, startUpdate, updaterInfo, updaterStatus } from '../services/updates.js';

/** O backup completo exigido antes de atualizar vale por este tempo. */
const BACKUP_VALID_MS = 60 * 60_000;

const applySchema = z.object({
  version: z.string().regex(/^v\d+\.\d+\.\d+$/),
  backupRunId: z.string().uuid(),
  confirm: z.literal(true),
});

/** Último backup "antes de atualizar" e se ainda vale para liberar a atualização. */
async function latestPreUpdateBackup() {
  const [run] = await db.select().from(schema.backupRuns).where(eq(schema.backupRuns.trigger, 'pre_update'))
    .orderBy(desc(schema.backupRuns.startedAt)).limit(1);
  if (!run) return null;
  const file = run.fileName ? localBackupPath(run.fileName) : null;
  const exists = !!file && !!(await stat(file).catch(() => null));
  const fresh = run.status === 'ok' && exists && !!run.finishedAt && Date.now() - run.finishedAt.getTime() < BACKUP_VALID_MS;
  return {
    id: run.id, status: run.status, fileName: run.fileName, sizeBytes: run.sizeBytes, remoteStatus: run.remoteStatus,
    error: run.error, startedAt: run.startedAt, finishedAt: run.finishedAt, usable: fresh,
    validUntil: run.finishedAt ? new Date(run.finishedAt.getTime() + BACKUP_VALID_MS) : null,
  };
}

/** Enquanto o updater trabalha, a API não deixa começar backup nem restauração. */
let watching: NodeJS.Timeout | null = null;
function holdUntilUpdaterIdle() {
  if (watching) return;
  watching = setInterval(async () => {
    const s = await updaterStatus();
    if (s && s.state === 'running') return;
    releaseOperation('update');
    clearInterval(watching!);
    watching = null;
  }, 5000);
}

export default async function updateRoutes(app: FastifyInstance) {
  const guard = { preHandler: [requireAuth, requireSuperadmin] };

  app.get('/api/system/updates', guard, async () => {
    const [rel, info, status, backup] = await Promise.all([availableReleases(), updaterInfo(), updaterStatus(), latestPreUpdateBackup()]);
    const expectedOrigin = `github.com/${env.UPDATE_REPO}`;
    return {
      current: APP_VERSION, repo: env.UPDATE_REPO,
      releases: rel.releases, checkedAt: new Date(rel.at).toISOString(), checkError: rel.error,
      updater: info && {
        ...info,
        // a instalação foi clonada de outro repositório (ex.: um fork): avisa na tela
        originMatches: !info.origin || info.origin.replace(/\.git$/, '').toLowerCase().includes(expectedOrigin.toLowerCase()),
      },
      status, backup, busy: currentOperation(),
    };
  });

  app.post('/api/system/updates/check', guard, async () => {
    const rel = await availableReleases(true);
    return { releases: rel.releases, checkedAt: new Date(rel.at).toISOString(), checkError: rel.error };
  });

  /** Passo 1: backup completo (banco + todos os anexos), também enviado ao destino remoto se houver. */
  app.post('/api/system/updates/backup', guard, async (req) => {
    if (currentOperation()) throw conflict(currentOperation() === 'restore' ? 'Há uma restauração em andamento' : currentOperation() === 'update' ? 'Há uma atualização em andamento' : 'Já existe um backup em andamento');
    runBackup('pre_update', { forceUploads: true })
      .then((r) => req.log.info({ backup: r.status, file: r.fileName }, 'backup antes de atualizar'))
      .catch((e) => req.log.error({ err: e }, 'backup antes de atualizar'));
    await audit(req, { action: 'system.update_backup', entityType: 'system', description: 'Iniciou o backup completo antes de atualizar' });
    return { started: true };
  });

  /** Passo 2: aplica a versão (só com um backup completo recente e a confirmação). */
  app.post('/api/system/updates/apply', guard, async (req) => {
    const body = parse(applySchema, req.body);
    const info = await updaterInfo();
    if (!info) throw badRequest('O serviço de atualização (updater) não está instalado ou não responde. Veja o guia de publicação.');
    if (!info.git) throw badRequest(info.error ?? 'A instalação não é um clone git do repositório.');
    if (info.dirty) throw badRequest('Há arquivos do projeto alterados no servidor (git status). Desfaça as alterações locais antes de atualizar.');
    const status = await updaterStatus();
    if (status?.state === 'running') throw conflict('Já existe uma atualização em andamento');

    let rel = await availableReleases();
    if (!rel.releases.some((r) => r.version === body.version)) rel = await availableReleases(true);
    const target = rel.releases.find((r) => r.version === body.version);
    if (!target) throw badRequest(`A versão ${body.version} não está entre as publicadas mais novas que a instalada (${APP_VERSION}).`);

    const backup = await latestPreUpdateBackup();
    if (!backup || backup.id !== body.backupRunId) throw badRequest('Faça o backup completo antes de atualizar.');
    if (!backup.usable) throw badRequest('O backup completo precisa ter terminado sem erro na última hora. Faça um novo backup.');

    try { acquireOperation('update'); } catch (e) { throw conflict((e as Error).message); }
    try {
      await startUpdate(body.version);
    } catch (e) {
      releaseOperation('update');
      throw badRequest(`O atualizador recusou: ${(e as Error).message}`);
    }
    holdUntilUpdaterIdle();
    await audit(req, {
      action: 'system.update', entityType: 'system',
      description: `Iniciou a atualização ${APP_VERSION} → ${body.version}`,
      details: { from: APP_VERSION, to: body.version, backup: backup.fileName, major: target.major },
    });
    return { started: true };
  });

  /** Acompanhamento (a tela consulta a cada poucos segundos; durante o reinício a API some por instantes). */
  app.get('/api/system/updates/status', guard, async () => ({ current: APP_VERSION, status: await updaterStatus() }));
}

