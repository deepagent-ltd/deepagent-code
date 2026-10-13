import { expect, test } from "bun:test"
import { mkdtemp, realpath, symlink } from "node:fs/promises"
import path from "node:path"
import { compileManagedBrowserInputNative } from "../../scripts/managed-browser-input-native"

test.skipIf(process.platform !== "darwin")("actual Darwin IME source delegates originals, retires replacements and respects shared hook ownership", async () => {
  const fixture = await createFixture()
  for (const scenario of ["source", "foreign", "foreign-env"]) {
    await runFixture(fixture, scenario)
    expect(await Bun.file(path.join(fixture.root, `${scenario}-cleanup.json`)).json()).toEqual(
      scenario === "foreign-env" ? { restored: true, lateDelegated: true } : { restored: true },
    )
  }
  const source = await Bun.file(path.join(fixture.root, "source-result.json")).json()
  expect(source.cdp).toHaveLength(7)
  expect(source.cdp.every((value: { callbacks: number }) => value.callbacks === 0)).toBe(true)
  expect(source.callbacks).toEqual([0, 0, 0])
  expect(source.extraSources).toEqual([1, 1, 1])
  expect(source).toMatchObject({ initialEmptyRejected: true, documentBoundaryRequired: true, multiWatch: true,
    reentrant: true, throwing: true, promiseRejected: true, persistentSubviewRetired: true, weakRootRetired: true,
    classChangeRetired: true, closed: true, liveAtCleanup: true, physicalHuman: false })
  expect(await Bun.file(path.join(fixture.root, "foreign-result.json")).json()).toMatchObject({ ownershipLost: true,
    foreignPreserved: true, tombstoneDelegated: true, taintedRefused: true, callbacks: [] })
  expect(await Bun.file(path.join(fixture.root, "foreign-env-result.json")).json()).toEqual({ liveForeignAtCleanup: true, callbacks: [] })
}, 50_000)

test.skipIf(process.platform !== "darwin")("actual Darwin runtime ABI rejects unqualified versions and keeps qualified IME source separation", async () => {
  const fixture = await createFixture()
  await runFixture(fixture, "pin")
  expect(await Bun.file(path.join(fixture.root, "pin-cleanup.json")).json()).toEqual({ restored: true })
  const result = await Bun.file(path.join(fixture.root, "pin-result.json")).json()
  expect(result).toMatchObject({ runtimeGate: true, sameVersionSource: true, initialEmptyRejected: true,
    documentBoundaryRequired: true, liveAtCleanup: true, physicalHuman: false, runtime: { electron: "41.10.3" } })
  expect(result.cdp).toHaveLength(7)
  expect(result.cdp.every((value: { callbacks: number }) => value.callbacks === 0)).toBe(true)
  expect(result.callbacks).toEqual([0, 0, 0])
}, 30_000)

async function createFixture() {
  const root = await realpath(await mkdtemp("/tmp/dac-browser-input-ime-"))
  const headers = path.resolve(import.meta.dir, "../../native/managed-browser-input/include")
  const asset = await compileManagedBrowserInputNative({ directory: root, headers,
    target: process.arch === "arm64" ? "darwin-arm64" : "darwin-x64" })
  await Bun.write(path.join(root, "asset.json"), JSON.stringify(asset))
  const compile = Bun.spawn(["/usr/bin/xcrun", "clang++", "-std=c++17", "-bundle", "-undefined", "dynamic_lookup",
    "-fobjc-arc", "-DNAPI_VERSION=8", "-framework", "AppKit", "-I", headers,
    path.join(import.meta.dir, "fixture/managed-browser-input-ime-qa.mm"), "-o", path.join(root, "ime-qa.node")],
  { stdout: "pipe", stderr: "pipe" })
  const compiled = await Promise.all([compile.exited, new Response(compile.stderr).text()])
  expect({ code: compiled[0], error: compiled[0] ? compiled[1] : null }).toEqual({ code: 0, error: null })
  const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/managed-browser-input-ime.ts")],
    outdir: root, target: "node", external: ["electron"] })
  expect(build.success).toBe(true)
  await symlink(path.resolve(import.meta.dir, "../../node_modules"), path.join(root, "node_modules"), "dir")
  return { root, entrypoint: build.outputs[0]!.path }
}

async function runFixture(fixture: { root: string; entrypoint: string }, scenario: string) {
    const child = Bun.spawn([path.resolve(import.meta.dir, "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
      fixture.entrypoint, fixture.root, scenario], { cwd: fixture.root,
      env: { PATH: process.env.PATH, HOME: fixture.root, TMPDIR: fixture.root }, stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000)
    const result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(timer)
    await Bun.write(path.join(fixture.root, `${scenario}-process.log`), result[1] + result[2])
    console.log("MANAGED_BROWSER_INPUT_IME_EVIDENCE", fixture.root, scenario)
    expect({ code: result[0], output: result[0] ? result[1] + result[2] : null }).toEqual({ code: 0, output: null })
}
