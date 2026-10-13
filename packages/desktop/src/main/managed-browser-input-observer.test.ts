import { expect, test } from "bun:test"
import { mkdtemp, realpath, symlink } from "node:fs/promises"
import path from "node:path"
import { compileManagedBrowserInputNative } from "../../scripts/managed-browser-input-native"
import { managedBrowserInputRuntime } from "../../scripts/managed-browser-input-runtime"
import { managedBrowserInputFixtureExecutable } from "./fixture/managed-browser-input-runtime"

test.skipIf(process.platform !== "darwin")("actual Darwin window observer separates CDP, releases reentrantly and cleans the Node environment", async () => {
  const root = await realpath(await mkdtemp("/tmp/dac-browser-input-observer-"))
  const headers = path.resolve(import.meta.dir, "../../native/managed-browser-input/include")
  const asset = await compileManagedBrowserInputNative({ target: process.arch === "arm64" ? "darwin-arm64" : "darwin-x64", headers, directory: root })
  await Bun.write(path.join(root, "asset.json"), JSON.stringify(asset))
  const compile = Bun.spawn(["/usr/bin/xcrun", "clang++", "-std=c++17", "-bundle", "-undefined", "dynamic_lookup",
    "-fobjc-arc", "-DNAPI_VERSION=8", "-framework", "AppKit", "-I", headers,
    path.join(import.meta.dir, "fixture/managed-browser-input-native-qa.mm"), "-o", path.join(root, "qa.node")],
    { stdout: "pipe", stderr: "pipe" })
  expect({ code: await compile.exited, stderr: await new Response(compile.stderr).text() }).toMatchObject({ code: 0 })
  const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/managed-browser-input-observer.ts")],
    outdir: root, target: "node", external: ["electron"] })
  expect(build.success).toBe(true)
  await symlink(path.resolve(import.meta.dir, "../../node_modules"), path.join(root, "node_modules"), "dir")
  const child = Bun.spawn([managedBrowserInputFixtureExecutable, build.outputs[0]!.path, root], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 20_000)
  const result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  await Bun.write(path.join(root, "process.log"), result[1] + result[2])
  console.log("MANAGED_BROWSER_INPUT_OBSERVER_EVIDENCE", root)
  expect({ code: result[0], output: result[0] ? result[1] + result[2] : null }).toEqual({ code: 0, output: null })
  const facts = await Bun.file(path.join(root, "result.json")).json()
  expect(facts.runtime).toMatchObject({
    electron: managedBrowserInputRuntime.electronVersion, node: managedBrowserInputRuntime.nodeVersion,
  })
  expect(facts.facts.ownedCDP).toHaveLength(7)
  expect(facts.facts.ownedCDP.every((entry: { ticks: number }) => entry.ticks === 0)).toBe(true)
  expect(facts.facts.callbacks.length > 0 && facts.facts.callbacks.every((count: number) => count === 0)).toBe(true)
  expect(facts.facts).toMatchObject({ reentrant: true, thrownCallback: true, closedWindow: true, capacity: true, churn: 32 })
  expect(facts.counts.installed - facts.counts.removed).toBe(1)
  const cleanup = await Bun.file(path.join(root, "cleanup.json")).json()
  expect(cleanup.installed).toBe(facts.counts.installed)
  expect(cleanup.removed).toBe(cleanup.installed)
  expect(facts.boundary).toEqual({ physicalHuman: false, globalMonitor: false, clipboard: 0, provider: 0 })
}, 30_000)
