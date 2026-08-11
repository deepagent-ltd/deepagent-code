import { strict as assert } from "node:assert"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test"

export type LiveConfig = {
  baseURL: string
  modelID: string
  modelRevision?: string
  apiKey: string
  apiKeyFile: string
  timeoutMs: number
}
export type Server = { url: string; username: string; password: string }
export type Session = {
  id: string
  parentID?: string
  agent?: string
  model?: { id: string; providerID: string }
  metadata?: Record<string, unknown>
}
export type Status = { type: "idle" | "busy" | "retry" }
export type PermissionRequest = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  tool?: { messageID: string; callID: string }
}
export type QuestionRequest = {
  id: string
  sessionID: string
  questions: Array<{ question: string; options: Array<{ label: string }> }>
  tool?: { messageID: string; callID: string }
}
export type Message = {
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
          | { status: "pending"; input?: unknown }
          | { status: "running"; input: unknown }
          | { status: "completed"; input: unknown; output: string; metadata: Record<string, unknown> }
          | { status: "error"; input: unknown; error: string }
      }
    | { type: string }
  >
}
export type ToolPart = Extract<Message["parts"][number], { type: "tool" }>
export type Runtime = {
  app: ElectronApplication
  page: Page
  root: string
  workspace: string
  server: Server
  config: LiveConfig
  env: Record<string, string>
  permissionRequests: PermissionRequest[]
  permissionErrors: string[]
  permissionAbort: AbortController
  permissionTask: Promise<void>
  cleanupRoot: boolean
}

export type LaunchOptions = {
  root?: string
  executablePath?: string
  environment?: Readonly<Record<string, string>>
  cleanupRoot?: boolean
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const main = path.join(packageRoot, "out/main/index.js")
const activeApps = new Set<ElectronApplication>()
const activePermissionMonitors = new Map<ElectronApplication, { abort: AbortController; task: Promise<void> }>()

export async function loadLiveConfig() {
  if (process.env.DEEPAGENT_CODE_LIVE_LLM_API_KEY?.trim() || process.env.DEEPSEEK_API_KEY?.trim()) {
    throw new Error(
      "Raw API key environment variables are not accepted by live LLM tests; " +
        "set DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE to a chmod 600 key file",
    )
  }
  const apiKeyFile = await validateKeyFile(process.env.DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE)
  const apiKey = (await readFile(apiKeyFile, "utf8")).trim()
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error("Live LLM key file must contain exactly one non-empty line")
  const baseURL = (process.env.DEEPAGENT_CODE_LIVE_LLM_BASE_URL?.trim() || "https://api.deepseek.com").replace(
    /\/$/,
    "",
  )
  const endpoint = new URL(baseURL)
  if (endpoint.protocol !== "https:" || endpoint.hostname !== "api.deepseek.com") {
    throw new Error(`Official DeepSeek live tests require https://api.deepseek.com, received ${baseURL}`)
  }
  const timeoutMs = Number(process.env.DEEPAGENT_CODE_LIVE_LLM_TIMEOUT_MS || 180_000)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15 * 60_000) {
    throw new Error("DEEPAGENT_CODE_LIVE_LLM_TIMEOUT_MS must be an integer between 1000 and 900000")
  }
  return {
    baseURL,
    modelID: process.env.DEEPAGENT_CODE_LIVE_LLM_MODEL?.trim() || "deepseek-v4-flash",
    modelRevision: process.env.DEEPAGENT_CODE_LIVE_LLM_REVISION?.trim() || undefined,
    apiKey,
    apiKeyFile,
    timeoutMs,
  } satisfies LiveConfig
}

