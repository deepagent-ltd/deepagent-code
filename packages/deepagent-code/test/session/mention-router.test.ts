import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { EventDispatcher } from "../../src/session/event-dispatcher"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { Scheduler } from "@deepagent-code/core/deepagent/scheduler"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentEventDropTable } from "@deepagent-code/core/deepagent/deepagent-event-sql"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMBroadcasterService, IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { MessageTable, NoTriggerMentionMetadata } from "@deepagent-code/core/im/sql"
import type { ServerEvent, IMWebSocketConnection } from "@deepagent-code/core/im/websocket"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { runtimeDefaultsFromEnv, EVENT_V2_ADMISSION_ENV } from "../../src/runtime-defaults"
import { testEffect } from "../lib/effect"
import { createRuntimeFeatureRegistry, type RuntimeFeatureRegistry } from "@deepagent-code/core/flag/runtime-features"

// W0.4 — @mention 路由修复与默认统一 (docs/core-v2.0-beta/v2.0-design.md W0.4).
//
// 背景：CLI 事件 V2 admission 默认 ON 时，IM @mention 发布 im.message.created 上总线；纯路由器按
// `triggers[].event` 匹配事件类型，而默认没有任何 agent 声明 IM 触发器 → `no_match` 终端静默
// 丢弃（无执行、无回执）。本套件验证 W0.4 修复（含审阅 P1-P11 修正）：
//   - mention 路由按「被点名的 agent」而非事件类型匹配（点名的 agent 就是授权目标）；
//   - 触发词声明默认 `["mention"]`（兼容 `im.mention`；`im.message.created` 是事件名，不走 mention
//     语义）：未声明 triggers 的 agent 默认可被 @mention；
//   - 未声明触发词 → durable 回执 `agent_no_trigger_mention`（含 agent id）+ `mention_no_trigger_receipt`
//     日志，绝无 no_match 终端丢弃；
//   - 混合提及（P8）：可派发名字 dispatch，未解析名字同样回执（不静默）；
//   - 门控矩阵（P1/P2，注记 4）：mention 分支仅当 V2 event admission ON 时接管 —— v4 ON ∧ admission
//     ON = dispatcher 全权（dispatch 或回执，legacy 跳过）；v4 ON ∧ admission OFF = 回退 legacy（本
//     分支跳过、不 dispatch 不回执，事件保持纯路由器路径）；v4 OFF = legacy 不变；
//   - 默认回执端口（P3/P7/P11）：真实 IMRepository 落库 + message_created 广播 + 重试幂等；
//   - 无 env 时事件 admission 默认 ON 的一致性（P10：真实断言 runtimeDefaultsFromEnv）。

// The mention branch gate reads DEEPAGENT_CODE_EVENT_V2_ADMISSION (the same predicate the dispatch port
// uses). These tests pin the dispatcher side of the matrix: the mention branch is ON for the whole file,
// and the P1 admission-OFF test flips it locally.
const savedAdmissionEnv = process.env[EVENT_V2_ADMISSION_ENV]
beforeAll(() => {
  process.env[EVENT_V2_ADMISSION_ENV] = "true"
})
afterAll(() => {
  if (savedAdmissionEnv === undefined) delete process.env[EVENT_V2_ADMISSION_ENV]
  else process.env[EVENT_V2_ADMISSION_ENV] = savedAdmissionEnv
})

let clock = 0
const setNow = (t: number) => {
  clock = t
}
const now = () => clock
const admissionOff = createRuntimeFeatureRegistry(undefined, { [EVENT_V2_ADMISSION_ENV]: "false" })

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

const agentListLayer = (agents: AgentDescriptor[]) =>
  Layer.succeed(AgentListProviderService, {
    listAgents: () => Effect.succeed(agents),
    findByTrigger: () => Effect.succeed(agents),
    findByCapability: () => Effect.succeed([]),
  })

const flagsLayer = RuntimeFlags.layer({
  v4AgentPushEnabled: true,
  v4MultiAgentRuntime: true,
})

// Bus + scheduler + DB.
const coreLayer = () =>
  Layer.mergeAll(DeepAgentEventBus.layerWith({ now }), Scheduler.layerWith({ now })).pipe(
    Layer.provideMerge(Database.layerFromPath(":memory:")),
  )

const makeLayer = (agents: AgentDescriptor[], runtimeFeatures?: RuntimeFeatureRegistry) => {
  const core = coreLayer()
  const dispatcher = EventDispatcher.layerWith({
    dispatchPort: recordingPort,
    mentionReceiptPort: recordingReceiptPort,
    runLoops: false,
    now,
    ...(runtimeFeatures ? { runtimeFeatures } : {}),
  }).pipe(
    Layer.provide(core),
    Layer.provide(agentListLayer(agents)),
    Layer.provide(flagsLayer),
  )
  return Layer.mergeAll(dispatcher, core, flagsLayer)
}

