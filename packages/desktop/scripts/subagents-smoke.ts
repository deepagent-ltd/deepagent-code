#!/usr/bin/env bun
import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { copyFile, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test"

const root = await realpath(await mkdtemp(join(tmpdir(), "deepagent-code-subagents-smoke-")))
const workspace = join(root, "workspace")
const main = resolve("out/main/index.js")
const packagedExecutable = process.env.DEEPAGENT_CODE_DESKTOP_EXECUTABLE
const databaseSource = process.env.DEEPAGENT_CODE_SMOKE_DATABASE_SOURCE
  ? await realpath(process.env.DEEPAGENT_CODE_SMOKE_DATABASE_SOURCE)
  : undefined
const databaseSourceBefore = databaseSource ? await stat(databaseSource) : undefined
await mkdir(workspace, { recursive: true })

const env = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
)
env.DEEPAGENT_CODE_TEST_ONBOARDING = "1"
env.DEEPAGENT_CODE_TEST_ROOT = root
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
if (databaseSource) await copyFile(databaseSource, env.DEEPAGENT_CODE_DB, constants.COPYFILE_FICLONE)

type DesktopAPI = {
  awaitInitialization(): Promise<{ url: string; username: string; password: string }>
  storeGet(name: string, key: string): Promise<string | null>
  storeSet(name: string, key: string, value: string): Promise<void>
  getWindowCount(): Promise<number>
}

const api = (page: Page) => page.evaluate(() => (window as unknown as { api: DesktopAPI }).api.awaitInitialization())

let activeApp: ElectronApplication | undefined

async function launch() {
  const started = performance.now()
  const app = await electron.launch({
    args: packagedExecutable ? [] : [main],
    ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
    env,
    timeout: 30_000,
  })
  activeApp = app
  console.log(
    "Electron main launched",
    await app.evaluate(({ app, BrowserWindow }) => ({
      ready: app.isReady(),
      windows: BrowserWindow.getAllWindows().length,
    })),
  )
  const page = await app.firstWindow({ timeout: 30_000 })
  await page.waitForFunction(() => Boolean((window as unknown as { api?: DesktopAPI }).api))
  const server = await api(page)
  const startupMs = Math.round(performance.now() - started)
  const resources = packagedExecutable
    ? await new Promise((resolve) => setTimeout(resolve, 5_000)).then(() => processTreeResources(app.process().pid))
    : undefined
  console.log("Electron startup ready", { packaged: Boolean(packagedExecutable), startupMs, resources })
  if (packagedExecutable) assert.equal(startupMs < 20_000, true, `packaged startup took ${startupMs}ms`)
  if (resources) {
    assert.equal(resources.cpuPercent < 75, true, `packaged idle CPU remained at ${resources.cpuPercent}%`)
    assert.equal(resources.rssMiB < 1_536, true, `packaged process tree retained ${resources.rssMiB} MiB RSS`)
  }
  return { app, page, server }
}

async function processTreeResources(rootPID: number) {
  const output = await promisify(execFile)("ps", ["-axo", "pid=,ppid=,%cpu=,rss="])
  const rows = output.stdout
    .trim()
    .split("\n")
    .flatMap((line) => {
      const [pid, parentPID, cpu, rss] = line.trim().split(/\s+/).map(Number)
      return [pid, parentPID, cpu, rss].every(Number.isFinite) ? [{ pid, parentPID, cpu, rss }] : []
    })
  const processIDs = new Set([rootPID])
  while (rows.some((row) => processIDs.has(row.parentPID) && !processIDs.has(row.pid) && processIDs.add(row.pid))) {}
  const resources = rows.filter((row) => processIDs.has(row.pid))
  return {
    processes: resources.length,
    cpuPercent: Math.round(resources.reduce((sum, row) => sum + row.cpu, 0) * 10) / 10,
    rssMiB: Math.round(resources.reduce((sum, row) => sum + row.rss, 0) / 1024),
  }
}

async function close(app: ElectronApplication) {
  await app.close()
  if (activeApp === app) activeApp = undefined
}

async function createSession(
  server: Awaited<ReturnType<typeof api>>,
  body: { title: string; parentID?: string; metadata?: Record<string, unknown> },
) {
  const response = await fetch(`${server.url}/session?directory=${encodeURIComponent(workspace)}`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${server.username}:${server.password}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`session create failed: ${response.status} ${await response.text()}`)
  return (await response.json()) as { id: string }
}

async function listSessions(server: Awaited<ReturnType<typeof api>>) {
  const response = await fetch(`${server.url}/session?directory=${encodeURIComponent(workspace)}`, {
    headers: {
      authorization: `Basic ${Buffer.from(`${server.username}:${server.password}`).toString("base64")}`,
    },
  })
  if (!response.ok) throw new Error(`session list failed: ${response.status} ${await response.text()}`)
  return (await response.json()) as { id: string }[]
}

