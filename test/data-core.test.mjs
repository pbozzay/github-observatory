import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createObservatory } from '../src/data.mjs';

const NOW = '2026-06-20T12:00:00.000Z';
const metadata = (extra = {}) => ({ id: 101, name: 'sample', owner: { login: 'example' }, full_name: 'example/sample', private: false, archived: false, default_branch: 'main', language: 'JavaScript', description: 'Synthetic repository', stargazers_count: 7, forks_count: 2, ...extra });
function mockGitHub(overrides = {}) {
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input); calls.push({ url, options });
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(options.redirect, 'error');
    const key = url.pathname;
    let value = overrides[key];
    if (typeof value === 'function') value = await value(url, options, calls);
    if (value instanceof Response) return value;
    if (value === undefined) {
      if (key === '/user/repos') value = [metadata()];
      else if (key.endsWith('/commits')) value = [{ sha: 'abc123', commit: { committer: { date: '2026-06-19T03:00:00Z', email: 'never-store@example.invalid' }, message: 'Actual commit title\n\nBounded descriptive context' }, author: { login: 'contributor' } }];
      else if (key.endsWith('/events')) value = [];
      else if (key.endsWith('/forks')) value = [];
      else if (key.endsWith('/pulls')) value = [{ number: 12, merged_at: '2026-06-18T05:00:00Z', updated_at: '2026-06-18T05:00:00Z', title: 'Merged change', user: { login: 'contributor' } }, { number: 13, merged_at: null, updated_at: '2026-06-18T05:00:00Z' }];
      else if (key.endsWith('/releases')) value = [{ id: 42, published_at: '2026-06-17T03:00:00Z', name: 'v1', tag_name: 'v1', draft: false }];
      else if (key.endsWith('/issues')) value = [{ id: 1, number: 1 }, { id: 2, number: 2, pull_request: {} }];
      else if (key.endsWith('/traffic/views')) value = { views: [{ timestamp: '2026-06-19T00:00:00Z', count: 9, uniques: 4 }] };
      else if (key.endsWith('/traffic/clones')) value = { clones: [{ timestamp: '2026-06-19T00:00:00Z', count: 3, uniques: 2 }] };
      else if (key.endsWith('/stargazers/history')) value = new Response('{}', { status: 404 });
      else value = metadata();
    }
    return value instanceof Response ? value : Response.json(value);
  };
  return { calls, fetchImpl };
}
async function fixture(t, options = {}, overrides = {}) {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'observatory-test-'));
  const mock = mockGitHub(overrides);
  const service = await createObservatory({ dbPath: join(directory, 'test.sqlite'), now: () => new Date(NOW), ...mock, ...options });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, directory, ...mock };
}

test('empty dashboard is aligned, private by default and local-only', async t => {
  const { service, calls } = await fixture(t);
  const dashboard = service.dashboard('7');
  assert.equal(dashboard.dates.length, 7);
  assert.equal(dashboard.dates.at(-1), '2026-06-20');
  assert.deepEqual(dashboard.repos, []);
  assert.equal(dashboard.credentialConfigured, false);
  assert.equal(service.status().lastAttempt, null);
  assert.deepEqual(service.events(), { events: [] });
  assert.equal(calls.length, 0);
  assert.throws(() => service.dashboard('999'), /range/i);
});

test('token watches collect actual observations and complete bounded events', async t => {
  const { service, calls, directory } = await fixture(t, { token: 'synthetic-test-token' });
  const added = await service.addWatch({ repository: 'example/sample', access: 'token' });
  assert.equal(added.repository.id, '101');
  await service.sync();
  const dashboard = service.dashboard('7');
  const metrics = dashboard.repos[0].metrics;
  assert.equal(metrics.stars.value, 7);
  assert.equal(metrics.stars.points.filter(p => p.value !== null).length, 1);
  assert.equal(metrics.stars.delta, null);
  assert.equal(metrics.commits.value, 1);
  assert.equal(metrics.commits.points.find(p => p.date === '2026-06-19').value, 1);
  assert.equal(metrics.commits.points[0].value, 0);
  assert.equal(metrics.merged_prs.value, 1);
  assert.equal(metrics.releases.value, 1);
  assert.equal(metrics.issues.value, 1);
  assert.equal(metrics.views.value, 9);
  assert.equal(metrics.views.points[0].value, null);
  assert.equal(metrics.star_activity, undefined);
  assert.equal(service.status().runs.find(r=>r.metric==='star_activity').status,'unsupported');
  for (const metric of Object.values(metrics)) assert.deepEqual(metric.points.map(p => p.date), dashboard.dates);
  assert.equal(service.events().events.length, 3);
  assert.ok(calls.every(c => c.options.headers.Authorization === 'Bearer synthetic-test-token'));
  const db = new DatabaseSync(join(directory, 'test.sqlite'), { readOnly: true });
  const dump = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())).join('');
  db.close();
  assert.ok(!dump.includes('never-store'));
  assert.ok(!dump.includes('synthetic-test-token'));
  // User-authorized descriptive metadata supersedes the old no-message rule;
  // source code, raw bodies, credentials and emails remain forbidden.
  assert.ok(dump.includes('Actual commit title'));
});