// The DEFAULT receipt port (real IM-backed writer + broadcast) instead of the recording spy — used by the
// P3/P7/P11 default-port / idempotency / visible-wins / log-only tests.
const makeDefaultPortLayer = (agents: AgentDescriptor[]) => {
  const database = Database.layerFromPath(":memory:")
  const core = Layer.mergeAll(DeepAgentEventBus.layerWith({ now }), Scheduler.layerWith({ now })).pipe(
    Layer.provideMerge(database),
  )
  const imRepo = IMRepositoryLive.pipe(Layer.provideMerge(database))
  const dispatcher = EventDispatcher.layerWith({
    dispatchPort: recordingPort,
    runLoops: false,
    now,
  }).pipe(
    Layer.provide(core),
    Layer.provide(agentListLayer(agents)),
    Layer.provide(flagsLayer),
  )
  return Layer.mergeAll(dispatcher, core, flagsLayer, imRepo, IMBroadcasterLive)
}

const mentionInput = (over?: Partial<DeepAgentEvent.PublishInput>): DeepAgentEvent.PublishInput => ({
  type: LMNEvents.IM_MESSAGE_CREATED,
  source: "im",
  workspaceID: "wrk_1",
  payload: { messageID: "msg_1", groupID: "grp_1", content: "@auto hi", mentions: ["auto"] },
  ...over,
})

