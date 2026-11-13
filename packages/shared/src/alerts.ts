import { z } from 'zod';

// ------------------------------------------------------------------ alertas (por espaço)
const typeRule = z.object({
  enabled: z.boolean().default(true),
  /** Dias de antecedência: 0 = no dia do vencimento. */
  daysBefore: z.array(z.number().int().min(0).max(30)).max(6).default([3, 0]),
  /** Lembrar contas vencidas e ainda abertas. */
  overdue: z.boolean().default(true),
  /**
   * `days` = só nos dias de antecedência marcados em `daysBefore`; `window` = tudo o que vence hoje
   * e nos próximos `windowDays` dias, todo dia, até a conta ser baixada.
   */
  mode: z.enum(['days', 'window']).default('days'),
  windowDays: z.number().int().min(1).max(30).default(7),
  /** Só estas categorias entram no resumo (vazio = todas). */
  categoryIds: z.array(z.string().uuid()).max(200).default([]),
});
export type AlertTypeRule = z.infer<typeof typeRule>;
/** Passo dos minutos do horário de envio (o verificador roda de 5 em 5 minutos). */
export const ALERT_MINUTE_STEP = 5;
export const ALERT_DAY_OPTIONS = [0, 1, 2, 3, 5, 7, 10, 15] as const;

export const alertConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Hora local (fuso do espaço) do envio diário. */
  hour: z.number().int().min(0).max(23).default(8),
  minute: z.number().int().min(0).max(59).default(0),
  // padrões completos: `.default()` devolve o valor como está, sem passar pelos padrões de dentro
  payable: typeRule.default({ enabled: true, daysBefore: [3, 0], overdue: true, mode: 'days', windowDays: 7, categoryIds: [] }),
  receivable: typeRule.default({ enabled: false, daysBefore: [0], overdue: true, mode: 'days', windowDays: 7, categoryIds: [] }),
  /** Incluir contas de categorias restritas (os destinatários podem não ser administradores). */
  includeRestricted: z.boolean().default(false),
  /** Avisar na hora quando o contador enviar documentos (área do contador). */
  accounting: z.boolean().default(true),
  telegram: z.object({
    enabled: z.boolean().default(false),
    chats: z.array(z.object({ id: z.string().max(32), name: z.string().max(120) })).max(10).default([]),
  }).default({ enabled: false, chats: [] }),
  email: z.object({
    enabled: z.boolean().default(false),
    recipients: z.array(z.string().trim().toLowerCase().email('E-mail inválido')).max(10).default([]),
  }).default({ enabled: false, recipients: [] }),
});
export type AlertConfig = z.infer<typeof alertConfigSchema>;

// ------------------------------------------------------------------ sistema (superadmin)
/** Segredos: na leitura vêm só como `hasX`; na gravação, string vazia/undefined = manter o atual, null = apagar. */
const secret = z.string().max(20000).nullish();

/** Segurança da plataforma: minutos sem interação até o logoff automático. */
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 60;
export const securitySettingsSchema = z.object({
  idleTimeoutMinutes: z.number().int().min(5, 'Mínimo de 5 minutos').max(1440, 'Máximo de 24 horas (1440 minutos)'),
});
export type SecuritySettings = z.infer<typeof securitySettingsSchema>;

export const smtpSchema = z.object({
  host: z.string().trim().max(200).default(''),
  port: z.number().int().min(1).max(65535).default(587),
  /** true = TLS direto (465); false = STARTTLS quando disponível. */
  secure: z.boolean().default(false),
  user: z.string().trim().max(200).default(''),
  password: secret,
  from: z.string().trim().max(200).default(''),
});
export const telegramBotSchema = z.object({ token: secret });

export const BACKUP_REMOTE_MODES = ['none', 'sftp', 'rclone'] as const;
export const backupConfigSchema = z.object({
  enabled: z.boolean().default(false),
  hour: z.number().int().min(0).max(23).default(3),
  keepLocal: z.number().int().min(1).max(90).default(7),
  includeUploads: z.boolean().default(true),
  remote: z.object({
    mode: z.enum(BACKUP_REMOTE_MODES).default('none'),
    sftp: z.object({
      host: z.string().trim().max(200).default(''),
      port: z.number().int().min(1).max(65535).default(22),
      user: z.string().trim().max(100).default(''),
      path: z.string().trim().max(300).default('backups/nopaper'),
      password: secret,
      privateKey: secret,
    }).default({ host: '', port: 22, user: '', path: 'backups/nopaper' }),
    /** Conteúdo de um rclone.conf (modo avançado: Drive, S3, B2, Dropbox…). */
    rcloneConfig: secret,
    /** Destino no formato remoto:caminho, ex.: gdrive:Backups/nopaper */
    rcloneTarget: z.string().trim().max(300).default(''),
    /** Apagar do destino backups com mais de N dias (0 = nunca). */
    keepDays: z.number().int().min(0).max(3650).default(30),
  }).default({ mode: 'none', sftp: { host: '', port: 22, user: '', path: 'backups/nopaper' }, rcloneTarget: '', keepDays: 30 }),
});
export type BackupConfig = z.infer<typeof backupConfigSchema>;

export const systemSettingsSchema = z.object({
  smtp: smtpSchema.optional(),
  telegram: telegramBotSchema.optional(),
  backup: backupConfigSchema.optional(),
});
