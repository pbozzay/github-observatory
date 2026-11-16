import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createNotifications, withNotifications } from '../src/notifications.mjs';

const NOW = new Date('2026-06-20T12:00:00Z');
const owned = { id: '101', owner: 'viewer', name: 'sample' };
const other = { id: '202', owner: 'someone', name: 'third' };
const context = () => ({ viewer: 'viewer', repositories: [owned, other], status: 'ready', coverage: { complete: false, label: 'Retained events only.' } });
const event = (id, extra = {}) => ({ id: `github:${id}`, repositoryId: '101', repository: 'viewer/sample', source: 'github_events', type: 'pull_requests', metadata: { action: 'opened', number: 3 }, date: NOW.toISOString(), title: 'Untrusted title with private@example.invalid', url: 'https://github.com/viewer/sample/pull/3', actor: { login: 'contributor' }, ...extra });
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'observatory-notifications-'));
  const state = { events: [], context: context(), calls: [], contextCalls: 0 };
  const service = {
    async notificationContext() { state.contextCalls++; if (state.failure) throw new Error('private failure'); return state.context; },
    activity({ offset, limit }) { state.calls.push(offset); const events = state.events.slice(offset, offset + limit); return { events, total: state.events.length, hasMore: offset + events.length < state.events.length }; }
  };
  const settings = { dbPath: join(directory, 'notifications.sqlite'), service, now: () => NOW, ...options };
  let inbox = createNotifications(settings);
  t.after(async () => { await inbox.close(); await rm(directory, { recursive: true, force: true }); });
  return { state, service, settings, directory, get inbox() { return inbox; }, async reopen() { await inbox.close(); inbox = createNotifications(settings); return inbox; } };
}

test('only verified owned other-user actionable GitHub Events enter the durable local inbox', async t => {
  const f = await fixture(t);
  f.state.events = [event(1), event(2, { actor: { login: 'VIEWER' } }), event(3, { repositoryId: '202', repository: 'someone/third', url: 'https://github.com/someone/third/pull/3' }), event(4, { type: 'stars' }), event(5, { source: 'commits' }), event(6, { actor: {} }), event(7, { metadata: { action: 'closed', number: 3 } }), event(8, { date: '2020-01-01' })];
  await f.inbox.refresh();
  const result = f.inbox.list();
  assert.equal(result.status, 'ready'); assert.equal(result.total, 1); assert.equal(result.unreadCount, 1);
  assert.equal(result.coverage.complete, false); assert.equal(result.items[0].actor.login, 'contributor');
  assert.equal(result.items[0].repository, 'viewer/sample'); assert.equal(result.items[0].occurredAt, NOW.toISOString());
  assert.ok(!JSON.stringify(result).includes('private@example')); assert.equal(result.items[0].readAt, null);
  f.inbox.markRead({ id: result.items[0].id });
  await f.inbox.refresh(); assert.equal(f.inbox.list().total, 0);
  await f.reopen(); await f.inbox.refresh();
  assert.equal(f.inbox.list({ unread: false }).total, 1); assert.equal(f.inbox.list().unreadCount, 0);
});

