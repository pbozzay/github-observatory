import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createObservatory } from '../src/data.mjs';
import { createNotifications } from '../src/notifications.mjs';
import { createServer } from '../src/server.mjs';
import { homePreview } from '../src/home-preview.mjs';
import { request } from 'node:http';

const at = '2026-06-20T12:00:00.000Z';
const collectedAt = '2026-06-18T12:00:00.000Z';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'home-commits-'));
  const dbPath = join(root, 'observatory.sqlite');
  let providerCalls = 0;
  const service = await createObservatory({ dbPath, now: () => new Date(at), fetchImpl: () => {
    providerCalls++; throw new Error('No provider reads permitted');
  } });
  const db = new DatabaseSync(dbPath);
  t.after(async () => { db.close(); await service.close(); await rm(root, { recursive: true, force: true }); });
  const repository = db.prepare('INSERT INTO repositories(id,owner,name,visibility,archived,branch,access,paused) VALUES(?,?,?,?,?,?,?,?)');
  repository.run('1', 'viewer', 'sample', 'public', 0, 'main', 'public', 0);
  repository.run('2', 'other', 'shared', 'private', 1, 'main', 'token', 0);
  repository.run('3', 'viewer', 'paused', 'public', 0, 'main', 'public', 1);
  const run = db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?)');
  for (const id of ['1', '2', '3']) {
    run.run(id, 'commits', 'ok', collectedAt, collectedAt, 'Synthetic successful collection');
    run.run(id, 'activity', 'ok', at, at, 'Newer unrelated activity');
  }
  db.prepare('INSERT INTO state VALUES(?,?)').run('updatedAt', at);
  const insert = (repo, key, type, date, title = 'Synthetic commit', author = 'viewer') => {
    const id = `${repo}:${type}:${key}`, day = date.slice(0, 10);
    const repository = repo === '1' ? 'viewer/sample' : repo === '2' ? 'other/shared' : 'viewer/paused';
    const url = `https://github.com/${repository}/${type === 'commits' ? 'commit' : 'issues'}/${key}`;
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(id, repo, type, day, title, url, author);
    if (date.includes('T')) db.prepare('INSERT INTO event_context VALUES(?,?,?,?,?)').run(id, date, collectedAt, type,
      JSON.stringify({ summary: 'SUMMARY_CANARY', metadata: { sha: key, body: 'RAW_CANARY' }, actor: { login: author, email: 'hidden@example.invalid' } }));
    return id;
  };
  for (let i = 1; i <= 9; i++) insert('1', String(i), i % 2 ? 'issues' : 'pushes', '2026-06-20T11:00:00.000Z', 'Newer noncommit');
  insert('3', 'ff', 'commits', '2026-06-20T11:59:00.000Z', 'Paused commit');
  const ids = [
    insert('1', 'aa', 'commits', '2026-06-19T10:00:00.000Z', 'Own commit'),
    insert('1', 'bb', 'commits', '2026-06-19T10:00:00.000Z', 'Same time'),
    insert('2', 'cc', 'commits', '2026-06-18T10:00:00.000Z', 'Other watched commit', 'other'),
    insert('1', 'dd', 'commits', '2026-06-17T10:00:00.000Z', 'No known author', null),
    insert('2', 'ee', 'commits', '2026-06-16', 'Commit ee', null),
    insert('1', 'ab', 'commits', '2026-06-15T10:00:00.000Z'),
    insert('2', 'ac', 'commits', '2025-01-01', 'Older retained commit'),
  ];
  return { root, dbPath, db, service, ids, providerCalls: () => providerCalls };
}