test('public watches stay anonymous even with a configured token', async t => {
  const { service, calls } = await fixture(t, { token: 'synthetic-test-token' });
  await service.addWatch({ repository: 'https://github.com/example/sample', access: 'public' });
  await service.sync();
  assert.ok(calls.length > 1);
  assert.ok(calls.every(c => !Object.hasOwn(c.options.headers, 'Authorization')));
});

test('invalid repository routes are refused before any network request', async t => {
  const { service, calls } = await fixture(t);
  for (const repository of ['http://github.com/example/sample', 'https://github.com.evil.invalid/example/sample', 'https://user@github.com/example/sample', 'https://github.com:443/example/sample', 'https://github.com/example/sample?x=1', 'https://github.com/example/sample#x', 'example/..', 'example/%2e%2e', 'example/sample/other', ' example/sample', 'example/sample\\other', 'https://api.github.com/repos/example/sample']) {
    await assert.rejects(service.addWatch({ repository, access: 'public' }), /Invalid repository/);
  }
  assert.equal(calls.length, 0);
});

test('token errors never fall back anonymously and provider bodies stay private', async t => {
  const { service, calls } = await fixture(t, { token: 'synthetic-test-token' }, {
    '/repos/example/sample': new Response('SECRET provider debug path /private/location', { status: 401 }),
  });
  await assert.rejects(service.addWatch({ repository: 'example/sample', access: 'token' }), error => error.safeMessage === 'GitHub credentials were rejected.' && !error.message.includes('SECRET'));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].options.headers.Authorization);
  assert.deepEqual(service.dashboard('7').repos, []);
});

test('token access without credentials and private metadata in public mode are rejected', async t => {
  const { service, calls } = await fixture(t, {}, { '/repos/example/sample': metadata({ private: true }) });
  await assert.rejects(service.addWatch({ repository: 'example/sample', access: 'token' }), /token is required/);
  assert.equal(calls.length, 0);
  await assert.rejects(service.addWatch({ repository: 'example/sample', access: 'public' }), /public repository/);
  assert.equal(service.dashboard('7').repos.length, 0);
});

test('discovery is owner-only, paginated, explicit about truncation, and never auto-enrolls', async t => {
  const { service, calls } = await fixture(t, { token: 'synthetic-test-token', maxPages: 1 }, {
    '/user/repos': url => {
      assert.equal(url.searchParams.get('affiliation'), 'owner');
      return Response.json([metadata()], { headers: { Link: '<https://evil.invalid/leak>; rel="next"' } });
    },
  });
  const result = await service.discover();
  assert.equal(result.complete, false);
  assert.equal(result.status, 'partial');
  assert.equal(result.repositories.length, 1);
  assert.equal(result.repositories[0].watched, false);
  assert.equal(service.dashboard('7').repos.length, 0);
  assert.equal(calls.length, 1);
});

test('pagination only increments a fixed GitHub URL, dedupes discovery IDs', async t => {
  const { service, calls } = await fixture(t, { token: 'synthetic-test-token' }, {
    '/user/repos': url => url.searchParams.get('page') === '1'
      ? Response.json([metadata()], { headers: { Link: '<https://evil.invalid/leak>; rel="next"' } })
      : [metadata(), metadata({ id: 202, name: 'other' })],
  });
  const result = await service.discover();
  assert.equal(result.complete, true);
  assert.equal(result.repositories.length, 2);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.url.origin === 'https://api.github.com'));
});

