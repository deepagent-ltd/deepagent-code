import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const runWorker = async (home: string, input: { readonly action: "create"; readonly id: string } | { readonly action: "list" }) => {
  const child = Bun.spawn([process.execPath, "test/fixture/pr-queue-worker.ts", JSON.stringify(input)], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: { ...process.env, DEEPAGENT_CODE_TEST_HOME: home, DEEPAGENT_CODE_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exitCode, stderr).toBe(0)
  return JSON.parse(stdout.trim()) as ReadonlyArray<{ readonly id: string }> | { readonly id: string }
}

describe("PRQueue cross-process durability", () => {
  test("serializes concurrent writers without losing either entry", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "deepagent-pr-queue-process-"))
    try {
      await Promise.all([
        runWorker(home, { action: "create", id: "process-a" }),
        runWorker(home, { action: "create", id: "process-b" }),
      ])
      const entries = await runWorker(home, { action: "list" })
      expect(Array.isArray(entries) ? entries.map((entry) => entry.id).sort() : []).toEqual(["process-a", "process-b"])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)
})
