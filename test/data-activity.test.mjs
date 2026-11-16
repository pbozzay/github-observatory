import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createObservatory } from '../src/data.mjs';

const NOW = '2026-06-20T12:00:00.000Z';
const DATE = '2026-06-19T03:04:05.000Z';
const repo = { id: 101, name: 'sample', owner: { login: 'example' }, private: false, archived: false, default_branch: 'main', stargazers_count: 7, forks_count: 2 };
const commit = { sha: 'abc123', commit: { message: 'Fix the actual bug\n\nExplain the change.\n\nSigned-off-by: Person <private@example.invalid>\n```js\nSOURCE_CANARY\n```', author: { name: 'Actual Author', email: 'private@example.invalid' }, committer: { date: DATE } }, author: { login: 'author' }, files: [{ patch: 'DIFF_CANARY' }] };
const event = (id, type, payload = {}, extra = {}) => ({ id: String(id), type, created_at: DATE, actor: { login: 'actor', display_login: 'Actor', url: 'https://attacker.invalid', email: 'private@example.invalid' }, repo: { id: 101 }, payload, ...extra });
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'activity-test-'));
  const dbPath = join(dir, 'test.sqlite');
  const state = { now: NOW, repo: { ...repo }, commits: [commit], feed: [], pulls: [], releases: [] };
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input); calls.push({ url, init });
    const endpoint = url.pathname.split('/').slice(4).join('/');
    let value = !endpoint ? state.repo : endpoint === 'commits' ? state.commits : endpoint === 'events' ? state.feed : endpoint === 'pulls' ? state.pulls : endpoint === 'releases' ? state.releases : endpoint === 'traffic/views' ? { views: [] } : endpoint === 'traffic/clones' ? { clones: [] } : [];
    if (typeof value === 'function') value = await value(url);
    return value instanceof Response ? value : Response.json(value);
  };
  const config = { dbPath, fetchImpl, token: 'synthetic-test-token', now: () => new Date(state.now), ...options };
  const service = await createObservatory(config);
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  await service.addWatch({ repository: 'example/sample', access: options.access ?? 'public' });
  return { service, state, calls, dbPath, config };
}

test('commit titles, safe bounded context and actual timestamps survive in activity and details', async t => {
  const { service, dbPath } = await fixture(t);
  await service.sync();
  const item = service.events().events[0];
  assert.equal(item.title, 'Fix the actual bug');
  assert.equal(item.date, DATE);
  assert.equal(item.repositoryId, '101');
  assert.deepEqual(item.actor, { login: 'author', name: 'Actual Author', url: 'https://github.com/author' });
  assert.equal(item.author, 'author');
  assert.equal(item.metadata.sha, 'abc123');
  assert.equal(item.metadata.branch, 'main');
  assert.match(item.summary, /Explain the change/);
  assert.equal(item.observedAt, NOW);
  assert.equal(item.source, 'commits');
  assert.deepEqual(service.details({ repository: '101', metric: 'commits', range: '7' }).items[0], item);
  assert.equal(service.dashboard('7').repos[0].lastActivityAt, DATE);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const dump = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())).join('');
  db.close();
  for (const forbidden of ['private@example.invalid', 'SOURCE_CANARY', 'DIFF_CANARY']) assert.ok(!dump.includes(forbidden), forbidden);
});

