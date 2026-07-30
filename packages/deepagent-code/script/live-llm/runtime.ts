import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ConfigV1 } from "@deepagent-code/core/v1/config/config"
import type { PermissionV1 } from "@deepagent-code/core/v1/permission"
import type { SessionV1 } from "@deepagent-code/core/v1/session"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import type { QuestionID } from "../../src/question/schema"
import type { SessionID } from "../../src/session/schema"
import {
  loadLiveLLMConfig,
  liveLLMKeyFileReference,
  modelFingerprint,
  preflightLiveLLM,
  type LiveLLMConfig,
} from "../../../llm/script/live-llm/config"
import { prepareToolSandbox, type ToolSandbox } from "../../../core/script/live-llm/sandbox"

export const runtimeProviderID = "live-deepseek"

const liveSubprocessHostKeys = [
  "PATH",
  "TMPDIR",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
] as const

export function liveSubprocessEnvironment(
  overrides: Readonly<Record<string, string | undefined>>,
  hostEnvironment: Readonly<Record<string, string | undefined>> = process.env,
) {
  return {
    ...Object.fromEntries(
      liveSubprocessHostKeys.flatMap((key) =>
        hostEnvironment[key] === undefined ? [] : ([[key, hostEnvironment[key]]] as const),
      ),
    ),
    ...overrides,
  }
}

export type LegacyLiveRuntimeConfig = Pick<
  LiveLLMConfig,
  "providerID" | "modelID" | "modelRevision" | "baseURL" | "timeoutMs" | "artifactDirectory"
>

export function parseLegacyLiveRuntimeConfig(
  env: Readonly<Record<string, string | undefined>>,
  options: { defaultArtifactDirectory?: string } = {},
): LegacyLiveRuntimeConfig {
  const baseURL = (env.DEEPAGENT_CODE_LIVE_LLM_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/$/, "")
  const endpoint = new URL(baseURL)
  if (endpoint.protocol !== "https:" || endpoint.hostname !== "api.deepseek.com") {
    throw new Error(`Official DeepSeek live tests require https://api.deepseek.com, received ${baseURL}`)
  }

  const timeoutMs = Number(env.DEEPAGENT_CODE_LIVE_LLM_TIMEOUT_MS || 120_000)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15 * 60_000) {
    throw new Error("DEEPAGENT_CODE_LIVE_LLM_TIMEOUT_MS must be an integer between 1000 and 900000")
  }

  return {
    providerID: "deepseek",
    modelID: env.DEEPAGENT_CODE_LIVE_LLM_MODEL?.trim() || "deepseek-v4-flash",
    modelRevision: env.DEEPAGENT_CODE_LIVE_LLM_REVISION?.trim() || undefined,
    baseURL,
    timeoutMs,
    artifactDirectory:
      env.DEEPAGENT_CODE_LIVE_LLM_ARTIFACT_DIR?.trim() ||
      options.defaultArtifactDirectory ||
      path.resolve(import.meta.dir, "../../.artifacts/live-llm"),
  }
}

export type LegacyLiveCase = {
  name: string
  prompt: string
  agent?: string
  intelligence?: {
    outputLanguage?: "english" | "chinese"
  }
}

export type LegacyPanelCase = {
  afterCaseName: string
  question: string
  codeRefs: string[]
  lenses: Array<"correctness" | "security" | "performance" | "architecture" | "repro">
  maxRounds?: number
  policy?: "default" | "security"
}

