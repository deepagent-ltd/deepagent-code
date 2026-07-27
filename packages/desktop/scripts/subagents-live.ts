#!/usr/bin/env node
import { strict as assert } from "node:assert"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test"

const MODEL = { providerID: "deepseek", modelID: "deepseek-chat" } as const
const main = resolve("out/main/index.js")
const authFile = process.env.DEEPAGENT_CODE_LIVE_AUTH_FILE ?? join(homedir(), ".deepagent", "code", "auth.json")
const savedAuth = JSON.parse(await readFile(authFile, "utf8")) as Record<string, unknown>
const deepseekAuth = savedAuth.deepseek
assert.equal(isRecord(deepseekAuth) && deepseekAuth.type === "api" && typeof deepseekAuth.key === "string", true)

type Server = { url: string; username: string; password: string }
type Session = {
  id: string
  parentID?: string
  agent?: string
  model?: { id: string; providerID: string }
  metadata?: Record<string, unknown>
}
type Status = { type: "idle" | "busy" | "retry" }
type Message = {
  info: {
    id: string
    role: "user" | "assistant"
    providerID?: string
    modelID?: string
    finish?: string
    error?: unknown
    time: { completed?: number }
  }
  parts: Array<
    | { type: "text"; text: string; synthetic?: boolean; ignored?: boolean }
    | {
        type: "tool"
        tool: string
        state:
          | { status: "pending" | "running" }
          | { status: "completed"; output: string; metadata: Record<string, unknown> }
          | { status: "error"; error: string }
      }
    | { type: string }
  >
}
type ToolPart = Extract<Message["parts"][number], { type: "tool" }>
type Runtime = {
  app: ElectronApplication
  root: string
  workspace: string
  server: Server
}
type PromptRun = { before: Set<string>; messages: Message[] }

const activeApps = new Set<ElectronApplication>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function basic(server: Server) {
  return `Basic ${Buffer.from(`${server.username}:${server.password}`).toString("base64")}`
}

function subagentState(session: Session) {
  const deepagent = isRecord(session.metadata?.deepagent) ? session.metadata.deepagent : undefined
  const subagent = isRecord(deepagent?.subagent) ? deepagent.subagent : undefined
  return {
    state: typeof subagent?.state === "string" ? subagent.state : undefined,
    reason: typeof subagent?.reason === "string" ? subagent.reason : undefined,
  }
}

async function request<T>(runtime: Runtime, pathname: string, init?: RequestInit) {
  const url = new URL(pathname, runtime.server.url)
  url.searchParams.set("directory", runtime.workspace)
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: basic(runtime.server),
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url.pathname} failed with HTTP ${response.status}`)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

async function launch(name: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `deepagent-code-subagents-live-${name}-`)))
  const workspace = join(root, "workspace")
  await mkdir(workspace, { recursive: true })
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  env.DEEPAGENT_CODE_TEST_ONBOARDING = "1"
  env.DEEPAGENT_CODE_TEST_ROOT = root
  env.DEEPAGENT_CODE_DB = join(root, "deepagent.sqlite")
  env.DEEPAGENT_CODE_DISABLE_CHANNEL_DB = "1"
  env.DEEPAGENT_CODE_DISABLE_EXTERNAL_SKILLS = "1"
  env.DEEPAGENT_CODE_DISABLE_LSP_DOWNLOAD = "1"
  env.DEEPAGENT_CODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = "true"
  env.DEEPAGENT_CODE_AUTH_CONTENT = JSON.stringify({ deepseek: deepseekAuth })
  env.DEEPAGENT_CODE_CONFIG_CONTENT = JSON.stringify({
    model: `${MODEL.providerID}/${MODEL.modelID}`,
    permission: { task: "allow", bash: "allow", read: "allow" },
  })

  const app = await electron.launch({ args: [main], env, timeout: 30_000 })
  activeApps.add(app)
  const page = await app.firstWindow({ timeout: 30_000 })
  await page.waitForFunction(() => Boolean((window as unknown as { api?: DesktopAPI }).api))
  const server = await page.evaluate(() => (window as unknown as { api: DesktopAPI }).api.awaitInitialization())
  return { app, root, workspace, server } satisfies Runtime
}

type DesktopAPI = {
  awaitInitialization(): Promise<Server>
}

async function close(runtime: Runtime) {
  await runtime.app.close()
  activeApps.delete(runtime.app)
  if (process.env.DEEPAGENT_CODE_KEEP_LIVE_SMOKE !== "1") {
    await rm(runtime.root, { recursive: true, force: true })
  }
}

async function waitFor<T>(check: () => Promise<T | undefined>, label: string, timeout = 300_000): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function createParent(runtime: Runtime, title: string) {
  return request<Session>(runtime, "/session", {
    method: "POST",
    body: JSON.stringify({
      title,
      agent: "auto",
      model: { id: MODEL.modelID, providerID: MODEL.providerID },
    }),
  })
}

function messages(runtime: Runtime, sessionID: string) {
  return request<Message[]>(runtime, `/session/${sessionID}/message`)
}

function children(runtime: Runtime, sessionID: string) {
  return request<Session[]>(runtime, `/session/${sessionID}/children`)
}

async function startPrompt(runtime: Runtime, sessionID: string, text: string) {
  const before = new Set((await messages(runtime, sessionID)).map((message) => message.info.id))
  await request<void>(runtime, `/session/${sessionID}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({
      model: MODEL,
      agent: "auto",
      system:
        "You are controlling a live subagent E2E test. Follow the requested tool sequence exactly. Do not simulate tool output.",
      parts: [{ type: "text", text }],
    }),
  })
  return before
}