test('fenced descriptions discard complete and unfinished blocks without treating inner delimiters as closers', async t => {
  const cases = [
    ['quoted backticks', '```js\nconst fence = "```";\nconst SOURCE_CANARY = 123;\n```\nAfter.', 'Before. After.'],
    ['quoted tildes', '~~~js\nconst fence = "~~~";\nSOURCE_CANARY\n~~~\nAfter.', 'Before. After.'],
    ['shorter closing fence', '````js\n```\nSOURCE_CANARY\n````\nAfter.', 'Before. After.'],
    ['different closing character', '```js\n~~~\nSOURCE_CANARY\n```\nAfter.', 'Before. After.'],
    ['nonstandalone closing fence', '```js\n``` trailing text\nSOURCE_CANARY\n```\nAfter.', 'Before. After.'],
    ['indented longer closing fence', '   ~~~~js\nSOURCE_CANARY\n  ~~~~~ \t\nAfter.', 'Before. After.'],
    ['unfinished fence', '```js\nconst fence = "```";\nSOURCE_CANARY', 'Before.'],
    ['truncated fence', '```js\n' + 'x'.repeat(32_000) + '\n```\nAfter.', 'Before.'],
  ];
  for (const [label, block, expected] of cases) await t.test(label, async t => {
    const { service, state, dbPath } = await fixture(t);
    const body = 'Before.\n' + block;
    state.commits = [{ ...commit, commit: { ...commit.commit, message: 'Title\n\n' + body } }];
    state.pulls = [{ number: 12, merged_at: DATE, updated_at: DATE, title: 'PR', body }];
    state.releases = [{ id: 42, published_at: DATE, tag_name: 'v1', name: 'Release', body }];
    state.feed = [event(1, 'PullRequestEvent', { action: 'opened', pull_request: { number: 13, title: 'Feed PR', body } }), event(2, 'ReleaseEvent', { action: 'published', release: { id: 43, tag_name: 'v2', body } })];
    await service.sync();
    const all = service.activity().events;
    assert.equal(all.length, 5);
    for (const item of all) assert.equal(item.summary, expected, item.source + ':' + item.type);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      for (const table of ['event_context', 'activity_feed']) assert.ok(!JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()).includes('SOURCE_CANARY'), table);
    } finally { db.close(); }
  });
});

test('inline identifiers and ordinary bullets survive titles and descriptions while refs stay exact', async t => {
  const { service, state, calls } = await fixture(t);
  const branch = 'fix/`foo`';
  const body = '- Fixed `parseConfig` timeout\n+ Added retry support\n* Documented ``foo`` behavior';
  const expected = 'Fixed parseConfig timeout Added retry support Documented foo behavior';
  state.repo.default_branch = branch;
  state.commits = [{ ...commit, commit: { ...commit.commit, message: 'Fix `foo` handling\n\n' + body, author: { name: '    + Real `Name`' } } }];
  state.pulls = [{ number: 12, merged_at: DATE, updated_at: DATE, title: '    - Fix `foo` handling', body, head: { ref: branch }, base: { ref: 'main' } }];
  state.releases = [{ id: 42, published_at: DATE, tag_name: 'v`1`', name: '+ Release `foo`', body }];
  state.feed = [
    event(1, 'PullRequestEvent', { action: 'opened', pull_request: { number: 13, title: 'Fix `foo` handling', body, head: { ref: branch }, base: { ref: 'main' } } }),
    event(2, 'ReleaseEvent', { action: 'published', release: { id: 43, tag_name: 'v`2`', name: 'Release `foo`', body } }),
    event(3, 'PushEvent', { ref: 'refs/heads/' + branch }),
    event(4, 'CreateEvent', { ref: branch, ref_type: 'branch' }),
    event(5, 'DeleteEvent', { ref: 'v`3`', ref_type: 'tag' }),
  ];
  await service.sync();
  const all = service.activity().events;
  const byId = id => all.find(x => x.id === id);
  const actualCommit = byId('101:commits:abc123');
  assert.equal(actualCommit.title, 'Fix foo handling');
  assert.equal(actualCommit.actor.name, '+ Real Name');
  assert.equal(actualCommit.metadata.branch, branch);
  assert.ok(calls.some(x => x.url.pathname.endsWith('/commits') && x.url.searchParams.get('sha') === branch));
  for (const id of ['101:commits:abc123', '101:merged_prs:12', '101:releases:42', '101:github_events:1', '101:releases:43']) assert.equal(byId(id).summary, expected, id);
  assert.equal(byId('101:merged_prs:12').title, '- Fix foo handling');
  assert.equal(byId('101:merged_prs:12').metadata.head, branch);
  assert.equal(byId('101:github_events:1').metadata.head, branch);
  assert.equal(byId('101:releases:42').title, '+ Release foo');
  for (const [id, ref] of [['101:releases:42', 'v`1`'], ['101:releases:43', 'v`2`']]) {
    assert.equal(byId(id).metadata.ref, ref);
    assert.equal(decodeURIComponent(new URL(byId(id).url).pathname), '/example/sample/releases/tag/' + ref);
  }
  assert.equal(byId('101:github_events:3').metadata.ref, 'refs/heads/' + branch);
  assert.equal(byId('101:github_events:3').metadata.branch, branch);
  assert.equal(byId('101:github_events:4').metadata.ref, branch);
  assert.equal(byId('101:github_events:5').metadata.ref, 'v`3`');
});

