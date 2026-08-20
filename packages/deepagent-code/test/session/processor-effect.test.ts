import { NodeFileSystem } from "@effect/platform-node"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { PermissionV1 } from "@deepagent-code/core/v1/permission"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { afterEach, expect } from "bun:test"
import { tool } from "ai"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import path from "path"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { Image } from "@/image/image"
import { Permission } from "../../src/permission"
import { Question } from "../../src/question"
import { Plugin } from "../../src/plugin"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { executeWithPermissionAuthority } from "../../src/session/tools"
import {
  PlanProtocolTracker,
  restorePlanProtocolFailures,
  SessionProcessor,
  ToolSequenceTracker,
  withPlanProtocolActivity,
} from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import * as Log from "@deepagent-code/core/util/log"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { WorkspaceRef } from "../../src/effect/instance-ref"
import { disposeAllInstances, provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionIntentTable, SessionTable } from "@deepagent-code/core/session/sql"
import { LLMEvent } from "@deepagent-code/llm"
import { Hash } from "@deepagent-code/core/util/hash"
import { DeepAgentActivityAuthority } from "@deepagent-code/core/deepagent/index"
import {
  SessionActivityObjectiveTable,
  SessionActivityEvidenceTable,
  SessionActivityPermissionDecisionTable,
  SessionActivityPermissionEffectDispatchTable,
  SessionActivityPermissionOwnerLeaseTable,
  SessionActivityPermissionOnceConsumptionTable,
  SessionActivityPermissionRequestTable,
} from "@deepagent-code/core/deepagent/activity-authority.sql"
import {
  SessionActivityAdmissionTable,
  SessionLegacyActivityAdmissionTable,
  SessionLegacyActivityTable,
} from "../../src/session/activity-sql"
import { count, eq } from "drizzle-orm"
import { Tool } from "../../src/tool/tool"

void Log.init({ print: false })

// Dispose any instances loaded into the process-wide AppRuntime instance
// store so this file leaves no shared state for files that run after it.
afterEach(async () => {
  await disposeAllInstances()
})

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
    computeManifest: () => Effect.succeed(SessionSummary.emptyManifest()),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const waitFor = <A>(check: Effect.Effect<A | undefined>, message: string) =>
  Effect.gen(function* () {
    // Poll budget must comfortably exceed first-stream latency: the initial run through the
    // compiled LLM pipeline can take ~1s on slower/cold machines, so 500ms flaked here.
    const stop = Date.now() + 5000
    while (Date.now() < stop) {
      const value = yield* check
      if (value !== undefined) return value
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(message))
  })

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const status = SessionStatus.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const deps = Layer.mergeAll(
  Session.defaultLayer.pipe(Layer.provide(SessionProjector.defaultLayer)),
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  LLM.defaultLayer,
  Provider.defaultLayer,
  status,
  Database.defaultLayer,
  EventV2Bridge.defaultLayer,
).pipe(Layer.provideMerge(infra))
const env = Layer.mergeAll(
  TestLLMServer.layer,
  SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(Image.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(deps),
  ),
)

const it = testEffect(env)

const providerErrorLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
        LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
        LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {}, providerExecuted: true }),
        LLMEvent.toolResult({
          id: "call-1",
          name: "lookup",
          result: { type: "error", value: "provider boom" },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)
const providerErrorEnv = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
  Layer.provide(providerErrorLLM),
  Layer.provideMerge(deps),
)
const itProviderError = testEffect(providerErrorEnv)

function typedToolFailureEnv(failure: { id: string; name: string; error: Error }) {
  return SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(Image.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provide(
      Layer.succeed(
        LLM.Service,
        LLM.Service.of({
          stream: () =>
            Stream.make(
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.toolInputStart({ id: failure.id, name: failure.name }),
              LLMEvent.toolInputEnd({ id: failure.id, name: failure.name }),
              LLMEvent.toolCall({ id: failure.id, name: failure.name, input: {} }),
              LLMEvent.toolResult({
                id: failure.id,
                name: failure.name,
                result: { type: "error", value: failure.error },
              }),
              LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
              LLMEvent.finish({ reason: "tool-calls" }),
            ),
        }),
      ),
    ),
    Layer.provideMerge(deps),
  )
}
const itQuestionRejected = testEffect(
  typedToolFailureEnv({ id: "question-call", name: "question", error: new Question.RejectedError() }),
)
const itPermissionRejected = testEffect(
  typedToolFailureEnv({ id: "permission-call", name: "bash", error: new PermissionV1.RejectedError() }),
)
const itPermissionCorrected = testEffect(
  typedToolFailureEnv({
    id: "permission-corrected-call",
    name: "bash",
    error: new PermissionV1.CorrectedError({ feedback: "Use the approved directory" }),
  }),
)

const noProgressLLM = Layer.sync(LLM.Service, () => {
  let ordinal = 0
  return LLM.Service.of({
    stream: () => {
      const id = `stable-read-${++ordinal}`
      const filePath = ordinal === 2 ? "other.ts" : "stable.ts"
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id, name: "read" }),
        LLMEvent.toolInputEnd({ id, name: "read" }),
        LLMEvent.toolCall({ id, name: "read", input: { filePath }, providerExecuted: true }),
        LLMEvent.toolResult({
          id,
          name: "read",
          result: { type: "json", value: { content: "unchanged" } },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      )
    },
  })
})
const durableFlags = RuntimeFlags.layer({ experimentalEventSystem: true })
const durablePermission = Permission.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(durableFlags),
)
const durableDeps = Layer.mergeAll(
  Session.defaultLayer.pipe(Layer.provide(SessionProjector.defaultLayer)),
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  durablePermission,
  Plugin.defaultLayer,
  Config.defaultLayer,
  Provider.defaultLayer,
  status,
  Database.defaultLayer,
  EventV2Bridge.defaultLayer,
).pipe(Layer.provideMerge(infra))
const noProgressEnv = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provideMerge(durableFlags),
  Layer.provide(noProgressLLM),
  Layer.provideMerge(durableDeps),
)
const itNoProgress = testEffect(noProgressEnv)
const durableProviderErrorEnv = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provideMerge(durableFlags),
  Layer.provide(providerErrorLLM),
  Layer.provideMerge(durableDeps),
)
const itDurableProviderError = testEffect(durableProviderErrorEnv)

const fragmentFailureLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "thinking" }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textDelta({ id: "text-1", text: "partial" }),
        LLMEvent.providerError({ message: "provider boom" }),
      ),
  }),
)
const fragmentFailureEnv = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
  Layer.provide(fragmentFailureLLM),
  Layer.provideMerge(deps),
)
const itFragmentFailure = testEffect(fragmentFailureEnv)

// §9.3 incident fixture LLM: sends actual malformed plan inputs from the BUG-010 incident.
// Each call rotates through the exact 11 step shapes observed in the live session, using the
// original (pre-v2) payload structure that lacks operation/version. A second variant (below)
// uses forward-compatible envelopes with valid operation/version but the same malformed steps.
const incidentStepShapes = [
  { title: "ayContext", status: "active" },
  { title: "Context", status: "pending" },
  { title: "Context", status: "active" },
  { title: "Context", status: "active" },
  { title: "", status: "" },
  { title: "Context", status: "active" },
  { title: "", status: "active" },
  { title: "Context", status: "pending" },
  { title: "", status: "active" },
  { title: "Context", status: "active" },
  { title: "Context", status: "active" },
] as const

let incidentOrdinalOrig = 0
// Original incident payloads (missing operation/version — structural reject)
const incidentOriginalPayloadLLM = Layer.sync(LLM.Service, () =>
  LLM.Service.of({
    stream: () => {
      const shape = incidentStepShapes[incidentOrdinalOrig % incidentStepShapes.length]
      const id = `incident-orig-${incidentOrdinalOrig}`
      incidentOrdinalOrig += 1
      // Exact payload structure from the incident: no operation, no version fields
      const input = {
        goal: "complete the benchmark and compress collectives to 3.3ms",
        steps: [{ step_id: "s1", title: shape.title, status: shape.status }],
        active_step_id: shape.status === "active" ? "s1" : null,
      }
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id, name: "plan" }),
        LLMEvent.toolInputEnd({ id, name: "plan" }),
        LLMEvent.toolCall({ id, name: "plan", input }),
        LLMEvent.toolResult({
          id,
          name: "plan",
          result: {
            type: "json",
            value: {
              title: "Plan needs correction",
              output: `The plan was not committed (invalid_operation). Correct the plan payload and retry once.`,
              metadata: { plan_protocol: "invalid", plan_error_code: "invalid_operation" },
            },
          },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      )
    },
  }),
)
const incidentOriginalEnv = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
  Layer.provide(incidentOriginalPayloadLLM),
  Layer.provideMerge(deps),
)
const itIncidentOriginal = testEffect(incidentOriginalEnv)

let incidentOrdinalFwd = 0
// Forward-compatible payloads: valid operation/version envelope, malformed steps only
// (the semantic/quality oracle is responsible for rejecting these).
const incidentForwardCompatPayloadLLM = Layer.sync(LLM.Service, () =>
  LLM.Service.of({
    stream: () => {
      const shape = incidentStepShapes[incidentOrdinalFwd % incidentStepShapes.length]
      const id = `incident-fwd-${incidentOrdinalFwd}`
      incidentOrdinalFwd += 1
      const input = {
        operation: "replan",
        expected_plan_id: "plan_fixture_base",
        expected_version: 1,
        replan_reason: "provider returned malformed plan arguments",
        goal: "complete the benchmark and compress collectives to 3.3ms",
        steps: [{ step_id: "s1", title: shape.title, status: shape.status }],
        active_step_id: shape.status === "active" ? "s1" : null,
      }
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id, name: "plan" }),
        LLMEvent.toolInputEnd({ id, name: "plan" }),
        LLMEvent.toolCall({ id, name: "plan", input }),
        LLMEvent.toolResult({
          id,
          name: "plan",
          result: {
            type: "json",
            value: {
              title: "Plan needs correction",
              output: `The plan was not committed (suspicious_quality_regression). Correct the plan payload and retry once.`,
              metadata: {
                plan_protocol: "invalid",
                plan_error_code: "suspicious_quality_regression",
              },
            },
          },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      )
    },
  }),
)
const incidentForwardCompatEnv = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
  Layer.provide(incidentForwardCompatPayloadLLM),
  Layer.provideMerge(deps),
)
const itIncidentForwardCompat = testEffect(incidentForwardCompatEnv)

