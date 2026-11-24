import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createServer } from '../src/server.mjs';
import { createNotifications } from '../src/notifications.mjs';
import { createObservatory } from '../src/data.mjs';
import { DatabaseSync } from 'node:sqlite';
import { aggregate, chartView } from '../public/metrics.js';

const origin = 'https://observatory.example.test';
const proxyKey = 'synthetic_proxy_secret_12345678901234567890';
const homeToken = 'synthetic_home_secret_123456789012345678901';
const at = '2026-06-20T12:00:00.000Z';
const metric = (value, extra = {}) => ({ value, observedAt: at, status: 'ok', coverage: { complete: true }, ...extra });
const dashboard = () => ({ updatedAt: at, collecting: false, repos: [
  { metrics: { stars: metric(7), issues: metric(2), commits: metric(3) } },
  { metrics: { stars: metric(0), issues: metric(1), commits: metric(4) } },
] });
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'observatory-home-'));
  let contexts = 0, activities = 0, mutations = 0, dashboardReads = 0;
  const service = {
    dashboard: range => { dashboardReads++; assert.equal(range, '30'); return (options.dashboard || dashboard)(); },
    notificationContext: async () => { contexts++; return { viewer: 'viewer', repositories: [{ id: '1', owner: 'viewer', name: 'repo' }], status: 'ready' }; },
    activity: query => {
      activities++;
      if (query?.type === 'commits') {
        assert.deepEqual(query, { type: 'commits', range: 'all', offset: 0, limit: 5 });
        return { events: [], total: 0, hasMore: false, status: 'ready', updatedAt: at };
      }
      return { events: Array.from({ length: 12 }, (_, i) => ({ id: `github:${i}`, repositoryId: '1', repository: 'viewer/repo', type: 'issue_comment', metadata: { action: 'created', number: i + 1 }, source: 'github_events', date: new Date(Date.parse(at) - i * 1000).toISOString(), actor: { login: 'other' }, url: `https://github.com/viewer/repo/issues/${i + 1}` })), total: 12, hasMore: false };
    },
    sync: async () => { mutations++; }, status: () => ({ collecting: false }),
    discover: async () => { mutations++; return {}; }, addWatch: async () => { mutations++; }, pauseWatch: async () => { mutations++; },
  };
  const inbox = createNotifications({ dbPath: join(root, 'notifications.sqlite'), service, now: () => new Date(at) });
  await inbox.refresh();
  const notifications = Object.hasOwn(options, 'notifications') ? options.notifications : inbox;
  const server = createServer({ service, notifications, publicDir: root, unlockKey: 'synthetic-local-key', publicOrigin: origin, proxyKey, homeToken: options.disabled ? undefined : homeToken });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await inbox.close(); await rm(root, { recursive: true, force: true }); });
  function call(path = '/api/home-preview', { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: { Host: new URL(origin).host, ...headers } }, res => {
        let text = ''; res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null, text }));
      });
      req.on('error', reject); req.end(body);
    });
  }
  return { call, inbox, auth: { Authorization: `Bearer ${homeToken}` }, counters: () => ({ contexts, activities, mutations, dashboardReads }) };
}

