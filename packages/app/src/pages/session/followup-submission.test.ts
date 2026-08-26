import { describe, expect, test } from "bun:test"
import { createFollowupSubmissionRegistry } from "./followup-submission"

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
    const firstController = new AbortController()
    const secondController = new AbortController()
    registry.register({ sessionID: "session-a", id: "a", controller: firstController, promise: first.promise })
    registry.register({ sessionID: "session-b", id: "b", controller: secondController, promise: second.promise })

    let joined = false
    const cancel = registry.cancel("session-a").then(() => {
      joined = true
    })
    await Promise.resolve()
    expect(firstController.signal.aborted).toBe(true)
    expect(secondController.signal.aborted).toBe(false)
    expect(joined).toBe(false)
    first.resolve(false)
    await cancel
    expect(joined).toBe(true)
    second.resolve(true)
  })

  test("an old completion cannot clear a replacement submission", async () => {
    const registry = createFollowupSubmissionRegistry()
    const current = deferred()
    const controller = new AbortController()
    registry.register({
      sessionID: "session-a",
      id: "replacement",
      controller,
      promise: current.promise,
    })
    registry.clear("session-a", "old")

    const cancel = registry.cancel("session-a")
    expect(controller.signal.aborted).toBe(true)
    current.resolve(false)
    await cancel
  })
})
