import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer as httpServer, request } from 'node:http';
import { createServer, validateHomeConfiguration } from '../src/server.mjs';

const origin = 'https://observatory.example.test';
const proxyKey = 'synthetic_proxy_secret_12345678901234567890';
const homeToken = 'synthetic_home_secret_123456789012345678901';
const main = fileURLToPath(new URL('../src/main.mjs', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'observatory-home-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeFile = join(root, 'home-secret'), proxyFile = join(root, 'proxy-secret');
  await writeFile(homeFile, homeToken + '\n', { mode: 0o600 });
  await writeFile(proxyFile, proxyKey + '\n', { mode: 0o600 });
  const env = { ...process.env, OBSERVATORY_BIND_HOST: '127.0.0.1', OBSERVATORY_PUBLIC_ORIGIN: origin, OBSERVATORY_PROXY_KEY_FILE: proxyFile, OBSERVATORY_HOME_TOKEN_FILE: homeFile, OBSERVATORY_DATA_DIR: join(root, 'state') };
  delete env.GITHUB_TOKEN_FILE;
  return { root, env, homeFile };
}

test('home token configuration is optional, strong, distinct and requires the configured public origin', () => {
  assert.equal(validateHomeConfiguration(), null);
  assert.equal(validateHomeConfiguration({ publicOrigin: origin, proxyKey, homeToken }).origin, origin);
  for (const config of [{ homeToken }, { publicOrigin: origin, proxyKey, homeToken: '' }, { publicOrigin: origin, proxyKey, homeToken: 'short' }, { publicOrigin: origin, proxyKey, homeToken: proxyKey }, { publicOrigin: origin, proxyKey, homeToken: 'x'.repeat(129) }, { publicOrigin: origin, proxyKey, homeToken: 'x'.repeat(32) + '\n' }]) assert.throws(() => validateHomeConfiguration(config));
  assert.throws(() => createServer({ publicDir: '.', service: {}, unlockKey: homeToken, publicOrigin: origin, proxyKey, homeToken }), /differ/);
});

test('bad integration file/config fails startup before creating runtime state', async t => {
  for (const kind of ['weak', 'permissions', 'symlink', 'absent', 'shared']) {
    const f = await fixture(t);
    if (kind === 'weak') await writeFile(f.homeFile, 'short');
    if (kind === 'permissions') await chmod(f.homeFile, 0o644);
    if (kind === 'symlink') { const link = join(f.root, 'alias'); await symlink(f.homeFile, link); f.env.OBSERVATORY_HOME_TOKEN_FILE = link; }
    if (kind === 'absent') f.env.OBSERVATORY_HOME_TOKEN_FILE = join(f.root, 'missing');
    if (kind === 'shared') f.env.OBSERVATORY_HOME_TOKEN_FILE = f.env.OBSERVATORY_PROXY_KEY_FILE;
    const result = spawnSync(process.execPath, [main], { env: f.env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1, kind);
    assert.ok(!result.stderr.includes(homeToken)); assert.ok(!result.stderr.includes(proxyKey));
    await assert.rejects(stat(f.env.OBSERVATORY_DATA_DIR));
  }
});

test('main loads dedicated file-backed token and serves only preview over direct transport', async t => {
  const f = await fixture(t);
  const reservation = httpServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [main], { env: { ...f.env, OBSERVATORY_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Startup timed out')); }, 10000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', () => { clearTimeout(timeout); reject(new Error('Startup exited before readiness')); });
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('listening behind')) { clearTimeout(timeout); resolve(); } });
  });
  function call(path, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, headers: { Host: new URL(origin).host, ...headers } }, res => {
        let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      }); req.on('error', reject); req.end();
    });
  }
  const auth = { Authorization: `Bearer ${homeToken}` };
  const preview = await call('/api/home-preview', auth);
  assert.equal(preview.status, 200); assert.equal(preview.body.schemaVersion, 1);
  assert.equal(preview.body.summary.repositories, 0);
  assert.deepEqual(preview.body.summary.metrics.map(m => m.value), [null, null, null]);
  assert.equal(preview.body.notifications.unreadCount, null);
  assert.equal((await call('/api/home-preview')).status, 403);
  assert.equal((await call('/api/dashboard', auth)).status, 403);
  assert.ok(!output.includes(homeToken)); assert.ok(!errors.includes(homeToken));
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
});
