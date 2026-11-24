// Read-only, bounded projection of existing application-owned snapshots.
// This module must never call sync, discovery, notificationContext or refresh.
import { aggregate, chartView, historyNote, presentRepository } from '../public/metrics.js';
import { activityText } from './data.mjs';

const METRICS = [
  ['stars', 'stars', 'Stars', 'Latest retained balances'],
  ['openIssues', 'issues', 'Open issues', 'Latest retained balances; excludes pull requests'],
  ['commits30d', 'commits', 'Commits', 'Totals over retained default-branch history; 30-day graph zoom'],
];
const INBOX_COVERAGE = 'Local Observatory inbox, not the GitHub notifications inbox. Retained events only; provider limits, delays and collection gaps apply.';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : null;
const timestamp = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

// Daily comparisons use the headline's exact observed contributor cohort.
// In particular, surviving-star reconstructions cannot measure lost stars.
function dailyChangeOf(projected, source, value, clock) {
  const result = { value: null, date: clock.date, previousDate: clock.previousDate, timeZone: 'UTC',
    basis: source === 'commits' ? 'retained-commit-history' : 'observed-balances', reason: null };
  const unavailable = reason => ({ ...result, reason: `Daily change for the headline's observed contributors unavailable: ${reason}` });
  const contributors = projected?.contributors || [];
  if (value === null || !contributors.length) return unavailable('no safe current total.');
  if (projected.chartComparable === false) return unavailable('observations are not comparable.');
  let current = 0, previous = 0;
  for (const repo of contributors) {
    const raw = repo.rawMetrics?.[source], metric = repo.metrics?.[source];
    const observedAt = timestamp(raw?.observedAt), availability = repo.metricAvailability?.[source]?.state;
    if (raw?.status !== 'ok' || (availability && availability !== 'available')) return unavailable('current collection is not available.');
    if (!observedAt || observedAt.slice(0, 10) !== clock.date || Date.parse(observedAt) > clock.time) {
      return unavailable('current observation is missing, stale or in the future.');
    }
    const history = raw.history;
    if (source === 'commits' && (!history || !['recorded', 'retained'].includes(history.kind) ||
      history.complete !== true || history.status !== 'complete')) return unavailable('retained commit history is missing or incomplete.');
    const series = source === 'commits' ? history.points : raw.points;
    // Require exactly one real point on each UTC day; never carry a value forward.
    const exact = date => {
      const matches = Array.isArray(series) ? series.filter(point => point.date === date) : [];
      return matches.length === 1 ? count(matches[0].value) : null;
    };
    const today = exact(clock.date), yesterday = exact(clock.previousDate);
    if (today === null || yesterday === null) return unavailable('exact today/yesterday points are missing or invalid.');
    if (count(metric?.value) === null || today !== metric.value || (source !== 'commits' && today !== raw.value)) {
      return unavailable('current points do not match the headline contributors.');
    }
    current += today; previous += yesterday;
    if (count(current) === null || count(previous) === null) return unavailable('comparison totals exceed safe integer limits.');
  }
  if (current !== value) return unavailable('current total does not match the headline.');
  const change = current - previous;
  return Number.isSafeInteger(change) ? { ...result, value: change } : unavailable('change exceeds safe integer limits.');
}

function summaryOf(service, clock) {
  let dashboard;
  try { dashboard = service.dashboard('30'); if (!Array.isArray(dashboard?.repos)) throw new Error(); }
  catch { dashboard = null; }
  const repos = dashboard?.repos?.map(repo => presentRepository(repo, 'totals')), coverage = {};
  const dates = (dashboard?.dates || []).slice(-30);
  const metrics = METRICS.map(([key, source, label, description]) => {
    const projected = aggregate(repos || [], source, dates);
    const observed = (repos || []).map(repo => ({ metric: repo.metrics?.[source], availability: repo.metricAvailability?.[source]?.state }))
      .filter(({ metric }) => count(metric?.value) !== null);
    const value = count(projected?.value);
    const complete = value !== null && observed.length === repos.length && observed.every(({ metric, availability }) =>
      metric.status === 'ok' && timestamp(metric.observedAt) !== null && (!availability || availability === 'available') && (source !== 'commits' || (metric.history || metric.coverage)?.complete === true));
    const observedDates = observed.map(({ metric }) => timestamp(metric.observedAt));
    coverage[key] = { observedRepositories: repos ? observed.length : null, totalRepositories: repos?.length ?? null, complete,
      oldestObservedAt: observedDates.length && observedDates.every(Boolean) ? observedDates.sort()[0] : null };
    const detail = !dashboard ? 'Summary unavailable.' : value === null ? `${description}; no observations available.`
      : `${description}; ${observed.length}/${repos.length} watched repositories observed${complete ? '.' : '; partial or stale coverage.'}`;
    const view = projected ? chartView(projected, dates, 'totals') : null;
    const comparable = projected?.chartComparable !== false;
    const points = (view?.points || dates.map(date => ({ date, value: null })))
      .map(point => ({ date: point.date, value: value !== null && comparable ? count(point.value) : null }));
    const history = projected?.history;
    const graph = { mode: 'totals', kind: view?.kind || 'balance', label: view?.label || 'Recorded history', comparable,
      coverage: { start: projected?.chartCoverage?.start ?? null, end: projected?.chartCoverage?.end ?? null,
        complete: value !== null && comparable && points.length > 0 && points.every(point => point.value !== null) && projected?.chartCoverage?.complete === true },
      history: history ? { kind: history.kind, status: history.status, complete: history.complete, from: history.from,
        baseline: count(history.baseline), label: text(history.label, 700) } : null };
    return { key, label, value, detail: detail + (history ? ` ${text(historyNote(projected), 700)}` : '') +
      (comparable ? '' : ' Latest balances are not comparable: different or unknown observation dates.'), points, graph,
      dailyChange: dailyChangeOf(projected, source, value, clock) };
  });
  return { summary: { repositories: repos?.length ?? null, metrics }, coverage,
    freshness: { updatedAt: timestamp(dashboard?.updatedAt), collecting: typeof dashboard?.collecting === 'boolean' ? dashboard.collecting : null },
    status: !dashboard ? 'error' : metrics.every(({ key }) => coverage[key].complete) ? 'ready' : 'partial' };
}

