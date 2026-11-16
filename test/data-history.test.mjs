import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { createObservatory } from '../src/data.mjs';

const NOW = '2026-11-16T12:00:00.000Z';
const metadata = { id: 101, owner: { login: 'example' }, name: 'sample', private: false, archived: false, default_branch: 'main', stargazers_count: 0, forks_count: 0, created_at: '2010-01-01T00:00:00Z' };
const commit = (sha, date) => ({ sha, commit: { committer: { date: `${date}T01:00:00Z` }, message: 'Allowed title\n\nNEVER HISTORICAL BODY' } });
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'observatory-history-'));
  const dbPath = join(dir, 'db.sqlite'), calls = [];
  const state = { now: NOW, metadata: { ...metadata }, handlers: {} };
  const fetchImpl = async (input, init) => {
    const url = new URL(input), endpoint = url.pathname === '/user' ? 'user' : url.pathname.split('/').slice(4).join('/');
    calls.push({ url, init, endpoint });
    let data = state.handlers[endpoint];
    if (typeof data === 'function') data = await data(url);
    if (data === undefined) data = !endpoint ? state.metadata : endpoint.startsWith('traffic/') ? { [endpoint.split('/')[1]]: [] } : [];
    return data instanceof Response ? data : Response.json(data);
  };
  const config = { dbPath, token: 'synthetic-token', now: () => new Date(state.now), fetchImpl, ...options };
  const service = await createObservatory(config);
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  await service.addWatch({ repository: 'example/sample', access: config.token ? 'token' : 'public' });
  return { service, state, calls, dbPath, config };
}

test('history totals and baselines are DB-only, range-independent, and retain gaps beyond ten years', async t => {
  const { service, dbPath, calls } = await fixture(t);
  const db = new DatabaseSync(dbPath);
  for (const [day, value] of [['2010-01-01', 5], ['2026-11-01', 3], ['2026-11-16', 2]]) db.prepare('INSERT INTO points VALUES(?,?,?,?,?)').run('101', 'commits', day, value, NOW);
  db.close();
  const before = calls.length;
  const seven = service.dashboard('7').repos[0].metrics.commits;
  const month = service.dashboard('30').repos[0].metrics.commits;
  assert.equal(seven.value, 2);
  assert.equal(seven.history.value, 10);
  assert.equal(month.history.value, 10);
  assert.equal(seven.history.baseline, 8);
  assert.equal(month.history.baseline, 5);
  assert.equal(seven.history.points.at(-1).value, 10);
  assert.equal(seven.history.points[0].value, null);
  assert.equal(seven.history.complete, false);
  assert.equal(service.dashboard('all').dates[0], '2010-01-01');
  service.details({ repository: '101', metric: 'commits', range: 'all' });
  assert.equal(calls.length, before);
});

test('historical pages resume after failure and restart, dedupe, and completed backfills stay warm', async t => {
  const { service, state, config, dbPath, calls } = await fixture(t, { maxPages: 1 });
  let fail = true;
  state.handlers.commits = url => {
    if (url.searchParams.has('since')) return [commit('a', '2026-11-16')];
    const page = Number(url.searchParams.get('page'));
    if (page === 1) return Response.json([commit('b', '2010-01-01')], { headers: { link: '<https://attacker.invalid>; rel="next"' } });
    if (fail) return new Response('never expose', { status: 500 });
    return [commit('b', '2010-01-01'), commit('c', '2011-01-01')];
  };
  await service.sync();
  assert.equal(service.dashboard('7').repos[0].metrics.commits.history.value, 2);
  assert.equal(service.dashboard('7').repos[0].metrics.commits.history.status, 'backfilling');
  await service.sync();
  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare("SELECT page FROM history_jobs WHERE metric='commits'").get().page, 2);
  assert.equal(service.dashboard('7').repos[0].metrics.commits.history.status, 'error');
  db.close();
  await service.close();
  const reopened = await createObservatory(config);
  t.after(() => reopened.close());
  fail = false;
  await reopened.sync();
  const metric = reopened.dashboard('7').repos[0].metrics.commits;
  assert.equal(metric.history.value, 3);
  assert.equal(metric.history.complete, true);
  assert.equal(metric.history.points.at(-1).value, 3);
  assert.equal(metric.history.baseline, 2);
  const oldCalls = calls.filter(c => c.endpoint === 'commits' && !c.url.searchParams.has('since'));
  assert.deepEqual(oldCalls.map(c => c.url.searchParams.get('page')), ['1', '2', '2']);
  await reopened.sync();
  assert.equal(calls.filter(c => c.endpoint === 'commits' && !c.url.searchParams.has('since')).length, oldCalls.length);
  assert.equal(reopened.dashboard('30').repos[0].metrics.commits.history.value, 3);
  const inspect = new DatabaseSync(dbPath);
  assert.equal(inspect.prepare("SELECT COUNT(*) AS n FROM events WHERE type='commits'").get().n, 3);
  assert.ok(!inspect.prepare("SELECT context FROM event_context WHERE event_id='101:commits:b'").get().context.includes('NEVER HISTORICAL BODY'));
  inspect.close();
});

