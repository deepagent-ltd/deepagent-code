import { expect, test } from "bun:test"
import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises"
import path from "node:path"
import { prepareManagedBrowserInputAsset } from "../../scripts/managed-browser-input-assets"
import { managedBrowserInputRuntime } from "../../scripts/managed-browser-input-runtime"
import { managedBrowserInputFixtureExecutable } from "./fixture/managed-browser-input-runtime"

test.skipIf(process.platform !== "darwin")("actual Main input source retires only its window, denies old refs and releases with NativeHost", async () => {
  const root = await realpath(await mkdtemp("/tmp/dac-browser-input-main-"))
  const directory = path.join(root, "managed-browser-input")
  await mkdir(directory, { mode: 0o700 })
  const asset = await prepareManagedBrowserInputAsset({ directory })
  expect(asset).toBeDefined()
  const format = process.env.DAC_BROWSER_INPUT_MAIN_FORMAT === "cjs" ? "cjs" : "esm"
  const entry = format === "cjs" ? "main.cjs" : "main.mjs"
  const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/managed-browser-input-main.ts")],
    outdir: root, target: "node", format, splitting: format === "esm", conditions: ["node"], sourcemap: "external",
    external: ["electron", "jsonc-parser", "@lydell/node-pty"], naming: entry,
    define: { __DAC_MANAGED_BROWSER_INPUT_ASSET__: JSON.stringify(asset) } })
  expect(build.success, build.logs.map(String).join("\n")).toBe(true)
  const sources = (await Promise.all(build.outputs.filter((output) => output.kind === "sourcemap").map(async (output) => {
    const map = await Bun.file(output.path).json() as { sources: string[]; sourcesContent: (string | null)[] }
    return map.sources.flatMap((source, index) => {
      const content = map.sourcesContent[index]
      if (content === null || content === undefined) return []
      return [{ path: path.resolve(path.dirname(output.path), source),
        sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex") }]
    })
  }))).flat()
  const cohort = await Promise.all([...new Map(sources.map((source) => [source.path, source])).values()].map(async (source) => {
    expect(new Bun.CryptoHasher("sha256").update(await Bun.file(source.path).arrayBuffer()).digest("hex")).toBe(source.sha256)
    return source
  }))
  expect(cohort.some((source) => source.path.endsWith("/src/main/managed-browser-input-observer.ts"))).toBe(true)
  expect(cohort.some((source) => source.path.endsWith("/src/main/managed-browser.ts"))).toBe(true)
  await Bun.write(path.join(root, "source-cohort.json"), JSON.stringify({ sources: cohort,
    outputs: await Promise.all(build.outputs.map(async (output) => ({ path: output.path, kind: output.kind,
      sha256: new Bun.CryptoHasher("sha256").update(await output.arrayBuffer()).digest("hex") }))) }))
  const compile = Bun.spawn(["/usr/bin/xcrun", "clang++", "-std=c++17", "-bundle", "-undefined", "dynamic_lookup",
    "-fobjc-arc", "-DNAPI_VERSION=8", "-DDAC_QA_SOURCE_MASK_ONLY=1", "-framework", "AppKit", "-I",
    path.resolve(import.meta.dir, "../../native/managed-browser-input/include"),
    path.join(import.meta.dir, "fixture/managed-browser-input-native-qa.mm"), "-o", path.join(root, "qa.node")],
  { stdout: "pipe", stderr: "pipe" })
  const compiled = await Promise.all([compile.exited, new Response(compile.stderr).text()])
  expect({ code: compiled[0], error: compiled[0] === 0 ? null : compiled[1] }).toEqual({ code: 0, error: null })
  await symlink(path.resolve(import.meta.dir, "../../node_modules"), path.join(root, "node_modules"), "dir")
  const child = Bun.spawn([managedBrowserInputFixtureExecutable, path.join(root, entry), root],
  { cwd: root, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_DATA_HOME: root,
    XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root }, stdout: "pipe", stderr: "pipe" })
  const timeout = { fired: false }
  const timer = setTimeout(() => { timeout.fired = true; child.kill() }, 25_000)
  const result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  await Bun.write(path.join(root, "process.log"), result[1] + result[2])
  console.log("MANAGED_BROWSER_INPUT_MAIN_EVIDENCE", root)
  const diagnostics = result[0] === 0 ? null : Object.fromEntries(await Promise.all(
    ["main-stages.jsonl", "utility-stages.jsonl", "main-error.json", "utility-error.json", "runtime-paths.json", "result.json"].map(async (name) =>
      [name, await Bun.file(path.join(root, name)).exists() ? await Bun.file(path.join(root, name)).text() : null]),
  ))
  expect({ code: result[0], timedOut: timeout.fired, diagnostics,
    output: result[0] === 0 ? null : result[1] + result[2] }).toEqual({ code: 0, timedOut: false, diagnostics: null, output: null })
  const facts = await Bun.file(path.join(root, "result.json")).json()
  expect(facts.runtimePaths).toEqual({ userData: path.join(root, "profile"), sessionData: path.join(root, "profile") })
  const stages = (await Bun.file(path.join(root, "main-stages.jsonl")).text()).trim().split("\n")
    .map((line) => (JSON.parse(line) as { phase: string }).phase)
  expect(stages.indexOf("other-window-created")).toBeGreaterThanOrEqual(0)
  expect(stages.indexOf("utility-forked")).toBeGreaterThan(stages.indexOf("other-window-created"))
  expect(stages.indexOf("message-listener-installed")).toBeGreaterThan(stages.indexOf("utility-forked"))
  expect(stages.indexOf("bootstrap-ready")).toBeGreaterThan(stages.indexOf("message-listener-installed"))
  expect(stages).toContain("window-shown-offpointer")
  expect(facts.runtime).toMatchObject({
    electron: managedBrowserInputRuntime.electronVersion, node: managedBrowserInputRuntime.nodeVersion,
  })
  expect(facts.defaultProductAsset).toBe(format === "esm")
  expect(facts.childExit).toBe(0)
  expect(facts.result).toMatchObject({ otherWindowResourcePreserved: true, ownSourceRetired: true, staleDispatches: 0,
    freshOwnCDPPreserved: true, stopped: true })
  expect(facts.monitors).toEqual({ installed: 2, removed: 2 })
  expect(facts.windows).toBe(0)
  expect(facts.boundary).toEqual({ physicalHuman: false, canonicalRunner: false, provider: 0, clipboard: 0, externalNetwork: 0 })
}, 35_000)
