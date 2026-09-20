import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FileLock } from "@deepagent-code/core/file-lock"

describe("FileLock production capacity", () => {
  test("fails closed at the ceiling and reuses released capacity", () => {
    const service = Effect.runSync(FileLock.Service.pipe(Effect.provide(FileLock.layer)))
    const entries = Array.from({ length: FileLock.MAX_ACTIVE_LOCKS }, (_, index) =>
      service.acquire(`/repo/${index}`, "agent"),
    )
    expect(entries.every(Boolean)).toBe(true)
    expect(service.acquire("/repo/overflow", "agent")).toBeNull()

    service.release(entries[0]!.lockId)
    expect(service.acquire("/repo/overflow", "agent")).not.toBeNull()
  })
})
