import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"

await import("@deepagent-code/core/session")

const fixture = path.join(import.meta.dir, "fixture/work-read-refusal.ts")
let cohort: Awaited<ReturnType<typeof import("../fixture/windows-native-node-cohort").build>> | undefined
let preserve = false
beforeAll(async () => {
  if (process.platform !== "win32") return
  const runner = process.env.RUNNER_TEMP
  if (!runner || path.win32.parse(runner).root.toUpperCase() !== "D:\\")
    throw new Error("Native read tests require D: scratch space")
  await fs.mkdir(runner, { recursive: true })
  const { build } = await import("../fixture/windows-native-node-cohort")
  cohort = await build({ directory: await fs.mkdtemp(path.join(runner, "dac-work-read-")), nodeEntry: fixture })
}, 240_000)
afterAll(async () => {
  if (!preserve) await cohort?.dispose()
})

for (const mode of ["known", "native_unknown", "permission_denied", "default", "zero_budget"])
  test(
    `original read registry preserves bounded defaults and known refusal: ${mode}`,
    async () => {
      if (cohort) {
        const result = await cohort.run(mode)
        if (result.code !== 0) {
          preserve = true
          console.error(
            "WINDOWS_NATIVE_READ_LAUNCHER",
            result.root,
            await fs.readFile(path.join(result.root, "runtime-stderr.log"), "utf8"),
          )
        }
        expect(result, JSON.stringify(result)).toMatchObject({ code: 0 })
        expect(result.stdout).toContain('"ok":true')
        expect(result.stdout).toContain(mode === "default" ? '"reads":1' : '"reads":0')
        expect(result.stdout).toContain('"provider":0')
        return
      }
      const child = spawn(process.execPath, [fixture, mode], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] })
      const output = { stdout: "", stderr: "" }
      child.stdout.on("data", (chunk) => {
        output.stdout += chunk
      })
      child.stderr.on("data", (chunk) => {
        output.stderr += chunk
      })
      const result = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL")
          reject(new Error("Owned refusal module exceeded 20s"))
        }, 20_000)
        child.once("error", (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.once("close", (code) => {
          clearTimeout(timer)
          resolve(code)
        })
      })
      expect(result, output.stderr).toBe(0)
      expect(output.stdout).toContain('"ok":true')
      expect(output.stdout).toContain(mode === "default" ? '"reads":1' : '"reads":0')
      expect(output.stdout).toContain('"provider":0')
    },
    process.platform === "win32" ? 60_000 : 25_000,
  )
