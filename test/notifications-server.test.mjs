import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createServer } from '../src/server.mjs';
import { createNotifications, withNotifications } from '../src/notifications.mjs';

async function fixture(t, { absent = false, proxy = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'observatory-notifications-http-'));
  const now = new Date('2026-06-20T12:00:00Z');
  let contexts = 0, activities = 0, syncs = 0;
  const service = { notificationContext: async () => { contexts++; return { viewer: 'viewer', repositories: [{ id: '1', owner: 'viewer', name: 'repo' }], status: 'ready' }; }, activity: () => { activities++; return { events: [{ id: 'github:1', repositoryId: '1', repository: 'viewer/repo', type: 'issue_comment', metadata: { action: 'created', number: 1 }, source: 'github_events', date: now.toISOString(), actor: { login: 'other' }, url: 'https://github.com/viewer/repo/issues/1#issuecomment-5' }], total: 1, hasMore: false }; }, sync: async () => { syncs++; }, status: () => ({ collecting: false }), pauseWatch: async () => {}, close: async () => {} };
  const notifications = absent ? undefined : createNotifications({ service, dbPath: join(root, 'notifications.sqlite'), now: () => now });
  if (notifications) await notifications.refresh();
  const proxyKey = 'synthetic_proxy_key_12345678901234567890';
  const server = createServer({ service: notifications ? withNotifications(service, notifications) : service, notifications, publicDir: root, unlockKey: 'synthetic-key', ...(proxy ? { publicOrigin: 'https://observatory.example', proxyKey } : {}) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await notifications?.close(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function raw(path, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => { const req = request(base + path, { method, headers }, res => { let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) })); }); req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end(); });
  }
  const origin = proxy ? 'https://observatory.example' : base;
  const transport = proxy ? { Host: 'observatory.example', 'X-Observatory-Proxy-Key': proxyKey } : {};
  const login = await raw('/api/session', { method: 'POST', headers: { ...transport, Origin: origin, 'Content-Type': 'application/json' }, body: proxy ? {} : { key: 'synthetic-key' } });
  assert.equal(login.status, 200);
  const headers = { ...transport, Cookie: login.headers['set-cookie'][0].split(';')[0] };
  const mutationHeaders = { ...headers, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': login.body.csrf };
  return { raw, headers, mutationHeaders, notifications, counters: () => ({ contexts, activities, syncs }) };
}

test('notifications GET is cached, default-unread and authenticated; POST reads are local', async t => {
  const f = await fixture(t);
  const before = f.counters();
  assert.equal((await f.raw('/api/notifications')).status, 401);
  const response = await f.raw('/api/notifications', { headers: f.headers });
  assert.equal(response.status, 200); assert.match(response.headers['cache-control'], /no-store/);
  assert.equal(response.body.total, 1); assert.equal(response.body.limit, 50); assert.equal(response.body.offset, 0);
  assert.equal(response.body.hasMore, false); assert.equal(response.body.coverage.complete, false);
  const id = response.body.items[0].id;
  assert.equal((await f.raw('/api/notifications/read', { method: 'POST', headers: f.mutationHeaders, body: { id } })).status, 200);
  assert.equal((await f.raw('/api/notifications', { headers: f.headers })).body.total, 0);
  assert.equal((await f.raw('/api/notifications?unread=false', { headers: f.headers })).body.total, 1);
  assert.equal((await f.raw('/api/notifications/read-all', { method: 'POST', headers: f.mutationHeaders, body: { through: response.body.snapshot } })).status, 200);
  assert.deepEqual(f.counters(), before);
});