test('prose removes structural code and contextual diffs, not adjacent bullet descriptions', async t => {
  const { service, state, dbPath } = await fixture(t);
  const body = [
    '- Fixed `parseConfig` timeout', '+ Added retry support',
    '    INDENTED_CANARY', '\tTABBED_CANARY',
    'diff --git a/file b/file', 'index DIFF_INDEX_CANARY', '--- a/file', '+++ b/file', '@@ -1,1 +1,1 @@',
    '-REMOVED_CANARY', '+ADDED_CANARY', ' CONTEXT_CANARY', '\\ No newline at end of file', '',
    '- Preserved next bullet', '--- a/other', '+++ b/other', '@@ -1 +1 @@', '-OLD_CANARY', '+NEW_CANARY', '',
    'Use `parseConfig` safely, not `const INLINE_CANARY = 123;`.', 'const BARE_CODE_CANARY = 123;',
    'Contact private@example.invalid\u0000\u202e safely.',
  ].join('\n');
  state.commits = [{ ...commit, commit: { ...commit.commit, message: 'Fix `parseConfig`\n\n' + body } }];
  await service.sync();
  const item = service.activity().events[0];
  assert.equal(item.summary, 'Fixed parseConfig timeout Added retry support Preserved next bullet Use parseConfig safely, not . Contact [redacted] safely.');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const saved = JSON.stringify(db.prepare('SELECT * FROM event_context').all());
    assert.ok(!saved.includes('CANARY'));
    assert.ok(!saved.includes('private@example.invalid'));
  } finally { db.close(); }
});

test('code-only snippets are not meaningful titles or descriptions, while inline names are retained', async t => {
  const { service, state } = await fixture(t);
  // Inline identifiers are deliberately retained now; executable snippets are not.
  const snippets = ['`const SOURCE_CANARY = 123;`', '`SOURCE_CANARY = 123`', '`console.log(SOURCE_CANARY)`'];
  state.commits = snippets.map((snippet, i) => ({ ...commit, sha: String(i + 1), commit: { ...commit.commit, message: snippet + '\n\n' + snippet } }));
  await service.sync();
  const all = service.activity().events;
  assert.equal(all.length, snippets.length);
  for (const item of all) {
    assert.equal(item.title, 'Commit (title unavailable)');
    assert.equal(item.summary, undefined);
  }
});

test('invalid or private refs are omitted whole instead of becoming plausible different identifiers', async t => {
  const { service, state } = await fixture(t);
  const invalid = ['fix/ bad', 'fix/../bad', 'fix//bad', 'fix/.hidden', 'fix/name.lock', 'fix/name.', 'fix/name/', 'fix/a@{b', 'fix/a:b', 'fix/a?b', 'fix/a*b', 'fix/a[b', 'fix/a\\b', 'fix/\u202ebad', 'fix/\u0000bad', 'private@example.invalid', 'x'.repeat(256)];
  state.feed = invalid.flatMap((ref, i) => [event(i * 3 + 1, 'PushEvent', { ref: 'refs/heads/' + ref }), event(i * 3 + 2, 'CreateEvent', { ref, ref_type: 'branch' }), event(i * 3 + 3, 'ReleaseEvent', { release: { tag_name: ref }, action: 'created' })]);
  await service.sync();
  for (const item of service.activity().events.filter(x => x.source === 'github_events')) {
    assert.equal(item.metadata.ref, undefined, item.id);
    assert.equal(item.metadata.branch, undefined, item.id);
    assert.ok(!item.url.includes('/tag/'), item.id);
  }
});

