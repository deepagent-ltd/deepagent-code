import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  loadLiveLLMConfig,
  liveLLMKeyFileReference,
  modelFingerprint,
  preflightLiveLLM,
  writeLiveArtifact,
} from "../../../llm/script/live-llm/config"

const suite = "v2-provider-loop"
const runtimeProviderID = "live-deepseek"
const config = await loadLiveLLMConfig()
const preflight = await preflightLiveLLM(config)
const testRoot = await mkdtemp(path.join(os.tmpdir(), "deepagent-code-v2-live-llm-"))
const workspace = path.join(testRoot, "workspace")
const isolatedHome = path.join(testRoot, "home")
const isolatedData = path.join(testRoot, "deepagent-home")

await mkdir(workspace, { recursive: true })
await mkdir(isolatedHome, { recursive: true })
process.env.HOME = isolatedHome
process.env.XDG_DATA_HOME = path.join(testRoot, "data")
process.env.XDG_CONFIG_HOME = path.join(testRoot, "config")
process.env.XDG_CACHE_HOME = path.join(testRoot, "cache")
process.env.XDG_STATE_HOME = path.join(testRoot, "state")
process.env.DEEPAGENT_CODE_TEST_HOME = isolatedHome
process.env.DEEPAGENT_CODE_HOME = isolatedData
process.env.DEEPAGENT_CODE_DISABLE_AUTOUPDATE = "1"
process.env.DEEPAGENT_CODE_DISABLE_MODELS_FETCH = "1"
process.env.DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS = "1"
process.env.DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE = config.apiKeyFile
process.env.DEEPAGENT_ENABLED = "false"

await Bun.write(
  path.join(workspace, "deepagent-code.json"),
  JSON.stringify({
    $schema: "https://ai.deepagent.ltd/config.schema.json",
    model: `${runtimeProviderID}/${config.modelID}`,
    snapshot: false,
    permission: { "*": "deny", issue_marker: "allow" },
    agent: {
      auto: {
        mode: "primary",
        prompt:
          "For this test, call issue_marker exactly once. After it returns, answer with the exact marker from the tool result.",
        permission: { "*": "deny", issue_marker: "allow" },
      },
    },
    provider: {
      [runtimeProviderID]: {
        name: "DeepSeek V2 live test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        api: config.baseURL,
        options: { apiKey: liveLLMKeyFileReference(config), baseURL: config.baseURL },
        models: {
          [config.modelID]: {
            id: config.modelID,
            name: "DeepSeek V4 Flash live test",
            reasoning: false,
            temperature: true,
            tool_call: true,
            release_date: "2026-07-27",
            limit: { context: 1_000_000, output: 1024 },
            cost: { input: 0, output: 0 },
            modalities: { input: ["text"], output: ["text"] },
            options: {
              thinking: { type: "disabled" },
              maxTokens: 256,
              temperature: 0,
            },
          },
        },
      },
    },
  }),
)

await runGit("init")
await runGit("config", "core.fsmonitor", "false")
await runGit("config", "commit.gpgsign", "false")
await runGit("config", "user.email", "live-llm@deepagent-code.test")
await runGit("config", "user.name", "Live LLM")
await runGit("add", "deepagent-code.json")
await runGit("commit", "-m", "test fixture")

const { ApplicationTools } = await import("../../src/tool/application-tools")
const { AgentV2 } = await import("../../src/agent")
const { Database } = await import("../../src/database/database")
const { EventV2 } = await import("../../src/event")
const { EventTable } = await import("../../src/event/sql")
const { Location } = await import("../../src/location")
const { LocationServiceMap } = await import("../../src/location-layer")
const { ModelV2 } = await import("../../src/model")
const { ProjectV2 } = await import("../../src/project")
const { ProviderV2 } = await import("../../src/provider")
const { AbsolutePath } = await import("../../src/schema")
const { SessionV2 } = await import("../../src/session")
const { SessionEvent } = await import("../../src/session/event")
const { V2ProviderTurnReceiptTable } = await import("../../src/session/runner/v2-provider-turn.sql")
const sessionExecutionLocal = await import("../../src/session/execution/local")
const { Prompt } = await import("../../src/session/prompt")
const { SessionProjector } = await import("../../src/session/projector")
const { SessionStore } = await import("../../src/session/store")
const { Tool } = await import("../../src/tool/tool")
const { Effect, Layer, Schema } = await import("effect")
const { eq } = await import("drizzle-orm")

