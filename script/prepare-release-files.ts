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
}

if (import.meta.main) {
  await prepareReleaseFiles(process.argv[2] ?? "", path.resolve(import.meta.dir, ".."))
}
