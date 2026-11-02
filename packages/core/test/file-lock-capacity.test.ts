import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FileLock } from "@deepagent-code/core/file-lock"
import path from "node:path"
import { tmpRoot } from "./fixture/tmpdir"

describe("FileLock production capacity", () => {
  test("fails closed at the ceiling and reuses released capacity", () => {
    const service = Effect.runSync(FileLock.Service.pipe(Effect.provide(FileLock.layer)))
    const root = path.join(tmpRoot(), "repo")
    const overflow = path.join(root, "overflow")
    const entries = Array.from({ length: FileLock.MAX_ACTIVE_LOCKS }, (_, index) =>
      service.acquire(path.join(root, String(index)), "agent"),
    )
    expect(entries.every(Boolean)).toBe(true)
    expect(service.acquire(overflow, "agent")).toBeNull()

    service.release(entries[0]!.lockId)
    const replacement = service.acquire(overflow, "agent")
    expect(replacement).not.toBeNull()
    for (const entry of entries) if (entry) service.release(entry.lockId)
    if (replacement) service.release(replacement.lockId)
  })
})
