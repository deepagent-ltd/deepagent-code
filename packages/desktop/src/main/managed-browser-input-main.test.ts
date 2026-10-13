import { expect, test } from "bun:test"
import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises"
import path from "node:path"
import { prepareManagedBrowserInputAsset } from "../../scripts/managed-browser-input-assets"

test.skipIf(process.platform !== "darwin")("actual Main input source retires only its window, denies old refs and releases with NativeHost", async () => {
  const root = await realpath(await mkdtemp("/tmp/dac-browser-input-main-"))
  const directory = path.join(root, "managed-browser-input")
  await mkdir(directory, { mode: 0o700 })
  const asset = await prepareManagedBrowserInputAsset({ directory })
  expect(asset).toBeDefined()
  const format = process.env.DAC_BROWSER_INPUT_MAIN_FORMAT === "cjs" ? "cjs" : "esm"
  const entry = format === "cjs" ? "main.cjs" : "main.mjs"
  const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/managed-browser-input-main.ts")],
    outdir: root, target: "node", format, splitting: format === "esm", conditions: ["node"],
    external: ["electron", "jsonc-parser", "@lydell/node-pty"], naming: entry,
    define: { __DAC_MANAGED_BROWSER_INPUT_ASSET__: JSON.stringify(asset) } })
  expect(build.success, build.logs.map(String).join("\n")).toBe(true)
  const compile = Bun.spawn(["/usr/bin/xcrun", "clang++", "-std=c++17", "-bundle", "-undefined", "dynamic_lookup",
    "-fobjc-arc", "-DNAPI_VERSION=8", "-DDAC_QA_SOURCE_MASK_ONLY=1", "-framework", "AppKit", "-I",
    path.resolve(import.meta.dir, "../../native/managed-browser-input/include"),
    path.join(import.meta.dir, "fixture/managed-browser-input-native-qa.mm"), "-o", path.join(root, "qa.node")],
  { stdout: "pipe", stderr: "pipe" })
  const compiled = await Promise.all([compile.exited, new Response(compile.stderr).text()])
  expect({ code: compiled[0], error: compiled[0] === 0 ? null : compiled[1] }).toEqual({ code: 0, error: null })
  await symlink(path.resolve(import.meta.dir, "../../node_modules"), path.join(root, "node_modules"), "dir")
  const child = Bun.spawn([path.resolve(import.meta.dir,
    "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), path.join(root, entry), root],
  { cwd: root, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_DATA_HOME: root,
    XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root }, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 25_000)
  const result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  await Bun.write(path.join(root, "process.log"), result[1] + result[2])
  console.log("MANAGED_BROWSER_INPUT_MAIN_EVIDENCE", root)
  expect({ code: result[0], output: result[0] === 0 ? null : result[1] + result[2] }).toEqual({ code: 0, output: null })
  const facts = await Bun.file(path.join(root, "result.json")).json()
  expect(facts.childExit).toBe(0)
  expect(facts.result).toMatchObject({ otherWindowPreserved: true, ownSourceRetired: true, staleDispatches: 0,
    freshOwnCDPPreserved: true, stopped: true })
  expect(facts.monitors).toEqual({ installed: 2, removed: 2 })
  expect(facts.windows).toBe(0)
  expect(facts.boundary).toEqual({ physicalHuman: false, canonicalRunner: false, provider: 0, clipboard: 0, externalNetwork: 0 })
}, 35_000)
