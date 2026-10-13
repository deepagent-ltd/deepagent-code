export * as BrowserUnavailableProduct from "./browser-unavailable-product"

import { chromium } from "@playwright/test"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:net"
import { Schema } from "effect"

export const Descriptor = Schema.Struct({
  version: Schema.Literal(1),
  url: Schema.String.check(Schema.makeFilter((value: string) => /^http:\/\/127\.0\.0\.1:[0-9]+$/.test(value))),
  directory: Schema.String.check(Schema.makeFilter((value: string) => value.startsWith("/"))),
  sessionID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  authorizationFile: Schema.String,
  output: Schema.String,
  deadlineAt: Schema.Int,
})

export async function descriptor(file: string) {
  const input = Schema.decodeUnknownSync(Descriptor)(await Bun.file(file).json())
  const authorization = await fs.readFile(input.authorizationFile, "utf8")
  if (!/^Basic [A-Za-z0-9+/]+=*$/.test(authorization)) throw new Error("Private canonical Basic credential required")
  return { ...input, authorization }
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Own loopback port was not allocated")
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function stop(child: ReturnType<typeof Bun.spawn>) {
  if (child.exitCode !== null) return { natural: true, code: child.exitCode }
  child.kill("SIGTERM")
  const result = await exitWithin(child, 8000)
  if (result !== undefined) return { natural: true, code: result }
  child.kill("SIGKILL")
  return { natural: false, code: await child.exited }
}

async function exitWithin(child: ReturnType<typeof Bun.spawn>, duration: number) {
  const state = { timer: undefined as ReturnType<typeof setTimeout> | undefined }
  return Promise.race([child.exited, new Promise<undefined>((resolve) => {
    state.timer = setTimeout(() => resolve(undefined), duration)
  })]).finally(() => { if (state.timer) clearTimeout(state.timer) })
}

export async function run(mode: "both" | "gui" | "tui" = "both") {
  const root = await fs.mkdtemp("/tmp/dac-browser-unavailable-product-")
  await fs.chmod(root, 0o700)
  const workspace = path.join(root, "workspace")
  const home = path.join(root, "home")
  await fs.mkdir(workspace, { mode: 0o700 })
  await fs.mkdir(home, { mode: 0o700 })
  const ports = { root: await freePort(), app: await freePort() }
  const origin = `http://127.0.0.1:${ports.app}`
  const url = `http://127.0.0.1:${ports.root}`
  const password = randomUUID()
  const authorization = `Basic ${Buffer.from(`deepagent-code:${password}`).toString("base64")}`
  const authorizationFile = path.join(root, "authorization")
  await fs.writeFile(authorizationFile, authorization, { mode: 0o600 })
  const dbFile = path.join(home, ".deepagent/code/deepagent.sqlite")
  const repo = path.resolve(import.meta.dir, "../../../..")
  const logs = await Promise.all(["root", "vite", "tui"].map((name) => fs.open(path.join(root, `${name}-private.log`), "wx", 0o600)))
  const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"),
    XDG_CACHE_HOME: path.join(home, "cache"), XDG_STATE_HOME: path.join(home, "state"),
    DEEPAGENT_CODE_TEST_HOME: home, DEEPAGENT_CODE_DB: dbFile, DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
    DEEPAGENT_ENABLED: "false", DEEPAGENT_IM_AGENT_RESPONDER: "off" }
  const server = Bun.spawn([process.execPath, path.join(repo, "packages/deepagent-code/src/index.ts"),
    "serve", "--hostname", "127.0.0.1", "--port", String(ports.root), "--cors", origin], {
    cwd: workspace, env: { ...environment, DEEPAGENT_CODE_SERVER_USERNAME: "deepagent-code", DEEPAGENT_CODE_SERVER_PASSWORD: password },
    stdin: "ignore", stdout: logs[0].fd, stderr: logs[0].fd,
  })
  const state = { phase: "root_readiness", appRequests: 0, appResponses: 0, exactRetry: false,
    unavailableVisible: false, useDisabled: false, closed: false, composerUnchanged: false,
    actualWheel: false, errorViewportVisible: false,
    authQueryRemoved: false, executionRequests: 0, tuiExit: undefined as number | undefined,
    serverExit: undefined as Awaited<ReturnType<typeof stop>> | undefined,
    viteExit: undefined as Awaited<ReturnType<typeof stop>> | undefined,
    databaseCounts: {} as Record<string, number>, browserClosed: false, portsClosed: false }
  const resources = { vite: undefined as ReturnType<typeof Bun.spawn> | undefined,
    tui: undefined as ReturnType<typeof Bun.spawn> | undefined,
    browser: undefined as Awaited<ReturnType<typeof chromium.launch>> | undefined,
    page: undefined as Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>> | undefined }
  const requests: string[] = []
  const responses: { status: number; code: string }[] = []
  const started = Date.now()
  try {
    const readiness = Date.now() + 60_000
    while (Date.now() < readiness) {
      if (server.exitCode !== null) throw new Error("Original CLI serve exited during readiness")
      if (await fetch(`${url}/global/health`, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(500) })
        .then((response) => response.ok).catch(() => false)) break
      await Bun.sleep(100)
    }
    if (Date.now() >= readiness) throw new Error("Original Root readiness deadline exceeded")
    const client = createDeepAgentCodeClient({ baseUrl: url, headers: { Authorization: authorization } })
    const session = (await client.v2.session.create({ location: { directory: workspace } }, { throwOnError: true })).data.data
    await fs.writeFile(path.join(root, "descriptor-private.json"), JSON.stringify({ version: 1, url, directory: workspace,
      sessionID: session.id, authorizationFile, output: root, deadlineAt: Date.now() + 150_000 }), { mode: 0o600 })
    if (mode !== "tui") {
    state.phase = "original_app"
    resources.vite = Bun.spawn([process.execPath, "run", "dev", "--", "--host", "127.0.0.1", "--port", String(ports.app), "--strictPort"], {
      cwd: path.join(repo, "packages/app"), env: { ...environment,
        VITE_DEEPAGENT_CODE_SERVER_HOST: "127.0.0.1", VITE_DEEPAGENT_CODE_SERVER_PORT: String(ports.root) },
      stdin: "ignore", stdout: logs[1].fd, stderr: logs[1].fd,
    })
    const viteDeadline = Date.now() + 30_000
    while (Date.now() < viteDeadline) {
      if (resources.vite.exitCode !== null) throw new Error("Original Vite exited during readiness")
      if (await fetch(origin, { signal: AbortSignal.timeout(500) }).then((response) => response.ok).catch(() => false)) break
      await Bun.sleep(100)
    }
    if (Date.now() >= viteDeadline) throw new Error("Original App readiness deadline exceeded")
    resources.browser = await chromium.launch({ headless: true })
    const context = await resources.browser.newContext({ locale: "en-US", viewport: { width: 1000, height: 680 } })
    const page = await context.newPage()
    resources.page = page
    page.setDefaultTimeout(15_000)
    page.on("request", (request) => {
      if (new URL(request.url()).origin !== url || request.method() !== "POST") return
      if (/\/(?:prompt|resume|execute)$/.test(new URL(request.url()).pathname)) state.executionRequests++
      if (new URL(request.url()).pathname !== "/api/v1/browser/controls") return
      requests.push(request.postData() ?? "")
      state.appRequests++
    })
    page.on("response", async (response) => {
      if (new URL(response.url()).origin !== url || new URL(response.url()).pathname !== "/api/v1/browser/controls" || response.request().method() !== "POST") return
      const value: unknown = await response.json()
      const code = value && typeof value === "object" && "code" in value && typeof value.code === "string" ? value.code : ""
      responses.push({ status: response.status(), code })
      state.appResponses++
    })
    await page.goto(`${origin}/${Buffer.from(workspace).toString("base64url")}/session/${session.id}?auth_token=${encodeURIComponent(authorization.slice(6))}`)
    await page.waitForFunction(() => !new URL(location.href).searchParams.has("auth_token"))
    state.authQueryRemoved = true
    const composer = page.locator('[contenteditable="true"][data-component="prompt-input"]')
    await composer.waitFor({ state: "visible" })
    const before = await composer.textContent()
    const mac = await page.evaluate(() => /(Mac|iPod|iPhone|iPad)/.test(navigator.platform))
    await page.keyboard.press(mac ? "Meta+Shift+P" : "Control+Shift+P")
    await page.getByPlaceholder("Search files, commands, and sessions").fill("Connect an agent browser")
    await page.locator('[data-slot="list-item"][data-key="command:browser.connect"]').click()
    await page.getByRole("button", { name: "Approve and connect", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "Not currently available; check the current state" }).waitFor()
    state.useDisabled = await page.getByRole("button", { name: "Add browser reference to draft", exact: true }).isDisabled()
    await page.getByRole("button", { name: "Retry the same connection request", exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent?.includes("Not currently available; check the current state"))
    const responseDeadline = Date.now() + 5000
    while (responses.length < 2 && Date.now() < responseDeadline) await Bun.sleep(20)
    state.exactRetry = requests.length === 2 && requests[0] === requests[1]
    if (!state.exactRetry || responses.length !== 2 || responses.some((item) => item.status !== 503 || item.code !== "BROWSER_HOST_UNAVAILABLE") || !state.useDisabled)
      throw new Error("Original browser unavailable/retry boundary failed")
    const scroll = page.locator('[data-slot="dialog-body"] > div').first()
    const bounds = await scroll.boundingBox()
    if (!bounds) throw new Error("Original browser approval scroller is absent")
    await page.mouse.move(bounds.x + bounds.width - 5, bounds.y + Math.min(120, bounds.height - 5))
    await page.mouse.wheel(0, 1000)
    state.actualWheel = true
    await page.waitForFunction(() => {
      const alert = document.querySelector('[role="alert"]')
      if (!(alert instanceof HTMLElement)) return false
      const rect = alert.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0 || rect.top < 0 || rect.bottom > innerHeight) return false
      for (let parent = alert.parentElement; parent; parent = parent.parentElement) {
        if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) continue
        const clip = parent.getBoundingClientRect()
        if (rect.top < clip.top || rect.bottom > clip.bottom) return false
      }
      return true
    })
    state.errorViewportVisible = true
    state.unavailableVisible = true
    await page.screenshot({ path: path.join(root, "app-unavailable.png") })
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "Approve and connect", exact: true }).waitFor({ state: "hidden" })
    state.closed = true
    state.composerUnchanged = await composer.textContent() === before
    if (!state.composerUnchanged || state.executionRequests) throw new Error("Closing browser approval unexpectedly handed off execution")
    }
    if (mode !== "gui") {
    state.phase = "original_tui"
    resources.tui = Bun.spawn([process.execPath, path.join(repo, "packages/tui/test/fixture/browser-unavailable-product.tsx"), path.join(root, "descriptor-private.json")], {
      cwd: path.join(repo, "packages/tui"), env: environment, stdin: "ignore", stdout: logs[2].fd, stderr: logs[2].fd,
    })
    const result = await exitWithin(resources.tui, 75_000)
    if (result === undefined) throw new Error("Original TUI product window exceeded its deadline")
    state.tuiExit = result
    if (result !== 0) throw new Error("Original TUI product boundary failed")
    }
    state.phase = "complete"
  } catch (error) {
    if (resources.page) await resources.page.screenshot({ path: path.join(root, "app-failure.png") }).catch(() => undefined)
    await fs.writeFile(path.join(root, "driver-error-private.log"), error instanceof Error ? error.stack ?? error.message : "Unclassified fixture failure", { mode: 0o600 })
    throw error
  } finally {
    if (resources.browser) { await resources.browser.close(); state.browserClosed = true }
    if (resources.tui && resources.tui.exitCode === null) await stop(resources.tui)
    if (resources.vite) state.viteExit = await stop(resources.vite)
    state.serverExit = await stop(server)
    if (await Bun.file(dbFile).exists()) {
      const database = new Database(dbFile, { readonly: true })
      try {
        for (const table of ["session_input", "session_v2_provider_turn_receipt", "session_v2_tool_effect_admission", "browser_control", "browser_action"])
          state.databaseCounts[table] = (database.query(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count
      } finally { database.close() }
    }
    state.portsClosed = (await Promise.all([url, origin].map((endpoint) => fetch(endpoint, { signal: AbortSignal.timeout(500) }).then(() => false).catch(() => true)))).every(Boolean)
    await fs.writeFile(path.join(root, "safe-observation.json"), JSON.stringify({ version: 1, ...state, elapsedMs: Date.now() - started,
      actualRoot: true, nativeFactory: "unavailable", mode, actualApp: resources.browser !== undefined, tuiScope: "original OpenTUI component, not complete CLI/PTY",
      responses, requestHash: requests[0] ? createHash("sha256").update("dac.browser.approval.v1\0").update(requests[0]).digest("hex") : "",
      limits: ["No Native action/tool/permission evidence", "No provider or prompt", "No tabs/history/DOM action verification"] }, null, 2), { mode: 0o600 })
    await Promise.all(logs.map((log) => log.close()))
    console.log(JSON.stringify({ root, phase: state.phase, requests: state.appRequests, responses: state.appResponses, portsClosed: state.portsClosed }))
    if (state.phase === "complete" && Object.values(state.databaseCounts).some((count) => count !== 0))
      throw new Error("Read-only browser product window unexpectedly admitted execution")
  }
}

if (import.meta.main) {
  if (process.argv[2] === "--dry") console.log(JSON.stringify({ dry: true, originalCLI: "serve", originalApp: "dev",
    native: "unavailable", provider: 0, immutableRetry: true, privateResources: true }))
  if (process.argv[2] !== "--dry") await run(process.argv[2] === "--gui" ? "gui" : process.argv[2] === "--tui" ? "tui" : "both")
    .catch(() => { console.error("BROWSER_PRODUCT_BOUNDARY_FAILED; inspect private observation"); process.exitCode = 1 })
}
