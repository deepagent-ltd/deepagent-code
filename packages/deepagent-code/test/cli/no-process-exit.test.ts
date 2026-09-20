import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

// RI-110: a direct `process.exit()` bypasses Scope finalizers, ProcessLifecycle
// disposal, and listener stops, so command handlers must set `process.exitCode`
// and let the runtime unwind. This gate keeps that discipline machine-enforced.
// Sanctioned terminal exits (everything else must use process.exitCode):
// - src/node.ts / src/index.ts snapshot backdoor: test-only env backdoor that
//   exits before any service, listener, or runtime is created.
// - src/index.ts main() finally: exits only AFTER AppRuntime.dispose() and
//   ProcessLifecycle.disposeAll() had a bounded 2s opportunity to finish;
//   required because some external subprocesses keep the event loop alive.
const SANCTIONED = new Set(["node.ts", "index.ts"])

describe("cli process exit discipline", () => {
  test("no source file calls process.exit() directly", async () => {
    const src = path.resolve(import.meta.dir, "../../src")
    const offenders: string[] = []
    for (const file of await tsFiles(src)) {
      const relative = path.relative(src, file)
      if (SANCTIONED.has(relative)) continue
      const content = await readFile(file, "utf8")
      if (/process\.exit\s*\(/.test(content)) offenders.push(relative)
    }
    expect(offenders).toEqual([])
  })
})

async function tsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return tsFiles(full)
      return Promise.resolve(entry.name.endsWith(".ts") ? [full] : [])
    }),
  )
  return nested.flat()
}
