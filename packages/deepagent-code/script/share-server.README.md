# Session bundle share host

Run `bun packages/deepagent-code/script/share-server.ts` behind the aly HTTPS reverse proxy. On a host without Bun, build a self-contained Linux binary from the repo root with `bun build --compile --target=bun-linux-x64 ./packages/deepagent-code/script/share-server.ts --outfile ./share-server` and install that binary as a service. Set:

- `DEEPAGENT_SHARE_PUBLIC_URL=https://<public-host>`: the public origin, with no path or query.
- `DEEPAGENT_SHARE_UPLOAD_TOKEN`: a random secret of at least 32 characters, shared with the DeepAgent Code server process that uploads bundles.
- `DEEPAGENT_SHARE_DATA_DIR`: persistent directory for ZIPs and metadata (defaults to `./share-data`).
- `PORT`: local listening port (defaults to `8789`).
- `DEEPAGENT_SHARE_BIND_HOST`: listening address (defaults to `127.0.0.1`; set an explicit private bridge address only when the reverse proxy runs in a separate container).

The app server needs the same `DEEPAGENT_SHARE_PUBLIC_URL` and `DEEPAGENT_SHARE_UPLOAD_TOKEN`. The public host accepts `POST /api/bundles` with upload bearer, checks the ZIP manifest and checksums, re-sanitizes every member, and returns a link whose download secret is in the URL fragment. `GET /api/bundles/:id` requires that secret as a bearer token. `DELETE /api/bundles/:id` requires the separate revocation token or the upload token. Shares expire after seven days; the host removes expired files at startup and hourly. Restrict the data directory to the service account and exclude it from public static serving and request logs. Set a reverse proxy request size cap at or below 64 MiB and HTTPS on the public origin.

The ZIP importer creates a read-only archive. V2 admission, events, and receipts inside a C-tier bundle are retained as audit data; the bundle does not transfer execution ownership or authorize provider replay.