const planProtocolLLM = Layer.sync(LLM.Service, () => {
  let ordinal = 0
  return LLM.Service.of({
    stream: () => {
      ordinal += 1
      const id = `plan-protocol-${ordinal}`
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id, name: "plan" }),
        LLMEvent.toolInputEnd({ id, name: "plan" }),
        LLMEvent.toolCall({ id, name: "plan", input: {} }),
        LLMEvent.toolResult({
          id,
          name: "plan",
          result: {
            type: "json",
            value: {
              title: "Plan needs correction",
              output: "invalid plan",
              metadata: {
                plan_protocol: "invalid",
                plan_error_code: `invalid_${ordinal}`,
              },
            },
          },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      )
    },
  })
})
const planProtocolEnv = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
  Layer.provide(planProtocolLLM),
  Layer.provideMerge(deps),
)
const itPlanProtocol = testEffect(planProtocolEnv)
let orphanPlanOrdinal = 0
const orphanPlanResultLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () => {
      const id = `orphan-plan-result-${++orphanPlanOrdinal}`
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolResult({
          id,
          name: "plan",
          result: { type: "error", value: "schema decode failed before execution" },
        }),
        LLMEvent.finish({ reason: "stop" }),
      )
    },
  }),
)
const orphanPlanProtocolEnv = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
  Layer.provide(orphanPlanResultLLM),
  Layer.provideMerge(deps),
)
const itOrphanPlanProtocol = testEffect(orphanPlanProtocolEnv)

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

const processTypedToolFailure = Effect.fn("test.processTypedToolFailure")(function* (dir: string) {
  const { processors, session, provider } = yield* boot()
  const chat = yield* session.create({})
  const parent = yield* user(chat.id, "run the tool")
  const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
  const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
  const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
  const decision = yield* handle.process({
    user: {
      id: parent.id,
      sessionID: chat.id,
      role: "user",
      time: parent.time,
      agent: parent.agent,
      model: { providerID: ref.providerID, modelID: ref.modelID },
    } satisfies SessionV1.User,
    sessionID: chat.id,
    model: mdl,
    agent: agent(),
    system: [],
    messages: [{ role: "user", content: "run the tool" }],
    tools: {},
  })
  const part = (yield* MessageV2.parts(msg.id)).find(
    (candidate): candidate is SessionV1.ToolPart => candidate.type === "tool",
  )
  return { decision, part }
})

itQuestionRejected.live("question rejection returns a typed terminal decision and durable failure code", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const result = yield* processTypedToolFailure(dir)
        expect(result.decision).toEqual({
          action: "stop",
          reason: { code: "user_rejected_question", callID: "question-call" },
        })
        expect(result.part?.state.status).toBe("error")
        if (result.part?.state.status === "error")
          expect(result.part.state.metadata?.failureCode).toBe("user_rejected_question")
      }),
    { config: cfg },
  ),
)

itPermissionRejected.live("plain permission rejection returns a typed terminal decision and durable failure code", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const result = yield* processTypedToolFailure(dir)
        expect(result.decision).toEqual({
          action: "stop",
          reason: { code: "user_rejected_permission", callID: "permission-call" },
        })
        expect(result.part?.state.status).toBe("error")
        if (result.part?.state.status === "error")
          expect(result.part.state.metadata?.failureCode).toBe("user_rejected_permission")
      }),
    { config: cfg },
  ),
)

itPermissionCorrected.live("permission correction remains a non-terminal tool failure", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const result = yield* processTypedToolFailure(dir)
        expect(result.decision).toEqual({ action: "continue" })
        expect(result.part?.state.status).toBe("error")
        if (result.part?.state.status === "error") {
          expect(result.part.state.error).toContain("Use the approved directory")
          expect(result.part.state.metadata?.failureCode).toBeUndefined()
        }
      }),
    { config: cfg },
  ),
)

const admitActivity = Effect.fn("test.admitActivity")(function* (sessionID: SessionID, messageID: MessageID) {
  const { db } = yield* Database.Service
  const admissionID = Hash.sha256(`test-activity-admission:${messageID}`)
  const activityID = Hash.sha256(`test-legacy-activity:${admissionID}`)
  const intentID = `test-intent:${messageID}`
  const payloadFingerprint = Hash.sha256(`test-payload:${messageID}`)
  const now = Date.now()
  yield* db
    .insert(SessionIntentTable)
    .values({
      intent_id: intentID,
      session_id: sessionID,
      source: "composer",
      state: "admitted",
      selected_variant: "original",
      selected_payload_hash: payloadFingerprint,
      delivery: "turn",
      admitted_message_id: messageID,
      correlation_id: messageID,
      mutation_epoch: 0,
      version: 1,
      time_created: now,
      time_selected: now,
      time_admitted: now,
      time_updated: now,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionActivityAdmissionTable) // fixture-exempt: seeds legacy-intent admission row for processor fixture
    .values({
      admission_id: admissionID,
      session_id: sessionID,
      source_kind: "legacy_intent",
      legacy_intent_id: intentID,
      admitted_message_id: messageID,
      delivery: "turn",
      payload_fingerprint_kind: "payload_hash",
      payload_fingerprint: payloadFingerprint,
      created_at: now,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionLegacyActivityTable)
    .values({
      activity_id: activityID,
      session_id: sessionID,
      ordinal: 0,
      trigger_admission_id: admissionID,
      owner_token: "test-owner",
      state: "active",
      created_at: now,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionLegacyActivityAdmissionTable)
    .values({ activity_id: activityID, admission_id: admissionID, ordinal: 0, role: "trigger", attached_at: now })
    .run()
    .pipe(Effect.orDie)
  return activityID
})

const makeRemotePermission = Effect.fn("test.makeRemotePermission")(function* () {
  const database = yield* Database.Service
  const events = yield* EventV2Bridge.Service
  const scope = yield* Scope.make()
  return {
    service: Context.get(
      yield* Layer.build(
        Layer.fresh(
          Permission.layer.pipe(
            Layer.provide(Layer.succeed(Database.Service, database)),
            Layer.provide(Layer.succeed(EventV2Bridge.Service, events)),
            Layer.provide(durableFlags),
          ),
        ),
      ).pipe(Effect.provideService(Scope.Scope, scope)),
      Permission.Service,
    ),
    scope,
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

itNoProgress.live(
  "durable tool permission persists approval without consuming before effect start",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { session } = yield* boot()
          const database = yield* Database.Service
          const permission = yield* Permission.Service
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "run pwd")
          const activityID = yield* admitActivity(chat.id, parent.id)
          const waiting = yield* permission
            .ask({
              sessionID: chat.id,
              permission: "bash",
              patterns: ["pwd"],
              metadata: { command: "pwd" },
              always: ["pwd"],
              tool: { messageID: parent.id, callID: "call-durable-pwd" },
              ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
            })
            .pipe(Effect.forkChild)
          const pending = yield* waitFor(
            permission.list().pipe(Effect.map((items) => (items.length === 1 ? items[0] : undefined))),
            "timed out waiting for durable tool permission",
          )
          expect(String(pending.id).startsWith("per_")).toBe(true)
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionRequestTable)
              .where(eq(SessionActivityPermissionRequestTable.request_id, pending.id))
              .get()
              .pipe(Effect.orDie),
          ).toMatchObject({
            activity_id: activityID,
            request_kind: "tool",
            tool_message_id: parent.id,
            tool_call_id: "call-durable-pwd",
            state: "pending",
          })

          yield* permission.reply({ requestID: pending.id, reply: "once" })
          yield* Fiber.join(waiting)
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionDecisionTable)
              .where(eq(SessionActivityPermissionDecisionTable.request_id, pending.id))
              .get()
              .pipe(Effect.orDie),
          ).toMatchObject({ decision: "approved_once", scope: "once" })
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionOnceConsumptionTable)
              .where(eq(SessionActivityPermissionOnceConsumptionTable.request_id, pending.id))
              .get()
              .pipe(Effect.orDie),
          ).toBeUndefined()
        }),
      { config: cfg },
    ),
  20_000,
)

itNoProgress.live(
  "durable tool permission starts its effect for policy allow and reuses the exact terminal decision",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { session } = yield* boot()
          const database = yield* Database.Service
          const permission = yield* Permission.Service
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "run pwd")
          yield* admitActivity(chat.id, parent.id)
          if (!permission.askEffect) return yield* Effect.die(new Error("durable permission effect API is unavailable"))

          const allowed = yield* permission.askEffect({
            sessionID: chat.id,
            permission: "bash",
            patterns: ["pwd"],
            metadata: { command: "pwd" },
            always: ["pwd"],
            tool: { messageID: parent.id, callID: "call-policy-allow" },
            effectToolName: "bash",
            ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
          })
          expect(allowed).toMatchObject({ state: "started", toolName: "bash", toolCallID: "call-policy-allow" })
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionOnceConsumptionTable)
              .where(eq(SessionActivityPermissionOnceConsumptionTable.request_id, allowed!.requestID))
              .get(),
          ).toMatchObject({ consumer_id: `tool:${parent.id}:call-policy-allow` })

          const alwaysRequest = yield* DeepAgentActivityAuthority.requestPermission({
            activityKind: "legacy",
            activityID: allowed!.activityID,
            requestID: "permission-crash-before-start",
            requestKind: "tool",
            idempotencyKey: "permission-request:permission-crash-before-start",
            permission: "bash",
            patterns: ["git status"],
            alwaysPatterns: ["git status"],
            metadata: { command: "git status" },
            tool: { messageID: parent.id, callID: "call-crash-before-start" },
            ownerID: allowed!.ownerID,
          })
          yield* DeepAgentActivityAuthority.decidePermission({
            requestID: alwaysRequest.requestID,
            idempotencyKey: "permission-crash-before-start-decision",
            decision: "approved_always",
            actorType: "user",
            actorID: "user-1",
          })

          const resumed = yield* permission.askEffect({
            id: PermissionV1.ID.make("permission-crash-before-start"),
            sessionID: chat.id,
            permission: "bash",
            patterns: ["git status"],
            metadata: { command: "git status" },
            always: ["git status"],
            tool: { messageID: parent.id, callID: "call-crash-before-start" },
            effectToolName: "bash",
            ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
          })
          expect(resumed).toMatchObject({ state: "started", requestID: "permission-crash-before-start" })
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionDecisionTable)
              .where(eq(SessionActivityPermissionDecisionTable.request_id, "permission-crash-before-start"))
              .get(),
          ).toMatchObject({ decision: "approved_always", actor_type: "user" })
          expect(
            yield* database.db
              .select({ state: SessionActivityPermissionEffectDispatchTable.state })
              .from(SessionActivityPermissionEffectDispatchTable)
              .where(eq(SessionActivityPermissionEffectDispatchTable.request_id, "permission-crash-before-start"))
              .get(),
          ).toEqual({ state: "started" })
        }),
      { config: cfg },
    ),
  20_000,
)