export async function runLegacyLiveCases(input: {
  suite: string
  cases: LegacyLiveCase[]
  permission: ConfigV1.Info["permission"]
  primaryPermission?: ConfigV1.Info["permission"]
  agentPermissions?: Readonly<Record<string, ConfigV1.Info["permission"]>>
  mcp?: ConfigV1.Info["mcp"]
  files?: Record<string, string>
  inspectFiles?: string[]
  packageScripts?: Readonly<Record<string, string>>
  toolSandbox?: { verifierScript?: string; initialVerifier?: "fail" | "pass" }
  permissionReply?: { reply: "reject"; message?: string }
  questionReply?: string
  questionAction?: { type: "abort" } | { type: "background"; reply: string }
  awaitParentTools?: string[]
  primaryPrompt?: string
  modelMaxTokens?: number
  modelContextTokens?: number
  maxProviderTurns?: number
  toolOutput?: ConfigV1.Info["tool_output"]
  evaluateWorkspace?: (directory: string, sandbox?: ToolSandbox) => Promise<unknown>
  beforeCase?: (input: { caseName: string; directory: string; sandbox?: ToolSandbox }) => Promise<void>
  sharedSession?: boolean
  compactAfterCases?: string[]
  timeoutMs?: number
  // Inject a steering message through the production promptOrSteer ingress after the named case's
  // session runner reports an active turn. The original prompt remains in flight; the runtime records
  // durable admission evidence before awaiting that prompt to completion.
  steerDuringCases?: ReadonlyArray<{ duringCaseName: string; text: string }>
  observeAssembledRequestFingerprints?: boolean
  environment?: Readonly<Record<string, string>>
  panel?: LegacyPanelCase
}) {
  const config = await loadLiveLLMConfig()
  const preflight = await preflightLiveLLM(config)
  const testRoot = await mkdtemp(path.join(os.tmpdir(), `deepagent-code-${input.suite}-`))
  const isolatedHome = path.join(testRoot, "home")
  const isolatedData = path.join(testRoot, "deepagent-home")
  const environment = isolationEnvironment(Object.keys(input.environment ?? {}))
  if (input.observeAssembledRequestFingerprints) {
    process.env.DEEPAGENT_CODE_ASSEMBLED_REQUEST_FINGERPRINT = "true"
  }

  try {
    await prepareIsolation(testRoot, isolatedHome, isolatedData, config, input.environment)
    const { ModelV2 } = await import("@deepagent-code/core/model")
    const { ProviderV2 } = await import("@deepagent-code/core/provider")
    const { CrossSpawnSpawner } = await import("@deepagent-code/core/cross-spawn-spawner")
    const { Effect, Fiber, Layer, Schedule } = await import("effect")
    const globalBus = GlobalBus as unknown as EventEmitter
    const { EventV2Bridge } = await import("../../src/event-v2-bridge")
    const { Agent } = await import("../../src/agent/agent")
    const { Permission } = await import("../../src/permission")
    const { Question } = await import("../../src/question")
    const { SessionCompaction } = await import("../../src/session/compaction")
    const { SessionPrompt } = await import("../../src/session/prompt")
    const { SessionRunState } = await import("../../src/session/run-state")
    const { MessageID } = await import("../../src/session/schema")
    const { SessionSteer } = await import("../../src/session/steer")
    const { Session } = await import("../../src/session/session")
    const { InstanceStore } = await import("../../src/project/instance-store")
    const { Worktree } = await import("../../src/worktree")
    const { consultPanel } = await import("../../src/panel/consult")
    const { makeTaskSubagentRunner } = await import("../../src/session/goal-loop-wiring")
    const { TestInstance, testInstanceStoreLayer, tmpdirScoped } = await import("../../test/fixture/fixture")

    const providerID = ProviderV2.ID.make(runtimeProviderID)
    const modelID = ModelV2.ID.make(config.modelID)
    const startedAt = Date.now()
    let sandbox: ToolSandbox | undefined
    let initialVerifier: { expected: "fail" | "pass"; exitCode: number } | undefined
    let panelEvidence:
      | {
          verdict: unknown
          opinions: unknown[]
        }
      | undefined
    const program = Effect.gen(function* () {
      const prompts = yield* SessionPrompt.Service
      const runState = yield* SessionRunState.Service
      const steers = yield* SessionSteer.Service
      const compaction = yield* SessionCompaction.Service
      const sessions = yield* Session.Service
      const instance = yield* TestInstance
      const permissions = yield* Permission.Service
      const questions = yield* Question.Service
      const agents = input.panel ? yield* Agent.Service : undefined
      const assembledRequestFingerprints: GlobalEvent[] = []
      const requestFingerprintListener = (event: GlobalEvent) => {
        if (event.payload?.type !== "session.request.assembled-fingerprint") return
        assembledRequestFingerprints.push(structuredClone(event))
      }
      if (input.observeAssembledRequestFingerprints) {
        globalBus.on("event", requestFingerprintListener)
        yield* Effect.addFinalizer(() => Effect.sync(() => globalBus.off("event", requestFingerprintListener)))
      }
      const permissionRequests: PermissionV1.Request[] = []
      const questionRequests: Array<{
        id: QuestionID
        sessionID: string
        questions: ReadonlyArray<unknown>
        tool?: { messageID: string; callID: string }
        latch?: { type: "abort" | "background"; parentSessionID?: string; taskRunning?: boolean }
      }> = []
      const events = yield* EventV2Bridge.Service
      const unsubscribe = yield* events.listen((event) => {
        if (event.type !== Permission.Event.Asked.type) return Effect.void
        const request = event.data as PermissionV1.Request
        permissionRequests.push(request)
        return permissions
          .reply({
            requestID: request.id,
            reply: input.permissionReply?.reply ?? "reject",
            message: input.permissionReply?.message,
          })
          .pipe(Effect.orDie)
      })
      yield* Effect.addFinalizer(() => unsubscribe)
      const unsubscribeQuestions = yield* events.listen((event) => {
        if (event.type !== Question.Event.Asked.type) return Effect.void
        const request = event.data as (typeof questionRequests)[number]
        questionRequests.push(request)
        const questionAction = input.questionAction
        if (questionAction?.type === "abort") {
          request.latch = { type: "abort" }
          return prompts.cancel(request.sessionID as SessionID).pipe(Effect.orDie)
        }
        if (questionAction?.type === "background") {
          return Effect.gen(function* () {
            const child = yield* sessions.get(request.sessionID as SessionID)
            if (!child.parentID) return yield* Effect.die(new Error("Background child has no parent Session"))
            const observation = yield* Effect.gen(function* () {
              const messages = yield* sessions.messages({ sessionID: child.parentID as SessionID })
              const taskRunning = messages.some((message) =>
                message.parts.some(
                  (part) =>
                    part.type === "tool" &&
                    part.tool === "task" &&
                    part.state.status === "completed" &&
                    part.state.output.includes('state="running"'),
                ),
              )
              return taskRunning ? true : undefined
            }).pipe(
              Effect.repeat({ while: (value) => value === undefined, schedule: Schedule.spaced("50 millis") }),
              Effect.timeout(config.timeoutMs),
            )
            request.latch = {
              type: "background",
              parentSessionID: child.parentID,
              taskRunning: observation === true,
            }
            yield* questions.reply({
              requestID: request.id,
              answers: [[questionAction.reply]],
            })
          }).pipe(Effect.orDie)
        }
        if (input.questionReply !== undefined) {
          return questions.reply({ requestID: request.id, answers: [[input.questionReply]] }).pipe(Effect.orDie)
        }
        return questions.reject(request.id).pipe(Effect.orDie)
      })
      yield* Effect.addFinalizer(() => unsubscribeQuestions)
      const sharedSession = input.sharedSession
        ? yield* sessions.create({
            title: `Live ${input.suite}: shared Session`,
            permission: Permission.fromConfig(input.primaryPermission ?? input.permission ?? {}),
          })
        : undefined
      const observations = yield* Effect.forEach(input.cases, (testCase) =>
        Effect.gen(function* () {
          const session = sharedSession ?? (yield* sessions.create({ title: `Live ${input.suite}: ${testCase.name}` }))
          if (input.beforeCase) {
            yield* Effect.promise(() =>
              input.beforeCase!({ caseName: testCase.name, directory: instance.directory, sandbox }),
            )
          }
          const messagesBefore = yield* sessions.messages({ sessionID: session.id })
          const toolCountBefore = messagesBefore.reduce(
            (count, message) => count + message.parts.filter((part) => part.type === "tool").length,
            0,
          )
          const userCountBefore = messagesBefore.filter((message) => message.info.role === "user").length
          const assistantCountBefore = messagesBefore.filter((message) => message.info.role === "assistant").length
          const compactionCountBefore = messagesBefore.reduce(
            (count, message) => count + message.parts.filter((part) => part.type === "compaction").length,
            0,
          )
          const requestFingerprintCountBefore = assembledRequestFingerprints.length
          const concurrentSteers = (input.steerDuringCases ?? []).filter(
            (steer) => steer.duringCaseName === testCase.name,
          )
          const steeringEvidence: Array<{
            id: string
            delivery: "steer" | "goal_steer"
            ordinal: number
            activeBeforeAdmission: boolean
            pendingAfterAdmission: boolean
            consumedAfterAdmission: boolean
          }> = []
          const intelligenceDraft = testCase.intelligence
            ? yield* prompts.refineIntelligenceDraft({
                sessionID: session.id,
                rawInput: testCase.prompt,
                outputLanguage: testCase.intelligence.outputLanguage,
              })
            : undefined
          if (intelligenceDraft && (intelligenceDraft.route !== "code" || !intelligenceDraft.prompt_draft_id)) {
            return yield* Effect.die(new Error("Intelligence live case did not produce a confirmable code draft"))
          }
          const turn = prompts.prompt({
            sessionID: session.id,
            model: { providerID, modelID },
            agent: testCase.agent ?? "live-test",
            parts: [{ type: "text", text: testCase.prompt }],
            metadata: intelligenceDraft
              ? {
                  deepagent: {
                    prompt_pipeline: {
                      mode: "intelligence",
                      confirmed_draft_id: intelligenceDraft.prompt_draft_id,
                    },
                  },
                }
              : undefined,
          })
          const result =
            concurrentSteers.length === 0
              ? yield* turn
              : yield* Effect.gen(function* () {
                  const fiber = yield* turn.pipe(Effect.forkChild)
                  const active = yield* runState
                    .isBusy(session.id)
                    .pipe(
                      Effect.repeat({ while: (busy) => !busy, schedule: Schedule.spaced("10 millis") }),
                      Effect.timeout(config.timeoutMs),
                    )
                  if (!active)
                    return yield* Effect.die(new Error("Prompt did not enter an active turn before steering"))
                  yield* Effect.forEach(
                    concurrentSteers,
                    (steer, index) =>
                      Effect.gen(function* () {
                        const activeBeforeAdmission = yield* runState.isBusy(session.id)
                        const ingress = yield* prompts.promptOrSteer({
                          sessionID: session.id,
                          messageID: MessageID.ascending(),
                          model: { providerID, modelID },
                          agent: testCase.agent ?? "live-test",
                          parts: [{ type: "text", text: steer.text }],
                        })
                        if (ingress.kind !== "steer")
                          return yield* Effect.die(new Error(`Steer ${index + 1} started a second turn`))
                        const pendingAfterAdmission = (yield* steers.pending(session.id, ingress.delivery)).some(
                          (item) => item.id === ingress.admitted.id,
                        )
                        steeringEvidence.push({
                          id: ingress.admitted.id,
                          delivery: ingress.delivery,
                          ordinal: ingress.admitted.seq,
                          activeBeforeAdmission,
                          pendingAfterAdmission,
                          consumedAfterAdmission: false,
                        })
                      }),
                    { discard: true },
                  )
                  const result = yield* Fiber.join(fiber)
                  yield* Effect.forEach(
                    steeringEvidence,
                    (evidence) =>
                      Effect.gen(function* () {
                        const pendingAfterRun = (yield* steers.pending(session.id)).some(
                          (item) => item.id === evidence.id,
                        )
                        evidence.consumedAfterAdmission = !pendingAfterRun
                      }),
                    { discard: true },
                  )
                  return result
                })
          const panelCase = input.panel?.afterCaseName === testCase.name ? input.panel : undefined
          if (panelCase && sharedSession && agents) {
            const opinions: unknown[] = []
            const model = { providerID: runtimeProviderID, modelID: config.modelID }
            const runTurn = makeTaskSubagentRunner({
              sessions,
              agents,
              sessionPrompt: prompts,
              parentSessionID: session.id,
              model,
              purpose: "panel",
            })
            const verdict = yield* consultPanel(
              {
                question: panelCase.question,
                codeRefs: panelCase.codeRefs,
                lenses: panelCase.lenses,
                maxRounds: panelCase.maxRounds,
                policy: panelCase.policy,
                parentSessionID: session.id,
              },
              {
                runTurn: (turn) =>
                  runTurn({
                    agentType: turn.agentType,
                    prompt: turn.prompt,
                    outputSchema: turn.outputSchema,
                  }).pipe(Effect.map((turnResult) => ({ structured: turnResult.structured }))),
                observeOpinion: ({ opinion }) => Effect.sync(() => opinions.push(structuredClone(opinion))),
              },
            )
            panelEvidence = { verdict, opinions }
          }
          if (input.compactAfterCases?.includes(testCase.name)) {
            yield* compaction.create({
              sessionID: session.id,
              agent: testCase.agent ?? "live-test",
              model: { providerID, modelID },
              auto: false,
            })
            yield* prompts.loop({ sessionID: session.id })
          }
          if (input.awaitParentTools?.length) {
            yield* Effect.gen(function* () {
              const current = yield* sessions.messages({ sessionID: session.id })
              const completed = new Set(
                current.flatMap((message) =>
                  message.parts.flatMap((part) =>
                    part.type === "tool" && part.state.status === "completed" ? [part.tool] : [],
                  ),
                ),
              )
              const latest = current
                .filter(
                  (message): message is SessionV1.WithParts & { info: SessionV1.Assistant } =>
                    message.info.role === "assistant",
                )
                .at(-1)
              const finalText = latest?.parts.some(
                (part) => part.type === "text" && !part.synthetic && !part.ignored && part.text.trim().length > 0,
              )
              return input.awaitParentTools?.every((tool) => completed.has(tool)) &&
                latest?.info.time.completed !== undefined &&
                finalText
                ? true
                : undefined
            }).pipe(
              Effect.repeat({ while: (value) => value === undefined, schedule: Schedule.spaced("100 millis") }),
              Effect.timeout(config.timeoutMs),
            )
          }
          const messages = yield* sessions.messages({ sessionID: session.id })
          const assistants = messages.filter(
            (message): message is SessionV1.WithParts & { info: SessionV1.Assistant } =>
              message.info.role === "assistant",
          )
          const users = messages.filter(
            (message): message is SessionV1.WithParts & { info: SessionV1.User } => message.info.role === "user",
          )
          const currentUsers = users.slice(userCountBefore)
          const currentAssistants = assistants.slice(assistantCountBefore)
          const compactionIndex = messages.findLastIndex((message) =>
            message.parts.some((part) => part.type === "compaction"),
          )
          const children = yield* Effect.forEach(yield* sessions.children(session.id), (child) =>
            Effect.gen(function* () {
              const childMessages = yield* sessions.messages({ sessionID: child.id })
              const childAssistants = childMessages.filter(
                (message): message is SessionV1.WithParts & { info: SessionV1.Assistant } =>
                  message.info.role === "assistant",
              )
              return {
                id: child.id,
                parentID: child.parentID,
                directory: child.directory,
                agent: child.agent,
                model: child.model,
                metadata: child.metadata,
                messageCount: childMessages.length,
                users: childMessages
                  .filter(
                    (message): message is SessionV1.WithParts & { info: SessionV1.User } =>
                      message.info.role === "user",
                  )
                  .map((message) => ({
                    format: message.info.format,
                    metadata: message.info.metadata,
                    text: message.parts
                      .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
                      .join(""),
                  })),
                assistants: childAssistants.map((message) => ({
                  providerID: message.info.providerID,
                  modelID: message.info.modelID,
                  path: message.info.path,
                  finish: message.info.finish,
                  structured: message.info.structured,
                  text: message.parts
                    .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
                    .join(""),
                  tools: message.parts
                    .filter((part) => part.type === "tool")
                    .map((part) => ({
                      id: part.callID,
                      name: part.tool,
                      status: part.state.status,
                      input: part.state.input,
                      output: part.state.status === "completed" ? part.state.output : undefined,
                      error: part.state.status === "error" ? part.state.error : undefined,
                      metadata: "metadata" in part.state ? part.state.metadata : undefined,
                    })),
                })),
              }
            }),
          )
          const tools = assistants.flatMap((message) =>
            message.parts
              .filter((part) => part.type === "tool")
              .map((part) => ({
                id: part.callID,
                name: part.tool,
                status: part.state.status,
                input: part.state.input,
                output: part.state.status === "completed" ? part.state.output : undefined,
                error: part.state.status === "error" ? part.state.error : undefined,
                metadata: "metadata" in part.state ? part.state.metadata : undefined,
              })),
          )
          const compactions = messages.flatMap((message) =>
            message.parts.flatMap((part) =>
              part.type === "compaction"
                ? [
                    {
                      messageID: message.info.id,
                      auto: part.auto,
                      overflow: part.overflow,
                      tailStartID: part.tail_start_id,
                    },
                  ]
                : [],
            ),
          )
          const info = yield* sessions.get(session.id)
          return {
            name: testCase.name,
            sessionID: session.id,
            assembledRequestFingerprints: assembledRequestFingerprints
              .slice(requestFingerprintCountBefore)
              .filter((event) => event.payload?.properties?.sessionID === session.id)
              .map((event) => event.payload.properties),
            steering: steeringEvidence,
            messageCount: messages.length,
            intelligenceDraft,
            users: currentUsers.map((message) => ({
              metadata: message.info.metadata,
              text: message.parts
                .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
                .join(""),
              syntheticText: message.parts
                .flatMap((part) => (part.type === "text" && part.synthetic ? [part.text] : []))
                .join(""),
            })),
            assistantTurns: currentAssistants.length,
            summaryTexts: currentAssistants
              .filter((message) => message.info.summary === true)
              .map((message) =>
                message.parts
                  .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
                  .join(""),
              ),
            tools,
            newTools: tools.slice(toolCountBefore),
            compactionCount: compactions.length,
            compactions,
            newCompactions: compactions.slice(compactionCountBefore),
            compactionTexts:
              compactionIndex < 0
                ? []
                : messages
                    .slice(compactionIndex + 1)
                    .filter(
                      (message): message is SessionV1.WithParts & { info: SessionV1.Assistant } =>
                        message.info.role === "assistant",
                    )
                    .map((message) =>
                      message.parts
                        .flatMap((part) =>
                          part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : [],
                        )
                        .join(""),
                    ),
            finalText: result.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(""),
            allText: assistants
              .flatMap((message) =>
                message.parts.flatMap((part) =>
                  part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : [],
                ),
              )
              .join("\n"),
            finishReasons: currentAssistants.map((message) => message.info.finish),
            models: currentAssistants.map((message) => ({
              providerID: message.info.providerID,
              modelID: message.info.modelID,
            })),
            usage: currentAssistants.reduce(
              (total, message) => ({
                input:
                  total.input +
                  message.info.tokens.input +
                  message.info.tokens.cache.read +
                  message.info.tokens.cache.write,
                output: total.output + message.info.tokens.output,
                reasoning: total.reasoning + message.info.tokens.reasoning,
              }),
              { input: 0, output: 0, reasoning: 0 },
            ),
            sessionUsage: info.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            permissionRequests: permissionRequests
              .filter(
                (request) =>
                  request.sessionID === session.id || children.some((child) => child.id === request.sessionID),
              )
              .map((request) => ({
                id: request.id,
                sessionID: request.sessionID,
                permission: request.permission,
                patterns: request.patterns,
                tool: request.tool,
              })),
            questionRequests: questionRequests
              .filter(
                (request) =>
                  request.sessionID === session.id || children.some((child) => child.id === request.sessionID),
              )
              .map((request) => ({
                id: request.id,
                sessionID: request.sessionID,
                questionCount: request.questions.length,
                tool: request.tool,
                latch: request.latch,
              })),
            children,
          }
        }),
      )
      return {
        observations,
        workspace: {
          directory: instance.directory,
          files: Object.fromEntries(
            yield* Effect.forEach(input.inspectFiles ?? [], (file) =>
              Effect.promise(
                async () =>
                  [
                    file,
                    (await Bun.file(path.join(instance.directory, file)).exists())
                      ? await Bun.file(path.join(instance.directory, file)).text()
                      : undefined,
                  ] as const,
              ),
            ),
          ),
          status: yield* Effect.promise(() => git(instance.directory, "status", "--short", "--untracked-files=all")),
        },
        evaluation: input.evaluateWorkspace
          ? yield* Effect.promise(() => input.evaluateWorkspace!(instance.directory, sandbox))
          : undefined,
        panel: panelEvidence,
      }
    })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped({
          git: true,
          config: liveWorkspaceConfig(config, input.permission, input.primaryPermission, input.mcp, {
            primaryPrompt: input.primaryPrompt,
            modelMaxTokens: input.modelMaxTokens,
            modelContextTokens: input.modelContextTokens,
            maxProviderTurns: input.maxProviderTurns,
            toolOutput: input.toolOutput,
            agentPermissions: input.agentPermissions,
          }),
          init: (directory) =>
            Effect.promise(async () => {
              await Promise.all(
                Object.entries(input.files ?? {}).map(async ([file, content]) => {
                  await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
                  await Bun.write(path.join(directory, file), content)
                }),
              )
              if (input.packageScripts) {
                await Bun.write(
                  path.join(directory, "package.json"),
                  JSON.stringify({ private: true, scripts: input.packageScripts }),
                )
              }
              sandbox = input.toolSandbox
                ? await prepareToolSandbox({
                    workspace: directory,
                    testRoot,
                    verifierScript: input.toolSandbox.verifierScript,
                    additionalWorkspaceRoots: [path.join(isolatedData, "worktree")],
                  })
                : undefined
              if (sandbox && input.toolSandbox?.initialVerifier) {
                const process = Bun.spawn([sandbox.shell, "-c", "./verify"], {
                  cwd: directory,
                  stdout: "ignore",
                  stderr: "ignore",
                })
                const exitCode = await process.exited
                const passed = exitCode === 0
                if (passed !== (input.toolSandbox.initialVerifier === "pass")) {
                  throw new Error(
                    `Initial hidden verifier unexpectedly ${passed ? "passed" : `failed with exit ${exitCode}`}`,
                  )
                }
                initialVerifier = { expected: input.toolSandbox.initialVerifier, exitCode }
              }
              if (sandbox) {
                const configFile = path.join(directory, "deepagent-code.json")
                const workspaceConfig: unknown = await Bun.file(configFile).json()
                if (typeof workspaceConfig !== "object" || workspaceConfig === null || Array.isArray(workspaceConfig)) {
                  throw new Error("Legacy live workspace config is invalid")
                }
                await Bun.write(configFile, JSON.stringify({ ...workspaceConfig, shell: sandbox.shell }))
              }
              await git(directory, "add", ".")
              await git(directory, "commit", "-m", "test fixture")
            }),
        })
        const instances = yield* InstanceStore.Service
        return yield* instances.provide({ directory }, program.pipe(Effect.provideService(TestInstance, { directory })))
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            SessionPrompt.defaultLayer,
            Agent.defaultLayer,
            SessionRunState.defaultLayer,
            SessionSteer.defaultLayer,
            SessionCompaction.defaultLayer,
            Session.defaultLayer,
            Permission.defaultLayer,
            Question.defaultLayer,
            EventV2Bridge.defaultLayer,
            Worktree.appLayer,
            CrossSpawnSpawner.defaultLayer,
          ).pipe(Layer.provideMerge(testInstanceStoreLayer)),
        ),
        Effect.timeout(
          Math.min(config.timeoutMs, input.timeoutMs ?? config.timeoutMs) * Math.max(1, input.cases.length),
        ),
      ),
    )

    return {
      suite: input.suite,
      mode: "live" as const,
      stack: "legacy-session" as const,
      status: "passed" as const,
      fingerprint: { ...modelFingerprint(config), runtimeProviderID },
      preflight: { durationMs: preflight.durationMs },
      sandbox: sandbox?.evidence,
      initialVerifier,
      cases: result.observations,
      workspace: result.workspace,
      evaluation: result.evaluation,
      panel: result.panel,
      durationMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
    }
  } finally {
    restoreEnvironment(environment)
    await rm(testRoot, { recursive: true, force: true })
  }
}

