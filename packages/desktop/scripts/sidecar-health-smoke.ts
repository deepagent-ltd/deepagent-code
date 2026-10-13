#!/usr/bin/env node
// Packaged-app sidecar health smoke: launches the app (Electron binary from
// DEEPAGENT_CODE_DESKTOP_EXECUTABLE, or the dev entry when unset), waits for the
// main process to deliver sidecar credentials, then hits GET /global/health with
// Basic auth and asserts 200 + `healthy: true`. Wired into the desktop-build
// Windows job after packaging.
import assert from "node:assert/strict"
import { constants } from "node:fs"
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { _electron, type ElectronApplication } from "@playwright/test"

// The 150s budget still includes launch/window readiness and leaves 30s for
// owned shutdown. Every failure uses the same closed diagnostics after close.
const WATCHDOG_TIMEOUT_MS = 150_000
type Server = { url: string; username: string | null; password: string | null }

function withWatchdog<T>(probe: Promise<T>, observedStarted: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const watchdog = setTimeout(
      () => reject(new Error(`renderer initialization exceeded the total ${WATCHDOG_TIMEOUT_MS}ms observation budget`)),
      Math.max(1, WATCHDOG_TIMEOUT_MS - (performance.now() - observedStarted)),
    )
    probe.then(
      (value) => { clearTimeout(watchdog); resolve(value) },
      (error) => { clearTimeout(watchdog); reject(error) },
    )
  })
}

/** Preserve the original failure and normal app shutdown before reading logs;
 * otherwise a fast sidecar exit loses its stderr when the private root goes. */
export async function withSidecarSmokeCleanup<T>(input: {
  root: string
  run(): Promise<T>
  close(): Promise<unknown>
  report(diagnostics: readonly Record<string, string | number | null>[]): void
  keep?: boolean
}) {
  const state = { failed: false }
  try {
    return await input.run()
  } catch (error) {
    state.failed = true
    throw error
  } finally {
    await Promise.resolve().then(input.close).catch(() => undefined)
    if (state.failed) {
      const diagnostics = await readSidecarSmokeDiagnostics(input.root)
        .catch(() => [{ kind: "diagnostic-unavailable" }])
      await Promise.resolve().then(() => input.report(diagnostics)).catch(() => undefined)
    }
    if (!input.keep) await rm(input.root, { recursive: true, force: true })
  }
}

/** Three fixed log names from the original test-home Desktop storage only.
 * Emit parsed fields, never arbitrary log lines, environment or full paths. */
