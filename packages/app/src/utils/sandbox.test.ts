import { describe, expect, test } from "bun:test"
import { isSandboxDir, sandboxDir, SANDBOX_SUBDIR } from "./sandbox"

// Appendix C 形态二 (form 2): folder-less new chat routing/dir-resolution logic.
// The security-critical invariant is that a folder-less chat resolves to a dedicated
// sandbox directory under the server data dir — never "/". Rooting at "/" would make
// the whole filesystem readable/writable by file tools (the "global" project's
// worktree === "/" sentinel makes the permission boundary fall back to the instance
// directory). These tests lock the resolver behavior.

const DATA_POSIX = "/home/user/.deepagent/code"
const DATA_WIN = "C:\\Users\\user\\AppData\\Roaming\\deepagent-code"

describe("sandboxDir", () => {
  test("resolves under <dataDir>/workspaces/<id>, never '/'", () => {
    const dir = sandboxDir(DATA_POSIX, "abc123")
    expect(dir).toBe(`${DATA_POSIX}/${SANDBOX_SUBDIR}/abc123`)
    // Never the filesystem root, never a bare "/workspaces".
    expect(dir).not.toBe("/")
    expect(dir.startsWith(`${DATA_POSIX}/`)).toBe(true)
    expect(dir).not.toMatch(/^\/workspaces/)
  })

  test("generates a fresh id when none is given, still under the data dir", () => {
    const a = sandboxDir(DATA_POSIX)
    const b = sandboxDir(DATA_POSIX)
    expect(a).not.toBe(b)
    expect(a.startsWith(`${DATA_POSIX}/${SANDBOX_SUBDIR}/`)).toBe(true)
    expect(b.startsWith(`${DATA_POSIX}/${SANDBOX_SUBDIR}/`)).toBe(true)
  })

  test("uses the OS separator implied by the data dir (Windows)", () => {
    const dir = sandboxDir(DATA_WIN, "abc123")
    expect(dir).toBe(`${DATA_WIN}\\${SANDBOX_SUBDIR}\\abc123`)
  })

  test("strips trailing separators on the data dir", () => {
    expect(sandboxDir(`${DATA_POSIX}/`, "id")).toBe(`${DATA_POSIX}/${SANDBOX_SUBDIR}/id`)
    expect(sandboxDir(`${DATA_WIN}\\`, "id")).toBe(`${DATA_WIN}\\${SANDBOX_SUBDIR}\\id`)
  })

  test("throws instead of composing a root-level path when data dir is unavailable", () => {
    // Guards against the app rooting a folder-less chat at "/workspaces/<id>" (or
    // worse) before the server path data has loaded.
    expect(() => sandboxDir("")).toThrow()
    expect(() => sandboxDir("   ")).toThrow()
  })
})

describe("isSandboxDir", () => {
  test("recognizes directories under the sandbox root", () => {
    expect(isSandboxDir(DATA_POSIX, sandboxDir(DATA_POSIX, "x"))).toBe(true)
    expect(isSandboxDir(DATA_WIN, sandboxDir(DATA_WIN, "x"))).toBe(true)
  })

  test("rejects unrelated directories and the data root itself", () => {
    expect(isSandboxDir(DATA_POSIX, "/home/user/projects/app")).toBe(false)
    expect(isSandboxDir(DATA_POSIX, DATA_POSIX)).toBe(false)
    expect(isSandboxDir(DATA_POSIX, "/")).toBe(false)
    expect(isSandboxDir("", "/home/user/.deepagent/code/workspaces/x")).toBe(false)
  })
})
