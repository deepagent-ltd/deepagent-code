import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { runWorkLeafProofDiagnostic } from "./fixture/work-leaf-proof-process"

const native: { cohort?: Awaited<ReturnType<typeof import("../fixture/windows-native-cli-cohort").WindowsNativeCliCohort.build>> } = {}
beforeAll(async () => {
  if (process.platform !== "win32") return
  const { WindowsNativeCliCohort } = await import("../fixture/windows-native-cli-cohort")
  const directory = path.join(process.env.RUNNER_TEMP ?? path.resolve(import.meta.dir, "../../.artifacts/unit"), "windows-work-leaf-proof")
  await fs.mkdir(directory, { recursive: true })
  native.cohort = await WindowsNativeCliCohort.build({
    directory: await fs.realpath(directory),
    businessEntry: path.join(import.meta.dir, "fixture/work-leaf-proof-process.ts"),
    extraSources: [import.meta.path],
  })
}, 240_000)
afterAll(async () => {
  await native.cohort?.dispose()
})

async function verify(mode: "file" | "scope" | "logger") {
  if (!native.cohort) return runWorkLeafProofDiagnostic(mode)
  const result = await native.cohort.run({ args: [mode], env: { DEEPAGENT_CODE_DB: ":memory:" }, milliseconds: 30_000 })
  expect(result).toMatchObject({ code: 0, timedOut: false })
}

test("original file database refusals report fixed stages without exposing the effect identifier", () => verify("file"))
test("closing the original Scope reports inactive lifetime and preserves both refusal methods", () => verify("scope"))
test("a failing diagnostic logger cannot replace or turn a cache refusal into success", () => verify("logger"))