function inboxOf(notifications) {
  let inbox;
  try { inbox = notifications?.list({ offset: 0, limit: 5, unread: false }); }
  catch { return { status: 'error', unreadCount: null, items: [], hasMore: null, updatedAt: null, coverage: { complete: false, label: INBOX_COVERAGE + ' Inbox unavailable.' } }; }
  const status = !notifications ? 'not_configured' : ['ready', 'no_access', 'not_configured', 'error'].includes(inbox?.status) ? inbox.status : 'error';
  const items = (Array.isArray(inbox?.items) ? inbox.items : []).slice(0, 5).map(item => ({
    id: text(item.id, 64), title: text(item.title, 200), repository: text(item.repository, 150), type: text(item.type, 40),
    url: text(item.url, 500), actor: item.actor?.login ? { login: text(item.actor.login, 50) } : null, occurredAt: timestamp(item.occurredAt),
    readAt: timestamp(item.readAt), unread: item.readAt === null,
  }));
  return { status, unreadCount: status === 'ready' ? count(inbox?.unreadCount) : null, items,
    hasMore: status === 'ready' && typeof inbox?.hasMore === 'boolean' ? inbox.hasMore : null,
    updatedAt: timestamp(inbox?.updatedAt), coverage: { complete: false, label: text(inbox?.coverage?.label, 700) || INBOX_COVERAGE } };
}

function commitsOf(service) {
  try {
    const feed = service.activity({ type: 'commits', range: 'all', offset: 0, limit: 5 });
    if (!Array.isArray(feed?.events) || count(feed.total) === null || feed.events.length !== Math.min(feed.total, 5) ||
      feed.hasMore !== (feed.total > 5) || !['ready', 'partial'].includes(feed.status)) throw new Error();
    const items = feed.events.map(item => {
      // Identifiers/links stay exact or fail closed; only descriptive text is
      // normalized. Day-only legacy records must never acquire a fake midnight.
      const day = typeof item.date === 'string' ? item.date.slice(0, 10) : '';
      const validDay = /^\d{4}-\d{2}-\d{2}$/.test(day) && timestamp(day)?.slice(0, 10) === day;
      const occurredAt = validDay && item.date === day ? day : validDay && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(item.date) ? timestamp(item.date) : null;
      const prefix = `https://github.com/${item.repository}/commit/`;
      if (item.type !== 'commits' || typeof item.id !== 'string' || item.id.length > 128 || !/^[1-9]\d*:commits:[a-fA-F0-9]{1,64}$/.test(item.id) ||
        typeof item.repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(item.repository) ||
        ['.', '..'].includes(item.repository.split('/')[1]) || typeof item.url !== 'string' || item.url.length > 500 ||
        !item.url.startsWith(prefix) || !/^[a-fA-F0-9]{1,64}$/.test(item.url.slice(prefix.length)) || !occurredAt) throw new Error();
      const title = activityText(item.title);
      return { id: item.id, title: !title || /^Commit [a-fA-F0-9]{1,64}$/.test(title) ? 'Commit (title unavailable)' : title,
        repository: item.repository, url: item.url, author: activityText(item.author, 100) || null, occurredAt };
    });
    return { status: feed.status, items, hasMore: feed.hasMore, updatedAt: timestamp(feed.updatedAt),
      coverage: { complete: false, label: text(feed.coverage?.label, 700) || 'Retained commits only; full history is not guaranteed.' } };
  } catch {
    return { status: 'error', items: [], hasMore: null, updatedAt: null,
      coverage: { complete: false, label: 'Retained commits unavailable; full history is not guaranteed.' } };
  }
}

export function homePreview({ service, notifications, now = Date.now }) {
  const instant = new Date(now()), generatedAt = instant.toISOString();
  const date = generatedAt.slice(0, 10);
  const previousDate = new Date(Date.parse(date + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);
  const { summary, coverage, freshness, status: summaryStatus } = summaryOf(service, { time: instant.getTime(), date, previousDate });
  const inbox = inboxOf(notifications);
  const commits = commitsOf(service);
  const states = [summaryStatus, inbox.status, commits.status];
  const status = states.includes('error') ? 'error' : states.every(state => state === 'ready') ? 'ready' : 'partial';
  return { schemaVersion: 1, generatedAt, status, summary, freshness, coverage, notifications: inbox, commits };
}
