import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
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

export async function directoryExists(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory()
  } catch {
    return false
  }
}

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
    expectedRoute?: "code" | "general"
  }
  admission?: {
    intentID: string
    source: "composer" | "intelligence" | "followup" | "rewrite"
    variant: "original" | "rewritten"
    exactRetry?: boolean
    conflictingRetry?: {
      prompt: string
      variant: "original" | "rewritten"
    }
  }
  revertBefore?: {
    targetCase: string
    retryTargetIntent?: boolean
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

export type V4LiveEventCase = {
  type: "ci.failure" | "ci.repair.requested" | "git.push" | "monitor.alert" | "pr.comment" | "schedule.scan"
  source: "ci" | "git" | "monitor" | "schedule"
  payload: Record<string, unknown>
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
  inspectChildFiles?: string[]
  inspectPRCollaboration?: boolean
  packageScripts?: Readonly<Record<string, string>>
  toolSandbox?: { verifierScript?: string; initialVerifier?: "fail" | "pass" }
  verifyChildWorktrees?: boolean
  permissionReply?: { reply: "once" | "always" | "reject"; message?: string }
  permissionBarrierCount?: number
  questionReply?: string
  questionAction?: { type: "abort" } | { type: "background"; reply: string } | { type: "hold" }
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
  subagentIntensity?: "inherit" | "downgrade"
  environment?: Readonly<Record<string, string>>
  panel?: LegacyPanelCase
  v4Event?: V4LiveEventCase
}) {
  const config = await loadLiveLLMConfig()
  if (
    input.permissionBarrierCount !== undefined &&
    (!Number.isSafeInteger(input.permissionBarrierCount) || input.permissionBarrierCount < 2)
  ) {
    throw new Error("permissionBarrierCount must be an integer greater than or equal to 2")
  }
  if (input.verifyChildWorktrees && !input.toolSandbox?.verifierScript) {
    throw new Error("verifyChildWorktrees requires a toolSandbox verifierScript")
  }
  if (!input.sharedSession && input.cases.some((testCase) => testCase.revertBefore)) {
    throw new Error("revertBefore requires sharedSession so the target and rewrite use one durable Session")
  }
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
    const { EffectFlock } = await import("@deepagent-code/core/util/effect-flock")
    const { Context, Deferred, Effect, Fiber, Layer, Schedule } = await import("effect")
    const { eq } = await import("drizzle-orm")
    const { AgentExecution } = await import("@deepagent-code/core/deepagent/agent-execution")
    const { ApprovalQueue } = await import("@deepagent-code/core/deepagent/approval-queue")
    const { DeepAgentEventBus } = await import("@deepagent-code/core/deepagent/deepagent-event-bus")
    const { Scheduler } = await import("@deepagent-code/core/deepagent/scheduler")
    const { TaskPartitioner } = await import("@deepagent-code/core/deepagent/task-partitioner")
    const { BUILTIN_AGENT_DESCRIPTORS } = await import("@deepagent-code/core/im/builtin-agents")
    const { AgentListProviderService } = await import("@deepagent-code/core/im/agent-list-provider")
    const { Database } = await import("@deepagent-code/core/database/database")
    const globalBus = GlobalBus as unknown as EventEmitter
    const { EventV2Bridge } = await import("../../src/event-v2-bridge")
    const { Agent } = await import("../../src/agent/agent")
    const { PRQueue } = await import("../../src/agent/pr-queue")
    const { Git } = await import("../../src/git")
    const { Permission } = await import("../../src/permission")
    const { Question } = await import("../../src/question")
    const { SessionCompaction } = await import("../../src/session/compaction")
    const { SessionPromptIntent } = await import("../../src/session/prompt-intent")
    const { SessionPrompt } = await import("../../src/session/prompt")
    const { SessionRevert } = await import("../../src/session/revert")
    const { SessionRunState } = await import("../../src/session/run-state")
    const { MessageID } = await import("../../src/session/schema")
    const { SessionSteer } = await import("../../src/session/steer")
    const { Session } = await import("../../src/session/session")
    const { SessionIntentTable } = await import("@deepagent-code/core/session/sql")
    const { EventDispatcher } = await import("../../src/session/event-dispatcher")
    const { MultiAgentRuntime } = await import("../../src/session/multi-agent-runtime")
    const { makeEventTurnRunner } = await import("../../src/session/v4-event-runtime")
    const { V4PRCollaboration } = await import("../../src/session/v4-pr-collaboration")
    const { RuntimeFlags } = await import("../../src/effect/runtime-flags")
    const { InstanceRef } = await import("../../src/effect/instance-ref")
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
      const database = yield* Database.Service
      const runState = yield* SessionRunState.Service
      const steers = yield* SessionSteer.Service
      const compaction = yield* SessionCompaction.Service
      const revert = yield* SessionRevert.Service
      const sessions = yield* Session.Service
      const instance = yield* TestInstance
      const parentInstance = yield* InstanceRef
      if (!parentInstance) return yield* Effect.die(new Error("Live LLM harness has no parent InstanceRef"))
      const permissions = yield* Permission.Service
      const questions = yield* Question.Service
      const agents = input.panel || input.v4Event ? yield* Agent.Service : undefined
      const instances = input.v4Event ? yield* InstanceStore.Service : undefined
      const gitService = input.v4Event ? yield* Git.Service : undefined
      const prQueue = input.v4Event ? yield* PRQueue.Service : undefined
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
      const permissionLocations = new Map<PermissionV1.ID, { directory?: string; workspaceID?: string }>()
      const permissionBarrier = input.permissionBarrierCount ? yield* Deferred.make<void>() : undefined
      const permissionBarrierSnapshots: string[][] = []
      const questionRequests: Array<{
        id: QuestionID
        sessionID: string
        questions: ReadonlyArray<unknown>
        tool?: { messageID: string; callID: string }
        latch?: { type: "abort" | "background" | "hold"; parentSessionID?: string; taskRunning?: boolean }
      }> = []
      const events = yield* EventV2Bridge.Service
      const unsubscribe = yield* events.listen((event) => {
        if (event.type !== Permission.Event.Asked.type) return Effect.void
        const request = event.data as PermissionV1.Request
        permissionRequests.push(request)
        permissionLocations.set(request.id, {
          directory: event.location?.directory,
          workspaceID: event.location?.workspaceID,
        })
        return Effect.gen(function* () {
          if (permissionBarrier && input.permissionBarrierCount) {
            if (permissionRequests.length === input.permissionBarrierCount) {
              permissionBarrierSnapshots.push(
                (yield* permissions.list().pipe(Effect.provideService(InstanceRef, parentInstance))).map((item) =>
                  String(item.id),
                ),
              )
              yield* Deferred.succeed(permissionBarrier, undefined)
            }
            yield* Deferred.await(permissionBarrier)
          }
          yield* permissions.reply({
            requestID: request.id,
            reply: input.permissionReply?.reply ?? "reject",
            message: input.permissionReply?.message,
          })
        }).pipe(Effect.provideService(InstanceRef, parentInstance), Effect.orDie)
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
        if (questionAction?.type === "hold") {
          request.latch = { type: "hold" }
          return Effect.void
        }
        if (input.questionReply !== undefined) {
          return questions.reply({ requestID: request.id, answers: [[input.questionReply]] }).pipe(Effect.orDie)
        }
        return questions.reject(request.id).pipe(Effect.orDie)
      })
      yield* Effect.addFinalizer(() => unsubscribeQuestions)
      const v4Event = input.v4Event
      const v4 =
        v4Event && agents && instances && gitService && prQueue
          ? yield* Effect.gen(function* () {
              const database = yield* Database.Service
              const databaseLayer = Layer.succeed(Database.Service, database)
              const core = Layer.mergeAll(
                DeepAgentEventBus.layer,
                ApprovalQueue.layer,
                AgentExecution.layer,
                Scheduler.layer,
              ).pipe(Layer.provide(databaseLayer))
              const flags = RuntimeFlags.layer({ v4MultiAgentRuntime: true })
              const registry = Layer.succeed(AgentListProviderService, {
                listAgents: () => Effect.succeed([...BUILTIN_AGENT_DESCRIPTORS]),
                findByTrigger: () => Effect.succeed([]),
                findByCapability: () => Effect.succeed([]),
              })
              const runtime = Layer.unwrap(
                Effect.gen(function* () {
                  const execution = yield* AgentExecution.Service
                  const bus = yield* DeepAgentEventBus.Service
                  const approvalQueue = yield* ApprovalQueue.Service
                  return MultiAgentRuntime.layerWith({
                    execution,
                    trustedSources: [v4Event.source],
                    onEventCompleted: V4PRCollaboration.make({
                      sessions,
                      instanceStore: instances,
                      git: gitService,
                      queue: prQueue,
                      bus,
                      approvalQueue,
                    }),
                    runner: makeEventTurnRunner({
                      sessions,
                      agents,
                      sessionPrompt: prompts,
                      instanceStore: instances,
                      defaultModel: () => Effect.succeed({ providerID, modelID }),
                    }),
                  })
                }),
              ).pipe(Layer.provide(core), Layer.provide(registry))
              const dispatcher = Layer.unwrap(
                Effect.gen(function* () {
                  const multiAgent = yield* MultiAgentRuntime.Service
                  const bus = yield* DeepAgentEventBus.Service
                  return EventDispatcher.layerWith({
                    dispatchPort: { dispatch: multiAgent.dispatch },
                    runLoops: false,
                    pendingDeliveryCount: bus.pendingDeliveryCount,
                  })
                }),
              ).pipe(Layer.provide(runtime), Layer.provide(core), Layer.provide(registry), Layer.provide(flags))
              const context = yield* Layer.build(Layer.mergeAll(core, registry, runtime, dispatcher, flags))
              const bus = Context.get(context, DeepAgentEventBus.Service)
              const execution = Context.get(context, AgentExecution.Service)
              const eventDispatcher = Context.get(context, EventDispatcher.Service)
              yield* bus.registerConsumerGroup(EventDispatcher.DISPATCH_GROUP, v4Event.type)
              const event = yield* bus.publish({
                type: v4Event.type,
                source: v4Event.source,
                workspaceID: instance.directory,
                idempotencyKey: `live-v4:${input.suite}`,
                priority: "normal",
                payload: { ...v4Event.payload, directory: instance.directory },
              })
              const sourceDeliveryPendingBefore = (yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)).some(
                (delivery) =>
                  delivery.subscriptionGroup === EventDispatcher.DISPATCH_GROUP && delivery.eventID === event.id,
              )
              const decision = yield* eventDispatcher.handle(event)
              const sourceDeliveryPendingAfter = (yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)).some(
                (delivery) =>
                  delivery.subscriptionGroup === EventDispatcher.DISPATCH_GROUP && delivery.eventID === event.id,
              )
              const tasks = TaskPartitioner.partition(event, { stableIDPrefix: event.id }).subtasks
              const executions = yield* Effect.forEach(tasks, (task) =>
                execution.get({ workspaceID: event.workspaceID, eventID: event.id, taskID: task.id }),
              )
              const summary = {
                event,
                outcomes: tasks.map((task, index) => ({
                  taskID: task.id,
                  capability: task.capability,
                  status: executions[index]?.status === "completed" ? ("completed" as const) : ("blocked" as const),
                  agentID: executions[index]?.agentID,
                  ...(executions[index]?.status === "completed"
                    ? {}
                    : { reason: executions[index]?.lastError ?? executions[index]?.status ?? "execution_missing" }),
                })),
                hasUnfinished: executions.some((record) => record?.status !== "completed"),
              }
              const refs = [
                ...new Set(executions.flatMap((record) => (record?.continuationRef ? [record.continuationRef] : []))),
              ]
              const refFiles = yield* Effect.promise(async () =>
                Object.fromEntries(
                  await Promise.all(
                    refs.map(async (ref) => [
                      ref,
                      Object.fromEntries(
                        await Promise.all(
                          (input.inspectFiles ?? []).map(async (file) => {
                            const child = Bun.spawn(["git", "show", `${ref}:${file}`], {
                              cwd: instance.directory,
                              stdout: "pipe",
                              stderr: "ignore",
                            })
                            const [content, exitCode] = await Promise.all([
                              new Response(child.stdout).text(),
                              child.exited,
                            ])
                            return [file, exitCode === 0 ? content : undefined] as const
                          }),
                        ),
                      ),
                    ] as const),
                  ),
                ),
              )
              const sessionIDs = [
                ...new Set(
                  executions.flatMap((record) =>
                    (record?.artifacts ?? [])
                      .filter((artifact) => artifact.startsWith("session:"))
                      .map((artifact) => artifact.slice("session:".length)),
                  ),
                ),
              ]
              const childSessions = yield* Effect.forEach(sessionIDs, (sessionID) =>
                Effect.gen(function* () {
                  const info = yield* sessions.get(sessionID as SessionID)
                  const messages = yield* sessions.messages({ sessionID: info.id })
                  return {
                    id: info.id,
                    agent: info.agent,
                    directory: info.directory,
                    parentID: info.parentID,
                    assistants: messages.flatMap((message) =>
                      message.info.role !== "assistant"
                        ? []
                        : [
                            {
                              providerID: message.info.providerID,
                              modelID: message.info.modelID,
                              error: message.info.error,
                              tokens: message.info.tokens,
                              tools: message.parts
                                .filter((part) => part.type === "tool")
                                .map((part) => ({ name: part.tool, status: part.state.status })),
                            },
                          ],
                    ),
                  }
                }),
              )
              const parentSessionID = MultiAgentRuntime.parentSessionIDFor(event.id)
              const parentSession = yield* sessions.get(parentSessionID)
              const collaborationEntries = (yield* prQueue.list()).filter(
                (entry) => entry.metadata?.eventID === event.id,
              )
              const approvals = yield* Context.get(context, ApprovalQueue.Service).listPending(event.workspaceID)
              return {
                event,
                dispatch: { decision, sourceDeliveryPendingBefore, sourceDeliveryPendingAfter },
                summary,
                executions,
                childSessions,
                parentSession: {
                  id: parentSession.id,
                  directory: parentSession.directory,
                  children: childSessions.map((session) => ({
                    id: session.id,
                    parentID: session.parentID,
                  })),
                },
                prCollaboration: {
                  entries: collaborationEntries,
                  approvals,
                  branch: yield* gitService.branch(instance.directory),
                  worktrees: (yield* gitService.run(["worktree", "list", "--porcelain"], { cwd: instance.directory })).text(),
                },
                refFiles,
                permissionRequests: permissionRequests.filter((request) => sessionIDs.includes(request.sessionID)),
                questionRequests: questionRequests.filter((request) => sessionIDs.includes(request.sessionID)),
                pendingPermissionIDs: (yield* permissions
                  .list()
                  .pipe(Effect.provideService(InstanceRef, parentInstance))).map((request) => String(request.id)),
                pendingQuestionIDs: (yield* questions.list()).map((request) => String(request.id)),
              }
            })
          : undefined
      const sharedSession = input.sharedSession
        ? yield* sessions.create({
            title: `Live ${input.suite}: shared Session`,
            permission: Permission.fromConfig(input.primaryPermission ?? input.permission ?? {}),
          })
        : undefined
      const admittedCases = new Map<
        string,
        Parameters<typeof prompts.promptAsync>[0] & {
          readonly intentID: string
          readonly messageID: ReturnType<typeof MessageID.make>
        }
      >()
      const observations = yield* Effect.forEach(input.cases, (testCase) =>
        Effect.gen(function* () {
          const session = sharedSession ?? (yield* sessions.create({ title: `Live ${input.suite}: ${testCase.name}` }))
          if (input.beforeCase) {
            yield* Effect.promise(() =>
              input.beforeCase!({ caseName: testCase.name, directory: instance.directory, sandbox }),
            )
          }
          const revertEvidence = testCase.revertBefore
            ? yield* Effect.gen(function* () {
                const target = admittedCases.get(testCase.revertBefore!.targetCase)
                if (!target || target.sessionID !== session.id) {
                  return yield* Effect.die(
                    new Error(`Missing same-Session revert target ${testCase.revertBefore!.targetCase}`),
                  )
                }
                const epochBefore = yield* sessions.mutationEpoch(session.id).pipe(Effect.orDie)
                yield* revert.revert({ sessionID: session.id, messageID: target.messageID })
                const epochAfter = yield* sessions.mutationEpoch(session.id).pipe(Effect.orDie)
                const retry = testCase.revertBefore!.retryTargetIntent
                  ? yield* prompts
                      .promptAsync({ ...target, messageID: MessageID.ascending() })
                      .pipe(
                        Effect.as({ accepted: true as const }),
                        Effect.catch((error) =>
                          Effect.succeed({ accepted: false as const, error: liveErrorName(error) }),
                        ),
                      )
                  : undefined
                if (retry?.accepted) {
                  return yield* Effect.die(new Error("A pre-revert prompt intent was admitted in a newer mutation epoch"))
                }
                yield* revert.cleanup(yield* sessions.get(session.id).pipe(Effect.orDie), epochAfter)
                return {
                  targetCase: testCase.revertBefore!.targetCase,
                  targetMessageID: target.messageID,
                  epochBefore,
                  epochAfter,
                  retry,
                }
              })
            : undefined
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
          if (testCase.admission) {
            yield* SessionPromptIntent.prepare({
              intentID: testCase.admission.intentID,
              sessionID: session.id,
              source: testCase.admission.source,
            }).pipe(Effect.provideService(Database.Service, database))
          }
          const intelligenceDraft = testCase.intelligence
            ? yield* prompts.refineIntelligenceDraft({
                sessionID: session.id,
                rawInput: testCase.prompt,
                outputLanguage: testCase.intelligence.outputLanguage,
              })
            : undefined
          const expectedIntelligenceRoute = testCase.intelligence?.expectedRoute ?? "code"
          if (intelligenceDraft && intelligenceDraft.route !== expectedIntelligenceRoute) {
            return yield* Effect.die(
              new Error(
                `Intelligence live case expected ${expectedIntelligenceRoute} but received ${intelligenceDraft.route}`,
              ),
            )
          }
          if (intelligenceDraft?.route === "code" && !intelligenceDraft.prompt_draft_id) {
            return yield* Effect.die(new Error("Intelligence live case did not produce a confirmable code draft"))
          }
          const metadata = intelligenceDraft
            ? intelligenceDraft.route === "code"
              ? {
                  deepagent: {
                    prompt_pipeline: {
                      mode: "intelligence" as const,
                      confirmed_draft_id: intelligenceDraft.prompt_draft_id,
                    },
                  },
                }
              : {
                  deepagent: {
                    agent_mode_override: "general" as const,
                    prompt_pipeline: { mode: "direct_override" as const },
                  },
                }
            : undefined
          const promptInput = {
            sessionID: session.id,
            model: { providerID, modelID },
            agent: testCase.agent ?? "live-test",
            parts: [{ type: "text", text: testCase.prompt }],
            metadata,
            ...(testCase.admission
              ? {
                  messageID: MessageID.ascending(),
                  intentID: testCase.admission.intentID,
                  intentSource: testCase.admission.source,
                  intentVariant: testCase.admission.variant,
                }
              : {}),
          } satisfies Parameters<typeof prompts.prompt>[0]
          const admissionRetryEvidence: Array<{
            activeBeforeRetry: boolean
            exact?: { accepted: true; userCountBefore: number; userCountAfter: number }
            conflict?: { accepted: boolean; error?: string }
          }> = []
          const turn = testCase.admission
            ? Effect.gen(function* () {
                yield* prompts.promptAsync(promptInput)
                if (!promptInput.messageID) {
                  return yield* Effect.die(new Error("Durable admission did not reserve a message ID"))
                }
                admittedCases.set(testCase.name, {
                  ...promptInput,
                  intentID: testCase.admission!.intentID,
                  messageID: promptInput.messageID,
                })
                const hasRetry = testCase.admission!.exactRetry || testCase.admission!.conflictingRetry
                const activeBeforeRetry = hasRetry
                  ? yield* runState
                      .isBusy(session.id)
                      .pipe(
                        Effect.repeat({ while: (busy) => !busy, schedule: Schedule.spaced("10 millis") }),
                        Effect.timeout(config.timeoutMs),
                      )
                  : false
                if (hasRetry && !activeBeforeRetry) {
                  return yield* Effect.die(new Error("Admitted prompt did not enter an active turn before retry"))
                }
                const exact = testCase.admission!.exactRetry
                  ? yield* Effect.gen(function* () {
                      const before = (yield* sessions.messages({ sessionID: session.id })).filter(
                        (message) => message.info.role === "user",
                      ).length
                      yield* prompts.promptAsync({ ...promptInput, messageID: MessageID.ascending() })
                      const after = (yield* sessions.messages({ sessionID: session.id })).filter(
                        (message) => message.info.role === "user",
                      ).length
                      if (after !== before) {
                        return yield* Effect.die(new Error("An exact prompt intent retry created another user message"))
                      }
                      return { accepted: true as const, userCountBefore: before, userCountAfter: after }
                    })
                  : undefined
                const conflict = testCase.admission!.conflictingRetry
                  ? yield* prompts
                      .promptAsync({
                        ...promptInput,
                        messageID: MessageID.ascending(),
                        intentVariant: testCase.admission!.conflictingRetry.variant,
                        parts: [{ type: "text", text: testCase.admission!.conflictingRetry.prompt }],
                      })
                      .pipe(
                        Effect.as({ accepted: true as const }),
                        Effect.catch((error) =>
                          Effect.succeed({ accepted: false as const, error: liveErrorName(error) }),
                        ),
                      )
                  : undefined
                if (conflict?.accepted) {
                  return yield* Effect.die(new Error("A conflicting prompt intent retry was admitted"))
                }
                admissionRetryEvidence.push({ activeBeforeRetry, exact, conflict })
                return yield* Effect.gen(function* () {
                  const busy = yield* runState.isBusy(session.id)
                  const messages = yield* sessions.messages({ sessionID: session.id })
                  const assistant = messages
                    .filter(
                      (message): message is SessionV1.WithParts & { info: SessionV1.Assistant } =>
                        message.info.role === "assistant",
                    )
                    .slice(assistantCountBefore)
                    .findLast((message) => message.info.time.completed !== undefined || message.info.error !== undefined)
                  return !busy && assistant ? assistant : undefined
                }).pipe(
                  Effect.repeat({ while: (result) => result === undefined, schedule: Schedule.spaced("50 millis") }),
                  Effect.timeout(config.timeoutMs),
                  Effect.flatMap((result) =>
                    result ? Effect.succeed(result) : Effect.die(new Error("Admitted prompt produced no terminal assistant")),
                  ),
                )
              })
            : prompts.prompt(promptInput)
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
              const childDirectoryExists = yield* Effect.promise(() => directoryExists(child.directory))
              const childAssistants = childMessages.filter(
                (message): message is SessionV1.WithParts & { info: SessionV1.Assistant } =>
                  message.info.role === "assistant",
              )
              const verifier =
                input.verifyChildWorktrees && childDirectoryExists
                  ? yield* Effect.sync(() => {
                      if (!sandbox) throw new Error("Child worktree verifier requires a qualified tool sandbox")
                      const result = Bun.spawnSync([sandbox.shell, "-c", sandbox.verifier], {
                        cwd: child.directory,
                        stdout: "pipe",
                        stderr: "pipe",
                      })
                      return {
                        exitCode: result.exitCode,
                        stdout: result.stdout.toString(),
                        stderr: result.stderr.toString(),
                      }
                    })
                  : undefined
              return {
                id: child.id,
                parentID: child.parentID,
                directory: child.directory,
                directoryExists: childDirectoryExists,
                agent: child.agent,
                model: child.model,
                metadata: child.metadata,
                messageCount: childMessages.length,
                assembledRequestFingerprints: assembledRequestFingerprints
                  .slice(requestFingerprintCountBefore)
                  .filter((event) => event.payload?.properties?.sessionID === child.id)
                  .map((event) => event.payload.properties),
                files: Object.fromEntries(
                  yield* Effect.forEach(input.inspectChildFiles ?? [], (file) =>
                    Effect.promise(
                      async () =>
                        [
                          file,
                          childDirectoryExists && (await Bun.file(path.join(child.directory, file)).exists())
                            ? await Bun.file(path.join(child.directory, file)).text()
                            : undefined,
                        ] as const,
                    ),
                  ),
                ),
                status: childDirectoryExists
                  ? yield* Effect.promise(() => git(child.directory, "status", "--short", "--untracked-files=all"))
                  : "<removed>",
                verifier,
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
                  error: message.info.error,
                  structured: message.info.structured,
                  text: message.parts
                    .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
                    .join(""),
                  tools: message.parts
                    .filter((part) => part.type === "tool")
                    .map((part) => ({
                      messageID: message.info.id,
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
                messageID: message.info.id,
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
          const intent = testCase.admission
            ? yield* database.db
                .select()
                .from(SessionIntentTable)
                .where(eq(SessionIntentTable.intent_id, testCase.admission.intentID))
                .get()
                .pipe(Effect.orDie)
            : undefined
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
            admission: intent
              ? {
                  intentID: intent.intent_id,
                  state: intent.state,
                  source: intent.source,
                  variant: intent.selected_variant,
                  delivery: intent.delivery,
                  admittedMessageID: intent.admitted_message_id,
                  mutationEpoch: intent.mutation_epoch,
                  version: intent.version,
                  retry: admissionRetryEvidence[0],
                }
              : undefined,
            revert: revertEvidence,
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
            assistantTexts: currentAssistants.map((message) =>
              message.parts
                .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
                .join(""),
            ),
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
            providerErrors: currentAssistants.flatMap((message) => (message.info.error ? [message.info.error] : [])),
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
                eventDirectory: permissionLocations.get(request.id)?.directory,
                eventWorkspaceID: permissionLocations.get(request.id)?.workspaceID,
              })),
            permissionBarrierSnapshots,
            pendingPermissionIDs: (yield* permissions
              .list()
              .pipe(Effect.provideService(InstanceRef, parentInstance))).map((request) => String(request.id)),
            pendingQuestionIDs: (yield* questions.list()).map((request) => String(request.id)),
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
        collaboration: input.inspectPRCollaboration
          ? yield* Effect.promise(async () => ({
              queue: (await Bun.file(
                path.join(isolatedData, "agent-gateway", "state", "pr-queue", "queue.json"),
              ).exists())
                ? await Bun.file(path.join(isolatedData, "agent-gateway", "state", "pr-queue", "queue.json")).json()
                : { entries: [] },
              branch: (await git(instance.directory, "branch", "--show-current")).trim(),
              head: (await git(instance.directory, "rev-parse", "HEAD")).trim(),
              firstParentLog: (await git(instance.directory, "log", "--first-parent", "--format=%H%x09%P%x09%s"))
                .trim()
                .split("\n")
                .filter(Boolean),
              worktrees: await git(instance.directory, "worktree", "list", "--porcelain"),
            }))
          : undefined,
        evaluation: input.evaluateWorkspace
          ? yield* Effect.promise(() => input.evaluateWorkspace!(instance.directory, sandbox))
          : undefined,
        panel: panelEvidence,
        v4,
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
            subagentIntensity: input.subagentIntensity,
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
                    additionalWorkspaceRoots: [
                      path.join(isolatedData, "worktree"),
                      path.join(isolatedData, "tmp", "agent"),
                    ],
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
            SessionRevert.defaultLayer,
            Session.defaultLayer,
            Permission.defaultLayer,
            Question.defaultLayer,
            EventV2Bridge.defaultLayer,
            Worktree.appLayer,
            Git.defaultLayer,
            EffectFlock.defaultLayer,
            PRQueue.layer.pipe(Layer.orDie),
            CrossSpawnSpawner.defaultLayer,
            Database.defaultLayer,
          ).pipe(Layer.provideMerge(testInstanceStoreLayer)),
        ),
        Effect.timeout(
          Math.min(config.timeoutMs, input.timeoutMs ?? config.timeoutMs) * Math.max(1, input.cases.length),
        ),
      ),
    )
    const providerErrors = result.observations.flatMap((observation) => observation.providerErrors)
    const v4Errors = result.v4
      ? [
          ...(result.v4.summary.hasUnfinished ? ["V4 coordination remained unfinished"] : []),
          ...result.v4.summary.outcomes
            .filter((outcome) => outcome.status !== "completed")
            .map((outcome) => `${outcome.taskID}:${outcome.status}:${outcome.reason ?? "unknown"}`),
          ...result.v4.childSessions.flatMap((session) =>
            session.assistants.flatMap((assistant) => (assistant.error ? [assistant.error] : [])),
          ),
        ]
      : []
    const errors = [...providerErrors, ...v4Errors]

    return {
      suite: input.suite,
      mode: input.v4Event ? ("ext" as const) : ("live" as const),
      stack: input.v4Event ? ("v4-event-runtime" as const) : ("legacy-session" as const),
      status: errors.length > 0 ? ("failed" as const) : ("passed" as const),
      error: errors.length > 0 ? errors : undefined,
      fingerprint: { ...modelFingerprint(config), runtimeProviderID },
      preflight: { durationMs: preflight.durationMs },
      sandbox: sandbox?.evidence,
      initialVerifier,
      cases: result.observations,
      workspace: result.workspace,
      collaboration: result.collaboration,
      evaluation: result.evaluation,
      panel: result.panel,
      v4: result.v4,
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

function liveErrorName(error: unknown) {
  if (typeof error !== "object" || error === null) return String(error)
  if ("_tag" in error && typeof error._tag === "string") return error._tag
  if (error instanceof Error) return error.name
  return "UnknownError"
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
    mkdir(path.join(isolatedData, "tmp", "agent"), { recursive: true }),
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
    subagentIntensity?: "inherit" | "downgrade"
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
          { permission: agentPermission, steps: options?.maxProviderTurns },
        ]),
      ),
    },
    provider: {
      ...(options?.subagentIntensity
        ? {
            deepagent: {
              name: "DeepAgent",
              options: { subagentIntensity: options.subagentIntensity },
              models: {},
            },
          }
        : {}),
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