const weeklyHistory = () => Array.from({ length: 31 }, (_, index) => ({
  week: Date.parse('2026-11-15T00:00:00Z') / 1000 - index * 7 * 86400,
  days: [index === 0 || index === 30 ? 1 : 0, 0, 0, 0, 0, 0, 0],
}));
test('stars backfill beyond 180 days, resume on failure, reconcile a generation and never mix removed-star cohorts', async t => {
  const { service, state, calls, dbPath } = await fixture(t, { maxPages: 1 });
  let buckets = weeklyHistory(), fail = true;
  state.metadata.stargazers_count = 2;
  state.handlers['stargazers/history'] = url => {
    const page = Number(url.searchParams.get('page'));
    if (page === 2 && fail) return new Response('secret', { status: 500 });
    return buckets.slice((page - 1) * 30, page * 30);
  };
  await service.sync();
  let stars = service.dashboard('all').repos[0].metrics.stars;
  assert.equal(stars.history.status, 'backfilling');
  assert.equal(stars.history.points.filter(p => p.value !== null).length, 1, 'partial cohort cannot fabricate balances');
  await service.sync();
  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare("SELECT page FROM history_jobs WHERE metric='stars'").get().page, 2);
  fail = false;
  await service.sync();
  stars = service.dashboard('all').repos[0].metrics.stars;
  const oldest = new Date(buckets.at(-1).week * 1000).toISOString().slice(0, 10);
  assert.equal(stars.history.kind, 'reconstructed');
  assert.equal(stars.history.complete, true);
  assert.equal(stars.history.points.find(p => p.date === oldest).value, 1);
  assert.equal(stars.history.points.at(-1).value, 2);
  assert.equal(stars.points.filter(p => p.value !== null).length, 1, 'raw observations are not overwritten by reconstruction');
  assert.equal(service.dashboard('7').repos[0].metrics.star_activity.history.value, 2);
  const before = calls.length;
  await service.sync();
  assert.deepEqual(calls.slice(before).filter(c => c.endpoint === 'stargazers/history').map(c => c.url.searchParams.get('page')), ['1']);
  buckets = buckets.map((b, i) => i === 30 ? { ...b, days: [0, 0, 0, 0, 0, 0, 0] } : b);
  state.metadata.stargazers_count = 1;
  await service.sync();
  stars = service.dashboard('all').repos[0].metrics.stars;
  assert.equal(stars.history.value, 1);
  assert.equal(stars.history.complete, false);
  assert.equal(stars.history.points.find(p => p.date === oldest).value, null);
  assert.equal(db.prepare("SELECT generation FROM history_jobs WHERE metric='stars'").get().generation, 2);
  await service.sync();
  stars = service.dashboard('all').repos[0].metrics.stars;
  assert.equal(stars.history.complete, true);
  assert.equal(stars.history.points.find(p => p.date === oldest).value, 0);
  assert.match(stars.history.label, /removed stars/);
  assert.equal(service.dashboard('7').repos[0].metrics.star_activity.history.value, 1);
  db.close();
});

async function completedCohorts(t) {
  const fixtureState = await fixture(t);
  const { service, state } = fixtureState;
  state.metadata.stargazers_count = 2;
  state.metadata.forks_count = 2;
  state.handlers['stargazers/history'] = () => [{
    week: Date.parse('2026-11-15T00:00:00Z') / 1000,
    days: [state.metadata.stargazers_count, 0, 0, 0, 0, 0, 0],
  }];
  state.handlers.forks = () => Array.from({ length: state.metadata.forks_count }, (_, i) => ({ id: i + 1, created_at: '2026-11-15T00:00:00Z' }));
  await service.sync();
  for (const metric of ['stars', 'forks']) {
    const history = service.dashboard('7').repos[0].metrics[metric].history;
    assert.equal(history.complete, true);
    assert.equal(history.kind, 'reconstructed');
    assert.equal(history.points.find(p => p.date === '2026-11-15').value, 2);
  }
  return fixtureState;
}

function assertUnreconciledCohorts(service) {
  const metrics = service.dashboard('7').repos[0].metrics;
  for (const metric of ['stars', 'forks']) {
    const history = metrics[metric].history;
    assert.equal(history.complete, false, `${metric} must not remain complete after metadata changes`);
    assert.equal(history.status, 'limited');
    assert.equal(history.kind, 'recorded');
    assert.equal(history.points.find(p => p.date === '2026-11-15').value, null, 'obsolete inferred balances are suppressed');
    for (const point of metrics[metric].points.filter(p => p.value !== null)) {
      assert.equal(history.points.find(p => p.date === point.date).value, point.value, 'true observations survive');
    }
    assert.equal(history.points.at(-1).value, 1, 'latest metadata balance remains visible');
    assert.equal(history.value, 1);
    assert.match(history.label, /unavailable or incomplete/);
    assert.doesNotMatch(history.label, /current surviving/);
  }
  assert.equal(metrics.star_activity.history.complete, false, 'stale cohort buckets cannot claim completeness either');
}

