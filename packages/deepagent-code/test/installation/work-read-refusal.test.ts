import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import path from "node:path"

// Initialize the normal Session module before the package preload disposes AppRuntime.
await import("@deepagent-code/core/session")

for (const mode of ["known", "native_unknown", "permission_denied", "default", "zero_budget"]) test(`original read registry preserves bounded defaults and known refusal: ${mode}`, async () => {
  const child = spawn(process.execPath, [path.join(import.meta.dir, "fixture/work-read-refusal.ts"), mode], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] })
  const output = { stdout: "", stderr: "" }
  child.stdout.on("data", (chunk) => { output.stdout += chunk })
  child.stderr.on("data", (chunk) => { output.stderr += chunk })
  const result = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Owned refusal module exceeded 20s")) }, 20_000)
    child.once("error", (error) => { clearTimeout(timer); reject(error) })
    child.once("close", (code) => { clearTimeout(timer); resolve(code) })
  })
  expect(result, output.stderr).toBe(0)
  expect(output.stdout).toContain('"ok":true')
  expect(output.stdout).toContain(mode === "default" ? '"reads":1' : '"reads":0')
  expect(output.stdout).toContain('"provider":0')
}, 25_000)
