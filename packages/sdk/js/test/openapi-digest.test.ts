import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"

// C6-04 — deterministic OpenAPI digest gate (design §12). The SDK is generated
// from `packages/sdk/openapi.json`; regenerating the same source must produce
// byte-identical JSON (the generate command formats through prettier). If this
// digest changes, it means the OpenAPI surface drifted and the committed file
// MUST be regenerated + the SDK rebuilt — this test is that gate.

const openapiPath = new URL("../../openapi.json", import.meta.url).pathname
const expectedDigest = "b1a79087cadc649552b40e75afa44ad521d977416ebd81b4f5043de24d8b2508"

describe("C6-04 OpenAPI schema drift (digest gate)", () => {
  test("the committed openapi.json digest is stable (regenerate + rebuild when it changes)", async () => {
    const file = Bun.file(openapiPath)
    expect(await file.exists()).toBe(true)
    const text = await file.text()
    const digest = createHash("sha256").update(text).digest("hex")
    expect(digest).toBe(expectedDigest)
  })

  test("the OpenAPI document declares the C6-04 per-status error responses", async () => {
    const spec = (await Bun.file(openapiPath).json()) as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>
    }
    const op = spec.paths["/context/events"]?.get
    expect(op).toBeDefined()
    expect(Object.keys(op!.responses)).toEqual(["200", "400", "403", "404", "409", "410", "423", "503"])
  })
})