test('re-adding a watch invalidates completed cohorts until reconciliation, including after restart', async t => {
  const { service, state, calls, config } = await completedCohorts(t);
  state.metadata.stargazers_count = 1;
  state.metadata.forks_count = 1;
  const before = calls.length;
  await service.addWatch({ repository: 'example/sample', access: 'token' });
  assertUnreconciledCohorts(service);
  assert.deepEqual(calls.slice(before).map(c => c.endpoint), [''], 're-add performs metadata only; dashboard stays DB-only');
  await service.close();
  const reopened = await createObservatory(config);
  t.after(() => reopened.close());
  assertUnreconciledCohorts(reopened);
  await reopened.sync();
  for (const metric of ['stars', 'forks']) {
    const history = reopened.dashboard('7').repos[0].metrics[metric].history;
    assert.equal(history.complete, true);
    assert.equal(history.kind, 'reconstructed');
    assert.equal(history.points.find(p => p.date === '2026-11-15').value, 1);
    assert.equal(history.points.find(p => p.date === '2026-11-16').value, 1, 'reconciliation never overwrites real observations');
  }
});

test('metadata invalidates completed cohorts before a paused mid-sync can skip reconciliation', async t => {
  const { service, state, calls } = await completedCohorts(t);
  state.now = '2026-11-17T12:00:00Z';
  state.metadata.stargazers_count = 1;
  state.metadata.forks_count = 1;
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  state.handlers.commits = async () => { entered(); await gate; return []; };
  const before = calls.length;
  const syncing = service.sync();
  await waiting;
  try {
    assertUnreconciledCohorts(service);
  } finally {
    service.pauseWatch('101');
    release();
    await syncing;
  }
  assert.ok(!calls.slice(before).some(c => ['stargazers/history', 'forks'].includes(c.endpoint)), 'pause skips both cohort collectors');
  await service.addWatch({ repository: 'example/sample', access: 'token' });
  assertUnreconciledCohorts(service);
  state.metadata.stargazers_count = 2;
  state.metadata.forks_count = 2;
  await service.addWatch({ repository: 'example/sample', access: 'token' });
  for (const metric of ['stars', 'forks']) {
    const history = service.dashboard('7').repos[0].metrics[metric].history;
    assert.equal(history.complete, false, 'returning to the old count does not revalidate the old cohort');
    assert.equal(history.kind, 'recorded');
    assert.equal(history.points.find(p => p.date === '2026-11-15').value, null);
  }
  await service.sync();
  for (const metric of ['stars', 'forks']) {
    const history = service.dashboard('7').repos[0].metrics[metric].history;
    assert.equal(history.complete, true, 'invalidated cohorts with a matching anchor can reconcile afresh');
    assert.equal(history.points.find(p => p.date === '2026-11-15').value, 2);
    assert.equal(history.points.find(p => p.date === '2026-11-16').value, 2);
  }
});

