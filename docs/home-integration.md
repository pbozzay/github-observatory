# Homepage read-only integration

`GET /api/home-preview` is an optional, dedicated server-to-server projection for compact Homepage count/graph tiles, the latest five actual commits and the latest five local notifications. It reads `service.dashboard('30')`, `service.activity({type:'commits',range:'all',offset:0,limit:5})` and `notifications.list({offset:0,limit:5,unread:false})`; it never collects, discovers repositories, refreshes identity/inbox scope, marks items read, or contacts GitHub. No database schema or collection schedule changes are required. The pure `public/metrics.js` presentation, aggregation and chart-view functions are reused server-side; there is no separate graph math or collector. The additive `commits` field supports graphs above, recent commits on the left and the unchanged notification preview on the right; layout remains the consumer's responsibility.

## Authentication and deployment requirements

- Set **`OBSERVATORY_HOME_TOKEN_FILE`** to an externally managed, read-only mounted secret file. Omit the variable to disable the integration. There is no plaintext-token environment fallback.
- The existing secret-file reader requires a small regular owner-only file (normally mode `0600`), rejects symlinks, and trims its trailing newline. Its value must be 32–128 base64url characters (`A–Z`, `a–z`, `0–9`, `_`, `-`), independently generated and distinct from both proxy and local unlock keys. Use at least 32 random bytes of entropy; syntax validation cannot establish entropy. Files and credentials must remain outside the source checkout.
- The existing **`OBSERVATORY_PUBLIC_ORIGIN`** and **`OBSERVATORY_PROXY_KEY_FILE`** must remain configured. No reverse-proxy authentication, DNS, firewall or port publication changes are part of this feature.
- Homepage's **server-side** custom API proxy calls the existing private backend transport with `Host` equal to the configured public origin's host (including its port if configured) and `Authorization: Bearer <dedicated-token>`. It does **not** send a proxy key, browser cookie, CSRF token or Origin. A supplied Origin must exactly equal the configured public origin; foreign and `null` origins are rejected.
- The sole token exception is the exact raw target **`GET /api/home-preview`**. Query strings (even a bare `?`), trailing slashes, encoded/normalized aliases, absolute-form targets, and every other method/path do not receive the exception. The token cannot unlock a browser session, access other APIs, discover/collect data or mutate notification state. Existing proxy/session/CSRF rules remain in force everywhere else.
- Token comparisons use fixed-length SHA-256 digests with `timingSafeEqual`. The response is `private, no-store`, issues no session cookie and adds no CORS access. Invalid direct requests receive `403`. Unconfigured integration remains denied, rather than returning a fake empty preview.
- Keep the token and upstream headers entirely in Homepage's server-side configuration/secret mechanism. Never place them in browser JavaScript, CSS, HTML, returned widget data, public URLs, logs or a query string. A backend restart loads a changed file; rotation/removal requires updating/restarting the approved runtime, not a new service or cron.

The application does not create a network boundary: use only the existing trusted private transport. The dedicated token is the authorization boundary for this one route even if it is reachable through an existing authenticated reverse proxy.

## Version 1 contract

Authenticated reads return HTTP `200`, including explicitly degraded component states, with this fixed shape:

