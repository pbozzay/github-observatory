// Read-only, bounded projection of existing application-owned snapshots.
// This module must never call sync, discovery, notificationContext or refresh.
const METRICS = [
  ['stars', 'stars', 'Stars', 'Latest retained balances'],
  ['openIssues', 'issues', 'Open issues', 'Latest retained balances; excludes pull requests'],
  ['commits30d', 'commits', 'Commits (30d)', 'Retained default-branch commits in the last 30 UTC days'],
];
const INBOX_COVERAGE = 'Local Observatory inbox, not the GitHub notifications inbox. Retained events only; provider limits, delays and collection gaps apply.';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : null;
const timestamp = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function summaryOf(service) {
  let dashboard;
  try { dashboard = service.dashboard('30'); if (!Array.isArray(dashboard?.repos)) throw new Error(); }
  catch { dashboard = null; }
  const repos = dashboard?.repos, coverage = {};
  const metrics = METRICS.map(([key, source, label, description]) => {
    const observed = (repos || []).map(repo => ({ metric: repo.metrics?.[source], availability: repo.metricAvailability?.[source]?.state }))
      .filter(({ metric }) => count(metric?.value) !== null);
    const sum = observed.reduce((total, { metric }) => total + metric.value, 0);
    const value = observed.length ? count(sum) : null;
    const complete = value !== null && observed.length === repos.length && observed.every(({ metric, availability }) =>
      metric.status === 'ok' && timestamp(metric.observedAt) !== null && (!availability || availability === 'available') && (source !== 'commits' || metric.coverage?.complete === true));
    const dates = observed.map(({ metric }) => timestamp(metric.observedAt));
    coverage[key] = { observedRepositories: repos ? observed.length : null, totalRepositories: repos?.length ?? null, complete,
      oldestObservedAt: dates.length && dates.every(Boolean) ? dates.sort()[0] : null };
    const detail = !dashboard ? 'Summary unavailable.' : value === null ? `${description}; no observations available.`
      : `${description}; ${observed.length}/${repos.length} watched repositories observed${complete ? '.' : '; partial or stale coverage.'}`;
    return { key, label, value, detail };
  });
  return { summary: { repositories: repos?.length ?? null, metrics }, coverage,
    freshness: { updatedAt: timestamp(dashboard?.updatedAt), collecting: typeof dashboard?.collecting === 'boolean' ? dashboard.collecting : null },
    status: !dashboard ? 'error' : metrics.every(({ key }) => coverage[key].complete) ? 'ready' : 'partial' };
}

function inboxOf(notifications) {
  let inbox;
  try { inbox = notifications?.list({ offset: 0, limit: 8, unread: true }); }
  catch { return { status: 'error', unreadCount: null, items: [], hasMore: null, updatedAt: null, coverage: { complete: false, label: INBOX_COVERAGE + ' Inbox unavailable.' } }; }
  const status = !notifications ? 'not_configured' : ['ready', 'no_access', 'not_configured', 'error'].includes(inbox?.status) ? inbox.status : 'error';
  const items = (Array.isArray(inbox?.items) ? inbox.items : []).filter(item => item?.readAt === null).slice(0, 8).map(item => ({
    id: text(item.id, 64), title: text(item.title, 200), repository: text(item.repository, 150), type: text(item.type, 40),
    url: text(item.url, 500), actor: item.actor?.login ? { login: text(item.actor.login, 50) } : null, occurredAt: timestamp(item.occurredAt),
  }));
  return { status, unreadCount: status === 'ready' ? count(inbox?.unreadCount) : null, items,
    hasMore: status === 'ready' && typeof inbox?.hasMore === 'boolean' ? inbox.hasMore : null,
    updatedAt: timestamp(inbox?.updatedAt), coverage: { complete: false, label: text(inbox?.coverage?.label, 700) || INBOX_COVERAGE } };
}

export function homePreview({ service, notifications, now = Date.now }) {
  const { summary, coverage, freshness, status: summaryStatus } = summaryOf(service);
  const inbox = inboxOf(notifications);
  const status = summaryStatus === 'error' || inbox.status === 'error' ? 'error' : summaryStatus === 'ready' && inbox.status === 'ready' ? 'ready' : 'partial';
  return { schemaVersion: 1, generatedAt: new Date(now()).toISOString(), status, summary, freshness, coverage, notifications: inbox };
}
