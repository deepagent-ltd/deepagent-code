#!/usr/bin/env node
// Packaged-app sidecar health smoke: launches the app (Electron binary from
// DEEPAGENT_CODE_DESKTOP_EXECUTABLE, or the dev entry when unset), waits for the
// main process to deliver sidecar credentials, then hits GET /global/health with
// Basic auth and asserts 200 + `healthy: true`. Wired into the desktop-build
// Windows job after packaging.
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { _electron, type ElectronApplication, type Page } from "@playwright/test"

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

// The renderer's awaitInitialization hangs forever when the main process never
// delivers sidecar credentials (e.g. a dead sidecar URL), and page.evaluate has
// no default timeout — so a global watchdog covers it. On expiry the watchdog
// prints the app's main.log tail (where sidecar spawn/health diagnostics land)
// and exits 1 instead of leaving CI hanging until the job limit. The budget must
// exceed the worst-case legal startup: sidecar spawn stall (60s) + local health wait (15s).
const WATCHDOG_TIMEOUT_MS = 180_000

type Server = { url: string; username: string | null; password: string | null }
const readServer = (page: Page) =>
  withWatchdog(
    page.evaluate(
      () => (window as unknown as { api: { awaitInitialization(): Promise<Server> } }).api.awaitInitialization(),
    ),
  )

function withWatchdog<T>(probe: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const watchdog = setTimeout(() => {
      // No reject here: the finally block would delete the log root before the
      // tail is read. The watchdog itself prints and exits with 1.
      void mainLogTail()
        .catch(() => null)
        .then((tail) => {
          if (tail) console.error(`\nmain.log tail:\n${tail}\n`)
          console.error(`renderer awaitInitialization timed out after ${WATCHDOG_TIMEOUT_MS}ms`)
          process.exit(1)
        })
    }, WATCHDOG_TIMEOUT_MS)
    probe.then(
      (value) => {
        clearTimeout(watchdog)
        resolve(value)
      },
      (error) => {
        clearTimeout(watchdog)
        reject(error)
      },
    )
  })
}

async function mainLogTail(): Promise<string | null> {
  const candidates: { path: string; mtime: number }[] = []
  const collect = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        await collect(full)
        continue
      }
      if (entry.name !== "main.log") continue
      const info = await stat(full)
      candidates.push({ path: full, mtime: info.mtimeMs })
    }
  }
  await collect(root)
  const newest = candidates.sort((a, b) => b.mtime - a.mtime)[0]
  if (!newest) return null
  const contents = await readFile(newest.path, "utf8")
  return contents.split("\n").slice(-100).join("\n")
}

let activeApp: ElectronApplication | undefined
try {
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
  const server = await readServer(page)
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
  console.log("sidecar health smoke passed", {
    url: server.url,
    healthy: body.healthy,
    version: body.version,
    startupMs: Math.round(performance.now() - started),
  })
  await app.close()
} finally {
  if (activeApp) await activeApp.close().catch(() => undefined)
  if (process.env.DEEPAGENT_CODE_KEEP_SMOKE === "1") console.error(`sidecar health smoke artifacts retained at ${root}`)
  if (process.env.DEEPAGENT_CODE_KEEP_SMOKE !== "1") await rm(root, { recursive: true, force: true })
}