for (const metric of ['stars', 'forks']) for (const aba of [false, true]) for (const warm of [false, true]) {
  test(`${metric} ${warm ? 'warm refresh' : 'final verification'} rejects concurrent ${aba ? 'ABA 2→1→2' : '2→1'} and reconciles after restart`, async t => {
    const { service, state, config, dbPath, calls } = await fixture(t);
    const field = metric === 'stars' ? 'stargazers_count' : 'forks_count';
    const endpoint = metric === 'stars' ? 'stargazers/history' : 'forks';
    state.metadata[field] = 2;
    const cohort = () => metric === 'stars'
      ? [{ week: Date.parse('2026-11-15T00:00:00Z') / 1000, days: [state.metadata[field], 0, 0, 0, 0, 0, 0] }]
      : Array.from({ length: state.metadata[field] }, (_, i) => ({ id: i + 1, created_at: '2026-11-15T00:00:00Z' }));
    state.handlers[endpoint] = cohort;
    if (warm) {
      await service.sync();
      assert.equal(service.dashboard('7').repos[0].metrics[metric].history.complete, true);
    }
    let entered, release, verifying = false, held = false;
    const waiting = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    state.handlers[endpoint] = async () => {
      const response = Response.json(cohort()); // Freeze before concurrent metadata changes.
      if (warm && !held) { held = true; entered(); await gate; }
      else if (!warm) verifying = true;
      return response;
    };
    state.handlers[''] = async () => {
      const response = Response.json(state.metadata);
      if (!warm && verifying && !held) { held = true; entered(); await gate; }
      return response;
    };
    const syncing = service.sync();
    await waiting;
    try {
      state.metadata[field] = 1;
      await service.addWatch({ repository: 'example/sample', access: 'token' });
      if (aba) {
        state.metadata[field] = 2;
        await service.addWatch({ repository: 'example/sample', access: 'token' });
      }
    } finally { release(); await syncing; }
    const assertStale = active => {
      const result = active.dashboard('7').repos[0].metrics[metric];
      assert.equal(result.history.complete, false, 'an obsolete async response cannot publish completion');
      assert.equal(result.history.kind, 'recorded', 'obsolete reconstruction must be withdrawn');
      assert.equal(result.history.status, 'limited');
      assert.equal(result.history.points.find(p => p.date === '2026-11-15').value, null);
      assert.equal(result.history.value, aba ? 2 : 1);
      assert.equal(result.points.at(-1).value, aba ? 2 : 1, 'actual metadata observations win');
      assert.equal(result.history.points.at(-1).value, result.points.at(-1).value);
    };
    assertStale(service);
    const inspect = new DatabaseSync(dbPath);
    const stale = inspect.prepare('SELECT * FROM history_jobs WHERE metric=?').get(metric);
    assert.equal(stale.coherent, 0);
    assert.equal(stale.exhausted, 1, 'validated traversal and resume progress are retained');
    assert.equal(stale.checked_at, null, 'fresh reconciliation is durably required even for ABA');
    const retained = inspect.prepare('SELECT * FROM history_buckets WHERE metric=? ORDER BY generation,day').all(metric);
    assert.ok(retained.length > 0, 'do not erase retained cohort data');
    inspect.close();
    await service.close();
    const before = calls.length;
    const reopened = await createObservatory(config);
    t.after(() => reopened.close());
    assertStale(reopened);
    assert.equal(calls.length, before, 'startup and projections are network-free');
    const restarted = new DatabaseSync(dbPath);
    assert.deepEqual(restarted.prepare('SELECT * FROM history_jobs WHERE metric=?').get(metric), stale);
    assert.deepEqual(restarted.prepare('SELECT * FROM history_buckets WHERE metric=? ORDER BY generation,day').all(metric), retained);
    state.handlers[endpoint] = cohort;
    await reopened.sync();
    const reconciled = reopened.dashboard('7').repos[0].metrics[metric].history;
    assert.equal(reconciled.complete, true);
    assert.equal(reconciled.kind, 'reconstructed');
    assert.equal(reconciled.points.find(p => p.date === '2026-11-15').value, aba ? 2 : 1);
    assert.equal(reconciled.points.at(-1).value, aba ? 2 : 1);
    assert.equal(restarted.prepare('SELECT generation FROM history_jobs WHERE metric=?').get(metric).generation, stale.generation + 1);
    restarted.close();
  });
}

for (const metric of ['stars', 'forks']) test(`${metric} unfinished traversal keeps its revision across ABA and restart without rewinding`, async t => {
  const { service, state, config, dbPath, calls } = await fixture(t, { maxPages: 1 });
  const field = metric === 'stars' ? 'stargazers_count' : 'forks_count';
  const endpoint = metric === 'stars' ? 'stargazers/history' : 'forks';
  state.metadata[field] = 2;
  state.handlers[endpoint] = url => {
    const page = Number(url.searchParams.get('page'));
    const items = metric === 'stars'
      ? [{ week: Date.parse('2026-11-15T00:00:00Z') / 1000 - (page - 1) * 7 * 86400, days: [1, 0, 0, 0, 0, 0, 0] }]
      : [{ id: page, created_at: '2026-11-15T00:00:00Z' }];
    return Response.json(items, { headers: page === 1 ? { link: '<https://api.github.com/unused>; rel="next"' } : {} });
  };
  await service.sync();
  const inspect = new DatabaseSync(dbPath);
  const initial = inspect.prepare('SELECT * FROM history_jobs WHERE metric=?').get(metric);
  assert.equal(initial.page, 2);
  for (const value of [1, 2]) {
    state.metadata[field] = value;
    await service.addWatch({ repository: 'example/sample', access: 'token' });
  }
  const observation = inspect.prepare('SELECT * FROM cohort_observations WHERE metric=?').get(metric);
  assert.equal(observation.revision, initial.anchor_revision + 2, 'ABA increments twice even with the same observation timestamp');
  assert.deepEqual(inspect.prepare('SELECT * FROM history_jobs WHERE metric=?').get(metric), initial, 'metadata does not rewind unfinished pages');
  inspect.close();
  await service.close();
  const reopened = await createObservatory(config);
  t.after(() => reopened.close());
  const before = calls.length;
  await reopened.sync();
  assert.equal(calls.slice(before).find(c => c.endpoint === endpoint).url.searchParams.get('page'), '2');
  assert.equal(reopened.dashboard('7').repos[0].metrics[metric].history.complete, false);
  const restarted = new DatabaseSync(dbPath);
  const exhausted = restarted.prepare('SELECT * FROM history_jobs WHERE metric=?').get(metric);
  assert.equal(exhausted.exhausted, 1);
  assert.equal(exhausted.coherent, 0);
  assert.equal(exhausted.checked_at, null);
  assert.equal(exhausted.anchor_revision, initial.anchor_revision);
  assert.deepEqual(restarted.prepare('SELECT * FROM cohort_observations WHERE metric=?').get(metric), observation, 'equal metadata observations keep the persisted revision');
  await reopened.sync();
  assert.equal(reopened.dashboard('7').repos[0].metrics[metric].history.complete, false);
  await reopened.sync();
  assert.equal(reopened.dashboard('7').repos[0].metrics[metric].history.complete, true);
  assert.equal(restarted.prepare('SELECT generation FROM history_jobs WHERE metric=?').get(metric).generation, initial.generation + 1);
  restarted.close();
});

