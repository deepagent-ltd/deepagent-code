import { describe, expect, test } from "bun:test"
import path from "path"
import { assertSafeInstanceRoot, containsPath, isFilesystemRoot } from "../../src/project/instance-context"
import type { InstanceContext } from "../../src/project/instance-context"

// Security-critical invariant (Appendix C 权限边界): an instance's `directory` is the
// file-tool permission boundary (containsPath). It must NEVER be the filesystem root,
// or containsPath would match every absolute path and expose the whole filesystem.
// A folder-less chat / sandbox is bound to <dataDir>/workspaces/<id>; if that ever
// degraded to "/" or "" the boundary would collapse. These tests lock the fail-closed
// boot guard and the containsPath boundary semantics.

const ctx = (directory: string, worktree: string): InstanceContext => ({
  directory,
  worktree,
  // project is not consulted by containsPath.
  project: { id: "global" } as unknown as InstanceContext["project"],
})

describe("isFilesystemRoot", () => {
  test("detects the posix root", () => {
    expect(isFilesystemRoot("/")).toBe(true)
    // A path that resolves to root.
    expect(isFilesystemRoot("/foo/..")).toBe(true)
  })

  test("rejects real (non-root) directories", () => {
    expect(isFilesystemRoot("/home/user/.deepagent/code/workspaces/abc123")).toBe(false)
    expect(isFilesystemRoot("/tmp")).toBe(false)
  })

  test("treats empty / whitespace as not-a-root (assertSafeInstanceRoot rejects those separately)", () => {
    expect(isFilesystemRoot("")).toBe(false)
    expect(isFilesystemRoot("   ")).toBe(false)
  })
})

describe("assertSafeInstanceRoot", () => {
  test("rejects the filesystem root — fail closed", () => {
    expect(() => assertSafeInstanceRoot("/")).toThrow()
    expect(() => assertSafeInstanceRoot("/foo/..")).toThrow()
  })

  test("rejects empty / whitespace directories — fail closed", () => {
    expect(() => assertSafeInstanceRoot("")).toThrow()
    expect(() => assertSafeInstanceRoot("   ")).toThrow()
  })

  test("accepts a real sandbox directory", () => {
    const sandbox = path.join("/home/user/.deepagent/code/workspaces", "abc123")
    expect(() => assertSafeInstanceRoot(sandbox)).not.toThrow()
    expect(() => assertSafeInstanceRoot("/tmp/project")).not.toThrow()
  })
})

describe("containsPath boundary", () => {
  test("a sandbox directory confines file tools to itself", () => {
    const sandbox = "/home/user/.deepagent/code/workspaces/abc123"
    const c = ctx(sandbox, "/")
    // Inside the sandbox: inside the boundary.
    expect(containsPath(`${sandbox}/notes.md`, c)).toBe(true)
    expect(containsPath(sandbox, c)).toBe(true)
    // Outside the sandbox: NOT inside the boundary (routes through external_directory).
    expect(containsPath("/etc/passwd", c)).toBe(false)
    expect(containsPath("/home/user/secret.txt", c)).toBe(false)
  })

  test("worktree === '/' sentinel does NOT widen the boundary to the whole filesystem", () => {
    // Non-git ("global") projects carry the "/" worktree sentinel. The short-circuit
    // must keep external paths OUTSIDE the boundary so external_directory prompts fire.
    const c = ctx("/home/user/.deepagent/code/workspaces/abc123", "/")
    expect(containsPath("/", c)).toBe(false)
    expect(containsPath("/var/log/system.log", c)).toBe(false)
  })

  test("a real git worktree still counts paths inside it as in-boundary", () => {
    const c = ctx("/repo/sub", "/repo")
    expect(containsPath("/repo/other/file.ts", c)).toBe(true)
    expect(containsPath("/elsewhere/file.ts", c)).toBe(false)
  })
})
