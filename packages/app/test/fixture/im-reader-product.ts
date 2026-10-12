export * as IMReaderProduct from "./im-reader-product"

import { chromium } from "@playwright/test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { IMReaderProductDescriptor } from "./im-reader-product-descriptor"

export const UI = Schema.Struct({
  port: Schema.Int.check(Schema.isGreaterThan(1024), Schema.isLessThanOrEqualTo(65535)),
  observationDirectory: Schema.String.check(Schema.makeFilter((value: string) => value.startsWith("/"))),
})

export async function run(descriptorFile: string, uiFile: string) {
  const prepared = await IMReaderProductDescriptor.prepare(descriptorFile, true)
  const ui = Schema.decodeUnknownSync(UI)(await Bun.file(uiFile).json(), { onExcessProperty: "error" })
  await fs.mkdir(ui.observationDirectory, { recursive: true, mode: 0o700 })
  const home = path.join(ui.observationDirectory, "app-home")
  await fs.mkdir(home, { mode: 0o700 })
  const log = await fs.open(path.join(ui.observationDirectory, "vite-private.log"), "wx", 0o600)
  const root = new URL(prepared.input.root.url)
  const origin = `http://127.0.0.1:${ui.port}`
  const vite = Bun.spawn([process.execPath, "run", "dev", "--", "--host", "127.0.0.1", "--port", String(ui.port), "--strictPort"], {
    cwd: path.resolve(import.meta.dir, "../.."), env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home,
      XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"),
      XDG_CACHE_HOME: path.join(home, "cache"), VITE_DEEPAGENT_CODE_SERVER_HOST: root.hostname,
      VITE_DEEPAGENT_CODE_SERVER_PORT: root.port,
    }, stdin: "ignore", stdout: log.fd, stderr: log.fd,
  })
  const state = { phase: "vite_readiness", mutations: 0, legacyGroups: 0, wrongDirectory: 0,
    browser: undefined as Awaited<ReturnType<typeof chromium.launch>> | undefined,
    naturalViteExit: false, portClosed: false, timer: undefined as ReturnType<typeof setTimeout> | undefined }
  const observations: { scope: "A" | "B"; kind: "groups" | "messages" | "detail"; lane: string;
    cursorHash: string; status: number; ids: string[]; epochHash: string }[] = []
  const completed: { scope: "A" | "B"; groupsObserved: number; renderedMessages: number; uiMessagePages: number }[] = []
  const active = { key: "A" as "A" | "B" }
  const started = Date.now()
  const progress = setInterval(() => console.log(JSON.stringify({ phase: state.phase,
    elapsedMs: Date.now() - started, completedScopes: completed.length, mutations: state.mutations })), 5000)
  try {
    const readyUntil = Math.min(prepared.input.deadlineAt, Date.now() + 30_000)
    while (Date.now() < readyUntil) {
      if (vite.exitCode !== null) throw new Error("Original Vite exited")
      if (await fetch(origin, { signal: AbortSignal.timeout(500) }).then((response) => response.ok).catch(() => false)) break
      await Bun.sleep(50)
    }
    if (Date.now() >= readyUntil) throw new Error("Original Vite was not ready")
    state.browser = await chromium.launch({ headless: true })
    state.timer = setTimeout(() => { void state.browser?.close() }, Math.max(1, Math.min(75_000, prepared.input.deadlineAt - Date.now())))
    const context = await state.browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 960 } })
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)
    page.on("request", (request) => {
      const url = new URL(request.url())
      if (url.origin !== root.origin || !url.pathname.startsWith("/api/v1/im/")) return
      if (request.method() !== "GET") state.mutations++
      if (url.pathname.endsWith("/groups")) state.legacyGroups++
      if (url.searchParams.get("directory") !== prepared.input.scopes[active.key].directory) state.wrongDirectory++
    })
    page.on("response", async (response) => {
      const url = new URL(response.url())
      if (url.origin !== root.origin || response.request().method() !== "GET") return
      const scope = Object.entries(prepared.input.scopes).find(([, value]) => value.directory === url.searchParams.get("directory"))?.[0]
      if (scope !== "A" && scope !== "B") return
      const kind = url.pathname.endsWith("/groups/page") ? "groups"
        : url.pathname.endsWith("/messages") ? "messages"
        : /^\/api\/v1\/im\/groups\/[^/]+$/.test(url.pathname) ? "detail" : undefined
      if (!kind) return
      const bytes = await response.body().catch(() => undefined)
      const value = bytes ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(bytes.toString("utf8"))) : undefined
      const rows = value && typeof value === "object" && (kind === "groups" ? "groups" in value : "messages" in value)
        ? kind === "groups" && "groups" in value ? value.groups : "messages" in value ? value.messages : undefined : undefined
      const reader = value && typeof value === "object" && "reader" in value ? value.reader : undefined
      const epoch = reader && typeof reader === "object" && "displayEpoch" in reader ? reader.displayEpoch : undefined
      observations.push({ scope, kind, lane: url.searchParams.get("lane") ?? "", status: response.status(),
        cursorHash: url.searchParams.has("cursor") ? createHash("sha256").update(url.searchParams.get("cursor")!).digest("hex") : "",
        ids: Array.isArray(rows) ? rows.flatMap((row: unknown) => row && typeof row === "object" && "id" in row && typeof row.id === "string" ? [row.id] : []) : [],
        epochHash: typeof epoch === "string" ? createHash("sha256").update(epoch).digest("hex") : "" })
    })
    for (const key of ["A", "B", "A"] as const) {
      active.key = key
      const scope = prepared.input.scopes[key]
      const from = observations.length
      state.phase = `scope_${key}_list`
      await page.goto(`${origin}/${Buffer.from(scope.directory).toString("base64url")}/session?auth_token=${encodeURIComponent(prepared.authorization.slice(6))}`)
      await page.waitForFunction(() => !new URL(location.href).searchParams.has("auth_token"))
      await page.getByRole("tab", { name: "Messages", exact: true }).click()
      const panel = page.locator("#review-panel")
      await panel.getByRole("button").filter({ hasText: scope.ordinary[0]!.name }).waitFor()
      await panel.getByRole("button").filter({ hasText: scope.protected[0]!.name }).waitFor()
      for (const name of ["Load more local conversations", "Load more remote conversations"]) {
        for (let index = 0; index < 32; index++) {
          const more = panel.getByRole("button", { name, exact: true })
          if (!(await more.count())) break
          await more.click()
          await page.waitForFunction((label) => !Array.from(document.querySelectorAll("#review-panel button"))
            .some((button) => button.textContent?.trim() === label && (button as HTMLButtonElement).disabled), name)
          if (index === 31) throw new Error("Conversation page budget exceeded")
        }
      }
      const seenGroups = new Set(observations.slice(from).filter((row) => row.scope === key && row.kind === "groups").flatMap((row) => row.ids))
      if ([...scope.ordinary, ...scope.protected].some((group) => !seenGroups.has(group.id))) throw new Error("Original directory groups were missing")
      const group = scope.protected.find((value) => value.id === scope.selectedGroupID)!
      state.phase = `scope_${key}_offpage_history`
      await panel.getByRole("button").filter({ hasText: group.name }).click()
      await panel.getByText(scope.messages.newestMarker, { exact: true }).waitFor()
      for (let index = 0; index < 8; index++) {
        const more = panel.getByRole("button", { name: "Load earlier messages", exact: true })
        if (!(await more.count())) break
        await more.click()
        await page.waitForFunction(() => !document.querySelector('#review-panel [role="log"] button:disabled'))
        if (index === 7) throw new Error("Message page budget exceeded")
      }
      const ids = await panel.locator("[data-im-message]").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.imMessage!))
      if (ids.length !== 125 || new Set(ids).size !== 125 || scope.messages.ids.some((id) => !ids.includes(id)))
        throw new Error("Original UI did not render the 125 exact message identities")
      await panel.getByText(scope.messages.oldestMarker, { exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(ui.observationDirectory, `app-${completed.length}-${key}-oldest.png`) })
      completed.push({ scope: key, groupsObserved: seenGroups.size, renderedMessages: ids.length,
        uiMessagePages: observations.slice(from).filter((row) => row.scope === key && row.kind === "messages" && row.status === 200).length })
    }
    if (state.mutations || state.legacyGroups || state.wrongDirectory) throw new Error("Original read path violated its scope or mutation boundary")
    state.phase = "normal_pagination_complete_faults_open"
  } finally {
    clearInterval(progress)
    if (state.timer) clearTimeout(state.timer)
    await state.browser?.close()
    vite.kill("SIGTERM")
    state.naturalViteExit = await Promise.race([vite.exited.then(() => true), Bun.sleep(3000).then(() => false)])
    if (!state.naturalViteExit) { vite.kill("SIGKILL"); await vite.exited }
    state.portClosed = await fetch(origin, { signal: AbortSignal.timeout(500) }).then(() => false).catch(() => true)
    await log.close()
    await fs.writeFile(path.join(ui.observationDirectory, "app-reader-safe.json"), JSON.stringify({
      version: 1, phase: state.phase, actualApp: true, actualHTTP: true, completed,
      mutations: state.mutations, legacyGroups: state.legacyGroups, wrongDirectory: state.wrongDirectory,
      pages: observations.map((row) => ({ ...row, ids: undefined, itemCount: row.ids.length,
        idsHash: createHash("sha256").update(JSON.stringify(row.ids)).digest("hex") })),
      ownVitePID: vite.pid, ownViteExited: vite.exitCode !== null, naturalViteExit: state.naturalViteExit,
      ownBrowserClosed: true, ownPortClosed: state.portClosed, faults: IMReaderProductDescriptor.safe(prepared.input).faultCoverage,
    }, null, 2), { mode: 0o600, flag: "wx" })
  }
}

if (import.meta.main) {
  if (!process.argv[2] || !process.argv[3]) throw new Error("Original reader descriptor and UI plan required")
  if (process.argv[4] === "--dry") {
    const prepared = await IMReaderProductDescriptor.prepare(process.argv[2])
    Schema.decodeUnknownSync(UI)(await Bun.file(process.argv[3]).json(), { onExcessProperty: "error" })
    console.log(JSON.stringify({ dry: true, ...IMReaderProductDescriptor.safe(prepared.input), backendStarted: false }))
  }
  if (process.argv[4] !== "--dry") await run(process.argv[2], process.argv[3]).catch(() => {
    console.error("IM_READER_APP_STAGE_FAILED; inspect the private safe observation")
    process.exitCode = 1
  })
}