test('missing weekly buckets and fork network-count discrepancies stay limited, not fabricated zero history', async t => {
  const { service, state } = await fixture(t);
  state.metadata.stargazers_count = 2;
  state.metadata.forks_count = 2;
  const buckets = weeklyHistory();
  state.handlers['stargazers/history'] = [buckets[0], buckets[30]];
  state.handlers.forks = [{ id: 42, created_at: '2010-01-01T00:00:00Z', body: 'NEVER FORK BODY', owner: { email: 'NEVER EMAIL' } }];
  await service.sync();
  let metrics = service.dashboard('all').repos[0].metrics;
  for (const key of ['stars', 'forks']) {
    assert.equal(metrics[key].history.complete, false);
    assert.equal(metrics[key].history.status, 'limited');
    assert.equal(metrics[key].history.points.filter(p => p.value !== null).length, 1);
    assert.match(metrics[key].history.label, /discrepancy/);
  }
  assert.equal(metrics.star_activity.history.points.find(p => p.date === '2026-10-01').value, null);
  state.metadata.forks_count = 1;
  await service.sync();
  metrics = service.dashboard('all').repos[0].metrics;
  assert.equal(metrics.forks.history.complete, true);
  assert.equal(metrics.forks.history.kind, 'reconstructed');
  assert.equal(metrics.forks.history.points.find(p => p.date === '2010-01-01').value, 1);
  assert.equal(service.dashboard('7').repos[0].metrics.forks.history.value, 1);
  assert.match(metrics.forks.history.label, /deleted forks/);
});

test('merged PRs and published releases backfill old records; warm release refresh skips retained old pages', async t => {
  const { service, state, calls } = await fixture(t, { maxPages: 1 });
  state.handlers.pulls = [
    { number: 1, merged_at: null, updated_at: '2010-01-01T00:00:00Z' },
    { number: 2, merged_at: '2010-01-01T00:00:00Z', updated_at: '2010-01-01T00:00:00Z', title: 'Merged only', body: 'NEVER PR BODY' },
  ];
  state.handlers.releases = url => url.searchParams.get('page') === '1'
    ? Response.json([{ id: 1, tag_name: 'one', published_at: '2010-01-01T00:00:00Z', draft: false }], { headers: { link: '<https://evil.invalid>; rel="next"' } })
    : [{ id: 2, tag_name: 'two', published_at: '2011-01-01T00:00:00Z', draft: false }, { id: 3, draft: true }];
  await service.sync(); await service.sync();
  let metrics = service.dashboard('7').repos[0].metrics;
  assert.equal(metrics.merged_prs.history.value, 1);
  assert.equal(metrics.releases.history.value, 2);
  const before = calls.length;
  await service.sync();
  assert.deepEqual(calls.slice(before).filter(c => c.endpoint === 'releases').map(c => c.url.searchParams.get('page')), ['1']);
  metrics = service.dashboard('7').repos[0].metrics;
  assert.equal(metrics.releases.value, 0, 'proved exhausted historical pagination also covers the initial recent days');
  assert.equal(metrics.releases.history.value, 2);
  assert.equal(metrics.releases.history.complete, false);
  assert.equal(service.details({ repository: '101', metric: 'releases', range: 'all' }).total, 2);
});