test('reobserved feed IDs refresh observation time with actor and context, but skipped or failed reads do not', async t => {
  const { service, state, config, dbPath } = await fixture(t);
  state.commits = [];
  const pull = title => event(3, 'PullRequestEvent', { action: 'opened', pull_request: { number: 12, title, body: title + ' context', head: { ref: title } } });
  state.feed = [event(1, 'WatchEvent', {}, { actor: { login: 'oldactor' } }), event(2, 'WatchEvent'), pull('old')];
  await service.sync();
  const original = service.activity().events;
  assert.ok(original.every(x => x.observedAt === NOW));
  state.now = '2026-06-21T12:00:00.000Z';
  const refreshedAt = state.now;
  state.feed = () => Response.json([event(1, 'WatchEvent', {}, { actor: { login: 'renamedactor' } }), pull('updated')], { headers: { 'X-Poll-Interval': '60' } });
  await service.sync();
  const updated = service.activity().events;
  const star = updated.find(x => x.id === '101:github_events:1');
  assert.equal(star.actor.login, 'renamedactor');
  assert.equal(star.observedAt, refreshedAt);
  assert.equal(star.date, DATE);
  assert.equal(updated.find(x => x.id === '101:github_events:2').observedAt, NOW, 'unseen retained records must not be restamped');
  const pr = updated.find(x => x.id === '101:github_events:3');
  assert.equal(pr.title, 'updated');
  assert.equal(pr.summary, 'updated context');
  assert.equal(pr.metadata.head, 'updated');
  assert.equal(pr.observedAt, refreshedAt);
  const details = service.details({ repository: '101', metric: 'stars' });
  assert.equal(details.observedAt, refreshedAt);
  assert.equal(details.items.find(x => x.id === star.id).observedAt, refreshedAt);
  assert.equal(service.dashboard().repos[0].lastActivityAt, DATE);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { assert.equal(db.prepare('SELECT observed_at FROM activity_feed WHERE id=?').get(star.id).observed_at, refreshedAt); } finally { db.close(); }
  state.now = '2026-06-21T12:00:30.000Z';
  await service.sync();
  assert.deepEqual(service.activity().events, updated, 'poll-only cycle retains prior provenance');
  state.now = '2026-06-22T12:00:00.000Z';
  state.feed = () => new Response('SYNTHETIC_ERROR', { status: 403 });
  await service.sync();
  assert.deepEqual(service.activity().events, updated, 'failed refresh retains prior provenance');
  await service.close();
  const restored = await createObservatory(config);
  try { assert.deepEqual(restored.activity().events, updated); } finally { await restored.close(); }
});