test('stable IDs dedupe renames and aliases resolve the current canonical route', async t => {
  const { service, calls } = await fixture(t, {}, {
    '/repos/example/sample': metadata({ name: 'renamed' }),
    '/repos/example/renamed': metadata({ name: 'renamed', archived: true, default_branch: 'trunk' }),
  });
  await service.addWatch({ repository: 'example/sample', access: 'public' });
  await service.addWatch({ repository: 'example/renamed', access: 'public' });
  await service.addWatch({ repository: 'example/sample', access: 'public' });
  assert.equal(service.dashboard('7').repos.length, 1);
  assert.equal(service.dashboard('7').repos[0].name, 'renamed');
  assert.equal(service.dashboard('7').repos[0].archived, true);
  assert.equal(calls.at(-1).url.pathname, '/repos/example/renamed');
});

test('partial event pagination never zero-fills and preserves last good endpoint state', async t => {
  let truncate = false;
  const { service } = await fixture(t, { token: 'synthetic-test-token', maxPages: 1 }, {
    '/repos/example/sample/commits': () => Response.json([{ sha: 'abc123', commit: { committer: { date: '2026-06-19T03:00:00Z' } } }], { headers: truncate ? { Link: '<https://api.github.com/repos/example/sample/commits?page=2>; rel="next"' } : {} }),
  });
  await service.addWatch({ repository: 'example/sample', access: 'token' });
  truncate = true;
  await service.sync();
  let metric = service.dashboard('7').repos[0].metrics.commits;
  assert.equal(metric.value, 1, 'validated backfill pages now retain real counts even while recent pagination is incomplete');
  assert.equal(metric.points.filter(point => point.value !== null).length, 1);
  assert.equal(metric.coverage.complete, false);
  assert.equal(metric.history.status, 'backfilling');
  assert.equal(service.status().runs.find(r=>r.metric==='commits').status,'partial');
  truncate = false;
  await service.sync();
  const good = service.dashboard('7').repos[0].metrics.commits;
  assert.equal(good.value, 1);
  assert.equal(good.coverage.complete, true);
  truncate = true;
  await service.sync();
  metric = service.dashboard('7').repos[0].metrics.commits;
  assert.deepEqual(metric.points, good.points);
  assert.equal(metric.lastSuccess, good.lastSuccess);
  assert.equal(metric.coverage.complete, false);
});

test('single flight, idempotent repeated sync, default branch bounds, and pause', async t => {
  const { service, calls } = await fixture(t, { token: 'synthetic-test-token' });
  await service.addWatch({ repository: 'example/sample', access: 'token' });
  const first = service.sync();
  const second = service.sync();
  assert.equal(first, second);
  assert.equal(service.status().collecting, true);
  await first;
  assert.equal(service.status().collecting, false);
  const before = service.dashboard('7');
  await service.sync();
  assert.deepEqual(service.dashboard('7'), before);
  assert.equal(service.events().events.length, 3);
  const commitCall = calls.find(c => c.url.pathname.endsWith('/commits'));
  assert.equal(commitCall.url.searchParams.get('sha'), 'main');
  assert.equal(commitCall.url.searchParams.get('until'), NOW);
  assert.equal(new Date(NOW.slice(0, 10)).getTime() - Date.parse(commitCall.url.searchParams.get('since')), 179 * 86_400_000);
  service.pauseWatch('101');
  const count = calls.length;
  await service.sync();
  assert.equal(calls.length, count);
  assert.equal(service.dashboard('7').repos.length, 0);
  assert.equal(service.status().runs.find(r=>r.metric==='commits').status, 'paused');
  assert.equal(service.events().events.length, 0);
});

test('traffic overlaps upsert rather than add and missing days stay null', async t => {
  let count = 4;
  const { service } = await fixture(t, { token: 'synthetic-test-token' }, {
    '/repos/example/sample/traffic/views': () => ({ views: [{ timestamp: '2026-06-19T00:00:00Z', count }] }),
    '/repos/example/sample/stargazers/history': { stars: [{ date: '2026-06-18', count: 2 }] },
  });
  await service.addWatch({ repository: 'example/sample', access: 'token' });
  await service.sync();
  count = 8;
  await service.sync();
  const metrics = service.dashboard('30').repos[0].metrics;
  assert.equal(metrics.views.value, 8);
  assert.equal(metrics.views.points.filter(p => p.value !== null).length, 1);
  assert.equal(metrics.star_activity.value, 2);
  assert.equal(metrics.stars.value, 7);
  assert.match(metrics.star_activity.source, /provider-defined/);
});

