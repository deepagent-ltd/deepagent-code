import { managedBrowserInputRuntime } from "../../scripts/managed-browser-input-runtime"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { managedBrowserInputFixtureDefine } from "./fixture/managed-browser-input-build"
import { createHash, randomBytes } from "node:crypto"

const actual = process.env.DAC_BROWSER_CLIPBOARD_PHYSICAL_ACTUAL === "1" || process.env.DAC_BROWSER_CLIPBOARD_PHYSICAL_PREPARE_ONLY === "1" || process.env.DAC_BROWSER_CLIPBOARD_PHYSICAL_REPLAY ? test : test.skip
actual("actual private QA clipboard: native original Main/utility/fileDB read16KiB/write8KiB with RAM snapshot and pasteboard owner guard", async () => {
  const root = await fs.realpath(process.env.DAC_BROWSER_CLIPBOARD_PHYSICAL_REPLAY ?? await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "dac-browser-clipboard-physical-")))
  if (!process.env.DAC_BROWSER_CLIPBOARD_PHYSICAL_REPLAY) {
    await fs.chmod(root, 0o700)
    await fs.mkdir(path.join(root, "project"), { mode: 0o700 })
    await fs.symlink(path.resolve(import.meta.dir, "../../../deepagent-code/node_modules"), path.join(root, "node_modules"), "dir")
    for (const name of ["managed-browser-clipboard-physical.ts", "managed-browser-clipboard-physical-child.ts"]) {
      const source = await Bun.file(path.join(import.meta.dir, "fixture", name)).text()
      expect(source.includes("process.env.DAC_BROWSER_CLIPBOARD_QA_CREDENTIAL")).toBe(true)
      expect(source.includes("private-clipboard-module") || source.includes("private-clipboard-physical")).toBe(false)
    }
    const schema = path.resolve(import.meta.dir, "../../../core/src/browser/schema.ts")
    const original = await Bun.file(schema).text()
    const before = "export const CLIPBOARD_NATIVE_AVAILABLE = false"
    const after = "export const CLIPBOARD_NATIVE_AVAILABLE = true"
    expect(original.split(before).length).toBe(2)
    const overlay = original.replace(before, after)
    const inventory = new Map<string, { before: string; after: string }>()
    for (const role of ["main", "utility"]) {
      const entry = role === "main" ? "managed-browser-clipboard-physical.ts" : "managed-browser-clipboard-physical-child.ts"
      const built = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture", entry)], target: "node", conditions: ["node"],
        external: ["electron", "bun", "jsonc-parser", "@lydell/node-pty"], sourcemap: "external", outdir: root,
        naming: `${role}.${role === "main" ? "cjs" : "mjs"}`, format: role === "main" ? "cjs" : "esm",
        define: role === "main" ? await managedBrowserInputFixtureDefine(root) : {},
        plugins: [{ name: "private-qa-clipboard-exact-feature-enable", setup(build) {
          build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (input) => {
            const source = await Bun.file(input.path).text()
            const contents = input.path === schema ? overlay : source
            const previous = inventory.get(input.path)
            const hashes = { before: createHash("sha256").update(source).digest("hex"), after: createHash("sha256").update(contents).digest("hex") }
            expect(previous === undefined || previous.before === hashes.before && previous.after === hashes.after).toBe(true)
            inventory.set(input.path, hashes)
            return { contents, loader: input.path.endsWith(".tsx") ? "tsx" : input.path.endsWith(".ts") ? "ts" : "js" }
          })
        } }],
      })
      expect(built.success, built.logs.map(String).join("\n")).toBe(true)
    }
    const final = await Promise.all(Array.from(inventory, async ([filename, hashes]) => ({ filename, ...hashes,
      final: createHash("sha256").update(await Bun.file(filename).text()).digest("hex") })))
    expect(final.filter((row) => row.final !== row.before)).toEqual([])
    expect(final.filter((row) => row.before !== row.after).map((row) => row.filename)).toEqual([schema])
    await fs.writeFile(path.join(root, "source-cohort.json"), JSON.stringify({ version: 1, files: final,
      overlay: { filename: schema, exactBefore: before, exactAfter: after }, boundary: "QA enable only, official source remains OFF" }), { mode: 0o600 })
    const guard = '#import <AppKit/AppKit.h>\n#include <stdio.h>\nint main(void){@autoreleasepool{NSPasteboard*p=[NSPasteboard generalPasteboard];printf("%ld %lu\\n",(long)p.changeCount,(unsigned long)p.pasteboardItems.count);}return 0;}\n'
    await fs.writeFile(path.join(root, "pasteboard-owner.m"), guard, { mode: 0o600 })
    const compile = Bun.spawn(["/usr/bin/xcrun", "clang", "-framework", "AppKit", path.join(root, "pasteboard-owner.m"), "-o", path.join(root, "pasteboard-owner")], {
      env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root }, stdout: "pipe", stderr: "pipe", timeout: 15_000,
    })
    const [guardCode, guardOutput, guardErrors] = await Promise.all([compile.exited, new Response(compile.stdout).text(), new Response(compile.stderr).text()])
    expect(guardCode, guardOutput + guardErrors).toBe(0)
    console.log("CLIPBOARD_PHYSICAL_EVIDENCE", root)
    if (process.env.DAC_BROWSER_CLIPBOARD_PHYSICAL_PREPARE_ONLY === "1") {
      await fs.writeFile(path.join(root, "prepare-ready.json"), JSON.stringify({ root, onlyPrepare: true, sourceCount: inventory.size,
        overlayFiles: 1, guardSHA: createHash("sha256").update(guard).digest("hex"), nativeUIStarted: false, clipboardInspected: false }), { mode: 0o600 })
      return
    }
    if (process.env.DAC_BROWSER_CLIPBOARD_UI_ADDON) await fs.copyFile(process.env.DAC_BROWSER_CLIPBOARD_UI_ADDON, path.join(root, "native-ui-qa.node"))
    const child = Bun.spawn([process.env.DAC_BROWSER_CLIPBOARD_ELECTRON ?? path.join(import.meta.dir, "../../node_modules/.bin/electron"), path.join(root, "main.cjs")], {
      cwd: root, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root,
        DAC_BROWSER_CLIPBOARD_ROOT: root, DAC_BROWSER_CLIPBOARD_QA_CREDENTIAL: randomBytes(32).toString("hex"), DAC_BROWSER_CLIPBOARD_MODULE: path.join(root, "utility.mjs") }, stdout: "pipe", stderr: "pipe", timeout: 135_000,
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    await fs.writeFile(path.join(root, "process.log"), stdout + "\n" + stderr, { mode: 0o600 })
    const failure = await Bun.file(path.join(root, "main-failure.json")).exists() ? await Bun.file(path.join(root, "main-failure.json")).json() : undefined
    const utilityFailure = await Bun.file(path.join(root, "utility-failure.json")).exists() ? await Bun.file(path.join(root, "utility-failure.json")).json() : undefined
    expect(code, JSON.stringify({ failure, utilityFailure }) ?? "QA process failed").toBe(0)
  }
  const result = await Bun.file(path.join(root, "result.json")).json()
  expect(result.result.electron).toBe(managedBrowserInputRuntime.electronVersion)
  expect(result.result.positives.map((row: { direction: string; bytes: number }) => [row.direction, row.bytes])).toEqual([["read", 16384], ["write", 8192]])
  expect(result.result.oldDenied).toBe("BROWSER_SCOPE_DENIED")
  expect(result.result.copiedDescriptorDenied).toBe(true)
  expect(result.result.staleDenied).toBe(true)
  expect(result.result.exactRetryNoWrites).toBe(true)
  expect(result.result.cold.readOnly).toBe(true)
  expect(result.result.inputs).toBe(0)
  expect(result.result.providers).toBe(0)
  expect(result.facts.pageBypass).toEqual({ readAllowed: false, writeAllowed: false, copyAllowed: false, contentChanged: false })
  expect(result.facts.nativeUI.map((row: { direction: string; before: number; after: number; clicked: boolean }) =>
    [row.direction, row.before, row.after, row.clicked])).toEqual([["read", 0, 1, true], ["write", 0, 1, true]])
  expect(result.facts.restored).toBe(true)
  expect(result.facts.externalChanged).toBe(false)
  expect(result.facts.originalSnapshotRAMOnly).toBe(true)
  expect(result.facts.windows).toBe(0)
}, 150_000)
