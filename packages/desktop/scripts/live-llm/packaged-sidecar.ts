import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { _electron as electron, type ElectronApplication } from "@playwright/test"

type Server = { url: string; username: string; password: string }
type Status = { type: "idle" | "busy" | "retry" }
type PermissionRequest = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  tool?: { callID: string }
}
type Message = {
  info: {
    id: string
    role: "user" | "assistant"
    providerID?: string
    modelID?: string
    finish?: string
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

const suite = "packaged-sidecar"
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const config = await loadLiveLLMConfig()
const preflight = await preflightLiveLLM(config)
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "deepagent-code-packaged-sidecar-")))
const workspace = path.join(root, "workspace")
const fixtureName = "desktop-fixture.txt"
const fixture = path.join(workspace, fixtureName)
const marker = `desktop-${crypto.randomUUID()}`
const expected = `verified ${marker}\n`
await mkdir(workspace, { recursive: true })
await writeFile(fixture, `pending ${marker}\n`)

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
  ].flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
)
Object.assign(env, {
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
  DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE: config.apiKeyFile,
  DEEPAGENT_ENABLED: "false",
  DEEPAGENT_CODE_CONFIG_CONTENT: JSON.stringify({
    snapshot: false,
    enabled_providers: ["live-deepseek"],
    model: `live-deepseek/${config.modelID}`,
    permission: {
      "*": "deny",
      read: "ask",
      edit: "ask",
    },
    provider: {
      "live-deepseek": {
        name: "DeepSeek packaged sidecar live test",
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
            name: "DeepSeek V4 Flash packaged sidecar live test",
            reasoning: false,
            temperature: true,
            tool_call: true,
            limit: { context: 1_000_000, output: 2048 },
            cost: { input: 0, output: 0 },
            modalities: { input: ["text"], output: ["text"] },
            options: { thinking: { type: "disabled" }, maxTokens: 512, temperature: 0 },
          },
        },
      },
    },
  }),
})

