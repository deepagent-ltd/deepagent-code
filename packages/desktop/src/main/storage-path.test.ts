import { describe, expect, test } from "bun:test"
import path from "node:path"
import { desktopStoragePaths } from "./storage-path"

describe("desktop private storage", () => {
  test("keeps every Electron-owned path below the canonical data root", () => {
    const root = path.resolve("/private/deepagent/code")
    const paths = desktopStoragePaths(root, "ai.deepagent-code.desktop")
    expect(Object.values(paths).every((item) => item.startsWith(root + path.sep))).toBe(true)
    expect(paths.updater).toBe(path.join(paths.root, "updater"))
  })
})
