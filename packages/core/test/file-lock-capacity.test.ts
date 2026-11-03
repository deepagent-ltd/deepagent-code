import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test"
import { Effect } from "effect"
import { FileLock } from "@deepagent-code/core/file-lock"
import path from "node:path"
import { tmpRoot } from "./fixture/tmpdir"

describe("FileLock production capacity", () => {
  const service = Effect.runSync(FileLock.Service.pipe(Effect.provide(FileLock.layer)))
  const entries: Array<FileLock.FileLockEntry | null> = []
  const root = path.join(tmpRoot(), "repo")

  beforeAll(() => {
    // Capacity is independent of lease expiry and the time to populate all real path locks.
    setSystemTime(new Date())
    for (let index = 0; index < FileLock.MAX_ACTIVE_LOCKS; index++) {
      entries.push(service.acquire(path.join(root, String(index)), "agent"))
    }
  }, 120_000)

  afterAll(() => {
    for (const entry of entries) if (entry) service.release(entry.lockId)
    setSystemTime()
  })

  test("fails closed at the ceiling and reuses released capacity", () => {
    const overflow = path.join(root, "overflow")
    expect(entries.every(Boolean)).toBe(true)
    expect(service.acquire(overflow, "agent")).toBeNull()

    service.release(entries[0]!.lockId)
    const replacement = service.acquire(overflow, "agent")
    expect(replacement).not.toBeNull()
    if (replacement) service.release(replacement.lockId)
  })
})
