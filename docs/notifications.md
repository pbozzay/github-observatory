# Local actionable notification inbox

This is an **Observatory inbox built from retained GitHub Events**, not a mirror of GitHub's notifications inbox. It never calls `/notifications`, expands token scopes, changes credentials, or writes GitHub read state. Existing authentication and authorization gates protect every endpoint.

## Scope and evidence

The background-only `service.notificationContext()` verifies the current token identity through the existing authenticated `GET /user` request/cache. Only active watched repositories owned by that verified login are eligible. Merely watching somebody else's repository does not make its activity eligible. Admin/maintainer privileges are not inferred. The notification layer independently checks ownership and requires a validated actor login different from the viewer (case-insensitive). Missing identity or actor is never treated as evidence of another user's action.

Eligible retained `source: 'github_events'` records:

| Activity type | Actions |
| --- | --- |
| `pull_requests` | `opened`, `reopened`, `review_requested` |
| `issues` | `opened`, `reopened`, `assigned` |
| `issue_comment` | `created` |
| `pull_request_review` | `submitted` |
| `pull_request_review_comment` | `created` |
| `discussion_comment` | `created` |

Stars, forks, pushes, releases, merges, metric commits, self-authored events, and events without a known actor are excluded. Review requests and assignments mean activity on the owned repository, **not proof that the viewer personally was requested or assigned**. Mention-specific categorization is deliberately not claimed. Coverage always has `complete: false`: GitHub Events retains at most 300 events / 30 days per repository, may be delayed, and collection/access/rate limits can leave gaps.

Titles are fixed action descriptions with an optional validated issue/PR number. Provider titles, comments, bodies, actor display names, code, emails, and avatars are not copied into the sidecar. Links must be HTTPS on exactly `github.com`, within the exact eligible repository, and target an issue, pull request or discussion number. Only recognized numeric comment/review anchors are allowed; arbitrary paths, queries, credentials and external links are rejected. Frontends must still render all strings as text, not HTML.

## Persistence and lifecycle

`src/notifications.mjs` exports `createNotifications({dbPath, service, now?, maxPages?, pageSize?})`, returning:

- `list({offset=0, limit=50, unread=true})` — synchronous cached SQLite read only.
- `markRead({id})` — reads one immutable local event.
- `markAllRead({through})` — reads currently visible events through a displayed ingestion snapshot.
- `refresh()` — background ingestion, singleflight.
- `close()` — idempotent asynchronous drain/close.
- Internal `hideRepository(id)` — immediately hides a paused watch without provider calls or deleting state.

The main process opens `notifications.sqlite` in the existing private data directory (normally `/data/notifications.sqlite` in the container), **after acquiring the primary Observatory writer**. The sidecar also owns a stable, never-unlinked `notifications.sqlite.writer.sqlite` connection holding `BEGIN EXCLUSIVE`. It is a kernel-released lock, not a PID file. Files are precreated with mode `0600`; symlinks/nonregular files are rejected, WAL/SHM files retain private permissions, and startup failures close both database connections. Schema version 1 is additive and restart-safe; a newer unknown version fails closed.

`withNotifications(service, notifications)` is the sole main-process facade for initial, existing hourly, and manual sync. It refreshes notifications after the underlying sync settles, including failed attempts, and coalesces overlapping sync calls. No timer, cron or extra collection frequency is introduced. Shutdown drains that work, closes the inbox, then closes the primary Observatory service and its writer lock. Startup errors close the inbox before the primary service. Successful watch pause hides the local scope immediately, and an epoch guard prevents an in-flight scan from undoing that pause.

Immutable IDs are SHA-256 hashes of the verified viewer and stable retained event ID. Recollection uses conflict-ignore inserts: it never rewrites a prior item or resets `readAt`. A new comment on a previously read PR is a different event and starts unread. Pausing or changing eligibility hides items from lists/counts but preserves rows/read state. Different verified viewers cannot see each other's items. No destructive notification-history pruning is performed.

## Bounded ingestion and honesty

Refresh scans the real persisted `service.activity({range:'all',limit:500,offset})` feed after collection settles. Defaults cap each refresh at ten pages of 500 rows, and only events within the preceding 30 days are inserted. Metric-derived rows are ignored before insertion, but still consume scan budget; backfills can therefore defer actionable records.