test('each supported action is an immutable item; a new comment on a read PR remains unread', async t => {
  const f = await fixture(t);
  const actions = { pull_requests: ['opened', 'reopened', 'review_requested'], issues: ['opened', 'reopened', 'assigned'], issue_comment: ['created'], pull_request_review: ['submitted'], pull_request_review_comment: ['created'], discussion_comment: ['created'] };
  f.state.events = Object.entries(actions).flatMap(([type, values]) => values.map(action => event(`${type}-${action}`, { type, metadata: { action, number: 3 } })));
  await f.inbox.refresh();
  const before = f.inbox.list(); assert.equal(before.total, 10);
  f.inbox.markAllRead({ through: before.snapshot });
  f.state.events.unshift(event('new-comment', { type: 'issue_comment', metadata: { action: 'created', number: 3, commentURL: 'https://github.com/viewer/sample/pull/3#issuecomment-42' } }));
  await f.inbox.refresh();
  // A stale displayed snapshot cannot clear later arrivals, even on the same PR.
  f.inbox.markAllRead({ through: before.snapshot });
  const after = f.inbox.list(); assert.equal(after.total, 1); assert.equal(after.unreadCount, 1);
  assert.equal(after.items[0].url, 'https://github.com/viewer/sample/pull/3#issuecomment-42');
  assert.equal(f.inbox.list({ unread: false }).total, 11);
  assert.throws(() => f.inbox.markAllRead({ through: after.snapshot + 1 }), { statusCode: 400 });
  for (const through of [-1, '0', 0.5, null, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => f.inbox.markAllRead({ through }), { statusCode: 400 });
  f.inbox.markAllRead({ through: 0 }); assert.equal(f.inbox.list().unreadCount, 1);
});

test('cached reads never reacquire identity or reprocess activity and validate bounded pagination', async t => {
  const f = await fixture(t); f.state.events = [event(1), event(2), event(3)]; await f.inbox.refresh();
  const count = [f.state.contextCalls, f.state.calls.length];
  const page = f.inbox.list({ offset: '1', limit: '1', unread: 'false' });
  assert.equal(page.total, 3); assert.equal(page.items.length, 1); assert.equal(page.hasMore, true);
  assert.equal(f.inbox.list({ offset: 3 }).hasMore, false);
  for (const query of [{ limit: 101 }, { limit: 0 }, { offset: -1 }, { offset: '01' }, { offset: '' }, { offset: '1e2' }, { unread: '1' }]) assert.throws(() => f.inbox.list(query), { statusCode: 400 });
  assert.deepEqual([f.state.contextCalls, f.state.calls.length], count);
  assert.throws(() => f.inbox.markRead({ id: "x' OR 1=1--" }), { statusCode: 400 });
  assert.throws(() => f.inbox.markRead({ id: 'a'.repeat(64) }), { statusCode: 404 });
  assert.equal(f.inbox.list().unreadCount, 3);
});

test('context failure retains stale inbox; verified empty scope and missing identity are not conflated', async t => {
  const f = await fixture(t); f.state.events = [event(1)]; await f.inbox.refresh();
  const updated = f.inbox.list().updatedAt;
  f.state.failure = true; await f.inbox.refresh();
  assert.equal(f.inbox.list().status, 'error'); assert.equal(f.inbox.list().total, 1); assert.equal(f.inbox.list().updatedAt, updated); assert.match(f.inbox.list().coverage.label, /stale/);
  f.state.failure = false; f.state.context = { ...context(), status: 'no_access', viewer: null };
  await f.inbox.refresh(); assert.equal(f.inbox.list().status, 'no_access'); assert.equal(f.inbox.list().total, 1);
  f.state.context = { ...context(), viewer: null }; await f.inbox.refresh(); assert.equal(f.inbox.list().status, 'error');
  f.state.context = { ...context(), repositories: [] }; await f.inbox.refresh();
  assert.equal(f.inbox.list().status, 'ready'); assert.equal(f.inbox.list().total, 0);
  f.state.context = context(); await f.inbox.refresh(); assert.equal(f.inbox.list().total, 1);
  f.state.context = { status: 'not_configured' }; await f.inbox.refresh();
  assert.equal(f.inbox.list().status, 'not_configured'); assert.equal(f.inbox.list().items.length, 0);
});

test('pausing hides counts without deleting state; changing verified identity never leaks another inbox', async t => {
  const f = await fixture(t); f.state.events = [event(1), event(2)]; await f.inbox.refresh();
  const id = f.inbox.list().items[0].id; f.inbox.markRead({ id }); f.inbox.hideRepository('101');
  assert.equal(f.inbox.list({ unread: false }).total, 0); assert.equal(f.inbox.list().unreadCount, 0);
  assert.throws(() => f.inbox.markRead({ id }), { statusCode: 404 });
  f.state.context.repositories = [other]; await f.inbox.refresh(); assert.equal(f.inbox.list().total, 0);
  f.state.context = context(); await f.inbox.refresh(); assert.equal(f.inbox.list().unreadCount, 1);
  f.state.context = { ...context(), viewer: 'different' }; await f.inbox.refresh(); assert.equal(f.inbox.list({ unread: false }).total, 0);
  f.state.context = context(); await f.inbox.refresh(); assert.equal(f.inbox.list().unreadCount, 1);
});

for (const change of ['identity', 'empty scope', 'narrowed scope']) {
  for (const failure of ['activity', 'transaction']) {
    test(`verified ${change} restricts reads durably despite ${failure} failure`, async t => {
      const f = await fixture(t, { maxPages: 2, pageSize: 2 });
      const retained = { id: '303', owner: 'viewer', name: 'retained' };
      const original = { ...context(), repositories: [owned, retained] };
      f.state.context = original;
      f.state.events = Array.from({ length: 6 }, (_, i) => event(i));
      f.state.events[1] = event('retained', { repositoryId: '303', repository: 'viewer/retained', url: 'https://github.com/viewer/retained/pull/3' });
      await f.inbox.refresh();
      const before = f.inbox.list({ unread: false });
      const hidden = before.items.filter(item => item.repositoryId === '101');
      f.inbox.markRead({ id: hidden[0].id });
      const db = new DatabaseSync(f.settings.dbPath);
      const snapshot = () => ({
        rows: db.prepare('SELECT * FROM notifications ORDER BY seq').all(),
        checkpoint: db.prepare("SELECT * FROM notification_state WHERE key IN ('scope','scanOffset','updatedAt') ORDER BY key").all()
      });
      try {
        const saved = snapshot();
        assert.equal(saved.checkpoint.find(row => row.key === 'scanOffset').value, '4');
        f.state.context = change === 'identity'
          ? { ...context(), viewer: 'different', repositories: [{ ...owned, owner: 'different' }] }
          : { ...context(), repositories: change === 'empty scope' ? [] : [retained] };
        if (change !== 'empty scope') {
          const repository = change === 'identity' ? 'different/sample' : 'viewer/retained';
          f.state.events.unshift(event('new-scoped', { repositoryId: change === 'identity' ? '101' : '303', repository, url: `https://github.com/${repository}/pull/3` }));
        }
        const activity = f.service.activity;
        const entered = Promise.withResolvers(), release = Promise.withResolvers();
        f.service.activity = async query => {
          entered.resolve(); await release.promise;
          if (failure === 'activity') throw new Error('synthetic activity failure');
          return activity(query);
        };
        if (failure === 'transaction') {
          // Fail at commit even for an empty eligible scope, which has no inserts.
          db.exec("CREATE TRIGGER reject_checkpoint BEFORE INSERT ON notification_state WHEN NEW.key='scanOffset' BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END");
        }
        const refresh = f.inbox.refresh(); await entered.promise;
        const pending = f.inbox.list({ unread: false });
        release.resolve(); await refresh;
        const expected = change === 'narrowed scope' ? 1 : 0;
        assert.equal(pending.total, expected, 'new scope applies before activity settles');
        const assertRestricted = () => {
          assert.equal(f.inbox.list().status, 'error');
          assert.equal(f.inbox.list({ unread: false }).total, expected);
          assert.equal(f.inbox.list().unreadCount, expected);
          assert.equal(f.inbox.list().updatedAt, before.updatedAt);
          for (const item of hidden) assert.throws(() => f.inbox.markRead({ id: item.id }), { statusCode: 404 });
        };
        assertRestricted(); assert.deepEqual(snapshot(), saved, 'failed ingestion preserves rows and checkpoint');
        await f.reopen(); assertRestricted();
        f.state.failure = true; await f.inbox.refresh(); assertRestricted();
        f.inbox.markAllRead({ through: before.snapshot });
        assert.deepEqual(snapshot().rows.filter(row => row.repository_id === '101'), saved.rows.filter(row => row.repository_id === '101'), 'bulk read cannot mutate hidden rows');
        if (failure === 'transaction') db.exec('DROP TRIGGER reject_checkpoint');
        f.state.failure = false; f.state.context = original; f.service.activity = activity;
        await f.inbox.refresh();
        const restored = f.inbox.list({ unread: false }).items;
        for (const item of hidden) assert.equal(restored.find(row => row.id === item.id).readAt, item.id === hidden[0].id ? NOW.toISOString() : null);
      } finally { db.close(); }
    });
  }
}

test('bounded scan resumes durably, checks newest arrivals and never claims full coverage', async t => {
  const f = await fixture(t, { maxPages: 2, pageSize: 2 });
  f.state.events = Array.from({ length: 9 }, (_, i) => event(i));
  await f.inbox.refresh(); assert.deepEqual(f.state.calls, [0, 2]); assert.equal(f.inbox.list().total, 4); assert.match(f.inbox.list().coverage.label, /capped/);
  await f.reopen(); f.state.calls = []; await f.inbox.refresh();
  assert.deepEqual(f.state.calls, [0, 4]); assert.equal(f.inbox.list().total, 6);
  f.state.events.unshift(event('new')); f.state.calls = []; await f.inbox.refresh();
  assert.deepEqual(f.state.calls, [0, 6]); assert.equal(f.inbox.list().total, 8);
  await f.inbox.refresh(); assert.equal(f.inbox.list().total, 10); assert.equal(f.inbox.list().coverage.complete, false);
  f.state.calls = []; await f.inbox.refresh(); assert.deepEqual(f.state.calls, [0, 2]);
});

test('scan stops at the 30-day boundary and rejects misleading empty partial pages', async t => {
  const f = await fixture(t, { maxPages: 3, pageSize: 2 });
  f.state.events = [event(1), event(2, { date: '2026-01-01' }), event(3, { date: '2025-01-01' })];
  await f.inbox.refresh(); assert.deepEqual(f.state.calls, [0]); assert.equal(f.inbox.list().total, 1);
  f.service.activity = () => ({ events: [], total: 20, hasMore: true }); await f.inbox.refresh();
  assert.equal(f.inbox.list().status, 'error'); assert.equal(f.inbox.list().total, 1);
});

test('only exact repository HTTPS URLs and bounded actor identifiers are retained', async t => {
  const f = await fixture(t);
  const invalidURLs = ['https://evil.invalid/viewer/sample/pull/3', 'http://github.com/viewer/sample/pull/3', 'https://github.com/viewer/other/pull/3', 'https://github.com/viewer/sample-evil/pull/3', 'https://github.com/viewer/sample/pull/3?secret=1', 'https://user:pass@github.com/viewer/sample/pull/3', 'https://github.com/viewer/sample/pull/3#evil', 'https://github.com/viewer/sample/pull/3/../../other/3', 'https://github.com/viewer/sample/pull/%33'];
  f.state.events = invalidURLs.map((url, i) => event(i, { url }));
  f.state.events.push(event('mail', { actor: { login: 'someone@example.invalid' } }), event('malformed-actor', { actor: { login: 'someone-' } }), event('future', { date: '2027-01-01' }), event('safe'));
  await f.inbox.refresh(); assert.equal(f.inbox.list().total, 1);
});

test('storage files stay private, writer lock is stable and failed startup releases ownership', async t => {
  const f = await fixture(t); const inode = (await stat(f.settings.dbPath + '.writer.sqlite')).ino;
  for (const name of await readdir(f.directory)) assert.equal((await stat(join(f.directory, name))).mode & 0o777, 0o600, name);
  assert.throws(() => createNotifications(f.settings), { code: 'busy' });
  await f.reopen(); assert.equal((await stat(f.settings.dbPath + '.writer.sqlite')).ino, inode);
  await f.inbox.close();
  await writeFile(f.settings.dbPath, 'synthetic corrupt database');
  assert.throws(() => createNotifications(f.settings), { code: 'storage' });
  await rm(f.settings.dbPath); await f.reopen();
  const db = new DatabaseSync(f.settings.dbPath, { readOnly: true });
  try { assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1); } finally { db.close(); }
});