```text
{
  schemaVersion: 1,
  generatedAt: ISO,
  status: 'ready' | 'partial' | 'error',
  summary: {
    repositories: number | null,
    metrics: [
      {key: 'stars', label: 'Stars', value: number | null, detail: string, points: Point[], graph: Graph, dailyChange: DailyChange},
      {key: 'openIssues', label: 'Open issues', value: number | null, detail: string, points: Point[], graph: Graph, dailyChange: DailyChange},
      {key: 'commits30d', label: 'Commits', value: number | null, detail: string, points: Point[], graph: Graph, dailyChange: DailyChange}
    ]
  },
  freshness: {updatedAt: ISO | null, collecting: boolean | null},
  coverage: {
    stars: MetricCoverage,
    openIssues: MetricCoverage,
    commits30d: MetricCoverage
  },
  commits: {
    status: 'ready' | 'partial' | 'error',
    items: [{
      id: string, title: string, repository: string, url: string,
      author: string | null, occurredAt: ISO | 'YYYY-MM-DD'
    }],
    hasMore: boolean | null,
    updatedAt: ISO | null,
    coverage: {complete: false, label: string}
  },
  notifications: {
    status: 'ready' | 'not_configured' | 'no_access' | 'error',
    unreadCount: number | null,
    items: [{
      id: string, title: string, repository: string, type: string,
      url: string, actor: {login: string} | null, occurredAt: ISO | null,
      readAt: ISO | null, unread: boolean
    }],
    hasMore: boolean | null,
    updatedAt: ISO | null,
    coverage: {complete: false, label: string}
  }
}
MetricCoverage = {
  observedRepositories: number | null,
  totalRepositories: number | null,
  complete: boolean,
  oldestObservedAt: ISO | null
}
Point = {date: 'YYYY-MM-DD', value: number | null}
DailyChange = {
  value: integer | null,
  date: 'YYYY-MM-DD', previousDate: 'YYYY-MM-DD', timeZone: 'UTC',
  basis: 'observed-balances' | 'retained-commit-history',
  reason: string | null
}
Graph = {
  mode: 'totals', kind: 'balance', label: string, comparable: boolean,
  coverage: {start: 'YYYY-MM-DD' | null, end: 'YYYY-MM-DD' | null, complete: boolean},
  history: null | {
    kind: 'recorded' | 'retained' | 'reconstructed', status: string,
    complete: boolean, from: 'YYYY-MM-DD' | null, baseline: number | null, label: string
  }
}
```

### Summary semantics

- `repositories` counts active watched repositories in the existing dashboard, including archived repositories that remain watched. A successful empty dashboard returns `0`; a failed summary read returns `null`, not a fabricated zero.
- `stars` and `openIssues` sum latest retained balances across active watches. Open issues exclude pull requests. These are not sums of daily balances and not reconstructed historical totals.
- `commits30d` is retained as a compatibility **key**, but its label is now `Commits` and its value uses the app's default **Totals over history** model, not a 30-day sum. It sums retained default-branch history, including pre-window observations; earlier retained branches can be included after a default-branch change, as explained by the history label. It is **not** a guaranteed complete all-time total and does not count push notifications. Existing consumers can still render `label`, `value` and `detail`; do not infer units from the legacy key. Schema version remains 1, with additive `points` and `graph` fields.
- All three metric values are `null` when there are no observations, including an empty watch list. Real observed zeros remain `0`. Partial coverage sums only known observations, exposes the observed/total repository counts and labels the result partial; retained values are not erased when the latest collection failed. Unsafe integer sums are `null`.
- Metric `complete` requires a retained value with a valid observation timestamp from every active watch, successful current metric status/availability, and (for commits) complete history coverage. Balance completeness means a retained snapshot for every watch, **not** a fully observed 30-day time series or proof of present-day freshness.
- `oldestObservedAt` is the oldest contributing observation, or `null` if any contributing observation has an unknown timestamp. `freshness.updatedAt` is the existing dashboard's latest update, which may concern another metric. `generatedAt` is response creation time, **never** a successful collection timestamp. Consumers must display the observation times/coverage and not treat a recent response as fresh provider data. No arbitrary freshness threshold is imposed.
- `points` contains at most 30 ascending UTC dates: a **zoom**, not a history reset. Cumulative commit points retain their pre-window baseline. Stars use recorded balances or the app's coherent reconstructed history of current surviving stars; open issues use observed balances, not a running sum. The headline and graph always use the same contributors. A date is `null` if any headline contributor lacks an observation; unknown history totals are authoritative and never replaced by a window count. All-null points (or `[]` when dates are unavailable) mean no graph, not zero. Preserve null gaps and isolated observed points in SVG rendering.
- `graph.coverage`, `graph.history` and `detail` preserve the app's retained/reconstructed/partial history metadata for tooltips. `graph.comparable:false` suppresses plotted values when latest recorded balances have different or unknown observation dates. Unsafe integer totals also suppress points. Do not turn partial historical coverage into a routine visible error; show concise current collection errors separately, and put coverage/freshness explanations in titles or tooltips.

### Daily change semantics