const startedAt = Date.now()
let app: ElectronApplication | undefined
try {
  app = await electron.launch({
    args: [path.resolve(scriptDirectory, "../../out/main/index.js")],
    env,
    timeout: 90_000,
  })
  const page = await app.firstWindow({ timeout: 90_000 })
  await page.waitForFunction(() => Boolean((window as unknown as { api?: unknown }).api))
  const server = await page.evaluate(() =>
    (window as unknown as { api: { awaitInitialization(): Promise<Server> } }).api.awaitInitialization(),
  )
  const session = await request<{ id: string }>(server, workspace, "/session", {
    method: "POST",
    body: JSON.stringify({
      title: "DeepSeek V4 Flash packaged sidecar",
      agent: "auto",
      model: { id: config.modelID, providerID: "live-deepseek" },
    }),
  })
  const before = new Set((await messages(server, workspace, session.id)).map((message) => message.info.id))
  await request<void>(server, workspace, `/session/${session.id}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({
      model: { providerID: "live-deepseek", modelID: config.modelID },
      agent: "auto",
      system: "This is a packaged sidecar tool contract test. Use only the explicitly requested tools.",
      parts: [
        {
          type: "text",
          text: [
            `Call read exactly once for ${fixtureName}.`,
            `Then call edit exactly once to replace pending ${marker} with verified ${marker}.`,
            `Then call read exactly once again and report the exact final content ${expected.trim()}.`,
            "Do not call any other tool.",
          ].join("\n"),
        },
      ],
    }),
  })
  const permissionRequests: PermissionRequest[] = []
  const fresh = await waitFor(async () => {
    const pending = (await request<PermissionRequest[]>(server, workspace, "/permission")).filter(
      (item) => item.sessionID === session.id,
    )
    for (const item of pending) {
      const allowed =
        (item.permission === "read" || item.permission === "edit") &&
        item.tool?.callID !== undefined &&
        item.patterns.length === 1 &&
        item.patterns.every((pattern) =>
          [path.resolve(workspace, pattern), path.resolve(root, pattern), path.resolve("/", pattern)].includes(fixture),
        )
      if (!allowed) {
        await request<boolean>(server, workspace, `/permission/${item.id}/reply`, {
          method: "POST",
          body: JSON.stringify({ reply: "reject", message: "Outside the packaged sidecar fixture allowlist." }),
        })
        throw new Error(`Packaged sidecar requested disallowed permission: ${JSON.stringify(item)}`)
      }
      permissionRequests.push(item)
      await request<boolean>(server, workspace, `/permission/${item.id}/reply`, {
        method: "POST",
        body: JSON.stringify({ reply: "once" }),
      })
    }
    const statuses = await request<Record<string, Status>>(server, workspace, "/session/status")
    if (statuses[session.id]?.type === "busy" || statuses[session.id]?.type === "retry") return
    const all = await messages(server, workspace, session.id)
    const next = all.filter((message) => !before.has(message.info.id))
    if (
      next.some((message) => message.info.role === "assistant" && message.info.time.completed !== undefined) &&
      !next.some((message) =>
        message.parts.some(
          (part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
        ),
      )
    ) {
      return next
    }
  }, config.timeoutMs)
  const tools = fresh.flatMap((message) =>
    message.parts.flatMap((part) =>
      part.type === "tool"
        ? [
            {
              name: part.tool,
              status: part.state.status,
              input: part.state.input,
              output: part.state.status === "completed" ? part.state.output : undefined,
              error: part.state.status === "error" ? part.state.error : undefined,
            },
          ]
        : [],
    ),
  )
  assert.deepEqual(
    tools.map((tool) => ({ name: tool.name, status: tool.status })),
    [
      { name: "read", status: "completed" },
      { name: "edit", status: "completed" },
      { name: "read", status: "completed" },
    ],
    `Unexpected packaged sidecar tool sequence:\n${JSON.stringify(tools, undefined, 2)}`,
  )
  assert.equal(await readFile(fixture, "utf8"), expected)
  assert.equal(
    fresh.some(
      (message) =>
        message.info.role === "assistant" &&
        message.info.providerID === "live-deepseek" &&
        message.info.modelID === config.modelID,
    ),
    true,
  )
  assert.equal(
    fresh.some((message) =>
      message.parts.some(
        (part) => part.type === "text" && !part.synthetic && !part.ignored && part.text.includes(marker),
      ),
    ),
    true,
  )

  const artifact = {
    suite,
    mode: "ext",
    stack: "packaged-sidecar",
    status: "passed",
    fingerprint: {
      providerID: "deepseek",
      modelID: config.modelID,
      modelRevision: config.modelRevision,
      baseURL: config.baseURL,
    },
    preflight: { durationMs: preflight.durationMs },
    sessionID: session.id,
    messageCount: fresh.length,
    permissionRequests,
    tools,
    fixtureHash: createHash("sha256").update(expected).digest("hex"),
    durationMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
  }
  const artifactDirectory = path.resolve(scriptDirectory, "../../.artifacts/live-llm")
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(path.join(artifactDirectory, `${suite}.json`), `${JSON.stringify(artifact, undefined, 2)}\n`)
  console.log(`${suite}: passed (${artifact.fingerprint.providerID}/${artifact.fingerprint.modelID})`)
} finally {
  try {
    if (app) await app.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function messages(server: Server, workspace: string, sessionID: string) {
  return request<Message[]>(server, workspace, `/session/${sessionID}/message`)
}

async function request<T>(server: Server, workspace: string, pathname: string, init?: RequestInit) {
  const url = new URL(pathname, server.url)
  url.searchParams.set("directory", workspace)
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Basic ${Buffer.from(`${server.username}:${server.password}`).toString("base64")}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${url.pathname} failed with HTTP ${response.status}: ${(await response.text()).slice(0, 2_000)}`,
    )
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

async function waitFor<T>(check: () => Promise<T | undefined>, timeout: number): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Timed out waiting for packaged sidecar Session completion")
}

async function loadLiveLLMConfig() {
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
  const timeoutMs = Number(process.env.DEEPAGENT_CODE_LIVE_LLM_TIMEOUT_MS || 120_000)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15 * 60_000) {
    throw new Error("DEEPAGENT_CODE_LIVE_LLM_TIMEOUT_MS must be an integer between 1000 and 900000")
  }
  return {
    baseURL,
    apiKey,
    apiKeyFile,
    timeoutMs,
    modelID: process.env.DEEPAGENT_CODE_LIVE_LLM_MODEL?.trim() || "deepseek-v4-flash",
    modelRevision: process.env.DEEPAGENT_CODE_LIVE_LLM_REVISION?.trim() || undefined,
  }
}

async function preflightLiveLLM(config: Awaited<ReturnType<typeof loadLiveLLMConfig>>) {
  const startedAt = Date.now()
  const response = await fetch(`${config.baseURL}/models`, {
    headers: { authorization: `Bearer ${config.apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(Math.min(config.timeoutMs, 30_000)),
  })
  if (!response.ok) throw new Error(`DeepSeek model preflight failed with HTTP ${response.status}`)
  const payload: unknown = await response.json()
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("DeepSeek model preflight returned invalid JSON")
  }
  const models = payload.data.flatMap((item) => (isRecord(item) && typeof item.id === "string" ? [item.id] : []))
  if (!models.includes(config.modelID)) {
    throw new Error(`DeepSeek model ${config.modelID} is not available; reported models: ${models.join(", ")}`)
  }
  return { durationMs: Date.now() - startedAt }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
