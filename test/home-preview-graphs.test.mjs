import test from 'node:test';
import assert from 'node:assert/strict';
import { homePreview } from '../src/home-preview.mjs';
import { aggregate, chartView } from '../public/metrics.js';

const dates = Array.from({ length: 35 }, (_, i) => new Date(Date.UTC(2026, 4, i + 1)).toISOString().slice(0, 10));
const at = dates.at(-1) + 'T12:00:00.000Z';
const points = values => dates.map((date, i) => ({ date, value: values[i] ?? null }));
function metric(value, values, extra = {}) {
  return { value, kind: 'balance', status: 'ok', observedAt: at, points: points(values), coverage: { complete: true }, ...extra };
}
function preview(repos, selectedDates = dates) {
  let calls = 0;
  const result = homePreview({ service: { dashboard: range => {
    calls++; assert.equal(range, '30'); return { repos, dates: selectedDates, updatedAt: at, collecting: false };
  } }, notifications: { list: () => ({ status: 'ready', unreadCount: 0, items: [], hasMore: false }) } });
  assert.equal(calls, 1);
  return result;
}

test('graphs reuse app aggregate/totals and retained baselines, bounded to 30 points', () => {
  const values = dates.map((_, i) => 100 + i);
  const repos = [{ metrics: {
    stars: metric(134, values), issues: metric(134, values),
    commits: metric(30, dates.map(() => 1), { kind: 'event', history: {
      value: 134, points: points(values), baseline: 99, from: '2026-01-01',
      kind: 'recorded', status: 'limited', complete: false, label: 'Partial recorded history; cached totals only.',
    } }),
  } }];
  const result = preview(repos);
  for (const [i, source] of ['stars', 'issues', 'commits'].entries()) {
    const m = result.summary.metrics[i], expected = aggregate(repos, source, dates.slice(-30));
    assert.equal(m.value, expected.value);
    assert.deepEqual(m.points, chartView(expected, dates.slice(-30), 'totals').points);
    assert.equal(m.points.length, 30);
    assert.equal(m.graph.mode, 'totals');
    assert.equal(m.graph.kind, 'balance');
    assert.deepEqual(m.graph.coverage, expected.chartCoverage);
  }
  const commits = result.summary.metrics[2];
  assert.equal(commits.key, 'commits30d');
  assert.equal(commits.label, 'Commits');
  assert.equal(commits.value, 134, 'not the selected-window total of 30');
  assert.equal(commits.points[0].value, 105, 'zoom must not reset the retained baseline');
  assert.equal(commits.graph.history.baseline, 99);
  assert.equal(commits.graph.history.complete, false);
  assert.equal(result.coverage.commits30d.complete, false);
  assert.match(commits.detail, /Partial recorded history/);
});

test('graphs retain null gaps and use every headline contributor, not a better-covered subset', () => {
  const repos = [
    { metrics: { stars: metric(5, [1, 2, 3, 4, 5]) } },
    { metrics: { stars: metric(7, [null, 2, null, 6, 7]) } },
    { metrics: {} },
  ];
  const result = preview(repos, dates.slice(0, 5)), m = result.summary.metrics[0];
  assert.equal(m.value, 12);
  assert.deepEqual(m.points.map(p => p.value), [null, 4, null, 10, 12]);
  assert.equal(result.coverage.stars.observedRepositories, 2);
  assert.equal(result.coverage.stars.totalRepositories, 3);
  assert.equal(result.coverage.stars.complete, false);
  assert.equal(m.graph.coverage.complete, false);
});

test('zero is observed; missing history, empty watches and unsafe totals never invent a graph', () => {
  const zero = preview([{ metrics: { stars: metric(0, [null, 0, null]) } }], dates.slice(0, 3));
  assert.deepEqual(zero.summary.metrics[0].points.map(p => p.value), [null, 0, null]);
  for (const repos of [[], [{ metrics: {} }], [{ metrics: { stars: metric(8, []) } }],
    [{ metrics: { stars: metric(Number.MAX_SAFE_INTEGER, [Number.MAX_SAFE_INTEGER]) } }, { metrics: { stars: metric(1, [1]) } }]]) {
    const m = preview(repos, dates.slice(0, 3)).summary.metrics[0];
    assert.deepEqual(m.points.map(p => p.value), [null, null, null]);
  }
});

test('noncomparable latest balances cannot draw a graph under a mixed-date headline', () => {
  const repos = [{ metrics: { issues: metric(5, [5, 5]) } },
    { metrics: { issues: metric(7, [7, 7], { observedAt: '2026-01-01T00:00:00.000Z' }) } }];
  const m = preview(repos, dates.slice(0, 2)).summary.metrics[1];
  assert.equal(m.value, 12);
  assert.equal(m.graph.comparable, false);
  assert.deepEqual(m.points.map(p => p.value), [null, null]);
  assert.equal(m.graph.coverage.complete, false);
});

test('unknown history totals are authoritative rather than falling back to window counts', () => {
  const result = preview([{ metrics: { commits: metric(3, [1, 2], { kind: 'event', history: {
    value: null, points: [], kind: 'recorded', complete: false, status: 'backfilling', label: 'Backfilling',
  } }) } }], dates.slice(0, 2));
  assert.equal(result.summary.metrics[2].value, null);
  assert.deepEqual(result.summary.metrics[2].points.map(p => p.value), [null, null]);
  assert.equal(result.coverage.commits30d.observedRepositories, 0);
});
