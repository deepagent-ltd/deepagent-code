import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PINNED_PACKS_FILE, pinnedPacksFile, readPinnedPacks, writePinnedPacks } from "../../src/deepagent/pinned-packs"

const withTempMemoryDir = (fn: (memoryDir: string) => void) => {
  const dir = mkdtempSync(path.join(tmpdir(), "deepagent-pinned-packs-"))
  try {
    fn(path.join(dir, "memory"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("pinned-packs module (FEAT-001)", () => {
  test("missing file reads as no pins", () => {
    withTempMemoryDir((memoryDir) => {
      expect(readPinnedPacks(memoryDir)).toEqual([])
    })
  })

  test("corrupt JSON degrades to no pins instead of throwing", () => {
    withTempMemoryDir((memoryDir) => {
      mkdirSync(memoryDir, { recursive: true })
      writeFileSync(pinnedPacksFile(memoryDir), "{not json")
      expect(readPinnedPacks(memoryDir)).toEqual([])
    })
  })

  test("non-array JSON payload degrades to no pins", () => {
    withTempMemoryDir((memoryDir) => {
      mkdirSync(memoryDir, { recursive: true })
      writeFileSync(pinnedPacksFile(memoryDir), JSON.stringify({ packs: ["code.core"] }))
      expect(readPinnedPacks(memoryDir)).toEqual([])
    })
  })

  test("non-string entries are filtered out", () => {
    withTempMemoryDir((memoryDir) => {
      mkdirSync(memoryDir, { recursive: true })
      writeFileSync(pinnedPacksFile(memoryDir), JSON.stringify(["code.core", 42, null, { id: "x" }, "risk.security"]))
      expect(readPinnedPacks(memoryDir)).toEqual(["code.core", "risk.security"])
    })
  })

  test("write then read round-trips pins (deduplicated, sorted)", () => {
    withTempMemoryDir((memoryDir) => {
      writePinnedPacks(memoryDir, ["risk.security", "code.core", "risk.security"])
      expect(readPinnedPacks(memoryDir)).toEqual(["code.core", "risk.security"])
    })
  })

  test("write creates the memory dir on demand and pins the canonical file name", () => {
    withTempMemoryDir((memoryDir) => {
      expect(PINNED_PACKS_FILE).toBe("pinned-packs.json")
      writePinnedPacks(memoryDir, ["code.core"])
      expect(pinnedPacksFile(memoryDir)).toBe(path.join(memoryDir, PINNED_PACKS_FILE))
      expect(readPinnedPacks(memoryDir)).toEqual(["code.core"])
    })
  })
})
