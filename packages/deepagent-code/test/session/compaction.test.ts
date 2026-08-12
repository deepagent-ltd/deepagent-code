import { afterEach, describe, expect, mock, test } from "bun:test"
import { ConfigV1 } from "@deepagent-code/core/v1/config/config"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Database } from "@deepagent-code/core/database/database"
import { EventTable } from "@deepagent-code/core/event/sql"
import { PartTable, SessionHistoryStateTable, SessionWorldStateBaselineTable } from "@deepagent-code/core/session/sql"
import { EventV2Bridge } from "@/event-v2-bridge"
import { APICallError } from "ai"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import * as Stream from "effect/Stream"
import { and, eq, inArray } from "drizzle-orm"
import { Config } from "@/config/config"
import { Image } from "@/image/image"
import { Agent } from "../../src/agent/agent"
import { LLM } from "../../src/session/llm"
import { SessionCompaction } from "../../src/session/compaction"
import { HistoryAuthority } from "../../src/session/history-authority"
import { Token } from "@/util/token"
import * as Log from "@deepagent-code/core/util/log"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { provideTmpdirInstance, TestInstance } from "../fixture/fixture"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"

import type { Provider } from "@/provider/provider"
import * as SessionProcessorModule from "../../src/session/processor"
import { Snapshot } from "../../src/snapshot"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { TestConfig } from "../fixture/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PromptEpoch } from "@/session/prompt-epoch"
import { CompactionArtifactTable, CompactionRunTable, CompactionSummaryAttemptTable } from "@/session/compaction-sql"
import { SessionPromptEpochTable } from "@/session/prompt-epoch.sql"
import { LLMEvent, Usage } from "@deepagent-code/llm"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const usage = (input: ConstructorParameters<typeof Usage>[0]) => new Usage(input)

const basicUsage = () => usage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })

afterEach(() => {
  mock.restore()
})

function createModel(opts: {
  context: number
  output: number
  input?: number
  cost?: Provider.Model["cost"]
  npm?: string
}): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: {
      context: opts.context,
      input: opts.input,
      output: opts.output,
    },
    cost: opts.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: opts.npm ?? "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

const wide = () => ProviderTest.fake({ model: createModel({ context: 100_000, output: 32_000 }) })

function createUserMessage(sessionID: SessionID, text: string) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const msg = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "text",
      text,
    })
    return msg
  })
}

function createAssistantMessage(sessionID: SessionID, parentID: MessageID, root: string) {
  return SessionNs.Service.use((ssn) =>
    ssn.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      sessionID,
      mode: "build",
      agent: "build",
      path: { cwd: root, root },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: ref.modelID,
      providerID: ref.providerID,
      parentID,
      time: { created: Date.now() },
      finish: "end_turn",
    }),
  )
}

function createSummaryAssistantMessage(sessionID: SessionID, parentID: MessageID, root: string, text: string) {
  return SessionNs.Service.use((ssn) =>
    Effect.gen(function* () {
      const msg = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        sessionID,
        mode: "compaction",
        agent: "compaction",
        path: { cwd: root, root },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: ref.modelID,
        providerID: ref.providerID,
        parentID,
        summary: true,
        time: { created: Date.now() },
        finish: "end_turn",
      })
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "text",
        text,
      })
      return msg
    }),
  )
}

function createCompactionMarker(sessionID: SessionID) {
  return SessionNs.Service.use((ssn) =>
    Effect.gen(function* () {
      const msg = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: ref,
        sessionID,
        agent: "build",
        time: { created: Date.now() },
      })
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: false,
      })
    }),
  )
}

function fake(
  input: Parameters<SessionProcessorModule.SessionProcessor.Interface["create"]>[0],
  result: "continue" | "compact",
  session: SessionNs.Interface,
) {
  const decision = { action: result } as const
  const msg = input.assistantMessage
  const processSummary: SessionProcessorModule.SessionProcessor.Handle["processSummary"] = Effect.fn(
    "TestSessionProcessor.processSummary",
  )(function* (_streamInput, attempt) {
    yield* attempt.dispatching
    yield* attempt.streaming
    if (result === "continue") {
      yield* Effect.gen(function* () {
        msg.finish = "stop"
        msg.time.completed = Date.now()
        yield* session.updateMessage(msg)
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: msg.sessionID,
          type: "text",
          text: "summary",
        })
      })
    }
    yield* attempt.settled
    return decision
  })
  return {
    get message() {
      return msg
    },
    updateToolCall: Effect.fn("TestSessionProcessor.updateToolCall")(() => Effect.succeed(undefined)),
    completeToolCall: Effect.fn("TestSessionProcessor.completeToolCall")(() => Effect.void),
    process: Effect.fn("TestSessionProcessor.process")(() => Effect.succeed(decision)),
    processSummary,
  } satisfies SessionProcessorModule.SessionProcessor.Handle
}

function layer(result: "continue" | "compact") {
  return Layer.effect(
    SessionProcessorModule.SessionProcessor.Service,
    SessionNs.Service.use((session) =>
      Effect.succeed(
        SessionProcessorModule.SessionProcessor.Service.of({
          create: Effect.fn("TestSessionProcessor.create")((input) => Effect.succeed(fake(input, result, session))),
        }),
      ),
    ),
  ).pipe(Layer.provide(SessionNs.defaultLayer))
}

function cfg(compaction?: ConfigV1.Info["compaction"]) {
  const base = Schema.decodeUnknownSync(ConfigV1.Info)({}) as ConfigV1.Info
  return TestConfig.layer({
    get: () => Effect.succeed({ ...base, compaction }),
  })
}

const deps = Layer.mergeAll(
  wide().layer,
  layer("continue"),
  Agent.defaultLayer,
  Plugin.defaultLayer,
  EventV2Bridge.defaultLayer,
  Config.defaultLayer,
  RuntimeFlags.layer({ experimentalEventSystem: true }),
  Database.defaultLayer,
  EventV2Bridge.defaultLayer,
  PromptEpoch.defaultLayer,
)

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  Database.defaultLayer,
  EventV2Bridge.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  PromptEpoch.defaultLayer,
  SessionCompaction.layer.pipe(Layer.provide(SessionNs.defaultLayer), Layer.provideMerge(deps)),
)

const it = testEffect(env)

const compactionEnv = Layer.mergeAll(
  SessionNs.defaultLayer,
  Database.defaultLayer,
  EventV2Bridge.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  PromptEpoch.defaultLayer,
)
const itCompaction = testEffect(compactionEnv)

type CompactionProcessOptions = {
  result?: "continue" | "compact"
  llm?: Layer.Layer<LLM.Service>
  plugin?: Layer.Layer<Plugin.Service>
  provider?: ReturnType<typeof ProviderTest.fake>
  config?: Layer.Layer<Config.Service>
}

function withCompaction(options?: CompactionProcessOptions) {
  return Effect.provide(compactionProcessLayer(options))
}

