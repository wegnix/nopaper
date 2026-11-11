import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { backupConfigSchema, securitySettingsSchema, smtpSchema, telegramBotSchema } from '@nopaper/shared';
import { parse } from '../lib/validate.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { requireAuth, requireSuperadmin } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { nextSecret } from '../lib/secrets.js';
import { getSystemSetting, setSystemSetting } from '../lib/settings.js';
import { invalidateSecuritySettings, securitySettings } from '../lib/security.js';
import { sendEmail, telegramGetMe, type StoredSmtp, type StoredTelegram } from '../services/notify.js';
import {
  acquireOperation, currentOperation, listLocalBackups, listRemoteBackups, loadBackupConfig, localBackupPath, recentRuns, releaseOperation,
  runBackup, saveBackupConfig, testRemote,
} from '../services/backup.js';
import { restoreStatus, saveUploadedBackup, startRestore } from '../services/restore.js';

const busyMsg = () => (currentOperation() === 'restore' ? 'Há uma restauração em andamento' : 'Já existe um backup em andamento');

export default async function systemRoutes(app: FastifyInstance) {
  const guard = { preHandler: [requireAuth, requireSuperadmin] };

  app.get('/api/system/settings', guard, async () => {
    const smtp = await getSystemSetting<StoredSmtp>('smtp');
    const tg = await getSystemSetting<StoredTelegram>('telegram');
    const b = await loadBackupConfig();
    return {
      smtp: { host: smtp?.host ?? '', port: smtp?.port ?? 587, secure: smtp?.secure ?? false, user: smtp?.user ?? '', from: smtp?.from ?? '', hasPassword: !!smtp?.passwordEnc },
      telegram: { hasToken: !!tg?.tokenEnc, botUsername: tg?.botUsername ?? null },
      backup: {
        enabled: b.enabled, hour: b.hour, keepLocal: b.keepLocal, includeUploads: b.includeUploads, lastRunOn: b.lastRunOn ?? null,
        remote: {
          mode: b.remote.mode, rcloneTarget: b.remote.rcloneTarget, keepDays: b.remote.keepDays, hasRcloneConfig: !!b.remote.rcloneConfigEnc,
          sftp: { host: b.remote.sftp.host, port: b.remote.sftp.port, user: b.remote.sftp.user, path: b.remote.sftp.path, hasPassword: !!b.remote.sftp.passwordEnc, hasPrivateKey: !!b.remote.sftp.privateKeyEnc },
        },
      },
    };
  });

  // ---------------------------------------------------------------- segurança
  app.get('/api/system/security', guard, async () => securitySettings());
  app.put('/api/system/security', guard, async (req) => {
    const body = parse(securitySettingsSchema, req.body);
    const cur = await securitySettings();
    await setSystemSetting('security', body);
    invalidateSecuritySettings();
    await audit(req, {
      action: 'system.security', entityType: 'system',
      description: `Logoff por inatividade: ${body.idleTimeoutMinutes} min`,
      details: { changes: { idleTimeoutMinutes: { from: cur.idleTimeoutMinutes, to: body.idleTimeoutMinutes } } },
    });
    return body;
  });

  // ---------------------------------------------------------------- SMTP
  app.put('/api/system/smtp', guard, async (req) => {
    const body = parse(smtpSchema, req.body);
    const cur = await getSystemSetting<StoredSmtp>('smtp');
    await setSystemSetting('smtp', {
      host: body.host, port: body.port, secure: body.secure, user: body.user, from: body.from,
      passwordEnc: nextSecret(body.password, cur?.passwordEnc),
    } satisfies StoredSmtp);
    await audit(req, { action: 'system.smtp', entityType: 'system', description: `Configurou o SMTP (${body.host || 'desligado'})` });
    return { ok: true };
  });
  app.post<{ Body: { to?: string } }>('/api/system/smtp/test', guard, async (req) => {
    const to = (req.body?.to || req.user!.email).trim();
    if (!/^\S+@\S+\.\S+$/.test(to)) throw badRequest('E-mail inválido');
    try {
      await sendEmail([to], 'NoPaper · teste de e-mail', '<p>Se você recebeu esta mensagem, o envio de e-mails do NoPaper está funcionando.</p>', 'Se você recebeu esta mensagem, o envio de e-mails do NoPaper está funcionando.');
    } catch (e) { throw badRequest(`Falha ao enviar: ${(e as Error).message}`); }
    return { ok: true, to };
  });

  // ---------------------------------------------------------------- Telegram
  app.put('/api/system/telegram', guard, async (req) => {
    const body = parse(telegramBotSchema, req.body);
    const cur = await getSystemSetting<StoredTelegram>('telegram');
    const tokenEnc = nextSecret(body.token, cur?.tokenEnc);
    let botUsername = cur?.botUsername ?? null;
    if (!tokenEnc) botUsername = null;
    else if (body.token) {
      try { botUsername = (await telegramGetMe(body.token)).username; } catch (e) { throw badRequest(`Token recusado pelo Telegram: ${(e as Error).message}`); }
    }
    await setSystemSetting('telegram', { tokenEnc, botUsername } satisfies StoredTelegram);
    await audit(req, { action: 'system.telegram', entityType: 'system', description: botUsername ? `Configurou o bot @${botUsername}` : 'Removeu o bot do Telegram' });
    return { ok: true, botUsername };
  });

  // ---------------------------------------------------------------- backup
  app.put('/api/system/backup', guard, async (req) => {
    const body = parse(backupConfigSchema, req.body);
    const cur = await loadBackupConfig();
    const r = body.remote;
    await saveBackupConfig({
      enabled: body.enabled, hour: body.hour, keepLocal: body.keepLocal, includeUploads: body.includeUploads,
      lastRunOn: body.hour !== cur.hour ? null : cur.lastRunOn ?? null,
      remote: {
        mode: r.mode, rcloneTarget: r.rcloneTarget, keepDays: r.keepDays,
        rcloneConfigEnc: nextSecret(r.rcloneConfig, cur.remote.rcloneConfigEnc),
        sftp: {
          host: r.sftp.host, port: r.sftp.port, user: r.sftp.user, path: r.sftp.path,
          passwordEnc: nextSecret(r.sftp.password, cur.remote.sftp.passwordEnc),
          privateKeyEnc: nextSecret(r.sftp.privateKey, cur.remote.sftp.privateKeyEnc),
        },
      },
    });
    await audit(req, { action: 'system.backup', entityType: 'system', description: `Configurou backups (${body.enabled ? `diário às ${body.hour}h` : 'desligado'}, destino ${r.mode})` });
    return { ok: true };
  });

  app.post('/api/system/backup/test-remote', guard, async () => {
    try { return await testRemote(await loadBackupConfig()); } catch (e) { throw badRequest(`Falha no destino: ${(e as Error).message}`); }
  });

  app.post('/api/system/backup/run', guard, async (req) => {
    if (currentOperation()) throw conflict(busyMsg());
    // roda em segundo plano; a tela acompanha pela lista de execuções
    runBackup('manual').then((r) => req.log.info({ backup: r.status, file: r.fileName }, 'backup manual')).catch((e) => req.log.error({ err: e }, 'backup manual'));
    await audit(req, { action: 'system.backup_run', entityType: 'system', description: 'Iniciou um backup manual' });
    return { started: true };
  });

  app.get('/api/system/backups', guard, async () => {
    // safetyFiles: backups feitos automaticamente antes de uma restauração (etiqueta na lista)
    // origem de cada arquivo (agendado / manual / antes de restaurar); sem registro = enviado do computador
    const origin = await db.select({ f: schema.backupRuns.fileName, trigger: schema.backupRuns.trigger }).from(schema.backupRuns)
      .where(and(eq(schema.backupRuns.status, 'ok'), isNotNull(schema.backupRuns.fileName)));
    const byFile = new Map(origin.map((r) => [r.f!, r.trigger]));
    const files = (await listLocalBackups()).map((f) => ({ ...f, trigger: byFile.get(f.name) ?? null }));
    return { files, runs: await recentRuns(), safetyFiles: origin.filter((r) => r.trigger === 'pre_restore').map((r) => r.f!), busy: currentOperation() };
  });

  /** Histórico completo de execuções, paginado (mais recente primeiro). */
  app.get<{ Querystring: { before?: string; status?: string; trigger?: string } }>('/api/system/backup-runs', guard, async (req) => {
    const t = schema.backupRuns;
    const conds = [];
    if (req.query.before && !Number.isNaN(Date.parse(req.query.before))) conds.push(lt(t.startedAt, new Date(req.query.before)));
    if (req.query.status === 'ok' || req.query.status === 'error' || req.query.status === 'running') conds.push(eq(t.status, req.query.status));
    if (req.query.trigger === 'schedule' || req.query.trigger === 'manual' || req.query.trigger === 'pre_restore' || req.query.trigger === 'pre_update') conds.push(eq(t.trigger, req.query.trigger));
    const rows = await db.select().from(t).where(conds.length ? and(...conds) : undefined).orderBy(desc(t.startedAt)).limit(50);
    const [{ total, failed }] = await db.select({ total: sql<number>`count(*)::int`, failed: sql<number>`count(*) filter (where ${t.status} = 'error' or ${t.remoteStatus} = 'error')::int` }).from(t);
    return { items: rows, nextBefore: rows.length === 50 ? rows.at(-1)!.startedAt.toISOString() : null, total, failed };
  });

  app.get('/api/system/backups-remote', guard, async () => {
    try { return { files: await listRemoteBackups() }; } catch (e) { throw badRequest(`Falha ao listar o destino remoto: ${(e as Error).message}`); }
  });

  app.get<{ Params: { name: string } }>('/api/system/backups/:name', guard, async (req, reply) => {
    const p = localBackupPath(req.params.name);
    if (!p) throw notFound();
    const st = await stat(p).catch(() => null);
    if (!st) throw notFound('Arquivo não encontrado');
    await audit(req, { action: 'system.backup_download', entityType: 'system', description: `Baixou o backup ${req.params.name}` });
    reply.header('content-type', 'application/gzip').header('content-length', st.size)
      .header('content-disposition', `attachment; filename="${req.params.name}"`).header('cache-control', 'no-store');
    return reply.send(createReadStream(p));
  });

  app.delete<{ Params: { name: string } }>('/api/system/backups/:name', guard, async (req) => {
    const p = localBackupPath(req.params.name);
    if (!p) throw notFound();
    if (currentOperation() === 'restore') throw conflict('Há uma restauração em andamento');
    await rm(p, { force: true });
    await audit(req, { action: 'system.backup_delete', entityType: 'system', description: `Apagou o backup ${req.params.name}` });
    return { ok: true };
  });

  // ---------------------------------------------------------------- restauração
  /** Público e sem banco: a tela acompanha por aqui durante a manutenção (ninguém está logado). */
  app.get('/api/system/restore/status', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const s = restoreStatus();
    // o texto cru do erro (saída do pg_restore/rclone) só para o administrador da plataforma
    if ('error' in s && s.error && !req.user?.isSuperadmin) return { ...s, error: 'A restauração falhou e o sistema voltou ao estado anterior. O administrador da plataforma vê os detalhes.' };
    return s;
  });

  app.post<{ Body: { source?: string; name?: string } }>('/api/system/restore', guard, async (req, reply) => {
    const source = req.body?.source === 'remote' ? 'remote' : 'local';
    const name = String(req.body?.name ?? '');
    if (currentOperation()) throw conflict(busyMsg());
    await audit(req, { action: 'system.restore_start', entityType: 'system', description: `Iniciou a restauração do backup ${name} (${source === 'remote' ? 'destino remoto' : 'servidor'})` });
    try {
      const st = await startRestore({ source, name }, { id: req.user!.id, name: req.user!.name }, app.log);
      return reply.code(202).send(st);
    } catch (e) { throw badRequest((e as Error).message); }
  });

  /** Envio de um backup do computador (ex.: servidor novo). Fica na lista de arquivos do servidor. */
  app.post('/api/system/restore/upload', guard, async (req) => {
    if (currentOperation() === 'restore') throw conflict('Há uma restauração em andamento');
    const file = await req.file({ limits: { fileSize: 50 * 1024 ** 3, files: 1 } });
    if (!file) throw badRequest('Envie o arquivo .tar.gz do backup');
    // a trava evita que a retenção ou uma restauração mexam na pasta enquanto o arquivo chega
    try { acquireOperation('backup'); } catch (e) { file.file.resume(); throw conflict((e as Error).message); }
    try {
      const r = await saveUploadedBackup(file.file);
      await audit(req, { action: 'system.backup_upload', entityType: 'system', description: `Enviou o backup ${r.name}` });
      return r;
    } catch (e) {
      throw badRequest((e as Error).message);
    } finally { releaseOperation('backup'); }
  });
}
