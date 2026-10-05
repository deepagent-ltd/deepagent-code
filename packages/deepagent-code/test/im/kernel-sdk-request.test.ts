import { describe, expect, test } from "bun:test"
import { Effect, Result, Schedule } from "effect"
import { KernelSdk } from "@/im/kernel/sdk"

describe("SDK promise failure boundary", () => {
  test("a rejected SDK promise enters the typed retry path and is invoked again", async () => {
    const attempts: string[] = []
    const result = await Effect.runPromise(
      KernelSdk.request("connect", () => {
        attempts.push("connect")
        return attempts.length === 1 ? Promise.reject({ code: 503, msg: "offline" }) : Promise.resolve("online")
      }).pipe(Effect.retry(Schedule.recurs(1))),
    )
    expect(result).toBe("online")
    expect(attempts).toEqual(["connect", "connect"])
  })

  test("history rejection retains its operation and disconnect rejection can finalize cleanly", async () => {
    const result = await Effect.runPromise(
      Effect.result(KernelSdk.request("fetchHistory", () => Promise.reject(new Error("offline")))),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(KernelSdk.KernelError)
      expect(result.failure.operation).toBe("fetchHistory")
      expect(result.failure.message).toBe("offline")
    }
    await Effect.runPromise(
      Effect.addFinalizer(() =>
        KernelSdk.request("disconnect", () => Promise.reject(new Error("already closed"))).pipe(Effect.ignore),
      ).pipe(Effect.scoped),
    )
  })
})
