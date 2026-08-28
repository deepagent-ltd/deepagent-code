import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { PanelConveneConsumer } from "../../src/panel/panel-convene-consumer"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { Database } from "@deepagent-code/core/database/database"
import type { PanelVerdict } from "../../src/agent/schema/panel"
import { testEffect } from "../lib/effect"

// V4.0 §M — the PanelConveneConsumer's ROUTING behavior: flag gate, policy gate, panel-port driving,
// panel.verdict publish, Approval-Queue routing, delivery discharge, and transient-failure nack. The
// panel engine (arbiter/orchestrator) is covered elsewhere; here we verify the bus→panel bridge with a
// deterministic fake PanelConvenePort (no LLM, no session).

let clock = 0
const now = () => clock
const setNow = (t: number) => {
  clock = t
}

// A fake verdict factory — the port returns whatever decision the test wants.
const verdictOf = (decision: PanelVerdict["decision"]): PanelVerdict => ({
  decision,
  dissent: [],
  evidence: ["auto-convene evidence"],
  confidence: 0.9,
  rounds: 1,
})

// Records every call the fake port receives so a test can assert convene-count (idempotency).
const makeFakePort = (decision: PanelVerdict["decision"] | "fail") => {
  const calls: PanelConveneConsumer.PanelConveneInput[] = []
  const port: PanelConveneConsumer.PanelConvenePort = (input) => {
    calls.push(input)
    return decision === "fail"
      ? Effect.fail(new Error("panel run blew up"))
      : Effect.succeed(verdictOf(decision))
  }
  return { port, calls }
}

const database = Database.layerFromPath(":memory:")

// Build the full consumer layer with an injected fake port + a chosen flag value. runLoop:false → drive
// handle()/pumpRetries() directly for determinism.
const makeLayer = (opts: { port: PanelConveneConsumer.PanelConvenePort; flag: boolean }) => {
  const busLayer = DeepAgentEventBus.layerWith({ now }).pipe(Layer.provideMerge(database))
  const queueLayer = ApprovalQueue.layerWith({ now }).pipe(Layer.provideMerge(database))
  const flagLayer = RuntimeFlags.layer({ v4PanelAutoConvene: opts.flag })
  return PanelConveneConsumer.layerWith({ convene: opts.port, runLoop: false }).pipe(
    Layer.provideMerge(Layer.mergeAll(busLayer, queueLayer, flagLayer)),
  )
}

// A high-risk event that the DEFAULT_RULES classify as convene-worthy (security alert).
const publishSecurityAlert = (over?: Partial<DeepAgentEvent.PublishInput>) =>
  Effect.gen(function* () {
    const bus = yield* DeepAgentEventBus.Service
    return yield* bus.publish({
      type: "monitor.alert",
      source: "monitor",
      workspaceID: "wrk_1",
      idempotencyKey: `alert-${Math.random()}`,
      payload: { category: "security", summary: "suspicious login spike" },
      ...over,
    })
  })

// A live grouped subscriber so `publish` records a durable pending delivery for panel-convener.
const subscribeConvener = Effect.gen(function* () {
  const bus = yield* DeepAgentEventBus.Service
  yield* bus
    .subscribe({ group: PanelConveneConsumer.CONVENE_GROUP })
    .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
  yield* Effect.yieldNow
})

const isPending = (eventID: DeepAgentEvent.ID) =>
  Effect.gen(function* () {
    const bus = yield* DeepAgentEventBus.Service
    const due = yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)
    return due.some((d) => d.eventID === eventID && d.subscriptionGroup === PanelConveneConsumer.CONVENE_GROUP)
  })

describe("PanelConveneConsumer.handle (§M flag OFF)", () => {
  const off = makeLayer({ port: makeFakePort("needs_human").port, flag: false })
  const it = testEffect(off)

  it.effect("flag off → acks + does NOT convene (no verdict published)", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const consumer = yield* PanelConveneConsumer.Service
      yield* subscribeConvener
      const ev = yield* publishSecurityAlert()
      expect(yield* isPending(ev.id)).toBe(true) // owed before handle
      const decision = yield* consumer.handle(ev)
      expect(decision).toBeNull() // skipped
      // no panel.verdict was published (nothing convened).
      const verdicts = yield* bus.recentByType({
        type: LMNEvents.PANEL_VERDICT,
        workspaceID: "wrk_1",
        windowMs: Number.MAX_SAFE_INTEGER,
      })
      expect(verdicts.length).toBe(0)
      // delivery discharged (acked) → no orphaned pending row.
      expect(yield* isPending(ev.id)).toBe(false)
    }),
  )
})