try {
  const first = await launch()
  const parent = await createSession(first.server, { title: "Cold-start parent" })
  const child = await createSession(first.server, {
    title: "Cold-start researcher",
    parentID: parent.id,
    metadata: {
      deepagent: {
        subagent: {
          finished: true,
          state: "completed",
          reason: "structured_output_valid",
          run_id: "run_electron_smoke",
          generation: 1,
        },
      },
    },
  })
  const firstSessions = await listSessions(first.server)
  assert.equal(
    firstSessions.some((session) => session.id === parent.id),
    true,
  )
  assert.equal(
    firstSessions.some((session) => session.id === child.id),
    true,
  )
  const slug = Buffer.from(workspace).toString("base64url")
  const sessionKey = `local\u0000${slug}/${parent.id}`
  await first.page.evaluate(
    async ({ layout, pageLayout, server }) => {
      const api = (window as unknown as { api: DesktopAPI }).api
      await api.storeSet("deepagent.global.dat", "layout", JSON.stringify(layout))
      await api.storeSet("deepagent.global.dat", "layout.page", JSON.stringify(pageLayout))
      await api.storeSet("deepagent.global.dat", "server", JSON.stringify(server))
    },
    {
      layout: { sessionView: { [sessionKey]: { scroll: {}, rightPanelMode: "subagents" } } },
      pageLayout: {
        lastProjectSession: {
          [workspace]: { directory: workspace, id: parent.id, at: Date.now() },
        },
      },
      server: {
        list: [],
        projects: { local: [{ worktree: workspace, expanded: true }] },
        lastProject: { local: workspace },
      },
    },
  )
  await close(first.app)
  assert.equal((await stat(env.DEEPAGENT_CODE_DB)).size > 0, true, "desktop sidecar did not persist its database")

  const second = await launch()
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  const responseErrors: { method: string; status: number; type: string; url: string }[] = []
  second.page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
  second.page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  second.page.on("response", (response) => {
    if (response.status() < 400) return
    responseErrors.push({
      method: response.request().method(),
      status: response.status(),
      type: response.request().resourceType(),
      url: response.url(),
    })
  })
  const sessions = await listSessions(second.server)
  assert.equal(
    sessions.some((session) => session.id === parent.id),
    true,
    "parent session did not survive restart",
  )
  assert.equal(
    sessions.some((session) => session.id === child.id),
    true,
    "child session did not survive restart",
  )
  await second.page
    .getByText("Cold-start researcher")
    .waitFor({ state: "visible", timeout: 30_000 })
    .catch(async (error) => {
      console.error("Electron cold-start diagnostics", {
        body: (await second.page.locator("body").innerText()).slice(0, 4_000),
        consoleErrors,
        responseErrors,
        layout: await second.page.evaluate(() =>
          (window as unknown as { api: DesktopAPI }).api.storeGet("deepagent.global.dat", "layout"),
        ),
        pageLayout: await second.page.evaluate(() =>
          (window as unknown as { api: DesktopAPI }).api.storeGet("deepagent.global.dat", "layout.page"),
        ),
        server: await second.page.evaluate(() =>
          (window as unknown as { api: DesktopAPI }).api.storeGet("deepagent.global.dat", "server"),
        ),
      })
      throw error
    })
  assert.equal(await second.page.getByRole("button", { name: /Cold-start researcher/ }).count(), 2)
  assert.equal(await second.page.evaluate(() => (window as unknown as { api: DesktopAPI }).api.getWindowCount()), 1)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(responseErrors, [])
  assert.deepEqual(consoleErrors, [])
  assert.deepEqual(
    await second.page.locator("#review-panel").evaluate((panel) => {
      const selector = "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab]"
      return [...panel.querySelectorAll(selector)]
        .filter((element) => element.parentElement?.closest(selector))
        .map((element) => element.outerHTML)
    }),
    [],
  )
  assert.equal(child.id.startsWith("ses_"), true)
  await close(second.app)
  console.log("Electron subagent cold-start smoke passed")
} finally {
  if (activeApp) await activeApp.close().catch(() => undefined)
  if (databaseSource && databaseSourceBefore) {
    const databaseSourceAfter = await stat(databaseSource)
    assert.equal(databaseSourceAfter.size, databaseSourceBefore.size, "source database size changed")
    assert.equal(databaseSourceAfter.mtimeMs, databaseSourceBefore.mtimeMs, "source database modification time changed")
  }
  if (process.env.DEEPAGENT_CODE_KEEP_SMOKE === "1") console.error(`Electron smoke artifacts retained at ${root}`)
  if (process.env.DEEPAGENT_CODE_KEEP_SMOKE !== "1") await rm(root, { recursive: true, force: true })
}
