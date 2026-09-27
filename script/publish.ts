#!/usr/bin/env bun

import { Script } from "@deepagent-code/script"
import { $ } from "bun"
import { fileURLToPath } from "url"
import { assertReleaseDraftFromEnv } from "./assert-release-candidate"
import { prepareReleaseFiles } from "./prepare-release-files"
import { verifySdkBuild } from "../packages/sdk/js/script/verify-build"
import { publishUpdaterEvidence, verifyUpdaterInputs } from "../packages/desktop/scripts/verify-updater-assets"

console.log("=== publishing ===\n")

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)
const tag = `v${Script.version}`

if (Script.release && Script.preview)
  throw new Error("preview release candidate freezing requires a separate repository routing design")
if (!Script.release) await prepareReleaseFiles(Script.version, dir)
const assertCandidate = async (expectedDraft = true) => {
  if (!Script.release) return
  await assertReleaseDraftFromEnv("packages/deepagent-code/dist/deepagent-code-linux-x64", expectedDraft)
}
await assertCandidate()
await verifySdkBuild(`${dir}/packages/sdk/js`)
await assertCandidate()

if (Script.release) {
  const latestDir = process.env.LATEST_YML_DIR
  const assetsDir = process.env.RELEASE_ASSETS_DIR
  const ledgerPath = process.env.RELEASE_LEDGER_PATH
  const repo = process.env.GH_REPO
  if (!latestDir || !assetsDir || !ledgerPath || !repo || !process.env.RUNNER_TEMP)
    throw new Error(
      "release updater verification requires latest YAML, staged assets, RI-51 ledger, repository and runner temp",
    )
  await verifyUpdaterInputs(latestDir, assetsDir, Script.version)
  await $`bun ./packages/desktop/scripts/finalize-latest-json.ts`
  await $`bun ./packages/desktop/scripts/finalize-latest-yml.ts`
  await publishUpdaterEvidence({
    directory: process.env.RUNNER_TEMP,
    repository: repo,
    tag,
    commit: process.env.DEEPAGENT_CODE_CANDIDATE_COMMIT!,
    tree: process.env.DEEPAGENT_CODE_CANDIDATE_TREE!,
    ledgerPath,
    assertCandidate,
  })
}

console.log("\n=== cli ===\n")
await assertCandidate()
await $`bun ./packages/deepagent-code/script/publish.ts`

console.log("\n=== preview cli ===\n")
await assertCandidate()
await $`bun ./packages/cli/script/publish.ts`

console.log("\n=== sdk ===\n")
await assertCandidate()
await $`bun ./packages/sdk/js/script/publish.ts`

console.log("\n=== plugin ===\n")
await assertCandidate()
await $`bun ./packages/plugin/script/publish.ts`

if (Script.release) {
  await assertCandidate()
  await $`gh api --method PATCH ${`repos/${process.env.GH_REPO}/releases/${process.env.DEEPAGENT_CODE_RELEASE}`} -F draft=false`
  await assertCandidate(false)
}
