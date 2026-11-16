import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { openSync, closeSync, chmodSync, lstatSync, mkdirSync, realpathSync, constants } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';

const DAY = 86400000;
const COVERAGE = 'Local Observatory inbox, not the GitHub notifications inbox. Retained GitHub Events only: at most 300 events / 30 days per repository, with provider delays and collection gaps.';
const ACTIONS = new Map([
  ['pull_requests', new Map([['opened', 'Pull request opened'], ['reopened', 'Pull request reopened'], ['review_requested', 'Review requested']])],
  ['issues', new Map([['opened', 'Issue opened'], ['reopened', 'Issue reopened'], ['assigned', 'Issue assigned']])],
  ['issue_comment', new Map([['created', 'New issue or pull request comment']])],
  ['pull_request_review', new Map([['submitted', 'Pull request review submitted']])],
  ['pull_request_review_comment', new Map([['created', 'New pull request review comment']])],
  ['discussion_comment', new Map([['created', 'New discussion comment']])]
]);
const loginOK = value => typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\[bot\])?$/.test(value);
const fail = (message, statusCode = 400, code) => Object.assign(new Error(message), { statusCode, local: true, ...(code ? { code } : {}) });
function integer(value, min, max) {
  if (!['number', 'string'].includes(typeof value) || !/^(0|[1-9]\d*)$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw fail('Invalid notification pagination.');
  return Number(value);
}
export function notificationQuery({ offset = 0, limit = 50, unread = true } = {}) {
  if (![true, false, 'true', 'false'].includes(unread)) throw fail('Invalid unread filter.');
  return { offset: integer(offset, 0, Number.MAX_SAFE_INTEGER), limit: integer(limit, 1, 100), unread: unread === true || unread === 'true' };
}
export function unavailableNotifications(query = {}) {
  const { offset, limit } = notificationQuery(query);
  return { items: [], total: 0, unreadCount: 0, offset, limit, hasMore: false, snapshot: 0, coverage: { complete: false, label: COVERAGE + ' Notifications are not configured.' }, status: 'not_configured', updatedAt: null };
}
// Precreate files privately, refusing symlinks/nonregular files. SQLite journal
// permissions derive from the database; there is no permissive creation window.
function privateFile(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    if (!lstatSync(path).isFile()) throw fail('Invalid notification storage.', 500, 'storage');
    chmodSync(path, 0o600);
  } finally { if (fd !== undefined) closeSync(fd); }
}
function repositoryURL(value, repository) {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value);
    if (url.origin !== 'https://github.com' || url.username || url.password || url.port || url.search) return null;
    const pieces = url.pathname.split('/');
    if (pieces.length !== 5 || `${pieces[1]}/${pieces[2]}`.toLowerCase() !== repository.toLowerCase() || !['issues', 'pull', 'discussions'].includes(pieces[3]) || !/^[1-9]\d*$/.test(pieces[4])) return null;
    if (url.hash && !/^#(?:(?:issuecomment|pullrequestreview|discussioncomment)-[1-9]\d*|discussion_r[1-9]\d*)$/.test(url.hash)) return null;
    return url.href;
  } catch { return null; }
}

