import { readFileSync } from 'node:fs';

/**
 * Versão do sistema (SemVer), lida do package.json da API — todos os package.json do monorepo
 * têm sempre o mesmo número.
 * Funciona no dev (src/lib) e na imagem de produção (dist/lib): ambos ficam a 2 níveis de apps/api.
 */
export const APP_VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