itNoProgress.live(
  "scope shutdown preserves a user reply whose first durable settlement failed",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { session } = yield* boot()
          const database = yield* Database.Service
          const remote = yield* makeRemotePermission()
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "run pwd")
          yield* admitActivity(chat.id, parent.id)
          const waiting = yield* remote.service
            .ask({
              sessionID: chat.id,
              permission: "bash",
              patterns: ["pwd"],
              metadata: { command: "pwd" },
              always: ["pwd"],
              tool: { messageID: parent.id, callID: "call-shutdown-reply" },
              ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
            })
            .pipe(Effect.forkChild)
          const pending = yield* waitFor(
            remote.service.list().pipe(Effect.map((items) => (items.length === 1 ? items[0] : undefined))),
            "timed out waiting for shutdown settlement fixture",
          )
          yield* database.db.run(`
            CREATE TRIGGER fail_shutdown_permission_decision
            BEFORE INSERT ON session_activity_permission_decision
            WHEN NEW.request_id = '${pending.id}'
            BEGIN
              SELECT RAISE(ABORT, 'injected permission decision failure');
            END
          `)
          expect(
            Exit.isFailure(yield* remote.service.reply({ requestID: pending.id, reply: "once" }).pipe(Effect.exit)),
          ).toBe(true)
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionRequestTable)
              .where(eq(SessionActivityPermissionRequestTable.request_id, pending.id))
              .get(),
          ).toMatchObject({ state: "pending" })

          yield* database.db.run("DROP TRIGGER fail_shutdown_permission_decision")
          yield* Scope.close(remote.scope, Exit.void)

          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionDecisionTable)
              .where(eq(SessionActivityPermissionDecisionTable.request_id, pending.id))
              .get(),
          ).toMatchObject({ decision: "approved_once", actor_type: "user", actor_id: "permission-ui" })
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionOnceConsumptionTable)
              .where(eq(SessionActivityPermissionOnceConsumptionTable.request_id, pending.id))
              .get(),
          ).toBeUndefined()
          expect(Exit.isSuccess(yield* Fiber.await(waiting))).toBe(true)
        }),
      { config: cfg },
    ),
  20_000,
)

itNoProgress.live(
  "terminal activity decision independently reconciles its local permission waiter",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { session } = yield* boot()
          const database = yield* Database.Service
          const permission = yield* Permission.Service
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "run pwd")
          const activityID = yield* admitActivity(chat.id, parent.id)
          const waiting = yield* permission
            .ask({
              sessionID: chat.id,
              permission: "bash",
              patterns: ["pwd"],
              metadata: { command: "pwd" },
              always: ["pwd"],
              tool: { messageID: parent.id, callID: "call-terminal-pwd" },
              ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
            })
            .pipe(Effect.forkChild)
          const pending = yield* waitFor(
            permission.list().pipe(Effect.map((items) => (items.length === 1 ? items[0] : undefined))),
            "timed out waiting for terminal permission fixture",
          )

          yield* DeepAgentActivityAuthority.settle({
            activityKind: "legacy",
            activityID,
            expectedVersion: 1,
            state: "interrupted",
            terminalReason: "test_terminal_wins",
          })
          expect(
            Exit.isFailure(
              yield* Fiber.await(waiting).pipe(
                Effect.timeoutOrElse({
                  duration: "1 second",
                  orElse: () => Effect.fail(new Error("terminal permission waiter did not settle")),
                }),
              ),
            ),
          ).toBe(true)
          expect(yield* permission.list()).toEqual([])
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionDecisionTable)
              .where(eq(SessionActivityPermissionDecisionTable.request_id, pending.id))
              .get()
              .pipe(Effect.orDie),
          ).toMatchObject({ decision: "interrupted", actor_id: "activity-authority" })
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionOnceConsumptionTable)
              .where(eq(SessionActivityPermissionOnceConsumptionTable.request_id, pending.id))
              .get()
              .pipe(Effect.orDie),
          ).toBeUndefined()
          expect(
            Exit.isFailure(yield* permission.reply({ requestID: pending.id, reply: "once" }).pipe(Effect.exit)),
          ).toBe(true)
        }),
      { config: cfg },
    ),
  20_000,
)

itNoProgress.live(
  "an external durable approval wins before the local timeout and completes the caller",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { session } = yield* boot()
          const database = yield* Database.Service
          const permission = yield* Permission.Service
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "run pwd")
          yield* admitActivity(chat.id, parent.id)
          const waiting = yield* permission
            .ask({
              sessionID: chat.id,
              permission: "bash",
              patterns: ["pwd"],
              metadata: { command: "pwd" },
              always: ["pwd"],
              tool: { messageID: parent.id, callID: "call-external-timeout" },
              ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
              timeoutMs: 100,
            })
            .pipe(Effect.forkChild)
          const pending = yield* waitFor(
            permission.list().pipe(Effect.map((items) => (items.length === 1 ? items[0] : undefined))),
            "timed out waiting for external approval fixture",
          )

          yield* DeepAgentActivityAuthority.decidePermission({
            requestID: pending.id,
            idempotencyKey: `external-permission:${pending.id}:approved_once`,
            decision: "approved_once",
            actorType: "user",
            actorID: "external-runtime",
          })
          expect(
            Exit.isSuccess(
              yield* Fiber.await(waiting).pipe(
                Effect.timeoutOrElse({
                  duration: "1 second",
                  orElse: () => Effect.fail(new Error("external approval did not settle the local waiter")),
                }),
              ),
            ),
          ).toBe(true)
          expect(yield* permission.list()).toEqual([])
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionOnceConsumptionTable)
              .where(eq(SessionActivityPermissionOnceConsumptionTable.request_id, pending.id))
              .get()
              .pipe(Effect.orDie),
          ).toBeUndefined()
        }),
      { config: cfg },
    ),
  20_000,
)

itNoProgress.live(
  "an external durable approval is preserved when the local ask fiber is cancelled",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { session } = yield* boot()
          const database = yield* Database.Service
          const permission = yield* Permission.Service
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "run pwd")
          yield* admitActivity(chat.id, parent.id)
          const waiting = yield* permission
            .ask({
              sessionID: chat.id,
              permission: "bash",
              patterns: ["pwd"],
              metadata: { command: "pwd" },
              always: ["pwd"],
              tool: { messageID: parent.id, callID: "call-external-cancel" },
              ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
            })
            .pipe(Effect.forkChild)
          const pending = yield* waitFor(
            permission.list().pipe(Effect.map((items) => (items.length === 1 ? items[0] : undefined))),
            "timed out waiting for external cancel fixture",
          )

          yield* DeepAgentActivityAuthority.decidePermission({
            requestID: pending.id,
            idempotencyKey: `external-permission:${pending.id}:approved_once`,
            decision: "approved_once",
            actorType: "user",
            actorID: "external-runtime",
          })
          yield* Fiber.interrupt(waiting)

          expect(yield* permission.list()).toEqual([])
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionDecisionTable)
              .where(eq(SessionActivityPermissionDecisionTable.request_id, pending.id))
              .get()
              .pipe(Effect.orDie),
          ).toMatchObject({ decision: "approved_once", actor_id: "external-runtime" })
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionOnceConsumptionTable)
              .where(eq(SessionActivityPermissionOnceConsumptionTable.request_id, pending.id))
              .get()
              .pipe(Effect.orDie),
          ).toBeUndefined()
        }),
      { config: cfg },
    ),
  20_000,
)