test('dedicated token reads bounded cached home preview directly without proxy key or session', async t => {
  const f = await fixture(t), before = f.counters(), inboxBefore = f.inbox.list();
  const response = await f.call(undefined, { headers: f.auth });
  assert.equal(response.status, 200);
  assert.match(response.headers['cache-control'], /no-store/);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.body.schemaVersion, 1);
  assert.ok(Number.isFinite(Date.parse(response.body.generatedAt)));
  assert.equal(response.body.status, 'ready');
  assert.equal(response.body.summary.repositories, 2);
  assert.deepEqual(response.body.summary.metrics.map(({ key, value }) => ({ key, value })), [
    { key: 'stars', value: 7 }, { key: 'openIssues', value: 3 }, { key: 'commits30d', value: 7 },
  ]);
  assert.equal(response.body.freshness.updatedAt, at);
  assert.equal(response.body.freshness.collecting, false);
  assert.deepEqual(response.body.coverage.stars, { observedRepositories: 2, totalRepositories: 2, complete: true, oldestObservedAt: at });
  assert.equal(response.body.notifications.status, 'ready');
  assert.equal(response.body.notifications.unreadCount, 12);
  assert.equal(response.body.notifications.items.length, 5);
  assert.equal(response.body.notifications.hasMore, true);
  assert.equal(response.body.notifications.coverage.complete, false);
  assert.equal(response.body.notifications.updatedAt, at);
  assert.deepEqual(response.body.notifications.items.map(item => item.title), inboxBefore.items.slice(0, 5).map(item => item.title));
  assert.deepEqual(Object.keys(response.body.notifications.items[0]).sort(), ['actor', 'id', 'occurredAt', 'readAt', 'repository', 'title', 'type', 'unread', 'url']);
  assert.ok(!response.text.includes(homeToken)); assert.ok(!response.text.includes(proxyKey));
  assert.deepEqual(f.inbox.list(), inboxBefore);
  assert.deepEqual(f.counters(), { ...before, dashboardReads: before.dashboardReads + 1, activities: before.activities + 1 });
});

test('latest five include read entries, retain inbox order and preserve the full unread count', async t => {
  const items = Array.from({ length: 7 }, (_, i) => ({ id: `item-${i}`, title: 'Synthetic event',
    occurredAt: at, readAt: i % 2 ? null : at }));
  let reads = 0;
  const f = await fixture(t, { notifications: { list: query => {
    reads++;
    assert.deepEqual(query, { offset: 0, limit: 5, unread: false });
    return { status: 'ready', unreadCount: 19, items, hasMore: true, updatedAt: at };
  }, markRead: () => assert.fail('preview cannot mark read') } });
  const { body } = await f.call(undefined, { headers: f.auth });
  assert.equal(reads, 1);
  assert.deepEqual(body.notifications.items.map(item => item.id), items.slice(0, 5).map(item => item.id));
  assert.deepEqual(body.notifications.items.map(item => item.unread), [false, true, false, true, false]);
  assert.deepEqual(body.notifications.items.map(item => item.readAt), [at, null, at, null, at]);
  assert.equal(body.notifications.unreadCount, 19);
  assert.equal(body.notifications.hasMore, true);
});