// IMMessage.metadata is a free-form JSON column typed `unknown | null` — narrow to the receipt shape for
// the filters below (the decode assertions use the core schema).
interface ReceiptMetaShape {
  type?: string
  agentID?: string
  messageID?: string
}
const asReceiptMeta = (m: { metadata?: unknown }): ReceiptMetaShape | null => {
  const md = m.metadata
  return md !== null && md !== undefined && typeof md === "object" ? (md as ReceiptMetaShape) : null
}

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
// P4 — the event-aligned alias declares the same @mention semantics.
const imMentionAgent: AgentDescriptor = {
  id: "agt_alias",
  name: "alias",
  displayName: "Alias",
  description: "agent declaring im.mention",
  visible: true,
  triggers: [{ event: "im.mention" }],
}
// P4 — `im.message.created` is the EVENT TYPE, not a mention trigger word: an agent declaring it routes
// by event type (pure router) and is NOT mentionable via @mention.
const eventTypeAgent: AgentDescriptor = {
  id: "agt_etype",
  name: "etype",
  displayName: "Event type",
  description: "agent declaring the bus event type",
  visible: true,
  triggers: [{ event: "im.message.created" }],
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

describe('W0.4 mention router — default declaration ["mention"]', () => {
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

describe("W0.4 mention router — P4 trigger-word convention", () => {
  const aliasIt = testEffect(makeLayer([imMentionAgent]))
  const eventIt = testEffect(makeLayer([eventTypeAgent]))

  aliasIt.effect("an agent declaring `{event:\"im.mention\"}` is mentionable (alias word)", () =>
    Effect.gen(function* () {
      resetRecorder()
      resetReceipts()
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      const event = yield* bus.publish(
        mentionInput({ payload: { messageID: "msg_1", groupID: "grp_1", content: "@alias hi", mentions: ["alias"] } }),
      )
      const decision = yield* dispatcher.handle(event)
      expect(decision).toMatchObject({ type: "dispatch" })
      expect((decision as { targets?: ReadonlyArray<{ id: string }> }).targets?.map((t) => t.id)).toEqual([
        "agt_alias",
      ])
      expect(recorded.length).toBe(1)
      expect(receipted.length).toBe(0)
      yield* expectNoDropRowFor(event.id)
    }),
  )

  eventIt.effect("an agent declaring `{event:\"im.message.created\"}` is NOT mentionable → receipt", () =>
    Effect.gen(function* () {
      resetRecorder()
      resetReceipts()
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      const event = yield* bus.publish(
        mentionInput({ payload: { messageID: "msg_1", groupID: "grp_1", content: "@etype hi", mentions: ["etype"] } }),
      )
      const decision = yield* dispatcher.handle(event)
      // `im.message.created` is the bus event type (pure-router trigger), NOT a mention trigger word —
      // so a mention of this agent receipts instead of dispatching via the mention branch.
      expect(decision).toMatchObject({ type: "receipted", reason: "agent_no_trigger_mention" })
      expect(recorded.length).toBe(0)
      expect(receipted).toEqual([
        {
          eventID: event.id,
          groupID: "grp_1",
          messageID: "msg_1",
          agentID: "agt_etype",
          agentNames: ["etype"],
          reason: "agent_no_trigger_mention",
        },
      ])
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

describe("W0.4 mention router — P8 mixed mentions", () => {
  const it = testEffect(makeLayer([declaringAgent]))

  it.effect("mentions [\"auto\",\"ghost\"] with auto dispatchable: dispatch auto AND receipt ghost (no silent unknown)", () =>
    Effect.gen(function* () {
      resetRecorder()
      resetReceipts()
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      const event = yield* bus.publish(
        mentionInput({ payload: { messageID: "msg_1", groupID: "grp_1", content: "@auto @ghost hi", mentions: ["auto", "ghost"] } }),
      )
      const decision = yield* dispatcher.handle(event)
      expect(decision).toMatchObject({ type: "dispatch" })
      expect((decision as { targets?: ReadonlyArray<{ id: string }> }).targets?.map((t) => t.id)).toEqual([
        "agt_auto",
      ])
      expect(recorded.length).toBe(1)
      // the unknown name is NOT silently dropped: it gets the generic no-declarer receipt.
      expect(receipted).toEqual([
        {
          eventID: event.id,
          groupID: "grp_1",
          messageID: "msg_1",
          agentID: undefined,
          agentNames: ["ghost"],
          reason: "no_declared_trigger",
        },
      ])
      // the dispatch path never uses the no_match terminal drop either.
      yield* expectNoDropRowFor(event.id)
    }),
  )
})

describe("W0.4 mention router — P1/P2 admission gate", () => {
  const it = testEffect(makeLayer([declaringAgent], admissionOff))

  it.effect("v4 ON + admission OFF: mention branch skipped → pure-router fallback (no dispatch, no receipt)", () =>
    Effect.gen(function* () {
      resetRecorder()
      resetReceipts()
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      const event = yield* bus.publish(mentionInput())
      const decision = yield* dispatcher.handle(event)
      // Design note 4: v4 ON ∧ admission OFF = explicit fall-back-to-legacy — the dispatcher's mention
      // branch does NOT take over (the legacy synchronous executor in the IM handler runs instead).
      // The event keeps the pre-W0.4 pure-router path (no_match for this registry — no dispatch/receipt).
      expect(decision).toMatchObject({ type: "dropped", reason: "no_match" })
      expect(recorded.length).toBe(0)
      expect(receipted.length).toBe(0)
    }),
  )
})

describe("W0.4 — P10 default-ON consistency", () => {
  test("无 env 时事件 admission 默认 ON（W0.1 runtimeDefaultsFromEnv 单点化）", () => {
    expect(runtimeDefaultsFromEnv({}).eventV2Admission).toBe(true)
  })
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

// ---------------------------------------------------------------------------
// P3 / P7 / P11 — the DEFAULT receipt port against the real IMRepository + broadcaster.
// ---------------------------------------------------------------------------

describe("W0.4/P11 — default receipt port end-to-end (real IMRepository + broadcast)", () => {
  const it = testEffect(makeDefaultPortLayer([nonMentionAgent]))

  it.effect("receipt message persists with metadata.type = agent_no_trigger_mention (JSON round-trip) and broadcasts message_created", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      const repo = yield* IMRepository
      const broadcaster = yield* IMBroadcasterService
      // The IM message insert is FK-constrained on im_groups — seed the initiating group (as the real
      // IM handler's group would exist).
      const group = yield* repo.createGroup({ workspaceID: "wrk_1", type: "project", name: "g", createdBy: "user_1" })
      // A fake WS client in the group — the real broadcaster's delivery seam (P3 observation).
      const sent: ServerEvent[] = []
      const conn: IMWebSocketConnection = {
        groupID: group.id,
        userID: "user_1",
        workspaceID: "wrk_1",
        send: (event) => sent.push(event),
        close: () => {},
      }
      broadcaster.register(conn)

      const event = yield* bus.publish(
        mentionInput({ payload: { messageID: "msg_1", groupID: group.id, content: "@noise hi", mentions: ["noise"] } }),
      )
      const decision = yield* dispatcher.handle(event)
      expect(decision).toMatchObject({ type: "receipted", reason: "agent_no_trigger_mention" })

      // Durable IM message in the group, metadata decodable back through the core schema (a real JSON
      // round-trip through the DB column) and carrying the initiating context.
      const page = yield* repo.listMessages({ groupID: group.id, limit: 50 })
      const receipts = page.messages.filter((m) => asReceiptMeta(m)?.type === "agent_no_trigger_mention")
      expect(receipts.length).toBe(1)
      const receipt = receipts[0]!
      const decoded = Schema.decodeUnknownSync(NoTriggerMentionMetadata)(receipt.metadata)
      expect(decoded.type).toBe("agent_no_trigger_mention")
      expect(decoded).toMatchObject({
        agentID: "agt_noise",
        agentNames: ["noise"],
        eventID: event.id,
        messageID: "msg_1",
      })
      expect(receipt.senderID).toBe("agt_noise")

      // P3 — the receipt reaches live clients (mirrors agent-orchestrator's broadcastAgentResult shape).
      const created = sent.filter((e) => e.type === "message_created")
      expect(created.length).toBe(1)
      const data = created[0]!.data as { id: string; content: string; metadata: { type?: string } | null }
      expect(data.id).toBe(receipt.id)
      expect(data.content).toContain("未声明")
      expect(data.metadata?.type).toBe("agent_no_trigger_mention")
    }),
  )

  it.effect("P7 — retry re-drive of the same mention does NOT double-write the receipt", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      const repo = yield* IMRepository
      const group = yield* repo.createGroup({ workspaceID: "wrk_1", type: "project", name: "g", createdBy: "user_1" })
      const event = yield* bus.publish(
        mentionInput({ payload: { messageID: "msg_1", groupID: group.id, content: "@noise hi", mentions: ["noise"] } }),
      )
      // The retry pump re-runs handle() on the same event (at-least-once delivery); the ack on the first
      // run doesn't prevent a pathological/redriven path from re-handling — the default port dedups.
      expect(yield* dispatcher.handle(event)).toMatchObject({ type: "receipted", reason: "agent_no_trigger_mention" })
      expect(yield* dispatcher.handle(event)).toMatchObject({ type: "receipted", reason: "agent_no_trigger_mention" })
      const page = yield* repo.listMessages({ groupID: group.id, limit: 50 })
      expect(
        page.messages.filter(
          (m) =>
            asReceiptMeta(m)?.type === "agent_no_trigger_mention" && asReceiptMeta(m)?.agentID === "agt_noise",
        ).length,
      ).toBe(1)
    }),
  )

  it.effect("P11 — log-only fallback: no groupID writes nothing and broadcasts nothing (never a silent no-op write)", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      const broadcaster = yield* IMBroadcasterService
      const { db } = yield* Database.Service
      const sent: ServerEvent[] = []
      const conn: IMWebSocketConnection = {
        groupID: "grp_1",
        userID: "user_1",
        workspaceID: "wrk_1",
        send: (event) => sent.push(event),
        close: () => {},
      }
      broadcaster.register(conn)

      const event = yield* bus.publish(
        mentionInput({ payload: { messageID: "msg_1", content: "@noise hi", mentions: ["noise"] } }),
      )
      const decision = yield* dispatcher.handle(event)
      expect(decision).toMatchObject({ type: "receipted", reason: "agent_no_trigger_mention" })
      // no durable write (no initiating conversation to receipt into) and no broadcast — the receipt
      // surface is the mention_no_trigger_receipt log line (the "log-only" fallback).
      expect(yield* db.select().from(MessageTable).all().pipe(Effect.orDie)).toEqual([])
      expect(sent.length).toBe(0)
    }),
  )
})

describe("W0.4/P11 — visible agent wins over same-name hidden builtin", () => {
  const it = testEffect(makeDefaultPortLayer([
    {
      id: "agt_auto_hidden",
      name: "auto",
      displayName: "Auto (hidden)",
      description: "hidden builtin",
      visible: false,
      triggers: [{ event: "mention" }],
    },
    declaringAgent,
  ]))

  it.effect("mentioning a name with a visible + a hidden agent dispatches ONLY the visible one, no receipt for the hidden", () =>
    Effect.gen(function* () {
      resetRecorder()
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const dispatcher = yield* EventDispatcher.Service
      const repo = yield* IMRepository
      const event = yield* bus.publish(mentionInput())
      const decision = yield* dispatcher.handle(event)
      expect(decision).toMatchObject({ type: "dispatch" })
      expect((decision as { targets?: ReadonlyArray<{ id: string }> }).targets?.map((t) => t.id)).toEqual([
        "agt_auto",
      ])
      expect(recorded.length).toBe(1)
      expect(recorded[0]?.targets.map((t) => t.id)).toEqual(["agt_auto"])
      // the hidden builtin gets NO receipt (it is not a user-facing name; the visible agent owns it).
      expect(yield* repo.listMessages({ groupID: "grp_1", limit: 50 })).toMatchObject({ messages: [] })
    }),
  )
})
