// Unit tests for the CLI permission tri-state auto-responder (PARITY-002).
// The interactive path keeps the manual prompt UI; these cover the
// non-interactive `deepagent-code run` auto-reply policy.
import { describe, expect, test } from "bun:test"
import { MUTATING_PERMISSIONS } from "@deepagent-code/core/permission/mutating"
import {
  PERMISSION_MODES,
  permissionReplyFor,
  resolvePermissionMode,
} from "@/cli/cmd/run/permission-mode"

const READ_PERMISSIONS = ["read", "glob", "grep", "list", "lsp", "webfetch", "websearch", "todowrite"]

describe("run --permission-mode resolution", () => {
  test("defaults to request mode (legacy reject-everything behavior)", () => {
    expect(resolvePermissionMode({})).toBe("request")
    expect(resolvePermissionMode({ "permission-mode": "request" })).toBe("request")
  })

  test("accepts every documented mode", () => {
    for (const mode of PERMISSION_MODES) {
      expect(resolvePermissionMode({ "permission-mode": mode })).toBe(mode)
    }
  })

  test("--dangerously-skip-permissions resolves to full-access (alias)", () => {
    expect(resolvePermissionMode({ "dangerously-skip-permissions": true })).toBe("full-access")
    expect(
      resolvePermissionMode({ "dangerously-skip-permissions": true, "permission-mode": "full-access" }),
    ).toBe("full-access")
  })

  test("rejects contradictory flag combinations and unknown modes", () => {
    expect(() =>
      resolvePermissionMode({ "dangerously-skip-permissions": true, "permission-mode": "request" }),
    ).toThrow("alias for --permission-mode full-access")
    expect(() =>
      resolvePermissionMode({ "dangerously-skip-permissions": true, "permission-mode": "read-only" }),
    ).toThrow("alias for --permission-mode full-access")
    expect(() => resolvePermissionMode({ "permission-mode": "yolo" })).toThrow(
      "--permission-mode must be one of: request, read-only, full-access",
    )
  })
})

describe("run --permission-mode auto-replies", () => {
  test("request mode rejects every permission (backwards-compatible default)", () => {
    for (const permission of [...MUTATING_PERMISSIONS, ...READ_PERMISSIONS]) {
      expect(permissionReplyFor("request", permission)).toBe("reject")
    }
  })

  test("read-only mode rejects exactly the mutating set and approves read-style tools", () => {
    expect([...MUTATING_PERMISSIONS]).toEqual(
      expect.arrayContaining(["edit", "write", "patch", "bash", "task", "external_directory"]),
    )
    for (const permission of MUTATING_PERMISSIONS) {
      expect(permissionReplyFor("read-only", permission)).toBe("reject")
    }
    for (const permission of READ_PERMISSIONS) {
      expect(permissionReplyFor("read-only", permission)).toBe("once")
    }
  })

  test("full-access mode approves every permission once (skip semantics)", () => {
    for (const permission of [...MUTATING_PERMISSIONS, ...READ_PERMISSIONS]) {
      expect(permissionReplyFor("full-access", permission)).toBe("once")
    }
  })
})

describe("mutating set consistency across consumers", () => {
  test("app read-only guard and CLI read-only mode share the same core constant", async () => {
    // packages/app re-exports the shared constant; a divergence here would
    // mean the GUI and CLI read-only modes disagree on what is denied.
    const app = await import("../../../../app/src/context/permission-auto-respond")
    expect(app.MUTATING_PERMISSIONS).toBe(MUTATING_PERMISSIONS)
    for (const permission of MUTATING_PERMISSIONS) {
      expect(app.isMutatingPermission(permission)).toBe(true)
      expect(permissionReplyFor("read-only", permission)).toBe("reject")
    }
  })
})
