#!/usr/bin/env bash
set -euo pipefail

repo=$(git rev-parse --show-toplevel)
output=${1:-"$repo/dist/share-server-aly-$(git rev-parse --short HEAD).tar.gz"}
stage=$(mktemp -d "${TMPDIR:-/tmp}/deepagent-share.XXXXXX")
trap 'rm -rf "$stage"' EXIT

bun build --compile --target=bun-linux-x64 \
  "$repo/packages/deepagent-code/script/share-server.ts" \
  --outfile "$stage/share-server"
cp "$repo/packages/deepagent-code/script/share-server.deploy/share-server.service" "$stage/"
cp "$repo/packages/deepagent-code/script/share-server.deploy/env.example" "$stage/"
cp "$repo/packages/deepagent-code/script/share-server.README.md" "$stage/README.md"
git rev-parse HEAD > "$stage/BUILD_COMMIT"
(cd "$stage" && shasum -a 256 share-server share-server.service env.example README.md BUILD_COMMIT > SHA256SUMS)
mkdir -p "$(dirname "$output")"
tar -czf "$output" -C "$stage" share-server share-server.service env.example README.md BUILD_COMMIT SHA256SUMS
printf '%s\n' "$output"
