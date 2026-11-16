import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createObservatory } from '../src/data.mjs';

const NOW = '2026-06-20T12:00:00.000Z';
const issue = (number, extra = {}) => ({ id: number + 1000, number, title: `Issue ${number}`, created_at: '2020-01-01T10:00:00Z', ...extra });
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'observatory-details-test-'));
  const dbPath = join(directory, 'test.sqlite');
  const calls = [];
  const state = { now: NOW, issues: [issue(1)], commits: [
    { sha: 'abc1', commit: { committer: { date: '2026-06-20T05:00:00Z' } }, author: { login: 'synthetic-author' } },
    { sha: 'abc2', commit: { committer: { date: '2026-06-14T00:00:00Z' } } },
    { sha: 'abc3', commit: { committer: { date: '2026-06-13T23:59:59Z' } } },
  ] };
  const fetchImpl = async (input, init) => {
    const url = new URL(input); calls.push({ url, init });
    assert.equal(url.origin, 'https://api.github.com');
    const name = url.pathname.split('/')[3];
    const endpoint = url.pathname.split('/').slice(4).join('/');
    let value;
    if (!endpoint) value = { id: name === 'sample' ? 101 : 202, name, owner: { login: 'example' }, private: true, archived: false, default_branch: 'main', stargazers_count: 7, forks_count: 2 };
    else if (endpoint === 'commits') value = state.commits;
    else if (endpoint === 'issues') value = typeof state.issues === 'function' ? await state.issues(url) : state.issues;
    else if (endpoint === 'pulls') value = [{ number: 12, merged_at: '2026-06-18T05:00:00Z', updated_at: '2026-06-18T05:00:00Z', title: 'Merged change' }];
    else if (endpoint === 'releases') value = [{ id: 42, published_at: '2026-06-17T03:00:00Z', name: 'v1', tag_name: 'v1', draft: false }];
    else if (endpoint === 'traffic/views') value = { views: [] };
    else if (endpoint === 'traffic/clones') value = { clones: [] };
    else if (endpoint === 'stargazers/history') value = [];
    else throw new Error(`Unexpected synthetic route: ${url.pathname}`);
    return value instanceof Response ? value : Response.json(value);
  };
  const config = { dbPath, token: 'synthetic-test-token', fetchImpl, now: () => new Date(state.now), ...options };
  const service = await createObservatory(config);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  await service.addWatch({ repository: 'example/sample', access: 'token' });
  return { service, state, calls, dbPath, config };
}
const query = (metric, extra = {}) => ({ repository: '101', metric, range: '7', ...extra });

test('details filter exact repository, metric and inclusive dashboard days with stable pagination', async t => {
  const { service, calls } = await fixture(t);
  await service.addWatch({ repository: 'example/other', access: 'token' });
  await service.sync();
  const requests = calls.length;
  const first = service.details(query('commits', { limit: 1 }));
  assert.deepEqual(first, { items: [{ id: '101:commits:abc1', date: '2026-06-20', title: 'Commit abc1', url: 'https://github.com/example/sample/commit/abc1', author: 'synthetic-author' }], total: 2, hasMore: true, offset: 0, limit: 1, kind: 'events', observedAt: NOW, status: 'ok', complete: true });
  const next = service.details(query('commits', { offset: '1', limit: '1' }));
  assert.deepEqual(next.items.map(x => x.id), ['101:commits:abc2']);
  assert.equal(next.hasMore, false);
  assert.equal(service.details(query('commits', { range: '30' })).total, 3);
  assert.equal(service.details(query('commits', { range: '90' })).total, 3);
  assert.equal(service.details(query('merged_prs')).items[0].url, 'https://github.com/example/sample/pull/12');
  assert.equal(service.details(query('releases')).items[0].url, 'https://github.com/example/sample/releases/tag/v1');
  assert.equal(service.details(query('commits', { offset: 100 })).total, 2);
  assert.deepEqual(service.details(query('commits', { offset: 100 })).items, []);
  assert.equal(service.details(query('commits', { offset: 100 })).hasMore, false);
  assert.equal(calls.length, requests, 'details must only read persisted records');
});

