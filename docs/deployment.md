# Secured container deployment

Use an authenticated HTTPS reverse proxy in front of the container. This is a single-user app: the proxy's admission policy applies to all repository data and controls. Local mode remains loopback-only by default.

## Image and storage

Build from a reviewed, clean source revision:

```sh
docker build --build-arg VERSION=0.2.0 --build-arg REVISION="$(git rev-parse HEAD)" -t github-observatory:0.2.0 .
```

The image runs as **100:101**, contains no runtime dependencies beyond Node, and does not copy tests, screenshots, credentials, or databases. Create two external directories owned by that UID/GID: writable data and read-only secrets. Restrict both to mode 700 and secret files to mode 600 or 400. The data directory must be outside the checkout.

Generate a random proxy key into a private file, without printing it:

```sh
node --input-type=module -e "import {writeFileSync} from 'node:fs'; import {randomBytes} from 'node:crypto'; writeFileSync('/absolute/private/secrets/proxy-key',randomBytes(32).toString('base64url')+'\\n',{mode:0o600,flag:'wx'});"
```

Use a dedicated scoped GitHub token in `github-token` if needed. Do not substitute broader deployment/CLI credentials. This app does not change GitHub permissions.

## Runtime settings

- Mount private data at `/data` read/write.
- Mount private secrets at `/run/secrets/observatory` read-only.
- `OBSERVATORY_BIND_HOST=0.0.0.0`
- `OBSERVATORY_PUBLIC_ORIGIN=https://observatory.example.com` (your exact origin, no path/trailing slash)
- `OBSERVATORY_PROXY_KEY_FILE=/run/secrets/observatory/proxy-key`
- Optional `GITHUB_TOKEN_FILE=/run/secrets/observatory/github-token`
- Port `8080` to a private proxy-reachable address, not an unrestricted public port.
- Restart `unless-stopped`; drop all capabilities; enable `no-new-privileges`; bound Docker log size.

Non-loopback startup without the origin/key is rejected. Direct requests lacking the key fail closed, even with a session cookie or spoofed forwarding headers. Container health checks call loopback `/health`; that only reports process readiness, not collection success.

## Reverse proxy

Terminate HTTPS, enforce the existing login/access policy on **every route**, preserve the external Host, and overwrite the upstream `X-Observatory-Proxy-Key` header with the secret file's contents. Never forward a client-controlled value. Do not expose the header to browsers or write it into public templates.

For Nginx Proxy Manager, a custom `/` location can set this header in its Advanced field while NPM generates its normal access-list directives for the location. Confirm that the generated location retains `auth_basic`, access rules, TLS policy, and the intended upstream. A successful API update alone does not prove the rendered Nginx configuration is correct. Do not create a second unprotected location.

The proxy must authenticate before forwarding. Observatory does not parse usernames or proxy login passwords; possession of the server-to-server key is trusted only after your proxy policy has admitted the browser. The frontend obtains its short-lived HttpOnly, Secure, SameSite=Strict app session using a same-origin request; no second unlock is needed. CSRF remains mandatory for all mutations.

Acceptance checks:

1. Direct backend requests to `/`, `/api/dashboard`, and `/api/session` are denied without the key.
2. HTTPS unauthenticated requests are rejected by the proxy, with a valid certificate.
3. A permitted user can load actual data through HTTPS, open each drilldown type, and follow the right GitHub links.
4. Foreign origins/hosts and mutations without CSRF fail.
5. Restart the container; verify SQLite integrity, retained watch/history counts, and a new successful collection independently of `/health`.
6. Verify native container Edit/WebUI/icon metadata, autostart, and the actual installed image revision.

## Unraid integration

Create a native DockerMan template with the image's registry tag, meaningful settings for the mounts and variables above, WebUI, project/support URLs, and icon. Keep secrets out of environment/XML: only **file paths** belong there. Use a registry-resolvable tag for normal update checks; record immutable image identity separately for rollback. Do not enable unattended upgrades merely to install the app.

## Backup, migration, rollback

Do not copy a live SQLite main file by itself: committed data may still be in WAL. Use SQLite's online backup API, or stop the sole writer and take a verified quiescent copy. Check `PRAGMA integrity_check`, table counts, and the destination hash before migration. Keep secrets separate from data backups.

Migrate a complete Observatory database into an empty destination with the correct ownership. The separate `.writer.sqlite` sidecar is a kernel-held lifetime lock: never unlink or replace it while any instance may be running. Back up the application database, not a live lock file. Old pilot versions used `.writer.lock`; stop their original process cleanly before upgrading. If a legacy lock remains, verify the old writer is offline before manually removing that exact legacy file—new-version crash recovery needs no lock deletion.

Do not invent a merged history by renaming or combining another application's tables. Existing ghstats data should remain as an independent retained backup unless an explicit, tested importer is supplied.

Start the candidate on a separate private port. Verify auth, data, collection, restart persistence, and UI before switching the existing proxy target. Preserve the old proxy/template/image and data until acceptance. Retire only the explicitly approved old containers and operational entries; do not delete databases, credentials, backups, images, certificates, or DNS as incidental cleanup.

After the old container is removed, rollback requires **recreating it from the saved native template and retained image/data**, verifying its health, then restoring the saved proxy target. Merely pointing back to a removed container is not rollback.