Every refresh checks page zero for new arrivals. The remaining page budget resumes a durable rolling offset. Reaching the end or the 30-day boundary resets that cursor for a subsequent cycle. A scope different from the last successful scan starts at zero too. Overlapping recollection is harmless. Offset movement can delay discoveries when backfill, arrivals or pauses change the feed; later rolling cycles revisit those positions. This is **not a transactional feed snapshot or a claim that every retained event has been exhausted**. The label distinguishes a capped/deferred scan from reaching the current window, and neither reports complete coverage. Failed ingestion rolls back new items, scan signature, cursor and success timestamp together; existing rows and read state are retained.

Verified identity and eligible repository scope are persisted **before** reading activity, separately from that ingestion transaction. They immediately govern lists, counts and both read mutations, even while activity is pending or after activity/ingestion fails, and remain authoritative across restart. An ingestion failure cannot restore the previous viewer or widen the visible scope. If a watch is paused while context verification is pending, only the intersection with the still-visible repository scope can be retained, the newly verified identity still applies, and ingestion is deferred. A pause during activity likewise cannot be undone by that scan.

GET never calls GitHub, `notificationContext`, `refresh`, or `activity`. On process startup, retained rows are explicitly stale until background identity/scope verification succeeds. Context failure without a newly verified identity/scope keeps only data within the last persisted scope with `error`/`no_access` and a stale warning; it does not turn unavailable coverage into a healthy empty inbox or revive an older scope. `not_configured` returns an explicit empty result. A verified identity with no eligible repositories can truthfully return `ready` with zero visible items. `updatedAt` is the last successful local ingestion, not proof of fresh or complete provider activity.

## HTTP contract

### `GET /api/notifications?offset=0&limit=50&unread=true`

`offset` is a canonical nonnegative safe integer. `limit` is 1–100. `unread` is exactly `true` or `false` and defaults to true. Duplicate/unknown query parameters fail with 400. Results are ordered by occurrence time descending, then local sequence descending.

```json
{
  "items": [{
    "id": "opaque immutable local event ID",
    "repositoryId": "101",
    "repository": "owner/project",
    "type": "issue_comment",
    "title": "New issue or pull request comment #7",
    "url": "https://github.com/owner/project/issues/7#issuecomment-90",
    "actor": {"login": "contributor"},
    "occurredAt": "2026-06-19T03:04:05.000Z",
    "readAt": null
  }],
  "total": 1,
  "unreadCount": 1,
  "offset": 0,
  "limit": 50,
  "hasMore": false,
  "snapshot": 1,
  "coverage": {"complete": false, "label": "Local Observatory inbox; retained activity only."},
  "status": "ready",
  "updatedAt": "2026-06-20T12:00:00.000Z"
}
```

`total` counts the selected unread/all filter; `unreadCount` counts unread visible items independent of pagination/filter. `snapshot` is the local ingestion high-water sequence, not a timestamp or GitHub cursor. Status is one of `ready`, `no_access`, `not_configured`, `error`. `updatedAt` is nullable. Old server callers that omit the optional `notifications` dependency receive this same envelope with `not_configured`, no items, snapshot zero and `updatedAt: null`, rather than a 404.

### `POST /api/notifications/read`

JSON body: `{"id":"<ID returned by GET>"}`. Marks exactly that visible event; repeated reads are idempotent. Malformed IDs return 400 and unknown/out-of-scope IDs return 404. SQL parameters are bound.

### `POST /api/notifications/read-all`

JSON body: `{"through":<snapshot returned by the displayed GET>}`. `through` must be a nonnegative safe **JSON integer**, no greater than the maximum known local sequence; zero is valid. Only currently eligible events with `seq <= through` are marked. Newly ingested items after that snapshot stay unread, even if they concern an already-read PR.

Both POSTs return `{"ok":true}` and retain the existing session/proxy-host, exact Origin, CSRF and JSON/body-size gates. Extra/missing body keys fail with 400. An unconfigured service returns 503 for mutations. All API responses are private/no-store; provider/storage details are not leaked in errors.

## Verification

Run `node --test test/notifications*.test.mjs` for real temporary SQLite, lifecycle, HTTP and collector integration coverage. Fixtures use `os.tmpdir()`, fake provider responses and no real credentials. Tests cover eligibility/action filtering, unknown/self actors, immutability, restart/read persistence, snapshot arrival races, paused scope/race guards, bounded scan/resume, failures vs healthy zero, private storage and startup cleanup, cached GETs, local/proxy gates, malformed input and injection resistance. The integration test exercises the actual retained feed and authenticated identity context, with a fake network boundary, then closes/reopens both databases and checks integrity.