- `dailyChange` is additive metadata on all three metrics; schema version, headline values, graphs, coverage, notification behavior and authentication remain unchanged. It is computed only from the already-loaded dashboard. The injected clock is read once for both `generatedAt` and the comparison dates.
- `date` is **today in UTC** and `previousDate` is the immediately preceding UTC calendar day, not the last two available dates or a rolling 24-hour interval. Today's value is the latest retained observation so far today, not a completed-day count. Both exact daily points are required: no carry-forward, interpolation or missing-as-zero baseline.
- Comparisons use **exactly the current headline's observed repository contributors** on both dates. Unobserved/noncontributing repositories can remain excluded as they are from the headline; a valid delta can therefore coexist with partial overall coverage. Never substitute a smaller, better-covered cohort for a missing contributor.
- Stars and open issues use `basis:'observed-balances'`: subtract yesterday's raw observed balance from today's for each contributor. **Do not subtract the displayed star graph**: reconstructed surviving-star history omits removed stars and cannot measure net unstars. A negative star change can correctly coexist with a rising reconstructed graph. Open issues still exclude pull requests.
- Commits use `basis:'retained-commit-history'`: subtract exact cumulative retained-history points, preserving pre-window history. Each contributor must have complete, available recorded/retained history (`complete:true`, `status:'complete'`); missing, backfilling, limited, failed or inaccessible history suppresses the change. Never substitute the raw 30-day count or reset the retained baseline. This describes the retained default-branch history model, not push events or a guarantee about all GitHub history.
- Every contributor must have current metric `status:'ok'`, no unavailable metric state, and a valid `observedAt` **today and no later than the response clock**. Current points must match each contributing headline value, raw current balances for stars/issues, and the summed headline. Missing/invalid/duplicate exact-day points, stale/future observations, noncomparable dates, inconsistent counts or unsafe integer inputs/sums return `value:null` with a bounded explanatory `reason`. No observations also means `null`, not zero. These stricter daily checks do not redefine the existing summary completeness flag.
- A valid signed integer, including negative values and **zero**, has `reason:null`. Rendering belongs to the consumer: hide null and zero changes; render positive changes as small green `(+3)` text and negative changes as small red `(-1)` text. Do not infer a positive/negative sign from color, or add HTML/color fields to this API.
- Suggested tooltip for a valid value: **“Today vs yesterday (UTC), for the headline's observed contributors; latest observation today, not a full-day total.”** Include the explicit dates, observation freshness and existing coverage. For null values, use `reason` as text if a coverage tooltip is shown. Partial contributor coverage is not a claim about every watched repository.

### Recent commits

- `commits` is additive; schema version remains 1 and existing metrics, graphs, daily changes, notifications and authentication are unchanged. The five newest retained **actual commits** come from all active watched repositories, including public/private, archived, third-party and your own commits. There is no ownership/identity check or self-exclusion. Paused watches are excluded. Push events are not commits and cannot fill this panel.
- The service applies `type:'commits'` in SQL **before both COUNT and LIMIT**, not by filtering a bounded mixed feed. Ordering is occurrence descending, then stable opaque ID ascending for ties. `range:'all'` includes retained history through today, without the graph's 30-day window. `hasMore` describes additional matching local commits, never exhaustive provider coverage. It remains meaningful with a partial collection; a failed/invalid local read returns `null`.
- Items contain only the six listed fields, at most five rows. IDs (max 128 characters), repository names (max 140) and GitHub commit URLs (max 500) are validated and preserved, never truncated into different identifiers. Titles (max 200) and author strings (max 100) reuse the collection's one-line safe-text normalizer; absent/unsafe/hash-placeholder titles use `Commit (title unavailable)`. Unknown authors are `null`, never inferred from push actors or emails. No summaries, bodies, code/diffs, emails, raw payloads, avatars, metadata, mutation snapshots or repository IDs are exported. Render text as text, not HTML.
- `occurredAt` is the retained committer timestamp normalized to ISO, or the exact legacy `YYYY-MM-DD` when time precision is unknown. Do not render date-only records as midnight, convert them through a local-time timestamp, or claim a relative hour/minute. Invalid item identifiers, links or occurrence dates fail this component closed without hiding other components.
- `status:'ready'` means every scoped active watch has a successful latest **commit** collection (or an explicitly confirmed empty repository) with a valid collection timestamp. No active watches is also a known empty result. `partial` means at least one watch is never collected, collecting, inaccessible, failed or missing collection provenance; retain any known items. `error` means the local activity read or its contract failed; return `items:[]`, `hasMore:null`, `updatedAt:null`. An empty ready list is not the same as an unavailable list. No arbitrary age threshold is imposed.
- `updatedAt` is the **oldest** last successful commit collection across the scoped active watches, or the confirming attempt time for an explicit empty-repository outcome. A failed collection retains its prior success time. Any watch with unknown provenance yields `null`; no watches also yields `null`. Never use the newest displayed row, event occurrence time, unrelated activity/metric updates, or `generatedAt` for commit freshness.
- `coverage.complete` is always `false`, and its bounded label (max 700) describes retained default-branch commits, permissions, collection limits and gaps. A successful current collection is not complete all-branch/all-time history; historical backfill can still be incomplete. The notification Events API's 300-event/30-day limit does not describe this commit collection and is not used as its coverage label.