itNoProgress.live(
  "a second permission runtime can durably reply to the owner runtime",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { session } = yield* boot()
          const database = yield* Database.Service
          const events = yield* EventV2Bridge.Service
          const permission = yield* Permission.Service
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "run pwd")
          yield* admitActivity(chat.id, parent.id)
          const workspaceA = WorkspaceV2.ID.make("wrk_permission_owner_a")
          const workspaceB = WorkspaceV2.ID.make("wrk_permission_other_b")
          yield* database.db
            .update(SessionTable)
            .set({ workspace_id: workspaceA })
            .where(eq(SessionTable.id, chat.id))
            .run()
            .pipe(Effect.orDie)
          const waiting = yield* permission
            .ask({
              sessionID: chat.id,
              permission: "bash",
              patterns: ["pwd"],
              metadata: { command: "pwd" },
              always: ["pwd"],
              tool: { messageID: parent.id, callID: "call-cross-runtime" },
              ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
            })
            .pipe(Effect.provideService(WorkspaceRef, workspaceA))
            .pipe(Effect.forkChild)
          const pending = yield* waitFor(
            database.db
              .select({ id: SessionActivityPermissionRequestTable.request_id })
              .from(SessionActivityPermissionRequestTable)
              .where(eq(SessionActivityPermissionRequestTable.tool_call_id, "call-cross-runtime"))
              .get()
              .pipe(Effect.orDie),
            "timed out waiting for cross-runtime fixture",
          )
          const requestID = PermissionV1.ID.make(pending.id)
          const remoteScope = yield* Scope.make()
          const remote = Context.get(
            yield* Layer.build(
              Layer.fresh(
                Permission.layer.pipe(
                  Layer.provide(Layer.succeed(Database.Service, database)),
                  Layer.provide(Layer.succeed(EventV2Bridge.Service, events)),
                  Layer.provide(durableFlags),
                ),
              ),
            ).pipe(Effect.provideService(Scope.Scope, remoteScope)),
            Permission.Service,
          )

          const wrongWorkspace = yield* remote
            .reply({ requestID, reply: "once" })
            .pipe(Effect.provideService(WorkspaceRef, workspaceB), Effect.exit)
          expect(Exit.isFailure(wrongWorkspace)).toBe(true)
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionRequestTable)
              .where(eq(SessionActivityPermissionRequestTable.request_id, pending.id))
              .get()
              .pipe(Effect.orDie),
          ).toMatchObject({ state: "pending", workspace_id: workspaceA })
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionDecisionTable)
              .where(eq(SessionActivityPermissionDecisionTable.request_id, pending.id))
              .get()
              .pipe(Effect.orDie),
          ).toBeUndefined()
          yield* remote.reply({ requestID, reply: "once" }).pipe(Effect.provideService(WorkspaceRef, workspaceA))

          expect(
            Exit.isSuccess(
              yield* Fiber.await(waiting).pipe(
                Effect.timeoutOrElse({
                  duration: "1 second",
                  orElse: () => Effect.fail(new Error("cross-runtime reply did not settle the owner waiter")),
                }),
              ),
            ),
          ).toBe(true)
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionDecisionTable)
              .where(eq(SessionActivityPermissionDecisionTable.request_id, pending.id))
              .get()
              .pipe(Effect.orDie),
          ).toMatchObject({ decision: "approved_once", actor_id: "permission-ui" })
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionOnceConsumptionTable)
              .where(eq(SessionActivityPermissionOnceConsumptionTable.request_id, pending.id))
              .get()
              .pipe(Effect.orDie),
          ).toBeUndefined()

          const unscoped = yield* permission
            .ask({
              sessionID: chat.id,
              permission: "bash",
              patterns: ["pwd"],
              metadata: { command: "pwd" },
              always: ["pwd"],
              tool: { messageID: parent.id, callID: "call-cross-runtime-unscoped" },
              ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
            })
            .pipe(Effect.provideService(WorkspaceRef, workspaceA))
            .pipe(Effect.forkChild)
          const unscopedPending = yield* waitFor(
            database.db
              .select({ id: SessionActivityPermissionRequestTable.request_id })
              .from(SessionActivityPermissionRequestTable)
              .where(eq(SessionActivityPermissionRequestTable.tool_call_id, "call-cross-runtime-unscoped"))
              .get()
              .pipe(Effect.orDie),
            "timed out waiting for unscoped permission fixture",
          )
          const wrongScopedReply = yield* permission
            .reply({ requestID: PermissionV1.ID.make(unscopedPending.id), reply: "once" })
            .pipe(Effect.provideService(WorkspaceRef, workspaceB), Effect.exit)
          expect(Exit.isFailure(wrongScopedReply)).toBe(true)
          yield* permission
            .reply({ requestID: PermissionV1.ID.make(unscopedPending.id), reply: "once" })
            .pipe(Effect.provideService(WorkspaceRef, workspaceA))
          expect(Exit.isSuccess(yield* Fiber.await(unscoped))).toBe(true)
          yield* Scope.close(remoteScope, Exit.void)
        }),
      { config: cfg },
    ),
  20_000,
)

itNoProgress.live(
  "owner and remote reject produce identical durable sibling fanout",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { session } = yield* boot()
          const database = yield* Database.Service
          const permission = yield* Permission.Service
          const ownerChat = yield* session.create({})
          const ownerParent = yield* user(ownerChat.id, "owner rejects pending tools")
          yield* admitActivity(ownerChat.id, ownerParent.id)
          const remoteChat = yield* session.create({})
          const remoteParent = yield* user(remoteChat.id, "remote rejects pending tools")
          yield* admitActivity(remoteChat.id, remoteParent.id)
          const ownerTarget = yield* permission
            .ask({
              sessionID: ownerChat.id,
              permission: "bash",
              patterns: ["rm -rf build"],
              metadata: {},
              always: [],
              tool: { messageID: ownerParent.id, callID: "call-owner-reject-target" },
              ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
            })
            .pipe(Effect.forkChild)
          const ownerSibling = yield* permission
            .ask({
              sessionID: ownerChat.id,
              permission: "edit",
              patterns: ["src/index.ts"],
              metadata: {},
              always: [],
              tool: { messageID: ownerParent.id, callID: "call-owner-reject-sibling" },
              ruleset: [{ permission: "edit", pattern: "*", action: "ask" }],
            })
            .pipe(Effect.forkChild)
          const remoteTarget = yield* permission
            .ask({
              sessionID: remoteChat.id,
              permission: "bash",
              patterns: ["rm -rf build"],
              metadata: {},
              always: [],
              tool: { messageID: remoteParent.id, callID: "call-remote-reject-target" },
              ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
            })
            .pipe(Effect.forkChild)
          const remoteSibling = yield* permission
            .ask({
              sessionID: remoteChat.id,
              permission: "edit",
              patterns: ["src/index.ts"],
              metadata: {},
              always: [],
              tool: { messageID: remoteParent.id, callID: "call-remote-reject-sibling" },
              ruleset: [{ permission: "edit", pattern: "*", action: "ask" }],
            })
            .pipe(Effect.forkChild)
          const requests = yield* waitFor(
            database.db
              .select({
                requestID: SessionActivityPermissionRequestTable.request_id,
                callID: SessionActivityPermissionRequestTable.tool_call_id,
              })
              .from(SessionActivityPermissionRequestTable)
              .all()
              .pipe(
                Effect.orDie,
                Effect.map((items) => (items.length === 4 ? items : undefined)),
              ),
            "timed out waiting for durable reject fanout fixtures",
          )
          const ownerTargetID = PermissionV1.ID.make(
            requests.find((request) => request.callID === "call-owner-reject-target")!.requestID,
          )
          const remoteTargetID = PermissionV1.ID.make(
            requests.find((request) => request.callID === "call-remote-reject-target")!.requestID,
          )
          const remote = yield* makeRemotePermission()

          yield* permission.reply({ requestID: ownerTargetID, reply: "reject" })
          yield* remote.service.reply({ requestID: remoteTargetID, reply: "reject" })

          const outcomes = yield* Effect.all(
            [ownerTarget, ownerSibling, remoteTarget, remoteSibling].map((fiber) =>
              Fiber.await(fiber).pipe(
                Effect.timeoutOrElse({
                  duration: "1 second",
                  orElse: () => Effect.fail(new Error("durable reject fanout did not settle every waiter")),
                }),
              ),
            ),
          )
          expect(outcomes.every(Exit.isFailure)).toBe(true)
          expect(
            (yield* database.db
              .select({
                requestID: SessionActivityPermissionRequestTable.request_id,
                state: SessionActivityPermissionRequestTable.state,
              })
              .from(SessionActivityPermissionRequestTable)
              .all()
              .pipe(Effect.orDie))
              .map((request) => request.state)
              .toSorted(),
          ).toEqual(["denied", "denied", "denied", "denied"])
          expect(
            (yield* database.db
              .select({ decision: SessionActivityPermissionDecisionTable.decision })
              .from(SessionActivityPermissionDecisionTable)
              .all()
              .pipe(Effect.orDie))
              .map((decision) => decision.decision)
              .toSorted(),
          ).toEqual(["denied", "denied", "denied", "denied"])
          yield* Scope.close(remote.scope, Exit.void)
        }),
      { config: cfg },
    ),
  20_000,
)

itNoProgress.live(
  "owner and remote always produce identical durable matching sibling fanout",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { session } = yield* boot()
          const database = yield* Database.Service
          const permission = yield* Permission.Service
          const ownerChat = yield* session.create({})
          const ownerParent = yield* user(ownerChat.id, "owner approves matching tools")
          yield* admitActivity(ownerChat.id, ownerParent.id)
          const remoteChat = yield* session.create({})
          const remoteParent = yield* user(remoteChat.id, "remote approves matching tools")
          yield* admitActivity(remoteChat.id, remoteParent.id)
          const fibers = yield* Effect.forEach(
            [
              { sessionID: ownerChat.id, messageID: ownerParent.id, callID: "call-owner-always-target", pattern: "ls" },
              {
                sessionID: ownerChat.id,
                messageID: ownerParent.id,
                callID: "call-owner-always-sibling",
                pattern: "ls -la",
              },
              {
                sessionID: ownerChat.id,
                messageID: ownerParent.id,
                callID: "call-owner-always-pending",
                pattern: "pwd",
              },
              {
                sessionID: remoteChat.id,
                messageID: remoteParent.id,
                callID: "call-remote-always-target",
                pattern: "ls",
              },
              {
                sessionID: remoteChat.id,
                messageID: remoteParent.id,
                callID: "call-remote-always-sibling",
                pattern: "ls -la",
              },
              {
                sessionID: remoteChat.id,
                messageID: remoteParent.id,
                callID: "call-remote-always-pending",
                pattern: "pwd",
              },
            ],
            (input) =>
              permission
                .ask({
                  sessionID: input.sessionID,
                  permission: "bash",
                  patterns: [input.pattern],
                  metadata: {},
                  always: input.callID.endsWith("target") ? ["ls *"] : [],
                  tool: { messageID: input.messageID, callID: input.callID },
                  ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
                })
                .pipe(Effect.forkChild),
          )
          const requests = yield* waitFor(
            database.db
              .select({
                requestID: SessionActivityPermissionRequestTable.request_id,
                callID: SessionActivityPermissionRequestTable.tool_call_id,
              })
              .from(SessionActivityPermissionRequestTable)
              .all()
              .pipe(
                Effect.orDie,
                Effect.map((items) => (items.length === 6 ? items : undefined)),
              ),
            "timed out waiting for durable always fanout fixtures",
          )
          const ownerTargetID = PermissionV1.ID.make(
            requests.find((request) => request.callID === "call-owner-always-target")!.requestID,
          )
          const remoteTargetID = PermissionV1.ID.make(
            requests.find((request) => request.callID === "call-remote-always-target")!.requestID,
          )
          const remote = yield* makeRemotePermission()

          yield* permission.reply({ requestID: ownerTargetID, reply: "always" })
          yield* remote.service.reply({ requestID: remoteTargetID, reply: "always" })

          const approved = yield* Effect.forEach([fibers[0], fibers[1], fibers[3], fibers[4]], (fiber) =>
            Fiber.await(fiber).pipe(
              Effect.timeoutOrElse({
                duration: "1 second",
                orElse: () => Effect.fail(new Error("durable always fanout did not settle a matching waiter")),
              }),
            ),
          )
          expect(approved.every(Exit.isSuccess)).toBe(true)
          const states = yield* database.db
            .select({
              callID: SessionActivityPermissionRequestTable.tool_call_id,
              state: SessionActivityPermissionRequestTable.state,
            })
            .from(SessionActivityPermissionRequestTable)
            .all()
            .pipe(Effect.orDie)
          expect(
            states
              .filter((request) => request.callID?.includes("always-sibling"))
              .map((request) => request.state)
              .toSorted(),
          ).toEqual(["approved_once", "approved_once"])
          expect(
            states
              .filter((request) => request.callID?.includes("always-pending"))
              .map((request) => request.state)
              .toSorted(),
          ).toEqual(["pending", "pending"])
          expect(
            yield* database.db.select({ count: count() }).from(SessionActivityPermissionOnceConsumptionTable).get(),
          ).toEqual({ count: 0 })
          yield* Effect.forEach([fibers[2], fibers[5]], Fiber.interrupt, { discard: true })
          yield* Scope.close(remote.scope, Exit.void)
        }),
      { config: cfg },
    ),
  20_000,
)

