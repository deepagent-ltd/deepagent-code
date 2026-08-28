import { describe, expect, test } from "bun:test"
import { isTransientServerAbort, withServerAbortRetry } from "./terminal-retry"

const abort503 = (body?: unknown) => new Error("deepagent-code server POST /pty → 503", { cause: { body, status: 503 } })

describe("isTransientServerAbort", () => {
  test("true for 503 with empty body (the desktop terminal case)", () => {
    expect(isTransientServerAbort(abort503(""))).toBe(true)
    expect(isTransientServerAbort(abort503(undefined))).toBe(true)
    expect(isTransientServerAbort(abort503(null))).toBe(true)
    expect(isTransientServerAbort(abort503({}))).toBe(true)
  })

  test("false for 503 that carries a real body", () => {
    expect(isTransientServerAbort(abort503("broken sync connection for workspace: ws_1"))).toBe(false)
    expect(isTransientServerAbort(abort503({ _tag: "ServiceUnavailableError", message: "no catalog" }))).toBe(false)
  })

  test("false for other statuses and non-cause errors", () => {
    expect(isTransientServerAbort(new Error("boom", { cause: { body: "", status: 500 } }))).toBe(false)
    expect(isTransientServerAbort(new Error("boom", { cause: { body: "", status: 404 } }))).toBe(false)
    expect(isTransientServerAbort(new Error("plain"))).toBe(false)
    expect(isTransientServerAbort("string error")).toBe(false)
    expect(isTransientServerAbort(undefined)).toBe(false)
  })
})

describe("withServerAbortRetry", () => {
  const noSleep = () => Promise.resolve()

  test("returns on first success without retrying", async () => {
    let calls = 0
    const result = await withServerAbortRetry(
      () => {
        calls += 1
        return Promise.resolve("ok")
      },
      { sleep: noSleep },
    )
    expect(result).toBe("ok")
    expect(calls).toBe(1)
  })

  test("retries transient 503 then succeeds", async () => {
    let calls = 0
    const result = await withServerAbortRetry(
      () => {
        calls += 1
        if (calls < 3) return Promise.reject(abort503(""))
        return Promise.resolve("recovered")
      },
      { sleep: noSleep },
    )
    expect(result).toBe("recovered")
    expect(calls).toBe(3)
  })

  test("gives up after the retry budget and rethrows the last 503", async () => {
    let calls = 0
    const attempt = withServerAbortRetry(
      () => {
        calls += 1
        return Promise.reject(abort503(""))
      },
      { retries: 2, sleep: noSleep },
    )
    await expect(attempt).rejects.toThrow("503")
    expect(calls).toBe(3) // initial + 2 retries
  })

  test("does not retry a non-transient error", async () => {
    let calls = 0
    const attempt = withServerAbortRetry(
      () => {
        calls += 1
        return Promise.reject(new Error("real failure", { cause: { body: "nope", status: 500 } }))
      },
      { sleep: noSleep },
    )
    await expect(attempt).rejects.toThrow("real failure")
    expect(calls).toBe(1)
  })

  test("backoff grows linearly with attempt count", async () => {
    const delays: number[] = []
    let calls = 0
    await withServerAbortRetry(
      () => {
        calls += 1
        if (calls < 3) return Promise.reject(abort503(undefined))
        return Promise.resolve("done")
      },
      { delayMs: 100, sleep: (ms) => (delays.push(ms), Promise.resolve()) },
    )
    expect(delays).toEqual([100, 200])
  })
})
