import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  loadLiveLLMConfig,
  liveLLMKeyFileReference,
  modelFingerprint,
  preflightLiveLLM,
  type LiveLLMConfig,
} from "../../../llm/script/live-llm/config"
import { prepareToolSandbox } from "./sandbox"

export const runtimeProviderID = "live-deepseek"

export type V2LiveAgent = {
  prompt: string
  permission: Record<string, "allow" | "deny" | Record<string, "allow" | "deny">>
}

export type V2LiveCase = {
  name: string
  agent: string
  prompt: string
}

export async function runV2LiveCases(input: {
  suite: string
  agents: Record<string, V2LiveAgent>
  cases: V2LiveCase[]
  files?: Record<string, string>
  inspectFiles?: string[]
  toolSandbox?: { verifierScript?: string }
}) {
  const config = await loadLiveLLMConfig()
  const preflight = await preflightLiveLLM(config)
  const testRoot = await mkdtemp(path.join(os.tmpdir(), `deepagent-code-${input.suite}-`))
  const workspace = path.join(testRoot, "workspace")
  const isolatedHome = path.join(testRoot, "home")
  const isolatedData = path.join(testRoot, "deepagent-home")

  try {
    await mkdir(workspace, { recursive: true })
    await mkdir(isolatedHome, { recursive: true })
    isolateProcess(testRoot, isolatedHome, isolatedData, config)
    await Promise.all(
      Object.entries(input.files ?? {}).map(async ([file, content]) => {
        await mkdir(path.dirname(path.join(workspace, file)), { recursive: true })
        await Bun.write(path.join(workspace, file), content)
      }),
    )
    const sandbox = input.toolSandbox
      ? await prepareToolSandbox({ workspace, testRoot, verifierScript: input.toolSandbox.verifierScript })
      : undefined
    await Bun.write(
      path.join(workspace, "deepagent-code.json"),
      JSON.stringify(workspaceConfig(config, input.agents, sandbox?.shell)),
    )
    await initializeGit(workspace)

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
    const sessionExecutionLocal = await import("../../src/session/execution/local")
    const { Prompt } = await import("../../src/session/prompt")
    const { SessionProjector } = await import("../../src/session/projector")
    const { SessionStore } = await import("../../src/session/store")
    const { ApplicationTools } = await import("../../src/tool/application-tools")
    const { Effect, Layer } = await import("effect")
    const { eq } = await import("drizzle-orm")

    const database = Database.defaultLayer
    const events = EventV2.defaultLayer
    const store = SessionStore.defaultLayer
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
    const layer = Layer.mergeAll(
      database,
      events,
      SessionProjector.defaultLayer,
      store,
      ApplicationTools.layer,
      locations,
      execution,
      sessions,
    )
    const location = Location.Ref.make({ directory: AbsolutePath.make(workspace) })
    const providerID = ProviderV2.ID.make(runtimeProviderID)
    const modelID = ModelV2.ID.make(config.modelID)
    const startedAt = Date.now()

    const observations = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* SessionV2.Service
        const database = yield* Database.Service
        return yield* Effect.forEach(input.cases, (testCase) =>
          Effect.gen(function* () {
            const created = yield* service.create({
              location,
              agent: AgentV2.ID.make(testCase.agent),
              model: ModelV2.Ref.make({ providerID, id: modelID }),
            })
            const admitted = yield* service.prompt({
              sessionID: created.id,
              prompt: new Prompt({ text: testCase.prompt }),
              resume: false,
            })
            yield* service.resume(created.id)
            const messages = yield* service.context(created.id)
            const assistants = messages.filter((message) => message.type === "assistant")
            const tools = assistants.flatMap((message) =>
              message.content
                .filter((content) => content.type === "tool")
                .map((content) => ({
                  id: content.id,
                  name: content.name,
                  input: content.state.input,
                  status: content.state.status,
                  structured: content.state.status === "completed" ? content.state.structured : undefined,
                  error: content.state.status === "error" ? content.state.error.message : undefined,
                })),
            )
            const session = yield* service.get(created.id)
            const eventTypes = yield* database.db
              .select({ type: EventTable.type })
              .from(EventTable)
              .where(eq(EventTable.aggregate_id, created.id))
              .all()
              .pipe(
                Effect.orDie,
                Effect.map((rows) => rows.map((row) => row.type)),
              )
            return {
              name: testCase.name,
              sessionID: created.id,
              admittedSeq: admitted.admittedSeq,
              messageCount: messages.length,
              assistantTurns: assistants.length,
              tools,
              finalText:
                assistants
                  .at(-1)
                  ?.content.filter((content) => content.type === "text")
                  .map((content) => content.text)
                  .join("") ?? "",
              finishReasons: assistants.map((message) => message.finish),
              models: assistants.map((message) => ({
                providerID: message.model.providerID,
                modelID: message.model.id,
              })),
              usage: assistants.reduce(
                (total, message) => ({
                  input: total.input + (message.tokens?.input ?? 0),
                  output: total.output + (message.tokens?.output ?? 0),
                  reasoning: total.reasoning + (message.tokens?.reasoning ?? 0),
                  cacheRead: total.cacheRead + (message.tokens?.cache.read ?? 0),
                  cacheWrite: total.cacheWrite + (message.tokens?.cache.write ?? 0),
                }),
                { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
              ),
              sessionUsage: session.tokens,
              eventTypes,
            }
          }),
        )
      }).pipe(Effect.scoped, Effect.provide(layer), Effect.timeout(config.timeoutMs * Math.max(1, input.cases.length))),
    )

    return {
      suite: input.suite,
      mode: "live" as const,
      stack: "session-v2" as const,
      status: "passed" as const,
      fingerprint: { ...modelFingerprint(config), runtimeProviderID },
      preflight: { durationMs: preflight.durationMs },
      sandbox: sandbox?.evidence,
      cases: observations,
      workspace: {
        files: Object.fromEntries(
          await Promise.all(
            (input.inspectFiles ?? []).map(async (file) => [
              file,
              (await Bun.file(path.join(workspace, file)).exists())
                ? await Bun.file(path.join(workspace, file)).text()
                : undefined,
            ]),
          ),
        ),
        status: await git(workspace, "status", "--short", "--untracked-files=all"),
      },
      durationMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true })
  }
}