test('bounded feed retains actors and same-time identities, dedupes overlapping PR/release records and leaves metrics alone', async t => {
  const { service, state, calls } = await fixture(t);
  state.pulls = [{ number: 12, merged_at: DATE, updated_at: DATE, title: 'Real PR title', body: 'PR context', head: { ref: 'feature' }, base: { ref: 'main' }, user: { login: 'creator' } }];
  state.releases = [{ id: 42, published_at: DATE, draft: false, tag_name: 'v1', name: 'Real release', body: 'Release context', author: { login: 'releaser' } }];
  state.feed = [event(1, 'WatchEvent', { action: 'started' }), event(2, 'WatchEvent', { action: 'started' }, { actor: { login: 'other' } }), event(3, 'ForkEvent', { forkee: { id: 202, owner: { login: 'forker' }, name: 'forked' } }), event(4, 'PullRequestEvent', { action: 'closed', pull_request: { ...state.pulls[0], merged: true } }), event(5, 'ReleaseEvent', { action: 'published', release: state.releases[0] }), event(6, 'PushEvent', { ref: 'refs/heads/feature', head: 'def456', size: 2 }), event(7, 'IssueCommentEvent', { action: 'created', issue: { number: 13, title: 'Issue subject' }, comment: { id: 88, body: 'DO_NOT_STORE_COMMENT' } })];
  await service.sync();
  const first = service.activity({ limit: 2 });
  assert.equal(first.total, 8);
  assert.equal(first.hasMore, true);
  assert.equal(first.coverage.complete, false);
  const all = service.activity({ limit: 100 }).events;
  const paged = [];
  for (let offset = 0; offset < first.total; offset += 2) paged.push(...service.activity({ offset, limit: 2 }).events);
  assert.deepEqual(paged, all, 'same-time IDs must neither skip nor duplicate across pages');
  assert.equal(new Set(all.map(x => x.id)).size, all.length);
  assert.equal(all.filter(x => x.type === 'merged_prs').length, 1);
  assert.equal(all.filter(x => x.type === 'releases').length, 1);
  assert.deepEqual(all.filter(x => x.type === 'stars').map(x => x.actor.login).sort(), ['actor', 'other']);
  assert.equal(all.find(x => x.type === 'forks').url, 'https://github.com/forker/forked');
  assert.equal(all.find(x => x.type === 'pushes').metadata.branch, 'feature');
  assert.equal(all.find(x => x.type === 'merged_prs').metadata.head, 'feature');
  assert.ok(!JSON.stringify(all).includes('DO_NOT_STORE_COMMENT'));
  assert.ok(!JSON.stringify(all).includes('attacker.invalid'));
  assert.equal(service.dashboard('7').repos[0].metrics.commits.value, 1);
  assert.equal(service.dashboard('7').repos[0].metrics.stars.value, 7);
  const starDetails = service.details({ repository: '101', metric: 'stars', range: '7' });
  assert.equal(starDetails.kind, 'events');
  assert.equal(starDetails.total, 2);
  assert.equal(starDetails.complete, false);
  assert.equal(starDetails.status, 'partial');
  await service.sync();
  assert.deepEqual(service.activity({ limit: 100 }).events, all);
  assert.ok(calls.every(x => !x.init.headers.Authorization));
  state.commits = []; state.feed = [];
  await service.sync();
  assert.equal(service.dashboard('7').repos[0].metrics.commits.value, 0);
  assert.equal(service.activity().events.filter(x => x.type === 'pushes').length, 1);
  service.pauseWatch('101');
  assert.deepEqual(service.events(), { events: [] });
  assert.equal(service.activity().total, 0);
  assert.throws(() => service.activity({ repository: '101' }), error => error.statusCode === 404);
});

test('activity pagination and scope are strict, range all includes retained feed history without network I/O', async t => {
  const { service, state, calls } = await fixture(t);
  state.feed = [event(1, 'WatchEvent'), event(2, 'WatchEvent', {}, { created_at: '2026-05-01T00:00:00Z' })];
  await service.sync();
  const before = calls.length;
  assert.equal(service.activity({ range: '7' }).total, 2);
  assert.equal(service.activity({ range: 'all' }).total, 3);
  assert.equal(service.activity({ offset: 99 }).hasMore, false);
  assert.equal(service.activity({ limit: 500 }).limit, 500);
  for (const extra of [{ repository: '' }, { repository: '0101' }, { repository: 101 }, { range: '' }, { range: false }, { offset: null }, { offset: '01' }, { offset: -1 }, { offset: '1e2' }, { limit: 0 }, { limit: 501 }, { limit: ' 1' }]) assert.throws(() => service.activity(extra), error => error.statusCode === 400, JSON.stringify(extra));
  assert.throws(() => service.activity({ repository: '999' }), error => error.statusCode === 404);
  assert.equal(calls.length, before);
});

