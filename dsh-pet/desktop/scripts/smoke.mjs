import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PLUGIN_ROOT = resolve(DESKTOP_ROOT, '..');
const unpacked = join(DESKTOP_ROOT, 'dist', 'win-unpacked', 'dsh-pet-desktop.exe');
const electron = join(DESKTOP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const executable = existsSync(unpacked) ? unpacked : electron;
const executableArgs = executable === unpacked ? [] : [DESKTOP_ROOT];
const stripJsonc = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1')
    .trim();
const config = JSON.parse(stripJsonc(readFileSync(join(PLUGIN_ROOT, 'assets', 'config.jsonc'), 'utf8')));
config.desktopEnabled = true;
config.pets = [{ ...config.pets[0], size: 240 }];
let stopRequested = false;
let ready = false;
let resolveReady;
let rejectReady;
const readyPromise = new Promise((resolvePromise, rejectPromise) => {
  resolveReady = resolvePromise;
  rejectReady = rejectPromise;
});
const token = 'desktop-smoke-token-' + '0'.repeat(32);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const json = (value) => {
    const body = JSON.stringify(value);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  if (url.pathname === '/dsh-pet-7340/desktop/snapshot') {
    if (req.headers.authorization !== 'Bearer ' + token) {
      res.writeHead(401).end();
      return;
    }
    json({ config: { ...config, desktopEnabled: !stopRequested }, sessionId: null });
    return;
  }
  if (url.pathname === '/dsh-pet-7340/desktop/ready') {
    if (req.method !== 'POST' || req.headers.authorization !== 'Bearer ' + token) {
      res.writeHead(401).end();
      return;
    }
    ready = true;
    stopRequested = true;
    resolveReady();
    res.writeHead(204).end();
    return;
  }
  if (url.pathname.startsWith('/dsh-pet-7340/thumb/')) {
    const name = basename(decodeURIComponent(url.pathname));
    const file = join(PLUGIN_ROOT, 'assets', 'webm', name);
    res.writeHead(200, { 'content-type': 'video/webm' });
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
    return;
  }
  json({ count: 0, amount: 0, currency: 'CNY', at: 0 });
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('mock Host failed to listen');

const child = spawn(executable, executableArgs, {
  cwd: DESKTOP_ROOT,
  windowsHide: true,
  env: {
    ...process.env,
    DSH_PET_HOST_ORIGIN: 'http://127.0.0.1:' + address.port,
    DSH_PET_DESKTOP_TOKEN: token,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const timeout = setTimeout(() => {
  child.kill();
  rejectReady(new Error('timeout waiting for renderer'));
}, 30_000);
child.stdout.on('data', (chunk) => {
  const text = String(chunk);
  process.stdout.write(text);
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
child.once('error', (error) => rejectReady(error));
child.once('exit', (code) => {
  if (!ready) rejectReady(new Error('desktop exited before ready, code=' + code));
});
await readyPromise;
clearTimeout(timeout);
// ready 后 mock Host 返回 desktopEnabled=false，等待 Electron 下一轮快照自行干净退出。
await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_500));
if (!child.killed) child.kill();
await new Promise((resolveClose) => server.close(resolveClose));
console.log('[desktop-smoke] passed');
