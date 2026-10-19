import { expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"

function at(input: unknown, ...keys: string[]): unknown {
  return keys.reduce(
    (value, key) => (value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined),
    input,
  )
}

function resolve(spec: unknown, schema: unknown): unknown {
  const ref = at(schema, "$ref")
  return typeof ref === "string" ? at(spec, ...ref.split("/").slice(1)) : schema
}

test("OpenAPI exposes native model selections without fabricating a legacy disabled field", () => {
  const spec = OpenApi.fromApi(PublicApi)
  const provider = resolve(
    spec,
    at(spec, "components", "schemas", "Config", "properties", "providers", "additionalProperties"),
  )
  const native = resolve(spec, at(provider, "properties", "models", "additionalProperties"))
  const legacy = resolve(
    spec,
    at(spec, "components", "schemas", "ProviderConfig", "properties", "models", "additionalProperties"),
  )
  expect(at(native, "properties", "disabled", "type")).toBe("boolean")
  expect(at(legacy, "properties")).toBeDefined()
  expect(at(legacy, "properties", "disabled")).toBeUndefined()
})
