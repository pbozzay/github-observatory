import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createObservatory } from '../src/data.mjs';
import { createServer } from '../src/server.mjs';

const NOW = '2026-06-20T12:00:00.000Z';
const metadata = { id: 101, owner: { login: 'example' }, name: 'sample', private: false, archived: false, default_branch: 'main', stargazers_count: 0, forks_count: 2 };
const keys = ['commits', 'stars', 'forks', 'merged_prs', 'releases', 'issues', 'views', 'clones', 'star_activity'];
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'availability-test-'));
  const state = { metadata: { ...metadata }, endpoints: {}, now: NOW };
  const calls = [];
  const config = { dbPath: join(dir, 'test.sqlite'), token: 'synthetic-test-token', now: () => new Date(state.now), fetchImpl: async (input, init) => {
    const endpoint = new URL(input).pathname.split('/').slice(4).join('/');
    calls.push({ endpoint, init });
    const value = !endpoint ? state.metadata : state.endpoints[endpoint] ?? (endpoint === 'traffic/views' ? { views: [] } : endpoint === 'traffic/clones' ? { clones: [] } : []);
    return value instanceof Function ? value() : Response.json(value);
  } };
  const service = await createObservatory(config);
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  await service.addWatch({ repository: 'example/sample', access: 'public' });
  return { service, state, calls, config };
}
const availability = (service, metric) => service.dashboard('7').repos[0].metricAvailability[metric];

test('verified disabled issues persist across restarts and omitted metadata without fabricating zero observations', async t => {
  const { service, state, calls, config } = await fixture(t);
  state.metadata.has_issues = false;
  await service.sync();
  assert.deepEqual(availability(service, 'issues'), { state: 'disabled', label: 'Disabled on repo' });
  assert.equal(service.dashboard().repos[0].metrics.issues, undefined);
  assert.equal(calls.filter(call => call.endpoint === 'issues').length, 0);
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  assert.equal(db.prepare('SELECT has_issues FROM repositories').get().has_issues, 0);
  db.close();
  await service.close();
  const restarted = await createObservatory(config);
  t.after(() => restarted.close());
  assert.deepEqual(availability(restarted, 'issues'), { state: 'disabled', label: 'Disabled on repo' });
  delete state.metadata.has_issues;
  await restarted.sync();
  assert.equal(availability(restarted, 'issues').state, 'disabled');
  assert.equal(calls.filter(call => call.endpoint === 'issues').length, 0);
  state.metadata.has_issues = true;
  await restarted.sync();
  assert.equal(availability(restarted, 'issues').state, 'available');
  assert.equal(restarted.dashboard().repos[0].metrics.issues.value, 0);
  assert.ok(calls.every(call => !Object.hasOwn(call.init.headers, 'Authorization')));
});

test('only a boolean false capability can disable issues; legacy or malformed metadata remains unknown', async t => {
  for (const value of [undefined, null, 0, 'false', {}, true]) await t.test(String(value), async t => {
    const { service, state, config } = await fixture(t);
    state.metadata.has_issues = value;
    state.endpoints.issues = () => new Response('UPSTREAM_PRIVATE_CANARY', { status: 404 });
    await service.sync();
    assert.deepEqual(availability(service, 'issues'), { state: 'error', label: 'Collection failed' });
    const db = new DatabaseSync(config.dbPath, { readOnly: true });
    assert.equal(db.prepare('SELECT has_issues FROM repositories').get().has_issues, value === true ? 1 : null);
    db.close();
  });
});

test('HTTP failure reasons are bounded and never inferred to mean disabled', async t => {
  for (const [status, expected] of [[401, 'no_access'], [403, 'no_access'], [404, 'error'], [409, 'error'], [500, 'error'], [429, 'error']]) await t.test(String(status), async t => {
    const { service, state } = await fixture(t);
    state.endpoints.issues = () => Response.json({ message: 'UPSTREAM_PRIVATE_CANARY' }, { status });
    await service.sync();
    assert.deepEqual(availability(service, 'issues'), { state: expected, label: expected === 'no_access' ? 'No access' : 'Collection failed' });
    assert.ok(!JSON.stringify(service.dashboard()).includes('UPSTREAM_PRIVATE_CANARY'));
  });
});

