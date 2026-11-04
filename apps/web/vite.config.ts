import { defineConfig, defaultClientConditions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/** Versão do sistema (SemVer) embutida no front — a mesma de todos os package.json. */
const version = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')).version as string;

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
    // dev: @nopaper/shared direto do src (sem compilar); build usa o dist
    conditions: command === 'serve' ? ['nopaper-source', ...defaultClientConditions] : [...defaultClientConditions],
  },
  server: {
    host: process.env.VITE_HOST ?? '127.0.0.1',
    port: 5173,
    proxy: { '/api': { target: process.env.API_URL ?? 'http://localhost:3000', changeOrigin: false } },
  },
  build: { sourcemap: false, chunkSizeWarningLimit: 900 },
}));