itNoProgress.live(
  "closing one permission runtime preserves the owner runtime lease and pending request",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { session } = yield* boot()
          const database = yield* Database.Service
          const events = yield* EventV2Bridge.Service
          const permission = yield* Permission.Service
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "run pwd")
          const activityID = yield* admitActivity(chat.id, parent.id)
          const waiting = yield* permission
            .ask({
              sessionID: chat.id,
              permission: "bash",
              patterns: ["pwd"],
              metadata: { command: "pwd" },
              always: ["pwd"],
              tool: { messageID: parent.id, callID: "call-owner-scope" },
              ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
            })
            .pipe(Effect.forkChild)
          yield* waitFor(
            permission.list().pipe(Effect.map((items) => (items.length === 1 ? items[0] : undefined))),
            "timed out waiting for owner-scope fixture",
          )
          const remoteScope = yield* Scope.make()
          yield* Layer.build(
            Layer.fresh(
              Permission.layer.pipe(
                Layer.provide(Layer.succeed(Database.Service, database)),
                Layer.provide(Layer.succeed(EventV2Bridge.Service, events)),
                Layer.provide(durableFlags),
              ),
            ),
          ).pipe(Effect.provideService(Scope.Scope, remoteScope))
          expect(
            yield* database.db.select({ count: count() }).from(SessionActivityPermissionOwnerLeaseTable).get(),
          ).toEqual({ count: 2 })

          yield* Scope.close(remoteScope, Exit.void)

          expect(
            yield* database.db.select({ count: count() }).from(SessionActivityPermissionOwnerLeaseTable).get(),
          ).toEqual({ count: 1 })
          expect(yield* DeepAgentActivityAuthority.recoverPendingPermissions("third-runtime")).toBe(0)
          expect(
            (yield* DeepAgentActivityAuthority.reconstruct({ activityKind: "legacy", activityID }))
              .pendingPermissionRequestIDs,
          ).toHaveLength(1)
          yield* Fiber.interrupt(waiting)
        }),
      { config: cfg },
    ),
  20_000,
)

itNoProgress.live(
  "an expired permission owner lease rotates the single runtime to a fresh owner token",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const database = yield* Database.Service
          const events = yield* EventV2Bridge.Service
          const existing = new Set(
            (yield* database.db
              .select({ ownerID: SessionActivityPermissionOwnerLeaseTable.owner_id })
              .from(SessionActivityPermissionOwnerLeaseTable)
              .all()
              .pipe(Effect.orDie)).map((row) => row.ownerID),
          )
          const scope = yield* Scope.make()
          const permission = Context.get(
            yield* Layer.build(
              Layer.fresh(
                Permission.layerWith({ ownerLeaseMs: 15, ownerHeartbeatMs: 30 }).pipe(
                  Layer.provide(Layer.succeed(Database.Service, database)),
                  Layer.provide(Layer.succeed(EventV2Bridge.Service, events)),
                  Layer.provide(durableFlags),
                ),
              ),
            ).pipe(Effect.provideService(Scope.Scope, scope)),
            Permission.Service,
          )
          const initialOwner = (yield* database.db
            .select({ ownerID: SessionActivityPermissionOwnerLeaseTable.owner_id })
            .from(SessionActivityPermissionOwnerLeaseTable)
            .all()
            .pipe(Effect.orDie)).find((row) => !existing.has(row.ownerID))!.ownerID
          const rotatedOwner = yield* waitFor(
            database.db
              .select({ ownerID: SessionActivityPermissionOwnerLeaseTable.owner_id })
              .from(SessionActivityPermissionOwnerLeaseTable)
              .all()
              .pipe(
                Effect.orDie,
                Effect.map((rows) => rows.find((row) => !existing.has(row.ownerID) && row.ownerID !== initialOwner)),
              ),
            "timed out waiting for an expired permission owner rotation",
          )
          const subsequent = yield* permission.rotateOwner!()

          expect(subsequent.previousOwnerID).toBe(rotatedOwner.ownerID)
          expect(subsequent.ownerID).not.toBe(rotatedOwner.ownerID)
          expect(
            yield* database.db
              .select({ ownerID: SessionActivityPermissionOwnerLeaseTable.owner_id })
              .from(SessionActivityPermissionOwnerLeaseTable)
              .where(eq(SessionActivityPermissionOwnerLeaseTable.owner_id, subsequent.ownerID))
              .get(),
          ).toEqual({ ownerID: subsequent.ownerID })
          yield* Scope.close(scope, Exit.void)
        }),
      { config: cfg },
    ),
  20_000,
)

itNoProgress.live(
  "interrupting a production tool quarantines its real Core permission effect before propagating",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { session } = yield* boot()
          const database = yield* Database.Service
          const permission = yield* Permission.Service
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "run pwd")
          const activityID = yield* admitActivity(chat.id, parent.id)
          const started = yield* Deferred.make<void>()
          const permissionEffectGrants: Permission.EffectGrant[] = []
          const context = {
            sessionID: chat.id,
            messageID: parent.id,
            callID: "call-interrupted-core-effect",
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
            permissionEffectGrants,
          } satisfies Tool.Context
          const running = yield* executeWithPermissionAuthority({
            permission,
            context,
            toolName: "bash",
            execute: Effect.gen(function* () {
              const grant = yield* permission.askEffect!({
                sessionID: chat.id,
                permission: "bash",
                patterns: ["pwd"],
                metadata: { command: "pwd" },
                always: ["pwd"],
                tool: { messageID: parent.id, callID: "call-interrupted-core-effect" },
                effectToolName: "bash",
                ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
              })
              if (grant) context.permissionEffectGrants.push(grant)
              yield* Deferred.succeed(started, undefined)
              return yield* Effect.never
            }),
          }).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          yield* Fiber.interrupt(running)
          const interrupted = yield* Fiber.await(running)

          expect(Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause)).toBe(true)
          expect(
            yield* database.db
              .select({ state: SessionActivityPermissionEffectDispatchTable.state })
              .from(SessionActivityPermissionEffectDispatchTable)
              .where(eq(SessionActivityPermissionEffectDispatchTable.tool_call_id, "call-interrupted-core-effect"))
              .get(),
          ).toEqual({ state: "unknown" })
          expect(
            yield* database.db
              .select({ state: SessionActivityObjectiveTable.state })
              .from(SessionActivityObjectiveTable)
              .where(eq(SessionActivityObjectiveTable.activity_id, activityID))
              .get(),
          ).toEqual({ state: "recovery_required" })
          expect(
            yield* database.db
              .select({ state: SessionLegacyActivityTable.state })
              .from(SessionLegacyActivityTable)
              .where(eq(SessionLegacyActivityTable.activity_id, activityID))
              .get(),
          ).toEqual({ state: "recovery_required" })
        }),
      { config: cfg },
    ),
  20_000,
)

itNoProgress.live(
  "a failing Asked listener cannot orphan a durable permission request",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { session } = yield* boot()
          const database = yield* Database.Service
          const events = yield* EventV2Bridge.Service
          const permission = yield* Permission.Service
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "run pwd")
          yield* admitActivity(chat.id, parent.id)
          const off = yield* events.listen((event) =>
            event.type === Permission.Event.Asked.type &&
            (event.data as { tool?: { callID: string } }).tool?.callID === "call-asked-failure"
              ? Effect.die(new Error("asked listener failed"))
              : Effect.void,
          )
          yield* Effect.addFinalizer(() => off)

          expect(
            Exit.isFailure(
              yield* permission
                .ask({
                  sessionID: chat.id,
                  permission: "bash",
                  patterns: ["pwd"],
                  metadata: { command: "pwd" },
                  always: ["pwd"],
                  tool: { messageID: parent.id, callID: "call-asked-failure" },
                  ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
                })
                .pipe(Effect.exit),
            ),
          ).toBe(true)
          expect(yield* permission.list()).toEqual([])
          const request = yield* database.db
            .select()
            .from(SessionActivityPermissionRequestTable)
            .where(eq(SessionActivityPermissionRequestTable.tool_call_id, "call-asked-failure"))
            .get()
            .pipe(Effect.orDie)
          expect(request).toMatchObject({ state: "interrupted", decided_at: expect.any(Number) })
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionDecisionTable)
              .where(eq(SessionActivityPermissionDecisionTable.request_id, request!.request_id))
              .get()
              .pipe(Effect.orDie),
          ).toMatchObject({ decision: "interrupted" })
        }),
      { config: cfg },
    ),
  20_000,
)

itNoProgress.live(
  "a cross-runtime rejection preserves durable correction feedback",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { session } = yield* boot()
          const database = yield* Database.Service
          const events = yield* EventV2Bridge.Service
          const permission = yield* Permission.Service
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "run pwd")
          yield* admitActivity(chat.id, parent.id)
          const waiting = yield* permission
            .ask({
              sessionID: chat.id,
              permission: "bash",
              patterns: ["pwd"],
              metadata: { command: "pwd" },
              always: ["pwd"],
              tool: { messageID: parent.id, callID: "call-cross-runtime-feedback" },
              ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
            })
            .pipe(Effect.forkChild)
          const pending = yield* waitFor(
            database.db
              .select({ id: SessionActivityPermissionRequestTable.request_id })
              .from(SessionActivityPermissionRequestTable)
              .where(eq(SessionActivityPermissionRequestTable.tool_call_id, "call-cross-runtime-feedback"))
              .get()
              .pipe(Effect.orDie),
            "timed out waiting for cross-runtime feedback fixture",
          )
          const requestID = PermissionV1.ID.make(pending.id)
          const remoteScope = yield* Scope.make()
          const remote = Context.get(
            yield* Layer.build(
              Layer.fresh(
                Permission.layer.pipe(
                  Layer.provide(Layer.succeed(Database.Service, database)),
                  Layer.provide(Layer.succeed(EventV2Bridge.Service, events)),
                  Layer.provide(durableFlags),
                ),
              ),
            ).pipe(Effect.provideService(Scope.Scope, remoteScope)),
            Permission.Service,
          )

          yield* remote.reply({ requestID, reply: "reject", message: "use the scoped command" })

          const outcome = yield* Fiber.await(waiting).pipe(
            Effect.timeoutOrElse({
              duration: "1 second",
              orElse: () => Effect.fail(new Error("cross-runtime correction did not settle the owner waiter")),
            }),
          )
          expect(Exit.isFailure(outcome)).toBe(true)
          if (Exit.isFailure(outcome))
            expect(Cause.squash(outcome.cause)).toMatchObject({ feedback: "use the scoped command" })
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionDecisionTable)
              .where(eq(SessionActivityPermissionDecisionTable.request_id, pending.id))
              .get()
              .pipe(Effect.orDie),
          ).toMatchObject({ decision: "denied", feedback: "use the scoped command" })
          yield* Scope.close(remoteScope, Exit.void)
        }),
      { config: cfg },
    ),
  20_000,
)

