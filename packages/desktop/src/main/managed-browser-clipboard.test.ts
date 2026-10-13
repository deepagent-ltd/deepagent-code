import { managedBrowserInputRuntime } from "../../scripts/managed-browser-input-runtime"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { managedBrowserInputFixtureDefine } from "./fixture/managed-browser-input-build"

const actual = process.env.DAC_BROWSER_CLIPBOARD_ACTUAL === "1" ? test : test.skip

actual("actual Main clipboard: original confirmation, private utility/fileDB, lease, stale/close gates and RAM restoration", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-browser-clipboard-"))
  await fs.chmod(root, 0o700)
  await fs.mkdir(path.join(root, "project"), { mode: 0o700 })
  await fs.symlink(path.resolve(import.meta.dir, "../../../deepagent-code/node_modules"), path.join(root, "node_modules"), "dir")
  for (const role of ["main", "utility"]) {
    const entry = role === "main" ? "managed-browser-clipboard-main.ts" : "managed-browser-clipboard.ts"
    const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture", entry)], target: "node", conditions: ["node"],
      external: ["electron", "bun", "jsonc-parser", "@lydell/node-pty"], outdir: root, naming: `${role}.${role === "main" ? "cjs" : "mjs"}`,
      format: role === "main" ? "cjs" : "esm", define: role === "main" ? await managedBrowserInputFixtureDefine(root) : {} })
    expect(build.success, build.logs.map(String).join("\n")).toBe(true)
  }
  console.log("CLIPBOARD_MODULE_EVIDENCE", root)
  const child = Bun.spawn([path.join(import.meta.dir, "../../node_modules/.bin/electron"), path.join(root, "main.cjs")], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root,
      DAC_BROWSER_CLIPBOARD_ROOT: root, DAC_BROWSER_CLIPBOARD_MODULE: path.join(root, "utility.mjs") }, stdout: "pipe", stderr: "pipe", timeout: 165_000,
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  await fs.writeFile(path.join(root, "process.log"), stdout + "\n" + stderr, { mode: 0o600 })
  const result = await Bun.file(path.join(root, "result.json")).json()
  const failure = await Bun.file(path.join(root, "utility-failure.json")).exists() ?
    await Bun.file(path.join(root, "utility-failure.json")).json() : undefined
  expect(code, failure ? JSON.stringify(failure) : stderr.slice(-2000)).toBe(0)
  expect(result.code).toBe(0)
  expect(result.result.node).toBe(managedBrowserInputRuntime.nodeVersion)
  expect(result.result.electron).toBe(managedBrowserInputRuntime.electronVersion)
  expect(result.result.oldDenied).toBe("BROWSER_SCOPE_DENIED")
  expect(result.result.copiedDescriptorDenied).toBe(true)
  expect(result.result.inputs).toBe(0)
  expect(result.result.providers).toBe(0)
  expect(result.result.cold.readOnly).toBe(true)
  expect(result.facts.windows).toBe(0)
  expect(result.facts.externalChanged).toBe(false)
  expect(result.facts.restored).toBe(true)
  if (result.result.blocked) {
    expect(result.result.refusedRead).toBe("BROWSER_DRIVER_UNAVAILABLE")
    expect(result.result.refusedWrite).toBe("BROWSER_DRIVER_UNAVAILABLE")
    expect(result.facts.clipboardInspectedByQA).toBe(false)
    expect(result.facts.stages).toEqual([])
    return
  }
  expect(result.result.leaseDenied).toBe("BROWSER_CAPACITY")
  expect(result.result.staleDenied).toBe(true)
  expect(result.result.oversizedWriteDenied).toBe(true)
  expect(result.result.positives.map((value: { direction: string }) => value.direction)).toEqual(result.facts.safeRestore ? ["read", "write"] : [])
  if (result.facts.safeRestore) {
    expect(result.facts.pageBypass).toEqual({ readAllowed: false, writeAllowed: false, copyAllowed: false, contentChanged: false })
    expect(result.result.positives.map((value: { bytes: number }) => value.bytes)).toEqual([16384, 8192])
    expect(result.result.exactRetryNoWrites).toBe(true)
  }
}, 180_000)
