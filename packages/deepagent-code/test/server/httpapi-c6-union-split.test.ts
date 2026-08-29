import { describe, expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"
import { CapabilityPaths } from "../../src/server/routes/instance/httpapi/groups/capability"
import { ContextPaths } from "../../src/server/routes/instance/httpapi/groups/context"
import { SystemContextPaths } from "../../src/server/routes/instance/httpapi/groups/system-context"

// C6-04 — the C0-03 typed-error union (ApiTypedError) that Effect's OpenApi.fromApi
// emits as a single 500 `anyOf` is split by the mapper into the per-status
// responses 400/403/404/409/410/423/503. This asserts the C6-01..03 endpoints now
// advertise the per-status error responses a client can branch on (Client decides
// on `code` + `httpStatus`, never `message`).

type Operation = {
  responses: Record<string, { description?: string; content?: Record<string, { schema?: { $ref?: string } }> }>
}

const opOf = (doc: unknown, path: string, method: string): Operation | undefined => {
  const p = (doc as { paths: Record<string, Record<string, Operation>> }).paths?.[path]
  return p?.[method]
}

const statusRef = (op: Operation, status: string): string | undefined =>
  op.responses[status]?.content?.["application/json"]?.schema?.$ref

describe("C6-04 typed-error union split", () => {
  const doc = OpenApi.fromApi(PublicApi)

  const expectedStatuses = ["400", "403", "404", "409", "410", "423", "503"]

  test("the C6 endpoints advertise per-status typed-error responses, not a generic 500 union", () => {
    const routes: Array<[string, string]> = [
      ["GET", CapabilityPaths.catalog],
      ["POST", CapabilityPaths.search],
      ["GET", ContextPaths.readiness],
      ["GET", ContextPaths.eventsCursor],
      ["GET", ContextPaths.events],
      ["GET", SystemContextPaths.snapshot],
      ["GET", "/recovery/list"],
      ["GET", "/bootstrap/status"],
    ]
    for (const [method, path] of routes) {
      const op = opOf(doc, path, method.toLowerCase())
      expect(op, `${method} ${path}`).toBeDefined()
      for (const status of expectedStatuses) {
        expect(op!.responses[status], `${method} ${path} ${status}`).toBeDefined()
      }
      expect(op!.responses["500"], `${method} ${path} still emits the aggregate 500 union`).toBeUndefined()
    }
  })

  test("each per-status response references the matching Api* component", () => {
    const expectedRefs: Record<string, string> = {
      "400": "ApiBadRequest",
      "403": "ApiForbidden",
      "404": "ApiNotFound",
      "409": "ApiConflict",
      "410": "ApiGone",
      "423": "ApiLocked",
      "503": "ApiUnavailable",
    }
    const op = opOf(doc, ContextPaths.events, "get")!
    for (const [status, component] of Object.entries(expectedRefs)) {
      expect(statusRef(op, status)).toBe(`#/components/schemas/${component}`)
    }
  })

  test("the generic 500 union from OpenApi.fromApi is gone from the C6 surface", () => {
    const op = opOf(doc, CapabilityPaths.catalog, "get")!
    expect(statusRef(op, "500")).toBeUndefined()
  })
})
