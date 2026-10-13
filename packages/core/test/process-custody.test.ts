import { expect, test } from "bun:test"
import path from "node:path"

for (const scenario of ["capacity", "unknown"]) {
  test(`ordinary process custody ${scenario} uses an isolated actual-process owner`, async () => {
    if (process.platform === "win32") return
    const proc = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "fixture/process-custody-case.ts"), scenario], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect({ code, err }).toEqual({ code: 0, err: "" })
    expect(JSON.parse(out).case).toBe(scenario)
  }, 20_000)
}