export async function preflight(config: LiveConfig) {
  const startedAt = Date.now()
  const response = await fetch(`${config.baseURL}/models`, {
    headers: { authorization: `Bearer ${config.apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(Math.min(config.timeoutMs, 30_000)),
  })
  if (!response.ok) throw new Error(`DeepSeek model preflight failed with HTTP ${response.status}`)
  const payload: unknown = await response.json()
  if (!isRecord(payload) || !Array.isArray(payload.data))
    throw new Error("DeepSeek model preflight returned invalid JSON")
  const models = payload.data.flatMap((item) => (isRecord(item) && typeof item.id === "string" ? [item.id] : []))
  if (!models.includes(config.modelID)) {
    throw new Error(`DeepSeek model ${config.modelID} is not available; reported models: ${models.join(", ")}`)
  }
  return { durationMs: Date.now() - startedAt }
}

export async function launch(name: string, config: LiveConfig, options: LaunchOptions = {}) {
  const root = options.root
    ? await realpath(options.root)
    : await realpath(await mkdtemp(path.join(os.tmpdir(), `deepagent-code-${name}-`)))
  const workspace = path.join(root, "workspace")
  await mkdir(workspace, { recursive: true })
  const env = Object.fromEntries(
    [
      "PATH",
      "TMPDIR",
      "SHELL",
      "LANG",
      "LC_ALL",
      "TERM",
      "USER",
      "LOGNAME",
      "DISPLAY",
      "WAYLAND_DISPLAY",
      "XAUTHORITY",
      "DBUS_SESSION_BUS_ADDRESS",
      "SystemRoot",
      "WINDIR",
      "ComSpec",
      "PATHEXT",
    ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  )
  Object.assign(
    env,
    {
      HOME: path.join(root, "home"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      DEEPAGENT_CODE_TEST_ONBOARDING: "1",
      DEEPAGENT_CODE_TEST_ROOT: root,
      DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
      DEEPAGENT_CODE_DB: path.join(root, "deepagent.sqlite"),
      DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1",
      DEEPAGENT_CODE_DISABLE_CHANNEL_DB: "1",
      DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS: "1",
      DEEPAGENT_CODE_DISABLE_EXTERNAL_SKILLS: "1",
      DEEPAGENT_CODE_DISABLE_LSP_DOWNLOAD: "1",
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
      DEEPAGENT_CODE_DISABLE_SHELL_ENV: "1",
      DEEPAGENT_CODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true",
      DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE: config.apiKeyFile,
      DEEPAGENT_ENABLED: "false",
      DEEPAGENT_CODE_CONFIG_CONTENT: JSON.stringify({
        snapshot: false,
        enabled_providers: ["live-deepseek"],
        model: `live-deepseek/${config.modelID}`,
        permission: { "*": "deny", read: "allow", question: "allow" },
        agent: {
          auto: {
            mode: "primary",
            prompt:
              "When a visible isolated desktop contract test is requested, follow its tool sequence exactly and do not simulate tool output.",
            permission: {
              "*": "deny",
              task: "allow",
              task_status: "allow",
              task_read: "allow",
              read: "allow",
              edit: "allow",
              question: "allow",
            },
          },
          "live-parent": {
            mode: "primary",
            prompt:
              "This is a constrained desktop contract test. Follow the requested tool sequence exactly and do not simulate tool output.",
            permission: { "*": "deny", task: "allow", task_status: "allow", task_read: "allow", read: "deny" },
          },
          "live-ui": {
            mode: "primary",
            prompt:
              "This is a constrained desktop UI contract test. Follow the requested tool sequence exactly and do not simulate tool output.",
            permission: { "*": "deny", read: "allow" },
          },
          "live-long": {
            mode: "primary",
            prompt:
              "This is an isolated long-session test. Use durable conversation evidence, follow explicit tool constraints, and never fabricate a tool result.",
            permission: { "*": "deny", read: "allow", question: "allow" },
          },
          "live-observed": {
            mode: "primary",
            prompt:
              "This is a visible isolated desktop contract test. Follow the requested tool sequence exactly and do not simulate tool output.",
            permission: {
              "*": "deny",
              task: "allow",
              task_status: "allow",
              task_read: "allow",
              read: "allow",
              edit: "allow",
              question: "allow",
            },
          },
        },
        provider: {
          "live-deepseek": {
            name: "DeepSeek V4 Flash isolated desktop test",
            env: [],
            npm: "@ai-sdk/openai-compatible",
            api: config.baseURL,
            options: {
              apiKey: `{file:${config.apiKeyFile}}`,
              baseURL: config.baseURL,
              maxRetries: 0,
              timeout: config.timeoutMs,
            },
            models: {
              [config.modelID]: {
                id: config.modelID,
                name: "DeepSeek V4 Flash isolated desktop test",
                reasoning: false,
                temperature: true,
                tool_call: true,
                limit: { context: 1_000_000, output: 2048 },
                cost: { input: 0, output: 0 },
                modalities: { input: ["text"], output: ["text"] },
                options: { thinking: { type: "disabled" }, maxTokens: 1024, temperature: 0 },
              },
            },
          },
        },
      }),
    },
    options.environment,
  )
  await Promise.all([
    mkdir(env.HOME, { recursive: true }),
    mkdir(env.XDG_DATA_HOME, { recursive: true }),
    mkdir(env.XDG_CONFIG_HOME, { recursive: true }),
    mkdir(env.XDG_CACHE_HOME, { recursive: true }),
    mkdir(env.XDG_STATE_HOME, { recursive: true }),
    mkdir(env.DEEPAGENT_CODE_TEST_HOME, { recursive: true }),
  ])
  const app = await electron.launch({
    args: options.executablePath ? [] : [main],
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    env,
    timeout: 90_000,
  })
  activeApps.add(app)
  const page = await app.firstWindow({ timeout: 90_000 })
  await page.waitForFunction(() => Boolean((window as unknown as { api?: unknown }).api))
  const server = await page.evaluate(() =>
    (window as unknown as { api: { awaitInitialization(): Promise<Server> } }).api.awaitInitialization(),
  )
  const permissionAbort = new AbortController()
  const runtime = {
    app,
    page,
    root,
    workspace,
    server,
    config,
    env,
    permissionRequests: [],
    permissionErrors: [],
    permissionAbort,
    permissionTask: Promise.resolve(),
    cleanupRoot: options.cleanupRoot ?? true,
  } satisfies Runtime
  runtime.permissionTask = monitorPermissions(runtime)
  activePermissionMonitors.set(app, { abort: permissionAbort, task: runtime.permissionTask })
  return runtime
}

export async function close(runtime: Runtime) {
  runtime.permissionAbort.abort()
  await runtime.permissionTask
  activePermissionMonitors.delete(runtime.app)
  const closed = runtime.app.close().then(
    () => true,
    () => true,
  )
  if (!(await Promise.race([closed, new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000))]))) {
    runtime.app.process().kill("SIGTERM")
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 2_000))])
  }
  activeApps.delete(runtime.app)
  if (runtime.cleanupRoot && process.env.DEEPAGENT_CODE_KEEP_LIVE_SMOKE !== "1") {
    await rm(runtime.root, { recursive: true, force: true })
  }
}

export async function hardKill(runtime: Runtime) {
  runtime.permissionAbort.abort()
  activePermissionMonitors.delete(runtime.app)
  const child = runtime.app.process()
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  child.kill("SIGKILL")
  await Promise.race([
    exited,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Desktop did not exit after SIGKILL")), 10_000),
    ),
  ])
  await runtime.permissionTask
  activeApps.delete(runtime.app)
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const alive = await fetch(new URL("/global/health", runtime.server.url), {
      headers: {
        authorization: `Basic ${Buffer.from(`${runtime.server.username}:${runtime.server.password}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(1_000),
    })
      .then((response) => response.ok)
      .catch(() => false)
    if (!alive) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Desktop sidecar remained reachable after SIGKILL")
}

export async function focusSession(runtime: Runtime, session: Session) {
  const slug = Buffer.from(runtime.workspace).toString("base64url")
  const sessionKey = `local\u0000${slug}/${session.id}`
  await runtime.page.evaluate(
    async ({ layout, pageLayout, server }) => {
      const api = (
        window as unknown as {
          api: { storeSet(name: string, key: string, value: string): Promise<void> }
        }
      ).api
      await api.storeSet("deepagent.global.dat", "layout", JSON.stringify(layout))
      await api.storeSet("deepagent.global.dat", "layout.page", JSON.stringify(pageLayout))
      await api.storeSet("deepagent.global.dat", "server", JSON.stringify(server))
    },
    {
      layout: { sessionView: { [sessionKey]: { scroll: {} } } },
      pageLayout: {
        lastProjectSession: {
          [runtime.workspace]: { directory: runtime.workspace, id: session.id, at: Date.now() },
        },
      },
      server: {
        list: [],
        projects: { local: [{ worktree: runtime.workspace, expanded: true }] },
        lastProject: { local: runtime.workspace },
      },
    },
  )
}

export async function closeAll() {
  for (const monitor of activePermissionMonitors.values()) monitor.abort.abort()
  await Promise.all([...activePermissionMonitors.values()].map((monitor) => monitor.task))
  activePermissionMonitors.clear()
  await Promise.all(
    [...activeApps].map(async (app) => {
      const closed = app.close().then(
        () => true,
        () => true,
      )
      if (!(await Promise.race([closed, new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000))]))) {
        app.process().kill("SIGTERM")
      }
    }),
  )
  activeApps.clear()
}

export async function request<T>(runtime: Runtime, pathname: string, init?: RequestInit) {
  const url = new URL(pathname, runtime.server.url)
  url.searchParams.set("directory", runtime.workspace)
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Basic ${Buffer.from(`${runtime.server.username}:${runtime.server.password}`).toString("base64")}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${url.pathname} failed with HTTP ${response.status}: ${await response.text()}`,
    )
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export async function assertNoPermissionRequests(runtime: Runtime) {
  assert.deepEqual(runtime.permissionErrors, [])
  assert.deepEqual(runtime.permissionRequests, [])
  assert.deepEqual(await request<PermissionRequest[]>(runtime, "/permission"), [])
}

export function messages(runtime: Runtime, sessionID: string) {
  return request<Message[]>(runtime, `/session/${sessionID}/message`)
}

export function children(runtime: Runtime, sessionID: string) {
  return request<Session[]>(runtime, `/session/${sessionID}/children`)
}

export async function createSession(runtime: Runtime, title: string, agent = "live-parent") {
  return request<Session>(runtime, "/session", {
    method: "POST",
    body: JSON.stringify({
      title,
      agent,
      model: { id: runtime.config.modelID, providerID: "live-deepseek" },
    }),
  })
}

export async function startPrompt(runtime: Runtime, sessionID: string, text: string, agent = "live-parent") {
  const before = new Set((await messages(runtime, sessionID)).map((message) => message.info.id))
  await request<void>(runtime, `/session/${sessionID}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({
      model: { providerID: "live-deepseek", modelID: runtime.config.modelID },
      agent,
      parts: [{ type: "text", text }],
    }),
  })
  return before
}

export async function waitFor<T>(check: () => Promise<T | undefined>, label: string, timeout = 180_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await check()
    if (result !== undefined) return result
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

export function subagentState(session: Session) {
  const deepagent = isRecord(session.metadata?.deepagent) ? session.metadata.deepagent : undefined
  const subagent = isRecord(deepagent?.subagent) ? deepagent.subagent : undefined
  return {
    state: typeof subagent?.state === "string" ? subagent.state : undefined,
    reason: typeof subagent?.reason === "string" ? subagent.reason : undefined,
  }
}

export function tools(items: Message[]) {
  return items.flatMap((message) => message.parts.filter((part): part is ToolPart => part.type === "tool"))
}

export function visibleText(items: Message[]) {
  return items
    .flatMap((message) =>
      message.parts.flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : [])),
    )
    .join("\n")
}

export function assertModel(items: Message[], modelID: string) {
  assert.equal(
    items.some(
      (message) =>
        message.info.role === "assistant" &&
        message.info.providerID === "live-deepseek" &&
        message.info.modelID === modelID,
    ),
    true,
  )
}

export async function waitForPrompt(
  runtime: Runtime,
  sessionID: string,
  before: Set<string>,
  label: string,
  onPoll?: () => Promise<void>,
) {
  return waitFor(
    async () => {
      await onPoll?.()
      const [all, statuses] = await Promise.all([
        messages(runtime, sessionID),
        request<Record<string, Status>>(runtime, "/session/status"),
      ])
      const next = all.filter((message) => !before.has(message.info.id))
      const latest = next.filter((message) => message.info.role === "assistant").at(-1)
      if (
        statuses[sessionID]?.type !== "busy" &&
        statuses[sessionID]?.type !== "retry" &&
        latest?.info.time.completed !== undefined &&
        !next.some((message) =>
          message.parts.some(
            (part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
          ),
        )
      ) {
        return next
      }
    },
    label,
    runtime.config.timeoutMs,
  )
}

export async function writeArtifact(suite: string, artifact: unknown) {
  const directory = path.join(packageRoot, ".artifacts/live-llm")
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, `${suite}.json`), `${JSON.stringify(artifact, undefined, 2)}\n`)
}

async function validateKeyFile(file: string | undefined) {
  if (!file?.trim()) throw new Error("DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE must point to a chmod 600 key file")
  const resolved = await realpath(file.trim()).catch(() => {
    throw new Error(`Live LLM key file does not exist: ${file}`)
  })
  if (resolved.includes("}")) throw new Error("Live LLM key file path cannot contain }")
  const info = await stat(resolved)
  if (!info.isFile()) throw new Error(`Live LLM key file is not a regular file: ${resolved}`)
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`Live LLM key file must not be readable by group or others; run: chmod 600 ${resolved}`)
  }
  return resolved
}

async function monitorPermissions(runtime: Runtime) {
  const seen = new Set<string>()
  while (!runtime.permissionAbort.signal.aborted) {
    const pending = await request<PermissionRequest[]>(runtime, "/permission").catch((error) => {
      if (!runtime.permissionAbort.signal.aborted) runtime.permissionErrors.push(String(error))
      return undefined
    })
    if (!pending) return

    for (const item of pending.filter((request) => !seen.has(request.id))) {
      seen.add(item.id)
      runtime.permissionRequests.push(item)
      await request<boolean>(runtime, `/permission/${item.id}/reply`, {
        method: "POST",
        body: JSON.stringify({ reply: "reject" }),
      }).catch((error) => runtime.permissionErrors.push(String(error)))
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
