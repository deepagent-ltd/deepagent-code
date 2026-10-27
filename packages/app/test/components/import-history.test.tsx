import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createStore } from "solid-js/store"
import { createOpencodeClient, type ImportJobInfo, type ImportJobRequest } from "@deepagent-code/sdk"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Window } from "happy-dom"
import { DialogProvider, useDialog } from "@deepagent-code/ui/context/dialog"
import { Dialog } from "@deepagent-code/ui/v2/dialog-v2"
import { ImportSection } from "@/components/settings-v2/import-history"
import { dict } from "@/i18n/en"
import { publishImportFixturePacket } from "./fixture/import-control"
import { importFixtureEnvironment } from "./fixture/import-environment"
import { waitForImportFixtureReady } from "./fixture/import-readiness"

const transport = vi.hoisted(() => ({
  capabilities: vi.fn(),
  importCreate: vi.fn(),
  importList: vi.fn(),
  importGet: vi.fn(),
  importCancel: vi.fn(),
  importBundle: vi.fn(),
  importSnapshot: vi.fn(),
}))
const [server, setServer] = createStore({
  key: "one",
  current: { http: { url: "http://fixture-one", password: "one" } },
})
vi.mock("@/context/server", () => ({ useServer: () => server }))
vi.mock("@/context/server-sdk", () => ({
  useServerSDK: () => ({
    client: {
      global: transport,
      session: { importBundle: transport.importBundle, importSnapshot: transport.importSnapshot },
    },
  }),
}))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] ?? key, intl: () => "en-US" }),
}))
vi.mock("@deepagent-code/ui/context/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }))

const target = {
  id: "fixture-copy",
  mode: "copy_to_new_db" as const,
  sourcePath: "/isolated/source",
  dbPath: "/isolated/imports/fixture-copy/data/import.db",
  dataRoot: "/isolated/imports/fixture-copy/data",
  configDir: "/isolated/imports/fixture-copy/config",
  dryRun: false,
  backup: {
    path: "/isolated/imports/fixture-copy/backup/before-import.db",
    manifestPath: "/isolated/backup.manifest",
    sha256: "a".repeat(64),
  },
}
const job = (overrides: Partial<ImportJobInfo> = {}): ImportJobInfo => ({
  id: "job-fixture",
  requestID: "request-fixture",
  source: "codex",
  state: "running",
  revision: 1,
  dryRun: false,
  target,
  sourceDigest: "b".repeat(64),
  totalSessions: 3,
  committedBatches: 0,
  failedBatches: 0,
  createdAt: 1700000000000,
  updatedAt: 1700000000001,
  ...overrides,
})
const response = <T,>(data: T) => ({ data: structuredClone(data), response: Response.json(data) })
let rows: ImportJobInfo[] = []

beforeEach(() => {
  sessionStorage.clear()
  setServer({ key: "one", current: { http: { url: "http://fixture-one", password: "one" } } })
  Object.values(transport).forEach((method) => method.mockReset())
  rows = []
  transport.capabilities.mockResolvedValue(response({ features: { importJobs: true, importModes: true, importFileJobs: true } }))
  transport.importList.mockImplementation(async () => response({ items: rows }))
  transport.importGet.mockImplementation(async ({ jobID }: { jobID: string }) =>
    response(rows.find((row) => row.id === jobID)!),
  )
  transport.importCreate.mockImplementation(async (parameters: { importJobRequest: ImportJobRequest }) => {
    rows = [job({ requestID: parameters.importJobRequest.requestID })]
    return response(rows[0])
  })
  transport.importCancel.mockImplementation(async () => {
    rows = [job({ ...rows[0], state: "cancel_requested", revision: 2, cancelRequestedAt: 1700000000002 })]
    return response(rows[0])
  })
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Import GUI must use the SDK")
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function shownJob(id: string) {
  const button = await screen.findByRole("button", { name: dict["settings.import.job.details"] })
  if (button.getAttribute("aria-expanded") !== "true") fireEvent.click(button)
  await waitFor(() =>
    expect(
      (screen.getByRole("textbox", { name: dict["settings.import.job.diagnosticText"] }) as HTMLTextAreaElement).value,
    ).toContain(`Job: ${id}`),
  )
}

async function start() {
  render(() => <ImportSection />)
  const button = screen.getByRole("button", { name: "Import" })
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false))
  fireEvent.click(button)
  await shownJob("job-fixture")
}

it("shared scope checkboxes support label, focus and Space without submitting an import", async () => {
  const user = userEvent.setup()
  render(() => <ImportSection />)
  await screen.findByText(dict["settings.import.job.empty"])
  const group = screen.getByRole("group", { name: dict["settings.import.scope"] })
  const memory = within(group).getByRole("checkbox", { name: "Memory" })
  const skills = within(group).getByRole("checkbox", { name: "Skills" })
  expect(within(group).getByRole("checkbox", { name: dict["settings.import.scope.session"] })).toHaveProperty("checked", true)
  expect(memory).toHaveProperty("checked", false)
  await user.click(within(group).getByText("Memory"))
  expect(memory).toHaveProperty("checked", true)
  expect(screen.getByRole("switch", { name: dict["settings.import.copyLiveDb"] }).hasAttribute("disabled")).toBe(true)
  memory.focus()
  await user.keyboard(" ")
  expect(memory).toHaveProperty("checked", false)
  expect(document.activeElement).toBe(memory)
  await user.tab()
  expect(document.activeElement).toBe(skills)
  await user.keyboard(" ")
  expect(skills).toHaveProperty("checked", true)
  expect(transport.importCreate).not.toHaveBeenCalled()
  expect(transport.importCancel).not.toHaveBeenCalled()
})

it("submits the default session-only copy through the durable SDK and shows actual target/backup evidence", async () => {
  await start()
  expect(transport.importCreate).toHaveBeenCalledTimes(1)
  expect(transport.importCreate.mock.calls[0]![0].importJobRequest).toMatchObject({
    requestID: expect.any(String),
    source: "codex",
    mode: "copy_to_new_db",
    copyLiveDb: true,
    confirmLiveMerge: false,
    scopes: ["session"],
  })
  expect(screen.getByText(dict["settings.import.job.targetCopy"])).toBeTruthy()
  expect(screen.getByDisplayValue(/Manifest: \/isolated\/backup.manifest/)).toBeTruthy()
  expect(screen.getByRole("checkbox", { name: "Memory" }).hasAttribute("disabled")).toBe(true)
  expect(screen.getByRole("checkbox", { name: "Skills" }).hasAttribute("disabled")).toBe(true)
  expect(fetch).not.toHaveBeenCalled()
})

it("preserves file scopes for a copy and requires explicitly deselecting them before live merge", async () => {
  render(() => <ImportSection />)
  await screen.findByText(dict["settings.import.job.empty"])
  fireEvent.click(screen.getByRole("switch", { name: "Dry-run" }))
  fireEvent.click(screen.getByRole("checkbox", { name: "Memory" }))
  expect(screen.getByRole("checkbox", { name: "Memory" })).toHaveProperty("checked", true)
  fireEvent.click(screen.getByRole("switch", { name: "Dry-run" }))
  expect(screen.getByRole("checkbox", { name: "Memory" })).toHaveProperty("checked", true)
  expect(screen.getByRole("switch", { name: dict["settings.import.copyLiveDb"] }).hasAttribute("disabled")).toBe(true)
  fireEvent.click(screen.getByRole("checkbox", { name: "Memory" }))
  fireEvent.click(screen.getByRole("switch", { name: dict["settings.import.copyLiveDb"] }))
  expect(screen.getByRole("button", { name: "Import" }).hasAttribute("disabled")).toBe(true)
  fireEvent.click(screen.getByRole("checkbox", { name: dict["settings.import.merge.confirm"] }))
  await waitFor(() => expect(screen.getByRole("button", { name: "Import" }).hasAttribute("disabled")).toBe(false))
  fireEvent.click(screen.getByRole("button", { name: "Import" }))
  await waitFor(() => expect(transport.importCreate).toHaveBeenCalledTimes(1))
  expect(transport.importCreate.mock.calls[0]![0].importJobRequest).toMatchObject({
    mode: "merge_into_live",
    copyLiveDb: false,
    confirmLiveMerge: true,
    scopes: ["session"],
  })
})

it("an older session-only job server permits file previews but no file writes", async () => {
  transport.capabilities.mockResolvedValue(response({ features: { importJobs: true, importModes: true } }))
  render(() => <ImportSection />)
  await screen.findByText(dict["settings.import.job.empty"])
  expect(screen.getByRole("checkbox", { name: "Memory" }).hasAttribute("disabled")).toBe(true)
  fireEvent.click(screen.getByRole("switch", { name: "Dry-run" }))
  fireEvent.click(screen.getByRole("checkbox", { name: "Memory" }))
  expect(screen.getByRole("checkbox", { name: "Memory" })).toHaveProperty("checked", true)
  fireEvent.click(screen.getByRole("switch", { name: "Dry-run" }))
  expect(screen.getByRole("checkbox", { name: "Memory" })).toHaveProperty("checked", false)
  expect(transport.importCreate).not.toHaveBeenCalled()
})

it("file scope unknown responses keep the original request and show only verified published summaries", async () => {
  transport.importCreate.mockRejectedValueOnce(new Error("lost response"))
  rows = []
  render(() => <ImportSection />)
  await screen.findByText(dict["settings.import.job.empty"])
  fireEvent.click(screen.getByRole("checkbox", { name: "Memory" }))
  fireEvent.click(screen.getByRole("checkbox", { name: "Skills" }))
  fireEvent.click(screen.getByRole("button", { name: "Import" }))
  await screen.findByText(dict["settings.import.job.requestUnknown"])
  const original = structuredClone(transport.importCreate.mock.calls[0]![0])
  expect(original.importJobRequest).toMatchObject({ scopes: ["session", "memory", "skill"], mode: "copy_to_new_db" })
  expect(transport.importCreate).toHaveBeenCalledTimes(1)
  expect(screen.queryByText(dict["settings.import.job.fileSets"])).toBeNull()
  transport.importCreate.mockImplementation(async () => {
    rows = [job({ state: "completed", scopes: ["session", "memory", "skill"], committedSessions: 1, committedBatches: 3,
      fileResults: [{ kind: "file_set.v1", phase: "published", sourceId: "memory", targetId: "memory-target",
        scope: "memory", manifestHash: "c".repeat(64), directoryRef: { area: "data", relative: "knowledge/fixture" },
        bytes: 100, fileCount: 2, summary: { staged: 1, approved: 1, pending: 0, writtenToInstructions: false } },
      { kind: "file_set.v1", phase: "published", sourceId: "skill", targetId: "skill-target",
        scope: "skill", manifestHash: "d".repeat(64), directoryRef: { area: "config", relative: "skills/fixture" },
        bytes: 200, fileCount: 2, summary: { written: 1, skipped: 0 } }],
    })]
    return response(rows[0])
  })
  fireEvent.click(screen.getByRole("button", { name: dict["settings.import.job.retryRequest"] }))
  await shownJob("job-fixture")
  expect(transport.importCreate.mock.calls[1]![0]).toEqual(original)
  expect(screen.getByText("1 / 3")).toBeTruthy()
  expect(screen.queryByText("3 / 3")).toBeNull()
  expect(screen.getByText(dict["settings.import.job.fileSets"])).toBeTruthy()
  expect(screen.getByDisplayValue(/File set: memory.*100 bytes/)).toBeTruthy()
})

it("GUI uses the formal SDK and authenticated production HTTP to publish memory and binary skills into one private copy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dac-gui-import-files-"))
  const surface = window as unknown as Window
  const origin = window.location.href
  const hostPackage = path.resolve(process.cwd(), "../deepagent-code")
  const progress = { phase: "startup", startedAt: Date.now(), failed: false, deadlineExpired: false,
    spawnError: undefined as string | undefined }
  const child = spawn("bun", ["--preload", path.resolve("test/components/fixture/import-startup.ts"), path.join(hostPackage, "test/fixture/import-gui-job-server.ts"), root], {
    cwd: hostPackage,
    env: importFixtureEnvironment(root),
    stdio: ["ignore", "pipe", "pipe"],
  })
  const observations: {
    phase: string
    at: number
    elapsedMs: number
    pid?: number
    status?: number
    state?: string
    hasTarget?: boolean
    hasSourceDigest?: boolean
    committedBatches?: number
    deadlineAt?: number
    code?: number | null
  }[] = []
  const observe = (
    phase: string,
    facts: Omit<(typeof observations)[number], "phase" | "at" | "elapsedMs" | "pid"> = {},
  ) => {
    if (observations.length < 128)
      observations.push({ phase, at: Date.now(), elapsedMs: Date.now() - progress.startedAt, pid: child.pid, ...facts })
  }
  const observed = { copy: "" }
  observe("spawn", { deadlineAt: progress.startedAt + 25000 })
  let output = ""
  child.stdout?.on("data", (data: Buffer) => { output = (output + data.toString()).slice(-65536) })
  child.stderr?.on("data", (data: Buffer) => { output = (output + data.toString()).slice(-65536) })
  child.once("error", (error) => { progress.spawnError = error.message })
  const exited = new Promise<number | null>((resolve) =>
    child.once("close", (code) => {
      observe("child-close", { code })
      resolve(code)
    }),
  )
  const diagnostic = async () =>
    JSON.stringify({
      ...progress,
      elapsedMs: Date.now() - progress.startedAt,
      root,
      pid: child.pid,
      exitCode: child.exitCode,
      signal: child.signalCode,
      resultFiles: (await fs.readdir(root)).filter((name) => name.endsWith(".json")),
      startup: await fs.readFile(path.join(root, "startup.jsonl"), "utf8").catch(() => null),
      observations,
      output,
    })
  const deadline = setTimeout(() => {
    progress.deadlineExpired = true
    observe("child-deadline-fired", { deadlineAt: progress.startedAt + 25000 })
    child.kill("SIGTERM")
  }, 25000)
  try {
    await fs.mkdir(path.join(root, "home"), { recursive: true })
    await waitForImportFixtureReady({ root, startedAt: progress.startedAt,
      ended: () => child.exitCode !== null || child.signalCode !== null || progress.spawnError !== undefined })
    observe("ready-observed")
    expect(await fs.stat(path.join(root, "ready.json"))).toBeTruthy()
    const ready = JSON.parse(await fs.readFile(path.join(root, "ready.json"), "utf8")) as { url: string; sourcePath: string }
    progress.phase = "authenticated capability"
    // Use this owned listener as the actual test window origin; no HTTP authorization or
    // production CORS gate is replaced to accommodate HappyDOM's same-origin enforcement.
    surface.happyDOM.setURL(ready.url)
    vi.unstubAllGlobals()
    const client = createOpencodeClient({ baseUrl: ready.url, headers: { Authorization: `Basic ${btoa("deepagent-code:gui-private-auth")}` } })
    const capability = await client.global.capabilities()
    observe("capability-returned", { status: capability.response?.status })
    if (capability.error) throw new Error(`Private capability transport: ${String(capability.error)}`)
    expect(capability.response?.status).toBe(200)
    expect(capability.data?.features.importFileJobs).toBe(true)
    setServer({ key: "private-http", current: { http: { url: ready.url, password: "gui-private-auth" } } })
    transport.capabilities.mockImplementation((options) => client.global.capabilities(options))
    transport.importCreate.mockImplementation((parameters, options) => {
      observe("create-post-start")
      return client.global.importCreate(parameters, options)
    })
    transport.importGet.mockImplementation((parameters, options) => client.global.importGet(parameters, options))
    transport.importList.mockImplementation((parameters, options) => client.global.importList(parameters, options))
    transport.importCancel.mockImplementation((parameters, options) => client.global.importCancel(parameters, options))
    const user = userEvent.setup()
    const view = render(() => <ImportSection />)
    await screen.findByText(dict["settings.import.job.empty"])
    expect(screen.getByRole("checkbox", { name: "Memory" }).hasAttribute("disabled")).toBe(false)
    await user.click(screen.getByRole("button", { name: "Codex" }))
    await user.click(await screen.findByRole("option", { name: dict["settings.import.preset.custom"] }))
    fireEvent.input(screen.getByRole("textbox", { name: dict["settings.import.customPath"] }), { target: { value: ready.sourcePath } })
    const picker = screen.getByRole("button", { name: "Codex" })
    await user.click(picker)
    await waitFor(() => expect(document.getElementById(picker.getAttribute("aria-controls") ?? "")).not.toBeNull())
    const menu = within(document.getElementById(picker.getAttribute("aria-controls")!)!)
    await user.click(menu.getAllByRole("option").find((option) => option.textContent?.trim() === "Claude Code")!)
    expect(screen.getByRole("button", { name: dict["settings.import.preset.custom"] })).toBeTruthy()
    expect((screen.getByRole("textbox", { name: dict["settings.import.customPath"] }) as HTMLInputElement).value).toBe(ready.sourcePath)
    fireEvent.click(screen.getByRole("checkbox", { name: "Memory" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Skills" }))
    fireEvent.click(screen.getByRole("checkbox", { name: dict["settings.import.scope.session"] }))
    fireEvent.click(screen.getByRole("button", { name: "Import" }))
    await waitFor(() => expect(transport.importCreate).toHaveBeenCalledTimes(1))
    const original = transport.importCreate.mock.calls[0]![0] as { importJobRequest: ImportJobRequest }
    expect(original.importJobRequest).toMatchObject({ source: "claude", sourcePath: ready.sourcePath, scopes: ["memory", "skill"], mode: "copy_to_new_db", copyLiveDb: true, dryRun: false })
    const accepted = await client.global.importCreate(original)
    observe("original-create-ack", {
      status: accepted.response?.status,
      state: accepted.data?.state,
      hasTarget: Boolean(accepted.data?.target),
      hasSourceDigest: Boolean(accepted.data?.sourceDigest),
      committedBatches: accepted.data?.committedBatches,
    })
    expect(accepted.data?.id).toBeTruthy()
    progress.phase = `copy ${accepted.data!.id}`
    observe("copy-wait-start", { deadlineAt: Date.now() + 10000 })
    await waitFor(
      async () => {
        const current = await client.global.importGet({ jobID: accepted.data!.id })
        const facts = {
          status: current.response?.status,
          state: current.data?.state ?? "missing",
          hasTarget: Boolean(current.data?.target),
          hasSourceDigest: Boolean(current.data?.sourceDigest),
          committedBatches: current.data?.committedBatches,
        }
        if (observed.copy !== JSON.stringify(facts)) {
          observed.copy = JSON.stringify(facts)
          observe("copy-observed", facts)
        }
        if (current.data?.state === "failed" || current.data?.state === "recovery_required") {
        if (process.env.DAC_GUI_IMPORT_EVIDENCE_DIR) {
          await fs.mkdir(process.env.DAC_GUI_IMPORT_EVIDENCE_DIR, { recursive: true })
          await fs.writeFile(path.join(process.env.DAC_GUI_IMPORT_EVIDENCE_DIR, "gui-http-failed-job.json"), JSON.stringify({ request: original.importJobRequest, job: current.data }, null, 2))
        }
        throw new Error(`Actual import ${current.data.state}: ${JSON.stringify(current.data.error)}`)
      }
        expect(current.data?.state).toBe("completed")
        expect(current.data?.committedSessions).toBe(0)
        expect(current.data?.fileResults).toHaveLength(2)
      },
      { timeout: 10000 },
    )
    observe("copy-completed")
    fireEvent.click(screen.getByRole("button", { name: dict["settings.import.job.refresh"] }))
    await screen.findByText(dict["settings.import.job.fileSets"])
    expect(screen.queryByText(dict["settings.import.job.imported"])).toBeNull()
    expect(screen.getByText(dict["settings.import.job.copyComplete"])).toBeTruthy()
    await shownJob(accepted.data!.id)
    expect(screen.getByDisplayValue(/Manifest: [a-f0-9]{64}/)).toBeTruthy()
    const retried = await client.global.importCreate(original)
    expect(retried.data?.id).toBe(accepted.data!.id)
    view.unmount()
    progress.phase = "original immutable receipt inspection"
    await publishImportFixturePacket(path.join(root, "inspect.json"), { jobID: accepted.data!.id })
    observe("inspect-published", { deadlineAt: Date.now() + 10000 })
    await waitFor(async () => expect(await fs.stat(path.join(root, "proof.json"))).toBeTruthy(), { timeout: 10000 })
    observe("proof-observed")
    const proof = JSON.parse(await fs.readFile(path.join(root, "proof.json"), "utf8")) as {
      before: unknown; after: unknown; sourceBefore: unknown; sourceAfter: unknown; binary: number[]; liveSessions: unknown[]; jobs: unknown[];
      proof: { count: number; fileResults: unknown[] }
    }
    expect(proof.after).toEqual(proof.before)
    expect(proof.sourceAfter).toEqual(proof.sourceBefore)
    expect(proof.binary).toEqual([0, 255, 128])
    expect(proof.liveSessions).toEqual([])
    expect(proof.jobs).toHaveLength(1)
    expect(proof.proof.count).toBe(2)
    expect(proof.proof.fileResults).toHaveLength(2)
    if (process.env.DAC_GUI_IMPORT_EVIDENCE_DIR) {
      await fs.mkdir(process.env.DAC_GUI_IMPORT_EVIDENCE_DIR, { recursive: true })
      await fs.writeFile(path.join(process.env.DAC_GUI_IMPORT_EVIDENCE_DIR, "gui-http-proof.json"), JSON.stringify({
        ...proof, request: original.importJobRequest, job: retried.data,
      }, null, 2))
    }
  } catch (error) {
    progress.failed = true
    throw new Error(`GUI import fixture failure: ${await diagnostic()}`, { cause: error })
  } finally {
    cleanup()
    surface.happyDOM.setURL(origin)
    clearTimeout(deadline)
    if (child.exitCode === null) child.kill("SIGTERM")
    const forced = setTimeout(() => child.kill("SIGKILL"), 2000)
    const code = await exited
    clearTimeout(forced)
    if (code !== 0 || /Unexpected observer/.test(output)) {
      if (!progress.failed) throw new Error(`GUI import fixture shutdown failed: ${await diagnostic()}`)
      console.error("Private GUI import shutdown failure", await diagnostic())
    }
    if (progress.failed) console.error("Private GUI import evidence retained", root)
    if (!progress.failed) await fs.rm(root, { recursive: true, force: true })
  }
}, 30000)

it("fails closed against old servers without falling back to unmanaged SSE writes", async () => {
  transport.capabilities.mockResolvedValue(response({ features: { importModes: true } }))
  render(() => <ImportSection />)
  await screen.findByText(dict["settings.import.mode.unavailable"])
  expect(screen.getByRole("button", { name: "Import" }).hasAttribute("disabled")).toBe(true)
  expect(transport.importCreate).not.toHaveBeenCalled()
  expect(transport.importList).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it("reopens the same durable job with reads only after the component remounts", async () => {
  rows = [job({ state: "recovery_required", activeBatchID: "batch-unconfirmed", committedBatches: 1 })]
  const view = render(() => <ImportSection />)
  await shownJob("job-fixture")
  expect(screen.getByText(dict["settings.import.job.recovery"])).toBeTruthy()
  view.unmount()
  render(() => <ImportSection />)
  await shownJob("job-fixture")
  expect(screen.getByDisplayValue(/Unconfirmed batch: batch-unconfirmed/)).toBeTruthy()
  expect(screen.getByText(dict["settings.import.job.partial"])).toBeTruthy()
  expect(screen.queryByRole("button", { name: dict["settings.import.job.cancel"] })).toBeNull()
  expect(transport.importCreate).not.toHaveBeenCalled()
  expect(transport.importCancel).not.toHaveBeenCalled()
})

it("retains the original request ID after a lost POST response and retries only on an explicit click", async () => {
  transport.importCreate.mockRejectedValueOnce(new Error("connection lost"))
  render(() => <ImportSection />)
  await screen.findByText(dict["settings.import.job.empty"])
  fireEvent.click(screen.getByRole("button", { name: "Import" }))
  await screen.findByText(dict["settings.import.job.requestUnknown"])
  const original = structuredClone(transport.importCreate.mock.calls[0]![0])
  expect(transport.importCreate).toHaveBeenCalledTimes(1)
  expect(screen.getByRole("button", { name: "Import" }).hasAttribute("disabled")).toBe(true)
  fireEvent.click(screen.getByRole("button", { name: dict["settings.import.job.retryRequest"] }))
  await shownJob("job-fixture")
  expect(transport.importCreate).toHaveBeenCalledTimes(2)
  expect(transport.importCreate.mock.calls[1]![0]).toEqual(original)
  expect(screen.queryByText(dict["settings.import.job.requestUnknown"])).toBeNull()
})

it("finds an accepted request through GET/list after POST response loss without submitting it again", async () => {
  transport.importCreate.mockImplementationOnce(async (parameters: { importJobRequest: ImportJobRequest }) => {
    rows = [job({ requestID: parameters.importJobRequest.requestID })]
    throw new Error("lost response")
  })
  render(() => <ImportSection />)
  await screen.findByText(dict["settings.import.job.empty"])
  fireEvent.click(screen.getByRole("button", { name: "Import" }))
  await screen.findByText(dict["settings.import.job.requestUnknown"])
  fireEvent.click(screen.getAllByRole("button", { name: dict["settings.import.job.refresh"] })[0]!)
  await shownJob("job-fixture")
  expect(transport.importCreate).toHaveBeenCalledTimes(1)
  expect(screen.queryByText(dict["settings.import.job.requestUnknown"])).toBeNull()
})

it("distinguishes requested cancellation from confirmed partial stop", async () => {
  await start()
  fireEvent.click(screen.getByRole("button", { name: dict["settings.import.job.cancel"] }))
  await screen.findByText(dict["settings.import.job.cancelPending"])
  expect(screen.queryByText(new RegExp(dict["settings.import.job.stopped"]))).toBeNull()
  rows = [
    job({ ...rows[0], state: "cancelled_partial", revision: 3, committedBatches: 1, stopConfirmedAt: 1700000000003 }),
  ]
  fireEvent.click(screen.getByRole("button", { name: dict["settings.import.job.refreshOne"] }))
  await screen.findByText(new RegExp(dict["settings.import.job.stopped"]))
  expect(screen.getByText(dict["settings.import.job.partial"])).toBeTruthy()
  expect(transport.importCancel).toHaveBeenCalledTimes(1)
  expect(transport.importCreate).toHaveBeenCalledTimes(1)
})

it("keeps the newer cancellation receipt when an older GET returns late", async () => {
  await start()
  await waitFor(() =>
    expect(screen.getByRole("button", { name: dict["settings.import.job.refreshOne"] }).hasAttribute("disabled")).toBe(
      false,
    ),
  )
  const pending = Promise.withResolvers<ReturnType<typeof response<ImportJobInfo>>>()
  transport.importGet.mockReturnValueOnce(pending.promise)
  fireEvent.click(screen.getByRole("button", { name: dict["settings.import.job.refreshOne"] }))
  fireEvent.click(screen.getByRole("button", { name: dict["settings.import.job.cancel"] }))
  await screen.findByText(dict["settings.import.job.cancelPending"])
  pending.resolve(response(job({ revision: 1 })))
  await waitFor(() =>
    expect(screen.getByRole("button", { name: dict["settings.import.job.refreshOne"] }).hasAttribute("disabled")).toBe(
      false,
    ),
  )
  expect(screen.getByText(dict["settings.import.job.cancelPending"])).toBeTruthy()
  expect(screen.queryByRole("button", { name: dict["settings.import.job.cancel"] })).toBeNull()
})

it.each(["server", "credential"])("discards late receipts when the %s generation changes", async (change) => {
  const pending = Promise.withResolvers<ReturnType<typeof response<ImportJobInfo>>>()
  transport.importCreate.mockReturnValue(pending.promise)
  render(() => <ImportSection />)
  await screen.findByText(dict["settings.import.job.empty"])
  fireEvent.click(screen.getByRole("button", { name: "Import" }))
  await waitFor(() => expect(transport.importCreate).toHaveBeenCalledTimes(1))
  if (change === "server") setServer({ key: "two", current: { http: { url: "http://fixture-two", password: "one" } } })
  if (change === "credential") setServer("current", "http", "password", "two")
  pending.resolve(response(job()))
  await screen.findByText(dict["settings.import.job.switched"])
  expect(screen.queryByText(/Job: job-fixture/)).toBeNull()
  expect(screen.queryByText(/DB: \/isolated/)).toBeNull()
  expect(screen.getByRole("button", { name: "Import" }).hasAttribute("disabled")).toBe(true)
})

it("retains target and backup evidence when a later read fails", async () => {
  await start()
  await waitFor(() =>
    expect(screen.getByRole("button", { name: dict["settings.import.job.refreshOne"] }).hasAttribute("disabled")).toBe(
      false,
    ),
  )
  transport.importGet.mockRejectedValueOnce(new Error("offline"))
  fireEvent.click(screen.getByRole("button", { name: dict["settings.import.job.refreshOne"] }))
  await screen.findByText(dict["settings.import.job.loadFailed"])
  expect(screen.getByDisplayValue(/Backup: \/isolated\/imports\/fixture-copy\/backup\/before-import.db/)).toBeTruthy()
  expect(transport.importCreate).toHaveBeenCalledTimes(1)
})

it("uses native keyboard activation for the import action", async () => {
  const user = userEvent.setup()
  render(() => <ImportSection />)
  await screen.findByText(dict["settings.import.job.empty"])
  const button = screen.getByRole("button", { name: "Import" })
  for (let index = 0; index < 20 && document.activeElement !== button; index++) await user.tab()
  expect(document.activeElement).toBe(button)
  await user.keyboard("{Enter}")
  await shownJob("job-fixture")
  expect(transport.importCreate).toHaveBeenCalledTimes(1)
})

it("remembers an explicitly selected older job without submitting another import", async () => {
  const user = userEvent.setup()
  rows = [job({ id: "job-newer", state: "completed" }), job({ id: "job-older", state: "failed" })]
  const view = render(() => <ImportSection />)
  await shownJob("job-newer")
  await user.click(screen.getByRole("button", { name: /codex · Completed/ }))
  await user.click(await screen.findByRole("option", { name: /Failed/ }))
  await shownJob("job-older")
  view.unmount()
  render(() => <ImportSection />)
  await shownJob("job-older")
  expect(transport.importCreate).not.toHaveBeenCalled()
})

it("drops a pending creation response after unmount without starting observation requests", async () => {
  const pending = Promise.withResolvers<ReturnType<typeof response<ImportJobInfo>>>()
  transport.importCreate.mockReturnValueOnce(pending.promise)
  const view = render(() => <ImportSection />)
  await screen.findByText(dict["settings.import.job.empty"])
  fireEvent.click(screen.getByRole("button", { name: "Import" }))
  await waitFor(() => expect(transport.importCreate).toHaveBeenCalledTimes(1))
  view.unmount()
  pending.resolve(response(job()))
  await pending.promise
  await Promise.resolve()
  expect(transport.importList).toHaveBeenCalledTimes(1)
  expect(transport.importGet).not.toHaveBeenCalled()
  expect(transport.importCancel).not.toHaveBeenCalled()
})

it("recovers from a capability read failure using reads only", async () => {
  transport.capabilities.mockRejectedValueOnce(new Error("offline"))
  render(() => <ImportSection />)
  await screen.findByText(dict["settings.import.job.loadFailed"])
  expect(screen.getByRole("button", { name: "Import" }).hasAttribute("disabled")).toBe(true)
  fireEvent.click(screen.getByRole("button", { name: dict["settings.import.job.refresh"] }))
  await screen.findByText(dict["settings.import.job.empty"])
  expect(transport.importCreate).not.toHaveBeenCalled()
})

it("does not offer an uncertain retry for an explicitly rejected request", async () => {
  transport.importCreate.mockResolvedValueOnce({
    error: { error: "IMPORT_TARGET_BUSY" },
    response: new Response("", { status: 409 }),
  })
  render(() => <ImportSection />)
  await screen.findByText(dict["settings.import.job.empty"])
  fireEvent.click(screen.getByRole("button", { name: "Import" }))
  await screen.findByText(dict["settings.import.job.rejected"])
  expect(screen.getByText(/IMPORT_TARGET_BUSY/)).toBeTruthy()
  expect(screen.queryByRole("button", { name: dict["settings.import.job.retryRequest"] })).toBeNull()
})

it("keeps ZIP/legacy snapshots explicitly outside durable job semantics", async () => {
  const user = userEvent.setup()
  transport.importSnapshot.mockResolvedValue(response({ sessionID: "archive-only", messages: 1, parts: 1 }))
  render(() => <ImportSection />)
  await screen.findByText(dict["settings.import.job.empty"])
  await user.click(screen.getByRole("button", { name: "Codex" }))
  await user.click(await screen.findByRole("option", { name: dict["settings.import.preset.deepagent"] }))
  await screen.findByText(dict["settings.import.snapshot.boundary"])
  fireEvent.change(screen.getByLabelText(dict["settings.import.bundle.file"]), {
    target: { files: [new File(["{}"], "archive.json", { type: "application/json" })] },
  })
  fireEvent.click(screen.getByRole("button", { name: "Import" }))
  await screen.findByText(dict["settings.import.bundle.done"])
  expect(transport.importSnapshot).toHaveBeenCalledTimes(1)
  expect(transport.importCreate).not.toHaveBeenCalled()
})

it("polls the existing active job at five seconds and stops polling on unmount", async () => {
  vi.useFakeTimers()
  rows = [job()]
  const view = render(() => <ImportSection />)
  await vi.advanceTimersByTimeAsync(0)
  expect(transport.importGet).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(4999)
  expect(transport.importGet).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(transport.importGet).toHaveBeenCalledTimes(2)
  view.unmount()
  await vi.advanceTimersByTimeAsync(10000)
  expect(transport.importGet).toHaveBeenCalledTimes(2)
  expect(transport.importCreate).not.toHaveBeenCalled()
  expect(transport.importCancel).not.toHaveBeenCalled()
})

it("retains loaded older pages when the job history is refreshed", async () => {
  const user = userEvent.setup()
  rows = [job({ id: "job-newer", state: "completed" }), job({ id: "job-older", state: "failed" })]
  transport.importList.mockImplementation(async ({ cursor }: { cursor?: string }) =>
    response(cursor ? { items: [rows[1]] } : { items: [rows[0]], cursor: "next-page" }),
  )
  render(() => <ImportSection />)
  await shownJob("job-newer")
  fireEvent.click(screen.getByRole("button", { name: dict["settings.import.job.more"] }))
  await waitFor(() => expect(screen.queryByRole("button", { name: dict["settings.import.job.more"] })).toBeNull())
  fireEvent.click(screen.getByRole("button", { name: dict["settings.import.job.refresh"] }))
  await waitFor(() => expect(transport.importList).toHaveBeenCalledTimes(4))
  await user.click(screen.getByRole("button", { name: /codex · Completed/ }))
  expect(await screen.findByRole("option", { name: /Failed/ })).toBeTruthy()
  expect(transport.importCreate).not.toHaveBeenCalled()
})

it("retains only an unresolved request ID across remount and finds later admission using reads only", async () => {
  const pending = Promise.withResolvers<ReturnType<typeof response<ImportJobInfo>>>()
  transport.importCreate.mockReturnValueOnce(pending.promise)
  const view = render(() => <ImportSection />)
  await screen.findByText(dict["settings.import.job.empty"])
  fireEvent.click(screen.getByRole("button", { name: "Import" }))
  await waitFor(() => expect(transport.importCreate).toHaveBeenCalledTimes(1))
  const requestID = transport.importCreate.mock.calls[0][0].importJobRequest.requestID
  expect(sessionStorage.length).toBe(1)
  expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(requestID)
  view.unmount()
  render(() => <ImportSection />)
  await screen.findByText(dict["settings.import.job.restoredUnknown"])
  expect(screen.getByText(requestID)).toBeTruthy()
  expect(screen.getByRole("button", { name: "Import" }).hasAttribute("disabled")).toBe(true)
  expect(screen.queryByRole("button", { name: dict["settings.import.job.retryRequest"] })).toBeNull()
  expect(transport.importCreate).toHaveBeenCalledTimes(1)
  rows = [job({ requestID })]
  pending.resolve(response(rows[0]))
  fireEvent.click(screen.getAllByRole("button", { name: dict["settings.import.job.refresh"] })[0])
  await shownJob("job-fixture")
  expect(screen.queryByText(dict["settings.import.job.restoredUnknown"])).toBeNull()
  expect(transport.importCreate).toHaveBeenCalledTimes(1)
  expect(transport.importCancel).not.toHaveBeenCalled()
  expect(sessionStorage.length).toBe(1)
  expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe("job-fixture")
})

it("allows explicit release of an unresolved observation guard without claiming cancellation", async () => {
  transport.importCreate.mockRejectedValueOnce(new Error("lost receipt"))
  render(() => <ImportSection />)
  await screen.findByText(dict["settings.import.job.empty"])
  fireEvent.click(screen.getByRole("button", { name: "Import" }))
  await screen.findByText(dict["settings.import.job.guardHint"])
  fireEvent.click(screen.getByRole("button", { name: dict["settings.import.job.releaseGuard"] }))
  await screen.findByText(dict["settings.import.job.guardReleased"])
  expect(screen.getByRole("button", { name: "Import" }).hasAttribute("disabled")).toBe(false)
  expect(screen.queryByText(dict["settings.import.job.stopped"])).toBeNull()
  expect(transport.importCreate).toHaveBeenCalledTimes(1)
  expect(transport.importCancel).not.toHaveBeenCalled()
  expect(sessionStorage.length).toBe(0)
})

it("requires an explicit custom source instead of silently importing the preset directory", async () => {
  const user = userEvent.setup()
  render(() => <ImportSection />)
  await screen.findByText(dict["settings.import.job.empty"])
  await user.click(screen.getByRole("button", { name: "Codex" }))
  await user.click(await screen.findByRole("option", { name: "Custom" }))
  expect(screen.getByRole("button", { name: "Import" }).hasAttribute("disabled")).toBe(true)
  fireEvent.input(screen.getByLabelText("Path"), { target: { value: "/isolated/codex-history" } })
  fireEvent.click(screen.getByRole("button", { name: "Import" }))
  await shownJob("job-fixture")
  expect(transport.importCreate.mock.calls[0][0].importJobRequest.sourcePath).toBe("/isolated/codex-history")
})

it("starts with a concise completed summary and keeps diagnostic identifiers collapsed", async () => {
  rows = [job({ state: "completed", committedBatches: 3 })]
  render(() => <ImportSection />)
  await screen.findByText(dict["settings.import.job.copyComplete"])
  expect(screen.getByText("3 / 3")).toBeTruthy()
  expect(screen.getByText(dict["settings.import.job.targetCopy"])).toBeTruthy()
  expect(screen.getByText(dict["settings.import.job.backupVerified"])).toBeTruthy()
  expect(screen.queryByRole("textbox", { name: dict["settings.import.job.diagnosticText"] })).toBeNull()
  expect(screen.queryByText(/Job: job-fixture/)).toBeNull()
  expect(screen.queryByText(/Backup: \/isolated/)).toBeNull()
  expect(screen.getByRole("button", { name: dict["settings.import.job.details"] }).getAttribute("aria-expanded")).toBe(
    "false",
  )
})

it("opens technical details with Tab and Enter, copies the receipt, and restores focus on Escape", async () => {
  const user = userEvent.setup()
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue()
  rows = [job({ state: "completed", committedBatches: 3 })]
  render(() => <ImportSection />)
  const button = await screen.findByRole("button", { name: dict["settings.import.job.details"] })
  for (let index = 0; index < 30 && document.activeElement !== button; index++) await user.tab()
  expect(document.activeElement).toBe(button)
  await user.keyboard("{Enter}")
  await user.tab()
  expect(document.activeElement).toBe(screen.getByRole("button", { name: dict["settings.import.job.copyDetails"] }))
  await user.keyboard("{Enter}")
  await screen.findByText(dict["settings.import.job.copied"])
  expect(write).toHaveBeenCalledWith(expect.stringContaining("Job: job-fixture\nRequest: request-fixture"))
  expect(write).toHaveBeenCalledWith(expect.stringContaining("Manifest: /isolated/backup.manifest"))
  expect(write).toHaveBeenCalledWith(expect.stringContaining(`SHA-256: ${"a".repeat(64)}`))
  await user.tab()
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: dict["settings.import.job.diagnosticText"] }))
  await user.keyboard("{Escape}")
  expect(button.getAttribute("aria-expanded")).toBe("false")
  expect(document.activeElement).toBe(button)
  expect(screen.queryByRole("textbox", { name: dict["settings.import.job.diagnosticText"] })).toBeNull()
  expect(transport.importCreate).not.toHaveBeenCalled()
  expect(transport.importCancel).not.toHaveBeenCalled()
})

