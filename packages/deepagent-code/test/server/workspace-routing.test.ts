import { describe, expect, test } from "bun:test"
import { sanitizeLocalDirectory } from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import {
  isLocalWorkspaceRoute,
  getWorkspaceRouteSessionID,
  workspaceProxyURL,
} from "../../src/server/shared/workspace-routing"
import { SessionID } from "../../src/session/schema"

describe("isLocalWorkspaceRoute", () => {
  test("keeps transfer-sensitive sync mutations local only at their exact POST paths", () => {
    expect(isLocalWorkspaceRoute("POST", "/sync/replay")).toBe(true)
    expect(isLocalWorkspaceRoute("POST", "/sync/steal")).toBe(true)
    expect(isLocalWorkspaceRoute("GET", "/sync/replay")).toBe(false)
    expect(isLocalWorkspaceRoute("POST", "/sync/replay/child")).toBe(false)
    expect(isLocalWorkspaceRoute("POST", "/sync/steal/child")).toBe(false)
  })

  test("GET /session is local", () => {
    expect(isLocalWorkspaceRoute("GET", "/session")).toBe(true)
  })

  test("GET /session/ses_abc is local (prefix match)", () => {
    expect(isLocalWorkspaceRoute("GET", "/session/ses_abc")).toBe(true)
  })

  test("POST /session is not local (method mismatch)", () => {
    expect(isLocalWorkspaceRoute("POST", "/session")).toBe(false)
  })

  test("/session/status is forwarded regardless of method", () => {
    expect(isLocalWorkspaceRoute("GET", "/session/status")).toBe(false)
    expect(isLocalWorkspaceRoute("POST", "/session/status")).toBe(false)
  })

  test("unrecognized paths are not local", () => {
    expect(isLocalWorkspaceRoute("GET", "/config")).toBe(false)
    expect(isLocalWorkspaceRoute("POST", "/session/ses_abc/message")).toBe(false)
  })
})

describe("getWorkspaceRouteSessionID", () => {
  test("extracts session ID from path", () => {
    const url = new URL("http://localhost/session/ses_abc123/message")
    expect(getWorkspaceRouteSessionID(url)).toBe(SessionID.make("ses_abc123"))
  })

  test("extracts session ID without trailing path", () => {
    const url = new URL("http://localhost/session/ses_xyz")
    expect(getWorkspaceRouteSessionID(url)).toBe(SessionID.make("ses_xyz"))
  })

  test("extracts session ID from experimental background path", () => {
    const url = new URL("http://localhost/experimental/session/ses_bg/background")
    expect(getWorkspaceRouteSessionID(url)).toBe(SessionID.make("ses_bg"))
  })

  test("returns null for /session/status", () => {
    const url = new URL("http://localhost/session/status")
    expect(getWorkspaceRouteSessionID(url)).toBeNull()
  })

  test("returns null for non-session paths", () => {
    const url = new URL("http://localhost/config")
    expect(getWorkspaceRouteSessionID(url)).toBeNull()
  })

  test("returns null for bare /session path", () => {
    const url = new URL("http://localhost/session")
    expect(getWorkspaceRouteSessionID(url)).toBeNull()
  })
})

describe("workspaceProxyURL", () => {
  test("appends request path to target", () => {
    const result = workspaceProxyURL("http://remote:8080/base", new URL("http://localhost/config"))
    expect(result.toString()).toBe("http://remote:8080/base/config")
  })

  test("strips trailing slash on target before appending", () => {
    const result = workspaceProxyURL("http://remote:8080/base/", new URL("http://localhost/session/abc"))
    expect(result.pathname).toBe("/base/session/abc")
  })

  test("preserves query params from request but removes workspace", () => {
    const url = new URL("http://localhost/config?workspace=ws_123&keep=yes")
    const result = workspaceProxyURL("http://remote:8080/base", url)
    expect(result.searchParams.get("workspace")).toBeNull()
    expect(result.searchParams.get("keep")).toBe("yes")
  })

  test("preserves hash from request", () => {
    const url = new URL("http://localhost/page#section")
    const result = workspaceProxyURL("http://remote:8080", url)
    expect(result.hash).toBe("#section")
  })

  test("works with URL object as target", () => {
    const target = new URL("http://remote:3000/api")
    const result = workspaceProxyURL(target, new URL("http://localhost/users"))
    expect(result.toString()).toBe("http://remote:3000/api/users")
  })
})

describe("sanitizeLocalDirectory (SEC-F4/F6 hardening)", () => {
  test("keeps clean absolute paths normalized", () => {
    expect(sanitizeLocalDirectory("/Users/me/projects/app")).toBe("/Users/me/projects/app")
    expect(sanitizeLocalDirectory("/a/../b")).toBe("/b")
  })
  test("rejects relative traversal and NUL by falling back to cwd", () => {
    expect(sanitizeLocalDirectory("../../etc")).toBe(process.cwd())
    expect(sanitizeLocalDirectory("a/../../b")).toBe(process.cwd())
    expect(sanitizeLocalDirectory("a\0b")).toBe(process.cwd())
  })
  test("keeps ordinary relative directories", () => {
    expect(sanitizeLocalDirectory(".")).toBe(".")
    expect(sanitizeLocalDirectory("work")).toBe("work")
  })
})