const location = Location.Ref.make({ directory: AbsolutePath.make(workspace) })
const providerID = ProviderV2.ID.make(runtimeProviderID)
const modelID = ModelV2.ID.make(config.modelID)
const database = Database.defaultLayer
const events = EventV2.defaultLayer
const projector = SessionProjector.defaultLayer
const store = SessionStore.defaultLayer
const applicationTools = ApplicationTools.layer
let issuedMarker: string | undefined
let toolExecutions = 0

const markerTool = Layer.effectDiscard(
  ApplicationTools.Service.use((tools) =>
    tools.register({
      issue_marker: Tool.make({
        description: "Issue the only valid runtime marker for this test. Call exactly once.",
        input: Schema.Struct({}),
        output: Schema.Struct({ marker: Schema.String }),
        execute: () =>
          Effect.sync(() => {
            toolExecutions++
            if (toolExecutions !== 1) throw new Error("issue_marker was executed more than once")
            issuedMarker = `v2-${crypto.randomUUID()}`
            return { marker: issuedMarker }
          }),
        toModelOutput: ({ output }) => [{ type: "text", text: `The issued marker is ${output.marker}` }],
      }),
    }),
  ),
).pipe(Layer.provide(applicationTools))

const locations = LocationServiceMap.layer
const execution = sessionExecutionLocal.layer.pipe(
  Layer.provide(store),
  Layer.provide(events),
  Layer.provide(locations),
)
const sessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(ProjectV2.defaultLayer),
  Layer.provide(execution),
)
const liveLayer = Layer.mergeAll(
  database,
  events,
  projector,
  store,
  applicationTools,
  markerTool,
  locations,
  execution,
  sessions,
)