test('event detail all-range matches capped dashboard bounds and excludes future records', async t => {
  const { service, dbPath } = await fixture(t);
  await service.sync();
  const db = new DatabaseSync(dbPath);
  for (const day of ['2000-01-01', '2026-06-21']) {
    db.prepare('INSERT INTO points VALUES(?,?,?,?,?)').run('101', 'commits', day, 1, NOW);
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(`101:commits:${day}`, '101', 'commits', day, 'Synthetic', 'https://github.com/example/sample/commit/abc', null);
  }
  db.close();
  const details = service.details(query('commits', { range: 'all' }));
  assert.equal(details.total, service.dashboard('all').repos[0].metrics.commits.value);
  assert.equal(details.total, 3);
  assert.equal(details.complete, false, 'retained old observations do not fill missing coverage');
});

test('details validate scope and pagination without accepting coercion or paused watches', async t => {
  const { service } = await fixture(t);
  for (const extra of [
    { repository: '' }, { repository: 101 }, { repository: '0101' }, { repository: 'example/sample' },
    { metric: '__proto__' }, { metric: 'unknown' }, { metric: null }, { range: '' }, { range: '8' },
    ...['', null, false, -1, 0.5, '1e2', ' 1', '+1', '01', Number.MAX_SAFE_INTEGER + 1].map(offset => ({ offset })),
    ...['', null, false, 0, -1, 101, 1.5, '1e2', ' 1'].map(limit => ({ limit })),
  ]) assert.throws(() => service.details(query('commits', extra)), error => error.statusCode === 400, JSON.stringify(extra));
  assert.throws(() => service.details(query('commits', { repository: '999' })), error => error.statusCode === 404);
  assert.equal(service.details({ repository: '101', metric: 'commits' }).limit, 50);
  assert.equal(service.details(query('commits', { limit: 100 })).limit, 100);
  service.pauseWatch('101');
  assert.throws(() => service.details(query('commits')), error => error.statusCode === 404);
});

test('uncollected and observation-only details report provenance without invented entities', async t => {
  const { service } = await fixture(t);
  assert.deepEqual(service.details(query('commits')), { items: [], total: 0, hasMore: false, offset: 0, limit: 50, kind: 'events', observedAt: null, status: 'not_collected', complete: false });
  for (const metric of ['stars', 'forks', 'views', 'clones', 'star_activity']) {
    const details = service.details(query(metric));
    assert.equal(details.kind, 'observations');
    assert.deepEqual(details.items, []);
    assert.equal(details.total, 0);
    assert.equal(details.hasMore, false);
    assert.equal(details.observedAt, ['stars', 'forks'].includes(metric) ? NOW : null);
    assert.equal(details.complete, false);
  }
});

test('failed event refresh retains records and original observation time with incomplete status', async t => {
  const { service, state } = await fixture(t);
  await service.sync();
  const good = service.details(query('commits'));
  state.now = '2026-06-21T12:00:00.000Z';
  state.commits = new Response('private-upstream-canary', { status: 403 });
  await service.sync();
  const retained = service.details(query('commits', { range: '30' }));
  assert.equal(retained.total, 3);
  assert.equal(retained.observedAt, good.observedAt);
  assert.equal(retained.status, 'forbidden');
  assert.equal(retained.complete, false);
  assert.ok(!JSON.stringify(retained).includes('private-upstream-canary'));
});

