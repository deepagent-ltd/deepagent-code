import { strict as assert } from "node:assert"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  close,
  closeAll,
  createSession,
  findPackagedExecutable,
  launch,
  messages,
  request,
  startPrompt,
  tools,
  waitFor,
  writeArtifact,
  type Runtime,
  type Status,
} from "./runtime.ts"

const suite = "interrupted-permission-package"
if (process.platform !== "darwin") throw new Error(`${suite} currently requires macOS`)

const root = await mkdtemp(path.join(os.tmpdir(), `deepagent-code-${suite}-`))
const external = path.join(root, "external")
const marker = crypto.randomUUID()
await mkdir(external, { recursive: true })
await writeFile(path.join(external, "incident-marker.txt"), `${marker}\n`)
const keyFile = path.join(root, "provider.key")
await writeFile(keyFile, "isolated-package-test\n", { mode: 0o600 })
let dispatches = 0
let offeredTools: string[] = []
const provider = createServer(async (incoming, outgoing) => {
  if (incoming.method !== "POST" || incoming.url !== "/chat/completions") {
    outgoing.writeHead(404).end()
    return
  }
  const chunks: Buffer[] = []
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tools?: Array<{ function?: { name?: string } }> }
  offeredTools = body.tools?.flatMap((tool) => (tool.function?.name ? [tool.function.name] : [])) ?? []
  dispatches++
  outgoing.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  const frame = (value: unknown) => outgoing.write(`data: ${JSON.stringify(value)}\n\n`)
  frame({
    id: "completion-interrupted-permission",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "deterministic-tool-provider",
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  })
  frame({
    id: "completion-interrupted-permission",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "deterministic-tool-provider",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_interrupted_permission",
              type: "function",
              function: { name: "glob", arguments: JSON.stringify({ pattern: "*.txt", path: external }) },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  })
  frame({
    id: "completion-interrupted-permission",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "deterministic-tool-provider",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  })
  outgoing.end("data: [DONE]\n\n")
})
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve))
const address = provider.address()
if (!address || typeof address === "string") throw new Error("deterministic provider did not bind a TCP port")
const config = {
  baseURL: `http://127.0.0.1:${address.port}`,
  modelID: "deterministic-tool-provider",
  apiKey: "isolated-package-test",
  apiKeyFile: keyFile,
  timeoutMs: 30_000,
  providerID: "live-deepseek",
}
const executablePath = await findPackagedExecutable()
const environment = {
  DEEPAGENT_ENABLED: "true",
  DEEPAGENT_CODE_CONFIG_CONTENT: JSON.stringify({
    snapshot: false,
    enabled_providers: [config.providerID],
    model: `${config.providerID}/${config.modelID}`,
    permission: { "*": "deny", glob: "ask", external_directory: "ask" },
    agent: {
      "live-interrupt": {
        mode: "primary",
        prompt: "Follow the requested tool sequence exactly. Do not simulate tool output or call unrequested tools.",
        permission: { "*": "deny", glob: "ask", external_directory: "ask" },
      },
    },
    provider: {
      "live-deepseek": {
        name: "DeepSeek isolated interruption test",
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
            name: "DeepSeek isolated interruption test",
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
}
const startedAt = Date.now()
let initial: Runtime | undefined
let restarted: Runtime | undefined

try {
  initial = await launch(suite, config, {
    root,
    executablePath,
    environment,
    cleanupRoot: false,
    permissionResponse: "observe",
  })
  const packaged = await initial.app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }))
  assert.equal(packaged.packaged, true)
  const session = await createSession(initial, "Interrupted permission recovery", "live-interrupt")
  const before = await startPrompt(
    initial,
    session.id,
    [
      `Call glob exactly once with pattern *.txt and path ${external}.`,
      "Do not call any other tool and do not answer without the tool result.",
      "The operator will interrupt while the external-directory permission is pending.",
    ].join("\n"),
    "live-interrupt",
  )
  let approvedGlobRequest: string | undefined
  const pending = await waitFor(
    async () => {
      const glob = initial!.permissionRequests.find(
        (permission) => permission.sessionID === session.id && permission.permission === "glob",
      )
      if (glob && approvedGlobRequest !== glob.id) {
        approvedGlobRequest = glob.id
        await request<boolean>(initial!, `/permission/${glob.id}/reply`, {
          method: "POST",
          body: JSON.stringify({ reply: "once" }),
        })
        return
      }
      const item = initial!.permissionRequests.find(
        (request) => request.sessionID === session.id && request.permission === "external_directory",
      )
      if (!item) return
      const snapshot = inspect(path.join(root, "deepagent.sqlite"), session.id)
      if (snapshot.effectStates.includes("started") && snapshot.permissionStates.includes("pending")) {
        return { item, snapshot }
      }
    },
    "started glob effect and pending external-directory permission",
    config.timeoutMs,
  ).catch(async (error) => {
    console.error(`${suite}: latch diagnostics`, {
      observedPermissions: initial!.permissionRequests.map((item) => ({ permission: item.permission, id: item.id })),
      pendingPermissions: (await request<Runtime["permissionRequests"]>(initial!, "/permission")).map((item) => ({
        permission: item.permission,
        id: item.id,
      })),
      permissionErrors: initial!.permissionErrors,
      snapshot: inspect(path.join(root, "deepagent.sqlite"), session.id),
      offeredTools,
      dispatches,
    })
    throw error
  })
  assert.equal(offeredTools.includes("glob"), true, `glob was not offered: ${offeredTools.join(", ")}`)
  assert.equal(
    pending.item.patterns.some((pattern) => {
      const resolved = path.resolve(pattern)
      return resolved === external || resolved.startsWith(`${external}${path.sep}`)
    }),
    true,
  )
  assert.equal(pending.snapshot.providerReceipts, 1)

  await request<boolean>(initial, `/session/${session.id}/abort`, { method: "POST" })
  const interrupted = await waitFor(
    async () => {
      const statuses = await request<Record<string, Status>>(initial!, "/session/status")
      const snapshot = inspect(path.join(root, "deepagent.sqlite"), session.id)
      if (
        statuses[session.id]?.type !== "busy" &&
        snapshot.activeActivities === 0 &&
        snapshot.liveRuns === 0 &&
        snapshot.provisionalProgress === 0 &&
        !snapshot.permissionStates.includes("pending") &&
        !snapshot.effectStates.includes("started")
      ) {
        return snapshot
      }
    },
    "bounded interruption settlement",
    30_000,
  )
  assert.equal(interrupted.permissionStates.includes("interrupted"), true)
  assert.equal(interrupted.effectStates.includes("unknown"), true)
  assert.equal(interrupted.terminals, 1)
  const interruptedMessages = (await messages(initial, session.id)).filter((message) => !before.has(message.info.id))
  assert.equal(
    tools(interruptedMessages).some((part) => part.tool === "glob" && part.state.status === "error"),
    true,
  )
  assert.deepEqual(initial.permissionErrors, [])
  await close(initial)
  initial = undefined

  restarted = await launch(suite, config, {
    root,
    executablePath,
    environment,
    cleanupRoot: false,
    permissionResponse: "observe",
  })
  const recovered = await waitFor(
    async () => {
      const snapshot = inspect(path.join(root, "deepagent.sqlite"), session.id)
      if (snapshot.activeActivities === 0 && snapshot.liveRuns === 0 && !snapshot.effectStates.includes("started")) {
        return snapshot
      }
    },
    "restart convergence",
    30_000,
  )
  assert.deepEqual(recovered, interrupted)
  assert.deepEqual(restarted.permissionErrors, [])
  assert.deepEqual(await request<unknown[]>(restarted, "/permission"), [])

  await writeArtifact(suite, {
    suite,
    status: "passed",
    package: { isPackaged: packaged.packaged, version: packaged.version },
    provider: { id: "loopback-openai-compatible", model: config.modelID, dispatches },
    interruption: {
      permission: pending.item.permission,
      before: pending.snapshot,
      after: interrupted,
      afterRestart: recovered,
    },
    durationMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
  })
  console.log(`${suite}: passed (${config.modelID}, packaged interruption and restart)`)
} finally {
  if (initial) await close(initial).catch(() => undefined)
  if (restarted) await close(restarted).catch(() => undefined)
  await closeAll()
  await new Promise<void>((resolve, reject) =>
    provider.close((error) => (error ? reject(error) : resolve())),
  )
  if (process.env.DEEPAGENT_CODE_KEEP_LIVE_SMOKE !== "1") await rm(root, { recursive: true, force: true })
}

function inspect(databasePath: string, sessionID: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  const count = (sql: string) => Number((database.prepare(sql).get(sessionID) as { value: number }).value)
  const states = (sql: string) =>
    (database.prepare(sql).all(sessionID) as Array<{ state: string }>).map((row) => row.state).sort()
  try {
    return {
      providerReceipts: count("SELECT COUNT(*) AS value FROM session_tool_request_receipt WHERE session_id = ?"),
      permissionStates: states(
        "SELECT state FROM session_activity_permission_request WHERE session_id = ? ORDER BY created_at",
      ),
      effectStates: states(
        "SELECT state FROM session_activity_permission_effect_dispatch WHERE session_id = ? ORDER BY started_at",
      ),
      activeActivities: count(
        "SELECT COUNT(*) AS value FROM session_legacy_activity WHERE session_id = ? AND state = 'active'",
      ),
      liveRuns: count(
        "SELECT COUNT(*) AS value FROM session_legacy_activity_run WHERE session_id = ? AND state IN ('running','finalizing')",
      ),
      provisionalProgress: count(
        "SELECT COUNT(*) AS value FROM session_activity_progress progress JOIN session_legacy_activity activity USING(activity_id) WHERE activity.session_id = ? AND progress.state = 'provisional'",
      ),
      terminals: count("SELECT COUNT(*) AS value FROM session_legacy_activity_terminal WHERE session_id = ?"),
      messages: count("SELECT COUNT(*) AS value FROM message WHERE session_id = ?"),
      parts: count("SELECT COUNT(*) AS value FROM part WHERE session_id = ?"),
    }
  } finally {
    database.close()
  }
}