async function finishPrompt(runtime: Runtime, sessionID: string, before: Set<string>, label: string) {
  const fresh = await waitFor(async () => {
    const [all, statuses] = await Promise.all([
      messages(runtime, sessionID),
      request<Record<string, Status>>(runtime, "/session/status"),
    ])
    const next = all.filter((message) => !before.has(message.info.id))
    const active = statuses[sessionID]?.type
    const completed = next.some(
      (message) => message.info.role === "assistant" && message.info.time.completed !== undefined,
    )
    if (completed && active !== "busy" && active !== "retry") return next
  }, label)
  return { before, messages: fresh } satisfies PromptRun
}

async function runPrompt(runtime: Runtime, sessionID: string, text: string, label: string) {
  return finishPrompt(runtime, sessionID, await startPrompt(runtime, sessionID, text), label)
}

function toolParts(run: PromptRun, name: string) {
  return run.messages.flatMap((message) =>
    message.parts.filter((part): part is ToolPart => part.type === "tool" && part.tool === name),
  )
}

function completedTool(run: PromptRun, name: string) {
  const parts = toolParts(run, name)
  const completed = parts.findLast((part) => part.state.status === "completed")
  if (completed?.state.status === "completed") return completed.state
  const failed = parts.findLast((part) => part.state.status === "error")
  throw new Error(`${name} did not complete${failed?.state.status === "error" ? `: ${failed.state.error}` : ""}`)
}

function text(run: PromptRun) {
  return run.messages
    .flatMap((message) =>
      message.parts
        .filter(
          (part): part is Extract<Message["parts"][number], { type: "text" }> =>
            part.type === "text" && !part.synthetic && !part.ignored,
        )
        .map((part) => part.text),
    )
    .join("\n")
}

function assertDeepSeek(messages: Message[]) {
  assert.equal(
    messages.some(
      (message) =>
        message.info.role === "assistant" &&
        message.info.providerID === MODEL.providerID &&
        message.info.modelID === MODEL.modelID,
    ),
    true,
  )
}

