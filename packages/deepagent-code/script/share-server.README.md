# Session bundle share host (aly)

The share host is a separate Bun executable behind HTTPS. It accepts a ZIP from
the DeepAgent Code server, validates and re-sanitizes it, then issues a seven-day
link with a download secret in the URL fragment. The importer opens the ZIP as
a read-only archive; it never transfers V2 execution ownership or authorizes
provider replay.

## Verified aly topology (2026-09-24)

- Ubuntu x86_64, Docker and user systemd are available for `lxr`; user linger is
  enabled. SafeLine's tengine runs with host networking and owns public 80/443.
- Existing `modelsdev` binds `127.0.0.1:9100`. Port `127.0.0.1:8789` is free.
- `ai.deepagent.ltd` resolves to `39.106.112.23`; `share.deepagent.ltd` currently
  has no DNS answer and no SafeLine site. The generated SafeLine Nginx files are
  managed by SafeLine and should not be edited directly.
- SafeLine's global `client_max_body_size` is `0` (unlimited). Set a **64 MiB**
  limit on the new share site; the service independently rejects larger bodies.

## Build and stage

Run from a checked-out commit with installed workspace dependencies:

```sh
packages/deepagent-code/script/share-server.deploy/build-package.sh
```

The script creates `dist/share-server-aly-<commit>.tar.gz` containing a compiled
`bun-linux-x64` executable, its source commit, a checksum manifest, the user
systemd unit and an environment template. The archive contains no secrets. It
can be copied to aly and unpacked without Bun or a source checkout there.

The following commands describe the first installation. They are intentionally
separate from the build and have **not** been run on aly:

```sh
scp dist/share-server-aly-<commit>.tar.gz aly:/home/lxr/share-server-aly.tar.gz
ssh aly 'set -eu
  base="$HOME/.local/lib/deepagent-share"
  release=$(tar -xOzf "$HOME/share-server-aly.tar.gz" BUILD_COMMIT)
  install -d -m 700 "$base/releases/$release" "$HOME/.config/deepagent-share" "$HOME/.config/systemd/user" "$HOME/.local/share/deepagent-share"
  tar -xzf "$HOME/share-server-aly.tar.gz" -C "$base/releases/$release"
  (cd "$base/releases/$release" && sha256sum -c SHA256SUMS)
  install -m 644 "$base/releases/$release/share-server.service" "$HOME/.config/systemd/user/deepagent-share.service"
  if [ ! -e "$HOME/.config/deepagent-share/env" ]; then
    install -m 600 "$base/releases/$release/env.example" "$HOME/.config/deepagent-share/env"
  fi
  ln -sfn "releases/$release" "$base/current.next"
  mv -Tf "$base/current.next" "$base/current"
'
```

Before starting the service, replace `REPLACE_ME` in the mode-0600 environment
file with a cryptographically random token of at least 32 characters. For
example, generate one with `openssl rand -base64 48`. Supply the **same token**
to the DeepAgent Code server via `DEEPAGENT_SHARE_UPLOAD_TOKEN`; keep it out of
Git, shell history and logs. The file must also contain:

```ini
DEEPAGENT_SHARE_PUBLIC_URL=https://share.deepagent.ltd
DEEPAGENT_SHARE_BIND_HOST=127.0.0.1
PORT=8789
```

The `lxr` user's service stores bundles under
`~/.local/share/deepagent-share/share-data` by default. Keep the parent
directory mode 0700 and persist it across binary upgrades. Shares expire after
seven days; expired files are removed on startup and hourly. Monitor its disk
usage because the protocol has a 64 MiB per-share cap but no total-space quota.

```sh
ssh aly 'systemctl --user daemon-reload && systemctl --user enable --now deepagent-share.service'
ssh aly 'systemctl --user is-active deepagent-share.service && curl --fail --silent --show-error http://127.0.0.1:8789/healthz'
```

## Public route and acceptance

Create an `A` record for `share.deepagent.ltd` pointing to `39.106.112.23` in
the domain's AliDNS zone. In SafeLine, create an HTTPS site for that hostname
with a valid certificate and upstream `http://127.0.0.1:8789`. Set the site
request-body limit to 64 MiB, preserve the original path and `Authorization`
header, and leave `/api/bundles`, `/api/bundles/:id`, `/b/:id` and `/healthz`
available. Avoid caching these routes or logging authorization headers. URL
fragments do not reach the proxy.

Configure the DeepAgent Code server with
`DEEPAGENT_SHARE_PUBLIC_URL=https://share.deepagent.ltd` and the same upload
token. After DNS and SafeLine are live, verify:

```sh
curl --fail --silent --show-error https://share.deepagent.ltd/healthz
```

Then upload a disposable sanitized bundle through the application, download it
with its fragment token, import it as a read-only archive, revoke the link and
confirm a subsequent download is `404`. An unauthenticated download and an
upload with an invalid token must return `401`; a body over 64 MiB must return
`413`. Do not use a real private session for this acceptance check.

## Upgrade and rollback

Stage a new archive under its `BUILD_COMMIT` directory and verify `SHA256SUMS`
as above. Record the current target with
`ssh aly 'readlink ~/.local/lib/deepagent-share/current'`, atomically replace the
`current` symlink, and run
`ssh aly 'systemctl --user restart deepagent-share.service && curl --fail http://127.0.0.1:8789/healthz'`.
If health or the application round-trip fails, point `current` at the recorded
prior `releases/<commit>` directory using the same `current.next` + `mv -Tf`
sequence, restart the service and repeat the health and round-trip checks.
The data directory and upload token must not be replaced during rollback.
For first-install rollback, disable and stop the service, remove the SafeLine
site and DNS record, and retain the data directory until its retention policy
is decided.

The service exposes `POST /api/bundles` with the upload bearer token,
`GET /api/bundles/:id` with the link-fragment bearer token, and
`DELETE /api/bundles/:id` with the separate revocation token or upload token.
`GET /healthz` is a process-liveness check. Responses carry `Cache-Control:
no-store`; the download page has a restrictive content security policy.
