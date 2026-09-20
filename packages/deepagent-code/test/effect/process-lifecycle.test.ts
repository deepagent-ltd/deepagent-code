import { describe, expect, test } from "bun:test"
import { ProcessLifecycle } from "@/effect/process-lifecycle"

describe("process lifecycle", () => {
  test("runs every cleanup and reports aggregate failures", async () => {
    const lifecycle = ProcessLifecycle.make(2)
    const cleaned: string[] = []
    lifecycle.register("test.success", () => {
      cleaned.push("success")
    })
    lifecycle.register("test.failure", () => {
      cleaned.push("failure")
      throw new Error("cleanup failed")
    })

    const error = await lifecycle.disposeAll().catch((failure: unknown) => failure)

    expect(cleaned.toSorted()).toEqual(["failure", "success"])
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toHaveLength(1)
    expect(() => lifecycle.register("test.late", () => {})).toThrow("after shutdown started")
  })
})
