export * as BrowserCanonicalProduct from "./browser-canonical-product"

import { chromium } from "@playwright/test"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { BrowserClientWindow } from "./browser-client-window-descriptor"
import fs from "node:fs/promises"
import path from "node:path"

export async function run(descriptor: string, dry = false) {
  const { input, authorization } = await BrowserClientWindow.read(descriptor, !dry)
  if (dry) { console.log(JSON.stringify({ dry: true, nativeWindowStarted: false, HTTP: false, promptCalls: 0 })); return }
  const client = createDeepAgentCodeClient({ baseUrl: input.rootURL, headers: { Authorization: authorization } })
  const providers = (await client.provider.list({ directory: input.directory }, { throwOnError: true })).data
  if (!providers.connected.includes(input.model.providerID) ||
      !providers.all.some((provider) => provider.id === input.model.providerID && provider.models[input.model.modelID]))
    throw new Error("Original client picker does not expose the configured controlled model")
  const appURL = new URL(input.appOrigin)
  const rootURL = new URL(input.rootURL)
  const directory = path.join(input.output, "client-app-private")
  await fs.mkdir(directory, { mode: 0o700 })
  const log = await fs.open(path.join(directory, "vite-private.log"), "wx", 0o600)
  const vite = Bun.spawn([process.execPath, "run", "dev", "--", "--host", "127.0.0.1", "--port", appURL.port, "--strictPort"], {
    cwd: path.resolve(import.meta.dir, "../.."), env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: directory,
      XDG_DATA_HOME: path.join(directory, "data"), XDG_CONFIG_HOME: path.join(directory, "config"),
      XDG_CACHE_HOME: path.join(directory, "cache"), VITE_DEEPAGENT_CODE_SERVER_HOST: rootURL.hostname,
      VITE_DEEPAGENT_CODE_SERVER_PORT: rootURL.port }, stdin: "ignore", stdout: log.fd, stderr: log.fd,
  })
  const state = { phase: "app_readiness", createCalls: 0, promptCalls: 0, permissionReplies: 0,
    nativeVerified: false, beforeUseInputUnchanged: false, explicitUseComposer: false,
    userCompletionVisible: false, stopConfirmed: false, windowClosed: false, viteExited: false }
  const resources = { browser: undefined as Awaited<ReturnType<typeof chromium.launch>> | undefined,
    page: undefined as Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>> | undefined }
  const actualUntil = Math.min(input.deadlineAt, Date.now() + 100_000)
  const control = { id: "" }
  try {
    const readyUntil = Math.min(actualUntil, Date.now() + 30_000)
    while (Date.now() < readyUntil) {
      if (vite.exitCode !== null) throw new Error("Original Vite exited before readiness")
      if (await fetch(input.appOrigin, { signal: AbortSignal.timeout(500) }).then((response) => response.ok).catch(() => false)) break
      await Bun.sleep(100)
    }
    if (Date.now() >= readyUntil) throw new Error("Original App readiness deadline exceeded")
    if (!process.env.DAC_BROWSER_CLIENT_CHROMIUM || !(await fs.stat(process.env.DAC_BROWSER_CLIENT_CHROMIUM)).isFile())
      throw new Error("Original cached Chromium executable must be explicit before starting the private client")
    resources.browser = await chromium.launch({ headless: true, executablePath: process.env.DAC_BROWSER_CLIENT_CHROMIUM })
    const context = await resources.browser.newContext({ locale: "en-US", viewport: { width: 1200, height: 900 } })
    const page = await context.newPage()
    resources.page = page
    page.setDefaultTimeout(10_000)
    page.on("request", (request) => {
      if (new URL(request.url()).origin !== input.rootURL || request.method() !== "POST") return
      const pathname = new URL(request.url()).pathname
      if (pathname === "/api/v1/browser/controls") state.createCalls++
      if (pathname === `/api/session/${input.sessions.gui}/prompt`) state.promptCalls++
      if (pathname.endsWith("/reply") && pathname.includes("/permission/")) state.permissionReplies++
    })
    page.on("response", async (response) => {
      if (new URL(response.url()).origin !== input.rootURL || new URL(response.url()).pathname !== "/api/v1/browser/controls" || response.request().method() !== "POST") return
      if (!response.ok()) return
      const value: unknown = await response.json()
      if (value && typeof value === "object" && "nativeVerification" in value && value.nativeVerification === "verified" &&
          "control" in value && value.control && typeof value.control === "object" && "controlID" in value.control &&
          typeof value.control.controlID === "string") { control.id = value.control.controlID; state.nativeVerified = true }
    })
    await page.goto(`${input.appOrigin}/${Buffer.from(input.directory).toString("base64url")}/session/${input.sessions.gui}?auth_token=${encodeURIComponent(authorization.slice(6))}`)
    await page.waitForFunction(() => !new URL(location.href).searchParams.has("auth_token"))
    const composer = page.locator('[contenteditable="true"][data-component="prompt-input"]')
    await composer.waitFor()
    const before = await composer.textContent()
    const mac = await page.evaluate(() => /(Mac|iPod|iPhone|iPad)/.test(navigator.platform))
    await page.keyboard.press(mac ? "Meta+Shift+P" : "Control+Shift+P")
    await page.getByPlaceholder("Search files, commands, and sessions").fill("Connect an agent browser")
    await page.locator('[data-slot="list-item"][data-key="command:browser.connect"]').click()
    await page.getByLabel("Local project origin", { exact: true }).fill(input.pageOrigin)
    await page.getByLabel("Allowed POST paths", { exact: true }).fill(input.postPath)
    const programMode = page.getByRole("group", { name: "Page program mode" }).getByRole("button")
    await programMode.click()
    await page.getByRole("option", { name: "Bounded page changes", exact: true }).click()
    for (const name of ["Select options", "Click"]) {
      await page.locator('[data-slot="checkbox-checkbox-label"]').filter({ hasText: new RegExp(`^${name}$`) }).click()
      if (!await page.getByRole("checkbox", { name, exact: true }).isChecked())
        throw new Error("Original visible operation checkbox did not select")
    }
    await page.getByLabel("Maximum steps (1–16)", { exact: true }).fill("3")
    await page.getByLabel("Page validation code", { exact: true }).fill(input.program.source)
    await page.getByRole("button", { name: "Approve and connect", exact: true }).click()
    await page.getByText("Bounded page program approved", { exact: true }).waitFor()
    if (!control.id || !state.nativeVerified || state.createCalls !== 1 || state.promptCalls)
      throw new Error("Original Native control approval did not settle before explicit use")
    state.beforeUseInputUnchanged = await composer.textContent() === before
    await page.getByRole("button", { name: "Add approved page program to agent draft", exact: true }).click()
    await composer.waitFor()
    state.explicitUseComposer = (await composer.textContent())?.includes(`browser controlID: ${control.id}`) === true
    if (!state.explicitUseComposer || !state.beforeUseInputUnchanged || state.promptCalls)
      throw new Error("Original explicit-use/composer boundary failed")
    // This is the original user toggle, not a fake preparation response or model admission.
    const intelligence = page.getByRole("button", { name: "Intelligence", exact: true })
    if (await intelligence.getAttribute("aria-pressed") === "true") await intelligence.click()
    state.phase = "original_prompt_once"
    await composer.press("Enter")
    const replied = new Set<string>()
    while (Date.now() < actualUntil) {
      const pending = await client.v2.session.permission.list({ sessionID: input.sessions.gui }, { throwOnError: true })
      for (const permission of pending.data.data) {
        if (replied.has(permission.id)) continue
        if (permission.source?.type !== "tool" || !["browser", "browser-program"].includes(permission.action) ||
            !permission.resources.every((resource) => resource.startsWith(control.id + "/")))
          throw new Error("Unexpected original permission; no blanket approval is allowed")
        const once = page.getByRole("button", { name: "Allow once", exact: true })
        await once.waitFor()
        await once.click()
        replied.add(permission.id)
      }
      if (await page.getByText("Browser client program completed", { exact: true }).isVisible()) break
      await Bun.sleep(30)
    }
    state.userCompletionVisible = await page.getByText("Browser client program completed", { exact: true }).isVisible()
    if (!state.userCompletionVisible || state.promptCalls !== 1) throw new Error("Original client canonical completion did not settle")
    state.phase = "original_stop"
    await page.keyboard.press(mac ? "Meta+Shift+P" : "Control+Shift+P")
    await page.getByPlaceholder("Search files, commands, and sessions").fill("Connect an agent browser")
    await page.locator('[data-slot="list-item"][data-key="command:browser.connect"]').click()
    await page.getByRole("button", { name: "Stop browser", exact: true }).click()
    await page.getByText("Browser stop confirmed", { exact: true }).waitFor()
    state.stopConfirmed = true
    await page.screenshot({ path: path.join(directory, "client-completed.png") })
    state.phase = "complete"
  } catch (error) {
    if (resources.page) await resources.page.screenshot({ path: path.join(directory, "client-failure.png") }).catch(() => undefined)
    await fs.writeFile(path.join(directory, "driver-error-private.log"), error instanceof Error ? error.stack ?? error.message : String(error), { mode: 0o600 })
    throw error
  } finally {
    if (resources.browser) { await resources.browser.close(); state.windowClosed = true }
    if (vite.exitCode === null) vite.kill("SIGTERM")
    const ended = await Promise.race([vite.exited, Bun.sleep(5000).then(() => undefined)])
    if (ended === undefined) { vite.kill("SIGKILL"); await vite.exited }
    state.viteExited = vite.exitCode !== null
    await log.close()
    await fs.writeFile(path.join(directory, "client-safe-observation.json"), JSON.stringify({ version: 1, ...state,
      actualRoot: true, originalApp: true, realNativeFactoryRequired: true,
      limits: ["QA controlled loopback model transport", "Original Main and utility source-runtime, not installer", "Program positive only"] }, null, 2), { mode: 0o600 })
  }
}

if (import.meta.main) await run(process.argv[2], process.argv[3] === "--dry").catch(() => {
  console.error("BROWSER_CANONICAL_GUI_FAILED; inspect private observations"); process.exitCode = 1
})
