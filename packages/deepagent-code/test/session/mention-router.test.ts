import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { EventDispatcher } from "../../src/session/event-dispatcher"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { Scheduler } from "@deepagent-code/core/deepagent/scheduler"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentEventDropTable } from "@deepagent-code/core/deepagent/deepagent-event-sql"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { testEffect } from "../lib/effect"

// W0.4 — @mention 路由修复与默认统一 (docs/core-v2.0-beta/v2.0-design.md W0.4).
//
// 背景：CLI 事件 V2 admission 默认 ON 时，IM @mention 发布 im.message.created 上总线；纯路由器按
// `triggers[].event` 匹配事件类型，而默认没有任何 agent 声明 IM 触发器 → `no_match` 终端静默
// 丢弃（无执行、无回执）。本套件验证 W0.4 修复：
//   - mention 路由按「被点名的 agent」而非事件类型匹配（点名的 agent 就是授权目标）；
//   - 触发词声明默认 `["mention"]`：未声明 triggers 的 agent 默认可被 @mention；
//   - 未声明触发词 → durable 回执 `agent_no_trigger_mention`（含 agent id）+ `mention_no_trigger_receipt`
//     日志，绝无 no_match 终端丢弃；
//   - 「没有 agent 声明支持该触发词」→ 同样回执而非静默；
//   - 无 env 时事件 admission 默认 ON 的一致性（W0.1 `runtimeDefaultsFromEnv` 单点化前的语义等价断言）。

let clock = 0
const setNow = (t: number) => {
  clock = t
}
const now = () => clock

// Dispatch-port spy: records routed events/targets.
let recorded: EventDispatcher.DispatchRequest[] = []
const resetRecorder = () => {
  recorded = []
}
const recordingPort: EventDispatcher.DispatchPort = {
  dispatch: (request) =>
    Effect.sync(() => {
      recorded.push(request)
    }),
}

// Mention-receipt-port spy: records the W0.4 receipts written instead of a silent no_match drop.
let receipted: EventDispatcher.MentionReceiptInput[] = []
const resetReceipts = () => {
  receipted = []
}
const recordingReceiptPort: EventDispatcher.MentionReceiptPort = {
  receipt: (input) =>
    Effect.sync(() => {
      receipted.push(input)
    }),
}

const makeLayer = (agents: AgentDescriptor[]) => {
  const database = Database.layerFromPath(":memory:")
  const flagsLayer = RuntimeFlags.layer({
    v4EventDrivenIm: true,
    v4AgentPushEnabled: true,
    v4MultiAgentRuntime: true,
  })
  const core = Layer.mergeAll(DeepAgentEventBus.layerWith({ now }), Scheduler.layerWith({ now })).pipe(
    Layer.provideMerge(database),
  )
  const agentList = Layer.succeed(AgentListProviderService, {
    listAgents: () => Effect.succeed(agents),
    findByTrigger: () => Effect.succeed(agents),
    findByCapability: () => Effect.succeed([]),
  })
  const dispatcher = EventDispatcher.layerWith({
    dispatchPort: recordingPort,
    mentionReceiptPort: recordingReceiptPort,
    runLoops: false,
    now,
  }).pipe(
    Layer.provide(core),
    Layer.provide(agentList),
    Layer.provide(flagsLayer),
  )
  return Layer.mergeAll(dispatcher, core, flagsLayer)
}

const mentionInput = (over?: Partial<DeepAgentEvent.PublishInput>): DeepAgentEvent.PublishInput => ({
  type: LMNEvents.IM_MESSAGE_CREATED,
  source: "im",
  workspaceID: "wrk_1",
  payload: { messageID: "msg_1", groupID: "grp_1", content: "@auto hi", mentions: ["auto"] },
  ...over,
})

// An agent that explicitly declares the mention trigger (`[{ event: "mention" }]`).
const declaringAgent: AgentDescriptor = {
  id: "agt_auto",
  name: "auto",
  displayName: "Auto",
  description: "autonomous mode",
  visible: true,
  triggers: [{ event: "mention" }],
}
// An agent WITHOUT declared triggers — the default declaration `["mention"]` must apply.
const defaultMentionAgent: AgentDescriptor = {
  id: "agt_general",
  name: "general",
  displayName: "General",
  description: "general purpose",
  visible: true,
}
// An agent whose explicit triggers EXCLUDE the mention trigger word.
const nonMentionAgent: AgentDescriptor = {
  id: "agt_noise",
  name: "noise",
  displayName: "Noise",
  description: "ci-only agent",
  visible: true,
  triggers: [{ event: "ci.failure" }],
}

const expectNoDropRowFor = (eventID: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const drops = yield* db.select().from(DeepAgentEventDropTable).all().pipe(Effect.orDie)
    expect(drops.filter((d) => d.event_id === eventID).length).toBe(0)
  })

describe("W0.4 mention router — explicit declaration dispatches", () => {
  const it = testEffect(makeLayer([declaringAgent]))

  it.effect("mention of an agent that declares `mention` dispatches (no no_match silent drop)", () =>
    Effect.gen(function* () {
      resetRecorder()
      resetReceipts()
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      const event = yield* bus.publish(mentionInput())
      const decision = yield* dispatcher.handle(event)
      expect(decision).toMatchObject({ type: "dispatch", priority: "normal" })
      expect((decision as { targets?: ReadonlyArray<{ id: string }> }).targets?.map((t) => t.id)).toEqual([
        "agt_auto",
      ])
      expect(recorded.length).toBe(1)
      expect(recorded[0]?.targets.map((t) => t.id)).toEqual(["agt_auto"])
      expect(receipted.length).toBe(0)
      // the pure router's no_match/dropped terminal path must never run for a mention: no event_dropped row.
      yield* expectNoDropRowFor(event.id)
      expect((yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)).length).toBe(0) // acked
    }),
  )
})