test('notification routes retain host, origin, session, CSRF and reverse-proxy gates', async t => {
  for (const proxy of [false, true]) {
    const f = await fixture(t, { proxy });
    const result = await f.raw('/api/notifications', { headers: f.headers });
    assert.equal(result.status, 200); const id = result.body.items[0].id;
    assert.equal((await f.raw('/api/notifications', { headers: { ...f.headers, Host: 'attacker.invalid' } })).status, 403);
    assert.equal((await f.raw('/api/notifications', { headers: { ...f.headers, Origin: 'https://attacker.invalid' } })).status, 403);
    if (proxy) assert.equal((await f.raw('/api/notifications', { headers: { ...f.headers, 'X-Observatory-Proxy-Key': 'wrong' } })).status, 403);
    for (const path of ['/api/notifications/read', '/api/notifications/read-all']) {
      const body = path.endsWith('read-all') ? { through: result.body.snapshot } : { id };
      assert.equal((await f.raw(path, { method: 'POST', headers: f.headers, body })).status, 403);
      assert.equal((await f.raw(path, { method: 'POST', headers: { ...f.mutationHeaders, 'X-CSRF-Token': 'wrong' }, body })).status, 403);
      assert.equal((await f.raw(path, { method: 'POST', headers: { ...f.mutationHeaders, Origin: 'https://attacker.invalid' }, body })).status, 403);
    }
    assert.equal((await f.raw('/api/notifications', { headers: f.headers })).body.unreadCount, 1);
  }
});

test('invalid pagination, malformed IDs, SQL input and future snapshots fail safely', async t => {
  const f = await fixture(t);
  for (const query of ['limit=0', 'limit=101', 'limit=', 'limit=1&limit=2', 'offset=-1', 'offset=01', 'offset=1.2', 'offset=1e2', 'offset=9007199254740992', 'unread=1', 'unread=', 'unread=true&unread=false', 'unexpected=1']) {
    const response = await f.raw('/api/notifications?' + query, { headers: f.headers });
    assert.equal(response.status, 400, query); assert.deepEqual(Object.keys(response.body), ['error']);
  }
  for (const body of [{}, { id: null }, { id: "'; DROP TABLE notifications;--" }, { id: 'a'.repeat(65) }, { id: 'a'.repeat(64), extra: true }]) {
    const response = await f.raw('/api/notifications/read', { method: 'POST', headers: f.mutationHeaders, body });
    assert.equal(response.status, 400); assert.deepEqual(Object.keys(response.body), ['error']);
  }
  for (const body of [{}, { through: -1 }, { through: 999 }, { through: '1' }, { through: 0.1 }, { through: 0, unexpected: true }]) assert.equal((await f.raw('/api/notifications/read-all', { method: 'POST', headers: f.mutationHeaders, body })).status, 400);
  assert.equal((await f.raw('/api/notifications/read', { method: 'POST', headers: f.mutationHeaders, body: { id: 'a'.repeat(64) } })).status, 404);
  assert.equal((await f.raw('/api/notifications', { headers: f.headers })).body.unreadCount, 1);
});

test('optional absent notification service returns explicit not_configured rather than 404', async t => {
  const f = await fixture(t, { absent: true });
  const response = await f.raw('/api/notifications', { headers: f.headers });
  assert.equal(response.status, 200); assert.equal(response.body.status, 'not_configured');
  assert.deepEqual(response.body.items, []); assert.equal(response.body.snapshot, 0); assert.equal(response.body.updatedAt, null);
  assert.equal((await f.raw('/api/notifications?limit=101', { headers: f.headers })).status, 400);
  assert.equal((await f.raw('/api/notifications/read-all', { method: 'POST', headers: f.mutationHeaders, body: { through: 0 } })).status, 503);
});

test('manual sync uses the same facade and watch pause immediately hides local unread items', async t => {
  const f = await fixture(t); const before = f.counters();
  assert.equal((await f.raw('/api/sync', { method: 'POST', headers: f.mutationHeaders, body: {} })).status, 202);
  assert.equal(f.counters().syncs, before.syncs + 1); assert.equal(f.counters().contexts, before.contexts + 1);
  assert.equal((await f.raw('/api/watches/1/pause', { method: 'POST', headers: f.mutationHeaders, body: {} })).status, 200);
  assert.equal((await f.raw('/api/notifications', { headers: f.headers })).body.unreadCount, 0);
});
