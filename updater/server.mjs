// NoPaper updater — aplica uma versão publicada (tag vX.Y.Z do GitHub) nesta instalação.
//
// Roda num container próprio (docker/updater.Dockerfile) com:
//   - a pasta do projeto montada em /project (é um clone git do repositório);
//   - o socket do Docker (para reconstruir e reiniciar os containers api e web).
// Só é acessível pela rede interna do compose e só aceita pedidos da API, autenticados com um
// token derivado do JWT_SECRET. Não tem dependências: só Node, git e docker compose.
//
// Fluxo de uma atualização: git fetch → confere a tag → git checkout → docker compose build
// → up -d api web → espera ficarem saudáveis. Se algo falhar, volta o código para a versão
// anterior e reconstrói. No fim o processo sai e o Docker o reinicia já com o código novo.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

const PORT = 8080;
const PROJECT = '/project';
const STATE_DIR = '/state';
const STATE_FILE = `${STATE_DIR}/status.json`;
const TAG_RE = /^v\d+\.\d+\.\d+$/;
const HEALTH_TIMEOUT_MS = 5 * 60_000;

const secret = process.env.JWT_SECRET ?? '';
if (secret.length < 32) { console.error('updater: JWT_SECRET ausente ou curto'); process.exit(1); }
const TOKEN = createHmac('sha256', secret).update('nopaper-updater').digest('hex');

// ------------------------------------------------------------------ estado
mkdirSync(STATE_DIR, { recursive: true });
let state = { state: 'idle', from: null, to: null, step: null, startedAt: null, finishedAt: null, error: null, log: [] };
try { state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) }; } catch { /* primeira vez */ }
if (state.state === 'running') { state.state = 'failed'; state.error = 'A atualização foi interrompida (o atualizador reiniciou no meio).'; state.finishedAt = new Date().toISOString(); }
const save = () => { try { writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) { console.error('updater: estado', e.message); } };
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const log = (line) => {
  const text = String(line).replace(ANSI, '').replace(/\r/g, '').replace(/\s+$/, '');
  if (!text) return;
  for (const l of text.split('\n')) state.log.push(`${new Date().toISOString().slice(11, 19)} ${l}`);
  if (state.log.length > 400) state.log = state.log.slice(-400);
  console.log(text);
  save();
};
const step = (s) => { state.step = s; log(`== ${s}`); };
save();

// ------------------------------------------------------------------ comandos (sem shell: argumentos fixos)
// git roda como o dono da pasta do projeto: os arquivos trocados no checkout continuam dele no
// servidor (como root, um `git pull` manual depois exigiria sudo).
const owner = (() => { try { const st = statSync(PROJECT); return { uid: st.uid, gid: st.gid }; } catch { return null; } })();

function run(cmd, args, { quiet = false, timeoutMs = 30 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const asOwner = cmd === 'git' && owner && process.getuid?.() === 0 && owner.uid !== 0;
    const p = spawn(cmd, args, {
      cwd: PROJECT,
      env: { ...process.env, DOCKER_BUILDKIT: '1', ...(asOwner ? { HOME: '/tmp' } : {}) },
      ...(asOwner ? { uid: owner.uid, gid: owner.gid } : {}),
    });
    let out = '';
    const onData = (d) => { out += d; if (!quiet) log(d.toString()); };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${cmd} demorou demais`)); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} ${args.slice(0, 3).join(' ')} falhou (código ${code})`)); });
  });
}
const git = (...a) => run('git', a, { quiet: true });

/** Nome do projeto compose desta instalação (rótulo do próprio container), padrão "nopaper". */
let projectName = 'nopaper';
run('docker', ['inspect', process.env.HOSTNAME ?? '', '--format', '{{index .Config.Labels "com.docker.compose.project"}}'], { quiet: true })
  .then((n) => { if (n) projectName = n; }).catch(() => null);
// sem -f: o compose usa o COMPOSE_FILE do .env (ex.: deploy/porta-direta.yml) ou o docker-compose.override.yml,
// exatamente como quando o administrador roda `docker compose` na pasta do projeto
const compose = (...a) => run('docker', ['compose', '--project-directory', PROJECT, '-p', projectName, ...a]);

/** Caminho no servidor (host) de uma pasta montada neste container. */
async function hostPathOf(dest) {
  return run('docker', ['inspect', process.env.HOSTNAME ?? '', '--format', `{{range .Mounts}}{{if eq .Destination "${dest}"}}{{.Source}}{{end}}{{end}}`], { quiet: true });
}

/**
 * A imagem do próprio atualizador mudou nesta versão: um container auxiliar (fora deste, que vai
 * ser substituído) reconstrói e recria o serviço updater, com a pasta no mesmo caminho do servidor.
 */
async function rebuildSelf() {
  const [host, sock] = await Promise.all([hostPathOf(PROJECT), hostPathOf('/var/run/docker.sock')]);
  if (!host || !sock) throw new Error('não consegui descobrir as pastas do servidor');
  await run('docker', ['run', '-d', '--rm', '-v', `${sock}:/var/run/docker.sock`, '-v', `${host}:${host}`, '-w', host,
    '--entrypoint', 'docker', 'nopaper-updater:latest', 'compose', '-p', projectName, 'up', '-d', '--no-deps', '--build', 'updater'], { quiet: true });
}

async function currentRef() {
  try { return await git('describe', '--tags', '--exact-match', 'HEAD'); } catch { return git('rev-parse', '--short', 'HEAD'); }
}