function compactionProcessLayer(options?: CompactionProcessOptions) {
  const events = EventV2Bridge.defaultLayer
  const status = SessionStatus.layer.pipe(Layer.provide(events))
  const processor = options?.llm
    ? SessionProcessorModule.SessionProcessor.layer.pipe(
        Layer.provide(summary),
        Layer.provide(Image.defaultLayer),
        Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
        Layer.provide(status),
      )
    : layer(options?.result ?? "continue")
  return Layer.mergeAll(SessionCompaction.layer.pipe(Layer.provide(processor)), processor, events, status).pipe(
    Layer.provide(SessionNs.defaultLayer),
    Layer.provide((options?.provider ?? wide()).layer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(options?.llm ?? LLM.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(options?.plugin ?? Plugin.defaultLayer),
    Layer.provide(status),
    Layer.provide(events),
    Layer.provide(options?.config ?? Config.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provide(PromptEpoch.defaultLayer),
  )
}

function createSummaryCompaction(sessionID: SessionID) {
  return SessionCompaction.use.create({ sessionID, agent: "build", model: ref, auto: false })
}

function readCompactionPart(sessionID: SessionID) {
  return SessionNs.use
    .messages({ sessionID })
    .pipe(
      Effect.map((messages) =>
        messages.at(-2)?.parts.find((item): item is SessionV1.CompactionPart => item.type === "compaction"),
      ),
    )
}

function llm() {
  const queue: Array<
    Stream.Stream<LLMEvent, unknown> | ((input: LLM.StreamInput) => Stream.Stream<LLMEvent, unknown>)
  > = []

  return {
    push(stream: Stream.Stream<LLMEvent, unknown> | ((input: LLM.StreamInput) => Stream.Stream<LLMEvent, unknown>)) {
      queue.push(stream)
    },
    layer: Layer.succeed(
      LLM.Service,
      LLM.Service.of({
        stream: (input) => {
          const item = queue.shift() ?? Stream.empty
          const stream = typeof item === "function" ? item(input) : item
          return stream.pipe(Stream.mapEffect((event) => Effect.succeed(event)))
        },
      }),
    ),
  }
}

function reply(
  text: string,
  capture?: (input: LLM.StreamInput) => void,
): (input: LLM.StreamInput) => Stream.Stream<LLMEvent, unknown> {
  return (input) => {
    capture?.(input)
    return Stream.make(
      LLMEvent.textStart({ id: "txt-0" }),
      LLMEvent.textDelta({ id: "txt-0", text }),
      LLMEvent.textEnd({ id: "txt-0" }),
      LLMEvent.stepFinish({
        index: 0,
        reason: "stop",
        usage: basicUsage(),
      }),
      LLMEvent.finish({
        reason: "stop",
        usage: basicUsage(),
      }),
    )
  }
}

function plugin(ready: Deferred.Deferred<void>) {
  return Layer.mock(Plugin.Service)({
    trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
      if (name !== "experimental.session.compacting") return Effect.succeed(output)
      return Effect.sync(() => Deferred.doneUnsafe(ready, Effect.void)).pipe(
        Effect.andThen(Effect.never),
        Effect.as(output),
      )
    },
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  })
}

function autocontinue(enabled: boolean) {
  return Layer.mock(Plugin.Service)({
    trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
      if (name !== "experimental.compaction.autocontinue") return Effect.succeed(output)
      return Effect.sync(() => {
        ;(output as { enabled: boolean }).enabled = enabled
        return output
      })
    },
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  })
}

function gatedAutocontinue(ready: Deferred.Deferred<void>, release: Deferred.Deferred<void>) {
  return Layer.mock(Plugin.Service)({
    trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
      if (name !== "experimental.compaction.autocontinue") return Effect.succeed(output)
      return Effect.gen(function* () {
        yield* Deferred.succeed(ready, undefined)
        yield* Deferred.await(release)
        ;(output as { enabled: boolean }).enabled = true
        return output
      })
    },
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  })
}

describe("session.compaction.isOverflow", () => {
  it.live(
    "returns true when token count exceeds usable context",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "returns false when token count within usable context",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 200_000, output: 32_000 })
        const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
      }),
    ),
  )

  it.live(
    "includes cache.read in token count",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 60_000, output: 10_000, reasoning: 0, cache: { read: 10_000, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "respects input limit for input caps",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        const tokens = { input: 271_000, output: 1_000, reasoning: 0, cache: { read: 2_000, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "returns false when input/output are within input caps",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        const tokens = { input: 200_000, output: 20_000, reasoning: 0, cache: { read: 10_000, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
      }),
    ),
  )

  it.live(
    "returns false when output within limit with input caps",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 200_000, input: 120_000, output: 10_000 })
        const tokens = { input: 50_000, output: 9_999, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
      }),
    ),
  )

  it.live(
    "keeps an input-side compaction buffer when limit.input is set",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 200_000, input: 200_000, output: 32_000 })
        const tokens = { input: 180_000, output: 15_000, reasoning: 0, cache: { read: 3_000, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "uses context as the input limit fallback without subtracting output capacity",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 200_000, output: 32_000 })
        const tokens = { input: 180_000, output: 15_000, reasoning: 0, cache: { read: 3_000, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "uses the same input-side threshold with explicit input and context fallback",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const withInputLimit = createModel({ context: 200_000, input: 200_000, output: 32_000 })
        const withoutInputLimit = createModel({ context: 200_000, output: 32_000 })
        const tokens = { input: 166_000, output: 10_000, reasoning: 0, cache: { read: 5_000, write: 0 } }
        const withLimit = yield* compact.isOverflow({ tokens, model: withInputLimit })
        const withoutLimit = yield* compact.isOverflow({ tokens, model: withoutInputLimit })
        expect(withLimit).toBe(withoutLimit)
      }),
    ),
  )

  it.live(
    "context limit 0 (unknown) does not trigger overflow — isOverflow returns false with unavailable phase",
    // BUG-007 RC-3/RC-4: context=0 is the runtime fallback for an *unknown* limit. The typed phase
    // is now "unavailable/context_limit_unknown", not the same "ok" as auto=false.
    // isOverflow() still returns false because "unavailable" ≠ "hard", but the reason differs.
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 0, output: 32_000 })
        const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
      }),
    ),
  )

  it.live(
    "returns false when compaction.auto is disabled",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const model = createModel({ context: 100_000, output: 32_000 })
          const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
          expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
        }),
      {
        config: {
          compaction: { auto: false },
        },
      },
    ),
  )
})

describe("session.compaction.create", () => {
  it.live(
    "creates a compaction user message and part",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service

        const info = yield* ssn.create({})
        const activityID = "msg_activity_for_compaction"

        yield* compact.create({
          sessionID: info.id,
          agent: "build",
          model: ref,
          auto: true,
          overflow: true,
          activityID,
        })

        const msgs = yield* ssn.messages({ sessionID: info.id })
        expect(msgs).toHaveLength(1)
        expect(msgs[0].info.role).toBe("user")
        expect(
          SessionProcessorModule.planProtocolActivityID(
            msgs[0].info.role === "user" ? msgs[0].info.metadata : undefined,
          ),
        ).toBe(activityID)
        expect(msgs[0].parts).toHaveLength(1)
        expect(msgs[0].parts[0]).toMatchObject({
          type: "compaction",
          auto: true,
          overflow: true,
        })
      }),
    ),
  )

  it.live(
    "fails an incomplete requested run before admitting a replacement marker",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service
        const { db } = yield* Database.Service
        const info = yield* ssn.create({})
        const source = yield* MessageV2.promptHistoryProjectionEffect(info.id)
        yield* db
          .insert(CompactionRunTable)
          .values({
            run_id: "incomplete-run",
            session_id: info.id,
            from_prompt_epoch: 0,
            trigger: "manual",
            marker_message_id: MessageID.ascending(),
            marker_part_id: PartID.ascending(),
            source_window_id: source.window.windowID,
            source_effective_history_hash: source.effectiveHistoryHash,
            source_message_count: source.messages.length,
            source_projection_version: source.projectionVersion,
            state: "requested",
            created_at: Date.now(),
          })
          .run()
          .pipe(Effect.orDie)

        yield* compact.create({
          sessionID: info.id,
          agent: "build",
          model: ref,
          auto: false,
        })

        const runs = yield* db.select().from(CompactionRunTable).all().pipe(Effect.orDie)
        expect(runs).toHaveLength(2)
        expect(runs.find((run) => run.run_id === "incomplete-run")).toMatchObject({
          state: "failed",
          terminal_failure_kind: "marker_write_incomplete",
        })
        expect(runs.find((run) => run.run_id !== "incomplete-run")?.state).toBe("requested")
        const messages = yield* ssn.messages({ sessionID: info.id })
        expect(messages).toHaveLength(1)
        expect(messages[0]?.parts[0]?.type).toBe("compaction")
      }),
    ),
  )

  it.live.skip(
    "projects a compaction message to v2 (v2 projector disabled)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})

        yield* compact.create({
          sessionID: info.id,
          agent: "build",
          model: ref,
          auto: true,
          overflow: true,
        })

        const v2 = yield* SessionV2.Service.use((svc) => svc.messages({ sessionID: info.id })).pipe(
          Effect.provide(SessionExecution.noopLayer),
          Effect.provide(SessionV2.defaultLayer),
        )
        expect(v2.at(-1)).toMatchObject({
          type: "compaction",
          reason: "auto",
          summary: "",
        })
      }),
    ),
  )
})

