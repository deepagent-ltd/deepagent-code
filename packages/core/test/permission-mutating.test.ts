import { describe, expect, test } from "bun:test"
import { isMutatingPermission } from "../src/permission/mutating"

describe("read-only permission classification", () => {
  test.each(["mcp", "browser", "computer_use"])("rejects the generic %s execution permission", (permission) => {
    expect(isMutatingPermission(permission)).toBe(true)
  })

  test("retains existing write and execution restrictions", () => {
    expect(["edit", "write", "patch", "bash", "task", "external_directory"].every(isMutatingPermission)).toBe(true)
  })

  test("leaves established inspection permissions to their normal approval flow", () => {
    expect(
      ["read", "glob", "grep", "list", "lsp", "webfetch", "websearch", "todowrite"].some(isMutatingPermission),
    ).toBe(false)
  })
})
