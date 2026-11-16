import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createObservatory } from '../src/data.mjs';
import { createServer } from '../src/server.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'observatory-details-server-'));
  let upstreamCalls = 0;
  let detailCalls = 0;
  const service = await createObservatory({ dbPath: ':memory:', now: () => new Date('2026-06-20T12:00:00.000Z'), fetchImpl: async input => {
    upstreamCalls++;
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.github.com');
    const endpoint = url.pathname.split('/').slice(4).join('/');
    if (!endpoint) return Response.json({ id: 101, name: 'sample', owner: { login: 'example' }, private: false, archived: false, default_branch: 'main', stargazers_count: 7, forks_count: 2 });
    if (endpoint === 'issues') return Response.json([{ id: 1, number: 1, title: 'Synthetic issue', created_at: '2020-01-01T00:00:00Z' }]);
    if (endpoint === 'commits') return Response.json([{ sha: 'abc123', commit: { committer: { date: '2026-06-19T00:00:00Z' } } }]);
    if (endpoint === 'traffic/views') return Response.json({ views: [] });
    if (endpoint === 'traffic/clones') return Response.json({ clones: [] });
    assert.ok(['pulls', 'releases', 'stargazers/history'].includes(endpoint));
    return Response.json([]);
  } });
  const details = service.details;
  service.details = args => { detailCalls++; return details(args); };
  await service.addWatch({ repository: 'example/sample', access: 'public' });
  await service.sync();
  const server = createServer({ service, publicDir: root, unlockKey: 'synthetic-test-key' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await service.close(); await rm(root, { recursive: true, force: true }); });
  const login = async () => {
    const response = await fetch(base + '/api/session', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'synthetic-test-key' }) });
    assert.equal(response.status, 200);
    await response.json();
    return response.headers.get('set-cookie').split(';')[0];
  };
  return { service, base, login, counters: () => ({ upstreamCalls, detailCalls }) };
}
const route = '/api/details?repository=101&metric=commits&range=7';

test('detail route inherits session, origin, host and private no-store protections', async t => {
  const { base, login, counters } = await fixture(t);
  const anonymous = await fetch(base + route);
  assert.equal(anonymous.status, 401);
  assert.ok(!(await anonymous.text()).includes('abc123'));
  assert.match(anonymous.headers.get('cache-control'), /no-store/);
  const cookie = await login();
  const foreign = await fetch(base + route, { headers: { Cookie: cookie, Origin: 'https://attacker.invalid' } });
  assert.equal(foreign.status, 403);
  await foreign.text();
  const status = await new Promise((resolve, reject) => {
    const req = request(base + route, { headers: { Cookie: cookie, Host: 'attacker.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
  assert.equal(counters().detailCalls, 0);
});

test('authenticated detail route returns exact persisted contract and pagination without upstream requests', async t => {
  const { base, login, service, counters } = await fixture(t);
  const cookie = await login();
  const before = counters().upstreamCalls;
  for (const metric of ['commits', 'merged_prs', 'releases', 'issues', 'stars', 'forks', 'views', 'clones', 'star_activity']) {
    const response = await fetch(base + `/api/details?repository=101&metric=${metric}&range=7&offset=0&limit=1`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.deepEqual(await response.json(), service.details({ repository: '101', metric, range: '7', offset: 0, limit: 1 }));
  }
  const defaults = await fetch(base + '/api/details?repository=101&metric=issues', { headers: { Cookie: cookie } });
  assert.equal(defaults.status, 200);
  const body = await defaults.json();
  assert.equal(body.kind, 'snapshot');
  assert.equal(body.items[0].url, 'https://github.com/example/sample/issues/1');
  assert.equal(body.items[0].date, '2020-01-01');
  assert.equal(body.limit, 50);
  assert.equal(counters().upstreamCalls, before);
});

test('detail route rejects invalid and ambiguous parameters plus missing or paused scopes', async t => {
  const { base, login, service } = await fixture(t);
  const cookie = await login();
  const valid = { repository: '101', metric: 'commits', range: '7', offset: '0', limit: '50' };
  const invalid = [{ repository: '' }, { repository: 'example/sample' }, { repository: '0101' }, { metric: '' }, { metric: '__proto__' }, { metric: 'invalid' }, { range: '' }, { range: '8' }, { offset: '' }, { offset: '-1' }, { offset: '1.1' }, { offset: '1e2' }, { offset: '9007199254740992' }, { limit: '' }, { limit: '0' }, { limit: '101' }];
  for (const extra of invalid) {
    const response = await fetch(base + '/api/details?' + new URLSearchParams({ ...valid, ...extra }), { headers: { Cookie: cookie } });
    assert.equal(response.status, 400, JSON.stringify(extra));
    assert.deepEqual(Object.keys(await response.json()), ['error']);
  }
  for (const suffix of ['', '?metric=commits', '?repository=101', '?repository=101&repository=202&metric=commits']) {
    const response = await fetch(base + '/api/details' + suffix, { headers: { Cookie: cookie } });
    assert.equal(response.status, 400, suffix);
    await response.text();
  }
  let response = await fetch(base + '/api/details?repository=999&metric=issues', { headers: { Cookie: cookie } });
  assert.equal(response.status, 404);
  await response.text();
  service.pauseWatch('101');
  response = await fetch(base + route, { headers: { Cookie: cookie } });
  assert.equal(response.status, 404);
  await response.text();
});
