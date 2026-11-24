import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { mkdirSync, openSync, closeSync, lstatSync, unlinkSync, realpathSync, chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHistory, migrateHistory, HISTORY_FLOOR } from './history.mjs';

const DAY = 86_400_000;
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const ACTIVE = new Set();
const DEFINITIONS = {
  stars: ['Stars', 'balance', 'stars', 'GitHub repository metadata'],
  forks: ['Forks', 'balance', 'forks', 'GitHub repository metadata'],
  commits: ['Commits', 'event', 'commits', 'GitHub default-branch commits (UTC)'],
  merged_prs: ['Merged pull requests', 'event', 'pull requests', 'GitHub merged pull requests (UTC)'],
  releases: ['Releases', 'event', 'releases', 'GitHub published releases (UTC)'],
  issues: ['Open issues', 'balance', 'issues', 'GitHub open issues, excluding pull requests'],
  views: ['Views', 'event', 'views', 'GitHub traffic/views; rolling 14 days (UTC)'],
  clones: ['Clones', 'event', 'clones', 'GitHub traffic/clones; rolling 14 days (UTC)'],
  star_activity: ['Star activity', 'event', 'stars', 'GitHub stargazers/history; provider-defined daily boundaries, not guaranteed UTC'],
};
const safe = (message, statusCode = 400, code = 'invalid') => Object.assign(new Error(message), { safeMessage: message, statusCode, code });
// Public explanations are trusted constants, never provider messages.
const AVAILABILITY_LABELS = Object.freeze({
  available: 'Available', disabled: 'Disabled on repo', no_access: 'No access',
  not_collected: 'Not collected yet', error: 'Collection failed', empty_repository: 'No commits yet',
});
function metricAvailability(key, row, outcome, latest) {
  let state;
  if (key === 'issues' && row.has_issues === 0) state = 'disabled';
  else if (['forbidden', 'unauthorized', 'credentials_missing'].includes(outcome?.status)) state = 'no_access';
  else if (key === 'commits' && outcome?.status === 'empty_repository') state = 'empty_repository';
  else if (outcome && !['ok', 'collecting', 'not_collected'].includes(outcome.status)) state = 'error';
  else if (latest) state = 'available';
  else state = 'not_collected';
  const label = state === 'not_collected' && outcome?.status === 'ok' ? 'No observations yet'
    : state === 'not_collected' && outcome?.status === 'collecting' ? 'Collection in progress' : AVAILABILITY_LABELS[state];
  return { state, label };
}
const isoDay = date => new Date(date).toISOString().slice(0, 10);
const text = (value, max = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : null;
const nonnegative = n => Number.isSafeInteger(n) && n >= 0;
// Only standalone, matching fences close a block; unfinished blocks fail closed.
function withoutFences(value) {
  const lines = [];
  let fence;
  for (const line of value.split(/\r\n?|\n/)) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = undefined;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open) { fence = open[1]; continue; }
    lines.push(line);
  }
  return lines.join('\n');
}
const EMAIL = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;
// Recognizable statements are not prose; inline names such as `parseConfig` are.
const codeStatement = value => /^(?:(?:const|let|var)\s+[\w$]+\s*[:=;]|(?:export\s+)?(?:async\s+)?function\b.*\{|class\b.*\{|(?:import|from)\s+.*(?:['"]|\bimport\b)|(?:if|for|while)\s*\(.*\{|[\w$.]+\s*=(?!=).*;\s*$)/.test(value.trim());
const inlineSnippet = value => codeStatement(value) || /^(?:[\w$.]+\s*=(?!=)|[\w$.]+\s*\(\s*[^\s)].*\)\s*;?$)/.test(value.trim());
function descriptiveText(value, max) {
  return value.replace(/(`+)([^`]*?)\1/g, (_, delimiters, content) => inlineSnippet(content) ? ' ' : content)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[[^\]]*\]\([^)]*\)/g, match => match.slice(1, match.indexOf(']')))
    .replace(new RegExp(EMAIL, 'gi'), '[redacted]')
    .replace(new RegExp(UNSAFE_TEXT, 'g'), ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max) || undefined;
}
// Titles/names are one-line metadata, not Markdown blocks or diff lines.
function oneLine(value, max = 200) {
  if (typeof value !== 'string') return undefined;
  const line = value.slice(0, 32_000).split(/\r\n?|\n/, 1)[0].trim();
  return /^(?:`{3,}|~{3,})/.test(line) || codeStatement(line) ? undefined : descriptiveText(line, max);
}
// Reuse the collection text boundary for compact read-only projections too.
export { oneLine as activityText };
// Git refs are identifiers, never prose: retain exact validated input or omit it.
function refName(value) {
  if (typeof value !== 'string' || !value.length || value.length > 255 || value === '@' || value.startsWith('-') || value.endsWith('.') || value.includes('..') || value.includes('@{') || /[\s~^:?*\[\\<>]/.test(value) || UNSAFE_TEXT.test(value) || EMAIL.test(value)) return undefined;
  return value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock')) ? undefined : value;
}
// Descriptions retain ordinary bullet text, never structural code/diff blocks.
function prose(value, max = 500) {
  if (typeof value !== 'string') return undefined;
  const lines = withoutFences(value.slice(0, 32_000)).split('\n'), kept = [];
  let diff = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(?:diff --git(?: |$)|@@(?: |$))/.test(line) || (/^--- /.test(line) && /^\+\+\+ /.test(lines[i + 1] ?? ''))) diff = true;
    if (diff) {
      if (/^(?:diff --git|index |[ +\-@\\]|(?:new|deleted) file mode |(?:old|new) mode |(?:similarity|dissimilarity) index |(?:rename|copy) (?:from|to) |Binary files |GIT binary patch)/.test(line)) continue;
      diff = false;
    }
    if (/^(?: {4}|\t)/.test(line) || codeStatement(line)) continue;
    kept.push(line.replace(/^ {0,3}[-+*] +/, ''));
  }
  return descriptiveText(kept.join('\n'), max);
}
function actorOf(user, name) {
  const login = typeof user?.login === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/.test(user.login) ? user.login : undefined;
  const display = oneLine(name ?? user?.name, 100);
  return login || display ? { ...(login ? { login, url: `https://github.com/${encodeURIComponent(login)}` } : {}), ...(display ? { name: display } : {}) } : undefined;
}
const timestamp = value => dateOf(value) && value.includes('T') ? new Date(value).toISOString() : null;
function descriptive(user, name, summary, metadata, date, source) {
  const actor = actorOf(user, name);
  return { actor, author: actor?.login ?? actor?.name ?? null, summary: prose(summary), metadata, date: timestamp(date), source };
}
function dateOf(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return null;
  const day = value.slice(0, 10);
  const midnight = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(midnight) || isoDay(midnight) !== day || !Number.isFinite(Date.parse(value))) return null;
  return isoDay(value);
}

function repositoryName(input) {
  if (typeof input !== 'string' || input.length > 200 || input !== input.trim()) throw safe('Invalid repository.');
  let full = input;
  if (input.startsWith('https://')) {
    const match = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/?$/.exec(input);
    if (!match) throw safe('Invalid repository URL.');
    full = `${match[1]}/${match[2]}`;
  }
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]{1,100})$/.exec(full);
  if (!match || ['.', '..'].includes(match[2])) throw safe('Invalid repository.');
  return { owner: match[1], name: match[2], full };
}
function normalizeRepository(value) {
  if (!value || !Number.isSafeInteger(value.id) || value.id <= 0 || typeof value.private !== 'boolean' || typeof value.archived !== 'boolean') throw safe('Invalid upstream metadata.', 502, 'invalid_response');
  let names;
  try { names = repositoryName(`${value.owner?.login}/${value.name}`); } catch { throw safe('Invalid upstream metadata.', 502, 'invalid_response'); }
  if (typeof value.default_branch !== 'string' || !value.default_branch.length || value.default_branch.length > 255) throw safe('Invalid upstream metadata.', 502, 'invalid_response');
  return { id: String(value.id), ...names, visibility: value.private ? 'private' : 'public', archived: value.archived, language: text(value.language, 100), description: text(value.description, 500), branch: value.default_branch, stars: value.stargazers_count, forks: value.forks_count, hasIssues: typeof value.has_issues === 'boolean' ? Number(value.has_issues) : null, createdDay: dateOf(value.created_at) };
}
function datesBetween(start, end) {
  const dates = [];
  for (let t = Date.parse(`${start}T00:00:00Z`), e = Date.parse(`${end}T00:00:00Z`); t <= e; t += DAY) dates.push(isoDay(t));
  return dates;
}