test('warm release refresh preserves retained January context in November but omits summaries for new historical records', async t => {
  const { service, state, calls, dbPath } = await fixture(t, { maxPages: 1 });
  state.now = '2026-01-16T12:00:00Z';
  const retained = { id: 1, name: 'January release', tag_name: 'v1', published_at: '2026-01-01T12:00:00Z', draft: false, author: { login: 'maintainer' }, body: 'Retained release context.' };
  state.handlers.releases = [retained];
  await service.sync();
  const before = service.details({ repository: '101', metric: 'releases', range: 'all' }).items[0];
  assert.equal(before.summary, 'Retained release context.');
  const inspect = new DatabaseSync(dbPath);
  t.after(() => inspect.close());
  const contextBefore = inspect.prepare('SELECT * FROM event_context WHERE event_id=?').get(before.id);
  state.now = NOW;
  state.handlers.releases = Response.json([
    { id: 3, tag_name: 'v3', published_at: NOW, draft: false, body: 'Current release context.' },
    { id: 2, tag_name: 'v2', published_at: '2026-02-01T12:00:00Z', draft: false, body: 'NEVER NEW HISTORICAL RELEASE BODY' },
    { ...retained, body: 'Changed old body must not replace retained context.' },
  ], { headers: { link: '<https://api.github.com/repos/example/sample/releases?page=2>; rel="next"' } });
  const callCount = calls.length;
  await service.sync();
  const after = service.details({ repository: '101', metric: 'releases', range: 'all' });
  assert.deepEqual(after.items.find(item => item.id === before.id), before, 'old release retains its exact observed context, not a summary-less replacement');
  assert.deepEqual(inspect.prepare('SELECT * FROM event_context WHERE event_id=?').get(before.id), contextBefore);
  assert.equal(after.items.find(item => item.id === '101:releases:2').summary, undefined, 'new old records remain metadata-only');
  assert.equal(after.items.find(item => item.id === '101:releases:3').summary, 'Current release context.');
  assert.equal(after.total, 3);
  assert.equal(service.activity().events.find(item => item.id === before.id).summary, before.summary);
  assert.deepEqual(calls.slice(callCount).filter(c => c.endpoint === 'releases').map(c => c.url.searchParams.get('page')), ['1'], 'warm refresh stops on retained old record despite next link');
  assert.ok(!JSON.stringify(inspect.prepare('SELECT * FROM event_context').all()).includes('NEVER NEW HISTORICAL RELEASE BODY'));
});

test('traffic sums retained days only and issue balances never sum or invent reopen history', async t => {
  const { service, state, dbPath } = await fixture(t);
  const db = new DatabaseSync(dbPath);
  for (const [metric, day, value] of [['views', '2010-01-01', 3], ['views', '2026-11-15', 4], ['issues', '2010-01-01', 9], ['issues', '2026-11-15', 2]]) db.prepare('INSERT INTO points VALUES(?,?,?,?,?)').run('101', metric, day, value, NOW);
  db.close();
  const metrics = service.dashboard('7').repos[0].metrics;
  assert.equal(metrics.views.value, 4);
  assert.equal(metrics.views.history.value, 7);
  assert.equal(metrics.views.history.baseline, 3);
  assert.equal(metrics.views.history.points.at(-2).value, 7);
  assert.equal(metrics.views.history.points.at(-1).value, null);
  assert.equal(metrics.views.history.kind, 'retained');
  assert.match(metrics.views.history.label, /Since tracking began/);
  assert.equal(metrics.issues.history.value, 2);
  assert.equal(metrics.issues.history.baseline, null);
  assert.equal(metrics.issues.history.points.at(-2).value, 2);
  assert.equal(metrics.issues.history.complete, false);
  state.metadata.has_issues = false;
  await service.sync();
  assert.equal(service.dashboard('7').repos[0].metricAvailability.issues.state, 'disabled');
  assert.equal(service.dashboard('7').repos[0].metrics.issues.history.value, 2);
});

test('background notification identity is owner-scoped, cached per process, and invalidated by authentication failure', async t => {
  const { service, state, calls, config } = await fixture(t);
  state.handlers.user = { login: 'example', email: 'NEVER VIEWER EMAIL' };
  state.metadata = { ...metadata, id: 202, owner: { login: 'thirdparty' }, name: 'other' };
  await service.addWatch({ repository: 'thirdparty/other', access: 'public' });
  const before = calls.length;
  service.dashboard('7'); service.activity();
  assert.equal(calls.length, before);
  let result = await service.notificationContext();
  assert.equal(result.status, 'ready');
  assert.equal(result.viewer, 'example');
  assert.deepEqual(result.repositories.map(r => r.id), ['101']);
  assert.equal(result.coverage.complete, false);
  await service.notificationContext();
  assert.equal(calls.filter(c => c.endpoint === 'user').length, 1);
  state.handlers[''] = new Response('SECRET invalid credential', { status: 401 });
  await assert.rejects(service.addWatch({ repository: 'example/new', access: 'token' }));
  result = await service.notificationContext();
  assert.equal(result.status, 'no_access');
  assert.equal(result.viewer, null);
  assert.deepEqual(result.repositories, []);
  await service.close();
  state.handlers.user = { login: 'newviewer' };
  const reopened = await createObservatory({ ...config, token: 'different-synthetic-token' });
  t.after(() => reopened.close());
  result = await reopened.notificationContext();
  assert.equal(result.viewer, 'newviewer');
  assert.deepEqual(result.repositories, []);
  assert.equal(calls.filter(c => c.endpoint === 'user').length, 2);
  assert.ok(calls.filter(c => c.endpoint === 'user').every(c => c.init.headers.Authorization));
});

