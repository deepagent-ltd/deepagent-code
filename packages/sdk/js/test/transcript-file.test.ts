import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { uniqueExportPath } from "../src/transcript-file"

const dir = await mkdtemp(path.join(tmpdir(), "transcript-file-"))

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("uniqueExportPath", () => {
  test("returns the original path when nothing exists there", async () => {
    const target = path.join(dir, "fresh.md")
    expect(await uniqueExportPath(target)).toBe(target)
  })

  test("appends a sequence suffix instead of overwriting", async () => {
    const target = path.join(dir, "taken.md")
    await Bun.write(target, "one")
    const second = await uniqueExportPath(target)
    expect(second).toBe(path.join(dir, "taken-2.md"))
    await Bun.write(second, "two")
    expect(await uniqueExportPath(target)).toBe(path.join(dir, "taken-3.md"))
    // originals untouched
    expect(await Bun.file(target).text()).toBe("one")
    expect(await Bun.file(second).text()).toBe("two")
  })

  test("preserves the directory and extension of dotted names", async () => {
    const target = path.join(dir, "archive.final.md")
    await Bun.write(target, "x")
    expect(await uniqueExportPath(target)).toBe(path.join(dir, "archive.final-2.md"))
  })
})
