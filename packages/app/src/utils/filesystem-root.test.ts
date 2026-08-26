import { describe, expect, test } from "bun:test"
import { isFilesystemRootDir, recoverFilesystemRootRoute } from "./filesystem-root"

describe("isFilesystemRootDir", () => {
  test("recognizes POSIX, drive, and UNC roots", () => {
    expect(isFilesystemRootDir("/")).toBe(true)
    expect(isFilesystemRootDir("///")).toBe(true)
    expect(isFilesystemRootDir("C:\\")).toBe(true)
    expect(isFilesystemRootDir("c:/")).toBe(true)
    expect(isFilesystemRootDir("\\\\server\\share\\")).toBe(true)
  })

  test("rejects concrete directories", () => {
    expect(isFilesystemRootDir("/Users/example")).toBe(false)
    expect(isFilesystemRootDir("C:\\Users\\example")).toBe(false)
    expect(isFilesystemRootDir("\\\\server\\share\\folder")).toBe(false)
    expect(isFilesystemRootDir("")).toBe(false)
  })
})

describe("recoverFilesystemRootRoute", () => {
  const dataDir = "/home/user/.deepagent/code"

  test("creates a folder-less sandbox for a bare root route", async () => {
    const created: string[] = []
    const result = await recoverFilesystemRootRoute({
      dataDir,
      getSession: async () => undefined,
      mkdir: async (directory) => {
        created.push(directory)
      },
      moveSession: async () => {},
    })

    expect(result.directory).toStartWith(`${dataDir}/workspaces/`)
    expect(result.sessionID).toBeUndefined()
    expect(created).toEqual([result.directory])
  })

  test("moves a root session into a stable sandbox based on its conversation root", async () => {
    const sessions = new Map([
      ["parent", { id: "parent", directory: "/" }],
      ["child", { id: "child", parentID: "parent", directory: "/" }],
    ])
    const moved: Array<[string, string]> = []
    const first = await recoverFilesystemRootRoute({
      dataDir,
      sessionID: "child",
      getSession: async (sessionID) => sessions.get(sessionID),
      mkdir: async () => {},
      moveSession: async (sessionID, directory) => {
        moved.push([sessionID, directory])
      },
    })
    const second = await recoverFilesystemRootRoute({
      dataDir,
      sessionID: "parent",
      getSession: async (sessionID) => sessions.get(sessionID),
      mkdir: async () => {},
      moveSession: async () => {},
    })

    expect(first.directory).toBe(second.directory)
    expect(first.directory).toStartWith(`${dataDir}/workspaces/recovered-`)
    expect(moved).toEqual([["child", first.directory]])
  })

  test("reuses an already recovered parent sandbox", async () => {
    const recovered = `${dataDir}/workspaces/recovered-parent`
    const result = await recoverFilesystemRootRoute({
      dataDir,
      sessionID: "child",
      getSession: async (sessionID) =>
        sessionID === "child"
          ? { id: "child", parentID: "parent", directory: "/" }
          : { id: "parent", directory: recovered },
      mkdir: async () => {},
      moveSession: async () => {},
    })

    expect(result.directory).toBe(recovered)
  })

  test("redirects a stale root URL to the session's current directory", async () => {
    let mkdir = false
    let move = false
    const result = await recoverFilesystemRootRoute({
      dataDir,
      sessionID: "session",
      getSession: async () => ({ id: "session", directory: "/repo" }),
      mkdir: async () => {
        mkdir = true
      },
      moveSession: async () => {
        move = true
      },
    })

    expect(result).toEqual({ directory: "/repo", sessionID: "session" })
    expect(mkdir).toBe(false)
    expect(move).toBe(false)
  })
})
