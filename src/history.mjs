// History is separate from raw observations and the capped Events feed.
// Only validated metadata, daily counts and resume/provenance state live here.
const DAY = 86_400_000;
export const HISTORY_FLOOR = '2008-01-01';
export function migrateHistory(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_jobs (
      repo_id TEXT NOT NULL REFERENCES repositories(id), metric TEXT NOT NULL,
      page INTEGER NOT NULL DEFAULT 1, generation INTEGER NOT NULL DEFAULT 1,
      cutoff TEXT NOT NULL, started_at TEXT NOT NULL, checked_at TEXT,
      anchor INTEGER, branch TEXT, status TEXT NOT NULL DEFAULT 'backfilling',
      exhausted INTEGER NOT NULL DEFAULT 0, coherent INTEGER NOT NULL DEFAULT 0,
      first_day TEXT, head TEXT, PRIMARY KEY(repo_id,metric)
    );
    CREATE TABLE IF NOT EXISTS history_buckets (
      repo_id TEXT NOT NULL REFERENCES repositories(id), metric TEXT NOT NULL,
      generation INTEGER NOT NULL, day TEXT NOT NULL, value INTEGER NOT NULL CHECK(value>=0),
      PRIMARY KEY(repo_id,metric,generation,day)
    );
    CREATE TABLE IF NOT EXISTS history_members (
      repo_id TEXT NOT NULL REFERENCES repositories(id), metric TEXT NOT NULL,
      generation INTEGER NOT NULL, id TEXT NOT NULL, day TEXT NOT NULL,
      PRIMARY KEY(repo_id,metric,generation,id)
    );
    CREATE TABLE IF NOT EXISTS cohort_observations (
      repo_id TEXT NOT NULL REFERENCES repositories(id), metric TEXT NOT NULL,
      value INTEGER NOT NULL CHECK(value>=0), revision INTEGER NOT NULL CHECK(revision>0),
      PRIMARY KEY(repo_id,metric)
    );
  `);
  if (!db.prepare('PRAGMA table_info(repositories)').all().some(c => c.name === 'created_day')) db.exec('ALTER TABLE repositories ADD COLUMN created_day TEXT;');
  // Unknown legacy revisions are not silently certified. Preserve old rows;
  // projections fail closed until a fresh traversal establishes provenance.
  if (!db.prepare('PRAGMA table_info(history_jobs)').all().some(c => c.name === 'anchor_revision')) db.exec('ALTER TABLE history_jobs ADD COLUMN anchor_revision INTEGER;');
  db.exec('PRAGMA user_version=5;');
}

export function createHistory({ db, transaction, request, maxPages, safe, dateOf, isoDay, datesBetween, putPoint, storeEvent, run, setState }) {
  const jobFor = (id, metric) => db.prepare('SELECT * FROM history_jobs WHERE repo_id=? AND metric=?').get(id, metric);
  const freshCohort = job => job?.anchor_revision != null && db.prepare('SELECT revision FROM cohort_observations WHERE repo_id=? AND metric=?').get(job.repo_id, job.metric)?.revision === job.anchor_revision;
  const failure = (id, metric, error, at) => {
    const status = ['forbidden', 'unauthorized', 'credentials_missing'].includes(error.code) ? 'no_access'
      : ['rate_limited', 'budget_exhausted', 'partial'].includes(error.code) ? 'backfilling' : 'error';
    db.prepare('UPDATE history_jobs SET status=? WHERE repo_id=? AND metric=?').run(status, id, metric);
    run(id, `history_${metric}`, error.code || 'error', at, status === 'no_access' ? 'Historical endpoint access unavailable; cache retained.' : 'Historical collection deferred or failed; resume checkpoint retained.');
  };
  const progress = (id, metric, at, complete) => {
    const exhausted = jobFor(id, metric)?.exhausted;
    run(id, `history_${metric}`, complete ? 'ok' : 'partial', at, complete ? 'Paginated historical coverage cached.' : exhausted ? 'Historical traversal cached; coverage or count discrepancy remains.' : 'Historical backfill in progress; cached totals are partial.');
    setState('updatedAt', at);
  };
  const initialize = (row, metric, at, cutoff, anchor = null, branch = null, anchorRevision = null) => {
    db.prepare(`INSERT INTO history_jobs(repo_id,metric,cutoff,started_at,anchor,branch,anchor_revision) VALUES(?,?,?,?,?,?,?) ON CONFLICT(repo_id,metric) DO NOTHING`).run(row.id, metric, cutoff, at, anchor, branch, anchorRevision);
    return jobFor(row.id, metric);
  };
  const morePages = (response, size) => /\brel\s*=\s*["']?next\b/i.test(response.link) || response.data.length === size;
  const pageArray = (response, size) => {
    if (!Array.isArray(response.data) || response.data.length > size) throw safe('Invalid historical page.', 502, 'invalid_response');
    return response.data;
  };

  // The recent collector and backfill use exactly the same endpoint normalizer.
  // Commits have a frozen until; PRs use stable ascending creation order. A
  // release-list traversal is retained coverage, not an immutable event ledger.
  async function collectEvents({ row, metric, endpoint, query, normalize, at, context, branch }) {
    // Freeze a complete traversal through the initial collection time, not just
    // dates older than the recent window. Even very busy recent windows that
    // exceed one run's budget can then progressively enter the cache.
    const cutoff = isoDay(Date.parse(`${isoDay(at)}T00:00:00Z`) + DAY);
    let job = initialize(row, metric, at, cutoff, null, branch ?? null);
    if (job.branch !== (branch ?? null)) {
      // A default-branch change invalidates completion, not retained history.
      transaction(() => db.prepare("UPDATE history_jobs SET page=1,generation=generation+1,cutoff=?,started_at=?,branch=?,status='backfilling',exhausted=0,coherent=0 WHERE repo_id=? AND metric=?").run(cutoff, at, branch ?? null, row.id, metric));
      job = jobFor(row.id, metric);
    }
    if (job.exhausted) { progress(row.id, metric, at, Boolean(job.coherent)); return; }
    try {
      for (let count = 0; count < Math.min(maxPages, 2); count++) {
        const response = await request(endpoint, { ...query(job), per_page: 100, page: job.page }, row.access, context);
        const values = normalize(pageArray(response, 100)).filter(value => value.day < job.cutoff && value.day <= isoDay(at));
        const more = morePages(response, 100);
        transaction(() => {
          // Persist a validated page and its cursor together. Failed requests or
          // validation/storage errors never move the checkpoint.
          for (const value of values) {
            // Backfill adds missing metadata; it must not erase richer retained
            // context collected under the existing recent-activity contract.
            if (!db.prepare('SELECT 1 FROM events WHERE id=?').get(`${row.id}:${metric}:${value.id}`)) storeEvent(row.id, metric, { ...value, summary: undefined }, at);
          }
          const counts = db.prepare('SELECT day,COUNT(*) AS value FROM events WHERE repo_id=? AND type=? AND day<? GROUP BY day ORDER BY day').all(row.id, metric, job.cutoff);
          for (const point of counts) {
            const retained = db.prepare('SELECT value FROM points WHERE repo_id=? AND metric=? AND day=?').get(row.id, metric, point.day)?.value ?? 0;
            putPoint(row.id, metric, point.day, Math.max(retained, point.value), at);
          }
          let first = counts[0]?.day ?? isoDay(job.started_at);
          const created = db.prepare('SELECT created_day FROM repositories WHERE id=?').get(row.id).created_day;
          if (created && created < first) first = created;
          if (!more) {
            const byDay = new Map(counts.map(p => [p.day, p.value]));
            const last = isoDay(Date.parse(`${job.cutoff}T00:00:00Z`) - DAY);
            // Only proved end-of-pagination authorizes zero days. Historical
            // legacy counts without records are retained, never erased here.
            const insert = db.prepare('INSERT INTO points(repo_id,metric,day,value,observed_at) VALUES(?,?,?,?,?) ON CONFLICT(repo_id,metric,day) DO NOTHING');
            for (const day of datesBetween(first < HISTORY_FLOOR ? HISTORY_FLOOR : first, last)) insert.run(row.id, metric, day, byDay.get(day) ?? 0, at);
          }
          const legacyMismatch = !more && db.prepare('SELECT 1 FROM points p WHERE p.repo_id=? AND p.metric=? AND p.day<? AND p.value<>(SELECT COUNT(*) FROM events e WHERE e.repo_id=p.repo_id AND e.type=p.metric AND e.day=p.day) LIMIT 1').get(row.id, metric, job.cutoff);
          const coherent = !more && job.generation === 1 && !legacyMismatch;
          db.prepare('UPDATE history_jobs SET page=?,exhausted=?,coherent=?,status=?,first_day=?,checked_at=? WHERE repo_id=? AND metric=?').run(job.page + 1, Number(!more), Number(coherent), more ? 'backfilling' : coherent ? 'complete' : 'limited', first, at, row.id, metric);
          progress(row.id, metric, at, coherent);
        });
        if (!more) return;
        job = jobFor(row.id, metric);
      }
    } catch (error) { failure(row.id, metric, error, at); throw error; }
  }

  const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
  function cohortPage(response, metric, end) {
    let items = response.data, weekly = metric === 'stars' && Array.isArray(items) && (!items.length || Object.hasOwn(items[0], 'week'));
    const buckets = [], members = [];
    if (metric === 'stars') {
      if (weekly) {
        pageArray(response, 30);
        for (const item of items) {
          if (!nonnegative(item.week) || item.week > 253402300799 || !Array.isArray(item.days) || item.days.length !== 7 || !item.days.every(nonnegative)) throw safe('Invalid star-history bucket.', 502, 'invalid_response');
          item.days.forEach((value, index) => {
            const day = dateOf(isoDay(item.week * 1000 + index * DAY));
            if (!day) throw safe('Invalid star-history date.', 502, 'invalid_response');
            buckets.push({ day, value });
          });
        }
      } else {
        items = Array.isArray(items) ? items : items?.stars ?? items?.history ?? items?.stargazers;
        if (!Array.isArray(items) || items.length > 3660) throw safe('Unsupported star-history format.', 502, 'invalid_response');
        for (const item of items) {
          const day = dateOf(item.timestamp ?? item.date);
          if (!day || !nonnegative(item.count)) throw safe('Invalid star-history bucket.', 502, 'invalid_response');
          buckets.push({ day, value: item.count });
        }
      }
      if (new Set(buckets.map(p => p.day)).size !== buckets.length) throw safe('Duplicate historical days.', 502, 'invalid_response');
    } else {
      pageArray(response, 100);
      for (const item of items) {
        const day = dateOf(item.created_at);
        if (!nonnegative(item.id) || item.id < 1 || !day || day > end) throw safe('Invalid fork-history metadata.', 502, 'invalid_response');
        members.push({ id: String(item.id), day });
      }
    }
    // This is an allowlisted normalized page signature, never a raw payload.
    const head = JSON.stringify(metric === 'stars' ? buckets : members);
    const more = metric === 'stars' ? weekly && morePages(response, 30) : morePages(response, 100);
    return { buckets: buckets.filter(p => p.day <= end), members, head, more, native: metric === 'forks' || weekly };
  }
  async function collectCohort({ row, metric, endpoint, at, context, anchor, anchorRevision, verifyAnchor }) {
    const end = isoDay(at), size = metric === 'stars' ? 30 : 100;
    let job = initialize(row, metric, at, end, nonnegative(anchor) ? anchor : null, null, anchorRevision);
    // Capture provenance with metadata, not after an await (or at the start of
    // a later family). Compare it again inside the committing transaction.
    const fresh = () => job.anchor_revision === anchorRevision && freshCohort(job)
      && jobFor(row.id, metric)?.generation === job.generation;
    const reset = () => {
      transaction(() => {
        db.prepare("UPDATE history_jobs SET page=1,generation=generation+1,cutoff=?,started_at=?,checked_at=NULL,anchor=?,anchor_revision=?,status='backfilling',exhausted=0,coherent=0,first_day=NULL,head=NULL WHERE repo_id=? AND metric=?").run(end, at, nonnegative(anchor) ? anchor : null, anchorRevision, row.id, metric);
        db.prepare('DELETE FROM history_buckets WHERE repo_id=? AND metric=? AND generation<?').run(row.id, metric, job.generation);
        db.prepare('DELETE FROM history_members WHERE repo_id=? AND metric=? AND generation<?').run(row.id, metric, job.generation);
      });
      job = jobFor(row.id, metric);
    };
    const getPage = page => request(endpoint, { per_page: size, page, ...(metric === 'forks' ? { sort: 'oldest' } : {}) }, row.access, context);
    try {
      // Do not rewind an unfinished long traversal whenever a popular repo's
      // balance changes. Finish/cache it, fail reconciliation honestly, then
      // start a fresh generation. Otherwise active repos could never backfill.
      if (job.exhausted && (job.checked_at === null || !fresh() || job.anchor !== anchor || Date.parse(at) - Date.parse(job.started_at) >= 7 * DAY)) reset();
      let cachedHead;
      if (job.exhausted) {
        cachedHead = cohortPage(await getPage(1), metric, end);
        if (cachedHead.head === job.head) {
          transaction(() => {
            const current = fresh();
            const coherent = Boolean(job.coherent && current);
            for (const p of cachedHead.buckets) {
              db.prepare('INSERT OR REPLACE INTO history_buckets VALUES(?,?,?,?,?)').run(row.id, metric, job.generation, p.day, p.value);
              putPoint(row.id, 'star_activity', p.day, p.value, at);
            }
            if (metric === 'forks' && coherent) {
              const insert = db.prepare('INSERT OR IGNORE INTO history_buckets VALUES(?,?,?,?,0)');
              for (const day of datesBetween(job.cutoff, end)) insert.run(row.id, metric, job.generation, day);
            }
            db.prepare('UPDATE history_jobs SET checked_at=?,cutoff=?,coherent=?,status=? WHERE repo_id=? AND metric=?').run(current ? at : null, end, Number(coherent), coherent ? 'complete' : 'limited', row.id, metric);
            progress(row.id, metric, at, coherent);
            if (metric === 'stars') run(row.id, 'star_activity', 'ok', at, 'Provider cohort buckets refreshed; removed stars are absent.');
          });
          return;
        }
        reset();
      }
      for (let count = 0; count < Math.min(maxPages, 2); count++) {
        if (metric === 'stars' && job.page > 100) {
          db.prepare("UPDATE history_jobs SET status='limited',exhausted=1,coherent=0 WHERE repo_id=? AND metric=?").run(row.id, metric);
          progress(row.id, metric, at, false);
          return;
        }
        const page = cachedHead && job.page === 1 ? cachedHead : cohortPage(await getPage(job.page), metric, end);
        cachedHead = null;
        // Completion is conditional on the same traversal's head and current
        // metadata count. GitHub offers no immutable snapshot: label the result
        // as a reconstructed surviving cohort, never historical actual balances.
        let coherentAnchor = false;
        if (!page.more) {
          const head = job.page === 1 ? page.head : cohortPage(await getPage(1), metric, end).head;
          coherentAnchor = page.native && head === (job.head ?? page.head) && nonnegative(anchor) && job.anchor === anchor && await verifyAnchor() === anchor;
        }
        transaction(() => {
          const current = fresh();
          coherentAnchor = coherentAnchor && current;
          for (const p of page.buckets) {
            const existing = db.prepare('SELECT value FROM history_buckets WHERE repo_id=? AND metric=? AND generation=? AND day=?').get(row.id, metric, job.generation, p.day);
            if (existing && existing.value !== p.value) throw safe('Historical generation changed during pagination.', 502, 'invalid_response');
            db.prepare('INSERT OR REPLACE INTO history_buckets VALUES(?,?,?,?,?)').run(row.id, metric, job.generation, p.day, p.value);
            putPoint(row.id, 'star_activity', p.day, p.value, at);
          }
          for (const p of page.members) db.prepare('INSERT OR REPLACE INTO history_members VALUES(?,?,?,?,?)').run(row.id, metric, job.generation, p.id, p.day);
          if (metric === 'forks') {
            db.prepare('DELETE FROM history_buckets WHERE repo_id=? AND metric=? AND generation=?').run(row.id, metric, job.generation);
            db.prepare('INSERT INTO history_buckets SELECT repo_id,metric,generation,day,COUNT(*) FROM history_members WHERE repo_id=? AND metric=? AND generation=? GROUP BY day').run(row.id, metric, job.generation);
          }
          let stats = db.prepare('SELECT MIN(day) AS first,MAX(day) AS last,COUNT(*) AS days,SUM(value) AS total FROM history_buckets WHERE repo_id=? AND metric=? AND generation=?').get(row.id, metric, job.generation);
          if (!page.more && metric === 'forks' && coherentAnchor && (stats.total ?? 0) === anchor) {
            const insert = db.prepare('INSERT OR IGNORE INTO history_buckets VALUES(?,?,?,?,0)');
            for (const day of datesBetween(stats.first && stats.first > HISTORY_FLOOR ? stats.first : stats.first ? HISTORY_FLOOR : end, end)) insert.run(row.id, metric, job.generation, day);
            stats = db.prepare('SELECT MIN(day) AS first,MAX(day) AS last,COUNT(*) AS days,SUM(value) AS total FROM history_buckets WHERE repo_id=? AND metric=? AND generation=?').get(row.id, metric, job.generation);
          }
          const contiguous = stats.first && stats.last === end && stats.days === Math.round((Date.parse(end) - Date.parse(stats.first)) / DAY) + 1;
          const coherent = !page.more && coherentAnchor && Boolean(contiguous) && stats.total === anchor;
          const capped = metric === 'stars' && job.page === 100 && page.more;
          const status = page.more && !capped ? 'backfilling' : coherent ? 'complete' : 'limited';
          db.prepare('UPDATE history_jobs SET page=?,exhausted=?,coherent=?,status=?,first_day=?,head=COALESCE(head,?),checked_at=?,cutoff=? WHERE repo_id=? AND metric=?').run(job.page + 1, Number(!page.more || capped), Number(coherent), status, stats.first, page.head, current ? at : null, end, row.id, metric);
          progress(row.id, metric, at, coherent);
          if (metric === 'stars') run(row.id, 'star_activity', 'ok', at, 'Provider cohort buckets observed; omitted days remain unknown.');
        });
        if (!page.more || metric === 'stars' && job.page === 100) return;
        job = jobFor(row.id, metric);
      }
    } catch (error) { failure(row.id, metric, error, at); throw error; }
  }

  // SQL computes totals and running totals. This cache avoids rescanning all
  // retained days when changing ranges. Both local writes and other SQLite
  // connections invalidate it; GETs do no writes and no provider I/O.
  let revision = '', projections = new Map();
  function series(id, metric, end, reconstructed = false) {
    const next = `${db.prepare('SELECT total_changes() AS n').get().n}:${db.prepare('PRAGMA data_version').get().data_version}`;
    if (next !== revision) { revision = next; projections.clear(); }
    const key = `${id}:${metric}:${end}:${reconstructed}`;
    if (projections.has(key)) return projections.get(key);
    const rows = reconstructed ? db.prepare(`SELECT b.day,b.value,SUM(b.value) OVER(ORDER BY b.day) AS cumulative FROM history_buckets b
      JOIN history_jobs j ON j.repo_id=b.repo_id AND j.metric=b.metric AND j.generation=b.generation
      WHERE b.repo_id=? AND b.metric=? AND b.day<=? ORDER BY b.day`).all(id, metric, end)
      : db.prepare('SELECT day,value,SUM(value) OVER(ORDER BY day) AS cumulative FROM points WHERE repo_id=? AND metric=? AND day<=? ORDER BY day').all(id, metric, end);
    projections.set(key, rows);
    return rows;
  }
  function project(id, metric, kind, dates, outcome) {
    const end = dates.at(-1), start = dates[0];
    const jobMetric = metric === 'star_activity' ? 'stars' : metric;
    const job = jobFor(id, jobMetric);
    const balances = ['stars', 'forks'].includes(metric);
    const fresh = !['stars', 'forks'].includes(jobMetric) || freshCohort(job);
    const reconstruct = balances && fresh && job?.exhausted === 1 && job?.coherent === 1;
    const raw = series(id, metric, end);
    const cohort = reconstruct || metric === 'star_activity' && job ? series(id, jobMetric, end, true) : [];
    const source = cohort.length ? cohort : raw;
    const byDay = new Map(source.map(p => [p.day, reconstruct || kind === 'event' ? p.cumulative : p.value]));
    if (balances) for (const point of raw) byDay.set(point.day, point.value); // Real observations always win.
    let prior = null;
    // Binary search is for alignment only; sums came from SQLite above.
    let lo = 0, hi = source.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (source[mid].day < start) lo = mid + 1; else hi = mid; }
    if (lo) prior = source[lo - 1];
    const first = (balances ? [source[0]?.day, raw[0]?.day].filter(Boolean).sort()[0] : source[0]?.day) ?? null;
    const value = kind === 'balance' ? raw.at(-1)?.value ?? (reconstruct ? source.at(-1)?.cumulative : null) ?? null : source.at(-1)?.cumulative ?? null;
    const baseline = kind === 'balance' ? null : source.length ? prior?.cumulative ?? 0 : null;
    const denied = ['forbidden', 'unauthorized', 'credentials_missing'].includes(outcome?.status) || job?.status === 'no_access';
    const failed = outcome && !['ok', 'collecting', 'not_collected', 'disabled', 'partial', 'budget_exhausted', 'rate_limited'].includes(outcome.status);
    const contiguous = source.length > 0 && source.length === Math.round((Date.parse(end) - Date.parse(first)) / DAY) + 1;
    let complete = Boolean(fresh && job?.exhausted && job.coherent && contiguous && outcome?.status === 'ok' && job.status === 'complete');
    if (['views', 'clones', 'issues'].includes(metric)) complete = false;
    let status = denied ? 'no_access' : failed || job?.status === 'error' ? 'error' : complete ? 'complete'
      : job && !job.exhausted ? 'backfilling' : value === null ? 'not_collected' : 'limited';
    let historyKind = balances && reconstruct || metric === 'star_activity' ? 'reconstructed' : ['views', 'clones'].includes(metric) ? 'retained' : 'recorded';
    let label = metric === 'views' || metric === 'clones' ? 'Since tracking began — recorded traffic; gaps may remain.'
      : metric === 'issues' ? 'Observed open-issue balances only; earlier reopen history unavailable.'
      : balances || metric === 'star_activity' ? (reconstruct || metric === 'star_activity' ? 'Reconstructed history of current surviving ' + (jobMetric === 'stars' ? 'stars; removed stars are absent.' : 'forks; deleted forks are absent.') : 'Observed balances; reconstructed history unavailable or incomplete.')
      : complete ? 'Recorded history — paginated endpoint coverage.' : 'Partial recorded history; cached totals only.';
    if (status === 'backfilling') label += ' Backfilling historical pages.';
    if (metric === 'star_activity' && !cohort.length && raw.length) label = 'Retained star buckets; cohort consistency unverified. ' + label;
    if (job?.exhausted && (!job.coherent || !fresh)) label += ' Provider coverage or count discrepancy.';
    if (metric === 'commits' && job?.generation > 1) label += ' Default branch changed; earlier retained branch history is included.';
    if (denied) label += ' No access; retained cache shown.';
    else if (status === 'error') label += ' Collection failed; retained cache shown.';
    return { value, points: dates.map(date => ({ date, value: byDay.get(date) ?? null })), baseline, from: first, complete, status, kind: historyKind, label };
  }
  return { collectEvents, collectCohort, project };
}