/** Own sidecar writer lock; create after the Observatory writer is acquired. */
export function createNotifications({ dbPath, service, now = () => new Date(), maxPages = 10, pageSize = 500 } = {}) {
  if (typeof dbPath !== 'string' || !dbPath || !service || typeof service.activity !== 'function' || typeof now !== 'function' || !Number.isInteger(maxPages) || maxPages < 2 || maxPages > 100 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw fail('Invalid notification configuration.', 500);
  const clock = () => { const date = now(); if (!(date instanceof Date) || !Number.isFinite(+date)) throw fail('Invalid notification clock.', 500); return date; };
  clock();
  let db, lock, flight, closePromise, closing = false, closed = false, scopeEpoch = 0;
  try {
    let path = dbPath;
    if (path !== ':memory:') {
      const full = resolve(path);
      mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
      path = resolve(realpathSync(dirname(full)), basename(full));
      // Never unlink the writer sidecar: exclusivity must refer to one inode.
      privateFile(`${path}.writer.sqlite`);
      lock = new DatabaseSync(`${path}.writer.sqlite`);
      try { lock.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;'); }
      catch (error) { if ([5, 6].includes(error.errcode)) throw fail('Notification storage already has a writer.', 409, 'busy'); throw error; }
      privateFile(path);
      for (const suffix of ['-wal', '-shm']) {
        try { const info = lstatSync(path + suffix); if (!info.isFile() || info.isSymbolicLink()) throw fail('Invalid notification storage.', 500, 'storage'); chmodSync(path + suffix, 0o600); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    db = new DatabaseSync(path);
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw fail('Notification storage requires a newer application.', 500, 'storage');
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS notification_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_scope (id TEXT PRIMARY KEY, repository TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        viewer TEXT NOT NULL, repository_id TEXT NOT NULL, repository TEXT NOT NULL,
        type TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, actor TEXT NOT NULL,
        occurred_at TEXT NOT NULL, read_at TEXT
      );
      CREATE INDEX IF NOT EXISTS notifications_scope ON notifications(viewer,repository_id,seq);
      PRAGMA user_version=1;
      COMMIT;`);
  } catch (error) {
    try { db?.close(); } catch {}
    try { lock?.close(); } catch {}
    throw error.local ? error : fail('Notification storage could not be initialized.', 500, 'storage');
  }
  const get = key => db.prepare('SELECT value FROM notification_state WHERE key=?').get(key)?.value;
  const set = (key, value) => db.prepare('INSERT INTO notification_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  let status = typeof service.notificationContext === 'function' ? 'error' : 'not_configured';
  let label = COVERAGE + ' Waiting for collection; retained items may be stale.';
  const ensureOpen = () => { if (closed || closing) throw fail('Notification inbox is closing.', 503); };
  const scope = `FROM notifications n JOIN notification_scope s ON s.id=n.repository_id AND lower(s.repository)=lower(n.repository) WHERE n.viewer=?`;
  const viewer = () => get('viewer') || '';
  const highwater = () => db.prepare('SELECT COALESCE(MAX(seq),0) AS value FROM notifications').get().value;
  function list(query = {}) {
    ensureOpen();
    const { offset, limit, unread } = notificationQuery(query);
    if (status === 'not_configured') return unavailableNotifications(query);
    const unreadCount = db.prepare(`SELECT COUNT(*) AS count ${scope} AND n.read_at IS NULL`).get(viewer()).count;
    const filtered = scope + (unread ? ' AND n.read_at IS NULL' : '');
    const total = db.prepare(`SELECT COUNT(*) AS count ${filtered}`).get(viewer()).count;
    const items = db.prepare(`SELECT n.* ${filtered} ORDER BY n.occurred_at DESC,n.seq DESC LIMIT ? OFFSET ?`).all(viewer(), limit, offset).map(row => ({ id: row.id, repositoryId: row.repository_id, repository: row.repository, type: row.type, title: row.title, url: row.url, actor: { login: row.actor }, occurredAt: row.occurred_at, readAt: row.read_at }));
    return { items, total, unreadCount, offset, limit, hasMore: offset < total - items.length, snapshot: highwater(), coverage: { complete: false, label }, status, updatedAt: get('updatedAt') || null };
  }
  function markRead({ id } = {}) {
    ensureOpen();
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw fail('Invalid notification ID.');
    if (!db.prepare(`SELECT 1 ${scope} AND n.id=?`).get(viewer(), id)) throw fail('Notification not found.', 404);
    db.prepare('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=?').run(clock().toISOString(), id);
    return { ok: true };
  }
  function markAllRead({ through } = {}) {
    ensureOpen();
    if (!Number.isSafeInteger(through) || through < 0 || through > highwater()) throw fail('Invalid notification snapshot.');
    db.prepare(`UPDATE notifications SET read_at=? WHERE read_at IS NULL AND seq<=? AND id IN (SELECT n.id ${scope})`).run(clock().toISOString(), through, viewer());
    return { ok: true };
  }
  function hideRepository(id) {
    ensureOpen();
    // Watch pause is a local mutation, not a reason for a provider refresh.
    scopeEpoch++;
    db.prepare('DELETE FROM notification_scope WHERE id=?').run(String(id));
  }
  function normalized(event, repositories, identity, at) {
    if (event?.source !== 'github_events' || typeof event.id !== 'string' || !event.id.length || event.id.length > 300 || /[\u0000-\u001f\u007f]/.test(event.id)) return null;
    const repository = repositories.get(String(event.repositoryId));
    if (!repository || typeof event.repository !== 'string' || event.repository.toLowerCase() !== repository.toLowerCase()) return null;
    const actor = event.actor?.login;
    if (!loginOK(actor) || actor.toLowerCase() === identity) return null;
    const title = ACTIONS.get(event.type)?.get(event.metadata?.action);
    const occurred = Date.parse(event.date);
    if (!title || !Number.isFinite(occurred) || occurred < +at - 30 * DAY || occurred > +at) return null;
    const url = repositoryURL(event.metadata?.commentURL, repository) || repositoryURL(event.url, repository);
    if (!url) return null;
    const number = event.metadata?.number;
    // Fixed descriptive labels rather than provider body/title/name text: no
    // emails, code snippets, comment contents, avatars or arbitrary links.
    return [createHash('sha256').update(JSON.stringify([identity, event.id])).digest('hex'), identity, String(event.repositoryId), repository, event.type, title + (Number.isSafeInteger(number) && number > 0 ? ` #${number}` : ''), url, actor, new Date(occurred).toISOString()];
  }
  async function ingest() {
    const epoch = scopeEpoch;
    let context;
    try { context = typeof service.notificationContext === 'function' ? await service.notificationContext() : { status: 'not_configured' }; }
    catch { status = 'error'; label = COVERAGE + ' Identity or scope refresh failed; retained items may be stale.'; return; }
    if (!context || context.status !== 'ready' || !loginOK(context.viewer) || !Array.isArray(context.repositories)) {
      status = ['no_access', 'not_configured', 'error'].includes(context?.status) ? context.status : 'error';
      label = COVERAGE + ' Identity or repository access is unavailable; retained items may be stale.';
      return;
    }
    const identity = context.viewer.toLowerCase();
    const repositories = new Map(context.repositories.filter(repo => repo && loginOK(repo.owner) && repo.owner.toLowerCase() === identity && ['string', 'number'].includes(typeof repo.id) && /^[1-9]\d*$/.test(String(repo.id)) && typeof repo.name === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(repo.name) && !['.', '..'].includes(repo.name)).map(repo => [String(repo.id), `${repo.owner}/${repo.name}`]));
    const signature = JSON.stringify([identity, [...repositories].sort()]);
    const sameScope = get('scope') === signature;
    let offset = sameScope ? Number(get('scanOffset') || 0) : 0;
    const at = clock(), entries = [];
    let exhausted = false, total = 0;
    try {
      // Authorization is authoritative as soon as context is verified, even if
      // the subsequent feed read or item/checkpoint transaction fails.
      transaction(() => {
        // A pause while context was pending forbids scope expansion from that
        // stale snapshot, but must not discard a newly verified restriction.
        const visible = epoch !== scopeEpoch ? new Map(db.prepare('SELECT * FROM notification_scope').all().map(row => [row.id, row.repository.toLowerCase()])) : null;
        db.exec('DELETE FROM notification_scope');
        for (const [id, repository] of repositories) {
          if (!visible || visible.get(id) === repository.toLowerCase()) db.prepare('INSERT INTO notification_scope VALUES(?,?)').run(id, repository);
        }
        set('viewer', identity);
      });
      if (epoch !== scopeEpoch) {
        status = 'error'; label = COVERAGE + ' Watch scope changed during identity verification; refresh deferred until the next collection.';
        return;
      }
      // Always scan the newest page. Remaining bounded work resumes the rolling
      // older-page scan. A later cycle revisits inserts that shifted offsets.
      for (let page = 0; page < maxPages; page++) {
        const position = page === 0 ? 0 : offset;
        const result = await service.activity({ range: 'all', limit: pageSize, offset: position });
        if (!result || !Array.isArray(result.events) || result.events.length > pageSize || !Number.isSafeInteger(result.total) || result.total < 0 || typeof result.hasMore !== 'boolean' || (result.hasMore && result.events.length === 0)) throw new Error('Invalid retained feed');
        total = result.total;
        for (const event of result.events) { const item = normalized(event, repositories, identity, at); if (item) entries.push(item); }
        const oldest = result.events.at(-1)?.date;
        const beyondWindow = oldest && Number.isFinite(Date.parse(oldest)) && Date.parse(oldest) < +at - 30 * DAY;
        if (!result.hasMore || beyondWindow) { exhausted = true; offset = 0; break; }
        if (page === 0) offset = Math.max(pageSize, offset);
        else offset = position + result.events.length;
      }
      if (epoch !== scopeEpoch) {
        status = 'error'; label = COVERAGE + ' Watch scope changed during ingestion; refresh deferred until the next collection.';
        return;
      }
      transaction(() => {
        const insert = db.prepare('INSERT INTO notifications(id,viewer,repository_id,repository,type,title,url,actor,occurred_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING');
        for (const entry of entries) insert.run(...entry);
        // This signature belongs to the scan cursor, not the visible scope.
        set('scope', signature); set('scanOffset', offset); set('updatedAt', at.toISOString());
      });
      status = 'ready';
      label = COVERAGE + (exhausted ? ' Bounded scan reached the current retained window; this does not establish complete coverage.' : ` Local scan capped; older retained activity is deferred to a later collection (resume offset ${Math.min(offset, total)}).`);
    } catch { status = 'error'; label = COVERAGE + ' Local ingestion failed; retained items may be stale.'; }
  }
  function refresh() {
    ensureOpen();
    if (!flight) flight = ingest().finally(() => { flight = null; });
    return flight;
  }
  function close() {
    if (!closePromise) {
      closing = true;
      closePromise = (async () => { try { await flight; } finally { try { db.close(); } finally { try { lock?.close(); } finally { closed = true; } } } })();
    }
    return closePromise;
  }
  return { list, markRead, markAllRead, refresh, close, hideRepository };
}

/** Route initial/hourly/manual collection through one existing lifecycle. */
export function withNotifications(service, notifications) {
  let flight, closing = false, closePromise;
  return {
    ...service,
    sync(...args) {
      if (closing) return Promise.reject(fail('Collection is closing.', 503));
      if (!flight) flight = (async () => { try { return await service.sync(...args); } finally { await notifications.refresh(); } })().finally(() => { flight = null; });
      return flight;
    },
    async pauseWatch(id) { const result = await service.pauseWatch(id); notifications.hideRepository(id); return result; },
    close() {
      if (!closePromise) { closing = true; closePromise = (async () => { try { await flight; } catch {} finally { try { await notifications.close(); } finally { await service.close(); } } })(); }
      return closePromise;
    }
  };
}