itNoProgress.live(
  "durable UI reply and timeout race converges on one decision and settles the waiter",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { session } = yield* boot()
          const database = yield* Database.Service
          const permission = yield* Permission.Service
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "run pwd")
          yield* admitActivity(chat.id, parent.id)
          const waiting = yield* permission
            .ask({
              sessionID: chat.id,
              permission: "bash",
              patterns: ["pwd"],
              metadata: { command: "pwd" },
              always: ["pwd"],
              tool: { messageID: parent.id, callID: "call-timeout-race" },
              ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
              timeoutMs: 25,
            })
            .pipe(Effect.forkChild)
          const pending = yield* waitFor(
            permission.list().pipe(Effect.map((items) => (items.length === 1 ? items[0] : undefined))),
            "timed out waiting for permission race fixture",
          )
          yield* Effect.sleep("20 millis")
          yield* permission.reply({ requestID: pending.id, reply: "once" }).pipe(Effect.exit)
          const askExit = yield* Fiber.await(waiting).pipe(
            Effect.timeoutOrElse({
              duration: "1 second",
              orElse: () => Effect.fail(new Error("permission reply/timeout race did not settle")),
            }),
          )

          const request = yield* database.db
            .select()
            .from(SessionActivityPermissionRequestTable)
            .where(eq(SessionActivityPermissionRequestTable.request_id, pending.id))
            .get()
            .pipe(Effect.orDie)
          const decisions = yield* database.db
            .select()
            .from(SessionActivityPermissionDecisionTable)
            .where(eq(SessionActivityPermissionDecisionTable.request_id, pending.id))
            .all()
            .pipe(Effect.orDie)
          const consumption = yield* database.db
            .select()
            .from(SessionActivityPermissionOnceConsumptionTable)
            .where(eq(SessionActivityPermissionOnceConsumptionTable.request_id, pending.id))
            .get()
            .pipe(Effect.orDie)
          expect(decisions).toHaveLength(1)
          expect(request?.state).toBe(decisions[0]?.decision)
          expect(yield* permission.list()).toEqual([])
          if (decisions[0]?.decision === "approved_once") {
            expect(Exit.isSuccess(askExit)).toBe(true)
            expect(consumption).toMatchObject({ consumer_id: `tool:${parent.id}:call-timeout-race` })
            return
          }
          expect(["expired", "interrupted"]).toContain(decisions[0]?.decision)
          expect(Exit.isFailure(askExit)).toBe(true)
          expect(consumption).toBeUndefined()
        }),
      { config: cfg },
    ),
  20_000,
)

itNoProgress.live(
  "cancelling a durable permission waiter cannot orphan its admitted request",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { session } = yield* boot()
          const database = yield* Database.Service
          const permission = yield* Permission.Service
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "run pwd")
          yield* admitActivity(chat.id, parent.id)
          const waiting = yield* permission
            .ask({
              sessionID: chat.id,
              permission: "bash",
              patterns: ["pwd"],
              metadata: { command: "pwd" },
              always: ["pwd"],
              tool: { messageID: parent.id, callID: "call-cancelled" },
              ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
            })
            .pipe(Effect.forkChild)
          const pending = yield* waitFor(
            permission.list().pipe(Effect.map((items) => (items.length === 1 ? items[0] : undefined))),
            "timed out waiting for cancelled permission fixture",
          )

          yield* Fiber.interrupt(waiting)

          expect(yield* permission.list()).toEqual([])
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionDecisionTable)
              .where(eq(SessionActivityPermissionDecisionTable.request_id, pending.id))
              .get()
              .pipe(Effect.orDie),
          ).toMatchObject({ decision: "interrupted" })
          expect(
            Exit.isFailure(yield* permission.reply({ requestID: pending.id, reply: "once" }).pipe(Effect.exit)),
          ).toBe(true)
        }),
      { config: cfg },
    ),
  20_000,
)

itNoProgress.live(
  "saved no-progress approval resumes the durable objective without another UI wait",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { session } = yield* boot()
          const database = yield* Database.Service
          const permission = yield* Permission.Service
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "keep reading")
          const activityID = yield* admitActivity(chat.id, parent.id)
          const initial = yield* DeepAgentActivityAuthority.reconstruct({ activityKind: "legacy", activityID })
          const configured = yield* DeepAgentActivityAuthority.configure({
            activityKind: "legacy",
            activityID,
            expectedVersion: initial.objective.version,
            objectiveText: "keep reading until evidence changes",
            completionCriteria: [{ kind: "plan_complete" }],
            enforcementState: "monitoring",
            stallThreshold: 1,
          })
          const first = yield* DeepAgentActivityAuthority.observe({
            activityKind: "legacy",
            activityID,
            idempotencyKey: "saved-no-progress-first",
            expectedVersion: configured.version,
            evidence: [{ fingerprint: "stable-read", kind: "tool_invocation" }],
            effectReceipts: [],
          })
          const stalled = yield* DeepAgentActivityAuthority.observe({
            activityKind: "legacy",
            activityID,
            idempotencyKey: "saved-no-progress-stalled",
            expectedVersion: first.objective.version,
            evidence: [{ fingerprint: "stable-read", kind: "tool_invocation" }],
            effectReceipts: [],
          })
          expect(stalled.objective.state).toBe("needs_human")
          yield* DeepAgentActivityAuthority.requestPermission({
            activityKind: "legacy",
            activityID,
            requestID: "permission-saved-no-progress",
            requestKind: "no_progress",
            idempotencyKey: "permission-saved-no-progress-request",
            permission: "doom_loop",
            patterns: ["read"],
            alwaysPatterns: ["read"],
            metadata: {},
            ownerID: "test-owner",
          })
          yield* DeepAgentActivityAuthority.decidePermission({
            requestID: "permission-saved-no-progress",
            idempotencyKey: "permission-saved-no-progress-decision",
            decision: "approved_always",
            actorType: "user",
            actorID: "test-user",
          })
          const resumed = yield* DeepAgentActivityAuthority.reconstruct({ activityKind: "legacy", activityID })
          const stalledAgain = yield* DeepAgentActivityAuthority.observe({
            activityKind: "legacy",
            activityID,
            idempotencyKey: "saved-no-progress-stalled-again",
            expectedVersion: resumed.objective.version,
            evidence: [{ fingerprint: "stable-read", kind: "tool_invocation" }],
            effectReceipts: [],
          })
          expect(stalledAgain.objective.state).toBe("needs_human")

          yield* permission.ask({
            sessionID: chat.id,
            permission: "doom_loop",
            patterns: ["read"],
            metadata: { observation_revision: stalledAgain.observation.revision },
            always: ["read"],
            ruleset: [{ permission: "doom_loop", pattern: "*", action: "ask" }],
          })

          expect(
            (yield* DeepAgentActivityAuthority.reconstruct({ activityKind: "legacy", activityID })).objective,
          ).toMatchObject({ state: "active", noProgressCount: 0 })
          const auto = (yield* database.db
            .select()
            .from(SessionActivityPermissionRequestTable)
            .all()
            .pipe(Effect.orDie)).find((request) => request.request_id !== "permission-saved-no-progress")
          expect(auto).toMatchObject({ request_kind: "no_progress", state: "approved_once" })
          if (!auto) return
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionDecisionTable)
              .where(eq(SessionActivityPermissionDecisionTable.request_id, auto.request_id))
              .get()
              .pipe(Effect.orDie),
          ).toMatchObject({ decision: "approved_once", actor_type: "system", actor_id: "permission-policy" })
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionOnceConsumptionTable)
              .where(eq(SessionActivityPermissionOnceConsumptionTable.request_id, auto.request_id))
              .get()
              .pipe(Effect.orDie),
          ).toBeDefined()
        }),
      { config: cfg },
    ),
  20_000,
)

