import test from 'node:test';
import assert from 'node:assert/strict';
import { homePreview } from '../src/home-preview.mjs';

const today = '2026-06-01', yesterday = '2026-05-31';
const now = Date.parse(today + 'T12:00:00Z');
const points = (previous, current) => [{ date: yesterday, value: previous }, { date: today, value: current }];
function balance(previous = 10, current = 13, extra = {}) {
  return { kind: 'balance', value: current, status: 'ok', observedAt: today + 'T11:00:00Z', points: points(previous, current), ...extra };
}
function commits(previous = 1000, current = 1003, extra = {}) {
  return balance(2, 3, { kind: 'event', history: {
    value: current, points: points(previous, current), baseline: 998, from: '2025-01-01',
    kind: 'recorded', complete: true, status: 'complete', label: 'Retained default-branch history',
  }, ...extra });
}
function preview(repos, options = {}) {
  return homePreview({ service: { dashboard: range => {
    assert.equal(range, '30');
    return { repos, dates: [yesterday, today], updatedAt: today + 'T11:00:00Z' };
  } }, now: () => now, ...options });
}
const metric = (repos, key = 'stars', options) => preview(repos, options).summary.metrics.find(m => m.key === key);
const expected = (value, basis = 'observed-balances') => ({ value, date: today, previousDate: yesterday, timeZone: 'UTC', basis, reason: null });
function unknown(result) {
  assert.equal(result.dailyChange.value, null);
  assert.equal(result.dailyChange.date, today);
  assert.equal(result.dailyChange.previousDate, yesterday);
  assert.match(result.dailyChange.reason, /headline's observed contributors unavailable:/);
}

test('daily change preserves positive, negative and zero integers in all three metrics', () => {
  for (const delta of [3, -1, 0]) {
    const result = preview([{ metrics: { stars: balance(10, 10 + delta), issues: balance(10, 10 + delta), commits: commits(1000, 1000 + delta) } }]);
    assert.deepEqual(result.summary.metrics[0].dailyChange, expected(delta));
    assert.deepEqual(result.summary.metrics[1].dailyChange, expected(delta));
    assert.deepEqual(result.summary.metrics[2].dailyChange, expected(delta, 'retained-commit-history'));
  }
  for (const [previous, current] of [[0, 0], [0, Number.MAX_SAFE_INTEGER], [Number.MAX_SAFE_INTEGER, 0]]) {
    const result = preview([{ metrics: { stars: balance(previous, current), issues: balance(previous, current), commits: commits(previous, current) } }]);
    for (const m of result.summary.metrics) assert.equal(m.dailyChange.value, current - previous);
  }
});

test('unstar uses real balances even while the surviving-star graph rises', () => {
  const stars = balance(10, 9, { history: { value: 9, points: points(7, 9),
    kind: 'reconstructed', complete: true, status: 'complete' } });
  const result = metric([{ metrics: { stars } }]);
  assert.deepEqual(result.points, points(7, 9));
  assert.deepEqual(result.dailyChange, expected(-1));
  stars.points = [{ date: today, value: 9 }];
  unknown(metric([{ metrics: { stars } }]));
});

test('only exact UTC today and yesterday count: no last-two-available or carryforward', () => {
  for (const source of ['stars', 'issues', 'commits']) {
    const key = { stars: 'stars', issues: 'openIssues', commits: 'commits30d' }[source];
    for (const series of [[], [{ date: today, value: 13 }],
      [{ date: '2026-05-30', value: 10 }, { date: today, value: 13 }],
      [{ date: '2026-05-30', value: 10 }, { date: yesterday, value: 13 }],
      [{ date: yesterday, value: 10 }, { date: '2026-06-02', value: 13 }],
      [{ date: yesterday + 'T00:00:00Z', value: 10 }, { date: today, value: 13 }],
      [...points(10, 13), { date: yesterday, value: 10 }]]) {
      const raw = source === 'commits' ? commits(10, 13) : balance();
      (source === 'commits' ? raw.history : raw).points = series;
      unknown(metric([{ metrics: { [source]: raw } }], key));
    }
  }
});

test('every contributor requires a successful, available and fresh nonfuture observation', () => {
  for (const source of ['stars', 'issues', 'commits']) {
    const key = { stars: 'stars', issues: 'openIssues', commits: 'commits30d' }[source];
    const create = () => source === 'commits' ? commits() : balance();
    for (const observedAt of [null, undefined, '', 'bad timestamp', yesterday + 'T23:59:59Z',
      today + 'T12:00:00.001Z', '2026-06-02T00:00:00Z']) {
      unknown(metric([{ metrics: { [source]: { ...create(), observedAt } } }], key));
    }
    for (const status of [undefined, 'error', 'collecting', 'partial', 'no_access']) {
      unknown(metric([{ metrics: { [source]: { ...create(), status } } }], key));
    }
    for (const state of ['disabled', 'error', 'not_collected', 'no_access']) {
      unknown(metric([{ metrics: { [source]: create() }, metricAvailability: { [source]: { state } } }], key));
    }
    const raw = { ...create(), observedAt: today + 'T05:00:00-07:00' };
    assert.equal(metric([{ metrics: { [source]: raw }, metricAvailability: { [source]: { state: 'available' } } }], key).dailyChange.value, 3);
  }
});

test('partial headline cohorts remain valid, but no contributor can be dropped for comparison', () => {
  for (const source of ['stars', 'issues', 'commits']) {
    const key = { stars: 'stars', issues: 'openIssues', commits: 'commits30d' }[source];
    const create = () => source === 'commits' ? commits(10, 13) : balance();
    const repos = [{ metrics: { [source]: create() } }, { metrics: { [source]: create() } }, { metrics: {} }];
    const result = preview(repos);
    assert.equal(result.coverage[key].complete, false);
    assert.equal(result.summary.metrics.find(m => m.key === key).value, 26);
    assert.equal(result.summary.metrics.find(m => m.key === key).dailyChange.value, 6);
    const second = source === 'commits' ? repos[1].metrics[source].history : repos[1].metrics[source];
    second.points[0].value = null;
    unknown(metric(repos, key));
    second.points[0].value = 10;
    repos[1].metrics[source].observedAt = yesterday + 'T23:00:00Z';
    unknown(metric(repos, key));
  }
});

test('null, invalid, unsafe and inconsistent comparison values never become a delta', () => {
  for (const source of ['stars', 'issues', 'commits']) {
    const key = { stars: 'stars', issues: 'openIssues', commits: 'commits30d' }[source];
    const create = () => source === 'commits' ? commits(10, 13) : balance();
    for (const invalid of [null, undefined, NaN, Infinity, -1, 0.5, '10', Number.MAX_SAFE_INTEGER + 1]) {
      for (const day of [0, 1]) {
        const raw = create();
        (source === 'commits' ? raw.history : raw).points[day].value = invalid;
        unknown(metric([{ metrics: { [source]: raw } }], key));
      }
      const raw = create();
      (source === 'commits' ? raw.history : raw).value = invalid;
      unknown(metric([{ metrics: { [source]: raw } }], key));
    }
    const raw = create();
    (source === 'commits' ? raw.history : raw).points[1].value = 12;
    unknown(metric([{ metrics: { [source]: raw } }], key));
    // Previous aggregate overflow, even though today's headline is safe.
    const one = create(), two = create();
    (source === 'commits' ? one.history : one).points[0].value = Number.MAX_SAFE_INTEGER;
    unknown(metric([{ metrics: { [source]: one } }, { metrics: { [source]: two } }], key));
    // Current aggregate overflow is also unknown, not a smaller cohort.
    (source === 'commits' ? one.history : one).value = Number.MAX_SAFE_INTEGER;
    (source === 'commits' ? one.history : one).points[1].value = Number.MAX_SAFE_INTEGER;
    unknown(metric([{ metrics: { [source]: one } }, { metrics: { [source]: two } }], key));
  }
  // Offsetting inconsistencies must not pass merely because the aggregate matches.
  unknown(metric([{ metrics: { stars: balance(1, 4, { points: points(1, 5) }) } },
    { metrics: { stars: balance(1, 6, { points: points(1, 5) }) } }]));
  const stars = balance(10, 14, { history: { value: 13, points: points(10, 13), kind: 'reconstructed' } });
  unknown(metric([{ metrics: { stars } }]));
});

test('commit change uses complete retained cumulative history, not window counts or a reset baseline', () => {
  const raw = commits();
  const result = metric([{ metrics: { commits: raw } }], 'commits30d');
  assert.equal(result.value, 1003);
  assert.equal(result.graph.history.baseline, 998);
  assert.deepEqual(result.dailyChange, expected(3, 'retained-commit-history'));
  for (const history of [undefined, null, { ...raw.history, complete: false }, { ...raw.history, kind: 'reconstructed' },
    ...['backfilling', 'limited', 'no_access', 'error', 'not_collected', undefined].map(status => ({ ...raw.history, status }))]) {
    unknown(metric([{ metrics: { commits: { ...raw, history } } }], 'commits30d'));
  }
  assert.equal(metric([{ metrics: { commits: { ...raw, history: { ...raw.history, kind: 'retained' } } } }], 'commits30d').dailyChange.value, 3);
});

test('empty or failed dashboards keep null metadata and existing contract', () => {
  for (const repos of [[], [{ metrics: {} }]]) {
    const result = preview(repos);
    assert.equal(result.schemaVersion, 1);
    assert.deepEqual(result.summary.metrics.map(m => m.key), ['stars', 'openIssues', 'commits30d']);
    result.summary.metrics.forEach(unknown);
  }
  const failed = preview([], { service: { dashboard: () => { throw new Error('private diagnostic'); } } });
  assert.equal(failed.status, 'error');
  failed.summary.metrics.forEach(unknown);
  assert.ok(!JSON.stringify(failed).includes('private diagnostic'));
});

test('one injected clock anchors all metrics and generatedAt at UTC midnight', () => {
  for (const time of ['2026-06-01T00:00:00Z', '2026-01-01T00:00:00Z', '2024-03-01T00:00:00Z', '2026-11-01T23:59:59.999-07:00']) {
    const instant = new Date(time), date = instant.toISOString().slice(0, 10);
    const previousDate = new Date(Date.parse(date + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);
    let calls = 0;
    const raw = balance(10, 13, { observedAt: instant.toISOString(), points: [{ date: previousDate, value: 10 }, { date, value: 13 }] });
    const result = preview([{ metrics: { stars: raw, issues: raw, commits: { ...raw, kind: 'event', history: {
      ...commits().history, value: 13, points: raw.points,
    } } } }], { now: () => instant.getTime() + calls++ * 86_400_000 });
    assert.equal(calls, 1);
    assert.equal(result.generatedAt, instant.toISOString());
    for (const m of result.summary.metrics) {
      assert.equal(m.dailyChange.date, date);
      assert.equal(m.dailyChange.previousDate, previousDate);
      assert.equal(m.dailyChange.value, 3);
    }
  }
});

test('daily metadata reads the one existing dashboard only and never mutates snapshots or notifications', () => {
  const snapshot = { dates: [yesterday, today], repos: [{ metrics: { stars: balance(), issues: balance(), commits: commits() } }] };
  const before = structuredClone(snapshot);
  const freeze = object => { Object.values(object).filter(value => value && typeof value === 'object').forEach(freeze); Object.freeze(object); };
  freeze(snapshot);
  let dashboards = 0, inboxes = 0;
  const forbidden = () => assert.fail('unexpected collector or external action');
  const service = new Proxy({ dashboard: range => { dashboards++; assert.equal(range, '30'); return snapshot; } }, {
    get: (target, key) => key in target ? target[key] : forbidden,
  });
  const notifications = new Proxy({ list: options => {
    inboxes++; assert.deepEqual(options, { offset: 0, limit: 5, unread: false });
    return { status: 'ready', unreadCount: 0, items: [], hasMore: false };
  } }, { get: (target, key) => key in target ? target[key] : forbidden });
  const result = homePreview({ service, notifications, now: () => now });
  assert.equal(dashboards, 1);
  assert.equal(inboxes, 1);
  assert.deepEqual(snapshot, before);
  assert.equal(result.notifications.unreadCount, 0);
  result.summary.metrics.forEach(m => assert.equal(m.dailyChange.value, 3));
});