test('rate limits persist, stay identity-scoped, sanitize errors, and do not retry', async t => {
  let limited = false;
  const { service, calls } = await fixture(t, { token: 'synthetic-test-token' }, {
    '/repos/example/sample': () => limited ? new Response('SECRET', { status: 429, headers: { 'Retry-After': '120' } }) : metadata(),
  });
  await service.addWatch({ repository: 'example/sample', access: 'token' });
  limited = true;
  await service.sync();
  const count = calls.length;
  await service.sync();
  assert.equal(calls.length, count);
  assert.equal(service.status().runs.find(r => r.metric === 'metadata').status, 'rate_limited');
  assert.ok(!JSON.stringify(service.status()).includes('SECRET'));
  assert.ok(service.status().rateLimit.token.blockedUntil);
  limited = false;
  await service.addWatch({ repository: 'example/sample', access: 'public' });
  assert.ok(!calls.at(-1).options.headers.Authorization);
});

test('redirects and oversized responses are refused without leaking their bodies', async t => {
  const { service } = await fixture(t, {}, {
    '/repos/example/redirect': new Response('private upstream data', { status: 302, headers: { Location: 'https://evil.invalid/' } }),
    '/repos/example/large': new Response('{}', { headers: { 'Content-Length': String(9 * 1024 * 1024) } }),
  });
  await assert.rejects(service.addWatch({ repository: 'example/redirect', access: 'public' }), /redirect refused/);
  await assert.rejects(service.addWatch({ repository: 'example/large', access: 'public' }), /size limit/);
});

test('SQLite online backup restores observations and checkpoint-independent state', async t => {
  const { service, directory } = await fixture(t, { token: 'synthetic-test-token' });
  await service.addWatch({ repository: 'example/sample', access: 'token' });
  await service.sync();
  const destination = join(directory, 'backup.sqlite');
  assert.deepEqual(await service.backup(destination), { ok: true });
  const restored = await createObservatory({ dbPath: destination, token: 'synthetic-test-token', now: () => new Date(NOW), fetchImpl: () => { throw new Error('No network during restore'); } });
  try {
    assert.deepEqual(restored.dashboard('7'), service.dashboard('7'));
    assert.deepEqual(restored.events(), service.events());
    assert.deepEqual(restored.status(), service.status());
  } finally { await restored.close(); }
});

test('an attempted second writer does not remove the first writer lock', async t => {
  const { service, directory } = await fixture(t);
  const options = { dbPath: join(directory, 'test.sqlite') };
  await assert.rejects(createObservatory(options), /active writer/);
  await assert.rejects(createObservatory(options), /active writer/);
  await service.close();
  const reopened = await createObservatory(options);
  await reopened.close();
});

test('request timeout aborts even a transport that ignores AbortSignal', async t => {
  let signal;
  let start;
  let finish;
  const started = new Promise(resolve => { start = resolve; });
  const { service } = await fixture(t, { fetchImpl: (_, options) => { signal = options.signal; start(); return new Promise(resolve => { finish = resolve; }); } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const request = service.addWatch({ repository: 'example/sample', access: 'public' });
  const rejected = assert.rejects(request, /timed out/);
  await started;
  t.mock.timers.tick(15_001);
  await rejected;
  assert.equal(signal.aborted, true);
  await service.close();
  finish(Response.json(metadata()));
  await new Promise(resolve => setImmediate(resolve));
});

test('stream size limit is enforced without a content-length header', async t => {
  const { service } = await fixture(t, {}, {
    '/repos/example/sample': () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); controller.close(); } })),
  });
  await assert.rejects(service.addWatch({ repository: 'example/sample', access: 'public' }), /size limit/);
});

test('interrupted endpoint attempts recover with good history and idempotent retries', async t => {
  const { service, directory, fetchImpl } = await fixture(t, { token: 'synthetic-test-token' });
  await service.addWatch({ repository: 'example/sample', access: 'token' });
  await service.sync();
  const good = service.dashboard('7');
  await service.close();
  const dbPath = join(directory, 'test.sqlite');
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE runs SET status='collecting' WHERE metric='commits'").run();
  db.close();
  const restored = await createObservatory({ dbPath, token: 'synthetic-test-token', now: () => new Date(NOW), fetchImpl });
  try {
    assert.equal(restored.status().runs.find(r => r.metric === 'commits').status, 'interrupted');
    assert.deepEqual(restored.dashboard('7').repos[0].metrics.commits.points, good.repos[0].metrics.commits.points);
    await restored.sync();
    assert.deepEqual(restored.dashboard('7'), good);
    assert.equal(restored.events().events.length, 3);
  } finally { await restored.close(); }
});