itNoProgress.live(
  "durable activity authority owns the production no-progress challenge and rejection",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()
          const database = yield* Database.Service
          const permission = yield* Permission.Service
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "read stable.ts until it changes")
          const activityID = yield* admitActivity(chat.id, parent.id)
          const model = yield* provider.getModel(ref.providerID, ref.modelID)
          const tracker = new ToolSequenceTracker()

          const run = Effect.fn("test.runStableReadTurn")(function* () {
            const msg = yield* assistant(chat.id, parent.id, dir)
            const handle = yield* processors.create({
              assistantMessage: msg,
              sessionID: chat.id,
              model,
              sequenceTracker: tracker,
              loopPolicy: "ask",
            })
            const result = yield* handle.process({
              user: {
                id: parent.id,
                sessionID: chat.id,
                role: "user",
                time: parent.time,
                agent: parent.agent,
                model: { providerID: ref.providerID, modelID: ref.modelID },
              } satisfies SessionV1.User,
              sessionID: chat.id,
              model,
              agent: agent(),
              system: [],
              messages: [{ role: "user", content: "read stable.ts until it changes" }],
              tools: {},
            })
            return { result, messageID: msg.id, error: handle.message.error, finish: handle.message.finish }
          })

          const first = yield* run()
          expect(first.result).toEqual({ action: "continue" })
          expect(yield* MessageV2.parts(first.messageID)).toEqual([
            expect.objectContaining({ type: "step-start" }),
            expect.objectContaining({
              type: "tool",
              tool: "read",
              state: expect.objectContaining({ status: "completed" }),
            }),
            expect.objectContaining({ type: "step-finish" }),
          ])
          expect(
            yield* database.db
              .select()
              .from(SessionActivityObjectiveTable)
              .where(eq(SessionActivityObjectiveTable.activity_id, activityID))
              .get()
              .pipe(Effect.orDie),
          ).toMatchObject({ enforcement_state: "monitoring", no_progress_count: 0 })
          const second = yield* run()
          expect(second).toMatchObject({ result: { action: "continue" }, error: undefined })
          expect(
            yield* database.db
              .select()
              .from(SessionActivityObjectiveTable)
              .where(eq(SessionActivityObjectiveTable.activity_id, activityID))
              .get()
              .pipe(Effect.orDie),
          ).toMatchObject({ enforcement_state: "monitoring", no_progress_count: 0 })
          expect((yield* run()).result).toEqual({ action: "continue" })
          expect(
            yield* database.db
              .select()
              .from(SessionActivityObjectiveTable)
              .where(eq(SessionActivityObjectiveTable.activity_id, activityID))
              .get()
              .pipe(Effect.orDie),
          ).toMatchObject({ enforcement_state: "monitoring", no_progress_count: 1 })
          const blocked = yield* run().pipe(
            Effect.map((turn) => turn.result),
            Effect.forkChild,
          )
          const pending = yield* waitFor(
            permission.list().pipe(Effect.map((items) => (items.length === 1 ? items[0] : undefined))),
            "timed out waiting for durable no-progress permission challenge",
          )
          expect(pending).toMatchObject({
            permission: "doom_loop",
            patterns: ["read"],
            sessionID: chat.id,
            metadata: { activity_id: activityID, no_progress_count: 2 },
          })
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionRequestTable)
              .where(eq(SessionActivityPermissionRequestTable.request_id, pending.id))
              .get()
              .pipe(Effect.orDie),
          ).toMatchObject({
            activity_kind: "legacy",
            activity_id: activityID,
            request_kind: "no_progress",
            state: "pending",
          })

          yield* permission.reply({ requestID: pending.id, reply: "reject" })
          expect(yield* Fiber.join(blocked)).toMatchObject({ action: "stop" })
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionRequestTable)
              .where(eq(SessionActivityPermissionRequestTable.request_id, pending.id))
              .get()
              .pipe(Effect.orDie),
          ).toMatchObject({ state: "interrupted" })
          expect(
            yield* database.db
              .select()
              .from(SessionActivityPermissionDecisionTable)
              .where(eq(SessionActivityPermissionDecisionTable.request_id, pending.id))
              .get()
              .pipe(Effect.orDie),
          ).toMatchObject({ decision: "interrupted", actor_type: "user" })
          expect(
            yield* database.db
              .select()
              .from(SessionActivityObjectiveTable)
              .where(eq(SessionActivityObjectiveTable.activity_id, activityID))
              .get()
              .pipe(Effect.orDie),
          ).toMatchObject({ state: "interrupted", terminal_reason: "permission_interrupted" })
          expect(
            yield* database.db
              .select()
              .from(SessionLegacyActivityTable)
              .where(eq(SessionLegacyActivityTable.activity_id, activityID))
              .get()
              .pipe(Effect.orDie),
          ).toMatchObject({ state: "interrupted", terminal_reason: "permission_interrupted" })
        }),
      { config: cfg },
    ),
  20_000,
)

itDurableProviderError.live(
  "repeated provider tool failures enter the durable no-progress challenge",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()
          const database = yield* Database.Service
          const permission = yield* Permission.Service
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "retry the failing lookup")
          const activityID = yield* admitActivity(chat.id, parent.id)
          const model = yield* provider.getModel(ref.providerID, ref.modelID)
          const run = Effect.fn("test.runFailingToolTurn")(function* () {
            const msg = yield* assistant(chat.id, parent.id, dir)
            const handle = yield* processors.create({
              assistantMessage: msg,
              sessionID: chat.id,
              model,
              loopPolicy: "ask",
            })
            return yield* handle.process({
              user: {
                id: parent.id,
                sessionID: chat.id,
                role: "user",
                time: parent.time,
                agent: parent.agent,
                model: { providerID: ref.providerID, modelID: ref.modelID },
              } satisfies SessionV1.User,
              sessionID: chat.id,
              model,
              agent: agent(),
              system: [],
              messages: [{ role: "user", content: "retry the failing lookup" }],
              tools: {},
            })
          })

          expect(yield* run()).toEqual({ action: "continue" })
          expect(yield* run()).toEqual({ action: "continue" })
          const blocked = yield* run().pipe(Effect.forkChild)
          const pending = yield* waitFor(
            permission.list().pipe(Effect.map((items) => (items.length === 1 ? items[0] : undefined))),
            "timed out waiting for repeated tool failure challenge",
          )
          expect(pending).toMatchObject({
            permission: "doom_loop",
            patterns: ["lookup"],
            metadata: { activity_id: activityID, no_progress_count: 2 },
          })
          expect(
            yield* database.db
              .select()
              .from(SessionActivityEvidenceTable)
              .where(eq(SessionActivityEvidenceTable.activity_id, activityID))
              .all()
              .pipe(Effect.orDie),
          ).toEqual([expect.objectContaining({ evidence_kind: "tool_error" })])

          yield* permission.reply({ requestID: pending.id, reply: "reject" })
          expect(yield* Fiber.join(blocked)).toMatchObject({ action: "stop" })
        }),
      { config: cfg },
    ),
  20_000,
)

itPlanProtocol.live("session.processor persists activity-scoped plan violations and stops without retry", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "repair the plan")
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const tracker = new PlanProtocolTracker()
        const run = Effect.fn("test.runPlanProtocolTurn")(function* () {
          const msg = yield* assistant(chat.id, parent.id, dir)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
            planTracker: tracker,
          })
          const result = yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "repair the plan" }],
            tools: {},
          })
          return { handle, msg, parts: yield* MessageV2.parts(msg.id), result }
        })

        const first = yield* run()
        const second = yield* run()
        const firstPlan = first.parts.find(
          (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "plan",
        )
        const secondPlan = second.parts.find(
          (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "plan",
        )

        expect(first.result).toEqual({ action: "continue" })
        expect(first.handle.message.error).toBeUndefined()
        expect(firstPlan?.state.status).toBe("completed")
        if (firstPlan?.state.status === "completed") expect(firstPlan.state.metadata.plan_attempt_ordinal).toBe(1)

        expect(second.result.action).toBe("stop")
        expect(second.handle.message.finish).toBe("error")
        expect(second.handle.message.error).toMatchObject({
          name: "PlanProtocolViolation",
          data: { attemptOrdinal: 2, code: "invalid_2" },
        })
        expect(secondPlan?.state.status).toBe("completed")
        if (secondPlan?.state.status === "completed") expect(secondPlan.state.metadata.plan_attempt_ordinal).toBe(2)
      }),
    { config: cfg },
  ),
)

itOrphanPlanProtocol.live("schema failure before durable tool-call consumes the same plan budget", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "repair the plan")
        yield* session.updateMessage({ ...parent, metadata: withPlanProtocolActivity(undefined, parent.id) })
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        let tracker = new PlanProtocolTracker()
        const run = Effect.fn("test.runOrphanPlanProtocolTurn")(function* () {
          const msg = yield* assistant(chat.id, parent.id, dir)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
            planTracker: tracker,
          })
          const result = yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "repair the plan" }],
            tools: {},
          })
          return { result, handle }
        })

        const first = yield* run()
        const firstParts = yield* MessageV2.parts(first.handle.message.id)
        const durableFailure = firstParts.find(
          (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "plan",
        )
        expect(durableFailure?.state.status).toBe("error")
        if (durableFailure?.state.status === "error") {
          expect(durableFailure.state.metadata).toMatchObject({ plan_protocol: "schema", plan_attempt_ordinal: 1 })
        }
        tracker = new PlanProtocolTracker(restorePlanProtocolFailures(yield* MessageV2.stream(chat.id)))
        expect(restorePlanProtocolFailures(yield* MessageV2.stream(chat.id))).toBe(1)
        const second = yield* run()
        expect(first.result).toEqual({ action: "continue" })
        expect(first.handle.message.error).toBeUndefined()
        expect(second.result.action).toBe("stop")
        expect(second.handle.message.finish).toBe("error")
        expect(second.handle.message.error).toMatchObject({
          name: "PlanProtocolViolation",
          data: { attemptOrdinal: 2, code: "missing_tool_call" },
        })
      }),
    { config: cfg },
  ),
)

