import { expect, test } from "bun:test"
import { mkdtemp, realpath, symlink } from "node:fs/promises"
import path from "node:path"
import { compileManagedBrowserInputNative } from "../../scripts/managed-browser-input-native"
import { managedBrowserInputRuntime } from "../../scripts/managed-browser-input-runtime"
import { managedBrowserInputFixtureExecutable } from "./fixture/managed-browser-input-runtime"

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
    documentBoundaryRequired: true, liveAtCleanup: true, physicalHuman: false,
    runtime: { electron: managedBrowserInputRuntime.electronVersion, node: managedBrowserInputRuntime.nodeVersion } })
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
    const child = Bun.spawn([managedBrowserInputFixtureExecutable,
      fixture.entrypoint, fixture.root, scenario], { cwd: fixture.root,
      env: { PATH: process.env.PATH, HOME: fixture.root, TMPDIR: fixture.root, DAC_MANAGED_BROWSER_INPUT_DIAGNOSTICS: "1" }, stdout: "pipe", stderr: "pipe" })
    const startedAt = Date.now()
    const deadline = { expired: false }
    const timer = setTimeout(() => { deadline.expired = true; child.kill("SIGKILL") }, 20_000)
    const result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(timer)
    await Bun.write(path.join(fixture.root, `${scenario}-process.log`), result[1] + result[2])
    console.log("MANAGED_BROWSER_INPUT_IME_EVIDENCE", fixture.root, scenario)
    if (result[0] !== 0) {
      const failureFile = Bun.file(path.join(fixture.root, `${scenario}-failure.json`))
      const failure: unknown = await failureFile.exists() && failureFile.size <= 32768 ? await failureFile.json().catch(() => null) : null
      const bounded = (value: unknown, limit: number) => typeof value === "string"
        ? value.replaceAll(fixture.root, "<owned-root>").replace(/data:[^\s"'<>]+/g, "data:<redacted>").slice(0, limit) : undefined
      const error = failure && typeof failure === "object" ? failure as Record<string, unknown> : undefined
      const stagesFile = Bun.file(path.join(fixture.root, "stages.log"))
      const stages = await stagesFile.exists() ? (await stagesFile.text()).slice(-4096).split("\n").filter((line) => /^[a-z0-9:-]{1,80}$/.test(line)).slice(-24) : []
      const sourceFile = Bun.file(path.join(fixture.root, `${scenario}-source.json`))
      const source: unknown = await sourceFile.exists() && sourceFile.size <= 16_384 ? await sourceFile.json().catch(() => null) : null
      const observation = source && typeof source === "object" ? source as Record<string, unknown> : undefined
      const timing = (value: Record<string, unknown>) => typeof value.at === "number" && Number.isFinite(value.at) &&
        typeof value.wallAt === "number" && Number.isFinite(value.wallAt)
      const cdp = Array.isArray(observation?.cdp) ? observation.cdp.slice(-7).flatMap((entry: unknown) => {
        if (!entry || typeof entry !== "object") return []
        const value = entry as Record<string, unknown>
        return ["Input.insertText", "Input.dispatchKeyEvent", "Input.dispatchMouseEvent"].includes(String(value.method)) &&
          Number.isInteger(value.callbacks) && Number(value.callbacks) >= 0 && Number(value.callbacks) <= 32 && timing(value)
          ? [{ method: value.method, callbacks: value.callbacks, at: value.at, wallAt: value.wallAt }] : []
      }) : []
      const callbacks = Array.isArray(observation?.callbacks) ? observation.callbacks.slice(-32).flatMap((entry: unknown) => {
        if (!entry || typeof entry !== "object") return []
        const value = entry as Record<string, unknown>
        return Number.isInteger(value.ordinal) && Number(value.ordinal) > 0 && Number(value.ordinal) <= 32 && timing(value)
          ? [{ ordinal: value.ordinal, at: value.at, wallAt: value.wallAt }] : []
      }) : []
      console.error("MANAGED_BROWSER_INPUT_IME_FAILURE", JSON.stringify({ scenario, code: result[0], exitSignal: child.signalCode,
        deadlineExpired: deadline.expired, elapsedMs: Date.now() - startedAt, stages, cdp, callbacks,
        failure: error ? { name: bounded(error.name, 80), message: bounded(error.message, 512), stack: bounded(error.stack, 4096) } : null }))
    }
    expect({ code: result[0], output: result[0] ? result[1] + result[2] : null }).toEqual({ code: 0, output: null })
}