describe("session.compaction.prune", () => {
  it.live(
    "compacts old completed tool output",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          const a = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: info.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: a.id,
            sessionID: info.id,
            type: "text",
            text: "first",
          })
          const b: SessionV1.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: info.id,
            mode: "build",
            agent: "build",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: {
              output: 0,
              input: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            modelID: ref.modelID,
            providerID: ref.providerID,
            parentID: a.id,
            time: { created: Date.now() },
            finish: "end_turn",
          }
          yield* ssn.updateMessage(b)
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: b.id,
            sessionID: info.id,
            type: "tool",
            callID: crypto.randomUUID(),
            tool: "bash",
            state: {
              status: "completed",
              input: {},
              output: "x".repeat(200_000),
              title: "done",
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            },
          })
          for (const text of ["second", "third"]) {
            const msg = yield* ssn.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: info.id,
              agent: "build",
              model: ref,
              time: { created: Date.now() },
            })
            yield* ssn.updatePart({
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: info.id,
              type: "text",
              text,
            })
          }

          yield* compact.prune({ sessionID: info.id })

          const msgs = yield* ssn.messages({ sessionID: info.id })
          const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
          expect(part?.type).toBe("tool")
          expect(part?.state.status).toBe("completed")
          if (part?.type === "tool" && part.state.status === "completed") {
            expect(part.state.time.compacted).toBeNumber()
          }
        }),

      {
        config: {
          compaction: { prune: true },
        },
      },
    ),
  )

  it.live(
    "skips protected skill tool output",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const a = yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: info.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: a.id,
          sessionID: info.id,
          type: "text",
          text: "first",
        })
        const b: SessionV1.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: info.id,
          mode: "build",
          agent: "build",
          path: { cwd: dir, root: dir },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: ref.modelID,
          providerID: ref.providerID,
          parentID: a.id,
          time: { created: Date.now() },
          finish: "end_turn",
        }
        yield* ssn.updateMessage(b)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: b.id,
          sessionID: info.id,
          type: "tool",
          callID: crypto.randomUUID(),
          tool: "skill",
          state: {
            status: "completed",
            input: {},
            output: "x".repeat(200_000),
            title: "done",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        })
        for (const text of ["second", "third"]) {
          const msg = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: info.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: info.id,
            type: "text",
            text,
          })
        }

        yield* compact.prune({ sessionID: info.id })

        const msgs = yield* ssn.messages({ sessionID: info.id })
        const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
        expect(part?.type).toBe("tool")
        if (part?.type === "tool" && part.state.status === "completed") {
          expect(part.state.time.compacted).toBeUndefined()
        }
      }),
    ),
  )
})