test('all range exposes its GitHub-era limit while history totals retain earlier cached counts', async t => {
  const { service, directory } = await fixture(t);
  await service.addWatch({ repository: 'example/sample', access: 'public' });
  const db = new DatabaseSync(join(directory, 'test.sqlite'));
  db.prepare('INSERT INTO points VALUES(?,?,?,?,?)').run('101', 'commits', '2000-01-01', 999, NOW);
  db.prepare('INSERT INTO points VALUES(?,?,?,?,?)').run('101', 'commits', '2026-06-10', 10, NOW);
  db.prepare('INSERT INTO points VALUES(?,?,?,?,?)').run('101', 'commits', '2026-06-20', 2, NOW);
  db.close();
  assert.equal(service.dashboard('all').dates[0], '2008-01-01');
  assert.equal(service.dashboard('all').rangeLimit.truncated, true);
  assert.equal(service.dashboard('all').repos[0].metrics.commits.history.value, 1011);
  assert.equal(service.dashboard('all').repos[0].metrics.commits.value, 12);
  assert.equal(service.dashboard('7').repos[0].metrics.commits.value, 2);
});

test('balance changes require complete observations, not interpolated history', async t => {
  let current = new Date('2026-06-14T12:00:00Z');
  let stars = 7;
  const { service } = await fixture(t, { token: 'synthetic-test-token', now: () => current }, {
    '/repos/example/sample': () => metadata({ stargazers_count: stars }),
  });
  for (let day = 14; day <= 20; day++) {
    current = new Date(`2026-06-${day}T12:00:00Z`);
    stars = day;
    await service.addWatch({ repository: 'example/sample', access: 'token' });
  }
  let metric = service.dashboard('7').repos[0].metrics.stars;
  assert.equal(metric.value, 20);
  assert.equal(metric.delta, 6);
  assert.equal(metric.coverage.complete, true);
  current = new Date('2026-06-22T12:00:00Z');
  await service.addWatch({ repository: 'example/sample', access: 'token' });
  metric = service.dashboard('7').repos[0].metrics.stars;
  assert.equal(metric.delta, null);
  assert.equal(metric.coverage.complete, false);
  assert.equal(metric.points.find(p => p.date === '2026-06-21').value, null);
});

test('no SQLite transaction spans a network request', async t => {
  let dbPath;
  const mock = mockGitHub();
  const { service, directory } = await fixture(t, { token: 'synthetic-test-token', fetchImpl: async (...args) => {
    const other = new DatabaseSync(dbPath);
    try { other.exec('PRAGMA busy_timeout=1; BEGIN IMMEDIATE; ROLLBACK;'); } finally { other.close(); }
    return mock.fetchImpl(...args);
  } });
  dbPath = join(directory, 'test.sqlite');
  await service.addWatch({ repository: 'example/sample', access: 'token' });
  await service.sync();
  assert.equal(service.dashboard('7').repos[0].metrics.commits.status, 'ok');
});

test('database permissions are private and symlink aliases cannot acquire a second writer', async t => {
  const { service, directory } = await fixture(t);
  const path = join(directory, 'test.sqlite');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const alias = join(directory, 'alias.sqlite');
  await symlink(path, alias);
  await assert.rejects(createObservatory({ dbPath: alias }), /active writer/);
  const destination = join(directory, 'backup.sqlite');
  await service.backup(destination);
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
});

test('endpoint failure retains successful snapshots and does not zero-fill the next day', async t => {
  let current = new Date(NOW);
  let failed = false;
  const { service } = await fixture(t, { token: 'synthetic-test-token', now: () => current }, {
    '/repos/example/sample/issues': () => failed ? new Response('private error body', { status: 403 }) : [{ id: 1 }],
  });
  await service.addWatch({ repository: 'example/sample', access: 'token' });
  await service.sync();
  failed = true;
  current = new Date('2026-06-21T12:00:00Z');
  await service.sync();
  const metric = service.dashboard('7').repos[0].metrics.issues;
  assert.equal(metric.status, 'forbidden');
  assert.equal(metric.value, 1);
  assert.equal(metric.lastSuccess, NOW);
  assert.equal(metric.points.at(-1).value, null);
  assert.equal(metric.delta, null);
});

