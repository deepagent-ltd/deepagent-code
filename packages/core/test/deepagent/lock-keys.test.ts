import { describe, expect, test } from "bun:test"
import path from "node:path"
import { LockKeys } from "@deepagent-code/core/deepagent/lock-keys"

describe("event execution lock keys", () => {
  test("normalizes relative, absolute, and dotted paths to one file identity", () => {
    const directory = path.resolve("workspace")
    const key = path.join(directory, "src", "agent.ts")
    expect(LockKeys.fileLockKey(directory, "src/agent.ts")).toBe(key)
    expect(LockKeys.fileLockKey(directory, "./src/../src/agent.ts")).toBe(key)
    expect(LockKeys.fileLockKey(directory, key)).toBe(key)
    expect(LockKeys.claimFileResource(LockKeys.fileLockKey(directory, "src/agent.ts"))).toBe(`file:${key}`)
  })

  test("scopes qualified code-graph symbols to their workspace", () => {
    expect(LockKeys.claimSymbolResource("wrk_a", "src/agent.ts#Agent.run")).toBe("symbol:wrk_a#src/agent.ts#Agent.run")
    expect(LockKeys.claimSymbolResource("wrk_a", "src/agent.ts#Agent.run")).not.toBe(
      LockKeys.claimSymbolResource("wrk_b", "src/agent.ts#Agent.run"),
    )
  })
})