describe("session.compaction.process", () => {
  it.instance(
    "throws when parent is not a user message",
    Effect.gen(function* () {
      const test = yield* TestInstance
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const reply = yield* createAssistantMessage(session.id, msg.id, test.directory)
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const exit = yield* Effect.exit(
        SessionCompaction.use.process({
          parentID: reply.id,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        }),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Error)
        if (error instanceof Error) {
          expect(error.message).toContain(`Compaction parent must be a user message: ${reply.id}`)
        }
      }
    }),
  )

  it.instance(
    "publishes compacted event on continue",
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const done = yield* Deferred.make<void, Error>()
      let seen = false
      const unsub = yield* events.listen((evt) => {
        if (evt.type !== SessionCompaction.Event.Compacted.type) return Effect.void
        if ((evt.data as typeof SessionCompaction.Event.Compacted.data.Type).sessionID !== session.id)
          return Effect.void
        seen = true
        Deferred.doneUnsafe(done, Effect.void)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      yield* Deferred.await(done).pipe(Effect.timeout("500 millis"))
      expect(result).toBe("continue")
      expect(seen).toBe(true)
    }),
  )

  itCompaction.instance(
    "marks summary message as errored on compact result",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      const summary = (yield* ssn.messages({ sessionID: session.id })).find(
        (msg) => msg.info.role === "assistant" && msg.info.summary,
      )

      expect(result).toBe("stop")
      expect(summary?.info.role).toBe("assistant")
      if (summary?.info.role === "assistant") {
        expect(summary.info.finish).toBe("error")
        expect(JSON.stringify(summary.info.error)).toContain("Session too large to compact")
      }
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select({ state: CompactionRunTable.state, failure: CompactionRunTable.terminal_failure_kind })
          .from(CompactionRunTable)
          .where(eq(CompactionRunTable.session_id, session.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ state: "failed", failure: "summary_context_overflow" })
      expect(
        yield* db
          .select({ state: SessionHistoryStateTable.state })
          .from(SessionHistoryStateTable)
          .where(eq(SessionHistoryStateTable.session_id, session.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ state: "recovery_required" })
      expect(
        yield* db
          .select({ authority: SessionPromptEpochTable.authority_state })
          .from(SessionPromptEpochTable)
          .where(and(eq(SessionPromptEpochTable.session_id, session.id), eq(SessionPromptEpochTable.state, "active")))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ authority: "recovery_required" })
      expect(Exit.isFailure(yield* ssn.assertRunnable(session.id).pipe(Effect.exit))).toBe(true)
    }).pipe(withCompaction({ result: "compact" })),
  )

  it.instance(
    "adds synthetic continue prompt when auto is enabled",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: true,
      })

      const all = yield* ssn.messages({ sessionID: session.id })
      const last = all.at(-1)

      expect(result).toBe("continue")
      expect(last?.info.role).toBe("user")
      if (last?.info.role === "user") {
        expect(SessionProcessorModule.planProtocolActivityID(last.info.metadata)).toBe(msg.id)
      }
      const summary = all.find((message) => message.info.role === "assistant" && message.info.summary)
      expect(summary).toBeDefined()
      expect(last!.info.id > summary!.info.id).toBe(true)
      expect(last?.parts[0]).toMatchObject({
        type: "text",
        synthetic: true,
        metadata: { compaction_continue: true },
      })
      if (last?.parts[0]?.type === "text") {
        expect(last.parts[0].text).toContain("Continue if you have next steps")
      }
    }),
  )

  itCompaction.instance(
    "persists tail_start_id for retained recent turns",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "first")
      const keep = yield* createUserMessage(session.id, "second")
      yield* createUserMessage(session.id, "third")
      yield* createSummaryCompaction(session.id)

      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({
        parentID: parent!,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      const part = yield* readCompactionPart(session.id)
      expect(part?.type).toBe("compaction")
      expect(part?.tail_start_id).toBe(keep.id)
    }).pipe(withCompaction({ config: cfg({ tail_turns: 2, preserve_recent_tokens: 10_000 }) })),
  )

  itCompaction.instance(
    "shrinks retained tail to fit preserve token budget",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "first")
      yield* createUserMessage(session.id, "x".repeat(2_000))
      const keep = yield* createUserMessage(session.id, "tiny")
      yield* createSummaryCompaction(session.id)

      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({
        parentID: parent!,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      const part = yield* readCompactionPart(session.id)
      expect(part?.type).toBe("compaction")
      expect(part?.tail_start_id).toBe(keep.id)
    }).pipe(withCompaction({ config: cfg({ tail_turns: 2, preserve_recent_tokens: 100 }) })),
  )

  itCompaction.instance(
    "falls back to full summary when even one recent turn exceeds preserve token budget",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(reply("summary", (input) => (captured = JSON.stringify(input.messages))))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "first")
        yield* createUserMessage(session.id, "y".repeat(2_000))
        yield* createSummaryCompaction(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        const part = yield* readCompactionPart(session.id)
        expect(part?.type).toBe("compaction")
        expect(part?.tail_start_id).toBeUndefined()
        expect(captured).toContain("yyyy")
      }).pipe(withCompaction({ llm: stub.layer, config: cfg({ tail_turns: 1, preserve_recent_tokens: 20 }) }))
    },
    { git: true },
  )

  itCompaction.instance(
    "falls back to full summary when retained tail media exceeds preserve token budget",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(reply("summary", (input) => (captured = JSON.stringify(input.messages))))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older")
        const recent = yield* createUserMessage(session.id, "recent image turn")
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: recent.id,
          sessionID: session.id,
          type: "file",
          mime: "image/png",
          filename: "big.png",
          url: `data:image/png;base64,${"a".repeat(4_000)}`,
        })
        yield* createSummaryCompaction(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        const part = yield* readCompactionPart(session.id)
        expect(part?.type).toBe("compaction")
        expect(part?.tail_start_id).toBeUndefined()
        expect(captured).toContain("recent image turn")
        expect(captured).toContain("Attached image/png: big.png")
      }).pipe(withCompaction({ llm: stub.layer, config: cfg({ tail_turns: 1, preserve_recent_tokens: 100 }) }))
    },
    { git: true },
  )

  itCompaction.instance(
    "summarizes an entire turn when only an assistant suffix fits the preserve token budget",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(reply("summary", (input) => (captured = JSON.stringify(input.messages))))
      return Effect.gen(function* () {
        const test = yield* TestInstance
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older")
        const recent = yield* createUserMessage(session.id, "recent turn")
        const large = yield* createAssistantMessage(session.id, recent.id, test.directory)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: large.id,
          sessionID: session.id,
          type: "text",
          text: "z".repeat(2_000),
        })
        const keep = yield* createAssistantMessage(session.id, recent.id, test.directory)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: keep.id,
          sessionID: session.id,
          type: "text",
          text: "keep tail",
        })
        yield* createSummaryCompaction(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        const part = yield* readCompactionPart(session.id)
        expect(part?.type).toBe("compaction")
        expect(part?.tail_start_id).toBeUndefined()
        expect(captured).toContain("zzzz")
        expect(captured).toContain("keep tail")

        const projected = yield* MessageV2.promptHistoryEffect(session.id)
        expect(projected[0]?.info.id).toBe(parent!)
        expect(projected[1]?.info.role).toBe("assistant")
        expect(projected[1]?.info.role === "assistant" ? projected[1].info.summary : false).toBe(true)
        expect(projected.map((msg) => msg.info.id)).not.toContain(recent.id)
        expect(projected.map((msg) => msg.info.id)).not.toContain(large.id)
        expect(projected.map((msg) => msg.info.id)).not.toContain(keep.id)
      }).pipe(withCompaction({ llm: stub.layer, config: cfg({ tail_turns: 1, preserve_recent_tokens: 100 }) }))
    },
    { git: true },
  )

  itCompaction.instance(
    "allows plugins to disable synthetic continue prompt",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: true,
      })

      const all = yield* ssn.messages({ sessionID: session.id })
      const last = all.at(-1)

      expect(result).toBe("continue")
      expect(last?.info.role).toBe("assistant")
      expect(
        all.some(
          (msg) =>
            msg.info.role === "user" &&
            msg.parts.some(
              (part) => part.type === "text" && part.synthetic && part.text.includes("Continue if you have next steps"),
            ),
        ),
      ).toBe(false)
    }).pipe(withCompaction({ plugin: autocontinue(false) })),
  )

  it.instance(
    "uses a synthetic continuation instead of replaying the latest media user turn",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "root")
      const request = yield* createUserMessage(session.id, "image request")
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: request.id,
        sessionID: session.id,
        type: "file",
        mime: "image/png",
        filename: "cat.png",
        url: "https://example.com/cat.png",
      })
      const marker = yield* createUserMessage(session.id, "compaction marker")
      const before = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: marker.id,
        messages: before,
        sessionID: session.id,
        auto: true,
        overflow: true,
      })

      const messages = yield* ssn.messages({ sessionID: session.id })
      const last = messages.at(-1)
      const markerPart = messages.flatMap((message) => message.parts).find((part) => part.type === "compaction")
      const continuation = last?.parts.find(
        (part) => part.type === "text" && part.metadata?.compaction_continue === true,
      )
      const { db } = yield* Database.Service
      const provenance = yield* db
        .select({ id: PartTable.id, provenance: PartTable.provenance })
        .from(PartTable)
        .where(
          inArray(
            PartTable.id,
            [markerPart?.id, continuation?.id].filter((id): id is PartID => id !== undefined),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const artifacts = yield* db
        .select({ kind: CompactionArtifactTable.kind })
        .from(CompactionArtifactTable)
        .all()
        .pipe(Effect.orDie)

      expect(result).toBe("continue")
      expect(last?.info.role).toBe("user")
      const summary = messages.find((message) => message.info.role === "assistant" && message.info.summary)
      expect(summary).toBeDefined()
      expect(last!.info.id > summary!.info.id).toBe(true)
      expect(
        messages
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "text" && part.text === "image request"),
      ).toHaveLength(1)
      expect(continuation?.type === "text" ? continuation.synthetic : false).toBe(true)
      expect(continuation?.type === "text" ? continuation.text : "").toContain("media files were removed from context")
      expect(
        messages
          .flatMap((message) => message.parts)
          .some((part) => part.type === "text" && part.text.includes("Attached image/png: cat.png")),
      ).toBe(false)
      expect(provenance.find((part) => part.id === markerPart?.id)?.provenance).toMatchObject({
        source: "compaction_marker",
        owner_session_id: session.id,
        durable: true,
      })
      expect(provenance.find((part) => part.id === continuation?.id)?.provenance).toMatchObject({
        source: "compaction_continue",
        owner_session_id: session.id,
        durable: true,
      })
      expect(artifacts.some((artifact) => artifact.kind === "replay")).toBe(false)
    }),
  )

  it.instance(
    "does not replay stale media across a newer text-only user request",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "root")
      const staleMedia = yield* createUserMessage(session.id, "old media request")
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: staleMedia.id,
        sessionID: session.id,
        type: "file",
        mime: "image/png",
        filename: "old.png",
        url: "https://example.com/old.png",
      })
      yield* createUserMessage(session.id, "latest text-only request")
      const marker = yield* createUserMessage(session.id, "compaction marker")
      const before = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: marker.id,
        messages: before,
        sessionID: session.id,
        auto: true,
        overflow: true,
      })

      const messages = yield* ssn.messages({ sessionID: session.id })
      const continuation = messages
        .at(-1)
        ?.parts.find((part) => part.type === "text" && part.metadata?.compaction_continue === true)
      const { db } = yield* Database.Service
      const provenance = yield* db.select({ provenance: PartTable.provenance }).from(PartTable).all().pipe(Effect.orDie)

      expect(result).toBe("continue")
      expect(continuation?.type === "text" ? continuation.synthetic : false).toBe(true)
      expect(
        messages
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "text" && part.text === "old media request"),
      ).toHaveLength(1)
      expect(provenance.some((part) => part.provenance?.source === "compaction_replay")).toBe(false)
    }),
  )

  it.instance(
    "uses overflow guidance for a text-only user turn",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "earlier")
      const msg = yield* createUserMessage(session.id, "current")
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: true,
        overflow: true,
      })

      const messages = yield* ssn.messages({ sessionID: session.id })
      const last = messages.at(-1)
      const marker = messages.flatMap((message) => message.parts).find((part) => part.type === "compaction")
      const continuation = last?.parts.find(
        (part) => part.type === "text" && part.metadata?.compaction_continue === true,
      )
      const { db } = yield* Database.Service
      const provenance = yield* db
        .select({ id: PartTable.id, provenance: PartTable.provenance })
        .from(PartTable)
        .where(
          inArray(
            PartTable.id,
            [marker?.id, continuation?.id].filter((id): id is PartID => id !== undefined),
          ),
        )
        .all()
        .pipe(Effect.orDie)

      expect(result).toBe("continue")
      expect(last?.info.role).toBe("user")
      if (last?.parts[0]?.type === "text") {
        expect(last.parts[0].text).toContain("previous request exceeded the provider's size limit")
      }
      expect(provenance.find((part) => part.id === marker?.id)?.provenance).toMatchObject({
        source: "compaction_marker",
        owner_session_id: session.id,
        durable: true,
      })
      expect(provenance.find((part) => part.id === continuation?.id)?.provenance).toMatchObject({
        source: "compaction_continue",
        owner_session_id: session.id,
        durable: true,
      })
    }),
  )

  itCompaction.instance(
    "does not enter in-memory retry backoff after a durable summary attempt fails",
    () => {
      const stub = llm()
      stub.push(
        Stream.fromAsyncIterable(
          {
            async *[Symbol.asyncIterator]() {
              yield LLMEvent.stepStart({ index: 0 })
              throw new APICallError({
                message: "boom",
                url: "https://example.com/v1/chat/completions",
                requestBodyValues: {},
                statusCode: 503,
                responseHeaders: { "retry-after-ms": "10000" },
                responseBody: '{"error":"boom"}',
                isRetryable: true,
              })
            },
          },
          (err) => err,
        ),
      )

      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const msg = yield* createUserMessage(session.id, "hello")
        const msgs = yield* ssn.messages({ sessionID: session.id })
        const start = Date.now()
        const result = yield* SessionCompaction.use.process({
          parentID: msg.id,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })
        expect(result).toBe("stop")
        // Keep this well below the provider's 10s retry hint while allowing durable
        // attempt settlement and test-database cleanup on slower CI workers.
        expect(Date.now() - start).toBeLessThan(2_000)
      }).pipe(withCompaction({ llm: stub.layer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "does not leave a summary assistant when aborted before processor setup",
    () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>()
        return yield* Effect.gen(function* () {
          const ssn = yield* SessionNs.Service
          const session = yield* ssn.create({})
          const msg = yield* createUserMessage(session.id, "hello")
          const msgs = yield* ssn.messages({ sessionID: session.id })
          const fiber = yield* SessionCompaction.use
            .process({
              parentID: msg.id,
              messages: msgs,
              sessionID: session.id,
              auto: false,
            })
            .pipe(Effect.forkChild)

          yield* Deferred.await(ready).pipe(Effect.timeout("1 second"))
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("250 millis"))
          const all = yield* ssn.messages({ sessionID: session.id })

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
          expect(all.some((msg) => msg.info.role === "assistant" && msg.info.summary)).toBe(false)
        }).pipe(withCompaction({ plugin: plugin(ready) }))
      }),
    { git: true },
  )

  itCompaction.instance(
    "does not classify an active local compaction as crash-indeterminate",
    () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const stub = llm()
        stub.push(reply("summary protected by the local owner"))
        return yield* Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const ssn = yield* SessionNs.Service
          const session = yield* ssn.create({})
          const message = yield* createUserMessage(session.id, "keep the active compaction alive")
          const fiber = yield* compact
            .process({
              parentID: message.id,
              messages: yield* ssn.messages({ sessionID: session.id }),
              sessionID: session.id,
              auto: true,
            })
            .pipe(Effect.forkChild)

          yield* Deferred.await(ready).pipe(Effect.timeout("2 seconds"))
          const { db } = yield* Database.Service
          const before = yield* db
            .select()
            .from(CompactionRunTable)
            .where(eq(CompactionRunTable.session_id, session.id))
            .get()
            .pipe(Effect.orDie)
          expect(before?.state).toBe("summarizing")

          yield* compact.recover(session.id)

          const during = yield* db
            .select()
            .from(CompactionRunTable)
            .where(eq(CompactionRunTable.session_id, session.id))
            .get()
            .pipe(Effect.orDie)
          expect(during?.state).toBe("summarizing")
          expect(during?.terminal_failure_kind).toBeNull()

          yield* Deferred.succeed(release, undefined)
          expect(yield* Fiber.join(fiber)).toBe("continue")
          const committed = yield* db
            .select()
            .from(CompactionRunTable)
            .where(eq(CompactionRunTable.session_id, session.id))
            .get()
            .pipe(Effect.orDie)
          expect(committed?.state).toBe("committed")
        }).pipe(withCompaction({ llm: stub.layer, plugin: gatedAutocontinue(ready, release) }))
      }),
    { git: true },
  )

  itCompaction.instance(
    "quarantines a provider attempt that has no active local owner",
    () =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const marker = yield* createUserMessage(session.id, "stale compaction marker")
        const { db } = yield* Database.Service
        const source = yield* MessageV2.promptHistoryProjectionEffect(session.id)
        yield* db
          .insert(CompactionRunTable)
          .values({
            run_id: "stale-provider-run",
            session_id: session.id,
            from_prompt_epoch: 0,
            trigger: "manual",
            marker_message_id: marker.id,
            source_window_id: source.window.windowID,
            source_effective_history_hash: source.effectiveHistoryHash,
            source_message_count: source.messages.length,
            source_projection_version: source.projectionVersion,
            state: "requested",
            created_at: Date.now(),
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(CompactionRunTable)
          .set({ state: "summarizing" })
          .where(eq(CompactionRunTable.run_id, "stale-provider-run"))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(CompactionSummaryAttemptTable)
          .values({
            summary_attempt_id: "stale-provider-attempt",
            run_id: "stale-provider-run",
            ordinal: 1,
            provider_id: "test",
            model_id: "test-model",
            protocol: "text",
            state: "streaming",
            prepared_at: Date.now(),
            dispatched_at: Date.now(),
          })
          .run()
          .pipe(Effect.orDie)

        yield* compact.recover(session.id)

        const run = yield* db
          .select()
          .from(CompactionRunTable)
          .where(eq(CompactionRunTable.run_id, "stale-provider-run"))
          .get()
          .pipe(Effect.orDie)
        const attempt = yield* db
          .select()
          .from(CompactionSummaryAttemptTable)
          .where(eq(CompactionSummaryAttemptTable.summary_attempt_id, "stale-provider-attempt"))
          .get()
          .pipe(Effect.orDie)
        expect(run?.state).toBe("indeterminate")
        expect(run?.terminal_failure_kind).toBe("process_restart")
        expect(attempt?.state).toBe("indeterminate_after_crash")
        expect(attempt?.failure_kind).toBe("process_restart")
        expect(attempt?.completed_at).toBeNumber()
      }).pipe(withCompaction({ llm: llm().layer })),
    { git: true },
  )

  itCompaction.instance(
    "does not publish or expose artifacts when the commit CAS loses a concurrent failure",
    () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const stub = llm()
        stub.push(reply("summary"))
        return yield* Effect.gen(function* () {
          const ssn = yield* SessionNs.Service
          const session = yield* ssn.create({})
          const original = yield* createUserMessage(session.id, "original context")
          yield* createCompactionMarker(session.id)
          const messages = yield* ssn.messages({ sessionID: session.id })
          const fiber = yield* SessionCompaction.use
            .process({
              parentID: messages.at(-1)!.info.id,
              messages,
              sessionID: session.id,
              auto: true,
            })
            .pipe(Effect.forkChild)

          yield* Deferred.await(ready).pipe(Effect.timeout("2 seconds"))
          const { db } = yield* Database.Service
          const run = yield* db
            .select()
            .from(CompactionRunTable)
            .where(eq(CompactionRunTable.session_id, session.id))
            .get()
            .pipe(Effect.orDie)
          expect(run?.state).toBe("summarizing")
          if (!run) return
          const beforeCommit = yield* ssn.messages({ sessionID: session.id })
          expect(
            beforeCommit.some((message) =>
              message.parts.some((part) => part.type === "text" && part.metadata?.compaction_continue === true),
            ),
          ).toBe(false)
          expect(
            yield* db
              .select()
              .from(CompactionArtifactTable)
              .where(
                and(
                  eq(CompactionArtifactTable.run_id, run.run_id),
                  inArray(CompactionArtifactTable.kind, ["replay", "continue"] as const),
                ),
              )
              .all()
              .pipe(Effect.orDie),
          ).toHaveLength(0)
          yield* db
            .update(CompactionRunTable)
            .set({ state: "failed", terminal_failure_kind: "concurrent_failure" })
            .where(and(eq(CompactionRunTable.run_id, run.run_id), eq(CompactionRunTable.state, "summarizing")))
            .run()
            .pipe(Effect.orDie)
          yield* Deferred.succeed(release, undefined)

          expect(yield* Fiber.join(fiber)).toBe("stop")
          const active = yield* PromptEpoch.Service
          expect((yield* active.getActive(session.id))?.epoch).toBe(0)
          expect(
            yield* db
              .select()
              .from(SessionWorldStateBaselineTable)
              .where(eq(SessionWorldStateBaselineTable.session_id, session.id))
              .all()
              .pipe(Effect.orDie),
          ).toHaveLength(0)
          const artifacts = yield* db
            .select()
            .from(CompactionArtifactTable)
            .where(eq(CompactionArtifactTable.run_id, run.run_id))
            .all()
            .pipe(Effect.orDie)
          expect(artifacts.length).toBeGreaterThan(0)
          expect(artifacts.every((artifact) => artifact.state === "orphaned")).toBe(true)
          expect(
            yield* db
              .select()
              .from(EventTable)
              .where(and(eq(EventTable.aggregate_id, session.id), eq(EventTable.type, "session.compacted")))
              .all()
              .pipe(Effect.orDie),
          ).toHaveLength(0)
          const history = yield* MessageV2.promptHistoryEffect(session.id)
          expect(history.map((message) => message.info.id)).toEqual([original.id])
        }).pipe(withCompaction({ llm: stub.layer, plugin: gatedAutocontinue(ready, release) }))
      }),
    { git: true },
  )

  itCompaction.instance(
    "rejects a replacement whose summary Part changed after candidate hashing",
    () =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const marker = yield* createUserMessage(session.id, "replacement source")
        const markerPart = yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: marker.id,
          sessionID: session.id,
          type: "compaction",
          auto: false,
        })
        const summary = yield* createSummaryAssistantMessage(session.id, marker.id, session.directory, "summary v1")
        const replacement = (yield* ssn.messages({ sessionID: session.id })).filter(
          (message) => message.info.id === marker.id || message.info.id === summary.id,
        )
        const target = replacement.map((message) =>
          message.info.id !== marker.id
            ? message
            : {
                info: message.info,
                parts: message.parts.map((part) =>
                  part.id === markerPart.id ? { ...markerPart, context_tokens: 42 } : part,
                ),
              },
        )
        const candidateHash = HistoryAuthority.hash(target)
        const summaryPart = replacement
          .find((message) => message.info.id === summary.id)
          ?.parts.find((part) => part.type === "text")
        expect(summaryPart).toBeDefined()
        if (!summaryPart || summaryPart.type !== "text") return
        yield* ssn.updatePart({ ...summaryPart, text: "summary mutated after hashing" })

        const { db } = yield* Database.Service
        expect(
          yield* db.transaction((tx) =>
            SessionCompaction.validateReplacementTargetInTransaction({
              tx: tx as unknown as Database.Interface["db"],
              sessionID: session.id,
              replacementMessageIDs: [marker.id, summary.id],
              checkpointUserID: marker.id,
              checkpointAssistantID: summary.id,
              markerMessageID: marker.id,
              markerPartID: markerPart.id,
              contextTokens: 42,
              checkpointHash: candidateHash,
              effectiveHistoryHash: candidateHash,
            }),
          ),
        ).toBe(false)
      }).pipe(withCompaction({ llm: llm().layer })),
    { git: true },
  )

  itCompaction.instance(
    "recovers lost publish receipts without duplicating committed continuation events",
    () => {
      const stub = llm()
      stub.push(reply("durable recovery summary"))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const compact = yield* SessionCompaction.Service
        const session = yield* ssn.create({})
        const message = yield* createUserMessage(session.id, "recover committed compaction")
        const result = yield* compact.process({
          parentID: message.id,
          messages: yield* ssn.messages({ sessionID: session.id }),
          sessionID: session.id,
          auto: true,
        })
        expect(result).toBe("continue")

        const { db } = yield* Database.Service
        const run = yield* db
          .select()
          .from(CompactionRunTable)
          .where(eq(CompactionRunTable.session_id, session.id))
          .get()
          .pipe(Effect.orDie)
        expect(run?.state).toBe("committed")
        if (!run) return
        const continuation = yield* db
          .select()
          .from(CompactionArtifactTable)
          .where(
            and(
              eq(CompactionArtifactTable.run_id, run.run_id),
              inArray(CompactionArtifactTable.kind, ["replay", "continue"] as const),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        expect(continuation?.published_at).not.toBeNull()
        if (!continuation) return
        const beforeEvents = yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, session.id))
          .all()
          .pipe(Effect.orDie)
        const beforeMessages = yield* ssn.messages({ sessionID: session.id })

        yield* db
          .update(CompactionArtifactTable)
          .set({ published_at: null })
          .where(eq(CompactionArtifactTable.artifact_id, continuation.artifact_id))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(CompactionRunTable)
          .set({ continuation_published_at: null, terminal_events_published_at: null })
          .where(eq(CompactionRunTable.run_id, run.run_id))
          .run()
          .pipe(Effect.orDie)

        yield* compact.recover(session.id)

        const recoveredRun = yield* db
          .select()
          .from(CompactionRunTable)
          .where(eq(CompactionRunTable.run_id, run.run_id))
          .get()
          .pipe(Effect.orDie)
        const recoveredArtifact = yield* db
          .select()
          .from(CompactionArtifactTable)
          .where(eq(CompactionArtifactTable.artifact_id, continuation.artifact_id))
          .get()
          .pipe(Effect.orDie)
        const afterEvents = yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, session.id))
          .all()
          .pipe(Effect.orDie)
        const afterMessages = yield* ssn.messages({ sessionID: session.id })

        expect(recoveredRun?.continuation_published_at).not.toBeNull()
        expect(recoveredRun?.terminal_events_published_at).not.toBeNull()
        expect(recoveredArtifact?.published_at).not.toBeNull()
        expect(afterEvents.map((event) => event.id).toSorted()).toEqual(
          beforeEvents.map((event) => event.id).toSorted(),
        )
        expect(afterMessages.map((item) => item.info.id)).toEqual(beforeMessages.map((item) => item.info.id))
      }).pipe(withCompaction({ llm: stub.layer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "silently drops reasoning-delta arriving without prior reasoning-start",
    () => {
      // Regression: PR initially auto-created a reasoning Part for orphan deltas (no preceding
      // reasoning-start). Reverted to match dev — drop silently. Pinned here so any future
      // change to processor.ts reasoning-delta handling triggers this test.
      const stub = llm()
      stub.push(
        Stream.make(
          LLMEvent.reasoningDelta({ id: "orphan-1", text: "stray reasoning" }),
          LLMEvent.textStart({ id: "txt-0" }),
          LLMEvent.textDelta({ id: "txt-0", text: "summary" }),
          LLMEvent.textEnd({ id: "txt-0" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop", usage: basicUsage() }),
          LLMEvent.finish({ reason: "stop", usage: basicUsage() }),
        ),
      )
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const msg = yield* createUserMessage(session.id, "hello")
        const msgs = yield* ssn.messages({ sessionID: session.id })
        yield* SessionCompaction.use.process({
          parentID: msg.id,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        const summary = (yield* ssn.messages({ sessionID: session.id })).find(
          (item) => item.info.role === "assistant" && item.info.summary,
        )
        expect(summary?.parts.some((part) => part.type === "reasoning")).toBe(false)
        // Sanity: the text part still got through.
        expect(summary?.parts.some((part) => part.type === "text" && part.text === "summary")).toBe(true)
      }).pipe(withCompaction({ llm: stub.layer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "tool event during summary stops with a SummaryProtocolViolation error (BUG-006 RC-3)",
    () => {
      const stub = llm()
      // First response: tool call → violation; second: text (fallback within budget).
      stub.push(
        Stream.make(
          LLMEvent.toolCall({ id: "call-1", name: "_noop", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls", usage: basicUsage() }),
          LLMEvent.finish({ reason: "tool-calls", usage: basicUsage() }),
        ),
      )
      stub.push(reply("recovered summary text"))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const msg = yield* createUserMessage(session.id, "hello")
        const msgs = yield* ssn.messages({ sessionID: session.id })
        const result = yield* SessionCompaction.use.process({
          parentID: msg.id,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        // BUG-006 RC-3: the processor raises a typed violation and the controller records
        // that physical attempt before using the remaining durable dispatch budget.
        const allMessages = yield* ssn.messages({ sessionID: session.id })
        const summaries = allMessages.filter((item) => item.info.role === "assistant" && item.info.summary)
        // At least one summary assistant message must have been created (the first attempt).
        expect(summaries.length).toBeGreaterThanOrEqual(1)
        // No tool parts must be persisted on any summary message (tool execution hard gate).
        for (const s of summaries) {
          expect(s.parts.some((p) => p.type === "tool")).toBe(false)
        }
        expect(result).toBe("continue")
        const { db } = yield* Database.Service
        const attempts = yield* db.select().from(CompactionSummaryAttemptTable).all().pipe(Effect.orDie)
        expect(attempts.map((attempt) => [attempt.ordinal, attempt.state, attempt.failure_kind])).toEqual([
          [1, "failed", "summary_protocol_tool_event"],
          [2, "settled", null],
        ])
        const runs = yield* db.select().from(CompactionRunTable).all().pipe(Effect.orDie)
        expect(runs).toHaveLength(1)
        expect(runs[0]?.state).toBe("committed")
        const epochs = yield* PromptEpoch.Service
        const epoch = yield* epochs.getActive(session.id)
        expect(epoch?.epoch).toBe(1)
        const history = yield* MessageV2.promptHistoryEffect(session.id)
        expect(history[0]?.info.role).toBe("user")
        expect(history[0]?.parts.some((part) => part.type === "compaction")).toBe(true)
        expect(history[1]?.info.role).toBe("assistant")
      }).pipe(withCompaction({ llm: stub.layer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "summarizes only the head while keeping recent tail out of summary input",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(
        reply("summary", (input) => {
          captured = JSON.stringify(input.messages)
        }),
      )
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older context")
        yield* createUserMessage(session.id, "keep this turn")
        yield* createUserMessage(session.id, "and this one too")
        yield* createCompactionMarker(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({
          parentID: parent!,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        expect(captured).toContain("older context")
        expect(captured).not.toContain("keep this turn")
        expect(captured).not.toContain("and this one too")
        expect(captured).not.toContain("What did we do so far?")
        const part = yield* readCompactionPart(session.id)
        const history = yield* MessageV2.promptHistoryProjectionEffect(session.id)
        const worldState = yield* MessageV2.promptWorldStateProjectionEffect(session.id)
        expect(worldState?.rendered).toContain("<world-state>")
        const lastUser = history.messages.findLast((message) => message.info.role === "user")
        expect(lastUser?.info.role).toBe("user")
        if (!worldState || !lastUser || lastUser.info.role !== "user") return
        const projected = yield* MessageV2.toModelMessagesEffect(
          MessageV2.appendPromptWorldState({
            messages: history.messages,
            sessionID: session.id,
            epoch: history.epoch,
            baselineHash: worldState.hash,
            rendered: worldState.rendered,
            agent: lastUser.info.agent,
            model: lastUser.info.model,
          }),
          createModel({ context: 100_000, output: 32_000 }),
        )
        expect(part?.context_tokens).toBe(Token.estimate(JSON.stringify(projected)) - Token.estimate("summary") + 1)
      }).pipe(withCompaction({ llm: stub.layer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "anchors repeated compactions with the previous summary",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(reply("summary one"))
      stub.push(
        reply("summary two", (input) => {
          captured = JSON.stringify(input.messages)
        }),
      )

      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older context")
        yield* createUserMessage(session.id, "keep this turn")
        yield* createCompactionMarker(session.id)

        let msgs = yield* ssn.messages({ sessionID: session.id })
        let parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        yield* createUserMessage(session.id, "latest turn")
        yield* createCompactionMarker(session.id)

        msgs = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
        parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        expect(captured).toContain("<previous-summary>")
        expect(captured).toContain("summary one")
        expect(captured.match(/summary one/g)?.length).toBe(1)
        expect(captured).toContain("## Constraints & Preferences")
        expect(captured).toContain("## Progress")
      }).pipe(withCompaction({ llm: stub.layer }))
    },
    { git: true },
  )

  itCompaction.instance("keeps recent pre-compaction turns across repeated compactions", () => {
    const stub = llm()
    stub.push(reply("summary one"))
    stub.push(reply("summary two"))

    return Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const u1 = yield* createUserMessage(session.id, "one")
      const u2 = yield* createUserMessage(session.id, "two")
      const u3 = yield* createUserMessage(session.id, "three")
      yield* createCompactionMarker(session.id)

      let msgs = yield* ssn.messages({ sessionID: session.id })
      let parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      const u4 = yield* createUserMessage(session.id, "four")
      yield* createCompactionMarker(session.id)

      msgs = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
      parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      const filtered = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
      const ids = filtered.map((msg) => msg.info.id)

      expect(ids).not.toContain(u1.id)
      expect(ids).not.toContain(u2.id)
      expect(ids).toContain(u3.id)
      expect(ids).toContain(u4.id)
      expect(filtered.some((msg) => msg.info.role === "assistant" && msg.info.summary)).toBe(true)
      expect(
        filtered.some((msg) => msg.info.role === "user" && msg.parts.some((part) => part.type === "compaction")),
      ).toBe(true)
      const projection = yield* MessageV2.promptHistoryProjectionEffect(session.id)
      const projectedIDs = new Set(projection.orderedMessageIDs)
      expect(projectedIDs.has(u1.id)).toBe(false)
      expect(projectedIDs.has(u2.id)).toBe(false)
      expect(projectedIDs.has(u3.id)).toBe(true)
      expect(projectedIDs.has(u4.id)).toBe(true)
      expect(
        projection.messages.every(
          (message) =>
            message.info.role !== "assistant" || !message.info.parentID || projectedIDs.has(message.info.parentID),
        ),
      ).toBe(true)
    }).pipe(withCompaction({ llm: stub.layer, config: cfg({ tail_turns: 2, preserve_recent_tokens: 10_000 }) }))
  })

  itCompaction.instance("does not let a previous summary create an artificial retained-tail boundary", () => {
    const stub = llm()
    stub.push(reply("summary ".repeat(800)))
    stub.push(reply("second summary"))
    return Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const test = yield* TestInstance
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "older")
      const keep = yield* createUserMessage(session.id, "keep this turn")
      const keepReply = yield* createAssistantMessage(session.id, keep.id, test.directory)
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: keepReply.id,
        sessionID: session.id,
        type: "text",
        text: "keep reply",
      })

      yield* createCompactionMarker(session.id)
      let msgs = yield* ssn.messages({ sessionID: session.id })
      let parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      const recent = yield* createUserMessage(session.id, "recent turn")
      const recentReply = yield* createAssistantMessage(session.id, recent.id, test.directory)
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: recentReply.id,
        sessionID: session.id,
        type: "text",
        text: "recent reply",
      })

      yield* createCompactionMarker(session.id)
      msgs = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
      parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      const part = yield* readCompactionPart(session.id)
      expect(part?.type).toBe("compaction")
      expect(part?.tail_start_id).toBeUndefined()
    }).pipe(withCompaction({ llm: stub.layer, config: cfg({ tail_turns: 2, preserve_recent_tokens: 500 }) }))
  })
})

describe("util.token.estimate", () => {
  test("estimates tokens from text (4 chars per token)", () => {
    const text = "x".repeat(4000)
    expect(Token.estimate(text)).toBe(1000)
  })

  test("estimates tokens from larger text", () => {
    const text = "y".repeat(20_000)
    expect(Token.estimate(text)).toBe(5000)
  })

  test("returns 0 for empty string", () => {
    expect(Token.estimate("")).toBe(0)
  })
})

describe("SessionNs.getUsage", () => {
  test("normalizes standard usage to token format", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }),
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(500)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
  })

  test("extracts cached tokens to cache.read", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadInputTokens: 200 }),
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("handles anthropic cache write metadata", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }),
      metadata: {
        anthropic: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.cache.write).toBe(300)
  })

  test("subtracts cached tokens for anthropic provider", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    // AI SDK v6 normalizes inputTokens to include cached tokens for all providers
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadInputTokens: 200 }),
      metadata: {
        anthropic: {},
      },
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("separates reasoning tokens from output tokens", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, reasoningTokens: 100, totalTokens: 1500 }),
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(400)
    expect(result.tokens.reasoning).toBe(100)
    expect(result.tokens.total).toBe(1500)
  })

  test("does not double count reasoning tokens in cost", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 0,
        output: 15,
        cache: { read: 0, write: 0 },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 0, outputTokens: 1_000_000, reasoningTokens: 250_000, totalTokens: 1_000_000 }),
    })

    expect(result.tokens.output).toBe(750_000)
    expect(result.tokens.reasoning).toBe(250_000)
    expect(result.cost).toBe(15)
  })

  test("handles undefined optional values gracefully", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    })

    expect(result.tokens.input).toBe(0)
    expect(result.tokens.output).toBe(0)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
    expect(Number.isNaN(result.cost)).toBe(false)
  })

  test("calculates cost correctly", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000 }),
    })

    expect(result.cost).toBe(3 + 1.5)
  })

  test("uses authoritative Copilot billed cost when provided", () => {
    const result = SessionNs.getUsage({
      model: createModel({
        context: 100_000,
        output: 32_000,
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 0.3 } },
      }),
      usage: usage({ inputTokens: 11_774, outputTokens: 39, totalTokens: 11_813 }),
      metadata: { copilot: { totalNanoAiu: 4_473_525_000 } },
    })

    expect(result.cost).toBe(0.04473525)
  })

  test("uses matching context cost tier before over-200k fallback", () => {
    const model = createModel({
      context: 1_000_000,
      output: 32_000,
      cost: {
        input: 1,
        output: 2,
        cache: { read: 0.1, write: 0.5 },
        tiers: [
          {
            input: 3,
            output: 4,
            cache: { read: 0.3, write: 1.5 },
            tier: { type: "context", size: 200_000 },
          },
          {
            input: 5,
            output: 6,
            cache: { read: 0.5, write: 2.5 },
            tier: { type: "context", size: 500_000 },
          },
        ],
        experimentalOver200K: {
          input: 100,
          output: 100,
          cache: { read: 100, write: 100 },
        },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({
        inputTokens: 650_000,
        outputTokens: 100_000,
        totalTokens: 750_000,
        cacheReadInputTokens: 100_000,
      }),
    })

    expect(result.tokens.input).toBe(550_000)
    expect(result.cost).toBe(2.75 + 0.6 + 0.05)
  })

  test("falls back to over-200k pricing when no cost tier matches", () => {
    const model = createModel({
      context: 1_000_000,
      output: 32_000,
      cost: {
        input: 1,
        output: 2,
        cache: { read: 0.1, write: 0.5 },
        tiers: [
          {
            input: 5,
            output: 6,
            cache: { read: 0.5, write: 2.5 },
            tier: { type: "context", size: 500_000 },
          },
        ],
        experimentalOver200K: {
          input: 3,
          output: 4,
          cache: { read: 0.3, write: 1.5 },
        },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 300_000, outputTokens: 100_000, totalTokens: 400_000 }),
    })

    expect(result.cost).toBe(0.9 + 0.4)
  })

  test.each(["@ai-sdk/anthropic", "@ai-sdk/amazon-bedrock", "@ai-sdk/google-vertex/anthropic"])(
    "computes total from components for %s models",
    (npm) => {
      const model = createModel({ context: 100_000, output: 32_000, npm })
      // AI SDK v6: inputTokens includes cached tokens for all providers
      const item = usage({
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cacheReadInputTokens: 200,
      })
      if (npm === "@ai-sdk/amazon-bedrock") {
        const result = SessionNs.getUsage({
          model,
          usage: item,
          metadata: {
            bedrock: {
              usage: {
                cacheWriteInputTokens: 300,
              },
            },
          },
        })

        // inputTokens (1000) includes cache, so adjusted = 1000 - 200 - 300 = 500
        expect(result.tokens.input).toBe(500)
        expect(result.tokens.cache.read).toBe(200)
        expect(result.tokens.cache.write).toBe(300)
        // total = adjusted (500) + output (500) + cacheRead (200) + cacheWrite (300)
        expect(result.tokens.total).toBe(1500)
        return
      }

      const result = SessionNs.getUsage({
        model,
        usage: item,
        metadata: {
          anthropic: {
            cacheCreationInputTokens: 300,
          },
        },
      })

      // inputTokens (1000) includes cache, so adjusted = 1000 - 200 - 300 = 500
      expect(result.tokens.input).toBe(500)
      expect(result.tokens.cache.read).toBe(200)
      expect(result.tokens.cache.write).toBe(300)
      // total = adjusted (500) + output (500) + cacheRead (200) + cacheWrite (300)
      expect(result.tokens.total).toBe(1500)
    },
  )

  test("extracts cache write tokens from vertex metadata key", () => {
    const model = createModel({ context: 100_000, output: 32_000, npm: "@ai-sdk/google-vertex/anthropic" })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadInputTokens: 200 }),
      metadata: {
        vertex: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.input).toBe(500)
    expect(result.tokens.cache.read).toBe(200)
    expect(result.tokens.cache.write).toBe(300)
  })
})
