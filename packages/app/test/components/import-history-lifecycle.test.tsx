import { expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createStore } from "solid-js/store"
import { createOpencodeClient, type DeepAgentCodeClient, type ImportJobInfo } from "@deepagent-code/sdk"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Window } from "happy-dom"
import { ImportSection } from "@/components/settings-v2/import-history"
import { dict } from "@/i18n/en"
import { publishImportFixturePacket } from "./fixture/import-control"
import { importFixtureEnvironment } from "./fixture/import-environment"

const [server, setServer] = createStore({
  key: "private-a",
  current: { http: { url: "", password: "lifecycle-private-auth" } },
})
const [owner, setOwner] = createStore({
  scope: "private-a",
  url: "",
  client: undefined as DeepAgentCodeClient | undefined,
})
vi.mock("@/context/server", () => ({ useServer: () => server }))
vi.mock("@/context/server-sdk", () => ({
  useServerSDK: () => ({
    get client() {
      return owner.client!
    },
    get scope() {
      return owner.scope
    },
    get url() {
      return owner.url
    },
  }),
}))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] ?? key, intl: () => "en-US" }),
}))
vi.mock("@deepagent-code/ui/context/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }))

async function processFor(root: string, count: number) {
  await fs.mkdir(path.join(root, "home"), { recursive: true })
  const packageDirectory = path.resolve(process.cwd(), "../deepagent-code")
  const child = spawn(
    "bun",
    ["--preload", path.resolve("test/components/fixture/import-startup.ts"), path.join(packageDirectory, "test/fixture/import-history-lifecycle-server.ts"), root, String(count)],
    {
      cwd: packageDirectory,
      env: importFixtureEnvironment(root),
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  let stdout = ""
  let stderr = ""
  let spawnError: string | undefined
  child.stdout?.on("data", (value: Buffer) => {
    stdout = (stdout + value.toString()).slice(-65536)
  })
  child.stderr?.on("data", (value: Buffer) => {
    stderr = (stderr + value.toString()).slice(-65536)
  })
  child.once("error", (error) => {
    spawnError = error.message
  })
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve))
  const diagnostic = async () =>
    JSON.stringify({
      root,
      pid: child.pid,
      exitCode: child.exitCode,
      signal: child.signalCode,
      spawnError,
      readyPath: path.join(root, "ready.json"),
      resultFiles: (await fs.readdir(root))
        .filter((name) => name.endsWith(".json"))
        .map((name) => path.join(root, name)),
      startup: await fs.readFile(path.join(root, "startup.jsonl"), "utf8").catch(() => null),
      stdout,
      stderr,
    })
  const deadline = setTimeout(() => child.kill("SIGTERM"), 60_000)
  const ready = await waitFor(
    async () => {
      if (child.exitCode !== null || child.signalCode !== null || spawnError)
        throw new Error(`Private import fixture ended: ${await diagnostic()}`)
      return JSON.parse(await fs.readFile(path.join(root, "ready.json"), "utf8")) as {
        url: string
        sourcePath: string
        count: number
        packetSourcePath: string
        packetCount: number
      }
    },
    { timeout: 15_000 },
  ).catch(async (error: unknown) => {
    clearTimeout(deadline)
    child.kill("SIGTERM")
    const force = setTimeout(() => child.kill("SIGKILL"), 2000)
    await exited
    clearTimeout(force)
    throw new Error(`Private import fixture not ready: ${String(error)}\n${await diagnostic()}`, { cause: error })
  })
  const calls: { method: string; path: string }[] = []
  const transport = {
    gate: undefined as Promise<void> | undefined,
    accepted: undefined as ImportJobInfo | undefined,
    received: undefined as { status: number; body: unknown } | undefined,
    error: undefined as string | undefined,
  }
  const client = createOpencodeClient({
    baseUrl: ready.url,
    headers: { Authorization: `Basic ${btoa("deepagent-code:lifecycle-private-auth")}` },
    fetch: Object.assign(
      async (request: RequestInfo | URL) => {
        const incoming = request instanceof Request ? request : new Request(request)
        const route = new URL(incoming.url).pathname
        calls.push({ method: incoming.method, path: route })
        const response = await fetch(request).catch((error: unknown) => {
          transport.error = String(error)
          throw error
        })
        if (incoming.method === "POST" && route === "/global/import/jobs") {
          const text = await response.text()
          transport.received = { status: response.status, body: text }
          const body: unknown = JSON.parse(text)
          transport.accepted = body as ImportJobInfo
          // Only packet delivery is held. The original authenticated route already
          // admitted the job and its original worker continues independently.
          await transport.gate
          // HappyDOM cannot tee this socket-backed response with clone(). Preserve
          // the original bytes/status/headers while delaying their delivery.
          return new Response(text, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        }
        return response
      },
      { preconnect: fetch.preconnect },
    ),
  })
  return {
    root,
    ready,
    client,
    calls,
    transport,
    diagnostic,
    posts: () => calls.filter((call) => call.method === "POST" && call.path === "/global/import/jobs").length,
    async close() {
      clearTimeout(deadline)
      if (child.exitCode === null) child.kill("SIGTERM")
      const force = setTimeout(() => child.kill("SIGKILL"), 2000)
      const code = await exited
      clearTimeout(force)
      expect(code, code === 0 ? undefined : await diagnostic()).toBe(0)
      expect(
        stdout + stderr,
        (stdout + stderr).includes("Unexpected observer") ? await diagnostic() : undefined,
      ).not.toContain("Unexpected observer")
    },
  }
}

async function chooseSource(sourcePath: string) {
  const user = userEvent.setup()
  await waitFor(() => expect(screen.getByRole("button", { name: "Import" }).hasAttribute("disabled")).toBe(false))
  await user.click(screen.getByRole("button", { name: "Codex" }))
  await user.click(await screen.findByRole("option", { name: dict["settings.import.preset.custom"] }))
  fireEvent.input(screen.getByRole("textbox", { name: dict["settings.import.customPath"] }), {
    target: { value: sourcePath },
  })
  const picker = screen.getByRole("button", { name: "Codex" })
  await user.click(picker)
  await waitFor(() => expect(document.getElementById(picker.getAttribute("aria-controls") ?? "")).not.toBeNull())
  const menu = within(document.getElementById(picker.getAttribute("aria-controls")!)!)
  await user.click(menu.getAllByRole("option").find((option) => option.textContent?.trim() === "Claude Code")!)
  fireEvent.click(screen.getByRole("checkbox", { name: "Memory" }))
  fireEvent.click(screen.getByRole("checkbox", { name: "Skills" }))
  fireEvent.click(screen.getByRole("button", { name: "Import" }))
}
async function diagnostics(jobID: string) {
  const button = await screen.findByRole("button", { name: dict["settings.import.job.details"] })
  if (button.getAttribute("aria-expanded") !== "true") fireEvent.click(button)
  await waitFor(() =>
    expect(
      (screen.getByRole("textbox", { name: dict["settings.import.job.diagnosticText"] }) as HTMLTextAreaElement).value,
    ).toContain(`Job: ${jobID}`),
  )
}

it("actual durable copy jobs isolate scope/instance/unmount packet loss, reopen with reads, and cancel only a proven committed boundary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dac-import-product-lifecycle-"))
  const surface = window as unknown as Window
  const origin = window.location.href
  const processes: Awaited<ReturnType<typeof processFor>>[] = []
  const gates: ReturnType<typeof Promise.withResolvers<void>>[] = []
  const progress = { phase: "startup", startedAt: Date.now(), failed: false }
  try {
    const a = await processFor(path.join(root, "a"), 400)
    processes.push(a)
    expect(a.ready.packetCount).toBe(2)
    const b = await processFor(path.join(root, "b"), 0)
    processes.push(b)
    surface.happyDOM.setURL(a.ready.url)
    setServer({ key: "private-a", current: { http: { url: a.ready.url, password: "lifecycle-private-auth" } } })
    setOwner({ scope: "private-a", url: a.ready.url, client: a.client })
    const gate = Promise.withResolvers<void>()
    gates.push(gate)
    a.transport.gate = gate.promise
    let view = render(() => <ImportSection />)
    await chooseSource(a.ready.sourcePath)
    await waitFor(() => {
      if (!a.transport.accepted?.id)
        throw new Error(
          `Original create receipt: ${JSON.stringify({ received: a.transport.received, error: a.transport.error, calls: a.calls })}`,
        )
    })
    const first = a.transport.accepted!
    expect(first.scopes).toEqual(["session", "memory", "skill"])
    expect(screen.getByRole("checkbox", { name: "Memory" }).hasAttribute("disabled")).toBe(true)
    progress.phase = "partial committed boundary"
    await publishImportFixturePacket(path.join(a.root, "monitor.json"), { jobID: first.id })
    // A real immutable destination receipt opens this test boundary. No job row,
    // target lock or executor is modified to create a partial state.
    const committed = await waitFor(
      async () =>
        JSON.parse(await fs.readFile(path.join(a.root, "first-commit.json"), "utf8")) as {
          count: number
          jobID: string
          state: string
        },
      { timeout: 15_000 },
    )
    expect(committed.jobID).toBe(first.id)
    expect(committed.count).toBeGreaterThan(0)
    setOwner("scope", "private-a-new-owner")
    gate.resolve()
    await screen.findByText(dict["settings.import.job.switched"])
    expect(screen.queryByText(dict["settings.import.job.current"])).toBeNull()
    expect(a.posts()).toBe(1)
    view.unmount()
    a.transport.gate = undefined
    view = render(() => <ImportSection />)
    await screen.findByText(dict["settings.import.job.current"])
    const cancel = await screen.findByRole("button", { name: dict["settings.import.job.cancel"] })
    fireEvent.click(cancel)
    await waitFor(() =>
      expect(a.calls.filter((call) => call.method === "POST" && call.path.endsWith("/cancel"))).toHaveLength(1),
    )
    await waitFor(
      async () => {
        const result = await a.client.global.importGet({ jobID: first.id })
        expect(result.data?.state).toBe("cancelled_partial")
        expect(result.data?.stopConfirmedAt).toBeTruthy()
      },
      { timeout: 10_000 },
    )
    fireEvent.click(screen.getByRole("button", { name: dict["settings.import.job.refreshOne"] }))
    await screen.findByText(new RegExp(dict["settings.import.job.stopped"]))
    expect(screen.getByText(dict["settings.import.job.partial"])).toBeTruthy()
    await diagnostics(first.id)
    await publishImportFixturePacket(path.join(a.root, "inspect.json"), { jobID: first.id, name: "partial-proof" })
    const partial = await waitFor(
      async () =>
        JSON.parse(await fs.readFile(path.join(a.root, "partial-proof.json"), "utf8")) as {
          before: unknown
          after: unknown
          sourceBefore: unknown
          sourceAfter: unknown
          proof: { count: number; results: unknown[]; fileResults: unknown[] }
          target: { sessions: number; messages: number }
          liveSessions: unknown[]
          job: ImportJobInfo
          jobs: unknown[]
        },
      { timeout: 10_000 },
    )
    expect(partial.after).toEqual(partial.before)
    expect(partial.sourceAfter).toEqual(partial.sourceBefore)
    expect(partial.liveSessions).toEqual([])
    expect(partial.target.sessions).toBe(partial.proof.results.length)
    expect(partial.target.sessions).toBeGreaterThan(0)
    expect(partial.target.sessions).toBeLessThan(400)
    expect(partial.job.committedBatches).toBe(partial.proof.count)
    view.unmount()

    for (const change of ["instance", "unmount"] as const) {
      progress.phase = `${change} packet loss`
      surface.happyDOM.setURL(a.ready.url)
      setServer({ key: "private-a", current: { http: { url: a.ready.url, password: "lifecycle-private-auth" } } })
      setOwner({ scope: "private-a", url: a.ready.url, client: a.client })
      const packet = Promise.withResolvers<void>()
      gates.push(packet)
      a.transport.gate = packet.promise
      a.transport.accepted = undefined
      view = render(() => <ImportSection />)
      const beforePosts = a.posts()
      // Only the first job needs a large source to observe a real partial cancel.
      // Packet delivery and owner lifetime use complete small copies of all scopes.
      await chooseSource(a.ready.packetSourcePath)
      await waitFor(() => expect(a.transport.accepted?.id).toBeTruthy())
      const accepted = a.transport.accepted!
      if (change === "instance") {
        surface.happyDOM.setURL(b.ready.url)
        setServer({ key: "private-b", current: { http: { url: b.ready.url, password: "lifecycle-private-auth" } } })
        setOwner({ scope: "private-b", url: b.ready.url, client: b.client })
        await screen.findByText(dict["settings.import.job.switched"])
      }
      view.unmount()
      const beforeRead = a.calls.length
      packet.resolve()
      await Promise.resolve()
      expect(a.calls.length).toBe(beforeRead)
      expect(a.posts()).toBe(beforePosts + 1)
      if (change === "instance") {
        view = render(() => <ImportSection />)
        await screen.findByText(dict["settings.import.job.empty"])
        expect(b.posts()).toBe(0)
        expect(screen.queryByText(dict["settings.import.job.current"])).toBeNull()
        view.unmount()
      }
      surface.happyDOM.setURL(a.ready.url)
      await waitFor(
        async () => {
          const current = await a.client.global.importGet({ jobID: accepted.id })
          expect(
            current.data?.state,
            JSON.stringify({
              phase: progress.phase,
              elapsedMs: Date.now() - progress.startedAt,
              job: current.data,
              error: current.error,
              process: await a.diagnostic(),
            }),
          ).toBe("completed")
          expect(current.data?.committedSessions).toBe(a.ready.packetCount)
          expect(current.data?.fileResults).toHaveLength(2)
        },
        { timeout: 15_000 },
      )
      surface.happyDOM.setURL(a.ready.url)
      setServer({ key: "private-a", current: { http: { url: a.ready.url, password: "lifecycle-private-auth" } } })
      setOwner({ scope: "private-a", url: a.ready.url, client: a.client })
      a.transport.gate = undefined
      view = render(() => <ImportSection />)
      await diagnostics(accepted.id)
      expect(a.posts()).toBe(beforePosts + 1)
      expect(screen.getByText(dict["settings.import.job.copyComplete"])).toBeTruthy()
      view.unmount()
    }
    progress.phase = "final immutable receipts"
    await publishImportFixturePacket(path.join(a.root, "inspect.json"), {
      jobID: a.transport.accepted!.id,
      name: "final-proof",
    })
    const proof = await waitFor(
      async () =>
        JSON.parse(await fs.readFile(path.join(a.root, "final-proof.json"), "utf8")) as {
          before: unknown
          after: unknown
          sourceBefore: unknown
          sourceAfter: unknown
          proof: { count: number; results: unknown[]; fileResults: unknown[] }
          target: { sessions: number; messages: number }
          liveSessions: unknown[]
          jobs: unknown[]
        },
      { timeout: 10_000 },
    )
    expect(proof.before).toEqual(proof.after)
    expect(proof.sourceAfter).toEqual(proof.sourceBefore)
    expect(proof.liveSessions).toEqual([])
    expect(proof.target.sessions).toBe(a.ready.packetCount)
    expect(proof.proof.results).toHaveLength(a.ready.packetCount)
    expect(proof.proof.fileResults).toHaveLength(2)
    expect(proof.jobs).toHaveLength(3)
    expect(a.posts()).toBe(3)
    expect(b.posts()).toBe(0)
    if (process.env.DAC_IMPORT_LIFECYCLE_EVIDENCE)
      await fs.writeFile(
        process.env.DAC_IMPORT_LIFECYCLE_EVIDENCE,
        JSON.stringify({ partial, proof, callsA: a.calls, callsB: b.calls }, null, 2),
      )
  } catch (error) {
    progress.failed = true
    throw new Error(
      `Import lifecycle failure: ${JSON.stringify({
        ...progress,
        root,
        processes: await Promise.all(processes.map((process) => process.diagnostic())),
      })}`,
      { cause: error },
    )
  } finally {
    gates.forEach((gate) => gate.resolve())
    cleanup()
    surface.happyDOM.setURL(origin)
    const closed = await Promise.allSettled(processes.map((process) => process.close()))
    if (progress.failed || closed.some((result) => result.status === "rejected"))
      console.error("Private import lifecycle evidence retained", root, closed)
    if (!progress.failed) {
      for (const result of closed) if (result.status === "rejected") throw result.reason
      await fs.rm(root, { recursive: true, force: true })
    }
  }
}, 60_000)
