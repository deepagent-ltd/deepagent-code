import { NodeFileSystem } from "@effect/platform-node"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { PermissionV1 } from "@deepagent-code/core/v1/permission"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { tool } from "ai"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
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
import {
  PlanProtocolTracker,
  restorePlanProtocolFailures,
  SessionProcessor,
  withPlanProtocolActivity,
} from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import * as Log from "@deepagent-code/core/util/log"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { LLMEvent } from "@deepagent-code/llm"

void Log.init({ print: false })

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
  Session.defaultLayer,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