it.each(["cancel_requested", "cancelled_partial", "recovery_required"] as const)(
  "keeps %s evidence actionable without opening technical details",
  async (state) => {
    rows = [
      job({
        state,
        committedBatches: 1,
        cancelRequestedAt: 1700000000002,
        ...(state === "cancelled_partial" ? { stopConfirmedAt: 1700000000003 } : {}),
      }),
    ]
    render(() => <ImportSection />)
    await screen.findByText("1 / 3")
    expect(screen.getByText(dict["settings.import.job.partial"])).toBeTruthy()
    expect(screen.queryByRole("textbox", { name: dict["settings.import.job.diagnosticText"] })).toBeNull()
    if (state === "cancel_requested") expect(screen.getByText(dict["settings.import.job.cancelPending"])).toBeTruthy()
    if (state === "cancelled_partial")
      expect(screen.getByText(new RegExp(dict["settings.import.job.stopped"]))).toBeTruthy()
    if (state === "recovery_required") expect(screen.getByText(dict["settings.import.job.recovery"])).toBeTruthy()
    expect(screen.queryByText(dict["settings.import.job.copyComplete"])).toBeNull()
  },
)

it("does not turn missing backup evidence or a preview into a verified backup", async () => {
  rows = [job({ state: "failed", target: undefined })]
  const view = render(() => <ImportSection />)
  await screen.findByText(dict["settings.import.job.backupPending"])
  expect(screen.getByText(dict["settings.import.job.targetPending"])).toBeTruthy()
  expect(screen.queryByText(dict["settings.import.job.backupVerified"])).toBeNull()
  view.unmount()
  rows = [job({ state: "completed", dryRun: true, target: { ...target, backup: undefined, dryRun: true } })]
  render(() => <ImportSection />)
  await screen.findByText(dict["settings.import.job.backupPreview"])
  expect(screen.getByText(dict["settings.import.job.identified"])).toBeTruthy()
  expect(screen.queryByText(dict["settings.import.job.copyComplete"])).toBeNull()
})