const isolationEnvironmentKeys = [
  "HOME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "DEEPAGENT_CODE_TEST_HOME",
  "DEEPAGENT_CODE_HOME",
  "DEEPAGENT_CODE_CONFIG_DIR",
  "DEEPAGENT_CODE_DISABLE_AUTOUPDATE",
  "DEEPAGENT_CODE_DISABLE_MODELS_FETCH",
  "DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS",
  "DEEPAGENT_CODE_DISABLE_LSP_DOWNLOAD",
  "DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE",
  "DEEPAGENT_CODE_ASSEMBLED_REQUEST_FINGERPRINT",
  "DEEPAGENT_ENABLED",
  "DEEPAGENT_MODE",
] as const

function isolationEnvironment(additionalKeys: string[] = []) {
  return Object.fromEntries(
    [...new Set([...isolationEnvironmentKeys, ...additionalKeys])].map((key) => [key, process.env[key]]),
  )
}

function restoreEnvironment(environment: Record<string, string | undefined>) {
  Object.entries(environment).forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key]
      return
    }
    process.env[key] = value
  })
}

async function prepareIsolation(
  testRoot: string,
  isolatedHome: string,
  isolatedData: string,
  config: LiveLLMConfig,
  environment?: Readonly<Record<string, string>>,
) {
  await Promise.all([
    mkdir(isolatedHome, { recursive: true }),
    mkdir(path.join(isolatedData, "node_modules"), { recursive: true }),
    mkdir(path.join(isolatedData, "worktree"), { recursive: true }),
  ])
  await Bun.write(
    path.join(isolatedData, "package.json"),
    JSON.stringify({ private: true, dependencies: { "@deepagent-code/plugin": "workspace:*" } }),
  )
  await Bun.write(
    path.join(isolatedData, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { dependencies: { "@deepagent-code/plugin": "workspace:*" } } },
    }),
  )
  process.env.HOME = isolatedHome
  process.env.XDG_DATA_HOME = path.join(testRoot, "data")
  process.env.XDG_CONFIG_HOME = path.join(testRoot, "config")
  process.env.XDG_CACHE_HOME = path.join(testRoot, "cache")
  process.env.XDG_STATE_HOME = path.join(testRoot, "state")
  process.env.DEEPAGENT_CODE_TEST_HOME = isolatedHome
  process.env.DEEPAGENT_CODE_HOME = isolatedData
  process.env.DEEPAGENT_CODE_CONFIG_DIR = isolatedData
  process.env.DEEPAGENT_CODE_DISABLE_AUTOUPDATE = "1"
  process.env.DEEPAGENT_CODE_DISABLE_MODELS_FETCH = "1"
  process.env.DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS = "1"
  process.env.DEEPAGENT_CODE_DISABLE_LSP_DOWNLOAD = "1"
  process.env.DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE = config.apiKeyFile
  process.env.DEEPAGENT_ENABLED = "false"
  process.env.DEEPAGENT_MODE = "general"
  Object.entries(environment ?? {}).forEach(([key, value]) => {
    process.env[key] = value
  })
}