export async function readSidecarSmokeDiagnostics(root: string) {
  if (resolve(root) !== root || await realpath(root) !== root || !(await lstat(root)).isDirectory())
    throw new Error("SMOKE_DIAGNOSTIC_ROOT_REJECTED")
  const candidates: { directory: string; stamp: string }[] = []
  for (const appID of ["ai.deepagent-code.desktop.dev", "ai.deepagent-code.desktop.beta", "ai.deepagent-code.desktop"]) {
    const parts = [".deepagent", "code", "desktop", appID, "logs"]
    const exists = await physicalDirectories(root, parts)
    if (!exists) continue
    const directory = join(root, ...parts)
    const entries = await readdir(directory)
    if (entries.length > 16) throw new Error("SMOKE_DIAGNOSTIC_DIRECTORY_BOUND")
    const stamp = entries.filter((name) => /^\d{8}T\d{6}$/.test(name)).sort().at(-1)
    if (!stamp) continue
    await physicalDirectories(directory, [stamp])
    candidates.push({ directory: join(directory, stamp), stamp })
  }
  const selected = candidates.sort((left, right) => right.stamp.localeCompare(left.stamp))[0]
  if (!selected) return []
  const diagnostics: Record<string, string | number | null>[] = []
  for (const log of ["main.log", "server.log", "utility.log"]) {
    const filename = join(selected.directory, log)
    const named = await lstat(filename, { bigint: true }).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
      throw new Error("SMOKE_DIAGNOSTIC_FILE_REJECTED")
    })
    if (!named) continue
    if (!named.isFile() || named.nlink !== 1n || named.size > 262_144n || await realpath(filename) !== filename)
      throw new Error("SMOKE_DIAGNOSTIC_FILE_REJECTED")
    const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const held = await file.stat({ bigint: true })
      const buffer = Buffer.alloc(262_145)
      const read = await file.read(buffer, 0, buffer.length, 0)
      const after = await file.stat({ bigint: true })
      const current = await lstat(filename, { bigint: true })
      if (read.bytesRead !== Number(named.size) || !held.isFile() || !current.isFile() ||
        [held, after, current].some((info) => info.nlink !== 1n ||
          (["dev", "ino", "size", "mtimeMs"] as const).some((key) => info[key] !== named[key])) ||
        await realpath(filename) !== filename || await realpath(root) !== root)
        throw new Error("SMOKE_DIAGNOSTIC_FILE_CHANGED")
      for (const line of buffer.subarray(0, read.bytesRead).toString("utf8").split("\n").slice(-100)) {
        if (line.length > 2048) continue
        const native = line.match(/dac-native-path-lease:(ancestor_name|leaf_name|disk|singlelink):([A-Za-z]{1,40}):(None|Some\([0-9]{1,10}\))/)
        const first = line.match(/dac-native-first-load:(system-root-lease|system-root-dacl|module-lease|module-dacl|module-private-dacl|original-current):([A-Za-z0-9_.-]{1,128}):([A-Za-z]{1,40}):(None|Some\([0-9]{1,10}\))/)
        const kinds = ["NotFound", "PermissionDenied", "AlreadyExists", "InvalidInput", "InvalidData", "Unsupported", "UnexpectedEof", "Interrupted", "Other", "Uncategorized", "WouldBlock", "TimedOut"]
        if (native && kinds.includes(native[2]!)) diagnostics.push({ log, kind: "native-path-lease", stage: native[1]!, errorClass: native[2]!, errno: native[3] === "None" ? null : Number(native[3]!.slice(5, -1)) })
        if (first && kinds.includes(first[3]!)) diagnostics.push({ log, kind: "native-first-load", stage: first[1]!, basename: first[2]!, errorClass: first[3]!, errno: first[4] === "None" ? null : Number(first[4]!.slice(5, -1)) })
        const bootstrap = line.match(/Windows native sidecar bootstrap unavailable \((parent-current|runtime-preparation|parent-lifetime|child-exited|child-challenge|challenge-timeout|native-transfer|native-entry|receipt-timeout|duplicate-prepare|original-entry|capture|receipt-shape|receipt-current|receipt-native)\)/)
        if (bootstrap) diagnostics.push({ log, kind: "sidecar-bootstrap", stage: bootstrap[1]! })
        for (const identifier of ["WINDOWS_FIRST_LOADER_UNAVAILABLE", "WINDOWS_FIRST_LOADER_CHANGED", "MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED", "Original Windows native image capture is unavailable", "Original Windows native bootstrap is unavailable", "Original Windows native bootstrap changed", "Sidecar parent port unavailable"])
          if (line.includes(identifier)) diagnostics.push({ log, kind: "fixed-error", identifier })
        const errorClass = line.match(/\b(Error|TypeError|SyntaxError|ReferenceError|RangeError|EvalError|URIError|AggregateError):/)
        if (errorClass) diagnostics.push({ log, kind: "error-class", errorClass: errorClass[1]! })
        const exit = line.match(/Sidecar exited before ready with code (-?[0-9]{1,3})/)
        if (exit) diagnostics.push({ log, kind: "exit", exitCode: Number(exit[1]) })
        const module = line.match(/Cannot find module ['"][^'"\r\n]*?([^/\\'"\r\n]+)['"]/)
        if (module && ["native-image-factory.node", "node.js", "sidecar.js"].includes(module[1]!))
          diagnostics.push({ log, kind: "module", basename: module[1]! })
        const frame = line.match(/\bat ([\w.$<>]{1,80}) \([^()\r\n]*?([^/\\():]+\.(?:js|ts|node)):([0-9]{1,7}):([0-9]{1,7})\)/)
        if (frame && ["start", "capture", "getParentPort", "receiveWindowsNativeSidecar", "prepareWindowsNativeSidecar", "Object.<anonymous>", "Module._compile", "Module._load", "Module.load", "Module.require", "require", "processTicksAndRejections"].includes(frame[1]!) &&
          (["index.js", "index.ts", "server.ts", "sidecar.js", "sidecar.ts", "node.js", "native-image-factory.node"].includes(frame[2]!) || /^index-[A-Za-z0-9_-]{1,12}\.js$/.test(frame[2]!)))
          diagnostics.push({ log, kind: "stack", function: frame[1]!, basename: frame[2]!, line: Number(frame[3]), column: Number(frame[4]) })
        if (diagnostics.length > 64) throw new Error("SMOKE_DIAGNOSTIC_RECORD_BOUND")
      }
    } finally { await file.close() }
  }
  return diagnostics.filter((value, index) => diagnostics.findIndex((previous) => JSON.stringify(previous) === JSON.stringify(value)) === index)
}