/** A single local writer. Credentials and provider response bodies are never persisted. */
export async function createObservatory({ dbPath, token = '', fetchImpl = globalThis.fetch, now = () => new Date(), maxPages = 20 } = {}) {
  if (typeof dbPath !== 'string' || !dbPath || typeof token !== 'string' || /[\r\n]/.test(token) || typeof fetchImpl !== 'function' || typeof now !== 'function' || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw safe('Invalid service configuration.');
  const clock = () => {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw safe('Invalid clock.', 500);
    return value;
  };
  clock();
  let path = dbPath;
  let writerLock;
  let ownsActive = false;
  let db;
  let closed = false;
  let closing = false;
  let closePromise = null;
  let flight = null;
  let nextRun = null;
  const pending = new Set();
  try {
    if (dbPath !== ':memory:') {
      const fullPath = resolve(dbPath);
      mkdirSync(dirname(fullPath), { recursive: true, mode: 0o700 });
      path = resolve(realpathSync(dirname(fullPath)), fullPath.slice(dirname(fullPath).length + 1));
      if (existsSync(path)) path = realpathSync(path);
      if (ACTIVE.has(path)) throw safe('Database already has an active writer.', 409, 'busy');
      // A legacy PID cannot establish identity across PID namespaces/reuse.
      // Fail closed even for a seemingly dead PID; offline migration must verify
      // the old writer is stopped before removing its lock. Never mutate it here.
      try {
        lstatSync(`${path}.writer.lock`);
        throw safe('Legacy database writer lock requires offline recovery.', 409, 'busy');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      // This dedicated rollback-journal connection holds a kernel-managed lock
      // for the service lifetime, without locking the application WAL database.
      // Never unlink the sidecar: different inodes would allow competing writers.
      const lockPath = `${path}.writer.sqlite`;
      writerLock = new DatabaseSync(lockPath);
      chmodSync(lockPath, 0o600);
      try {
        writerLock.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');
      } catch (error) {
        if (error.errcode === 5 || error.errcode === 6) throw safe('Database already has an active writer.', 409, 'busy');
        throw error;
      }
      ACTIVE.add(path);
      ownsActive = true;
    }
    db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, visibility TEXT NOT NULL,
        archived INTEGER NOT NULL, language TEXT, description TEXT, branch TEXT NOT NULL,
        access TEXT NOT NULL CHECK(access IN ('public','token')), paused INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS aliases (alias TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repositories(id));
      CREATE TABLE IF NOT EXISTS points (
        repo_id TEXT NOT NULL REFERENCES repositories(id), metric TEXT NOT NULL, day TEXT NOT NULL,
        value INTEGER NOT NULL CHECK(value >= 0), observed_at TEXT NOT NULL, PRIMARY KEY(repo_id,metric,day)
      );
      CREATE TABLE IF NOT EXISTS runs (
        repo_id TEXT NOT NULL REFERENCES repositories(id), metric TEXT NOT NULL, status TEXT NOT NULL,
        last_attempt TEXT NOT NULL, last_success TEXT, message TEXT NOT NULL, PRIMARY KEY(repo_id,metric)
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repositories(id), type TEXT NOT NULL,
        day TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, author TEXT
      );
      CREATE INDEX IF NOT EXISTS events_detail_scope ON events(repo_id,type,day DESC,id);
      CREATE TABLE IF NOT EXISTS issue_snapshots (
        repo_id TEXT PRIMARY KEY REFERENCES repositories(id), observed_at TEXT,
        complete INTEGER NOT NULL CHECK(complete IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS issue_records (
        repo_id TEXT NOT NULL REFERENCES repositories(id), number INTEGER NOT NULL CHECK(number > 0),
        day TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, PRIMARY KEY(repo_id,number)
      );
      CREATE INDEX IF NOT EXISTS issue_detail_scope ON issue_records(repo_id,day DESC,number);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budgets (identity TEXT PRIMARY KEY, remaining INTEGER NOT NULL, reset_at INTEGER NOT NULL, blocked_until INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS event_context (
        event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
        occurred_at TEXT, observed_at TEXT, source TEXT NOT NULL, context TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_context_time ON event_context(occurred_at DESC,event_id);
      CREATE TABLE IF NOT EXISTS activity_feed (
        id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repositories(id), type TEXT NOT NULL,
        day TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, author TEXT,
        occurred_at TEXT NOT NULL, observed_at TEXT NOT NULL, source TEXT NOT NULL, context TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS activity_feed_scope ON activity_feed(repo_id,type,day DESC,id);
      CREATE VIEW IF NOT EXISTS activity_records AS
        SELECT events.*,event_context.occurred_at,event_context.observed_at,event_context.source,event_context.context
        FROM events LEFT JOIN event_context ON events.id=event_context.event_id
        UNION ALL SELECT * FROM activity_feed WHERE NOT EXISTS (SELECT 1 FROM events WHERE events.id=activity_feed.id);
      `);
    // Nullable capability: legacy rows are unknown, never implicitly disabled.
    if (!db.prepare('PRAGMA table_info(repositories)').all().some(column => column.name === 'has_issues')) {
      db.exec('ALTER TABLE repositories ADD COLUMN has_issues INTEGER CHECK(has_issues IN (0,1));');
    }
    migrateHistory(db);
    // Include recovery in initialization cleanup: a failed UPDATE must not leak
    // either database handle or the lifetime writer lock.
    db.prepare("UPDATE runs SET status='interrupted', message='Collection interrupted; previous observations retained.' WHERE status='collecting'").run();
  } catch (error) {
    try { db?.close(); } catch {}
    try { writerLock?.close(); } catch {}
    if (ownsActive) ACTIVE.delete(path);
    throw error.safeMessage ? error : safe('Unable to open local database.', 500, 'storage');
  }
  const getState = key => db.prepare('SELECT value FROM state WHERE key=?').get(key)?.value ?? null;
  const setState = (key, value) => db.prepare('INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);

  const ensureOpen = () => { if (closed || closing) throw safe('Service is closed.', 503, 'closed'); };
  const transaction = action => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const run = (id, metric, status, at, message) => db.prepare(`INSERT INTO runs(repo_id,metric,status,last_attempt,last_success,message) VALUES(?,?,?,?,?,?)
    ON CONFLICT(repo_id,metric) DO UPDATE SET status=excluded.status,last_attempt=excluded.last_attempt,
    last_success=CASE WHEN excluded.status='ok' THEN excluded.last_success ELSE runs.last_success END,message=excluded.message`).run(id, metric, status, at, status === 'ok' ? at : null, message);
  const putPoint = (id, metric, day, value, at) => db.prepare(`INSERT INTO points(repo_id,metric,day,value,observed_at) VALUES(?,?,?,?,?)
    ON CONFLICT(repo_id,metric,day) DO UPDATE SET value=excluded.value,observed_at=excluded.observed_at`).run(id, metric, day, value, at);
  const publicRepo = row => ({ id: row.id, owner: row.owner, name: row.name, visibility: row.visibility, archived: Boolean(row.archived), language: row.language, description: row.description, url: `https://github.com/${row.owner}/${row.name}` });
  function tracked(action) {
    ensureOpen();
    const promise = Promise.resolve().then(action).catch(error => { throw error.safeMessage ? error : safe('Local operation failed.', 500, 'storage'); });
    pending.add(promise);
    promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  }
  function budget(identity) {
    const time = clock().getTime();
    let item = db.prepare('SELECT * FROM budgets WHERE identity=?').get(identity);
    if (!item || time >= item.reset_at) {
      const blocked = item?.blocked_until ?? 0;
      item = { identity, remaining: identity === 'token' ? 5000 : 60, reset_at: time + 60 * 60_000, blocked_until: blocked };
      db.prepare('INSERT OR REPLACE INTO budgets VALUES(?,?,?,?)').run(identity, item.remaining, item.reset_at, blocked);
    }
    return item;
  }
  async function request(endpoint, query, identity, context) {
    if (identity === 'token' && !token) throw safe('A token is required for this watch.', 401, 'credentials_missing');
    if (!/^\/(?:repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[a-z_/-]+)?|user(?:\/repos)?)$/.test(endpoint)) throw safe('Invalid upstream route.', 500, 'invalid');
    const item = budget(identity);
    const time = clock().getTime();
    if (item.remaining <= 0 || item.blocked_until > time) throw safe('GitHub rate limit reached; waiting for reset.', 429, 'rate_limited');
    const ceiling = identity === 'token' ? 500 : 55;
    if ((context[identity] ?? 0) >= ceiling) throw safe('Collection request budget reached.', 429, 'budget_exhausted');
    context[identity] = (context[identity] ?? 0) + 1;
    db.prepare('UPDATE budgets SET remaining=remaining-1 WHERE identity=?').run(identity);
    const url = new URL(`https://api.github.com${endpoint}`);
    for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, String(value));
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'github-observatory' };
    if (identity === 'token') headers.Authorization = `Bearer ${token}`;
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(safe('GitHub request timed out.', 504, 'timeout')); }, TIMEOUT_MS); });
    const task = async () => {
      let response;
      try { response = await fetchImpl(url.toString(), { headers, redirect: 'error', signal: controller.signal }); }
      catch { throw safe('GitHub request failed.', 502, 'network_error'); }
      if (controller.signal.aborted) { response?.body?.cancel().catch(() => {}); throw safe('GitHub request timed out.', 504, 'timeout'); }
      if (!response || !Number.isInteger(response.status) || !response.headers) throw safe('Invalid GitHub response.', 502, 'invalid_response');
      if (response.redirected || (response.url && new URL(response.url).origin !== 'https://api.github.com')) throw safe('GitHub redirect refused.', 502, 'redirect_refused');
      const remaining = response.headers.get('x-ratelimit-remaining');
      const reset = response.headers.get('x-ratelimit-reset');
      if (remaining !== null && /^\d+$/.test(remaining)) db.prepare('UPDATE budgets SET remaining=MIN(remaining,?) WHERE identity=?').run(Math.min(Number(remaining), 5000), identity);
      if (reset !== null && /^\d+$/.test(reset) && Number(reset) * 1000 > time) db.prepare('UPDATE budgets SET reset_at=? WHERE identity=?').run(Math.min(Number(reset) * 1000, time + DAY), identity);
      if (response.status === 429 || (response.status === 403 && (remaining === '0' || response.headers.has('retry-after')))) {
        const retry = Number(response.headers.get('retry-after'));
        const until = Number.isFinite(retry) && retry > 0 ? time + Math.min(retry * 1000, DAY) : Math.max(time + 60_000, budget(identity).reset_at);
        db.prepare('UPDATE budgets SET blocked_until=? WHERE identity=?').run(until, identity);
        await response.body?.cancel().catch(() => {});
        throw safe('GitHub rate limit reached; waiting for reset.', 429, 'rate_limited');
      }
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => {}); throw safe('GitHub redirect refused.', 502, 'redirect_refused'); }
      if ((response.status < 200 || response.status >= 300) && response.status !== 409) {
        await response.body?.cancel().catch(() => {});
        const code = response.status === 404 ? 'unsupported' : response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : 'upstream_error';
        if (response.status === 401 && identity === 'token') {
          viewerVerifiedUntil = 0; viewerAttemptUntil = clock().getTime() + 5 * 60_000; viewerStatus = 'no_access';
          db.prepare('DELETE FROM state WHERE key=?').run('notificationViewer');
        }
        throw safe(code === 'unsupported' ? 'Endpoint unavailable or repository not accessible.' : code === 'unauthorized' ? 'GitHub credentials were rejected.' : code === 'forbidden' ? 'Endpoint permission unavailable.' : 'GitHub endpoint failed.', response.status === 401 ? 401 : 502, code);
      }
      const length = Number(response.headers.get('content-length') ?? 0);
      if (!Number.isFinite(length) || length > MAX_BYTES) { controller.abort(); await response.body?.cancel().catch(() => {}); throw safe('GitHub response exceeded the size limit.', 502, 'response_too_large'); }
      let raw = '';
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        let total = 0;
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const chunk = await reader.read(); if (chunk.done) break;
            total += chunk.value.byteLength;
            if (total > MAX_BYTES) { controller.abort(); await reader.cancel().catch(() => {}); throw safe('GitHub response exceeded the size limit.', 502, 'response_too_large'); }
            raw += decoder.decode(chunk.value, { stream: true });
          }
          raw += decoder.decode();
        } finally { reader.releaseLock(); }
      } else throw safe('Invalid GitHub response stream.', 502, 'invalid_response');
      let data;
      try { data = JSON.parse(raw); } catch { throw safe('Invalid GitHub response.', 502, 'invalid_response'); }
      if (response.status === 409) throw safe(data?.message === 'Git Repository is empty.' ? 'Repository is empty; no commits are available yet.' : 'GitHub repository state conflicts with this request.', 409, data?.message === 'Git Repository is empty.' ? 'empty_repository' : 'conflict');
      return { data, link: response.headers.get('link') || '', pollInterval: response.headers.get('x-poll-interval') };
    };
    try { return await Promise.race([task(), timeout]); }
    catch (error) { throw error.safeMessage ? error : safe('GitHub request failed.', 502, 'network_error'); }
    finally { clearTimeout(timer); }
  }
  async function pages(endpoint, query, identity, context, stop) {
    const items = [];
    for (let page = 1; page <= maxPages; page++) {
      const response = await request(endpoint, { ...query, per_page: 100, page }, identity, context);
      if (!Array.isArray(response.data) || response.data.length > 100) throw safe('Invalid paginated GitHub response.', 502, 'invalid_response');
      items.push(...response.data);
      // Never follow provider-controlled URLs. Only increment our fixed-origin page number.
      const next = /\brel\s*=\s*["']?next\b/i.test(response.link);
      if (!next && response.data.length < 100) return { items, complete: true };
      if (stop?.(response.data)) return { items, complete: true, stopped: true };
      // A full page without Link is ambiguous; request the next page rather than zero-filling.
      if (page === maxPages) return { items, complete: false };
    }
    return { items, complete: false };
  }
  function storeRepository(repo, access, alias, at, resume) {
    const revisions = {};
    db.prepare(`INSERT INTO repositories(id,owner,name,visibility,archived,language,description,branch,access,has_issues) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,name=excluded.name,visibility=excluded.visibility,archived=excluded.archived,
      language=excluded.language,description=excluded.description,branch=excluded.branch,access=excluded.access,
      has_issues=COALESCE(excluded.has_issues,repositories.has_issues),
      paused=CASE WHEN ? THEN 0 ELSE repositories.paused END`).run(repo.id, repo.owner, repo.name, repo.visibility, Number(repo.archived), repo.language, repo.description, repo.branch, access, repo.hasIssues, Number(resume));
    if (repo.createdDay) db.prepare('UPDATE repositories SET created_day=? WHERE id=?').run(repo.createdDay, repo.id);
    for (const name of [alias, repo.full]) db.prepare('INSERT INTO aliases(alias,repo_id) VALUES(?,?) ON CONFLICT(alias) DO UPDATE SET repo_id=excluded.repo_id').run(name.toLowerCase(), repo.id);
    for (const metric of ['stars', 'forks']) {
      if (nonnegative(repo[metric])) {
        putPoint(repo.id, metric, isoDay(at), repo[metric], at);
        // Count transitions have a durable identity, including same-day ABA.
        // Equal observations do not invalidate a resumable long traversal.
        revisions[metric] = db.prepare(`INSERT INTO cohort_observations(repo_id,metric,value,revision) VALUES(?,?,?,1)
          ON CONFLICT(repo_id,metric) DO UPDATE SET value=excluded.value,
          revision=cohort_observations.revision + (cohort_observations.value IS NOT excluded.value)
          RETURNING revision`).get(repo.id, metric, repo[metric]).revision;
        // Withdraw published reconstruction in the observation transaction.
        // Unfinished jobs retain their cursor and original anchor revision;
        // their eventual completion must pass the same freshness guard.
        db.prepare(`UPDATE history_jobs SET coherent=0,checked_at=NULL,
          status=CASE WHEN status='complete' THEN 'limited' ELSE status END
          WHERE repo_id=? AND metric=? AND coherent=1 AND anchor_revision IS NOT ?`).run(repo.id, metric, revisions[metric]);
        run(repo.id, metric, 'ok', at, 'Observed repository balance.');
      }
      else run(repo.id, metric, 'invalid_response', at, 'Repository balance unavailable; previous observations retained.');
    }
    run(repo.id, 'metadata', 'ok', at, 'Repository metadata collected.');
    return revisions;
  }
  function dateWindow(range) {
    const selection = String(range);
    if (!['7', '30', '90', 'all'].includes(selection)) throw safe('Invalid range.');
    const end = isoDay(clock());
    const lower = HISTORY_FLOOR;
    const first = db.prepare(`SELECT MIN(day) AS day FROM (
      SELECT day FROM points WHERE day<=? UNION ALL SELECT b.day FROM history_buckets b
      JOIN history_jobs j ON j.repo_id=b.repo_id AND j.metric=b.metric AND j.generation=b.generation WHERE b.day<=?
    )`).get(end, end).day;
    const start = selection === 'all' ? (first && first > lower ? first : first ? lower : end) : isoDay(Date.parse(`${end}T00:00:00Z`) - (Number(selection) - 1) * DAY);
    return { start, end, rangeLimit: { earliest: lower, truncated: selection === 'all' && Boolean(first && first < lower) } };
  }
  function dashboard(range = '30') {
    ensureOpen();
    const { start, end, rangeLimit } = dateWindow(range);
    const dates = datesBetween(start, end);
    const repos = db.prepare('SELECT * FROM repositories WHERE paused=0 ORDER BY lower(owner),lower(name)').all().map(row => {
      const metrics = {}, availability = {};
      const records = db.prepare('SELECT * FROM runs WHERE repo_id=?').all(row.id);
      for (const [key, [label, kind, unit, source]] of Object.entries(DEFINITIONS)) {
        const outcome = records.find(item => item.metric === key);
        const latest=db.prepare('SELECT day,value,observed_at FROM points WHERE repo_id=? AND metric=? AND day<=? ORDER BY day DESC LIMIT 1').get(row.id,key,end);
        availability[key] = metricAvailability(key, row, outcome, latest);
        if(!latest)continue;
        const observations = db.prepare('SELECT day,value FROM points WHERE repo_id=? AND metric=? AND day>=? AND day<=? ORDER BY day').all(row.id, key, start, end);
        const byDay = new Map(observations.map(point => [point.day, point.value]));
        const points = dates.map(date => ({ date, value: byDay.get(date) ?? null }));
        const complete = observations.length === dates.length && outcome?.status === 'ok';
        const value=kind==='balance'?latest.value:observations.length?observations.reduce((sum,point)=>sum+point.value,0):null;
        metrics[key] = { label, kind, unit, value, observedAt:latest.observed_at, delta: kind === 'balance' && complete && dates.length > 1 ? points.at(-1).value - points[0].value : null, points,
          coverage: { start: observations[0]?.day ?? null, end: observations.at(-1)?.day ?? null, complete }, status: row.paused ? 'paused' : outcome?.status ?? 'not_collected', lastSuccess: outcome?.last_success ?? null, source,
          history: history.project(row.id, key, kind, dates, outcome) };
      }
      const lastActivityAt = db.prepare('SELECT MAX(occurred_at) AS at FROM activity_records WHERE repo_id=? AND occurred_at<=?').get(row.id, clock().toISOString()).at;
      return { ...publicRepo(row), metrics, metricAvailability: availability, ...(lastActivityAt ? { lastActivityAt } : {}) };
    });
    return { dates, repos, updatedAt: getState('updatedAt'), collecting: Boolean(flight), credentialConfigured: Boolean(token), rangeLimit };
  }
  function status() {
    ensureOpen();
    return { collecting: Boolean(flight), credentialConfigured: Boolean(token), lastAttempt: getState('lastAttempt'), lastSuccess: getState('lastSuccess'), ...(nextRun ? { nextRun } : {}),
      runs: db.prepare('SELECT runs.*,repositories.owner,repositories.name,repositories.paused FROM runs JOIN repositories ON repositories.id=runs.repo_id ORDER BY owner,name,metric').all().map(row => ({ repository: `${row.owner}/${row.name}`, metric: row.metric, status: row.paused ? 'paused' : row.status, lastAttempt: row.last_attempt, lastSuccess: row.last_success, message: row.paused ? 'Watch paused; history retained.' : row.message })),
      rateLimit: Object.fromEntries(db.prepare('SELECT * FROM budgets').all().map(row => [row.identity, { remaining: row.remaining, resetAt: new Date(row.reset_at).toISOString(), blockedUntil: row.blocked_until ? new Date(row.blocked_until).toISOString() : null }])) };
  }
  function events(limit = 100) {
    ensureOpen();
    if (!Number.isInteger(Number(limit)) || Number(limit) < 1) throw safe('Invalid event limit.');
    return { events: activity({ limit: Math.min(Number(limit), 500) }).events };
  }
  function eventRecord(row) {
    const context = Object.hasOwn(row, 'context') ? (row.context ? row : null) : db.prepare('SELECT * FROM event_context WHERE event_id=?').get(row.id);
    const title = row.type === 'commits' && /^Commit [a-fA-F0-9]{1,64}$/.test(row.title) ? 'Commit (title unavailable)' : row.title;
    return { id: row.id, repository: `${row.owner}/${row.name}`, repositoryId: row.repo_id, type: row.type, date: context?.occurred_at ?? row.day, title, url: row.url,
      ...(row.author ? { author: row.author } : {}), ...(context ? { ...JSON.parse(context.context), source: context.source, ...(context.observed_at ? { observedAt: context.observed_at } : {}) } : {}) };
  }
  const coverage = () => ({ complete: false, label: 'Retained activity only, not full history. GitHub Events is capped at 300 events / 30 days and may lag 30 seconds–6 hours; collection pages, permissions and rate budgets can leave gaps.' });
  function activity({ repository, range = 'all', offset = 0, limit = 100, visibility = 'all', search = '', archived, type } = {}) {
    ensureOpen();
    const integer = (value, min, max) => {
      if (!['number', 'string'].includes(typeof value) || !/^(0|[1-9]\d*)$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw safe('Invalid activity pagination.');
      return Number(value);
    };
    offset = integer(offset, 0, Number.MAX_SAFE_INTEGER); limit = integer(limit, 1, 500);
    if (!['string', 'number'].includes(typeof range) || !['7', '30', '90', 'all'].includes(String(range))) throw safe('Invalid range.');
    if (!['all', 'public', 'private'].includes(visibility)) throw safe('Invalid visibility.');
    if (typeof search !== 'string' || search.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(search)) throw safe('Invalid search.');
    if (archived !== undefined && ![true, false, 'true', 'false'].includes(archived)) throw safe('Invalid archive filter.');
    if (type !== undefined && type !== 'commits') throw safe('Invalid activity type.');
    const params = [], clauses = ['repositories.paused=0'];
    if (visibility !== 'all') { clauses.push('repositories.visibility=?'); params.push(visibility); }
    if (archived !== undefined) { clauses.push('repositories.archived=?'); params.push(Number(archived === true || archived === 'true')); }
    if (search.trim()) { clauses.push("instr(lower(repositories.owner || '/' || repositories.name),lower(?))>0"); params.push(search.trim()); }
    if (repository !== undefined) {
      if (typeof repository !== 'string' || !/^[1-9]\d*$/.test(repository)) throw safe('Invalid repository ID.');
      if (!db.prepare('SELECT 1 FROM repositories WHERE id=? AND paused=0').get(repository)) throw safe('Watch not found.', 404);
      clauses.push('repositories.id=?'); params.push(repository);
    }
    const repositoryScope = clauses.join(' AND '), repositoryParams = [...params];
    clauses.push('a.day<=?'); params.push(isoDay(clock()));
    if (String(range) !== 'all') { clauses.push('a.day>=?'); params.push(dateWindow(range).start); }
    if (type !== undefined) { clauses.push('a.type=?'); params.push(type); }
    const scope = `FROM activity_records a JOIN repositories ON repositories.id=a.repo_id WHERE ${clauses.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) AS count ${scope}`).get(...params).count;
    const records = db.prepare(`SELECT a.*,repositories.owner,repositories.name ${scope} ORDER BY COALESCE(a.occurred_at,a.day) DESC,a.id LIMIT ? OFFSET ?`).all(...params, limit, offset).map(eventRecord);
    const result = { events: records, total, hasMore: offset < total - records.length, offset, limit, coverage: coverage() };
    if (type === 'commits') {
      // Include watches with no records: an empty page cannot establish a
      // successful empty collection. Never borrow the mixed feed's freshness.
      const runs = db.prepare(`SELECT runs.status,runs.last_success,runs.last_attempt FROM repositories
        LEFT JOIN runs ON runs.repo_id=repositories.id AND runs.metric='commits' WHERE ${repositoryScope}`).all(...repositoryParams);
      const observed = runs.map(row => timestamp(row.status === 'empty_repository' ? row.last_attempt : row.last_success));
      result.status = runs.every((row, i) => ['ok', 'empty_repository'].includes(row.status) && observed[i]) ? 'ready' : 'partial';
      result.updatedAt = observed.length && observed.every(Boolean) ? observed.sort()[0] : null;
      result.coverage = { complete: false, label: 'Retained default-branch commits across active watches, including your own; not full GitHub history. Collection limits, permissions and gaps may omit commits.' +
        (result.status === 'partial' ? ' Commit collection is unavailable or incomplete for some watches; retained items may be stale.' : '') };
    }
    return result;
  }
  function details({ repository, metric, range = '30', offset = 0, limit = 50 } = {}) {
    ensureOpen();
    if (typeof repository !== 'string' || !/^[1-9]\d*$/.test(repository)) throw safe('Invalid repository ID.');
    if (typeof metric !== 'string' || !Object.hasOwn(DEFINITIONS, metric)) throw safe('Invalid metric.');
    if (!['string', 'number'].includes(typeof range)) throw safe('Invalid range.');
    const { start, end } = dateWindow(range);
    const integer = (value, minimum, maximum) => {
      if (!['number', 'string'].includes(typeof value) || !/^(0|[1-9]\d*)$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) throw safe('Invalid detail pagination.');
      return Number(value);
    };
    offset = integer(offset, 0, Number.MAX_SAFE_INTEGER);
    limit = integer(limit, 1, 100);
    if (!db.prepare('SELECT 1 FROM repositories WHERE id=? AND paused=0').get(repository)) throw safe('Watch not found.', 404);
    const outcome = db.prepare('SELECT * FROM runs WHERE repo_id=? AND metric=?').get(repository, metric);
    const latest = db.prepare('SELECT observed_at FROM points WHERE repo_id=? AND metric=? AND day<=? ORDER BY day DESC LIMIT 1').get(repository, metric, end);
    const covered = db.prepare('SELECT COUNT(*) AS count FROM points WHERE repo_id=? AND metric=? AND day>=? AND day<=?').get(repository, metric, start, end).count;
    const result = { items: [], total: 0, hasMore: false, offset, limit, kind: 'observations', observedAt: latest?.observed_at ?? null, status: outcome?.status ?? 'not_collected', complete: outcome?.status === 'ok' && covered === datesBetween(start, end).length };
    if (['commits', 'merged_prs', 'releases'].includes(metric)) {
      result.kind = 'events';
      result.total = db.prepare('SELECT COUNT(*) AS count FROM events WHERE repo_id=? AND type=? AND day>=? AND day<=?').get(repository, metric, start, end).count;
      result.items = db.prepare('SELECT events.*,repositories.owner,repositories.name FROM events JOIN repositories ON repositories.id=events.repo_id LEFT JOIN event_context ON event_context.event_id=events.id WHERE repo_id=? AND type=? AND day>=? AND day<=? ORDER BY COALESCE(occurred_at,day) DESC,events.id LIMIT ? OFFSET ?').all(repository, metric, start, end, limit, offset).map(eventRecord);
    } else if (['stars', 'forks'].includes(metric) && db.prepare('SELECT 1 FROM runs WHERE repo_id=? AND metric=?').get(repository, 'activity')) {
      const feedRun = db.prepare('SELECT * FROM runs WHERE repo_id=? AND metric=?').get(repository, 'activity');
      result.kind = 'events'; result.complete = false; result.coverage = coverage();
      result.status = feedRun.status === 'ok' ? 'partial' : feedRun.status;
      result.observedAt = db.prepare('SELECT MAX(observed_at) AS at FROM activity_feed WHERE repo_id=? AND type=?').get(repository, metric).at;
      const lower = String(range) === 'all' ? '' : start;
      result.total = db.prepare('SELECT COUNT(*) AS count FROM activity_feed WHERE repo_id=? AND type=? AND day>=? AND day<=?').get(repository, metric, lower, end).count;
      result.items = db.prepare('SELECT a.*,repositories.owner,repositories.name FROM activity_feed a JOIN repositories ON repositories.id=a.repo_id WHERE repo_id=? AND type=? AND day>=? AND day<=? ORDER BY occurred_at DESC,a.id LIMIT ? OFFSET ?').all(repository, metric, lower, end, limit, offset).map(eventRecord);
    } else if (metric === 'issues') {
      const snapshot = db.prepare('SELECT * FROM issue_snapshots WHERE repo_id=?').get(repository);
      result.kind = 'snapshot';
      result.observedAt = snapshot?.observed_at ?? null;
      result.complete = snapshot?.complete === 1 && outcome?.status === 'ok';
      if (outcome?.status === 'ok' && !result.complete) result.status = 'details_incomplete';
      result.total = db.prepare('SELECT COUNT(*) AS count FROM issue_records WHERE repo_id=?').get(repository).count;
      result.items = db.prepare('SELECT number,day AS date,title,url FROM issue_records WHERE repo_id=? ORDER BY day DESC,number LIMIT ? OFFSET ?').all(repository, limit, offset).map(({ number, ...item }) => ({ id: `${repository}:issues:${number}`, ...item }));
    }
    result.hasMore = offset < result.total - result.items.length;
    return result;
  }
  const addWatch = ({ repository, access } = {}) => tracked(async () => {
    const name = repositoryName(repository);
    if (!['public', 'token'].includes(access)) throw safe('Choose public or token access explicitly.');
    const alias = db.prepare('SELECT repositories.* FROM aliases JOIN repositories ON repositories.id=aliases.repo_id WHERE alias=?').get(name.full.toLowerCase());
    const route = alias ? `${alias.owner}/${alias.name}` : name.full;
    const response = await request(`/repos/${route}`, {}, access, {});
    const repo = normalizeRepository(response.data);
    if (access === 'public' && repo.visibility !== 'public') throw safe('Public mode requires a public repository.', 403, 'forbidden');
    const at = clock().toISOString();
    transaction(() => { storeRepository(repo, access, name.full, at, true); setState('updatedAt', at); });
    return { repository: dashboard('30').repos.find(row => row.id === repo.id) };
  });
  const discover = () => tracked(async () => {
    if (!token) return { repositories: [], complete: false, status: 'credentials_missing', message: 'A token is required to discover owned repositories.' };
    try {
      const result = await pages('/user/repos', { affiliation: 'owner', sort: 'full_name', direction: 'asc' }, 'token', {});
      const watched = new Set(db.prepare('SELECT id FROM repositories WHERE paused=0').all().map(row => row.id));
      const unique = new Map();
      for (const value of result.items) {
        const repo = normalizeRepository(value);
        unique.set(repo.id, { id: repo.id, owner: repo.owner, name: repo.name, visibility: repo.visibility, archived: repo.archived, watched: watched.has(repo.id) });
      }
      return { repositories: [...unique.values()], complete: result.complete, status: result.complete ? 'ok' : 'partial', ...(!result.complete ? { message: 'Repository discovery reached the pagination limit.' } : {}) };
    } catch (error) { return { repositories: [], complete: false, status: error.code || 'error', message: error.safeMessage || 'Repository discovery failed.' }; }
  });
  // Background notification refresh only. Not called by any GET or startup.
  // Persist only the verified login; verify afresh in every process (including
  // after a credential change), then expire that verification after one hour.
  let viewerVerifiedUntil = 0, viewerAttemptUntil = 0, viewerStatus = 'error', viewerFlight = null;
  const notificationContext = () => tracked(async () => {
    const unavailable = status => ({ viewer: null, repositories: [], coverage: { complete: false, label: 'Notification coverage unavailable; authenticated identity is not verified.' }, status });
    if (!token) return unavailable('not_configured');
    const time = clock().getTime();
    if (time >= viewerVerifiedUntil) {
      if (time < viewerAttemptUntil) return unavailable(viewerStatus);
      if (!viewerFlight) viewerFlight = (async () => {
        try {
          const response = await request('/user', {}, 'token', {});
          const login = response.data?.login;
          if (typeof login !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) throw safe('Invalid authenticated identity.', 502, 'invalid_response');
          setState('notificationViewer', login);
          viewerVerifiedUntil = clock().getTime() + 60 * 60_000;
          viewerAttemptUntil = 0;
          viewerStatus = 'ready';
        } catch (error) {
          viewerVerifiedUntil = 0;
          viewerAttemptUntil = clock().getTime() + 5 * 60_000;
          viewerStatus = ['forbidden', 'unauthorized', 'credentials_missing'].includes(error.code) ? 'no_access' : 'error';
          db.prepare('DELETE FROM state WHERE key=?').run('notificationViewer');
        }
      })().finally(() => { viewerFlight = null; });
      await viewerFlight;
    }
    if (viewerStatus !== 'ready' || clock().getTime() >= viewerVerifiedUntil) return unavailable(viewerStatus === 'ready' ? 'error' : viewerStatus);
    const viewer = getState('notificationViewer');
    const repositories = db.prepare('SELECT id,owner,name FROM repositories WHERE paused=0 AND lower(owner)=lower(?) ORDER BY id').all(viewer);
    return { viewer, repositories, coverage: { complete: false, label: 'Retained activity for verified owned watches only; provider event limits and collection gaps apply.' }, status: 'ready' };
  });
  function incomplete(result) { if (!result.complete) throw safe('Pagination limit reached; previous observations retained.', 502, 'partial'); return result.items; }
  function endpointFailure(id, metric, error, at) { run(id, metric, error.code || 'error', at, error.safeMessage || 'Collection failed; previous observations retained.'); }
  function storeEvent(id, metric, value, at) {
    const key = `${id}:${metric}:${value.id}`;
    db.prepare('INSERT OR REPLACE INTO events(id,repo_id,type,day,title,url,author) VALUES(?,?,?,?,?,?,?)').run(key, id, metric, value.day, value.title, value.url, value.author ?? null);
    db.prepare('INSERT INTO event_context(event_id,occurred_at,observed_at,source,context) VALUES(?,?,?,?,?)').run(key, value.date ?? null, at, value.source ?? metric, JSON.stringify({ ...(value.actor ? { actor: value.actor } : {}), ...(value.summary ? { summary: value.summary } : {}), ...(value.metadata ? { metadata: value.metadata } : {}) }));
  }
  function putEvents(id, metric, values, start, end, at) {
    const unique = new Map();
    for (const value of values) if (value.day >= start && value.day <= end) unique.set(value.id, value);
    const counts = new Map(datesBetween(start, end).map(day => [day, 0]));
    for (const value of unique.values()) counts.set(value.day, counts.get(value.day) + 1);
    transaction(() => {
      // Exact complete coverage replaces this bounded window, including rebase/deletion corrections.
      db.prepare('DELETE FROM events WHERE repo_id=? AND type=? AND day>=? AND day<=?').run(id, metric, start, end);
      for (const value of unique.values()) storeEvent(id, metric, value, at);
      for (const [day, count] of counts) putPoint(id, metric, day, count, at);
      run(id, metric, 'ok', at, 'Complete bounded event coverage collected.'); setState('updatedAt', at);
    });
  }
  const history = createHistory({ db, transaction, request, maxPages, safe, dateOf, isoDay, datesBetween, putPoint, storeEvent, run, setState });
  function feedEvent(item, row, web) {
    const date = timestamp(item?.created_at);
    if (!date || typeof item.id !== 'string' || !/^\d{1,40}$/.test(item.id) || typeof item.type !== 'string' || !/^[A-Z][A-Za-z]{0,60}Event$/.test(item.type) || (item.repo?.id !== undefined && String(item.repo.id) !== row.id)) throw safe('Invalid activity event.', 502, 'invalid_response');
    const p = item.payload && typeof item.payload === 'object' ? item.payload : {};
    const action = oneLine(p.action, 80);
    const metadata = action ? { action } : {};
    const actor = actorOf(item.actor);
    let type = item.type.replace(/Event$/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    let id = `${row.id}:github_events:${item.id}`, title = type.replaceAll('_', ' '), url = web, summary;
    const number = value => nonnegative(value) && value > 0;
    const subject = p.pull_request ?? p.issue ?? p.discussion;
    if (number(subject?.number ?? p.number)) {
      metadata.number = subject?.number ?? p.number;
      title = oneLine(subject?.title) || `${p.pull_request ? 'Pull request' : p.discussion ? 'Discussion' : 'Issue'} #${metadata.number}`;
      url = `${web}/${p.pull_request || p.issue?.pull_request ? 'pull' : p.discussion ? 'discussions' : 'issues'}/${metadata.number}`;
    }
    switch (item.type) {
      case 'WatchEvent': type = 'stars'; title = 'Starred repository'; break;
      case 'ForkEvent': {
        type = 'forks'; title = 'Forked repository';
        try { const fork = repositoryName(`${p.forkee?.owner?.login}/${p.forkee?.name}`); url = `https://github.com/${fork.full}`; } catch {}
        break;
      }
      case 'PushEvent':
        type = 'pushes'; title = 'Pushed commits';
        // Push time is not commit time. Keep one push, never fabricate commits
        // from the (often absent/truncated) payload.commits array or fetch N SHAs.
        if (refName(p.ref)) {
          metadata.ref = p.ref;
          if (p.ref.startsWith('refs/heads/')) metadata.branch = refName(p.ref.slice(11));
          metadata.refType = p.ref.startsWith('refs/tags/') ? 'tag' : p.ref.startsWith('refs/heads/') ? 'branch' : undefined;
        }
        if (typeof p.head === 'string' && /^[a-fA-F0-9]{1,64}$/.test(p.head)) metadata.head = p.head;
        if (nonnegative(p.size)) metadata.commitCount = p.size;
        if (metadata.branch) title = `Pushed to ${metadata.branch}`;
        break;
      case 'PullRequestEvent':
        type = 'pull_requests';
        if ((p.action === 'merged' || (p.action === 'closed' && (p.pull_request?.merged === true || timestamp(p.pull_request?.merged_at)))) && number(metadata.number)) {
          type = 'merged_prs'; id = `${row.id}:merged_prs:${metadata.number}`; metadata.action = 'merged';
        }
        for (const key of ['head', 'base']) if (refName(p.pull_request?.[key]?.ref)) metadata[key] = p.pull_request[key].ref;
        summary = prose(p.pull_request?.body);
        break;
      case 'ReleaseEvent':
        type = 'release_activity';
        title = oneLine(p.release?.name) || refName(p.release?.tag_name) || 'Release activity';
        if (refName(p.release?.tag_name)) { metadata.ref = p.release.tag_name; metadata.refType = 'tag'; }
        url = `${web}/releases`;
        if (metadata.ref) url += `/tag/${encodeURIComponent(metadata.ref)}`;
        if (p.action === 'published' && number(p.release?.id) && p.release?.draft !== true) { type = 'releases'; id = `${row.id}:releases:${p.release.id}`; }
        summary = prose(p.release?.body);
        break;
      case 'CreateEvent': case 'DeleteEvent':
        type = item.type === 'CreateEvent' ? 'ref_created' : 'ref_deleted';
        if (refName(p.ref)) metadata.ref = p.ref;
        if (['branch', 'tag', 'repository'].includes(p.ref_type)) metadata.refType = p.ref_type;
        title = `${item.type === 'CreateEvent' ? 'Created' : 'Deleted'} ${metadata.refType || 'reference'}${metadata.ref ? ` ${metadata.ref}` : ''}`;
        break;
      case 'PublicEvent': title = 'Made repository public'; break;
      case 'GollumEvent': title = 'Updated wiki'; url = `${web}/wiki`; break;
      case 'MemberEvent': title = 'Repository collaborator activity'; break;
      case 'CommitCommentEvent':
        title = 'Commit comment';
        if (typeof p.comment?.commit_id === 'string' && /^[a-fA-F0-9]{1,64}$/.test(p.comment.commit_id)) { metadata.sha = p.comment.commit_id; url = `${web}/commit/${p.comment.commit_id}`; }
        break;
    }
    if (['IssueCommentEvent', 'PullRequestReviewCommentEvent', 'DiscussionCommentEvent'].includes(item.type)) {
      if (nonnegative(p.comment?.id) && p.comment.id > 0) {
        metadata.commentId = p.comment.id;
        const section = item.type === 'DiscussionCommentEvent' ? 'discussions' : item.type === 'PullRequestReviewCommentEvent' || p.issue?.pull_request ? 'pull' : 'issues';
        const fragment = item.type === 'DiscussionCommentEvent' ? 'discussioncomment-' : item.type === 'PullRequestReviewCommentEvent' ? 'discussion_r' : 'issuecomment-';
        const expected = number(metadata.number) ? `${web}/${section}/${metadata.number}#${fragment}${p.comment.id}` : null;
        // Only a matching, specific GitHub URL can replace the generic subject URL.
        if (expected && p.comment.html_url === expected) url = expected;
      }
      if (typeof p.comment?.body === 'string') {
        const proseOnly = withoutFences(p.comment.body.slice(0, 32_000)).split('\n').filter(line => !/^(?: {4}|\t)/.test(line) && !codeStatement(line)).join('\n').replace(/`+[^`]*`+/g, ' ');
        const mentions = new Set();
        for (const match of proseOnly.matchAll(/(?:^|[^A-Za-z0-9_@])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)(?![A-Za-z0-9_-])/g)) {
          mentions.add(match[1].toLowerCase());
          if (mentions.size === 20) break;
        }
        if (mentions.size) metadata.mentions = [...mentions];
      }
    }
    return { id, type, day: date.slice(0, 10), title: title.slice(0, 200) || 'Repository activity', url, author: actor?.login ?? actor?.name ?? null, date, actor, summary, metadata };
  }
  async function collectFeed(row, route, web, context, at) {
    const pollKey = 'activityPoll:' + row.id;
    if (Number(getState(pollKey)) > clock().getTime()) {
      const previous = getState('activityOutcome:' + row.id) || 'partial';
      db.prepare('UPDATE runs SET status=?,message=? WHERE repo_id=? AND metric=?').run(previous, 'Waiting for GitHub polling interval; retained activity is incomplete.', row.id, 'activity');
      return;
    }
    const cursorKey = 'activityPage:' + row.id;
    let page = Number(getState(cursorKey) || 1);
    if (![1, 2, 3].includes(page)) page = 1;
    const allowance = Math.min(3, maxPages);
    for (let count = 0; count < allowance && page <= 3; count++, page++) {
      let response, values;
      try {
        response = await request(`${route}/events`, { per_page: 100, page }, row.access, context);
        if (!Array.isArray(response.data) || response.data.length > 100) throw safe('Invalid activity page.', 502, 'invalid_response');
        values = response.data.map(item => feedEvent(item, row, web));
      } catch (error) {
        // Resume budget deferrals, but do not let a permanently missing/invalid
        // old page prevent refreshing the newest page on every future cycle.
        if (!['rate_limited', 'budget_exhausted'].includes(error.code)) setState(cursorKey, '1');
        throw error;
      }
      const more = /\brel\s*=\s*["']?next\b/i.test(response.link) || response.data.length === 100;
      const partial = more;
      transaction(() => {
        for (const value of values) {
          if (value.date > at) continue;
          db.prepare(`INSERT INTO activity_feed(id,repo_id,type,day,title,url,author,occurred_at,observed_at,source,context) VALUES(?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET title=excluded.title,url=excluded.url,author=excluded.author,context=excluded.context,observed_at=excluded.observed_at`).run(value.id, row.id, value.type, value.day, value.title, value.url, value.author, value.date, at, 'github_events', JSON.stringify({ ...(value.actor ? { actor: value.actor } : {}), ...(value.summary ? { summary: value.summary } : {}), metadata: value.metadata }));
        }
        setState(cursorKey, String(more && page < 3 ? page + 1 : 1));
        const poll = Number(response.pollInterval);
        if (Number.isFinite(poll) && poll > 0) setState(pollKey, String(clock().getTime() + Math.min(poll, 86400) * 1000));
        setState('activityOutcome:' + row.id, partial ? 'partial' : 'ok');
        run(row.id, 'activity', partial ? 'partial' : 'ok', at, partial ? 'Activity page/cap reached; retained records are incomplete.' : 'Available activity pages retained; provider history is capped and delayed.');
        setState('updatedAt', at);
      });
      if (!more) break;
    }
  }
  async function collect(row, context, at) {
    const start = isoDay(Date.parse(`${isoDay(at)}T00:00:00Z`) - 179 * DAY);
    const end = isoDay(at);
    let repo, cohortRevisions;
    run(row.id, 'metadata', 'collecting', at, 'Collecting repository metadata.');
    try {
      repo = normalizeRepository((await request(`/repos/${row.owner}/${row.name}`, {}, row.access, context)).data);
      if (repo.id !== row.id || (row.access === 'public' && repo.visibility !== 'public')) throw safe('Repository identity or access changed.', 403, 'identity_changed');
      transaction(() => { cohortRevisions = storeRepository(repo, row.access, `${row.owner}/${row.name}`, at, false); setState('updatedAt', at); });
    } catch (error) {
      transaction(() => { for (const metric of ['metadata', 'activity', ...Object.keys(DEFINITIONS)]) endpointFailure(row.id, metric, error, at); });
      return false;
    }
    const route = `/repos/${repo.full}`;
    const web = `https://github.com/${repo.full}`;
    let successful = nonnegative(repo.stars) && nonnegative(repo.forks);
    const jobs=[];
    const perform=(metric,action)=>{jobs.push({metric,action});};
    const normalizeCommits = items => items.map(item => {
        const day = dateOf(item.commit?.committer?.date);
        if (!day || typeof item.sha !== 'string' || !/^[a-fA-F0-9]{1,64}$/.test(item.sha)) throw safe('Invalid commit response.', 502, 'invalid_response');
        const [title, ...rest] = typeof item.commit?.message === 'string' ? item.commit.message.split(/\r?\n/) : [];
        return { id: item.sha.toLowerCase(), day, title: oneLine(title) || 'Commit (title unavailable)', url: `${web}/commit/${item.sha.toLowerCase()}`, ...descriptive(item.author, item.commit?.author?.name, rest.join('\n'), { sha: item.sha.toLowerCase(), branch: refName(repo.branch) }, item.commit.committer.date, 'commits') };
    });
    const normalizePulls = items => {
      const values = [];
      for (const item of items) {
        if (!Object.hasOwn(item, 'merged_at')) throw safe('Invalid pull request response.', 502, 'invalid_response');
        if (!item.merged_at) continue;
        const day = dateOf(item.merged_at);
        if (!day || !nonnegative(item.number) || item.number < 1) throw safe('Invalid pull request response.', 502, 'invalid_response');
        values.push({ id: String(item.number), day, title: oneLine(item.title) || `Pull request #${item.number}`, url: `${web}/pull/${item.number}`, ...descriptive(item.user, undefined, item.body, { number: item.number, action: 'merged', ...(refName(item.head?.ref) ? { head: item.head.ref } : {}), ...(refName(item.base?.ref) ? { base: item.base.ref } : {}) }, item.merged_at, 'pulls') });
      }
      return values;
    };
    const normalizeReleases = items => {
      const values = [];
      for (const item of items) {
        if (item.draft === true) continue;
        const day = dateOf(item.published_at);
        if (!day || !nonnegative(item.id) || item.id < 1 || typeof item.tag_name !== 'string' || !item.tag_name.length) throw safe('Invalid release response.', 502, 'invalid_response');
        const ref = refName(item.tag_name);
        const url = ref ? `${web}/releases/tag/${encodeURIComponent(ref)}` : `${web}/releases`;
        values.push({ id: String(item.id), day, title: oneLine(item.name) || ref?.slice(0, 200) || 'Release', url, ...descriptive(item.author, undefined, item.body, { ref, refType: 'tag', action: 'published' }, item.published_at, 'releases') });
      }
      return values;
    };
    await perform('commits', async () => {
      const items = incomplete(await pages(`${route}/commits`, { sha: repo.branch, since: `${start}T00:00:00Z`, until: at }, row.access, context));
      putEvents(row.id, 'commits', normalizeCommits(items), start, end, at);
    });
    await perform('merged_prs', async () => {
      const items = incomplete(await pages(`${route}/pulls`, { state: 'closed', sort: 'updated', direction: 'desc' }, row.access, context, page => page.length > 0 && page.every(item => dateOf(item.updated_at)) && page.at(-1).updated_at < `${start}T00:00:00Z`));
      putEvents(row.id, 'merged_prs', normalizePulls(items), start, end, at);
    });
    await perform('releases', async () => {
      const backfilled = db.prepare("SELECT exhausted FROM history_jobs WHERE repo_id=? AND metric='releases'").get(row.id)?.exhausted;
      const result = await pages(`${route}/releases`, {}, row.access, context, page => Boolean(backfilled && page.some(item => dateOf(item.published_at) < start && db.prepare('SELECT 1 FROM events WHERE id=?').get(`${row.id}:releases:${item.id}`))));
      const values = normalizeReleases(incomplete(result));
      if (!result.stopped) putEvents(row.id, 'releases', values, start, end, at);
      else transaction(() => {
        // The release API has no since filter and publication order need not
        // match creation order. Stop at retained old releases, but do not claim
        // full coverage or erase unseen records on this incremental refresh.
        for (const value of values) {
          if (value.day > end) continue;
          // Like backfill, an old page may add metadata-only records, but must
          // not replace richer context retained when a release was recent.
          if (value.day < start && db.prepare('SELECT 1 FROM events WHERE id=?').get(`${row.id}:releases:${value.id}`)) continue;
          storeEvent(row.id, 'releases', value.day < start ? { ...value, summary: undefined } : value, at);
        }
        for (const p of db.prepare("SELECT day,COUNT(*) AS value FROM events WHERE repo_id=? AND type='releases' AND day>=? AND day<=? GROUP BY day").all(row.id, start, end)) putPoint(row.id, 'releases', p.day, p.value, at);
        run(row.id, 'releases', 'partial', at, 'Recent release pages refreshed; retained older releases not rescanned.');
        setState('updatedAt', at);
      });
    });
    await perform('issues', async () => {
      if (db.prepare('SELECT has_issues FROM repositories WHERE id=?').get(row.id).has_issues === 0) {
        run(row.id, 'issues', 'disabled', at, 'Disabled on repo; previous observations retained.');
        return;
      }
      const items = incomplete(await pages(`${route}/issues`, { state: 'open', sort: 'created', direction: 'asc' }, row.access, context));
      const issues = new Map();
      for (const item of items) {
        if (!item || !nonnegative(item.id) || item.id < 1) throw safe('Invalid issue response.', 502, 'invalid_response');
        if (!item.pull_request) issues.set(item.id, item);
      }
      const records = new Map();
      for (const item of issues.values()) {
        const day = dateOf(item.created_at);
        if (!day || !nonnegative(item.number) || item.number < 1) continue;
        records.set(item.number, { day, title: text(item.title) || `Issue #${item.number}`, url: `${web}/issues/${item.number}` });
      }
      const detailsComplete = records.size === issues.size;
      transaction(() => {
        // Count-only responses remain usable, but never replace a good detail snapshot.
        if (detailsComplete) {
          db.prepare('DELETE FROM issue_records WHERE repo_id=?').run(row.id);
          for (const [number, value] of records) db.prepare('INSERT INTO issue_records(repo_id,number,day,title,url) VALUES(?,?,?,?,?)').run(row.id, number, value.day, value.title, value.url);
          db.prepare('INSERT INTO issue_snapshots(repo_id,observed_at,complete) VALUES(?,?,1) ON CONFLICT(repo_id) DO UPDATE SET observed_at=excluded.observed_at,complete=1').run(row.id, at);
        } else {
          db.prepare('INSERT INTO issue_snapshots(repo_id,observed_at,complete) VALUES(?,NULL,0) ON CONFLICT(repo_id) DO UPDATE SET complete=0').run(row.id);
        }
        putPoint(row.id, 'issues', end, issues.size, at);
        run(row.id, 'issues', 'ok', at, detailsComplete ? 'Observed open issues, excluding pull requests.' : 'Observed open issue count; details incomplete, previous records retained.');
        setState('updatedAt', at);
      });
    });
    for (const metric of ['views', 'clones']) await perform(metric, async () => {
      const response = await request(`${route}/traffic/${metric}`, { per: 'day' }, row.access, context);
      const items = response.data?.[metric];
      if (!Array.isArray(items) || items.length > 3660) throw safe('Unsupported aggregate response format.', 502, 'invalid_response');
      const points = new Map();
      const lower = isoDay(Date.parse(`${end}T00:00:00Z`) - 14 * DAY);
      for (const item of items) {
        const day = dateOf(item.timestamp ?? item.date);
        if (!day || !nonnegative(item.count) || points.has(day)) throw safe('Invalid aggregate response.', 502, 'invalid_response');
        if (day >= lower && day <= end) points.set(day, item.count);
      }
      transaction(() => {
        for (const [day, value] of points) putPoint(row.id, metric, day, value, at);
        run(row.id, metric, 'ok', at, 'Provider daily buckets observed; omitted days remain unknown.'); setState('updatedAt', at);
      });
    });
    const cohort = metric => history.collectCohort({ row, metric, endpoint: `${route}/${metric === 'stars' ? 'stargazers/history' : 'forks'}`, at, context, anchor: repo[metric], anchorRevision: cohortRevisions[metric] ?? null, verifyAnchor: async () => {
      const check = normalizeRepository((await request(route, {}, row.access, context)).data);
      if (check.id !== row.id || row.access === 'public' && check.visibility !== 'public') throw safe('Repository identity or access changed.', 403, 'identity_changed');
      return check[metric];
    } });
    perform('star_activity', () => cohort('stars'));
    perform('activity', () => collectFeed(row, route, web, context, at));
    perform('history_forks', () => cohort('forks'));
    for (const [metric, endpoint, normalize, query, branch] of [
      ['commits', 'commits', normalizeCommits, job => ({ sha: repo.branch, until: job.started_at }), repo.branch],
      ['merged_prs', 'pulls', normalizePulls, () => ({ state: 'all', sort: 'created', direction: 'asc' })],
      ['releases', 'releases', normalizeReleases, () => ({})],
    ]) perform(`history_${metric}`, () => history.collectEvents({ row, metric, endpoint: `${route}/${endpoint}`, query, normalize, at, context, branch }));
    const cursor=getState('familyCursor:'+row.id),pivot=Math.max(0,jobs.findIndex(job=>job.metric===cursor));
    const ordered=[...jobs.slice(pivot),...jobs.slice(0,pivot)];let deferred=null;
    for(const {metric,action} of ordered){
      if(db.prepare('SELECT paused FROM repositories WHERE id=?').get(row.id)?.paused)break;
      run(row.id,metric,'collecting',at,'Collecting endpoint.');
      const beforeRequests = context[row.access] ?? 0;
      try{await action();}catch(error){
        successful=false;endpointFailure(row.id,metric,error,at);
        if(['budget_exhausted','rate_limited'].includes(error.code)&&deferred===null) {
          // A large family that consumes the whole identity budget must yield
          // to its siblings next cycle, not pin the cursor to itself forever.
          deferred = (context[row.access] ?? 0) > beforeRequests ? ordered[(ordered.findIndex(job => job.metric === metric) + 1) % ordered.length].metric : metric;
        }
      }
    }
    if(deferred)setState('familyCursor:'+row.id,deferred);
    else db.prepare('DELETE FROM state WHERE key=?').run('familyCursor:'+row.id);
    return successful;
  }
  function sync() {
    ensureOpen();
    if (flight) return flight;
    flight = tracked(async () => {
      const at = clock().toISOString();
      setState('lastAttempt', at);
      const context = {};
      let succeeded = 0;
      const all=db.prepare('SELECT * FROM repositories WHERE paused=0 ORDER BY id').all(),rows=[];
      const queues=new Map();
      for(const access of ['token','public']){
        const selected=all.filter(row=>row.access===access),cursor=getState('repositoryCursor:'+access),pivot=Math.max(0,selected.findIndex(row=>row.id===cursor));
        const queue=[...selected.slice(pivot),...selected.slice(0,pivot)];queues.set(access,queue);rows.push(...queue);
      }
      const deferred=new Set();
      for(const row of rows){
        if(db.prepare('SELECT paused FROM repositories WHERE id=?').get(row.id)?.paused)continue;
        if(await collect(row,context,at))succeeded++;
        const limited=db.prepare("SELECT 1 FROM runs WHERE repo_id=? AND last_attempt=? AND status IN ('budget_exhausted','rate_limited') LIMIT 1").get(row.id,at);
        if(limited&&!deferred.has(row.access)){
          const queue=queues.get(row.access),index=queue.findIndex(item=>item.id===row.id);
          // Start after the first deferred repo next cycle; its family cursor resumes
          // remaining work when its turn returns. Large watches cannot starve peers.
          setState('repositoryCursor:'+row.access,queue[(index+1)%queue.length].id);deferred.add(row.access);
        }
      }
      if (rows.length > 0 && succeeded === rows.length) setState('lastSuccess', at);
      return { status: rows.length === 0 ? 'idle' : succeeded === rows.length ? 'ok' : 'partial', repositories: rows.length, succeeded, failed: rows.length - succeeded };
    }).catch(() => ({ status: 'error', message: 'Collection failed; previous observations retained.' })).finally(() => { flight = null; });
    return flight;
  }
  function pauseWatch(id) {
    ensureOpen();
    if (typeof id !== 'string' || !/^\d+$/.test(id)) throw safe('Invalid watch ID.');
    if (!db.prepare('UPDATE repositories SET paused=1 WHERE id=?').run(id).changes) throw safe('Watch not found.', 404);
    return {};
  }
  const backup = destination => tracked(async () => {
    if (typeof destination !== 'string' || !destination || resolve(destination) === resolve(path)) throw safe('Invalid backup destination.');
    // Reserve a new private file before SQLite writes; never clobber an existing database or symlink.
    try { const fd = openSync(destination, 'wx', 0o600); closeSync(fd); }
    catch { throw safe('Invalid backup destination; choose a new writable file.'); }
    try { await sqliteBackup(db, destination); return { ok: true }; }
    catch { try { unlinkSync(destination); } catch {} throw safe('Database backup failed.', 500, 'storage'); }
  });
  async function close() {
    if (closed) return;
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      await Promise.allSettled([...pending]);
      // Release exclusivity only after every operation and the data connection
      // have closed. If close fails, retain ownership and allow a close retry.
      db?.close(); db = null;
      writerLock?.close(); writerLock = null;
      if (ownsActive) { ACTIVE.delete(path); ownsActive = false; }
      closed = true;
    })();
    try { await closePromise; } finally { closePromise = null; }
  }
  function setNextRun(iso) {
    ensureOpen();
    if (iso !== null && (typeof iso !== 'string' || !Number.isFinite(Date.parse(iso)))) throw safe('Invalid schedule.');
    nextRun = iso === null ? null : new Date(iso).toISOString();
  }
  return { dashboard, status, events, activity, details, discover, addWatch, sync, pauseWatch, backup, close, setNextRun, notificationContext };
}
