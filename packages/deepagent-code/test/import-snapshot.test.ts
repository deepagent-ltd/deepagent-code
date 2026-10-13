import { expect, test, spyOn } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { snapshot, DEFAULT_BUDGET } from "@/import/snapshot"
import { importSource } from "./fixture/import-job"

test("snapshot binds actual source bytes and Codex title index independently of later source edits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "import-source-"))
  try {
    const sourcePath = await importSource(root, "codex")
    await Bun.write(
      path.join(sourcePath, "session_index.jsonl"),
      JSON.stringify({ id: "durable-import-0", thread_name: "frozen title" }),
    )
    const result = await snapshot({
      source: "codex",
      sourcePath,
      destination: path.join(root, "job/snapshot/source"),
      budget: DEFAULT_BUDGET,
      checkpoint: async () => {},
    })
    expect(result.parsed.sessions[0]?.title).toBe("frozen title")
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/)
    const frozen = await Bun.file(result.path).text()
    await Bun.write(path.join(sourcePath, "sessions/rollout-00000.jsonl"), "changed after snapshot")
    expect(await Bun.file(result.path).text()).toBe(frozen)
    expect(frozen).toContain("question 0")
    expect(frozen).not.toContain("changed after snapshot")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test.each(["fileBytes", "totalBytes", "sessions", "turns", "entries", "depth"] as const)(
  "snapshot enforces %s budget before any target exists",
  async (limit) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "import-budget-"))
    try {
      const sourcePath = await importSource(root, "codex", 2)
      await expect(
        snapshot({
          source: "codex",
          sourcePath,
          destination: path.join(root, "job/snapshot/source"),
          budget: { ...DEFAULT_BUDGET, [limit]: limit === "depth" ? 0 : 1 },
          checkpoint: async () => {},
        }),
      ).rejects.toThrow(`IMPORT_BUDGET_EXCEEDED: ${limit} actual=`)
      expect(await Bun.file(path.join(root, "job/data/import.db")).exists()).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
)

test("snapshot refuses an actual symlink swap between lstat and open", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "import-source-race-"))
  const open = fs.open.bind(fs)
  const swap = { attempted: false }
  const sourcePath = await importSource(root, "codex")
  const victim = await fs.realpath(path.join(sourcePath, "sessions/rollout-00000.jsonl"))
  const outside = path.join(root, "outside.jsonl")
  await Bun.write(outside, "outside source authority")
  // The interception is only a deterministic race barrier. The OS performs the real
  // replacement and actual O_NOFOLLOW open; no file contents or errors are mocked.
  const intercepted = spyOn(fs, "open").mockImplementation(async (filename, flags, mode) => {
    if (filename === victim && !swap.attempted) {
      swap.attempted = true
      await fs.unlink(victim)
      await fs.symlink(outside, victim)
    }
    return open(filename, flags, mode)
  })
  try {
    await expect(
      snapshot({
        source: "codex",
        sourcePath,
        destination: path.join(root, "job/snapshot/source"),
        budget: DEFAULT_BUDGET,
        checkpoint: async () => {},
      }),
    ).rejects.toThrow()
    expect(swap.attempted).toBe(true)
    expect(await Bun.file(path.join(root, "job/snapshot/source/sessions/rollout-00000.jsonl")).exists()).toBe(false)
  } finally {
    intercepted.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  }
})