async function successScenario() {
  const runtime = await launch("success")
  try {
    const marker = `LIVE_SUCCESS_${randomUUID().replaceAll("-", "")}`
    const fixture = join(runtime.workspace, "success-fixture.txt")
    await writeFile(fixture, `${marker}\n`, "utf8")
    const parent = await createParent(runtime, "Live DeepSeek subagent success")
    const taskRun = await runPrompt(
      runtime,
      parent.id,
      [
        "Call the task tool exactly once and wait for it to finish.",
        'Use subagent_type="researcher" and description="live success fixture".',
        `The child prompt must require reading ${fixture} and returning its exact content ${marker} in the final research result.`,
        "Do not read the file yourself and do not call task_status or task_read yet.",
        `After task returns, include ${marker} in your final response.`,
      ].join("\n"),
      "successful parent task",
    )
    assertDeepSeek(taskRun.messages)
    assert.match(completedTool(taskRun, "task").output, new RegExp(marker))
    assert.match(text(taskRun), new RegExp(marker))

    const child = await waitFor(async () => {
      const items = await children(runtime, parent.id)
      const item = items.find((session) => subagentState(session).state === "completed")
      return item
    }, "completed child session")
    const childMessages = await messages(runtime, child.id)
    assertDeepSeek(childMessages)
    assert.match(JSON.stringify(childMessages), new RegExp(marker))

    const audit = await runPrompt(
      runtime,
      parent.id,
      [
        `The completed child task id is ${child.id}.`,
        "Call task_status exactly once, then call task_read exactly once with that task id.",
        "Do not call task again and do not infer the transcript.",
        `Your final response must include ${marker} and say that the child state is completed.`,
      ].join("\n"),
      "successful task audit",
    )
    const status = completedTool(audit, "task_status").output
    const transcript = completedTool(audit, "task_read").output
    assert.match(status, /\[completed\]/)
    assert.match(status, new RegExp(child.id))
    assert.match(transcript, /state="completed"/)
    assert.match(transcript, new RegExp(marker))
    assert.match(text(audit), new RegExp(marker))
    console.log("Live success scenario passed", { parent: parent.id, child: child.id, state: "completed" })
  } finally {
    await close(runtime)
  }
}

async function interruptedScenario() {
  const runtime = await launch("interrupted")
  try {
    const marker = `LIVE_PARTIAL_${randomUUID().replaceAll("-", "")}`
    const fixture = join(runtime.workspace, "partial-fixture.txt")
    await writeFile(fixture, `${marker}\n`, "utf8")
    const parent = await createParent(runtime, "Live DeepSeek subagent interruption")
    const before = await startPrompt(
      runtime,
      parent.id,
      [
        "Call the task tool exactly once in foreground mode and wait for it.",
        'Use subagent_type="researcher" and description="live interruption fixture".',
        "Give the child these strict instructions:",
        `1. Read ${fixture} with the read tool so its completed tool output contains ${marker}.`,
        "2. After the read completes, run `sleep 120` with the bash tool.",
        "3. Do not return a final answer before the sleep completes.",
        "Do not call task_status or task_read yet.",
      ].join("\n"),
    )
    const child = await waitFor(async () => (await children(runtime, parent.id))[0], "interruption child session")
    await waitFor(async () => {
      const items = await messages(runtime, child.id)
      const recovered = items.some((message) =>
        message.parts.some(
          (part) =>
            part.type === "tool" &&
            part.tool === "read" &&
            part.state.status === "completed" &&
            part.state.output.includes(marker),
        ),
      )
      return recovered ? true : undefined
    }, "recoverable child output")
    await request<boolean>(runtime, `/session/${child.id}/abort`, { method: "POST" })
    const taskRun = await finishPrompt(runtime, parent.id, before, "interrupted parent task")
    assertDeepSeek(taskRun.messages)
    assert.equal(
      toolParts(taskRun, "task").some((part) => part.state.status === "error"),
      true,
    )

    const settled = await waitFor(async () => {
      const item = (await children(runtime, parent.id)).find((session) => session.id === child.id)
      return item && subagentState(item).state ? item : undefined
    }, "interrupted child settlement")
    assert.equal(subagentState(settled).state, "interrupted")

    const audit = await runPrompt(
      runtime,
      parent.id,
      [
        `The interrupted child task id is ${child.id}.`,
        "Call task_status exactly once, then call task_read exactly once with that task id.",
        "Do not call task again. Recover the partial work only from the tool transcript.",
        `Your final response must include ${marker} and say that the child state is interrupted.`,
      ].join("\n"),
      "interrupted task audit",
    )
    const status = completedTool(audit, "task_status").output
    const transcript = completedTool(audit, "task_read").output
    assert.match(status, /\[interrupted\]/)
    assert.match(status, /partial work preserved/)
    assert.match(transcript, /state="interrupted"/)
    assert.match(transcript, new RegExp(marker))
    assert.match(text(audit), new RegExp(marker))
    console.log("Live interruption scenario passed", { parent: parent.id, child: child.id, state: "interrupted" })
  } finally {
    await close(runtime)
  }
}

try {
  await successScenario()
  await interruptedScenario()
  console.log("Live DeepSeek subagent E2E smoke passed")
} finally {
  await Promise.all([...activeApps].map((app) => app.close().catch(() => undefined)))
}
