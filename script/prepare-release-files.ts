#!/usr/bin/env bun

import { $ } from "bun"
import path from "node:path"

export const ReleasePackageManifests = [
  ["packages/app/package.json", "@deepagent-code/app"],
  ["packages/cli/package.json", "@deepagent-code/cli"],
  ["packages/core/package.json", "@deepagent-code/core"],
  ["packages/deepagent-code/package.json", "deepagent-code"],
  ["packages/desktop/package.json", "@deepagent-code/desktop"],
  ["packages/function/package.json", "@deepagent-code/function"],
  ["packages/plugin/package.json", "@deepagent-code/plugin"],
  ["packages/sdk/js/package.json", "@deepagent-code/sdk"],
  ["packages/server/package.json", "@deepagent-code/server"],
  ["packages/ui/package.json", "@deepagent-code/ui"],
  ["packages/web/package.json", "@deepagent-code/web"],
] as const

export async function preparePackageVersions(version: string, repository: string) {
  if (!version) throw new Error("release version is required")
  // Embedded upstream packages and private native helpers keep their own identities.
  // Validate the complete distribution set before modifying any manifest.
  const packages = await Promise.all(
    ReleasePackageManifests.map(async (entry) => {
      const file = Bun.file(path.join(repository, entry[0]))
      const before = await file.text()
      const metadata = JSON.parse(before) as Record<string, unknown>
      if (metadata.name !== entry[1] || typeof metadata.version !== "string")
        throw new Error(`Unexpected release package identity: ${entry[0]}`)
      return { file, before, after: JSON.stringify({ ...metadata, version }, null, 2) + "\n" }
    }),
  )
  await Promise.all(packages.map((entry) => entry.before === entry.after ? undefined : Bun.write(entry.file, entry.after)))
}

export async function prepareReleaseFiles(version: string, repository: string) {
  await preparePackageVersions(version, repository)
  await $`bun install`.cwd(repository)
  await $`./packages/sdk/js/script/build.ts`.cwd(repository)

  // Release package versions are manifest inputs, so pin the prepared tree before committing it.
  const { generateManifest } = await import("../packages/core/script/manifest-digest/manifest")
  const manifest = generateManifest({ repoRoot: repository })
  const pin = path.join(repository, "packages/core/script/manifest-digest/head-pin.ts")
  const before = await Bun.file(pin).text()
  if (
    !/commit: "[^"]+"/.test(before) ||
    !/setTreeDigest: "[0-9a-f]{64}"/.test(before) ||
    !/overallDigest: "[0-9a-f]{64}"/.test(before)
  )
    throw new Error("release manifest pin has an unexpected format")
  await Bun.write(
    pin,
    before
      .replace(/commit: "[^"]+"/, `commit: "${(await $`git rev-parse --short=8 HEAD`.cwd(repository).text()).trim()}"`)
      .replace(/setTreeDigest: "[0-9a-f]{64}"/, `setTreeDigest: "${manifest.setTreeDigest}"`)
      .replace(/overallDigest: "[0-9a-f]{64}"/, `overallDigest: "${manifest.overallDigest}"`),
  )
}

if (import.meta.main) {
  await prepareReleaseFiles(process.argv[2] ?? "", path.resolve(import.meta.dir, ".."))
}
