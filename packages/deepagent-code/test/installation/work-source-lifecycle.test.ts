import { expect, test } from "bun:test"
import path from "node:path"

await import("@deepagent-code/core/session")

for (const mode of ["complete", "revoked", "retired"]) test(`original v2 runner/source/8 sealed tools/3 turns: ${mode}`, async () => {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/work-source-lifecycle.ts"), mode], {
    cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), 40_000)
  try {
    const [status, stdout, stderr] = await Promise.all([child.exited,
      new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(status, stderr).toBe(0)
    const output = stdout.match(/WORK_SOURCE_LIFECYCLE_RESULT (.+)/)?.[1]
    expect(output).toBeDefined()
    const result = JSON.parse(output!)
    expect(result.ok).toBe(true)
    expect(result.inSQLPreparations).toBe(0)
    expect(result.durableEffects).toBe(8)
    console.info("WORK_SOURCE_LIFECYCLE_EVIDENCE", mode, result.fileDB)
  } finally {
    clearTimeout(timer)
    child.kill()
  }
}, 45_000)