test('transaction failure preserves prior items, scope, checkpoint and read state', async t => {
  const f = await fixture(t); f.state.events = [event(1)]; await f.inbox.refresh();
  const before = f.inbox.list(); f.inbox.markRead({ id: before.items[0].id });
  const db = new DatabaseSync(f.settings.dbPath);
  try {
    db.exec("CREATE TRIGGER reject_notification BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END");
    f.state.events.unshift(event(2)); await f.inbox.refresh();
    assert.equal(f.inbox.list().status, 'error'); assert.equal(f.inbox.list().snapshot, before.snapshot);
    assert.equal(f.inbox.list({ unread: false }).total, 1); assert.equal(f.inbox.list().unreadCount, 0);
    db.exec('DROP TRIGGER reject_notification');
  } finally { db.close(); }
  await f.inbox.refresh(); assert.equal(f.inbox.list().status, 'ready'); assert.equal(f.inbox.list().unreadCount, 1);
});

test('unknown future schema fails closed without losing existing records or retaining the writer', async t => {
  const f = await fixture(t); f.state.events = [event(1)]; await f.inbox.refresh();
  f.inbox.markAllRead({ through: f.inbox.list().snapshot }); await f.inbox.close();
  const db = new DatabaseSync(f.settings.dbPath);
  try {
    db.exec('PRAGMA user_version=42');
    assert.throws(() => createNotifications(f.settings), { code: 'storage' });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notifications').get().count, 1);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 42);
    db.exec('PRAGMA user_version=1');
  } finally { db.close(); }
  await f.reopen(); await f.inbox.refresh(); assert.equal(f.inbox.list().unreadCount, 0); assert.equal(f.inbox.list({ unread: false }).total, 1);
});