it.live("session.processor effect tests capture llm input cleanly", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const transitions: string[] = []
        const value = yield* handle.process(input, {
          attemptId: "attempt_effect",
          dispatching: Effect.sync(() => {
            transitions.push("dispatching")
          }),
          streaming: Effect.sync(() => {
            transitions.push("streaming")
          }),
          settled: Effect.sync(() => {
            transitions.push("settled")
          }),
          failed: () =>
            Effect.sync(() => {
              transitions.push("failed")
            }),
        })
        const parts = yield* MessageV2.parts(msg.id)
        const calls = yield* llm.calls

        expect(value).toEqual({ action: "continue" })
        expect(calls).toBe(1)
        expect(transitions).toEqual(["dispatching", "streaming", "settled"])
        expect(parts.some((part) => part.type === "text" && part.text === "hello")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests preserve text start time", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const gate = defer<void>()
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "hello" } }],
              },
            ],
            wait: gate.promise,
            tail: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "stop" }],
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.TextPart => part.type === "text")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for text part",
        )
        yield* Effect.sleep("20 millis")
        gate.resolve()

        const exit = yield* Fiber.await(run)
        const text = (yield* MessageV2.parts(msg.id)).find((part): part is SessionV1.TextPart => part.type === "text")

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(text?.text).toBe("hello")
        expect(text?.time?.start).toBeDefined()
        expect(text?.time?.end).toBeDefined()
        if (!text?.time?.start || !text.time.end) return
        expect(text.time.start).toBeLessThan(text.time.end)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests stop after token overflow requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("after", { usage: { input: 100_000, output: 0 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        const mdl = { ...base, limit: { context: 100_000, output: 10 } }
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        expect(value).toEqual({ action: "compact" })
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(parts.some((part) => part.type === "step-finish")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture reasoning from http mock", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("think").text("done").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.find((part): part is SessionV1.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is SessionV1.TextPart => part.type === "text")

        expect(value).toEqual({ action: "continue" })
        expect(yield* llm.calls).toBe(1)
        expect(reasoning?.text).toBe("think")
        expect(text?.text).toBe("done")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests reset reasoning state across retries", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("one").reset(), reply().reason("two").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.filter((part): part is SessionV1.ReasoningPart => part.type === "reasoning")

        expect(value).toEqual({ action: "continue" })
        expect(yield* llm.calls).toBe(2)
        expect(reasoning.some((part) => part.text === "two")).toBe(true)
        expect(reasoning.some((part) => part.text === "onetwo")).toBe(false)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests never retry a durable provider attempt", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("one").reset(), reply().reason("two").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })
        const transitions: string[] = []

        const value = yield* handle.process(
          {
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "reason" }],
            tools: {},
            durableAttempt: true,
          },
          {
            attemptId: "attempt_no_retry",
            dispatching: Effect.sync(() => {
              transitions.push("dispatching")
            }),
            streaming: Effect.sync(() => {
              transitions.push("streaming")
            }),
            settled: Effect.sync(() => {
              transitions.push("settled")
            }),
            failed: () =>
              Effect.sync(() => {
                transitions.push("failed")
              }),
          },
        )

        expect(value.action).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(transitions).toEqual(["dispatching", "failed"])
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests do not retry unknown json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { error: { message: "no_kv_space" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "json" }],
          tools: {},
        })

        expect(value.action).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("APIError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry recognized structured json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry json" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toEqual({ action: "continue" })
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish retry status updates", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        yield* llm.error(503, { error: "boom" })
        yield* llm.text("")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: number[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== SessionStatus.Event.Status.type) return Effect.void
          const data = evt.data as typeof SessionStatus.Event.Status.data.Type
          if (data.sessionID === chat.id && data.status.type === "retry") states.push(data.status.attempt)
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry" }],
          tools: {},
        })

        yield* off

        expect(value).toEqual({ action: "continue" })
        expect(yield* llm.calls).toBe(2)
        expect(states).toStrictEqual([1])
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests compact on structured context overflow", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact json" }],
          tools: {},
        })

        expect(value).toEqual({ action: "compact" })
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests complete AI SDK tool calls when native flag is off", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.tool("lookup", { query: "weather" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "tool" }],
          tools: {
            lookup: tool({
              description: "Look up information",
              inputSchema: z.object({ query: z.string() }),
              execute: async (input) => ({
                title: "Weather lookup",
                output: `result:${input.query}`,
                metadata: { source: "test" },
              }),
            }),
          },
        })

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(value).toEqual({ action: "continue" })
        expect(yield* llm.calls).toBe(1)
        expect(call?.callID).toBe("call_1")
        expect(call?.tool).toBe("lookup")
        expect(call?.state.status).toBe("completed")
        if (call?.state.status !== "completed") return
        expect(call.state.input).toEqual({ query: "weather" })
        expect(call.state.output).toBe("result:weather")
        expect(call.state.title).toBe("Weather lookup")
        expect(call.state.metadata).toEqual({ source: "test" })
        expect(call.state.time.start).toBeDefined()
        expect(call.state.time.end).toBeDefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark pending tools as aborted on cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.toolHang("bash", { cmd: "pwd" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "tool abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.ToolPart => part.type === "tool")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for tool part",
        )
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Tool input was incomplete and was not executed")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.metadata?.incompleteInput).toBe(true)
          expect(call.state.time.end).toBeDefined()
        }
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests record aborted errors and idle state", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const seen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errs: string[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== Session.Event.Error.type) return Effect.void
          const data = evt.data as typeof Session.Event.Error.data.Type
          if (data.sessionID !== chat.id || !data.error) return Effect.void
          errs.push(data.error.name)
          seen.resolve()
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        yield* Effect.promise(() => seen.promise)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)
        yield* off

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
        expect(errs).toContain("MessageAbortedError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark interruptions aborted without manual abort", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "interrupt" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itProviderError.live("session.processor effect tests fail provider-executed error results", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider tool error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const settlements: Array<typeof SessionEvent.Tool.Failed.Type> = []
        const off = yield* events.listen((event) => {
          if (event.type === SessionEvent.Tool.Failed.type)
            settlements.push(event as typeof SessionEvent.Tool.Failed.Type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "provider tool error" }],
          tools: {},
        })
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") expect(call.state.error).toBe("provider boom")
        expect(settlements).toHaveLength(1)
        expect(settlements[0]?.data).toMatchObject({
          callID: "call-1",
          error: { type: "unknown", message: "provider boom" },
          result: { type: "error", value: "provider boom" },
          provider: { executed: true },
        })
      }),
    { config: cfg },
  ),
)

itFragmentFailure.live("session.processor effect tests flush partial v2 fragments before step failure", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider failure")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        let text: string | undefined
        let reasoning: string | undefined
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          if (event.type === SessionEvent.Text.Ended.type)
            text = (event.data as typeof SessionEvent.Text.Ended.data.Type).text
          if (event.type === SessionEvent.Reasoning.Ended.type)
            reasoning = (event.data as typeof SessionEvent.Reasoning.Ended.data.Type).text
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        expect(
          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "provider failure" }],
            tools: {},
          }),
        ).toMatchObject({ action: "stop", reason: { code: "assistant_error" } })
        yield* off

        const failed = seen.indexOf(SessionEvent.Step.Failed.type)
        expect(failed).toBeGreaterThan(-1)
        expect(seen.indexOf(SessionEvent.Text.Ended.type)).toBeLessThan(failed)
        expect(seen.indexOf(SessionEvent.Reasoning.Ended.type)).toBeLessThan(failed)
        expect(text).toBe("partial")
        expect(reasoning).toBe("thinking")
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// BUG-010 §9.3 — deterministic incident fixture (P0 for GO gate)
// ---------------------------------------------------------------------------

// §9.3 variant A: original incident payloads (missing operation/version → invalid_operation)
// Must stop after exactly 2 dispatches with PlanProtocolViolation.
itIncidentOriginal.live("§9.3 BUG-010: original incident payloads (no operation/version) stop at 2 dispatches", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "build the benchmark suite")
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const tracker = new PlanProtocolTracker()
        let dispatchCount = 0

        const run = Effect.fn("test.runIncidentOrigTurn")(function* () {
          const msg = yield* assistant(chat.id, parent.id, dir)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
            planTracker: tracker,
          })
          dispatchCount += 1
          const result = yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "build the benchmark suite" }],
            tools: {},
          })
          return { handle, msg, parts: yield* MessageV2.parts(msg.id), result }
        })

        const first = yield* run()

        // Dispatch 1: first malformed plan → correctable error, session continues
        expect(first.result).toEqual({ action: "continue" })
        expect(first.handle.message.error).toBeUndefined()
        const firstPlan = first.parts.find(
          (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "plan",
        )
        if (firstPlan?.state.status === "completed") {
          expect(firstPlan.state.metadata.plan_attempt_ordinal).toBe(1)
          // §7.5: the output text must contain the attempt ordinal so the model can see it
          expect(firstPlan.state.output).toContain("[Plan attempt 1 of 2]")
        }

        const second = yield* run()

        // Dispatch 2: second consecutive malformed plan → PlanProtocolViolation, stops
        expect(second.result.action).toBe("stop")
        expect(second.handle.message.finish).toBe("error")
        expect(second.handle.message.error).toMatchObject({
          name: "PlanProtocolViolation",
          data: { attemptOrdinal: 2 },
        })

        // §9.3 hard contract: physical Provider dispatch ≤ 2
        expect(dispatchCount).toBeLessThanOrEqual(2)
      }),
    { config: cfg },
  ),
)

// §9.3 variant B: forward-compatible payloads (valid envelope, malformed steps) stop at 2 dispatches.
// This proves the semantic/quality oracle (not just structural decode) is what blocks them.
itIncidentForwardCompat.live("§9.3 BUG-010: forward-compatible incident payloads stop at 2 dispatches", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "build the benchmark suite")
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const tracker = new PlanProtocolTracker()
        let dispatchCount = 0

        const run = Effect.fn("test.runIncidentFwdTurn")(function* () {
          const msg = yield* assistant(chat.id, parent.id, dir)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
            planTracker: tracker,
          })
          dispatchCount += 1
          const result = yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "build the benchmark suite" }],
            tools: {},
          })
          return { handle, result }
        })

        const first = yield* run()
        expect(first.result).toEqual({ action: "continue" })
        expect(first.handle.message.error).toBeUndefined()

        const second = yield* run()
        expect(second.result.action).toBe("stop")
        expect(second.handle.message.finish).toBe("error")
        expect(second.handle.message.error).toMatchObject({ name: "PlanProtocolViolation" })

        // §9.3 hard contract: physical Provider dispatch ≤ 2
        expect(dispatchCount).toBeLessThanOrEqual(2)
      }),
    { config: cfg },
  ),
)

// PlanProtocolViolation persistence + DB reload round-trip
// §7.5: the error must survive a session reload (not be lost or downgraded to UnknownError).
itPlanProtocol.live("PlanProtocolViolation is persisted to DB and survives message reload", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "repair the plan")
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const tracker = new PlanProtocolTracker()

        const run = Effect.fn("test.runForPersistence")(function* () {
          const msg = yield* assistant(chat.id, parent.id, dir)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
            planTracker: tracker,
          })
          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "repair the plan" }],
            tools: {},
          })
          return handle
        })

        yield* run() // first turn: correctable error
        const second = yield* run() // second turn: PlanProtocolViolation

        // Immediate check: error present on the live handle
        expect(second.message.finish).toBe("error")
        expect(second.message.error).toMatchObject({ name: "PlanProtocolViolation" })

        // DB reload: load all messages for the session and find the last assistant message
        const allMessages = yield* session.messages({ sessionID: chat.id })
        const assistantMsgs = allMessages.filter((m) => m.info.role === "assistant")
        const lastAssistant = assistantMsgs[assistantMsgs.length - 1]?.info

        expect(lastAssistant?.role).toBe("assistant")
        if (lastAssistant?.role === "assistant") {
          // §7.5: after DB reload, PlanProtocolViolation must NOT be downgraded to UnknownError
          expect(lastAssistant.finish).toBe("error")
          expect(lastAssistant.error).toMatchObject({ name: "PlanProtocolViolation" })
          expect(lastAssistant.error?.name).not.toBe("UnknownError")
        }
      }),
    { config: cfg },
  ),
)
