#!/usr/bin/env node
// Packaged-app sidecar health smoke: launches the app (Electron binary from
// DEEPAGENT_CODE_DESKTOP_EXECUTABLE, or the dev entry when unset), waits for the
// main process to deliver sidecar credentials, then hits GET /global/health with
// Basic auth and asserts 200 + `healthy: true`. Wired into the desktop-build
// Windows job after packaging.
import { strict as assert } from "node:assert"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test"

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

type Server = { url: string; username: string | null; password: string | null }
const readServer = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { api: { awaitInitialization(): Promise<Server> } }).api.awaitInitialization(),
  )

let activeApp: ElectronApplication | undefined
try {
  const started = performance.now()
  const app = await electron.launch({
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