### Notifications and degradation

- `unreadCount` is the full **local Observatory inbox** count, not GitHub's native notification count. Only `status:'ready'` yields a count (including an actual zero). Missing, inaccessible or failed inbox state yields `null`, so the UI must show unknown/unavailable rather than a zero badge.
- Items are the latest **five read or unread** local notifications (fewer only when fewer are retained), ordered by occurrence time descending with the inbox's stable sequence tie-break. `readAt` is the retained read timestamp or `null`; `unread` explicitly marks unread rows. `unreadCount` remains the full scoped unread total, independent of this five-row preview. `hasMore` describes additional read or unread items, not collection completeness. Known retained items may remain visible with degraded status; they must not be presented as fresh. Reading this endpoint never marks notifications read.
- Coverage is always incomplete: provider event caps/delay, scope checks and collection gaps apply. Preserve the bounded coverage label in the UI. Fixed descriptive notification titles are reused; no comment bodies, raw provider messages, source code, credentials, avatars, repository IDs or mutation snapshots are exported.
- Item strings are bounded (ID 64, title 200, repository 150, type 40, URL 500, actor login 50 characters); the coverage label is capped at 700 characters. The existing inbox validates GitHub subject/comment URLs before storing them. Render all labels as text, not HTML.
- Summary, commits and inbox failures are isolated. A failed dashboard still permits the commits/inbox previews; an unavailable commit feed or inbox does not hide summary statistics or the other preview. Raw errors are never returned. Top-level `error` means any component errored; `partial` means incomplete summary coverage, partial commit collection or a non-ready inbox; `ready` means these local projections are available, **not** complete GitHub history or guaranteed current provider state.

## Verification

`test/home-preview-commits.test.mjs` covers SQL filtering before counts/pagination despite more than five newer noncommits; deterministic ties, own/private/archived/third-party watches, paused exclusion, date-only history, collection-specific freshness, known-empty versus partial/error states, bounded allowlisted safe text and exact URLs. Its real SQLite/HTTP integration verifies repeated reads make no provider calls, identity checks, refreshes or mutations; both databases' `data_version`, notification snapshot/read-state and dashboard remain unchanged. Existing exact-target token/auth and notification semantics tests remain in force.

`test/home-preview-daily-change.test.mjs` checks signed/zero changes, raw-balance unstars despite a rising reconstructed graph, exact UTC dates, missing/stale/future observations, invalid and overflowing counts, contributor consistency, partial cohorts, complete retained commit history, a single injected clock at midnight, and one read-only dashboard call. `test/home-preview.test.mjs` exercises the live HTTP server, exact method/target auth restrictions, Host/Origin checks, unchanged proxy/session/CSRF gates, bounded real inbox results, mixed read/unread rows, partial/unknown/error semantics, and a real SQLite-backed dashboard with pre-window retained history and no network or database writes on repeated GETs. `test/home-preview-graphs.test.mjs` checks equality with the app model, the 30-point bound, cumulative baselines, contributor alignment, null gaps, real zeros, unsafe totals and incomparable balances. `test/home-runtime.test.mjs` checks strong/distinct configuration, owner-only regular-file loading, invalid startup before runtime-state creation, and a real child-process startup using the file-backed token. All fixtures are synthetic and isolated; no production credentials or deployment changes are needed.