test('home token is exact-target GET only and cannot become a general API credential', async t => {
  const f = await fixture(t), before = f.counters();
  for (const path of ['/', '/health', '/api/dashboard', '/api/status', '/api/events', '/api/details', '/api/discover', '/api/export', '/api/notifications', '/api/session', '/api/home-preview?range=30', '/api/home-preview?', '/api/home-preview?token=' + homeToken, '/api/home-preview/', '/api/x/../home-preview', '/api/%68ome-preview', '//api/home-preview', origin + '/api/home-preview']) {
    assert.equal((await f.call(path, { headers: f.auth })).status, 403, path);
  }
  for (const method of ['HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await f.call('/api/home-preview', { method, headers: f.auth })).status, 403, method);
  }
  for (const path of ['/api/sync', '/api/watches', '/api/watches/1/pause', '/api/notifications/read', '/api/notifications/read-all', '/api/session']) {
    assert.equal((await f.call(path, { method: 'POST', headers: { ...f.auth, Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 403, path);
  }
  // Even a separately trusted transport cannot turn the read token into a session.
  for (const path of ['/api/dashboard', '/api/discover', '/api/notifications']) {
    assert.equal((await f.call(path, { headers: { ...f.auth, 'X-Observatory-Proxy-Key': proxyKey } })).status, 401, path);
  }
  assert.deepEqual(f.counters(), before);
});

test('home auth fails closed for missing/invalid token, wrong Host, foreign Origin and disabled integration', async t => {
  const f = await fixture(t), before = f.counters();
  for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: `Bearer ${proxyKey}` }, { Authorization: `Basic ${homeToken}` }, { Authorization: `Bearer ${homeToken}, Bearer wrong` }, { ...f.auth, Host: 'attacker.invalid', 'X-Forwarded-Host': new URL(origin).host }, { ...f.auth, Host: '127.0.0.1:18087' }, { ...f.auth, Origin: 'https://attacker.invalid' }, { ...f.auth, Origin: 'null' }]) {
    assert.equal((await f.call(undefined, { headers })).status, 403);
  }
  assert.deepEqual(f.counters(), before);
  const disabled = await fixture(t, { disabled: true });
  assert.equal((await disabled.call(undefined, { headers: disabled.auth })).status, 403);
  assert.equal((await f.call(undefined, { headers: { ...f.auth, Origin: origin } })).status, 200);
});

test('integration token leaves browser proxy, session and CSRF gates intact', async t => {
  const f = await fixture(t);
  const transport = { 'X-Observatory-Proxy-Key': proxyKey, Origin: origin, 'Content-Type': 'application/json' };
  const login = await f.call('/api/session', { method: 'POST', headers: transport, body: '{}' });
  assert.equal(login.status, 200);
  const headers = { ...transport, ...f.auth, Cookie: login.headers['set-cookie'][0] };
  assert.equal((await f.call('/api/dashboard', { headers })).status, 200);
  assert.equal((await f.call('/api/sync', { method: 'POST', headers, body: '{}' })).status, 403);
  assert.equal((await f.call('/api/notifications/read-all', { method: 'POST', headers, body: '{}' })).status, 403);
  assert.equal((await f.call('/api/sync', { method: 'POST', headers: { ...headers, 'X-CSRF-Token': login.body.csrf }, body: '{}' })).status, 202);
});

test('unknown and incomplete summary data stay null or explicitly partial, never fabricated zero', async t => {
  const f = await fixture(t, { dashboard: () => ({ collecting: true, repos: [
    { metrics: { stars: metric(0), commits: metric(2, { coverage: { complete: false } }) } },
    { metrics: {} },
  ] }) });
  const { body } = await f.call(undefined, { headers: f.auth });
  assert.equal(body.status, 'partial');
  assert.equal(body.summary.repositories, 2);
  assert.deepEqual(body.summary.metrics.map(m => m.value), [0, null, 2]);
  assert.equal(body.freshness.updatedAt, null); assert.equal(body.freshness.collecting, true);
  assert.equal(body.coverage.stars.complete, false);
  assert.equal(body.coverage.openIssues.observedRepositories, 0);
  assert.equal(body.coverage.commits30d.complete, false);
  assert.match(body.summary.metrics[1].detail, /no observations/);
  const empty = await fixture(t, { dashboard: () => ({ repos: [], collecting: false }) });
  const emptyBody = (await empty.call(undefined, { headers: empty.auth })).body;
  assert.equal(emptyBody.summary.repositories, 0);
  assert.deepEqual(emptyBody.summary.metrics.map(m => m.value), [null, null, null]);
});

test('summary and inbox failures are isolated and normalized without error messages or false zero badges', async t => {
  const failedSummary = await fixture(t, { dashboard: () => { throw new Error('private-provider-details'); } });
  const first = await failedSummary.call(undefined, { headers: failedSummary.auth });
  assert.equal(first.status, 200); assert.equal(first.body.status, 'error');
  assert.equal(first.body.summary.repositories, null);
  assert.deepEqual(first.body.summary.metrics.map(m => m.value), [null, null, null]);
  assert.equal(first.body.notifications.unreadCount, 12);
  assert.ok(!first.text.includes('private-provider-details'));
  for (const notifications of [undefined, { list: () => { throw new Error('private-provider-details'); } }, ...['not_configured', 'no_access', 'error'].map(status => ({ list: () => ({ status, unreadCount: 0, items: [], hasMore: false }) }))]) {
    const f = await fixture(t, { notifications });
    const response = await f.call(undefined, { headers: f.auth });
    assert.equal(response.status, 200); assert.notEqual(response.body.status, 'ready');
    assert.equal(response.body.summary.repositories, 2);
    assert.equal(response.body.notifications.unreadCount, null);
    assert.equal(response.body.notifications.hasMore, null);
    assert.equal(response.body.notifications.coverage.complete, false);
    assert.ok(!response.text.includes('private-provider-details'));
  }
});

test('retained failure values are labeled partial and missing timestamps cannot claim complete coverage', async t => {
  const f = await fixture(t, { dashboard: () => ({ repos: [{ metrics: {
    stars: metric(5, { status: 'forbidden' }), issues: metric(0, { observedAt: null }), commits: metric(null),
  } }] }) });
  const { body } = await f.call(undefined, { headers: f.auth });
  assert.equal(body.status, 'partial');
  assert.deepEqual(body.summary.metrics.map(m => m.value), [5, 0, null]);
  assert.equal(body.coverage.stars.complete, false);
  assert.equal(body.coverage.openIssues.complete, false);
  assert.equal(body.coverage.openIssues.oldestObservedAt, null);
});

test('real dashboard aggregates project through HTTP with no provider calls or database writes on reads', async t => {
  const root = await mkdtemp(join(tmpdir(), 'observatory-home-data-'));
  const dbPath = join(root, 'observatory.sqlite');
  let calls = 0, reading = false;
  const metadata = { id: 1, name: 'repo', owner: { login: 'viewer' }, full_name: 'viewer/repo', private: false, archived: false, default_branch: 'main', stargazers_count: 9, forks_count: 2, has_issues: true };
  const service = await createObservatory({ dbPath, token: 'synthetic-test-token', now: () => new Date(at), fetchImpl: async input => {
    assert.equal(reading, false, 'GET must not collect'); calls++;
    const path = new URL(input).pathname;
    if (path.endsWith('/commits')) return Response.json([{ sha: 'abc123', commit: { committer: { date: at }, message: 'Synthetic commit' } }]);
    if (path.endsWith('/issues')) return Response.json([{ id: 1, number: 1, title: 'Synthetic issue' }]);
    if (path.endsWith('/traffic/views')) return Response.json({ views: [] });
    if (path.endsWith('/traffic/clones')) return Response.json({ clones: [] });
    if (path.endsWith('/stargazers/history')) return new Response('{}', { status: 404 });
    if (['/events', '/pulls', '/releases', '/forks'].some(suffix => path.endsWith(suffix))) return Response.json([]);
    return Response.json(metadata);
  } });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  await service.addWatch({ repository: 'viewer/repo', access: 'token' }); await service.sync();
  // Synthetic retained history predates the graph zoom. GET must keep its baseline.
  const seed = new DatabaseSync(dbPath);
  try { seed.prepare('INSERT INTO points(repo_id,metric,day,value,observed_at) VALUES(?,?,?,?,?) ON CONFLICT(repo_id,metric,day) DO UPDATE SET value=excluded.value,observed_at=excluded.observed_at')
    .run('1', 'commits', '2026-04-01', 8, '2026-04-01T12:00:00.000Z'); }
  finally { seed.close(); }
  const retained = service.dashboard('30');
  assert.equal(retained.repos[0].metrics.commits.value, 1);
  assert.equal(retained.repos[0].metrics.commits.history.value, 9);
  const f = await fixture(t, { dashboard: () => service.dashboard('30') });
  const observer = new DatabaseSync(dbPath, { readOnly: true });
  t.after(() => observer.close());
  const version = observer.prepare('PRAGMA data_version').get().data_version;
  const beforeCalls = calls, inboxBefore = f.inbox.list(); reading = true;
  for (let i = 0; i < 3; i++) {
    const { status, body } = await f.call(undefined, { headers: f.auth });
    assert.equal(status, 200);
    assert.equal(body.summary.repositories, 1);
    assert.deepEqual(body.summary.metrics.map(m => m.value), [9, 1, 9]);
    for (const [index, source] of ['stars', 'issues', 'commits'].entries()) {
      const expected = aggregate(retained.repos, source, retained.dates);
      assert.deepEqual(body.summary.metrics[index].points, chartView(expected, retained.dates, 'totals').points);
      assert.equal(body.summary.metrics[index].points.length, 30);
    }
    assert.equal(body.summary.metrics[2].graph.history.baseline, 8);
    assert.equal(body.freshness.updatedAt, at);
    assert.equal(body.coverage.stars.oldestObservedAt, at);
    assert.equal(body.notifications.unreadCount, 12);
  }
  assert.equal(calls, beforeCalls);
  assert.equal(observer.prepare('PRAGMA data_version').get().data_version, version);
  assert.deepEqual(f.inbox.list(), inboxBefore);
});
