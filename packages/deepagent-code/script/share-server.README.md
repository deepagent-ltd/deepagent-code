# Session bundle share host

**2.0.2 release status:** public share creation, uploads, downloads and link
imports are deferred to 2.0.3. The server and standalone host are closed by
default even when a share URL and upload token are configured. Local ZIP export
and read-only import remain available. Existing links may still be revoked.
`DEEPAGENT_CODE_ENABLE_PUBLIC_SHARING=1` is an explicit test/future-release
opt-in and must not be set in a 2.0.2 deployment. The installation and public
route instructions below are staging notes for a later release; do not execute
them as part of 2.0.2 publication.

The share host is a separate Bun executable deployed behind HTTPS. It accepts
a session ZIP from the DeepAgent Code server, validates and re-sanitizes it,
and issues a seven-day download link. The download secret is held in the URL
fragment. Import opens the bundle as a read-only archive and does not transfer
session execution ownership or authorize model execution.

Public sharing is disabled by default. Configuring a public URL and upload
token alone does not enable it. Explicitly set
`DEEPAGENT_CODE_ENABLE_PUBLIC_SHARING=1` on both the share host and the DAC
server when enabling this capability. `DEEPAGENT_CODE_DISABLE_SHARE=1` or
`true` takes precedence. Local export and read-only import do not require a
public host.

## Build

From a source checkout with the workspace dependencies installed, choose an
output path and run:

```sh
packages/deepagent-code/script/share-server.deploy/build-package.sh \
  /tmp/deepagent-share-linux-x64.tar.gz
```

The package contains a compiled `bun-linux-x64` executable, its `BUILD_COMMIT`,
`SHA256SUMS`, this guide, a user systemd unit, and `env.example`. It contains no
credentials. The deployment host needs Linux x86_64 and user systemd; it does
not need Bun or a source checkout. Transfer the archive using your usual
authenticated channel.

## Install and configure

Run the following on the Linux deployment host as the dedicated service user.
Set `archive` to the transferred package's absolute path:

```sh
set -eu
archive=/tmp/deepagent-share-linux-x64.tar.gz
base="$HOME/.local/lib/deepagent-share"
release=$(tar -xOzf "$archive" BUILD_COMMIT)
case "$release" in
  ''|*[!0-9a-f]*) echo 'Invalid BUILD_COMMIT' >&2; exit 1 ;;
esac
install -d -m 700 "$base/releases/$release" \
  "$HOME/.config/deepagent-share" "$HOME/.config/systemd/user" \
  "$HOME/.local/share/deepagent-share"
tar -xzf "$archive" -C "$base/releases/$release"
(cd "$base/releases/$release" && sha256sum -c SHA256SUMS)
install -m 644 "$base/releases/$release/share-server.service" \
  "$HOME/.config/systemd/user/deepagent-share.service"
if [ ! -e "$HOME/.config/deepagent-share/env" ]; then
  install -m 600 "$base/releases/$release/env.example" \
    "$HOME/.config/deepagent-share/env"
fi
ln -sfn "releases/$release" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
```

Edit the mode-0600 environment file before starting the service. Replace
`REPLACE_ME` with a random upload token of at least 32 characters; for example,
generate it with `openssl rand -base64 48`. Keep the token out of Git, shell
history, and logs. Configure your own HTTPS hostname, as in this example:

```ini
DEEPAGENT_SHARE_PUBLIC_URL=https://share.example.com
DEEPAGENT_SHARE_UPLOAD_TOKEN=REPLACE_ME
DEEPAGENT_SHARE_BIND_HOST=127.0.0.1
DEEPAGENT_CODE_ENABLE_PUBLIC_SHARING=1
PORT=8789
```

Use the same public URL and upload token in the DAC server configuration.
The service's default bundle directory is
`~/.local/share/deepagent-share/share-data`, relative to the systemd unit's
working directory. `DEEPAGENT_SHARE_DATA_DIR` can specify another persistent
directory. Preserve this directory and the token across upgrades and
rollbacks. Expired shares are removed on startup and hourly. The per-bundle
limit is 64 MiB; there is no total disk-space quota, so monitor disk usage.

```sh
systemctl --user daemon-reload
systemctl --user enable --now deepagent-share.service
systemctl --user is-active deepagent-share.service
curl --fail --silent --show-error http://127.0.0.1:8789/healthz
```

If the service must run while the account is logged out, the administrator
must configure user-service persistence for that service account.

## HTTPS route and health checks

Configure DNS and an HTTPS reverse proxy for the hostname you selected. The
upstream is `http://127.0.0.1:8789`. Set a 64 MiB request-body limit, preserve
paths and the `Authorization` header, and do not cache responses or log
credentials. Expose `/api/bundles`, `/api/bundles/:id`, `/b/:id`, and
`/healthz`. URL fragments are not sent to the proxy.

```sh
curl --fail --silent --show-error https://share.example.com/healthz
```

`GET /healthz` checks process liveness only; it does not prove sharing is
enabled or storage is writable. Verify an application round trip with a
disposable sanitized bundle: upload, download using its fragment secret,
read-only import, revoke, and confirm a later download returns `404`. An
unauthenticated download or invalid upload token returns `401`; an oversized
body returns `413`. Disabled public sharing returns `503` for public read and
upload requests. Do not use private production sessions for this check.

## Upgrade and rollback

Stage and checksum-verify the new archive under its `BUILD_COMMIT` release
directory. Record the current release with:

```sh
readlink "$HOME/.local/lib/deepagent-share/current"
```

Switch `current` with the `current.next` and `mv -Tf` sequence above, then run:

```sh
systemctl --user restart deepagent-share.service
systemctl --user is-active deepagent-share.service
curl --fail --silent --show-error http://127.0.0.1:8789/healthz
```

Verify the application round trip as well. If it fails, set `current.next`
to the recorded prior `releases/<commit>` target, replace `current`
atomically, restart, and repeat the checks. Do not replace bundle data or
credentials during rollback. To undo a first installation, stop and disable
the user service, remove the proxy route and DNS entry you created, and retain
the data directory until its retention policy permits deletion.

## API

- `POST /api/bundles`: upload bearer token.
- `GET /api/bundles/:id`: download bearer token taken from the link fragment.
- `DELETE /api/bundles/:id`: separate revocation token or upload token.
- `GET /healthz`: process-liveness check.

The service returns `Cache-Control: no-store` for normal authenticated routes,
and its download page has a restrictive content security policy.