test('feed persists validated pages on later failure, resumes bounded pagination, and cannot erase metric success', async t => {
  const { service, state, calls } = await fixture(t, { maxPages: 1 });
  state.feed = url => Number(url.searchParams.get('page')) === 1 ? Response.json([event(1, 'WatchEvent')], { headers: { Link: '<https://attacker.invalid>; rel="next"' } }) : [event(2, 'WatchEvent')];
  await service.sync();
  assert.equal(service.activity().events.filter(x => x.type === 'stars').length, 1);
  assert.equal(service.status().runs.find(x => x.metric === 'activity').status, 'partial');
  await service.sync();
  assert.equal(service.activity().events.filter(x => x.type === 'stars').length, 2);
  assert.deepEqual(calls.filter(x => x.url.pathname.endsWith('/events')).map(x => x.url.searchParams.get('page')), ['1', '2']);
  state.feed = () => new Response('PRIVATE_ERROR', { status: 403 });
  await service.sync();
  assert.equal(service.status().runs.find(x => x.metric === 'activity').status, 'forbidden');
  assert.equal(service.dashboard('7').repos[0].metrics.commits.status, 'ok');
  assert.equal(service.activity().events.filter(x => x.type === 'stars').length, 2);
  assert.ok(!JSON.stringify(service.status()).includes('PRIVATE_ERROR'));
});

test('legacy events upgrade additively and restart without invented timestamps or loss', async t => {
  const { service, dbPath, config } = await fixture(t);
  await service.close();
  const db = new DatabaseSync(dbPath);
  db.exec('DROP VIEW activity_records; DROP TABLE activity_feed; DROP TABLE event_context; PRAGMA user_version=1;');
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run('101:commits:aaa', '101', 'commits', '2026-06-18', 'Old retained title', 'https://github.com/example/sample/commit/aaa', null);
  db.close();
  for (let i = 0; i < 2; i++) {
    const restored = await createObservatory({ ...config, fetchImpl: () => { throw new Error('No startup network'); } });
    try {
      assert.equal(restored.activity().total, 1);
      assert.equal(restored.activity().events[0].date, '2026-06-18');
      assert.equal(restored.dashboard().repos[0].lastActivityAt, undefined);
    } finally { await restored.close(); }
  }
});

test('current merged PR action dedupes with authoritative details and feed-only merges never change counts', async t => {
  const { service, state } = await fixture(t);
  state.pulls = [{ number: 12, merged_at: DATE, updated_at: DATE, title: 'Actual merge' }];
  state.feed = [event(1, 'PullRequestEvent', { action: 'merged', number: 12, pull_request: { number: 12, title: 'Actual merge' } }), event(2, 'PullRequestEvent', { action: 'merged', number: 99, pull_request: { number: 99, title: 'Only in feed' } })];
  await service.sync();
  assert.equal(service.activity().events.filter(x => x.type === 'merged_prs').length, 2);
  assert.equal(service.activity().events.filter(x => x.type === 'pull_requests').length, 0);
  assert.equal(service.details({ repository: '101', metric: 'merged_prs' }).total, 1);
  assert.equal(service.dashboard().repos[0].metrics.merged_prs.value, 1);
});