async function info() {
  try {
    const [ref, origin, dirty] = await Promise.all([
      currentRef(), git('remote', 'get-url', 'origin').catch(() => ''), git('status', '--porcelain', '--untracked-files=no'),
    ]);
    return { git: true, ref, origin, dirty: dirty.length > 0, project: projectName };
  } catch (e) {
    return { git: false, error: `A pasta do projeto não é um clone git utilizável: ${e.message}`, project: projectName };
  }
}

async function waitHealthy(services) {
  const until = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < until) {
    const out = await compose('ps', '--format', 'json', ...services).catch(() => '');
    const rows = out.split('\n').filter(Boolean).flatMap((l) => { try { const j = JSON.parse(l); return Array.isArray(j) ? j : [j]; } catch { return []; } });
    const health = services.map((s) => rows.find((r) => r.Service === s)?.Health ?? '');
    if (health.every((h) => h === 'healthy')) return;
    if (health.some((h) => h === 'unhealthy')) throw new Error(`serviço sem saúde: ${services.filter((_, i) => health[i] === 'unhealthy').join(', ')}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('os serviços não ficaram saudáveis em 5 minutos');
}

// ------------------------------------------------------------------ atualização
async function update(tag) {
  const prev = await currentRef();
  Object.assign(state, { state: 'running', from: prev, to: tag, step: null, startedAt: new Date().toISOString(), finishedAt: null, error: null, log: [] });
  save();
  let checkedOut = false;
  try {
    step('Baixando as versões publicadas');
    await run('git', ['fetch', '--tags', '--force', '--prune', 'origin']);
    await git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`).catch(() => { throw new Error(`a versão ${tag} não existe no repositório`); });
    if ((await git('status', '--porcelain', '--untracked-files=no')).length) {
      throw new Error('há arquivos do projeto alterados nesta instalação (git status): desfaça as alterações locais antes de atualizar');
    }
    step(`Trocando o código de ${prev} para ${tag}`);
    await run('git', ['-c', 'advice.detachedHead=false', 'checkout', '--detach', tag]);
    checkedOut = true;
    step('Construindo as imagens novas (pode levar alguns minutos)');
    await compose('build', 'api', 'web').catch(() => { throw new Error('a construção das imagens da versão nova falhou (detalhes no registro)'); });
    step('Reiniciando a API e a interface');
    await compose('up', '-d', '--no-deps', 'api', 'web').catch(() => { throw new Error('não foi possível reiniciar os containers (detalhes no registro)'); });
    step('Aguardando o sistema responder');
    await waitHealthy(['api', 'web']);
    Object.assign(state, { state: 'done', step: 'Concluído', finishedAt: new Date().toISOString() });
    log(`Atualizado para ${tag}.`);
    const selfChanged = await git('diff', '--name-only', prev, tag, '--', 'docker/updater.Dockerfile').catch(() => '');
    if (selfChanged) {
      log('A imagem do atualizador mudou nesta versão: ele vai se reconstruir em segundo plano.');
      await rebuildSelf().catch((e) => log(`Aviso: o atualizador não se reconstruiu (${e.message}). Rode: docker compose up -d --build updater`));
      return;
    }
    // reinicia o próprio atualizador com o código novo (o Docker o sobe de novo: restart: unless-stopped)
    setTimeout(() => process.exit(0), 1500);
  } catch (e) {
    log(`ERRO: ${e.message}`);
    state.error = e.message;
    if (checkedOut) {
      try {
        step(`Voltando para ${prev}`);
        await run('git', ['-c', 'advice.detachedHead=false', 'checkout', '--detach', prev]);
        await compose('build', 'api', 'web');
        await compose('up', '-d', '--no-deps', 'api', 'web');
        await waitHealthy(['api', 'web']);
        log(`O sistema voltou para ${prev}.`);
        state.error += ` — o sistema voltou para ${prev}. Se a versão nova chegou a alterar o banco, restaure o backup feito antes da atualização.`;
      } catch (e2) {
        log(`ERRO ao voltar: ${e2.message}`);
        state.error += ` — e não foi possível voltar sozinho (${e2.message}). Siga "Voltar para a versão anterior" no guia de publicação.`;
      }
    }
    Object.assign(state, { state: 'failed', finishedAt: new Date().toISOString() });
    save();
  }
}

// ------------------------------------------------------------------ HTTP
const authorized = (req) => {
  const h = req.headers.authorization ?? '';
  const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
};
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

createServer(async (req, res) => {
  try {
    if (req.url === '/health') return send(res, 200, { ok: true });
    if (!authorized(req)) return send(res, 401, { error: 'não autorizado' });
    if (req.method === 'GET' && req.url === '/status') return send(res, 200, state);
    if (req.method === 'GET' && req.url === '/info') return send(res, 200, await info());
    if (req.method === 'POST' && req.url === '/update') {
      let raw = '';
      for await (const c of req) { raw += c; if (raw.length > 1024) break; }
      const tag = (() => { try { return JSON.parse(raw).version; } catch { return null; } })();
      if (typeof tag !== 'string' || !TAG_RE.test(tag)) return send(res, 400, { error: 'versão inválida' });
      if (state.state === 'running') return send(res, 409, { error: 'já existe uma atualização em andamento' });
      void update(tag);
      return send(res, 202, { started: true });
    }
    send(res, 404, { error: 'não encontrado' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}).listen(PORT, '0.0.0.0', () => console.log(`updater ouvindo na porta ${PORT} (projeto ${projectName})`));