test('current issues are persisted metadata-only, exclude PRs and ignore the chart range', async t => {
  const { service, state, dbPath, config } = await fixture(t);
  state.issues = [issue(2, { body: 'never-persist-issue-body', html_url: 'https://attacker.invalid/' }), issue(1), issue(3, { pull_request: {} }), issue(2)];
  await service.addWatch({ repository: 'example/other', access: 'token' });
  await service.sync();
  const result = service.details(query('issues'));
  assert.deepEqual(result, { items: [
    { id: '101:issues:1', date: '2020-01-01', title: 'Issue 1', url: 'https://github.com/example/sample/issues/1' },
    { id: '101:issues:2', date: '2020-01-01', title: 'Issue 2', url: 'https://github.com/example/sample/issues/2' },
  ], total: 2, hasMore: false, offset: 0, limit: 50, kind: 'snapshot', observedAt: NOW, status: 'ok', complete: true });
  assert.deepEqual(service.details(query('issues', { range: 'all' })), result);
  const second = service.details(query('issues', { offset: 1, limit: 1 }));
  assert.deepEqual(second.items, [result.items[1]]);
  assert.equal(second.total, 2);
  assert.equal(second.hasMore, false);
  assert.equal(service.details(query('issues', { limit: 1 })).hasMore, true);
  assert.equal(service.dashboard('7').repos[0].metrics.issues.value, 2);
  assert.equal(service.events().events.some(x => x.type === 'issues'), false);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const dump = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())).join('');
  db.close();
  assert.ok(!dump.includes('never-persist-issue-body'));
  assert.ok(!dump.includes('attacker.invalid'));
  await service.close();
  const reopened = await createObservatory({ ...config, fetchImpl: () => { throw new Error('No network permitted on restart'); } });
  try { assert.deepEqual(reopened.details(query('issues')), result); } finally { await reopened.close(); }
});

test('issue snapshots replace only after the last complete page, then remove closed issues', async t => {
  const { service, state } = await fixture(t);
  await service.sync();
  const original = service.details(query('issues'));
  state.now = '2026-06-21T12:00:00.000Z';
  state.issues = url => {
    assert.deepEqual(service.details(query('issues')).items, original.items, 'no network request sees a partial replacement');
    assert.equal(url.searchParams.get('state'), 'open');
    return url.searchParams.get('page') === '1'
      ? Response.json([issue(2)], { headers: { Link: '<https://attacker.invalid/>; rel="next"' } })
      : [issue(3, { created_at: '2026-06-01T00:00:00Z' })];
  };
  await service.sync();
  const replacement = service.details(query('issues'));
  assert.deepEqual(replacement.items.map(x => x.id), ['101:issues:3', '101:issues:2']);
  assert.equal(replacement.observedAt, state.now);
  assert.equal(replacement.complete, true);
  state.issues = [];
  await service.sync();
  const empty = service.details(query('issues'));
  assert.deepEqual(empty.items, []);
  assert.equal(empty.total, 0);
  assert.equal(empty.complete, true);
  assert.equal(empty.observedAt, state.now);
  assert.equal(service.dashboard('7').repos[0].metrics.issues.value, 0);
});

test('failed, malformed and pagination-limited issue refreshes retain the last complete snapshot', async t => {
  const cases = [
    ['forbidden', () => new Response('private-upstream-canary', { status: 403 })],
    ['unauthorized', () => new Response('private-upstream-canary', { status: 401 })],
    ['network_error', () => { throw new Error('private-upstream-canary'); }],
    ['invalid_response', () => [issue(2), { id: -1 }]],
    ['partial', () => Response.json([issue(2)], { headers: { Link: '<https://attacker.invalid/>; rel="next"' } })],
    ['rate_limited', () => new Response('private-upstream-canary', { status: 429, headers: { 'Retry-After': '120' } })],
  ];
  for (const [expected, response] of cases) await t.test(expected, async t => {
    const { service, state, calls } = await fixture(t, { maxPages: 1 });
    await service.sync();
    const good = service.details(query('issues'));
    state.now = '2026-06-21T12:00:00.000Z';
    state.issues = response;
    await service.sync();
    const failed = service.details(query('issues'));
    assert.deepEqual(failed.items, good.items);
    assert.equal(failed.total, good.total);
    assert.equal(failed.observedAt, good.observedAt);
    assert.equal(failed.status, expected);
    assert.equal(failed.complete, false);
    assert.equal(service.dashboard('7').repos[0].metrics.issues.points.at(-1).value, null);
    assert.ok(calls.every(x => x.init.headers.Authorization === 'Bearer synthetic-test-token'), 'never downgrade private watches');
    assert.ok(!JSON.stringify(failed).includes('private-upstream-canary'));
  });
});

