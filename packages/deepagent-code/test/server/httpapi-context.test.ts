import { describe, expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { ContextApi, ContextPaths } from "../../src/server/routes/instance/httpapi/groups/context"
import { ApiGoneError, makeApiError, apiErrorStatus } from "../../src/server/routes/instance/httpapi/typed-error"
import {
  ContextEventPageLimit,
  dedupeEvents,
  isCursorBehindFloor,
  validateEventLimit,
} from "../../src/server/routes/instance/httpapi/handlers/context"

// C6-03 (design §11.1 + §11.2): context readiness + snapshot-at-watermark cursor.
// The OpenAPI route-table asserts the surface; the pure helpers assert the
// bounded-resync / dedupe / limit decisions that never fall back to a volatile
// stream.

type Operation = { responses: Record<string, { description?: string }> }

const opOf = (doc: unknown, path: string, method: string): Operation | undefined => {
  const p = (doc as { paths: Record<string, Record<string, Operation>> }).paths?.[path]
  return p?.[method]
}

describe("C6-03 context OpenAPI route table", () => {
  const doc = OpenApi.fromApi(ContextApi)

  test("exposes readiness / eventsCursor / events routes", () => {
    expect(opOf(doc, ContextPaths.readiness, "get")).toBeDefined()
    expect(opOf(doc, ContextPaths.eventsCursor, "get")).toBeDefined()
    expect(opOf(doc, ContextPaths.events, "get")).toBeDefined()
  })

  test("readiness and events declare a 200 success response", () => {
    expect(opOf(doc, ContextPaths.readiness, "get")!.responses["200"]).toBeDefined()
    expect(opOf(doc, ContextPaths.events, "get")!.responses["200"]).toBeDefined()
  })

  test("every endpoint declares the typed ApiTypedError error union", () => {
    for (const path of [ContextPaths.readiness, ContextPaths.eventsCursor, ContextPaths.events]) {
      expect(opOf(doc, path, "get")!.responses["500"]).toBeDefined()
    }
  })
})

describe("C6-03 cursor helpers", () => {
  test("validateEventLimit bounds the page size (over-limit is a typed 400)", () => {
    expect(validateEventLimit(undefined)).toBeUndefined()
    expect(validateEventLimit(1)).toBeUndefined()
    expect(validateEventLimit(ContextEventPageLimit)).toBeUndefined()
    expect(validateEventLimit(0)).toContain("positive")
    expect(validateEventLimit(-1)).toContain("positive")
    expect(validateEventLimit(ContextEventPageLimit + 1)).toContain("max page")
  })

  test("isCursorBehindFloor detects a retention-floor gap (bounded resync)", () => {
    expect(isCursorBehindFloor(10, 20)).toBe(true)
    expect(isCursorBehindFloor(20, 20)).toBe(false)
    expect(isCursorBehindFloor(30, 20)).toBe(false)
    // No compaction / no floor: a cursor never trips a synthetic gap.
    expect(isCursorBehindFloor(10, undefined)).toBe(false)
    expect(isCursorBehindFloor(10, null)).toBe(false)
  })

  test("dedupeEvents absorbs duplicates preserving order", () => {
    const events = [
      { seq: 1, id: "a" },
      { seq: 2, id: "b" },
      { seq: 2, id: "b" },
      { seq: 3, id: "c" },
      { seq: 1, id: "a" },
    ]
    expect(dedupeEvents(events).map((e) => e.seq)).toEqual([1, 2, 3])
  })
})

describe("C6-03 typed error mapping (retention floor / 410)", () => {
  test("cursor_gap_exceeded is a frozen 410 (ApiGone) so a client never parses message", () => {
    expect(apiErrorStatus("cursor_gap_exceeded")).toBe(410)
    const err = makeApiError("cursor_gap_exceeded", {
      resource: "session/abc",
      expected: "after >= 100",
      actual: "10",
    })
    expect(err).toBeInstanceOf(ApiGoneError)
    expect(err.data.httpStatus).toBe(410)
    expect(err.data.code).toBe("cursor_gap_exceeded")
    expect(err.data.retryability).toBe("not_retryable")
  })
})
