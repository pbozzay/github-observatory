# Github Observatory

A local-first GitHub analytics dashboard: overall trends above elegant, horizontal repository rows, with a small history graph beneath each count. Public watches and explicitly selected private repositories share one view. SQLite retains observations beyond GitHub's short traffic window.

**Local pilot.** This is a working application under active review, not a hosted analytics service. It does not publish repository data or send telemetry. Public source code does not make your running dashboard or database public.

## Run locally

Requires Node.js 24 or later. Runtime uses Node's built-in HTTP and SQLite modules; there are no third-party runtime dependencies.

```sh
npm ci
npm start
```

In another terminal, open the project and run:

```sh
npm run open
```

The server listens only on `127.0.0.1:47831`. The opener reads an owner-only local unlock file, opens your browser, and the page immediately removes the temporary handoff fragment from the address bar. The resulting session uses an HttpOnly, SameSite=Strict cookie. The unlock key is never printed or stored in browser localStorage.

To use a GitHub fine-grained token, create a file **outside this source checkout**, readable only by your user. Do not paste credentials into the dashboard, README, shell command history or a GitHub issue. Configure its path:

```sh
export GITHUB_TOKEN_FILE=/absolute/path/to/owner-only-token-file
npm start
```

The existing token is optional for public watches. It stays server-side; the application does not read GitHub CLI credentials or request additional permissions. Connections lists owned repositories available to the configured token; private repositories are added only through explicit selection. A token-mode access failure never falls back to an anonymous private-repository request.

Configuration:

| Variable | Default | Purpose |
|---|---|---|
| `OBSERVATORY_PORT` | `47831` | Local listening port |
| `OBSERVATORY_DATA_DIR` | `~/.local/share/github-observatory` | Private SQLite, unlock file and runtime state; must be outside source |
| `GITHUB_TOKEN_FILE` | unset | Owner-only scoped token file |

Use the same `OBSERVATORY_DATA_DIR` when starting and opening the app. Do not expose this pilot with a tunnel, LAN bind or reverse proxy. Remote deployment and container packaging require their own authentication/routing acceptance checks.

## Data, not demo numbers

- The browser loads persisted observations from the local API. There is no demo-data fallback.
- Current stars/forks are observed balances. They are not reconstructed historical balances.
- GitHub-reported star activity, when available, is distinct from current stars; provider date semantics may differ from UTC.
- Commits, merged pull requests, releases and authorized traffic are collected within bounded provider windows.
- Older balance observations remain visible when selecting a shorter chart window; their collection time remains available in metric details.
- Missing series are omitted. Unknown days remain gaps; actual observed zero is retained. An initial balance observation is one point, not an invented flat history.
- Partial history does not support an unqualified growth comparison. Collection diagnostics retain access, pagination and rate-limit outcomes without replacing good data with zeros.
- Daily traffic totals can be summed; daily unique visitors are not summed and called unique people.
- Public and authenticated request budgets are separate and persisted. Deferred repositories and metric families rotate across cycles rather than starving later watches.
- The hourly scheduler lives inside the app process. Closing the app stops it; no operating-system job or cloud scheduler is installed.

## Security boundaries

All data-bearing APIs require the local session. Mutations require an exact same-origin request and CSRF token. Host validation protects against DNS rebinding; unrelated filesystem paths cannot be served. Responses are non-cacheable, assets are self-hosted, and no third-party analytics/scripts are loaded. Repository text must be treated as untrusted content.

This protects a local browser workflow, not against a malicious process already running as your operating-system user. That user can read the local unlock and token files. Keep the database and backups private: repository names and activity can be sensitive even without code or credentials.

Never commit runtime state, live screenshots, collection logs, backups or real-account fixtures. `.gitignore`, the source-only release process and `npm run check` help enforce this boundary. The preflight is a heuristic, not a guarantee; independently review the exact staged tree before publishing.

## Development

```sh
npm test
npm run check
```

Browser verification uses Playwright as a dev-only dependency. Install its Chromium browser, or configure `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an existing Chrome-compatible executable. Tests use synthetic repository data, never a production credential. See `docs/api-contract.md` for the module and HTTP contracts.

## Scope and next steps

The local pilot is deliberately isolated from any existing analytics installation. It does not migrate another database, alter a production hostname, create GitHub OAuth applications or broaden token permissions. Restore/cutover, Docker publishing, native server integration and externally authenticated hosting are separate release steps.
