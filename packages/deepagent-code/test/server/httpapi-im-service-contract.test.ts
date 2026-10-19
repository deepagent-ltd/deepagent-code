import { expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"

function at(input: unknown, ...keys: string[]): unknown {
  return keys.reduce(
    (value, key) => (value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined),
    input,
  )
}

function allowsNull(input: unknown): boolean {
  if (at(input, "type") === "null") return true
  const options = at(input, "anyOf") ?? at(input, "oneOf")
  return Array.isArray(options) && options.some(allowsNull)
}

test("IM service OpenAPI keeps explicit disable distinct from absent settings", () => {
  const spec = OpenApi.fromApi(PublicApi)
  const im = at(spec, "components", "schemas", "ConfigIM")
  expect(allowsNull(at(im, "properties", "url"))).toBe(true)
  expect(at(im, "required") ?? []).not.toContain("url")
  expect(allowsNull(at(im, "properties", "model"))).toBe(false)
  for (const method of ["get", "patch"]) {
    const response = at(
      spec,
      "paths",
      "/global/config",
      method,
      "responses",
      "200",
      "content",
      "application/json",
      "schema",
    )
    expect(response).toBeDefined()
  }
  const update = at(spec, "paths", "/global/config", "patch")
  expect(at(update, "requestBody", "content", "application/json", "schema")).toBeDefined()
  expect(at(update, "responses", "409")).toBeDefined()
  const service = at(spec, "components", "schemas", "IMServiceStatus")
  expect(
    at(
      spec,
      "paths",
      "/api/v1/im/status",
      "get",
      "responses",
      "200",
      "content",
      "application/json",
      "schema",
      "properties",
      "service",
      "$ref",
    ),
  ).toBe("#/components/schemas/IMServiceStatus")
  expect(allowsNull(at(service, "properties", "url"))).toBe(true)
  expect(at(service, "properties", "source", "enum")).toEqual(["config", "environment", "none"])
})