test('commit activity filters in SQL before totals and pagination, preserving ties, legacy days and watched scope', async t => {
  const { service, ids, providerCalls } = await fixture(t);
  const all = service.activity({ limit: 5 });
  assert.equal(all.total, 16);
  assert.ok(all.events.every(event => event.type !== 'commits'));
  const first = service.activity({ type: 'commits', range: 'all', offset: 0, limit: 5 });
  assert.equal(first.total, 7);
  assert.deepEqual(first.events.map(event => event.id), ids.slice(0, 5));
  assert.equal(first.hasMore, true);
  assert.equal(first.events[4].date, '2026-06-16');
  assert.equal(first.events[4].title, 'Commit (title unavailable)');
  assert.equal(first.events[0].author, 'viewer');
  const rest = service.activity({ type: 'commits', offset: 5, limit: 5 });
  assert.equal(rest.total, 7); assert.equal(rest.hasMore, false);
  assert.deepEqual(rest.events.map(event => event.id), ids.slice(5));
  assert.equal(service.activity({ type: 'commits', offset: 99 }).hasMore, false);
  assert.equal(service.activity({ type: 'commits', range: '7' }).total, 6);
  assert.equal(service.activity({ type: 'commits', repository: '2' }).total, 3);
  assert.equal(service.activity({ type: 'commits', visibility: 'private', archived: true, search: 'SHARED' }).total, 3);
  assert.throws(() => service.activity({ type: 'commits', repository: '3' }), error => error.statusCode === 404);
  for (const type of ['', null, false, 1, [], {}, 'pushes', 'all', 'COMMITS', "commits' OR 1=1 --"]) {
    assert.throws(() => service.activity({ type }), error => error.statusCode === 400);
  }
  assert.deepEqual(service.activity({ type: undefined }), service.activity());
  assert.equal(providerCalls(), 0);
});

test('Home adds only five allowlisted actual commits, with independent collection freshness and preserved inbox state', async t => {
  const f = await fixture(t);
  let identities = 0, refreshes = 0, mutations = 0, activityReads = 0;
  const notifications = createNotifications({ dbPath: join(f.root, 'inbox.sqlite'), now: () => new Date(at), service: {
    notificationContext: async () => { identities++; return { status: 'ready', viewer: 'viewer', repositories: [{ id: '1', owner: 'viewer', name: 'sample' }] }; },
    activity: () => ({ total: 7, hasMore: false, events: Array.from({ length: 7 }, (_, i) => ({
      id: `1:github_events:${i}`, repositoryId: '1', repository: 'viewer/sample', type: 'issue_comment', source: 'github_events',
      actor: { login: 'other' }, date: at, url: `https://github.com/viewer/sample/issues/${i + 1}`, metadata: { action: 'created', number: i + 1 },
    })) }),
  } });
  t.after(() => notifications.close());
  await notifications.refresh();
  notifications.markRead({ id: notifications.list().items[0].id });
  const inboxBefore = notifications.list({ unread: false }), dashboardBefore = f.service.dashboard();
  const observer = new DatabaseSync(f.dbPath, { readOnly: true });
  const inboxObserver = new DatabaseSync(join(f.root, 'inbox.sqlite'), { readOnly: true });
  t.after(() => { observer.close(); inboxObserver.close(); });
  const version = db => db.prepare('PRAGMA data_version').get().data_version;
  const versions = [version(observer), version(inboxObserver)];
  const previewService = { ...f.service,
    activity: query => { activityReads++; assert.deepEqual(query, { type: 'commits', range: 'all', offset: 0, limit: 5 }); return f.service.activity(query); },
    notificationContext: () => { identities++; throw new Error('Home must not check identity'); },
    sync: () => { mutations++; throw new Error('Home must not sync'); },
    discover: () => { mutations++; throw new Error('Home must not discover'); },
    addWatch: () => { mutations++; throw new Error('Home must not mutate'); },
    pauseWatch: () => { mutations++; throw new Error('Home must not mutate'); },
  };
  const server = createServer({ service: previewService, notifications: { ...notifications, refresh: () => { refreshes++; throw new Error('Home must not refresh'); } },
    publicDir: f.root, unlockKey: 'synthetic-local-key', publicOrigin: 'https://observatory.example.test',
    proxyKey: 'synthetic_proxy_secret_12345678901234567890', homeToken: 'synthetic_home_secret_123456789012345678901', now: () => Date.parse(at) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const get = () => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/home-preview',
      headers: { Host: 'observatory.example.test', Authorization: 'Bearer synthetic_home_secret_123456789012345678901' } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text), text }));
    });
    req.on('error', reject); req.end();
  });
  for (let i = 0; i < 3; i++) {
    const { status, body, text } = await get();
    assert.equal(status, 200);
    assert.equal(body.schemaVersion, 1);
    assert.deepEqual(Object.keys(body).sort(), ['commits', 'coverage', 'freshness', 'generatedAt', 'notifications', 'schemaVersion', 'status', 'summary']);
    assert.deepEqual(Object.keys(body.commits).sort(), ['coverage', 'hasMore', 'items', 'status', 'updatedAt']);
    assert.equal(body.commits.status, 'ready');
    assert.deepEqual(body.commits.items.map(item => item.id), f.ids.slice(0, 5));
    assert.equal(body.commits.hasMore, true);
    assert.equal(body.commits.updatedAt, collectedAt);
    assert.equal(body.freshness.updatedAt, at, 'unrelated dashboard freshness must not stamp commits');
    assert.equal(body.commits.coverage.complete, false);
    assert.match(body.commits.coverage.label, /default.branch|retained/i);
    assert.doesNotMatch(body.commits.coverage.label, /300 events|30 days/);
    for (const item of body.commits.items) assert.deepEqual(Object.keys(item).sort(), ['author', 'id', 'occurredAt', 'repository', 'title', 'url']);
    assert.equal(body.commits.items[0].author, 'viewer', 'own commits remain visible');
    assert.equal(body.commits.items[2].repository, 'other/shared', 'all active watches, including private archived third-party watches');
    assert.equal(body.commits.items[3].author, null);
    assert.equal(body.commits.items[4].occurredAt, '2026-06-16');
    assert.equal(body.commits.items[4].title, 'Commit (title unavailable)');
    assert.equal(body.notifications.unreadCount, 6);
    assert.deepEqual(body.notifications.items.map(item => item.id), inboxBefore.items.slice(0, 5).map(item => item.id));
    assert.equal(body.notifications.items[0].unread, false);
    assert.equal(body.notifications.hasMore, true);
    for (const canary of ['SUMMARY_CANARY', 'RAW_CANARY', 'hidden@example.invalid', 'Paused commit']) assert.ok(!text.includes(canary), canary);
  }
  assert.equal(activityReads, 3);
  assert.equal(f.providerCalls(), 0); assert.equal(identities, 1); assert.equal(refreshes, 0); assert.equal(mutations, 0);
  assert.deepEqual([version(observer), version(inboxObserver)], versions);
  assert.deepEqual(notifications.list({ unread: false }), inboxBefore, 'read timestamps and mutation snapshot must be unchanged');
  assert.deepEqual(f.service.dashboard(), dashboardBefore);
});

