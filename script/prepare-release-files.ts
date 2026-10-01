#!/usr/bin/env bun

import { $ } from "bun"
import path from "node:path"

export async function prepareReleaseFiles(version: string, repository: string) {
  if (!version) throw new Error("release version is required")
  const files = await Array.fromAsync(new Bun.Glob("**/package.json").scan({ cwd: repository, absolute: true }))
  for (const file of files.filter((file) => !file.includes("node_modules") && !file.includes("dist"))) {
    const before = await Bun.file(file).text()
    const after = before.replaceAll(/"version": "[^"]+"/g, `"version": "${version}"`)
    if (after !== before) await Bun.write(file, after)
  }
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
