import { describe, expect, test } from "bun:test"
import { createFollowupSubmissionRegistry, FOLLOWUP_SUBMISSION_LIMIT } from "./followup-submission"

const deferred = () => {
  let resolve!: (value: boolean) => void
  const promise = new Promise<boolean>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("follow-up submission registry", () => {
  test("cancel aborts and joins only the targeted session", async () => {
    const registry = createFollowupSubmissionRegistry()
    const first = deferred()
    const second = deferred()
    let firstAborted = false
    let secondAborted = false
    registry.run({ sessionID: "session-a", id: "a" }, (signal) => {
      signal.addEventListener("abort", () => (firstAborted = true))
      return first.promise
    })
    registry.run({ sessionID: "session-b", id: "b" }, (signal) => {
      signal.addEventListener("abort", () => (secondAborted = true))
      return second.promise
    })
    await Promise.resolve()

    let joined = false
    const cancel = registry.cancel("session-a").then(() => {
      joined = true
    })
    await Promise.resolve()
    expect(firstAborted).toBe(true)
    expect(secondAborted).toBe(false)
    expect(joined).toBe(false)
    first.resolve(false)
    await cancel
    expect(joined).toBe(true)
    second.resolve(true)
  })

  test("coalesces the same follow-up while it is active", async () => {
    const registry = createFollowupSubmissionRegistry()
    const current = deferred()
    let calls = 0
    const first = registry.run({ sessionID: "session-a", id: "same" }, () => {
      calls++
      return current.promise
    })
    const second = registry.run({ sessionID: "session-a", id: "same" }, () => {
      calls++
      return Promise.resolve(true)
    })

    const cancel = registry.cancel("session-a")
    current.resolve(false)
    await cancel
    expect(first).toBe(second)
    expect(calls).toBe(1)
    expect(registry.active()).toBe(0)
  })

  test("rejects new work at the global active limit", async () => {
    const registry = createFollowupSubmissionRegistry()
    const pending = deferred()
    for (let index = 0; index < FOLLOWUP_SUBMISSION_LIMIT; index++) {
      registry.run({ sessionID: `session-${index}`, id: "one" }, () => pending.promise)
    }
    await Promise.resolve()

    expect(registry.active()).toBe(FOLLOWUP_SUBMISSION_LIMIT)
    await expect(registry.run({ sessionID: "overflow", id: "one" }, () => Promise.resolve(true))).rejects.toThrow(
      "Too many active follow-up submissions",
    )

    pending.resolve(false)
  })
})
