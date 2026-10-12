import { expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"

function at(input: unknown, ...keys: string[]): unknown {
  return keys.reduce(
    (value, key) => (value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined),
    input,
  )
}

test("scoped MCP mutation authentication and unknown connection errors survive public lowering", () => {
  const spec = OpenApi.fromApi(PublicApi)
  const routes = [
    ["/mcp", "post"],
    ["/mcp/catalog/enable", "post"],
    ["/mcp/{name}/auth", "post"],
    ["/mcp/{name}/auth/callback", "post"],
    ["/mcp/{name}/auth/authenticate", "post"],
    ["/mcp/{name}/auth", "delete"],
    ["/mcp/{name}/connect", "post"],
    ["/mcp/{name}/disconnect", "post"],
  ]
  routes.forEach(([path, method]) => {
    const operation = at(spec, "paths", path, method)
    expect(operation).toBeDefined()
    expect(at(operation, "responses", "401", "content", "application/json", "schema")).toBeDefined()
  })
  expect(at(spec, "paths", "/mcp/{name}/connect", "post", "responses", "409")).toBeDefined()
  expect(at(spec, "paths", "/mcp", "post", "requestBody", "required")).toBe(true)
  expect(at(spec, "paths", "/mcp/{name}/auth/callback", "post", "requestBody", "required")).toBe(true)
  // Read-only existing endpoints retain their legacy public error contract.
  expect(at(spec, "paths", "/mcp", "get", "responses", "401")).toBeUndefined()
  expect(at(spec, "paths", "/mcp/catalog", "get", "responses", "401")).toBeUndefined()
})

test("read-only commands expose optional metadata and native authentication errors", () => {
  const spec = OpenApi.fromApi(PublicApi)
  expect(at(spec, "paths", "/command", "get", "responses", "200", "content", "application/json", "schema", "items", "$ref")).toBe(
    "#/components/schemas/CommandRead",
  )
  expect(at(spec, "components", "schemas", "CommandRead", "required")).toEqual(
    expect.not.arrayContaining(["template", "availability"]),
  )
  expect(at(spec, "components", "schemas", "CommandRead", "properties", "availability", "enum")).toEqual([
    "available",
    "connect_required",
    "unavailable",
  ])
  expect(at(spec, "paths", "/command", "get", "responses", "401")).toBeDefined()
})

test("MCP display reads declare unavailable placement without changing legacy read authentication errors", () => {
  const spec = OpenApi.fromApi(PublicApi)
  for (const path of ["/mcp", "/mcp/catalog", "/experimental/resource", "/command"]) {
    expect(at(spec, "paths", path, "get", "responses", "503", "content", "application/json", "schema", "$ref")).toBe(
      "#/components/schemas/ServiceUnavailableError",
    )
  }
  expect(at(spec, "components", "schemas", "ServiceUnavailableError", "properties", "_tag", "enum")).toEqual([
    "ServiceUnavailableError",
  ])
  expect(at(spec, "components", "schemas", "ServiceUnavailableError", "required")).toContain("message")
  expect(at(spec, "paths", "/mcp", "get", "responses", "401")).toBeUndefined()
  expect(at(spec, "paths", "/mcp/catalog", "get", "responses", "401")).toBeUndefined()
})
