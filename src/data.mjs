import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync, realpathSync, chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
const isoDay = date => new Date(date).toISOString().slice(0, 10);
const text = (value, max = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : null;
const nonnegative = n => Number.isSafeInteger(n) && n >= 0;
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
  return { id: String(value.id), ...names, visibility: value.private ? 'private' : 'public', archived: value.archived, language: text(value.language, 100), description: text(value.description, 500), branch: value.default_branch, stars: value.stargazers_count, forks: value.forks_count };
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
  let lockPath = null;
  let ownsLock = false;
  let db;
  let closed = false;
  let closing = false;
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
      lockPath = `${path}.writer.lock`;
      try {
        const fd = openSync(lockPath, 'wx', 0o600);
        ownsLock = true;
        try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Serialize stale-lock recovery: a competing startup must not unlink a newly acquired lock.
        const recoveryPath = `${lockPath}.recovery`;
        let recovery;
        try { recovery = openSync(recoveryPath, 'wx', 0o600); }
        catch { throw safe('Database writer recovery is already active.', 409, 'busy'); }
        try {
          const pid = Number(readFileSync(lockPath, 'utf8'));
          if (!Number.isSafeInteger(pid) || pid < 1) throw safe('Database writer lock requires recovery.', 409, 'busy');
          let alive = true;
          try { process.kill(pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
          if (alive) throw safe('Database already has an active writer.', 409, 'busy');
          unlinkSync(lockPath);
          const fd = openSync(lockPath, 'wx', 0o600);
          ownsLock = true;
          try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
        } finally { closeSync(recovery); unlinkSync(recoveryPath); }
      }
      ACTIVE.add(path);
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
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budgets (identity TEXT PRIMARY KEY, remaining INTEGER NOT NULL, reset_at INTEGER NOT NULL, blocked_until INTEGER NOT NULL DEFAULT 0);
      PRAGMA user_version=1;`);
  } catch (error) {
    try { db?.close(); } catch {}
    if (ownsLock) { ACTIVE.delete(path); try { unlinkSync(lockPath); } catch {} }
    throw error.safeMessage ? error : safe('Unable to open local database.', 500, 'storage');
  }
  const getState = key => db.prepare('SELECT value FROM state WHERE key=?').get(key)?.value ?? null;
  const setState = (key, value) => db.prepare('INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  // A process interruption is visible; prior committed endpoint results remain intact.
  db.prepare("UPDATE runs SET status='interrupted', message='Collection interrupted; previous observations retained.' WHERE status='collecting'").run();
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
    if (!/^\/(?:repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[a-z_/-]+)?|user\/repos)$/.test(endpoint)) throw safe('Invalid upstream route.', 500, 'invalid');
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
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => {});
        const code = response.status === 404 ? 'unsupported' : response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : 'upstream_error';
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
      return { data, link: response.headers.get('link') || '' };
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
      if (stop?.(response.data)) return { items, complete: true };
      const next = /\brel\s*=\s*["']?next\b/i.test(response.link);
      if (!next && response.data.length < 100) return { items, complete: true };
      // A full page without Link is ambiguous; request the next page rather than zero-filling.
      if (page === maxPages) return { items, complete: false };
    }
    return { items, complete: false };
  }
  function storeRepository(repo, access, alias, at, resume) {
    db.prepare(`INSERT INTO repositories(id,owner,name,visibility,archived,language,description,branch,access) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,name=excluded.name,visibility=excluded.visibility,archived=excluded.archived,
      language=excluded.language,description=excluded.description,branch=excluded.branch,access=excluded.access,
      paused=CASE WHEN ? THEN 0 ELSE repositories.paused END`).run(repo.id, repo.owner, repo.name, repo.visibility, Number(repo.archived), repo.language, repo.description, repo.branch, access, Number(resume));
    for (const name of [alias, repo.full]) db.prepare('INSERT INTO aliases(alias,repo_id) VALUES(?,?) ON CONFLICT(alias) DO UPDATE SET repo_id=excluded.repo_id').run(name.toLowerCase(), repo.id);
    for (const metric of ['stars', 'forks']) {
      if (nonnegative(repo[metric])) { putPoint(repo.id, metric, isoDay(at), repo[metric], at); run(repo.id, metric, 'ok', at, 'Observed repository balance.'); }
      else run(repo.id, metric, 'invalid_response', at, 'Repository balance unavailable; previous observations retained.');
    }
    run(repo.id, 'metadata', 'ok', at, 'Repository metadata collected.');
  }
  function dashboard(range = '30') {
    ensureOpen();
    const selection = String(range);
    if (!['7', '30', '90', 'all'].includes(selection)) throw safe('Invalid range.');
    const end = isoDay(clock());
    const lower = isoDay(Date.parse(`${end}T00:00:00Z`) - 3659 * DAY);
    const first = db.prepare('SELECT MIN(day) AS day FROM points WHERE day<=?').get(end).day;
    const start = selection === 'all' ? (first && first > lower ? first : first ? lower : end) : isoDay(Date.parse(`${end}T00:00:00Z`) - (Number(selection) - 1) * DAY);
    const dates = datesBetween(start, end);
    const repos = db.prepare('SELECT * FROM repositories WHERE paused=0 ORDER BY lower(owner),lower(name)').all().map(row => {
      const metrics = {};
      const records = db.prepare('SELECT * FROM runs WHERE repo_id=?').all(row.id);
      for (const [key, [label, kind, unit, source]] of Object.entries(DEFINITIONS)) {
        const outcome = records.find(item => item.metric === key);
        const latest=db.prepare('SELECT day,value,observed_at FROM points WHERE repo_id=? AND metric=? AND day<=? ORDER BY day DESC LIMIT 1').get(row.id,key,end);
        if(!latest)continue;
        const observations = db.prepare('SELECT day,value FROM points WHERE repo_id=? AND metric=? AND day>=? AND day<=? ORDER BY day').all(row.id, key, start, end);
        const byDay = new Map(observations.map(point => [point.day, point.value]));
        const points = dates.map(date => ({ date, value: byDay.get(date) ?? null }));
        const complete = observations.length === dates.length && outcome?.status === 'ok';
        const value=kind==='balance'?latest.value:observations.length?observations.reduce((sum,point)=>sum+point.value,0):null;
        metrics[key] = { label, kind, unit, value, observedAt:latest.observed_at, delta: kind === 'balance' && complete && dates.length > 1 ? points.at(-1).value - points[0].value : null, points,
          coverage: { start: observations[0]?.day ?? null, end: observations.at(-1)?.day ?? null, complete }, status: row.paused ? 'paused' : outcome?.status ?? 'not_collected', lastSuccess: outcome?.last_success ?? null, source };
      }
      return { ...publicRepo(row), metrics };
    });
    return { dates, repos, updatedAt: getState('updatedAt'), collecting: Boolean(flight), credentialConfigured: Boolean(token) };
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
    return { events: db.prepare(`SELECT events.*,repositories.owner,repositories.name FROM events JOIN repositories ON repositories.id=events.repo_id ORDER BY day DESC,id LIMIT ?`).all(Math.min(Number(limit), 500)).map(row => ({ id: row.id, repository: `${row.owner}/${row.name}`, type: row.type, date: row.day, title: row.title, url: row.url, ...(row.author ? { author: row.author } : {}) })) };
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
  function incomplete(result) { if (!result.complete) throw safe('Pagination limit reached; previous observations retained.', 502, 'partial'); return result.items; }
  function endpointFailure(id, metric, error, at) { run(id, metric, error.code || 'error', at, error.safeMessage || 'Collection failed; previous observations retained.'); }
  function putEvents(id, metric, values, start, end, at) {
    const unique = new Map();
    for (const value of values) if (value.day >= start && value.day <= end) unique.set(value.id, value);
    const counts = new Map(datesBetween(start, end).map(day => [day, 0]));
    for (const value of unique.values()) counts.set(value.day, counts.get(value.day) + 1);
    transaction(() => {
      // Exact complete coverage replaces this bounded window, including rebase/deletion corrections.
      db.prepare('DELETE FROM events WHERE repo_id=? AND type=? AND day>=? AND day<=?').run(id, metric, start, end);
      for (const value of unique.values()) db.prepare('INSERT OR REPLACE INTO events(id,repo_id,type,day,title,url,author) VALUES(?,?,?,?,?,?,?)').run(`${id}:${metric}:${value.id}`, id, metric, value.day, value.title, value.url, value.author);
      for (const [day, count] of counts) putPoint(id, metric, day, count, at);
      run(id, metric, 'ok', at, 'Complete bounded event coverage collected.'); setState('updatedAt', at);
    });
  }
  async function collect(row, context, at) {
    const start = isoDay(Date.parse(`${isoDay(at)}T00:00:00Z`) - 179 * DAY);
    const end = isoDay(at);
    let repo;
    run(row.id, 'metadata', 'collecting', at, 'Collecting repository metadata.');
    try {
      repo = normalizeRepository((await request(`/repos/${row.owner}/${row.name}`, {}, row.access, context)).data);
      if (repo.id !== row.id || (row.access === 'public' && repo.visibility !== 'public')) throw safe('Repository identity or access changed.', 403, 'identity_changed');
      transaction(() => { storeRepository(repo, row.access, `${row.owner}/${row.name}`, at, false); setState('updatedAt', at); });
    } catch (error) {
      transaction(() => { for (const metric of ['metadata', ...Object.keys(DEFINITIONS)]) endpointFailure(row.id, metric, error, at); });
      return false;
    }
    const route = `/repos/${repo.full}`;
    const web = `https://github.com/${repo.full}`;
    let successful = nonnegative(repo.stars) && nonnegative(repo.forks);
    const jobs=[];
    const perform=(metric,action)=>{jobs.push({metric,action});};
    await perform('commits', async () => {
      const items = incomplete(await pages(`${route}/commits`, { sha: repo.branch, since: `${start}T00:00:00Z`, until: at }, row.access, context));
      const values = items.map(item => {
        const day = dateOf(item.commit?.committer?.date);
        if (!day || typeof item.sha !== 'string' || !/^[a-fA-F0-9]{1,64}$/.test(item.sha)) throw safe('Invalid commit response.', 502, 'invalid_response');
        return { id: item.sha, day, title: `Commit ${item.sha.slice(0, 7)}`, url: `${web}/commit/${item.sha}`, author: text(item.author?.login, 100) };
      });
      putEvents(row.id, 'commits', values, start, end, at);
    });
    await perform('merged_prs', async () => {
      const items = incomplete(await pages(`${route}/pulls`, { state: 'closed', sort: 'updated', direction: 'desc' }, row.access, context, page => page.length > 0 && page.every(item => dateOf(item.updated_at)) && page.at(-1).updated_at < `${start}T00:00:00Z`));
      const values = [];
      for (const item of items) {
        if (!Object.hasOwn(item, 'merged_at')) throw safe('Invalid pull request response.', 502, 'invalid_response');
        if (!item.merged_at) continue;
        const day = dateOf(item.merged_at);
        if (!day || !nonnegative(item.number) || item.number < 1) throw safe('Invalid pull request response.', 502, 'invalid_response');
        values.push({ id: String(item.number), day, title: text(item.title) || `Pull request #${item.number}`, url: `${web}/pull/${item.number}`, author: text(item.user?.login, 100) });
      }
      putEvents(row.id, 'merged_prs', values, start, end, at);
    });
    await perform('releases', async () => {
      const items = incomplete(await pages(`${route}/releases`, {}, row.access, context));
      const values = [];
      for (const item of items) {
        if (item.draft === true) continue;
        const day = dateOf(item.published_at);
        if (!day || !nonnegative(item.id) || item.id < 1 || typeof item.tag_name !== 'string' || !item.tag_name.length) throw safe('Invalid release response.', 502, 'invalid_response');
        values.push({ id: String(item.id), day, title: text(item.name) || text(item.tag_name) || 'Release', url: `${web}/releases/tag/${encodeURIComponent(item.tag_name)}`, author: text(item.author?.login, 100) });
      }
      putEvents(row.id, 'releases', values, start, end, at);
    });
    await perform('issues', async () => {
      const items = incomplete(await pages(`${route}/issues`, { state: 'open', sort: 'created', direction: 'asc' }, row.access, context));
      const ids = new Set();
      for (const item of items) { if (!nonnegative(item.id) || item.id < 1) throw safe('Invalid issue response.', 502, 'invalid_response'); if (!item.pull_request) ids.add(item.id); }
      transaction(() => { putPoint(row.id, 'issues', end, ids.size, at); run(row.id, 'issues', 'ok', at, 'Observed open issues, excluding pull requests.'); setState('updatedAt', at); });
    });
    for (const metric of ['views', 'clones', 'star_activity']) await perform(metric, async () => {
      const endpoint = metric === 'star_activity' ? `${route}/stargazers/history` : `${route}/traffic/${metric}`;
      const response = await request(endpoint, metric === 'star_activity' ? {per_page:30,page:1} : {per:'day'}, row.access, context);
      let data=response.data;
      // GitHub returns newest-first weekly buckets of seven daily creation counts.
      // Preserve provider boundaries; these are activity, NOT historical star balances.
      let items;
      if(metric==='star_activity'&&Array.isArray(data)&&data.length&&Object.hasOwn(data[0],'week')){
        const daily=[];let complete=false;
        for(let page=1;page<=maxPages;page++){
          if(!Array.isArray(data)||data.length>30)throw safe('Invalid star-history page.',502,'invalid_response');
          let oldest=null;
          for(const bucket of data){
            if(!nonnegative(bucket.week)||bucket.week>253402300799||!Array.isArray(bucket.days)||bucket.days.length!==7||!bucket.days.every(nonnegative))throw safe('Invalid star-history bucket.',502,'invalid_response');
            const first=isoDay(bucket.week*1000);oldest=oldest===null||first<oldest?first:oldest;
            bucket.days.forEach((count,index)=>daily.push({date:isoDay(bucket.week*1000+index*DAY),count}));
          }
          if(data.length<30||oldest<=start){complete=true;break;}
          if(page<maxPages)data=(await request(endpoint,{per_page:30,page:page+1},row.access,context)).data;
        }
        if(!complete)throw safe('Star history reached pagination limit; previous observations retained.',502,'partial');
        items=daily;
      }else{
        // Also accept explicitly dated provider buckets; unknown formats stay unknown.
        items=metric==='star_activity'?(Array.isArray(data)?data:data?.stars??data?.history??data?.stargazers):data?.[metric];
      }
      if (!Array.isArray(items) || items.length > 3660) throw safe('Unsupported aggregate response format.', 502, 'invalid_response');
      const points = new Map();
      const lower = metric === 'star_activity' ? start : isoDay(Date.parse(`${end}T00:00:00Z`) - 14 * DAY);
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
    const cursor=getState('familyCursor:'+row.id),pivot=Math.max(0,jobs.findIndex(job=>job.metric===cursor));
    const ordered=[...jobs.slice(pivot),...jobs.slice(0,pivot)];let deferred=null;
    for(const {metric,action} of ordered){
      if(db.prepare('SELECT paused FROM repositories WHERE id=?').get(row.id)?.paused)break;
      run(row.id,metric,'collecting',at,'Collecting endpoint.');
      try{await action();}catch(error){successful=false;endpointFailure(row.id,metric,error,at);if(['budget_exhausted','rate_limited'].includes(error.code)&&deferred===null)deferred=metric;}
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
    if (closing) { await Promise.allSettled([...pending]); return; }
    closing = true;
    await Promise.allSettled([...pending]);
    db.close(); closed = true;
    if (lockPath) { ACTIVE.delete(path); try { unlinkSync(lockPath); } catch {} }
  }
  function setNextRun(iso) {
    ensureOpen();
    if (iso !== null && (typeof iso !== 'string' || !Number.isFinite(Date.parse(iso)))) throw safe('Invalid schedule.');
    nextRun = iso === null ? null : new Date(iso).toISOString();
  }
  return { dashboard, status, events, discover, addWatch, sync, pauseWatch, backup, close, setNextRun };
}