export function liveWorkspaceConfig(
  config: LiveLLMConfig,
  permission: ConfigV1.Info["permission"],
  primaryPermission = permission,
  mcp?: ConfigV1.Info["mcp"],
  options?: {
    primaryPrompt?: string
    modelMaxTokens?: number
    modelContextTokens?: number
    maxProviderTurns?: number
    toolOutput?: ConfigV1.Info["tool_output"]
    agentPermissions?: Readonly<Record<string, ConfigV1.Info["permission"]>>
  },
): ConfigV1.Info {
  return {
    snapshot: false,
    enabled_providers: [runtimeProviderID],
    model: `${runtimeProviderID}/${config.modelID}`,
    permission,
    mcp,
    tool_output: options?.toolOutput,
    agent: {
      "live-test": {
        mode: "primary",
        steps: options?.maxProviderTurns,
        prompt:
          options?.primaryPrompt ??
          "This is a constrained tool contract test. Follow the user's requested tool sequence exactly, do not call unavailable tools, and do not add validation steps.",
        permission: primaryPermission,
      },
      ...Object.fromEntries(
        Object.entries(options?.agentPermissions ?? {}).map(([name, agentPermission]) => [
          name,
          { permission: agentPermission },
        ]),
      ),
    },
    provider: {
      [runtimeProviderID]: {
        name: "DeepSeek legacy live test",
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
            limit: { context: options?.modelContextTokens ?? 1_000_000, output: 2048 },
            cost: { input: 0, output: 0 },
            modalities: { input: ["text"], output: ["text"] },
            options: { thinking: { type: "disabled" }, maxTokens: options?.modelMaxTokens ?? 512, temperature: 0 },
          },
        },
      },
    },
  }
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