test('all event types retain only bounded safe metadata and no invented current PushEvent statistics', async t => {
  const { service, state } = await fixture(t);
  state.commits = [{ ...commit, author: null, commit: { ...commit.commit, message: 'Title\u0000\u202e safe\n\n' + 'Bounded prose '.repeat(100), author: { name: 'Local Author', email: 'private@example.invalid' } } }];
  state.releases = [{ id: 42, published_at: DATE, draft: false, tag_name: 'v1\nprivate@example.invalid', name: 'Release\u0000 title', body: '<b>Safe notes</b>\n```diff\nDIFF_CANARY\n```' }];
  state.feed = [event(1, 'PushEvent', { ref: 'refs/heads/main', head: 'abc123', commits: [{ message: 'DO_NOT_COPY_COMMITS', author: { email: 'private@example.invalid' } }] }), event(2, 'CreateEvent', { ref: 'new', ref_type: 'branch' }), event(3, 'DeleteEvent', { ref: 'old', ref_type: 'tag' }), event(4, 'IssuesEvent', { action: 'opened', issue: { number: 5, title: '<b>Safe</b>\u0000 title', body: 'DO_NOT_COPY_ISSUE' } }), event(5, 'PullRequestReviewEvent', { action: 'created', pull_request: { number: 8, title: 'Review subject' }, review: { body: 'DO_NOT_COPY_REVIEW' } }), event(6, 'PublicEvent'), event(7, 'GollumEvent'), event(8, 'MemberEvent'), event(9, 'CommitCommentEvent', { comment: { commit_id: 'abc123', body: 'DO_NOT_COPY_COMMENT', diff_hunk: 'DIFF_CANARY' } }), event(10, 'DiscussionEvent', { action: 'created', discussion: { number: 9, title: 'Discussion subject' } }), event(11, 'FutureNovelEvent', {}, { actor: { login: 'bad/../actor\n', name: 'Actual\u0000 Name', url: 'javascript:alert(1)' } })];
  await service.sync();
  const all = service.activity().events, serialized = JSON.stringify(all);
  for (const canary of ['private@example.invalid', 'DIFF_CANARY', 'DO_NOT_COPY', 'javascript:', '\\u0000', '\\u202e', '<b>']) assert.ok(!serialized.includes(canary), canary);
  for (const item of all) { assert.equal(new URL(item.url).origin, 'https://github.com'); assert.ok(!decodeURIComponent(item.url).includes('private@example.invalid')); assert.ok(!/[\u0000-\u001f]/.test(decodeURIComponent(item.url))); assert.ok(item.title.length <= 200); assert.ok(!item.summary || item.summary.length <= 500); }
  assert.equal(all.find(x => x.type === 'commits').actor.name, 'Local Author');
  assert.equal(all.find(x => x.type === 'commits').actor.login, undefined);
  assert.equal(all.find(x => x.type === 'pushes').metadata.commitCount, undefined);
  assert.equal(all.find(x => x.type === 'future_novel').actor.login, undefined);
  assert.equal(all.find(x => x.type === 'future_novel').actor.name, 'Actual Name');
});

test('feed caps at three pages, persists before rate failure, obeys poll delay and stays token-scoped', async t => {
  const { service, state, calls } = await fixture(t, { access: 'token' });
  state.feed = url => Response.json([event(Number(url.searchParams.get('page')), 'WatchEvent')], { headers: { Link: '<https://attacker.invalid>; rel="next"', 'X-Poll-Interval': '60' } });
  await service.sync();
  assert.equal(service.activity().events.filter(x => x.type === 'stars').length, 3);
  assert.equal(service.status().runs.find(x => x.metric === 'activity').status, 'partial');
  assert.equal(calls.filter(x => x.url.pathname.endsWith('/events')).length, 3);
  await service.sync();
  assert.equal(calls.filter(x => x.url.pathname.endsWith('/events')).length, 3);
  state.now = '2026-06-20T13:01:00.000Z';
  state.feed = url => url.searchParams.get('page') === '1' ? Response.json([event(4, 'WatchEvent')], { headers: { Link: '<https://attacker.invalid>; rel="next"' } }) : new Response('PRIVATE_ERROR', { status: 429, headers: { 'Retry-After': '120' } });
  await service.sync();
  assert.equal(service.activity().events.filter(x => x.type === 'stars').length, 4);
  assert.equal(service.status().runs.find(x => x.metric === 'activity').status, 'rate_limited');
  assert.ok(calls.every(x => x.init.headers.Authorization === 'Bearer synthetic-test-token'));
  assert.equal(service.dashboard().repos[0].lastActivityAt, DATE);
});

test('empty repositories distinguish the safe 409 status without exposing provider bodies', async t => {
  const { service, state } = await fixture(t);
  state.commits = () => Response.json({ message: 'Git Repository is empty.', debug: 'PRIVATE_ERROR' }, { status: 409 });
  await service.sync();
  assert.equal(service.status().runs.find(x => x.metric === 'commits').status, 'empty_repository');
  assert.match(service.status().runs.find(x => x.metric === 'commits').message, /empty/);
  assert.equal(service.dashboard().repos[0].metrics.commits, undefined);
  const empty = await createObservatory({ dbPath: ':memory:', fetchImpl: async () => Response.json({ message: 'Git Repository is empty.' }, { status: 409 }) });
  try { await assert.rejects(empty.addWatch({ repository: 'example/sample', access: 'public' }), error => error.statusCode === 409 && error.code === 'empty_repository'); } finally { await empty.close(); }
});