test('successful empty aggregates are not available, but observed zeros and complete empty event windows are', async t => {
  const { service, state } = await fixture(t);
  await service.sync();
  for (const key of ['views', 'clones', 'star_activity']) {
    assert.deepEqual(availability(service, key), { state: 'not_collected', label: 'No observations yet' });
    assert.equal(service.dashboard().repos[0].metrics[key], undefined);
  }
  for (const key of ['commits', 'merged_prs', 'releases', 'issues']) assert.equal(availability(service, key).state, 'available');
  state.endpoints['traffic/views'] = { views: [{ timestamp: '2026-06-20T00:00:00Z', count: 0 }] };
  await service.sync();
  assert.equal(availability(service, 'views').state, 'available');
  assert.equal(service.dashboard().repos[0].metrics.views.value, 0);
});

test('empty repository is specific to commits and retains existing observations on a later failure', async t => {
  const { service, state } = await fixture(t);
  state.endpoints.commits = () => Response.json({ message: 'Git Repository is empty.' }, { status: 409 });
  await service.sync();
  assert.deepEqual(availability(service, 'commits'), { state: 'empty_repository', label: 'No commits yet' });
  assert.equal(service.dashboard().repos[0].metrics.commits, undefined);
  state.endpoints.commits = [];
  await service.sync();
  const before = service.dashboard().repos[0].metrics.commits;
  state.endpoints.commits = () => Response.json({ message: 'Git Repository is empty.' }, { status: 409 });
  await service.sync();
  const after = service.dashboard().repos[0].metrics.commits;
  assert.deepEqual(after.points, before.points);
  assert.equal(after.observedAt, before.observedAt);
  assert.equal(after.status, 'empty_repository');
  assert.equal(availability(service, 'commits').state, 'empty_repository');
});

test('disable and access failures retain metric points, issue details and observation timestamps', async t => {
  const { service, state } = await fixture(t);
  state.metadata.has_issues = true;
  state.endpoints.issues = [{ id: 1, number: 1, created_at: '2026-06-19T00:00:00Z', title: 'Synthetic issue' }];
  state.endpoints['traffic/views'] = { views: [{ timestamp: '2026-06-20T00:00:00Z', count: 4 }] };
  await service.sync();
  const before = service.dashboard().repos[0].metrics;
  const details = service.details({ repository: '101', metric: 'issues' });
  state.metadata.has_issues = false;
  state.endpoints['traffic/views'] = () => new Response('{}', { status: 403 });
  await service.sync();
  for (const key of ['issues', 'views']) {
    const after = service.dashboard().repos[0].metrics[key];
    assert.deepEqual(after.points, before[key].points);
    assert.equal(after.observedAt, before[key].observedAt);
    assert.equal(after.value, before[key].value);
  }
  assert.equal(availability(service, 'views').state, 'no_access');
  assert.equal(availability(service, 'issues').state, 'disabled');
  assert.deepEqual(service.details({ repository: '101', metric: 'issues' }).items, details.items);
  assert.equal(service.details({ repository: '101', metric: 'issues' }).complete, false);
});

test('legacy database migration is additive, restart safe and never fetches on startup or dashboard reads', async t => {
  const { service, config, calls } = await fixture(t);
  await service.sync();
  const before = service.dashboard();
  await service.close();
  const db = new DatabaseSync(config.dbPath);
  // Simulate the pre-capability schema while preserving every observation table.
  db.exec('ALTER TABLE repositories DROP COLUMN has_issues; PRAGMA user_version=2;');
  const tables = ['points', 'events', 'issue_records', 'issue_snapshots', 'runs', 'budgets', 'aliases'];
  const snapshot = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const retained = snapshot();
  db.close();
  const count = calls.length;
  for (let i = 0; i < 2; i++) {
    const restarted = await createObservatory(config);
    try {
      assert.deepEqual(restarted.dashboard(), before);
      const read = new DatabaseSync(config.dbPath, { readOnly: true });
      try {
        assert.equal(read.prepare('SELECT has_issues FROM repositories').get().has_issues, null);
        for (const table of tables) assert.deepEqual(read.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), retained[table]);
      } finally { read.close(); }
      assert.equal(calls.length, count);
    } finally { await restarted.close(); }
  }
});

