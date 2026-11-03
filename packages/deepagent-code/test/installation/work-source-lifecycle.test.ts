import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

await import("@deepagent-code/core/session")

const fixture = path.join(import.meta.dir, "fixture/work-source-lifecycle.ts")
let cohort: Awaited<ReturnType<typeof import("../fixture/windows-native-node-cohort").build>> | undefined
beforeAll(async () => {
  if (process.platform !== "win32") return
  const runner = process.env.RUNNER_TEMP
  if (!runner || path.win32.parse(runner).root.toUpperCase() !== "D:\\")
    throw new Error("Native source lifecycle tests require D: scratch space")
  await fs.mkdir(runner, { recursive: true })
  const { build } = await import("../fixture/windows-native-node-cohort")
  cohort = await build({
    directory: await fs.mkdtemp(path.join(runner, "dac-work-source-lifecycle-")),
    nodeEntry: path.join(import.meta.dir, "fixture/work-source-lifecycle-entry.ts"),
  })
}, 240_000)
afterAll(async () => {
  await cohort?.dispose()
})

async function run(mode: string) {
  if (cohort) {
    const result = await cohort.run(mode)
    expect(result.code, result.stderr).toBe(0)
    return result.stdout
  }
  const child = Bun.spawn([process.execPath, fixture, mode], {
    cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), 40_000)
  try {
    const [status, stdout, stderr] = await Promise.all([child.exited,
      new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(status, stderr).toBe(0)
    return stdout
  } finally {
    clearTimeout(timer)
    child.kill()
  }
}

for (const mode of ["complete", "revoked", "retired"]) test(`original v2 runner/source/8 sealed tools/3 turns: ${mode}`, async () => {
  const stdout = await run(mode)
  const output = stdout.match(/WORK_SOURCE_LIFECYCLE_RESULT (.+)/)?.[1]
  expect(output).toBeDefined()
  const result = JSON.parse(output!)
  expect(result.ok).toBe(true)
  expect(result.inSQLPreparations).toBe(0)
  expect(result.durableEffects).toBe(8)
  console.info("WORK_SOURCE_LIFECYCLE_EVIDENCE", mode, result.fileDB)
}, process.platform === "win32" ? 60_000 : 45_000)
