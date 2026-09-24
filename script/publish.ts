#!/usr/bin/env bun

import { Script } from "@deepagent-code/script"
import { $ } from "bun"
import { fileURLToPath } from "url"
import { assertReleaseCandidate } from "./assert-release-candidate"
import { prepareReleaseFiles } from "./prepare-release-files"
import { verifySdkBuild } from "../packages/sdk/js/script/verify-build"

console.log("=== publishing ===\n")

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)
const tag = `v${Script.version}`

if (Script.release && Script.preview)
  throw new Error("preview release candidate freezing requires a separate repository routing design")
if (!Script.release) await prepareReleaseFiles(Script.version, dir)
if (Script.release) {
  const commit = process.env.DEEPAGENT_CODE_CANDIDATE_COMMIT
  const tree = process.env.DEEPAGENT_CODE_CANDIDATE_TREE
  if (!commit || !tree) throw new Error("release candidate identity is required before publishing")
  await assertReleaseCandidate({
    repository: dir,
    commit,
    tree,
    tag,
    packageDir: "packages/deepagent-code/dist/deepagent-code-linux-x64",
  })
}
await verifySdkBuild(`${dir}/packages/sdk/js`)
if (Script.release) {
  await assertReleaseCandidate({
    repository: dir,
    commit: process.env.DEEPAGENT_CODE_CANDIDATE_COMMIT!,
    tree: process.env.DEEPAGENT_CODE_CANDIDATE_TREE!,
    tag,
    packageDir: "packages/deepagent-code/dist/deepagent-code-linux-x64",
  })
}

console.log("\n=== cli ===\n")
await $`bun ./packages/deepagent-code/script/publish.ts`

console.log("\n=== preview cli ===\n")
await $`bun ./packages/cli/script/publish.ts`

console.log("\n=== sdk ===\n")
await $`bun ./packages/sdk/js/script/publish.ts`

console.log("\n=== plugin ===\n")
await $`bun ./packages/plugin/script/publish.ts`

if (Script.release) {
  await $`bun ./packages/desktop/scripts/finalize-latest-json.ts`
  await $`bun ./packages/desktop/scripts/finalize-latest-yml.ts`
}

if (Script.release) {
  await assertReleaseCandidate({
    repository: dir,
    commit: process.env.DEEPAGENT_CODE_CANDIDATE_COMMIT!,
    tree: process.env.DEEPAGENT_CODE_CANDIDATE_TREE!,
    tag,
    packageDir: "packages/deepagent-code/dist/deepagent-code-linux-x64",
  })
  await $`gh release edit ${tag} --draft=false --repo ${process.env.GH_REPO}`
}
