import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa de pelo menos 32 caracteres'),
  /** URL pública do app (links em e-mails/Telegram). */
  APP_URL: z.string().url().default('http://localhost:5173'),
  /**
   * Administrador inicial: criado no primeiro boot, só se o banco ainda não tiver usuários.
   * A senha é provisória — o sistema exige a troca no primeiro login. Depois disso estas
   * variáveis não são mais lidas (pode removê-las do .env).
   */
  ADMIN_EMAIL: z.preprocess((v) => (v === '' ? undefined : v), z.string().email().optional()),
  ADMIN_USERNAME: z.preprocess((v) => (v === '' ? undefined : v), z.string().default('admin')),
  ADMIN_NAME: z.preprocess((v) => (v === '' ? undefined : v), z.string().default('Administrador')),
  ADMIN_PASSWORD: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8, 'ADMIN_PASSWORD precisa de pelo menos 8 caracteres').optional()),
  ADMIN_ORG_NAME: z.preprocess((v) => (v === '' ? undefined : v), z.string().default('Principal')),
  STORAGE_DIR: z.string().default('./data/uploads'),
  BACKUP_DIR: z.string().default('./data/backups'),
  MAX_UPLOAD_MB: z.coerce.number().default(15),
  /** Limite por arquivo no envio do espaço para o contador (ZIP de notas fiscais costuma ser grande). */
  ACCOUNTING_MAX_UPLOAD_MB: z.coerce.number().default(200),
  TZ_DEFAULT: z.string().default('America/Sao_Paulo'),
  LOG_LEVEL: z.string().default('info'),
  /** Chave para cifrar segredos guardados no banco (opcional; padrão: derivada do JWT_SECRET). */
  SECRETS_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(32, 'SECRETS_KEY precisa de pelo menos 32 caracteres').optional()),
  /** Binários usados pelo backup (no Docker já vêm instalados). */
  /** Atualização pela interface: repositório das releases (dono/nome no GitHub) e endereço do serviço updater. */
  UPDATE_REPO: z.string().regex(/^[\w.-]+\/[\w.-]+$/).default('wegnix/nopaper'),
  UPDATER_URL: z.string().url().default('http://updater:8080'),
  PG_DUMP_BIN: z.string().default('pg_dump'),
  RCLONE_BIN: z.string().default('rclone'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Variáveis de ambiente inválidas:', z.prettifyError(parsed.error));
  process.exit(1);
}
export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