test('visibility, archive and literal repo-name search filter activity before totals and pagination', async t => {
  const { service, dbPath } = await fixture(t);
  await service.sync();
  const db = new DatabaseSync(dbPath);
  db.prepare('INSERT INTO repositories(id,owner,name,visibility,archived,branch,access) VALUES(?,?,?,?,?,?,?)').run('202', 'example', 'private-special', 'private', 1, 'main', 'token');
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run('202:commits:aaa', '202', 'commits', '2026-06-20', 'Private title', 'https://github.com/example/private-special/commit/aaa', null);
  db.close();
  assert.equal(service.activity({ visibility: 'public', limit: 1 }).events[0].repositoryId, '101');
  assert.equal(service.activity({ visibility: 'private', limit: 1 }).total, 1);
  assert.equal(service.activity({ archived: true }).events[0].repositoryId, '202');
  assert.equal(service.activity({ archived: 'false' }).total, 1);
  assert.equal(service.activity({ visibility: 'all', search: '  EXAMPLE/SAMPLE ' }).total, 1);
  assert.equal(service.activity({ search: '%' }).total, 0);
  assert.equal(service.activity({ search: 'private', offset: 1, limit: 1 }).total, 1);
  for (const extra of [{ visibility: '' }, { visibility: null }, { visibility: 'internal' }, { archived: '' }, { archived: '1' }, { archived: 1 }, { search: null }, { search: 'x'.repeat(201) }, { search: 'bad\u0000text' }]) assert.throws(() => service.activity(extra), error => error.statusCode === 400);
});

test('feed records and bounded-page cursor survive restart, malformed later pages retain valid records', async t => {
  const { service, state, config } = await fixture(t, { maxPages: 1 });
  state.feed = url => url.searchParams.get('page') === '1' ? Response.json([event(1, 'WatchEvent')], { headers: { Link: '<https://attacker.invalid>; rel="next"' } }) : [event(2, 'WatchEvent')];
  await service.sync();
  const saved = service.activity();
  await service.close();
  const restored = await createObservatory(config);
  try {
    assert.deepEqual(restored.activity(), saved);
    await restored.sync();
    assert.equal(restored.activity().events.filter(x => x.type === 'stars').length, 2);
    state.feed = [event(3, 'WatchEvent'), event(4, 'WatchEvent', {}, { created_at: '2026-02-30T00:00:00Z' })];
    await restored.sync();
    assert.equal(restored.status().runs.find(x => x.metric === 'activity').status, 'invalid_response');
    assert.equal(restored.activity().events.filter(x => x.type === 'stars').length, 2);
  } finally { await restored.close(); }
});

test('poll-only cycles do not claim a new success and a broken old page cannot pin collection forever', async t => {
  const { service, state } = await fixture(t, { maxPages: 1 });
  state.feed = () => Response.json([event(1, 'WatchEvent')], { headers: { 'X-Poll-Interval': '60' } });
  await service.sync();
  const success = service.status().runs.find(x => x.metric === 'activity').lastSuccess;
  state.now = '2026-06-20T12:00:30.000Z';
  await service.sync();
  assert.equal(service.status().runs.find(x => x.metric === 'activity').lastSuccess, success);
  state.now = '2026-06-20T13:01:00.000Z';
  state.feed = url => url.searchParams.get('page') === '1' ? Response.json([event(2, 'WatchEvent')], { headers: { Link: '<https://attacker.invalid>; rel="next"' } }) : new Response('PRIVATE_ERROR', { status: 404 });
  await service.sync(); await service.sync();
  state.feed = url => { assert.equal(url.searchParams.get('page'), '1'); return [event(3, 'WatchEvent')]; };
  await service.sync();
  assert.equal(service.activity().events.filter(x => x.type === 'stars').length, 3);
});