describe("W0.4 mention router — default declaration [\"mention\"]", () => {
  const it = testEffect(makeLayer([defaultMentionAgent]))

  it.effect("an agent WITHOUT declared triggers is mentionable by default (default [\"mention\"])", () =>
    Effect.gen(function* () {
      resetRecorder()
      resetReceipts()
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      const event = yield* bus.publish(
        mentionInput({ payload: { messageID: "msg_1", groupID: "grp_1", content: "@general hi", mentions: ["general"] } }),
      )
      const decision = yield* dispatcher.handle(event)
      expect(decision).toMatchObject({ type: "dispatch" })
      expect((decision as { targets?: ReadonlyArray<{ id: string }> }).targets?.map((t) => t.id)).toEqual([
        "agt_general",
      ])
      expect(recorded.length).toBe(1)
      expect(receipted.length).toBe(0)
      yield* expectNoDropRowFor(event.id)
    }),
  )
})

describe("W0.4 mention router — undeclared trigger receipt", () => {
  const it = testEffect(makeLayer([nonMentionAgent]))

  it.effect("mention of an agent whose triggers exclude `mention` writes agent_no_trigger_mention receipt", () =>
    Effect.gen(function* () {
      resetRecorder()
      resetReceipts()
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      const event = yield* bus.publish(
        mentionInput({ payload: { messageID: "msg_1", groupID: "grp_1", content: "@noise hi", mentions: ["noise"] } }),
      )
      const decision = yield* dispatcher.handle(event)
      // terminal, but NOT a no_match drop: the mention is receipted instead of silently discarded.
      expect(decision).toMatchObject({ type: "receipted", reason: "agent_no_trigger_mention" })
      expect(recorded.length).toBe(0)
      // the durable receipt carries the mentioned agent id + the initiating conversation context.
      expect(receipted).toEqual([
        {
          eventID: event.id,
          groupID: "grp_1",
          messageID: "msg_1",
          agentID: "agt_noise",
          agentNames: ["noise"],
          reason: "agent_no_trigger_mention",
        },
      ])
      yield* expectNoDropRowFor(event.id)
      expect((yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)).length).toBe(0) // receipted + acked, not retried
    }),
  )
})

describe("W0.4 mention router — nobody declares the trigger", () => {
  const it = testEffect(makeLayer([]))

  it.effect("no agent declares the mention trigger → generic receipt, never a silent no_match", () =>
    Effect.gen(function* () {
      resetRecorder()
      resetReceipts()
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      const event = yield* bus.publish(mentionInput())
      const decision = yield* dispatcher.handle(event)
      expect(decision).toMatchObject({ type: "receipted", reason: "no_declared_trigger" })
      expect(recorded.length).toBe(0)
      expect(receipted).toEqual([
        {
          eventID: event.id,
          groupID: "grp_1",
          messageID: "msg_1",
          agentID: undefined,
          agentNames: ["auto"],
          reason: "no_declared_trigger",
        },
      ])
      yield* expectNoDropRowFor(event.id)
      expect((yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)).length).toBe(0)
    }),
  )
})

describe("W0.4 mention router — default-ON consistency", () => {
  const it = testEffect(makeLayer([declaringAgent]))

  it.effect(
    "无 env 时事件 admission 默认 ON 等价: mention 不被静默丢弃（W0.1 runtimeDefaultsFromEnv 单点化接管前）",
    () =>
      Effect.gen(function* () {
        resetRecorder()
        resetReceipts()
        setNow(1_000)
        const previous = process.env.DEEPAGENT_CODE_EVENT_V2_ADMISSION
        // W0.1: 切换为 runtimeDefaultsFromEnv —— W0.1 在 runtime-defaults.ts 单点化
        // `eventV2Admission`（未设置/非 false → 默认 ON）。mention 路由器不读取该 env：无论它是否
        // 显式设置，mention 事件都走「dispatch 或回执」，绝不落入 no_match 静默丢弃。
        delete process.env.DEEPAGENT_CODE_EVENT_V2_ADMISSION
        try {
          const bus = yield* DeepAgentEventBus.Service
          const dispatcher = yield* EventDispatcher.Service
          const event = yield* bus.publish(mentionInput())
          const decision = yield* dispatcher.handle(event)
          expect(decision).toMatchObject({ type: "dispatch" })
          expect(recorded.length).toBe(1)
          expect(receipted.length).toBe(0)
          yield* expectNoDropRowFor(event.id)
        } finally {
          if (previous === undefined) delete process.env.DEEPAGENT_CODE_EVENT_V2_ADMISSION
          else process.env.DEEPAGENT_CODE_EVENT_V2_ADMISSION = previous
        }
      }),
  )
})

describe("W0.4 mention router — mentionless IM message keeps the pure router path", () => {
  const it = testEffect(makeLayer([]))

  it.effect("an im.message.created WITHOUT mentions keeps the existing no_match semantics (no overreach)", () =>
    Effect.gen(function* () {
      resetRecorder()
      resetReceipts()
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      const event = yield* bus.publish(mentionInput({ payload: { messageID: "msg_2", groupID: "grp_1", content: "hi", mentions: [] } }))
      const decision = yield* dispatcher.handle(event)
      expect(decision).toMatchObject({ type: "dropped", reason: "no_match" })
      expect(recorded.length).toBe(0)
      expect(receipted.length).toBe(0)
    }),
  )
})