describe("PanelConveneConsumer.handle (§M flag ON)", () => {
  describe("convene → needs_human", () => {
    const fake = makeFakePort("needs_human")
    const it = testEffect(makeLayer({ port: fake.port, flag: true }))

    it.effect("publishes panel.verdict + offers a needs_human verdict to the Approval Queue", () =>
      Effect.gen(function* () {
        setNow(1_000)
        const bus = yield* DeepAgentEventBus.Service
        const queue = yield* ApprovalQueue.Service
        const consumer = yield* PanelConveneConsumer.Service
        yield* subscribeConvener
        const ev = yield* publishSecurityAlert()

        const decision = yield* consumer.handle(ev)
        expect(decision).toBe("needs_human")

        // a panel.verdict was published, chained to the trigger with the deterministic idempotencyKey.
        const verdicts = yield* bus.recentByType({
          type: LMNEvents.PANEL_VERDICT,
          workspaceID: "wrk_1",
          windowMs: Number.MAX_SAFE_INTEGER,
        })
        expect(verdicts.length).toBe(1)
        const verdict = verdicts[0]!
        expect(verdict.causationID).toBe(ev.id)
        expect(verdict.correlationID).toBe(ev.id)
        expect(verdict.idempotencyKey).toBe(`panel:${ev.id}`)
        expect((verdict.payload as { decision?: string }).decision).toBe("needs_human")
        expect((verdict.payload as { riskClass?: string }).riskClass).toBe("security")

        // §D2: the needs_human verdict is now a PENDING approval item.
        const pending = yield* queue.listPending("wrk_1")
        expect(pending.length).toBe(1)
        expect(pending[0]!.eventType).toBe(LMNEvents.PANEL_VERDICT)
        expect(pending[0]!.eventID).toBe(verdict.id)

        // the trigger delivery is discharged (acked).
        expect(yield* isPending(ev.id)).toBe(false)
      }),
    )

    it.effect("idempotent: a second handle of the same event does NOT re-convene or double-queue", () =>
      Effect.gen(function* () {
        setNow(2_000)
        const bus = yield* DeepAgentEventBus.Service
        const queue = yield* ApprovalQueue.Service
        const consumer = yield* PanelConveneConsumer.Service
        const before = fake.calls.length
        const ev = yield* publishSecurityAlert()
        yield* consumer.handle(ev)
        yield* consumer.handle(ev) // re-delivery (retry pump / crash recovery)
        // the port ran exactly once for this event (started-guard).
        const callsForEvent = fake.calls.slice(before).filter((c) => c.event.id === ev.id)
        expect(callsForEvent.length).toBe(1)
        // exactly one verdict + one pending item for this event.
        const verdicts = yield* bus.recentByType({
          type: LMNEvents.PANEL_VERDICT,
          workspaceID: "wrk_1",
          windowMs: Number.MAX_SAFE_INTEGER,
        })
        expect(verdicts.filter((v) => v.causationID === ev.id).length).toBe(1)
        const pending = yield* queue.listPending("wrk_1")
        expect(pending.filter((p) => p.correlationID === ev.id).length).toBe(1)
      }),
    )
  })

  describe("convene → approve (autonomously resolved)", () => {
    const fake = makeFakePort("approve")
    const it = testEffect(makeLayer({ port: fake.port, flag: true }))

    it.effect("publishes panel.verdict but does NOT queue an approve verdict", () =>
      Effect.gen(function* () {
        setNow(1_000)
        const bus = yield* DeepAgentEventBus.Service
        const queue = yield* ApprovalQueue.Service
        const consumer = yield* PanelConveneConsumer.Service
        const ev = yield* publishSecurityAlert()
        const decision = yield* consumer.handle(ev)
        expect(decision).toBe("approve")
        // published…
        const verdicts = yield* bus.recentByType({
          type: LMNEvents.PANEL_VERDICT,
          workspaceID: "wrk_1",
          windowMs: Number.MAX_SAFE_INTEGER,
        })
        expect(verdicts.length).toBe(1)
        // …but NOT queued (shouldQueueForApproval only queues needs_human).
        const pending = yield* queue.listPending("wrk_1")
        expect(pending.length).toBe(0)
      }),
    )
  })

  describe("policy skip (no risk match)", () => {
    const fake = makeFakePort("needs_human")
    const it = testEffect(makeLayer({ port: fake.port, flag: true }))

    it.effect("a low-risk event acks WITHOUT convening (no verdict, delivery discharged)", () =>
      Effect.gen(function* () {
        setNow(1_000)
        const bus = yield* DeepAgentEventBus.Service
        const consumer = yield* PanelConveneConsumer.Service
        yield* subscribeConvener
        // a plain im.message.created is not in DEFAULT_RULES → policy skip.
        const ev = yield* bus.publish({
          type: LMNEvents.IM_MESSAGE_CREATED,
          source: "im",
          workspaceID: "wrk_1",
          idempotencyKey: "im-1",
          payload: { text: "hello" },
        })
        const before = fake.calls.length
        const decision = yield* consumer.handle(ev)
        expect(decision).toBeNull()
        expect(fake.calls.length).toBe(before) // port never called
        const verdicts = yield* bus.recentByType({
          type: LMNEvents.PANEL_VERDICT,
          workspaceID: "wrk_1",
          windowMs: Number.MAX_SAFE_INTEGER,
        })
        expect(verdicts.length).toBe(0)
        expect(yield* isPending(ev.id)).toBe(false) // discharged
      }),
    )
  })

  describe("panel-port failure", () => {
    const fake = makeFakePort("fail")
    const it = testEffect(makeLayer({ port: fake.port, flag: true }))

    it.effect("a failed panel run is NACKED (delivery stays pending for retry, no verdict published)", () =>
      Effect.gen(function* () {
        setNow(1_000)
        const bus = yield* DeepAgentEventBus.Service
        const consumer = yield* PanelConveneConsumer.Service
        yield* subscribeConvener
        const ev = yield* publishSecurityAlert()
        const decision = yield* consumer.handle(ev)
        expect(decision).toBeNull()
        // no verdict fabricated on failure.
        const verdicts = yield* bus.recentByType({
          type: LMNEvents.PANEL_VERDICT,
          workspaceID: "wrk_1",
          windowMs: Number.MAX_SAFE_INTEGER,
        })
        expect(verdicts.length).toBe(0)
        // nacked → still owed (a retry will re-drive it). next_attempt_at is scheduled in the future,
        // so it is due at MAX_SAFE_INTEGER.
        expect(yield* isPending(ev.id)).toBe(true)
      }),
    )
  })
})