it("drops an old copy acknowledgement and removes open details when credentials change", async () => {
  const user = userEvent.setup()
  const pending = Promise.withResolvers<void>()
  vi.spyOn(navigator.clipboard, "writeText").mockReturnValue(pending.promise)
  rows = [job({ state: "completed" })]
  render(() => <ImportSection />)
  await shownJob("job-fixture")
  await user.click(screen.getByRole("button", { name: dict["settings.import.job.copyDetails"] }))
  setServer("current", "http", "password", "different")
  pending.resolve()
  await screen.findByText(dict["settings.import.job.switched"])
  expect(screen.queryByRole("textbox", { name: dict["settings.import.job.diagnosticText"] })).toBeNull()
  expect(screen.queryByText(dict["settings.import.job.copied"])).toBeNull()
  expect(screen.queryByText(/\/isolated/)).toBeNull()
})

it("keeps selectable receipts when clipboard permission is unavailable", async () => {
  const user = userEvent.setup()
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("permission unavailable"))
  rows = [job({ state: "completed" })]
  render(() => <ImportSection />)
  await shownJob("job-fixture")
  await user.click(screen.getByRole("button", { name: dict["settings.import.job.copyDetails"] }))
  await screen.findByText(dict["settings.import.job.copyFailed"])
  const text = screen.getByRole("textbox", { name: dict["settings.import.job.diagnosticText"] }) as HTMLTextAreaElement
  expect(text.readOnly).toBe(true)
  expect(text.disabled).toBe(false)
  expect(text.value).toContain("DB: /isolated/imports/fixture-copy/data/import.db")
})