test('an error after the first issues page does not persist its records or count', async t => {
  const { service, state } = await fixture(t);
  await service.sync();
  const good = service.details(query('issues'));
  state.issues = url => url.searchParams.get('page') === '1'
    ? Response.json([issue(2)], { headers: { Link: '<https://attacker.invalid/>; rel="next"' } })
    : new Response('private-upstream-canary', { status: 500 });
  await service.sync();
  const failed = service.details(query('issues'));
  assert.deepEqual(failed.items, good.items);
  assert.equal(failed.status, 'upstream_error');
  assert.equal(failed.complete, false);
  assert.equal(service.dashboard('7').repos[0].metrics.issues.value, 1);
});

test('issue snapshot replacement rolls back records, count and provenance on storage failure', async t => {
  const { service, state, dbPath } = await fixture(t);
  await service.sync();
  const good = service.details(query('issues'));
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TRIGGER synthetic_issue_failure BEFORE INSERT ON issue_records WHEN NEW.number=3 BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END;");
  state.now = '2026-06-21T12:00:00.000Z';
  state.issues = [issue(2), issue(3)];
  try { await service.sync(); } finally { db.exec('DROP TRIGGER synthetic_issue_failure'); db.close(); }
  const retained = service.details(query('issues'));
  assert.deepEqual(retained.items, good.items);
  assert.equal(retained.observedAt, good.observedAt);
  assert.equal(retained.complete, false);
  assert.equal(service.dashboard('7').repos[0].metrics.issues.value, 1);
  assert.equal(service.dashboard('7').repos[0].metrics.issues.points.at(-1).value, null);
});

test('legacy count-only responses preserve counts but explicitly mark details incomplete', async t => {
  const { service, state } = await fixture(t);
  assert.deepEqual(service.details(query('issues')), { items: [], total: 0, hasMore: false, offset: 0, limit: 50, kind: 'snapshot', observedAt: null, status: 'not_collected', complete: false });
  state.issues = [{ id: 1 }, { id: 2, pull_request: {} }];
  await service.sync();
  const unavailable = service.details(query('issues'));
  assert.equal(service.dashboard('7').repos[0].metrics.issues.value, 1);
  assert.equal(service.dashboard('7').repos[0].metrics.issues.status, 'ok');
  assert.equal(unavailable.status, 'details_incomplete');
  assert.equal(unavailable.complete, false);
  assert.equal(unavailable.observedAt, null);
  assert.deepEqual(unavailable.items, []);
  state.issues = [issue(1)];
  await service.sync();
  const good = service.details(query('issues'));
  for (const bad of [{ id: 2 }, issue(2, { created_at: '2026-02-30T00:00:00Z' }), issue(2, { number: 0 })]) {
    state.now = '2026-06-21T12:00:00.000Z';
    state.issues = [issue(3), bad];
    await service.sync();
    const incomplete = service.details(query('issues'));
    assert.equal(service.dashboard('7').repos[0].metrics.issues.value, 2);
    assert.deepEqual(incomplete.items, good.items);
    assert.equal(incomplete.observedAt, good.observedAt);
    assert.equal(incomplete.status, 'details_incomplete');
    assert.equal(incomplete.complete, false);
  }
  state.issues = [issue(4)];
  await service.sync();
  assert.equal(service.details(query('issues')).status, 'ok');
  assert.equal(service.details(query('issues')).complete, true);
});