test('refresh is singleflight; close drains refresh and keeps its lock until completion', async t => {
  const f = await fixture(t); const gate = Promise.withResolvers(); let calls = 0;
  f.service.notificationContext = async () => { calls++; await gate.promise; return context(); };
  const first = f.inbox.refresh(), second = f.inbox.refresh(); assert.equal(first, second); assert.equal(calls, 1);
  const closing = f.inbox.close(); assert.equal(closing, f.inbox.close());
  assert.throws(() => createNotifications(f.settings), { code: 'busy' });
  gate.resolve(); await closing; await f.reopen();
});

test('facade refreshes after successful and failed sync, pauses locally and closes in order', async () => {
  const order = [], gate = Promise.withResolvers(); let broken = false;
  const raw = { async sync() { order.push('sync'); await gate.promise; if (broken) throw new Error('sync failed'); return 'result'; }, async pauseWatch(id) { order.push(`pause:${id}`); }, async close() { order.push('service-close'); } };
  const notifications = { async refresh() { order.push('refresh'); }, hideRepository(id) { order.push(`hide:${id}`); }, async close() { order.push('inbox-close'); } };
  const service = withNotifications(raw, notifications);
  const first = service.sync(); assert.equal(first, service.sync()); gate.resolve(); assert.equal(await first, 'result');
  broken = true; await assert.rejects(service.sync(), /sync failed/);
  await service.pauseWatch('101'); await service.close(); assert.equal(service.close(), service.close());
  assert.deepEqual(order, ['sync', 'refresh', 'sync', 'refresh', 'pause:101', 'hide:101', 'inbox-close', 'service-close']);
  await assert.rejects(service.sync(), { statusCode: 503 });
});