function isolateProcess(testRoot: string, isolatedHome: string, isolatedData: string, config: LiveLLMConfig) {
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
}

function workspaceConfig(config: LiveLLMConfig, agents: Record<string, V2LiveAgent>, shell?: string) {
  return {
    $schema: "https://ai.deepagent.ltd/config.schema.json",
    model: `${runtimeProviderID}/${config.modelID}`,
    snapshot: false,
    ...(shell ? { shell } : {}),
    permission: { "*": "deny" },
    agent: Object.fromEntries(Object.entries(agents).map(([id, agent]) => [id, { mode: "primary", ...agent }])),
    provider: {
      [runtimeProviderID]: {
        name: "DeepSeek V2 live test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        api: config.baseURL,
        options: {
          apiKey: liveLLMKeyFileReference(config),
          baseURL: config.baseURL,
          maxRetries: 0,
          timeout: config.timeoutMs,
        },
        models: {
          [config.modelID]: {
            id: config.modelID,
            name: "DeepSeek V4 Flash live test",
            reasoning: false,
            temperature: true,
            tool_call: true,
            release_date: "2026-07-27",
            limit: { context: 1_000_000, output: 2048 },
            cost: { input: 0, output: 0 },
            modalities: { input: ["text"], output: ["text"] },
            options: { thinking: { type: "disabled" }, maxTokens: 512, temperature: 0 },
          },
        },
      },
    },
  }
}

async function initializeGit(workspace: string) {
  await git(workspace, "init")
  await git(workspace, "config", "core.fsmonitor", "false")
  await git(workspace, "config", "commit.gpgsign", "false")
  await git(workspace, "config", "user.email", "live-llm@deepagent-code.test")
  await git(workspace, "config", "user.name", "Live LLM")
  await git(workspace, "add", ".")
  await git(workspace, "commit", "-m", "test fixture")
}

async function git(workspace: string, ...args: string[]) {
  const process = Bun.spawn(["git", ...args], { cwd: workspace, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed (${exitCode}): ${stderr.trim() || "no stderr"}`)
  return stdout
}