test('notification identity missing token and denied identity never infer an owner or fall back anonymously', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'observatory-identity-'));
  const without = await createObservatory({ dbPath: join(directory, 'without.sqlite'), fetchImpl: () => { throw new Error('network forbidden'); } });
  t.after(async () => { await without.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal((await without.notificationContext()).status, 'not_configured');
  const { service, state, calls } = await fixture(t);
  state.handlers.user = new Response('private', { status: 403 });
  const result = await service.notificationContext();
  assert.equal(result.status, 'no_access');
  assert.equal(result.viewer, null);
  assert.deepEqual(result.repositories, []);
  await service.notificationContext();
  assert.equal(calls.filter(c => c.endpoint === 'user').length, 1);
});

test('comment metadata persists only bounded mentions and validated specific URLs, never comment bodies', async t => {
  const { service, state, dbPath } = await fixture(t);
  state.handlers.events = [{ id: '111', type: 'IssueCommentEvent', created_at: NOW, actor: { login: 'contributor' }, payload: {
    issue: { number: 7, title: 'Issue title' },
    comment: { id: 123, html_url: 'https://github.com/example/sample/issues/7#issuecomment-123', body: 'NEVER COMMENT BODY @Example\n```js\n@notcode\n```\n`@inlinecode` person@example.invalid' },
  } }];
  await service.sync();
  const record = service.activity().events.find(e => e.type === 'issue_comment');
  assert.deepEqual(record.metadata.mentions, ['example']);
  assert.equal(record.metadata.commentId, 123);
  assert.equal(record.url, 'https://github.com/example/sample/issues/7#issuecomment-123');
  const db = new DatabaseSync(dbPath);
  const dump = db.prepare("SELECT context FROM activity_feed WHERE type='issue_comment'").get().context;
  assert.ok(!dump.includes('NEVER COMMENT BODY'));
  assert.ok(!dump.includes('notcode'));
  db.close();
});

test('v3 SQLite backup migrates without network, lost content, changed source, or restart drift', async t => {
  const { service, dbPath, config } = await fixture(t);
  await service.close();
  const source = new DatabaseSync(dbPath);
  source.exec('DROP TABLE history_buckets; DROP TABLE history_members; DROP TABLE history_jobs; DROP TABLE cohort_observations; ALTER TABLE repositories DROP COLUMN created_day; PRAGMA user_version=3;');
  source.prepare('INSERT INTO points VALUES(?,?,?,?,?)').run('101', 'commits', '2010-01-01', 9, NOW);
  source.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run('101:commits:a', '101', 'commits', '2010-01-01', 'Retained exact title', 'https://github.com/example/sample/commit/a', null);
  const tables = source.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  const dump = db => Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
  const before = dump(source), destination = `${dbPath}.migrated`;
  await backup(source, destination);
  let network = 0;
  const migrated = await createObservatory({ ...config, dbPath: destination, fetchImpl: () => { network++; throw new Error('forbidden'); } });
  assert.equal(migrated.dashboard('7').repos[0].metrics.commits.history.value, 9);
  assert.equal(migrated.details({ repository: '101', metric: 'commits', range: 'all' }).items[0].title, 'Retained exact title');
  const inspect = new DatabaseSync(destination);
  const after = dump(inspect);
  for (const row of after.repositories) delete row.created_day;
  assert.deepEqual(after, before);
  assert.equal(inspect.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(inspect.prepare('PRAGMA user_version').get().user_version, 5);
  inspect.close();
  await migrated.close();
  const reopened = await createObservatory({ ...config, dbPath: destination, fetchImpl: () => { network++; throw new Error('forbidden'); } });
  assert.equal(reopened.dashboard('all').repos[0].metrics.commits.history.value, 9);
  await reopened.close();
  assert.deepEqual(dump(source), before);
  assert.equal(source.prepare('PRAGMA user_version').get().user_version, 3);
  source.close();
  assert.equal(network, 0);
});

test('v4 cohort migration preserves every original column and fails closed until fresh reconciliation', async t => {
  const { service, config, dbPath } = await completedCohorts(t);
  await service.close();
  const source = new DatabaseSync(dbPath);
  source.exec('DROP TABLE cohort_observations; ALTER TABLE history_jobs DROP COLUMN anchor_revision; PRAGMA user_version=4;');
  const columns = source.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => ({
    name, columns: source.prepare(`PRAGMA table_info("${name}")`).all().map(c => c.name),
  }));
  const hashes = db => Object.fromEntries(columns.map(({ name, columns }) => [name, createHash('sha256')
    .update(JSON.stringify(db.prepare(`SELECT ${columns.map(c => `"${c}"`).join(',')} FROM "${name}" ORDER BY rowid`).all())).digest('hex')]));
  const original = hashes(source), destination = `${dbPath}.v5`;
  await backup(source, destination);
  let network = 0;
  const offline = { ...config, dbPath: destination, fetchImpl: () => { network++; throw new Error('network forbidden'); } };
  for (let restart = 0; restart < 2; restart++) {
    const migrated = await createObservatory(offline);
    try {
      const inspect = new DatabaseSync(destination);
      try {
        assert.deepEqual(hashes(inspect), original, 'all original table contents survive migration and reopen');
        assert.equal(inspect.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        assert.equal(inspect.prepare('PRAGMA user_version').get().user_version, 5);
        const changes = inspect.prepare('PRAGMA data_version').get().data_version;
        for (const range of ['7', '30', 'all']) for (const metric of ['stars', 'forks']) {
          const history = migrated.dashboard(range).repos[0].metrics[metric].history;
          assert.equal(history.complete, false, 'unversioned legacy coherence cannot certify current history');
          assert.equal(history.kind, 'recorded');
          assert.equal(history.value, 2, 'actual retained observations remain usable');
        }
        assert.equal(inspect.prepare('PRAGMA data_version').get().data_version, changes, 'projections perform no writes');
      } finally { inspect.close(); }
    } finally { await migrated.close(); }
  }
  assert.equal(network, 0);
  assert.deepEqual(hashes(source), original, 'source backup is untouched');
  assert.equal(source.prepare('PRAGMA user_version').get().user_version, 4);
  source.close();
  const reconciled = await createObservatory({ ...config, dbPath: destination });
  try {
    await reconciled.sync();
    for (const metric of ['stars', 'forks']) assert.equal(reconciled.dashboard('7').repos[0].metrics[metric].history.complete, true);
  } finally { await reconciled.close(); }
});

test('history access errors preserve cached totals and never expand token identity', async t => {
  const { service, state, calls, dbPath } = await fixture(t, { maxPages: 1 });
  state.metadata.private = true;
  let denied = false;
  state.handlers.commits = url => url.searchParams.has('since') ? [] : denied ? new Response('SECRET', { status: 403 })
    : Response.json([commit('a', '2010-01-01')], { headers: { link: '<https://evil.invalid/>; rel="next"' } });
  await service.sync();
  denied = true;
  await service.sync();
  const metric = service.dashboard('7').repos[0].metrics.commits;
  assert.equal(metric.history.value, 1);
  assert.equal(metric.history.status, 'no_access');
  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare("SELECT page FROM history_jobs WHERE metric='commits'").get().page, 2);
  db.close();
  assert.ok(calls.every(c => c.init.headers.Authorization === 'Bearer synthetic-token'));
  assert.ok(!JSON.stringify(service.status()).includes('SECRET'));
});

