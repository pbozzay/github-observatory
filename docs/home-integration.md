# Homepage read-only integration

`GET /api/home-preview` is an optional, dedicated server-to-server projection for a compact Homepage summary and local unread badge. It reads `service.dashboard('30')` and `notifications.list({offset:0,limit:8,unread:true})`; it never collects, discovers repositories, refreshes identity/inbox scope, marks items read, or contacts GitHub. No database schema or collection schedule changes are required.

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
      {key: 'stars', label: 'Stars', value: number | null, detail: string},
      {key: 'openIssues', label: 'Open issues', value: number | null, detail: string},
      {key: 'commits30d', label: 'Commits (30d)', value: number | null, detail: string}
    ]
  },
  freshness: {updatedAt: ISO | null, collecting: boolean | null},
  coverage: {
    stars: MetricCoverage,
    openIssues: MetricCoverage,
    commits30d: MetricCoverage
  },
  notifications: {
    status: 'ready' | 'not_configured' | 'no_access' | 'error',
    unreadCount: number | null,
    items: [{
      id: string, title: string, repository: string, type: string,
      url: string, actor: {login: string} | null, occurredAt: ISO | null
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
```

### Summary semantics

- `repositories` counts active watched repositories in the existing dashboard, including archived repositories that remain watched. A successful empty dashboard returns `0`; a failed summary read returns `null`, not a fabricated zero.
- `stars` and `openIssues` sum latest retained balances across active watches. Open issues exclude pull requests. These are not sums of daily balances and not reconstructed historical totals.
- `commits30d` sums retained default-branch daily commit counts across the dashboard's inclusive last 30 UTC days, including today. It is **not** an all-time commit total and does not count push notifications.
- All three metric values are `null` when there are no observations, including an empty watch list. Real observed zeros remain `0`. Partial coverage sums only known observations, exposes the observed/total repository counts and labels the result partial; retained values are not erased when the latest collection failed. Unsafe integer sums are `null`.
- Metric `complete` requires a retained value with a valid observation timestamp from every active watch, successful current metric status/availability, and (for commits) complete daily coverage. Balance completeness means a retained snapshot for every watch, **not** a fully observed 30-day time series or proof of present-day freshness.
- `oldestObservedAt` is the oldest contributing observation, or `null` if any contributing observation has an unknown timestamp. `freshness.updatedAt` is the existing dashboard's latest update, which may concern another metric. `generatedAt` is response creation time, **never** a successful collection timestamp. Consumers must display the observation times/coverage and not treat a recent response as fresh provider data. No arbitrary freshness threshold is imposed.

### Notifications and degradation

- `unreadCount` is the full **local Observatory inbox** count, not GitHub's native notification count. Only `status:'ready'` yields a count (including an actual zero). Missing, inaccessible or failed inbox state yields `null`, so the UI must show unknown/unavailable rather than a zero badge.
- Items are the latest **eight unread** local notifications, ordered by occurrence time descending with the inbox's stable sequence tie-break. `hasMore` describes additional unread items, not collection completeness. Known retained items may remain visible with degraded status; they must not be presented as fresh.
- Coverage is always incomplete: provider event caps/delay, scope checks and collection gaps apply. Preserve the bounded coverage label in the UI. Fixed descriptive notification titles are reused; no comment bodies, raw provider messages, source code, credentials, avatars, repository IDs or mutation snapshots are exported.
- Item strings are bounded (ID 64, title 200, repository 150, type 40, URL 500, actor login 50 characters); the coverage label is capped at 700 characters. The existing inbox validates GitHub subject/comment URLs before storing them. Render all labels as text, not HTML.
- Summary and inbox failures are isolated. A failed dashboard still permits the unread preview; an unavailable inbox does not hide summary statistics. Raw errors are never returned. Top-level `error` means either component errored; `partial` means incomplete summary coverage or a non-ready inbox; `ready` means these local projections are available, **not** complete GitHub event coverage or guaranteed current provider state.

## Verification

`test/home-preview.test.mjs` exercises the live HTTP server, exact method/target auth restrictions, Host/Origin checks, unchanged proxy/session/CSRF gates, bounded real inbox results, partial/unknown/error semantics, and a real SQLite-backed dashboard with no network or database writes on repeated GETs. `test/home-runtime.test.mjs` checks strong/distinct configuration, owner-only regular-file loading, invalid startup before runtime-state creation, and a real child-process startup using the file-backed token. All fixtures are synthetic and isolated; no production credentials or deployment changes are needed.