const preview = (service, notifications = { list: () => ({ status: 'ready', unreadCount: 0, items: [], hasMore: false }) }) =>
  homePreview({ service, notifications, now: () => Date.parse(at) });

test('commit freshness uses every matching active watch, not newest activity, page observations or paused failures', async t => {
  const { service, db } = await fixture(t);
  const older = '2026-06-17T12:00:00.000Z';
  db.prepare("UPDATE runs SET status='error',last_success=NULL WHERE repo_id='3' AND metric='commits'").run();
  assert.equal(preview(service).commits.status, 'ready', 'paused failures cannot degrade active commits');
  db.prepare("UPDATE runs SET last_success=? WHERE repo_id='2' AND metric='commits'").run(older);
  assert.equal(preview(service).commits.updatedAt, older, 'oldest successful scoped collection, not latest');
  db.prepare("UPDATE runs SET status='forbidden',last_attempt=? WHERE repo_id='2' AND metric='commits'").run(at);
  let result = preview(service).commits;
  assert.equal(result.status, 'partial'); assert.equal(result.updatedAt, older);
  assert.equal(result.items.length, 5); assert.equal(result.hasMore, true);
  assert.match(result.coverage.label, /unavailable|incomplete/);
  assert.equal(service.activity({ type: 'commits', visibility: 'public' }).status, 'ready');
  assert.equal(service.activity({ type: 'commits', repository: '1' }).updatedAt, collectedAt);
  db.prepare("DELETE FROM runs WHERE repo_id='2' AND metric='commits'").run();
  result = preview(service).commits;
  assert.equal(result.status, 'partial'); assert.equal(result.updatedAt, null);
  assert.equal(result.items.length, 5, 'legacy rows remain visible without invented collection provenance');
  assert.equal(result.coverage.complete, false);
});

test('known empty commit collection, never collected, unavailable collection and no watches are distinct', async t => {
  const { service, db } = await fixture(t);
  db.exec('DELETE FROM event_context; DELETE FROM events;');
  let result = preview(service).commits;
  assert.equal(result.status, 'ready'); assert.equal(result.updatedAt, collectedAt);
  assert.deepEqual(result.items, []); assert.equal(result.hasMore, false);
  db.exec("UPDATE runs SET status='empty_repository',last_success=NULL WHERE metric='commits'");
  result = preview(service).commits;
  assert.equal(result.status, 'ready'); assert.equal(result.updatedAt, collectedAt);
  db.exec("UPDATE runs SET status='forbidden',last_success=NULL WHERE metric='commits'");
  result = preview(service).commits;
  assert.equal(result.status, 'partial'); assert.equal(result.updatedAt, null);
  assert.deepEqual(result.items, []); assert.equal(result.hasMore, false);
  db.exec("DELETE FROM runs WHERE metric='commits'");
  assert.equal(preview(service).commits.status, 'partial');
  db.exec('UPDATE repositories SET paused=1');
  result = preview(service).commits;
  assert.equal(result.status, 'ready'); assert.equal(result.updatedAt, null);
  assert.deepEqual(result.items, []); assert.equal(result.hasMore, false);
});