test('successful full collections persist overall success and only metadata-safe events', async t => {
  const { service } = await fixture(t, { token: 'synthetic-test-token' }, {
    '/repos/example/sample/stargazers/history': { stars: [] },
  });
  await service.addWatch({ repository: 'example/sample', access: 'token' });
  const result = await service.sync();
  assert.equal(result.status, 'ok');
  assert.equal(service.status().lastAttempt, NOW);
  assert.equal(service.status().lastSuccess, NOW);
  for (const event of service.events(5000).events) {
    assert.ok(event.url.startsWith('https://github.com/example/sample/'));
    assert.ok(!Object.hasOwn(event, 'body'));
    assert.ok(!Object.hasOwn(event, 'email'));
  }
  assert.equal(service.dashboard('7').repos[0].metrics.star_activity, undefined);
});

test('backup refuses existing files and aliases of the source database', async t => {
  const { service, directory } = await fixture(t);
  const path = join(directory, 'test.sqlite');
  const alias = join(directory, 'source-alias.sqlite');
  await symlink(path, alias);
  await assert.rejects(service.backup(alias), /backup destination/);
  const destination = join(directory, 'backup.sqlite');
  await service.backup(destination);
  await assert.rejects(service.backup(destination), /backup destination/);
});

test('malformed provider dates never normalize into invented event coverage', async t => {
  const { service } = await fixture(t, { token: 'synthetic-test-token' }, {
    '/repos/example/sample/commits': [{ sha: 'abc123', commit: { committer: { date: '2026-02-30T03:00:00Z' } } }],
  });
  await service.addWatch({ repository: 'example/sample', access: 'token' });
  await service.sync();
  const metric = service.dashboard('7').repos[0].metrics.commits;
  assert.equal(metric,undefined);
  assert.equal(service.status().runs.find(r=>r.metric==='commits').status,'invalid_response');
});

test('public request budget survives restart and resets only with its window', async t => {
  let current = new Date(NOW);
  const { service, directory, fetchImpl, calls } = await fixture(t, { now: () => current });
  for (let index = 0; index < 60; index++) await service.addWatch({ repository: 'example/sample', access: 'public' });
  assert.equal(calls.length, 60);
  await assert.rejects(service.addWatch({ repository: 'example/sample', access: 'public' }), /rate limit/);
  assert.equal(calls.length, 60);
  await service.close();
  const reopened = await createObservatory({ dbPath: join(directory, 'test.sqlite'), now: () => current, fetchImpl });
  try {
    await assert.rejects(reopened.addWatch({ repository: 'example/sample', access: 'public' }), /rate limit/);
    assert.equal(calls.length, 60);
    current = new Date('2026-06-20T13:01:00Z');
    await reopened.addWatch({ repository: 'example/sample', access: 'public' });
    assert.equal(calls.length, 61);
  } finally { await reopened.close(); }
});

test('same endpoint corrections replace prior counts and roll back malformed pages atomically', async t => {
  let commits = [{ sha: 'abc123', commit: { committer: { date: '2026-06-19T03:00:00Z' } } }];
  const { service } = await fixture(t, { token: 'synthetic-test-token' }, {
    '/repos/example/sample/commits': () => commits,
  });
  await service.addWatch({ repository: 'example/sample', access: 'token' });
  await service.sync();
  const good = service.dashboard('7').repos[0].metrics.commits;
  commits = [commits[0], { sha: 'bad-date', commit: {} }];
  await service.sync();
  assert.deepEqual(service.dashboard('7').repos[0].metrics.commits.points, good.points);
  commits = [];
  await service.sync();
  assert.equal(service.dashboard('7').repos[0].metrics.commits.value, 0);
  assert.equal(service.events().events.filter(e => e.type === 'commits').length, 0);
});

