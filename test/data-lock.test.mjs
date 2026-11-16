import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createObservatory } from '../src/data.mjs';

const moduleURL = new URL('../src/data.mjs', import.meta.url).href;
const noNetwork = () => { throw new Error('Synthetic lock tests must not access the network'); };
async function fixture(t) {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'observatory-lock-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, dbPath: join(directory, 'synthetic.sqlite'), fetchImpl: noNetwork };
}
function writer(t, dbPath) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { createObservatory } from ${JSON.stringify(moduleURL)};
    // Model containers reusing PID 1 without touching any real container.
    Object.defineProperty(process, 'pid', { value: 1 });
    let service;
    process.on('message', async command => {
      if (command === 'close') { await service.close(); process.send({ status: 'closed' }); process.disconnect(); }
    });
    try {
      service = await createObservatory({ dbPath: process.argv[1], fetchImpl: () => { throw new Error('No network'); } });
      process.send({ status: 'ready' });
    } catch (error) {
      process.send({ status: 'error', code: error.code }); process.disconnect();
    }
  `, dbPath], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {} });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = once(child, 'exit');
  const ready = once(child, 'message', { signal: AbortSignal.timeout(10_000) }).then(([message]) => message);
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; });
  return { child, ready, exit, diagnostics: () => stderr };
}
async function gracefulClose(handle) {
  const message = once(handle.child, 'message', { signal: AbortSignal.timeout(10_000) });
  handle.child.send('close');
  assert.deepEqual((await message)[0], { status: 'closed' });
  assert.deepEqual(await handle.exit, [0, null], handle.diagnostics());
}

test('writer lock is kernel-held SQLite, keeps its inode, and supports graceful reopen', async t => {
  const options = await fixture(t);
  const service = await createObservatory(options);
  t.after(() => service.close());
  const lockPath = `${options.dbPath}.writer.sqlite`;
  const before = await stat(lockPath);
  assert.equal(before.mode & 0o777, 0o600);
  const probe = new DatabaseSync(lockPath);
  try {
    probe.exec('PRAGMA busy_timeout=0');
    assert.throws(() => probe.exec('BEGIN EXCLUSIVE'), /locked/);
  } finally { probe.close(); }
  await assert.rejects(createObservatory(options), { code: 'busy' });
  await service.close();
  assert.equal((await stat(lockPath)).ino, before.ino);
  const reopened = await createObservatory(options);
  try { assert.equal((await stat(lockPath)).ino, before.ino); }
  finally { await reopened.close(); }
  assert.equal((await readdir(options.directory)).some(name => /\.writer\.lock/.test(name)), false);
});

test('SIGKILL releases exclusivity on the same persistent volume without PID recovery', async t => {
  const options = await fixture(t);
  const first = writer(t, options.dbPath);
  assert.deepEqual(await first.ready, { status: 'ready' }, first.diagnostics());
  const rejected = writer(t, options.dbPath);
  assert.deepEqual(await rejected.ready, { status: 'error', code: 'busy' }, rejected.diagnostics());
  await rejected.exit;
  const seed = new DatabaseSync(options.dbPath);
  seed.exec("INSERT INTO state VALUES('synthetic-crash-marker', 'committed-before-kill')");
  seed.close();
  first.child.kill('SIGKILL');
  assert.deepEqual(await first.exit, [null, 'SIGKILL']);
  const restarted = writer(t, options.dbPath);
  assert.deepEqual(await restarted.ready, { status: 'ready' }, restarted.diagnostics());
  const persisted = new DatabaseSync(options.dbPath, { readOnly: true });
  try { assert.equal(persisted.prepare("SELECT value FROM state WHERE key='synthetic-crash-marker'").get().value, 'committed-before-kill'); }
  finally { persisted.close(); }
  const rejectedAgain = writer(t, options.dbPath);
  assert.deepEqual(await rejectedAgain.ready, { status: 'error', code: 'busy' });
  await rejectedAgain.exit;
  await gracefulClose(restarted);
  const reopened = writer(t, options.dbPath);
  assert.deepEqual(await reopened.ready, { status: 'ready' });
  await gracefulClose(reopened);
  assert.equal((await readdir(options.directory)).some(name => /\.writer\.lock/.test(name)), false);
});

test('close holds exclusivity until pending work drains and concurrent callers await release', async t => {
  const options = await fixture(t);
  const entered = Promise.withResolvers();
  const response = Promise.withResolvers();
  const service = await createObservatory({ ...options, token: 'synthetic-token', fetchImpl: () => { entered.resolve(); return response.promise; } });
  t.after(async () => { response.resolve(new Response('[]')); await service.close(); });
  const pending = service.discover();
  await entered.promise;
  const closing = service.close();
  const alsoClosing = service.close();
  let finished = false;
  alsoClosing.then(() => { finished = true; });
  const child = writer(t, options.dbPath);
  assert.deepEqual(await child.ready, { status: 'error', code: 'busy' });
  assert.equal(finished, false);
  await assert.rejects(createObservatory(options), { code: 'busy' });
  response.resolve(new Response('[]'));
  await Promise.all([pending, closing, alsoClosing]);
  const reopened = writer(t, options.dbPath);
  assert.deepEqual(await reopened.ready, { status: 'ready' });
  await gracefulClose(reopened);
});

test('late startup recovery failure releases both connections and ACTIVE membership', async t => {
  const options = await fixture(t);
  const service = await createObservatory(options);
  await service.close();
  const db = new DatabaseSync(options.dbPath);
  try {
    db.exec(`INSERT INTO repositories(id,owner,name,visibility,archived,branch,access)
      VALUES('synthetic', 'example', 'synthetic', 'public', 0, 'main', 'public');
      INSERT INTO runs VALUES('synthetic', 'metadata', 'collecting', '2026-01-01', NULL, 'synthetic');
      CREATE TRIGGER synthetic_recovery_failure BEFORE UPDATE ON runs
      BEGIN SELECT RAISE(ABORT, 'synthetic initialization failure'); END;`);
  } finally { db.close(); }
  await assert.rejects(createObservatory(options), { code: 'storage' });
  const repaired = new DatabaseSync(options.dbPath);
  repaired.exec('DROP TRIGGER synthetic_recovery_failure');
  repaired.close();
  const reopened = await createObservatory(options);
  await reopened.close();
  const child = writer(t, options.dbPath);
  assert.deepEqual(await child.ready, { status: 'ready' });
  await gracefulClose(child);
});

test('lock acquisition errors do not leak ownership or remove the sidecar', async t => {
  const options = await fixture(t);
  const lockPath = `${options.dbPath}.writer.sqlite`;
  await writeFile(lockPath, 'synthetic corrupt SQLite sidecar');
  const original = await stat(lockPath);
  await assert.rejects(createObservatory(options), { code: 'storage' });
  assert.equal((await stat(lockPath)).ino, original.ino);
  // Offline repair of this synthetic, unowned fixture only.
  await writeFile(lockPath, '');
  const service = await createObservatory(options);
  await service.close();
  assert.equal((await stat(lockPath)).ino, original.ino);
});

test('simultaneous subprocess starts elect exactly one writer', async t => {
  const options = await fixture(t);
  const candidates = Array.from({ length: 4 }, () => writer(t, options.dbPath));
  const results = await Promise.all(candidates.map(candidate => candidate.ready));
  assert.equal(results.filter(result => result.status === 'ready').length, 1);
  assert.equal(results.filter(result => result.status === 'error' && result.code === 'busy').length, 3);
  await gracefulClose(candidates[results.findIndex(result => result.status === 'ready')]);
});

test('legacy PID and malformed locks fail closed without modifying the original lock', async t => {
  const options = await fixture(t);
  for (const contents of [String(process.pid), '1', 'not-a-pid', '']) {
    await writeFile(`${options.dbPath}.writer.lock`, contents);
    await assert.rejects(createObservatory(options), { code: 'busy' });
    assert.equal(await readFile(`${options.dbPath}.writer.lock`, 'utf8'), contents);
  }
  await rm(`${options.dbPath}.writer.lock`);
  const service = await createObservatory(options);
  await service.close();
});

test('obsolete recovery files are not a new lifetime lock', async t => {
  const options = await fixture(t);
  await writeFile(`${options.dbPath}.writer.lock.recovery`, 'synthetic old crash artifact');
  const service = await createObservatory(options);
  await service.close();
  const reopened = await createObservatory(options);
  await reopened.close();
});

test('failed database initialization releases the lock and same-process ownership', async t => {
  const options = await fixture(t);
  await writeFile(options.dbPath, 'not a SQLite database');
  await assert.rejects(createObservatory(options), { code: 'storage' });
  await rm(options.dbPath);
  const service = await createObservatory(options);
  await service.close();
  const child = writer(t, options.dbPath);
  assert.deepEqual(await child.ready, { status: 'ready' });
  await gracefulClose(child);
});

test('canonical symlink aliases cannot bypass process or subprocess exclusivity', async t => {
  const options = await fixture(t);
  const service = await createObservatory(options);
  t.after(() => service.close());
  const alias = join(options.directory, 'alias.sqlite');
  await symlink(options.dbPath, alias);
  await assert.rejects(createObservatory({ ...options, dbPath: alias }), { code: 'busy' });
  const child = writer(t, alias);
  assert.deepEqual(await child.ready, { status: 'error', code: 'busy' });
});