it("ignores a late copy acknowledgement after details were closed and reopened", async () => {
  const user = userEvent.setup()
  const pending = Promise.withResolvers<void>()
  vi.spyOn(navigator.clipboard, "writeText")
    .mockReturnValueOnce(pending.promise)
    .mockRejectedValueOnce(new Error("denied"))
  rows = [job({ state: "completed" })]
  render(() => <ImportSection />)
  await shownJob("job-fixture")
  await user.click(screen.getByRole("button", { name: dict["settings.import.job.copyDetails"] }))
  const button = screen.getByRole("button", { name: dict["settings.import.job.details"] })
  await user.click(button)
  await user.click(button)
  await user.click(screen.getByRole("button", { name: dict["settings.import.job.copyDetails"] }))
  await screen.findByText(dict["settings.import.job.copyFailed"])
  pending.resolve()
  await pending.promise
  expect(screen.queryByText(dict["settings.import.job.copied"])).toBeNull()
  expect(screen.getByText(dict["settings.import.job.copyFailed"])).toBeTruthy()
})

it("captures disclosure Escape before an outer dialog's document dismissal listener", async () => {
  const user = userEvent.setup()
  const dismiss = vi.fn((event: KeyboardEvent) => {
    if (event.key === "Escape") event.preventDefault()
  })
  document.addEventListener("keydown", dismiss, true)
  rows = [job({ state: "completed" })]
  const view = render(() => <ImportSection />)
  await shownJob("job-fixture")
  const text = screen.getByRole("textbox", { name: dict["settings.import.job.diagnosticText"] })
  await user.click(text)
  dismiss.mockClear()
  await user.keyboard("{Escape}")
  expect(dismiss).not.toHaveBeenCalled()
  expect(screen.getByRole("button", { name: dict["settings.import.job.details"] }).getAttribute("aria-expanded")).toBe(
    "false",
  )
  expect(document.activeElement).toBe(screen.getByRole("button", { name: dict["settings.import.job.details"] }))
  view.unmount()
  await user.keyboard("{Escape}")
  expect(dismiss).toHaveBeenCalledTimes(1)
  document.removeEventListener("keydown", dismiss, true)
})

it("keeps the real settings dialog open for disclosure Escape and closes it on the next Escape", async () => {
  const user = userEvent.setup()
  rows = [job({ state: "completed" })]
  function Fixture() {
    const dialog = useDialog()
    return (
      <button
        onClick={() =>
          void dialog.show(() => (
            <Dialog title="Import settings">
              <ImportSection />
            </Dialog>
          ))
        }
      >
        Open import settings
      </button>
    )
  }
  render(() => (
    <DialogProvider>
      <Fixture />
    </DialogProvider>
  ))
  await user.click(screen.getByRole("button", { name: "Open import settings" }))
  await shownJob("job-fixture")
  await user.click(screen.getByRole("textbox", { name: dict["settings.import.job.diagnosticText"] }))
  await user.keyboard("{Escape}")
  await new Promise((resolve) => setTimeout(resolve, 130))
  expect(screen.getByRole("dialog", { name: "Import settings" })).toBeTruthy()
  const details = screen.getByRole("button", { name: dict["settings.import.job.details"] })
  expect(details.getAttribute("aria-expanded")).toBe("false")
  expect(document.activeElement).toBe(details)
  await user.keyboard("{Escape}")
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Import settings" })).toBeNull())
})