test('pagination-limited issues never report a falsely exact open issue balance', async t => {
  const { service } = await fixture(t, { token: 'synthetic-test-token', maxPages: 1 }, {
    '/repos/example/sample/issues': () => Response.json([{ id: 1 }], { headers: { Link: '<https://api.github.com/repos/example/sample/issues?page=2>; rel="next"' } }),
  });
  await service.addWatch({ repository: 'example/sample', access: 'token' });
  await service.sync();
  const metric = service.dashboard('7').repos[0].metrics.issues;
  assert.equal(metric,undefined);
  assert.equal(service.status().runs.find(r=>r.metric==='issues').status,'partial');
});

test('provider rate-limit headers stop further requests with no identity substitution', async t => {
  let exhausted = false;
  const { service, calls } = await fixture(t, { token: 'synthetic-test-token' }, {
    '/repos/example/sample': () => exhausted ? Response.json(metadata(), { headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(Date.parse(NOW) / 1000 + 3600) } }) : metadata(),
  });
  await service.addWatch({ repository: 'example/sample', access: 'token' });
  exhausted = true;
  await service.sync();
  assert.equal(calls.length, 2);
  assert.equal(service.dashboard('7').repos[0].metrics.commits,undefined);
  assert.equal(service.status().runs.find(r=>r.metric==='commits').status,'rate_limited');
  assert.ok(calls.every(c => Object.hasOwn(c.options.headers, 'Authorization')));
});

test('actual GitHub weekly star buckets become daily activity without inventing balances', async t => {
 const week=Math.floor(Date.parse('2026-06-14T00:00:00Z')/1000);
 const {service,calls}=await fixture(t,{token:'synthetic-test-token'},{'/repos/example/sample/stargazers/history':[{week,total:6,days:[1,0,2,0,3,0,0]}]});
 await service.addWatch({repository:'example/sample',access:'token'});await service.sync();
 const metrics=service.dashboard('7').repos[0].metrics;
 assert.equal(metrics.star_activity.value,6);assert.equal(metrics.star_activity.points.length,7);
 assert.equal(metrics.star_activity.points[0].value,1);assert.equal(metrics.star_activity.points[4].value,3);
 assert.equal(metrics.stars.points.filter(p=>p.value!==null).length,1);
 assert.equal(calls.find(c=>c.url.pathname.endsWith('/stargazers/history')).url.searchParams.get('per_page'),'30');
});
test('pausing hides the watch without deleting its history and discovery allows readding',async t=>{
 const {service}=await fixture(t,{token:'synthetic-test-token'});await service.addWatch({repository:'example/sample',access:'token'});await service.sync();
 service.pauseWatch('101');assert.equal(service.dashboard('7').repos.length,0);assert.equal((await service.discover()).repositories[0].watched,false);
 await service.addWatch({repository:'example/sample',access:'token'});assert.equal(service.dashboard('7').repos[0].metrics.commits.value,1);
});

test('never-observed metric families are absent from the dashboard contract',async t=>{
 const {service}=await fixture(t);await service.addWatch({repository:'example/sample',access:'public'});
 assert.deepEqual(Object.keys(service.dashboard('7').repos[0].metrics).sort(),['forks','stars']);
});
test('latest retained balance survives a shorter chart window without a fabricated point',async t=>{
 let current=new Date(NOW);const {service}=await fixture(t,{now:()=>current});
 await service.addWatch({repository:'example/sample',access:'public'});current=new Date('2026-07-20T12:00:00Z');
 const metric=service.dashboard('7').repos[0].metrics.stars;
 assert.equal(metric.value,7);assert.ok(metric.points.every(p=>p.value===null));assert.equal(metric.observedAt,NOW);assert.equal(metric.coverage.complete,false);
});
test('bounded public collection rotates deferred repositories across hourly resets',async t=>{
 let current=new Date(NOW);const overrides={};
 for(let i=1;i<=8;i++)overrides['/repos/example/project'+i]=metadata({id:100+i,name:'project'+i});
 const {service}=await fixture(t,{now:()=>current},overrides);
 for(let i=1;i<=8;i++)await service.addWatch({repository:'example/project'+i,access:'public'});
 for(let hour=1;hour<=3;hour++){current=new Date(Date.parse(NOW)+hour*3600000);await service.sync();}
 assert.ok(service.dashboard('7').repos.every(r=>r.metrics.commits?.lastSuccess));
 assert.ok(service.status().runs.filter(r=>r.metric==='activity').every(r=>r.lastSuccess));
 assert.equal(service.status().runs.filter(r=>r.metric==='activity').length,8);
});