const program = Effect.gen(function* () {
  const service = yield* SessionV2.Service
  const created = yield* service.create({
    location,
    agent: AgentV2.ID.make("auto"),
    model: ModelV2.Ref.make({ providerID, id: modelID }),
  })
  const promptText =
    "Call issue_marker exactly once. Then reply with `MARKER: ` followed by the exact marker returned by the tool."
  const startedAt = Date.now()
  const admitted = yield* service.prompt({
    sessionID: created.id,
    prompt: new Prompt({ text: promptText }),
    resume: false,
  })

  yield* service.resume(created.id)

  if (!issuedMarker) throw new Error("V2 tool execution did not issue a marker")
  if (promptText.includes(issuedMarker)) throw new Error("Runtime marker leaked into the prompt")
  if (toolExecutions !== 1) throw new Error(`Expected one V2 tool execution, received ${toolExecutions}`)

  const messages = yield* service.context(created.id)
  const assistants = messages.filter((message) => message.type === "assistant")
  if (assistants.length !== 2) throw new Error(`Expected two V2 assistant turns, received ${assistants.length}`)
  const tool = assistants
    .flatMap((message) => message.content)
    .find((content) => content.type === "tool" && content.name === "issue_marker")
  if (tool?.type !== "tool" || tool.state.status !== "completed") {
    throw new Error("V2 issue_marker tool part was not durably completed")
  }
  if (tool.state.structured.marker !== issuedMarker) {
    throw new Error("V2 durable tool result does not contain the issued marker")
  }
  const final = assistants.at(-1)
  if (!final || final.finish !== "stop") throw new Error(`V2 continuation did not finish with stop`)
  const finalText = final.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("")
  if (!finalText.includes(issuedMarker)) {
    throw new Error("V2 continuation did not reference the runtime-generated tool marker")
  }
  if (assistants.some((message) => message.model.providerID !== providerID || message.model.id !== modelID)) {
    throw new Error("V2 assistant messages persisted the wrong provider/model identity")
  }
  const usage = assistants.reduce(
    (total, message) => ({
      input: total.input + (message.tokens?.input ?? 0),
      output: total.output + (message.tokens?.output ?? 0),
      reasoning: total.reasoning + (message.tokens?.reasoning ?? 0),
      cacheRead: total.cacheRead + (message.tokens?.cache.read ?? 0),
      cacheWrite: total.cacheWrite + (message.tokens?.cache.write ?? 0),
    }),
    { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  )
  if (usage.input <= 0 || usage.output <= 0) throw new Error("V2 assistant messages did not persist token usage")

  const session = yield* service.get(created.id)
  if (session.tokens.input <= 0 || session.tokens.output <= 0) {
    throw new Error("V2 Session projection did not aggregate provider usage")
  }
  const db = (yield* Database.Service).db
  const rows = yield* db
    .select({ type: EventTable.type })
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, created.id))
    .all()
    .pipe(Effect.orDie)
  const eventTypes = rows.map((row) => row.type)
  const providerTurns = eventTypes.filter(
    (type) => type === EventV2.versionedType(SessionEvent.Step.Started.type, 1),
  ).length
  if (providerTurns !== 2) throw new Error(`Expected two durable provider turns, received ${providerTurns}`)
  if (!eventTypes.includes(EventV2.versionedType(SessionEvent.Tool.Success.type, 1))) {
    throw new Error("V2 event stream is missing durable tool completion")
  }
  const receipts = yield* db
    .select()
    .from(V2ProviderTurnReceiptTable)
    .where(eq(V2ProviderTurnReceiptTable.session_id, created.id))
    .all()
    .pipe(Effect.orDie)
  if (
    receipts.length !== 2 ||
    receipts.some(
      (receipt) =>
        receipt.owner_mode !== "v2" ||
        receipt.state !== "settled" ||
        !receipt.prepared_turn_hash ||
        !receipt.wire_request_hash ||
        !receipt.prepared_turn ||
        !receipt.outcome_hash ||
        !receipt.outcome_artifact,
    )
  ) {
    throw new Error(
      `V2 live provider turns did not seal and settle exact durable receipts: ${JSON.stringify(
        receipts.map((receipt) => ({
          ordinal: receipt.request_ordinal,
          ownerMode: receipt.owner_mode,
          state: receipt.state,
          preparedTurnHash: Boolean(receipt.prepared_turn_hash),
          wireRequestHash: Boolean(receipt.wire_request_hash),
          preparedTurn: Boolean(receipt.prepared_turn),
          outcomeHash: Boolean(receipt.outcome_hash),
          outcomeArtifact: Boolean(receipt.outcome_artifact),
        })),
      )}`,
    )
  }

  return {
    suite,
    mode: "live",
    stack: "session-v2",
    status: "passed",
    fingerprint: { ...modelFingerprint(config), runtimeProviderID },
    preflight: { durationMs: preflight.durationMs },
    session: {
      admittedSeq: admitted.admittedSeq,
      messageCount: messages.length,
      assistantTurns: assistants.length,
      providerTurns,
      providerReceipts: receipts.map((receipt) => ({
        ordinal: receipt.request_ordinal,
        ownerMode: receipt.owner_mode,
        state: receipt.state,
        preparedTurnHash: receipt.prepared_turn_hash,
        wireRequestHash: receipt.wire_request_hash,
        outcomeHash: receipt.outcome_hash,
      })),
      toolExecutions,
      toolCallIDLength: tool.id.length,
      markerHash: Bun.hash(issuedMarker).toString(16),
      finalTextLength: finalText.length,
      finishReasons: assistants.map((message) => message.finish),
      usage,
      eventCount: eventTypes.length,
      durationMs: Date.now() - startedAt,
    },
    completedAt: new Date().toISOString(),
  }
})

try {
  const artifact = await Effect.runPromise(
    program.pipe(Effect.scoped, Effect.provide(liveLayer), Effect.timeout(config.timeoutMs)),
  )
  await writeLiveArtifact(
    { ...config, artifactDirectory: path.resolve(import.meta.dir, "../../.artifacts/live-llm") },
    suite,
    artifact,
  )
  console.log(
    `${suite}: passed (${artifact.fingerprint.providerID}/${artifact.fingerprint.modelID}, ` +
      `${artifact.session.usage.input + artifact.session.usage.output} tokens)`,
  )
} finally {
  await rm(testRoot, { recursive: true, force: true })
}

async function runGit(...args: string[]) {
  const process = Bun.spawn(["git", ...args], { cwd: workspace, stdout: "pipe", stderr: "pipe" })
  if ((await process.exited) === 0) return
  throw new Error(`git ${args[0]} failed: ${await new Response(process.stderr).text()}`)
}