test('availability covers every family without changing metric omission or fetching on reads', async t => {
  const { service, calls } = await fixture(t);
  const before = calls.length;
  const repo = service.dashboard('7').repos[0];
  assert.deepEqual(Object.keys(repo.metricAvailability).sort(), [...keys].sort());
  assert.deepEqual(Object.keys(repo.metrics).sort(), ['forks', 'stars']);
  for (const key of keys) assert.deepEqual(repo.metricAvailability[key], ['stars', 'forks'].includes(key)
    ? { state: 'available', label: 'Available' } : { state: 'not_collected', label: 'Not collected yet' });
  assert.equal(repo.metrics.stars.value, 0);
  assert.equal(calls.length, before);
});

test('persisted failure and collecting states are honest with or without retained data and recover on restart', async t => {
  const { service, config, calls } = await fixture(t);
  const db = new DatabaseSync(config.dbPath);
  try {
    const put = db.prepare('INSERT OR REPLACE INTO runs(repo_id,metric,status,last_attempt,last_success,message) VALUES(?,?,?,?,?,?)');
    for (const status of ['network_error', 'invalid_response', 'partial', 'rate_limited', 'budget_exhausted', 'interrupted', 'unsupported', 'disabled']) {
      // Even a legacy disabled run is not proof of a disabled repository capability.
      for (const key of ['stars', 'views']) {
        put.run('101', key, status, NOW, null, 'UNTRUSTED_STORED_MESSAGE');
        assert.deepEqual(availability(service, key), { state: 'error', label: 'Collection failed' });
      }
    }
    put.run('101', 'views', 'collecting', NOW, null, 'UNTRUSTED_STORED_MESSAGE');
    put.run('101', 'stars', 'collecting', NOW, null, 'UNTRUSTED_STORED_MESSAGE');
    assert.deepEqual(availability(service, 'views'), { state: 'not_collected', label: 'Collection in progress' });
    assert.equal(availability(service, 'stars').state, 'available');
    assert.ok(!JSON.stringify(service.dashboard()).includes('UNTRUSTED_STORED_MESSAGE'));
  } finally { db.close(); }
  const points = service.dashboard().repos[0].metrics.stars.points;
  const count = calls.length;
  await service.close();
  const restarted = await createObservatory(config);
  try {
    for (const key of ['stars', 'views']) assert.equal(availability(restarted, key).state, 'error');
    assert.deepEqual(restarted.dashboard().repos[0].metrics.stars.points, points);
    assert.equal(restarted.dashboard().repos[0].metrics.stars.status, 'interrupted');
    assert.equal(calls.length, count);
  } finally { await restarted.close(); }
});

test('old observations remain available without synthetic points in a shorter range', async t => {
  const { service, state } = await fixture(t);
  state.now = '2026-07-20T12:00:00.000Z';
  assert.deepEqual(availability(service, 'stars'), { state: 'available', label: 'Available' });
  const metric = service.dashboard('7').repos[0].metrics.stars;
  assert.equal(metric.value, 0);
  assert.ok(metric.points.every(point => point.value === null));
  assert.equal(metric.observedAt, NOW);
});

test('authenticated dashboard exports availability as a pure persisted-data GET', async t => {
  const { service, state, calls, config } = await fixture(t);
  state.metadata.has_issues = false;
  await service.sync();
  const server = createServer({ service, publicDir: join(config.dbPath, '..'), unlockKey: 'synthetic-test-key' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const count = calls.length;
  const anonymous = await fetch(base + '/api/dashboard');
  assert.equal(anonymous.status, 401);
  assert.ok(!(await anonymous.text()).includes('metricAvailability'));
  const login = await fetch(base + '/api/session', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'synthetic-test-key' }) });
  assert.equal(login.status, 200);
  await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const range of ['7', '30', '90', 'all']) {
    const response = await fetch(base + `/api/dashboard?range=${range}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.deepEqual(await response.json(), service.dashboard(range));
  }
  assert.equal(calls.length, count);
});