test('a large public recent family yields budget to resumable history and other families', async t => {
  const { service, state, calls } = await fixture(t, { maxPages: 100, token: '' });
  state.handlers.commits = url => {
    const page = Number(url.searchParams.get('page'));
    if (url.searchParams.has('since')) return Response.json([commit(page.toString(16), '2026-11-16')], { headers: { link: '<https://evil.invalid>; rel="next"' } });
    return page === 1 ? Response.json([commit('abc', '2026-11-16')], { headers: { link: '<https://evil.invalid>; rel="next"' } }) : [commit('def', '2010-01-01')];
  };
  await service.sync();
  state.now = '2026-11-16T13:01:00Z';
  await service.sync();
  const metric = service.dashboard('7').repos[0].metrics.commits;
  assert.equal(metric.history.value, 2);
  assert.equal(metric.history.complete, false, 'a failed current refresh remains a visible limitation');
  assert.ok(service.status().runs.find(r => r.metric === 'history_commits').lastSuccess);
  assert.ok(service.status().runs.find(r => r.metric === 'activity').lastSuccess);
  assert.ok(calls.every(c => !Object.hasOwn(c.init.headers, 'Authorization')));
  assert.deepEqual(calls.filter(c => c.endpoint === 'commits' && !c.url.searchParams.has('since')).map(c => c.url.searchParams.get('page')), ['1', '2']);
});

test('changing cohort anchors cannot rewind unfinished pages or turn mixed generations into complete history', async t => {
  const { service, state, calls, dbPath } = await fixture(t, { maxPages: 1 });
  const buckets = weeklyHistory();
  state.metadata.stargazers_count = 2;
  state.handlers['stargazers/history'] = url => buckets.slice((Number(url.searchParams.get('page')) - 1) * 30, Number(url.searchParams.get('page')) * 30);
  await service.sync();
  state.metadata.stargazers_count = 3;
  const before = calls.length;
  await service.sync();
  assert.equal(calls.slice(before).find(c => c.endpoint === 'stargazers/history').url.searchParams.get('page'), '2');
  assert.equal(service.dashboard('7').repos[0].metrics.stars.history.complete, false);
  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare("SELECT exhausted FROM history_jobs WHERE metric='stars'").get().exhausted, 1);
  await service.sync();
  assert.equal(db.prepare("SELECT generation FROM history_jobs WHERE metric='stars'").get().generation, 2);
  db.close();
});