test('commit read failure is isolated from metrics and notifications; other component errors retain commits', async t => {
  const { service, db, ids } = await fixture(t);
  const healthy = preview(service);
  const feed = service.activity({ type: 'commits', limit: 5 });
  const failedSummary = preview({ ...service, dashboard: () => { throw new Error('PRIVATE_FAILURE'); } });
  assert.deepEqual(failedSummary.commits, healthy.commits);
  assert.equal(failedSummary.status, 'error');
  const failedInbox = preview(service, { list: () => { throw new Error('PRIVATE_FAILURE'); } });
  assert.deepEqual(failedInbox.commits, healthy.commits);
  assert.equal(failedInbox.status, 'error');
  db.prepare('UPDATE event_context SET context=? WHERE event_id=?').run('PRIVATE_MALFORMED_JSON', ids[0]);
  const failed = preview(service);
  assert.equal(failed.commits.status, 'error'); assert.equal(failed.status, 'error');
  assert.deepEqual(failed.commits.items, []); assert.equal(failed.commits.hasMore, null); assert.equal(failed.commits.updatedAt, null);
  assert.deepEqual(failed.summary, healthy.summary); assert.deepEqual(failed.notifications, healthy.notifications);
  assert.ok(!JSON.stringify(failed).includes('PRIVATE_MALFORMED_JSON'));
  for (const invalid of [undefined, {}, { ...feed, total: null }, { ...feed, hasMore: false }, { ...feed, events: [] },
    { ...feed, events: [...feed.events, feed.events[0]] }, { ...feed, status: 'ok' }]) {
    assert.equal(preview({ ...service, activity: () => invalid }).commits.status, 'error');
  }
});

test('commit projection bounds safe text, preserves dates and rejects malformed identifiers rather than repairing them', async t => {
  const { service, db, ids } = await fixture(t);
  db.prepare('UPDATE events SET title=?,author=? WHERE id=?').run('Title '.repeat(50) + '\nBODY_CANARY', 'Author '.repeat(50), ids[0]);
  db.prepare('UPDATE events SET title=?,author=? WHERE id=?').run('```js\nCODE_CANARY', 'Person <hidden@example.invalid>', ids[1]);
  db.prepare('UPDATE events SET title=? WHERE id=?').run('const CODE_CANARY = 1;', ids[2]);
  const safe = preview(service).commits;
  assert.equal(safe.status, 'ready');
  assert.equal(safe.items[0].title.length, 200); assert.equal(safe.items[0].author.length, 100);
  assert.equal(safe.items[1].title, 'Commit (title unavailable)');
  assert.equal(safe.items[2].title, 'Commit (title unavailable)');
  for (const canary of ['BODY_CANARY', 'CODE_CANARY', 'SUMMARY_CANARY', 'RAW_CANARY', 'hidden@example.invalid', '<']) assert.ok(!JSON.stringify(safe).includes(canary), canary);
  const feed = service.activity({ type: 'commits', limit: 5 });
  const project = extra => preview({ ...service, activity: () => ({ ...feed, events: [{ ...feed.events[0], ...extra }, ...feed.events.slice(1)] }) }).commits;
  for (const extra of [{ type: 'pushes' }, { id: 'x'.repeat(129) }, { id: 'bad\nidentifier' }, { id: 'hidden@example.invalid' }, { repository: 'viewer/..' },
    { date: '2026-02-30' }, { date: 'June 1 2026' }, { date: null }, { url: 'javascript:alert(1)' },
    { url: 'https://github.com/viewer/other/commit/aa' }, { url: 'https://github.com/viewer/sample/commit/aa?secret=canary' },
    { url: 'https://github.com/viewer/sample/commit/aa/extra/commit/bb' }]) {
    assert.equal(project(extra).status, 'error', JSON.stringify(extra));
  }
  assert.equal(project({ date: '2026-06-19T11:00:00+01:00' }).items[0].occurredAt, '2026-06-19T10:00:00.000Z');
});