for (const changedIdentity of [false, true]) {
  test(`a pause during pending context preserves restrictions (${changedIdentity ? 'new' : 'same'} viewer)`, async t => {
    const f = await fixture(t);
    const retained = { id: '303', owner: 'viewer', name: 'retained' };
    f.state.context = { ...context(), repositories: [owned, retained] };
    f.state.events = [event(1), event(2, { repositoryId: '303', repository: 'viewer/retained', url: 'https://github.com/viewer/retained/pull/3' })];
    await f.inbox.refresh();
    const before = f.inbox.list(), calls = f.state.calls.length;
    const gate = Promise.withResolvers();
    f.service.notificationContext = () => gate.promise;
    const refresh = f.inbox.refresh();
    f.inbox.hideRepository('101');
    gate.resolve(changedIdentity ? { ...context(), viewer: 'different', repositories: [{ ...retained, owner: 'different' }] } : f.state.context);
    await refresh;
    assert.equal(f.state.calls.length, calls, 'defer ingestion of a context invalidated by pause');
    for (const restart of [false, true]) {
      if (restart) await f.reopen();
      const result = f.inbox.list();
      assert.equal(result.status, 'error');
      assert.equal(result.total, changedIdentity ? 0 : 1);
      assert.equal(result.unreadCount, changedIdentity ? 0 : 1);
      assert.equal(result.snapshot, before.snapshot);
      for (const item of before.items.filter(item => changedIdentity || item.repositoryId === '101')) assert.throws(() => f.inbox.markRead({ id: item.id }), { statusCode: 404 });
    }
  });
}

test('a pause during an asynchronous scan cannot resurrect the paused scope', async t => {
  const f = await fixture(t); f.state.events = [event(1)]; await f.inbox.refresh();
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(), activity = f.service.activity;
  f.service.activity = async query => { entered.resolve(); await gate.promise; return activity(query); };
  const refresh = f.inbox.refresh(); await entered.promise;
  f.inbox.hideRepository('101'); gate.resolve(); await refresh;
  assert.equal(f.inbox.list().unreadCount, 0);
});