async function physicalDirectories(root: string, parts: readonly string[]) {
  for (const [index] of parts.entries()) {
    const filename = join(root, ...parts.slice(0, index + 1))
    const info = await lstat(filename).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
      throw new Error("SMOKE_DIAGNOSTIC_DIRECTORY_REJECTED")
    })
    if (!info) return false
    if (!info.isDirectory() || await realpath(filename) !== filename)
      throw new Error("SMOKE_DIAGNOSTIC_DIRECTORY_REJECTED")
  }
  return true
}

async function main() {
  const observedStarted = performance.now()
  const root = await realpath(await mkdtemp(join(tmpdir(), "deepagent-code-sidecar-health-")))
  // Fixed port so CI logs/asserts are deterministic (defaults to the port the
  // workflow sets via DEEPAGENT_CODE_SMOKE_PORT).
  const port = process.env.DEEPAGENT_CODE_SMOKE_PORT ?? "3188"
  const packagedExecutable = process.env.DEEPAGENT_CODE_DESKTOP_EXECUTABLE
  const main = resolve("out/main/index.js")

  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  env.DEEPAGENT_CODE_TEST_ONBOARDING = "1"
  env.DEEPAGENT_CODE_TEST_ROOT = root
  env.DEEPAGENT_CODE_PORT = port
  env.HOME = join(root, "home")
  env.XDG_DATA_HOME = join(root, "data")
  env.XDG_CONFIG_HOME = join(root, "config")
  env.XDG_CACHE_HOME = join(root, "cache")
  env.XDG_STATE_HOME = join(root, "state")
  env.DEEPAGENT_CODE_DB = join(root, "deepagent.sqlite")
  env.DEEPAGENT_CODE_DISABLE_CHANNEL_DB = "1"
  await Promise.all(
    [env.HOME, env.XDG_DATA_HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  )
  let activeApp: ElectronApplication | undefined
  await withSidecarSmokeCleanup({
    root,
    keep: process.env.DEEPAGENT_CODE_KEEP_SMOKE === "1",
    close: async () => { if (activeApp) await activeApp.close() },
    report: (diagnostics) => console.error("sidecar smoke closed diagnostics", JSON.stringify(diagnostics)),
    run: async () => {
      const started = performance.now()
      const app = await _electron.launch({
        args: packagedExecutable ? [] : [main],
        ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
        env,
        timeout: 30_000,
      })
      activeApp = app
      const page = await app.firstWindow({ timeout: 30_000 })
      await page.waitForFunction(
        () => Boolean((window as unknown as { api?: unknown }).api),
        undefined,
        { timeout: 30_000 },
      )
      const server = await withWatchdog(
        page.evaluate(
          () => (window as unknown as { api: { awaitInitialization(): Promise<Server> } }).api.awaitInitialization(),
        ),
        observedStarted,
      )
      assert.equal(new URL(server.url).port, port, `sidecar expected on port ${port}, got ${server.url}`)

      const headers = new Headers()
      if (server.password) {
        headers.set("authorization", `Basic ${Buffer.from(`${server.username}:${server.password}`).toString("base64")}`)
      }
      const response = await fetch(new URL("/global/health", server.url), {
        headers,
        signal: AbortSignal.timeout(10_000),
      })
      assert.equal(response.status, 200, `health endpoint responded ${response.status}`)
      const body = (await response.json()) as { healthy?: boolean; version?: string }
      assert.equal(body.healthy, true, `health endpoint body: ${JSON.stringify(body)}`)
      if (process.env.DEEPAGENT_CODE_VERSION) assert.equal(body.version, process.env.DEEPAGENT_CODE_VERSION)
      console.log("sidecar health smoke passed", {
        url: server.url,
        healthy: body.healthy,
        version: body.version,
        startupMs: Math.round(performance.now() - started),
      })
      await app.close()
    },
  }).finally(() => {
    if (process.env.DEEPAGENT_CODE_KEEP_SMOKE === "1") console.error(`sidecar health smoke artifacts retained at ${root}`)
  })

}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
