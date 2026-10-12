import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { withWindowsCompilerBun } from "./build-windows-native-bootstrap"

const helperSource = path.join(import.meta.dir, "build-windows-native-bootstrap.ts")

test("compiler capture refuses a non-Windows process without publishing a file", async () => {
  if (process.platform === "win32") return
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-compiler-platform-")))
  try {
    await expect(withWindowsCompilerBun(directory, async () => "unreachable")).rejects.toThrow("current build and owned staging")
    expect(await fs.readdir(directory)).toEqual([])
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test("real Windows compiler hardlinks capture exact private bytes without permitting generic linked Work images", async () => {
  if (process.platform !== "win32") return
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-compiler-bun-current-")))
  const compiler = path.join(directory, "bun.exe")
  const original = await fs.readFile(await fs.realpath(process.execPath))
  const originalHash = createHash("sha256").update(original).digest("hex")
  try {
    await fs.writeFile(compiler, original, { flag: "wx" })
    await fs.link(compiler, path.join(directory, "compiler-alias.exe"))
    expect((await fs.lstat(compiler)).nlink).toBe(2)
    const entry = path.join(directory, "capture-child.ts")
    await Bun.write(entry, `
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { withWindowsCompilerBun, copyWindowsWorkBuildImage } from ${JSON.stringify(helperSource)}
const staging = process.argv[2]
const mode = process.argv[3]
const work = path.join(staging, "work")
await fs.mkdir(work)
const direct = path.join(staging, "rejected-direct")
await fs.mkdir(direct)
const rejected = await copyWindowsWorkBuildImage({ name: "bun-command-runtime.exe", source: process.execPath,
  staging: direct, cargoDirectory: staging, architecture: process.arch === "arm64" ? "arm64" : "x64" }).then(() => null, error => String(error))
if (!rejected?.includes("source_links") || (await fs.readdir(direct)).length) throw new Error("GENERIC_LINK_GUARD_WAS_RELAXED")
const result = await withWindowsCompilerBun(staging, async (source) => {
  const captured = await fs.lstat(source)
  if (captured.nlink !== 1 || await fs.realpath(source) !== source) throw new Error("PRIVATE_SOURCE_NOT_SINGLELINK")
  if (mode === "replace-copy") await fs.appendFile(source, "changed")
  if (mode === "foreign-parent") await Bun.write(path.join(path.dirname(source), "foreign"), "changed")
  if (mode === "source-link-change") await fs.link(process.execPath, path.join(path.dirname(process.execPath), "new-source-link.exe"))
  if (mode === "callback-failure") throw new Error("EXPECTED_CALLBACK_REJECTION")
  if (mode === "collision") await Bun.write(path.join(work, "bun-command-runtime.exe"), "foreign")
  const published = await copyWindowsWorkBuildImage({ name: "bun-command-runtime.exe", source, staging: work,
    cargoDirectory: staging, architecture: process.arch === "arm64" ? "arm64" : "x64" })
  return { sha256: published.sha256, bytes: published.bytes, links: (await fs.lstat(path.join(work, "bun-command-runtime.exe"))).nlink }
})
if (createHash("sha256").update(await fs.readFile(process.execPath)).digest("hex") !== result.sha256) throw new Error("CAPTURE_DIFFERENT_FROM_COMPILER")
console.log(JSON.stringify(result))
`)
    const run = async (mode: string) => {
      const staging = path.join(directory, mode)
      await fs.mkdir(staging)
      const child = Bun.spawn([compiler, entry, staging, mode], { stdout: "pipe", stderr: "pipe", timeout: 60_000 })
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect((await fs.readdir(staging)).filter((name) => name.startsWith(".compiler-bun-"))).toEqual([])
      return { exit, stdout, stderr }
    }
    const success = await run("success")
    expect(success.exit).toBe(0)
    expect(JSON.parse(success.stdout)).toEqual({ sha256: originalHash, bytes: original.length, links: 1 })
    expect((await fs.lstat(compiler)).nlink).toBe(2)
    const replaced = await run("replace-copy")
    expect(replaced.exit).not.toBe(0)
    expect(replaced.stderr).toContain("Windows publisher host fixed")
    const foreign = await run("foreign-parent")
    expect(foreign.exit).not.toBe(0)
    expect(foreign.stderr).toMatch(/Windows compiler Bun owned (parent|namespace) changed/)
    const collision = await run("collision")
    expect(collision.exit).not.toBe(0)
    expect(collision.stderr).toContain("EEXIST")
    const rejected = await run("callback-failure")
    expect(rejected.exit).not.toBe(0)
    expect(rejected.stderr).toContain("EXPECTED_CALLBACK_REJECTION")
    const linked = await run("source-link-change")
    expect(linked.exit).not.toBe(0)
    expect(linked.stderr).toContain("Windows compiler Bun source changed")
    await fs.rm(path.join(directory, "new-source-link.exe"))
    expect(createHash("sha256").update(await fs.readFile(compiler)).digest("hex")).toBe(originalHash)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
}, 120_000)
