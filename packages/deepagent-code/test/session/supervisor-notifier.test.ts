import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { SupervisorNotifier } from "../../src/session/supervisor-notifier"
import { AgentPush } from "../../src/session/agent-push"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { WorkspaceConfig } from "@deepagent-code/core/deepagent/workspace-config"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { testEffect } from "../lib/effect"

// V4.0 §B2 (P2.8) — the SupervisorNotifier is the PRODUCTION caller of AgentPush.push. Verifies: it
// pushes a supervisor notification for human-attention terminal events when v4AgentPushEnabled is ON (and
// pushes NOTHING when OFF), targets the workspace's project/system groups, and skips non-notifiable events.
// The AgentPush policy internals (rate/quiet/scrub) are covered by agent-push.test.ts; here we assert the
// bus→push WIRING with the real AgentPush runtime behind it.

let clock = 1_000_000
const now = () => clock
const setNow = (t: number) => {
  clock = t
}

const database = Database.layerFromPath(":memory:")

const makeLayer = (opts: { flag: boolean }) => {
  const repo = IMRepositoryLive.pipe(Layer.provideMerge(database))
  const busLayer = DeepAgentEventBus.layerWith({ now }).pipe(Layer.provideMerge(database))
  const cfg = WorkspaceConfig.layerWith({ now }).pipe(Layer.provideMerge(database))
  const flagLayer = RuntimeFlags.layer({ v4AgentPushEnabled: opts.flag })
  // the real AgentPush runtime (not a stub) so the wiring is proven end-to-end.
  const push = AgentPush.layerWith({ now }).pipe(
    Layer.provide(repo),
    Layer.provide(flagLayer),
    Layer.provide(cfg),
  )
  const notifier = SupervisorNotifier.layerWith({ runLoop: false }).pipe(
    Layer.provide(push),
    Layer.provide(busLayer),
    Layer.provide(flagLayer),
    Layer.provide(database),
  )
  return Layer.mergeAll(notifier, push, repo, busLayer, cfg, flagLayer, database)
}

// seed a project group in wrk_1 so the default resolver finds a target; returns the group id.
const seedGroup = () =>
  Effect.gen(function* () {
    const repo = yield* IMRepository
    const group = yield* repo.createGroup({
      workspaceID: "wrk_1",
      type: "project",
      name: "team",
      createdBy: "user_1",
    })
    return group.id
  })

const publishNeedsHuman = (over?: Partial<DeepAgentEvent.PublishInput>) =>
  Effect.gen(function* () {
    const bus = yield* DeepAgentEventBus.Service
    return yield* bus.publish({
      type: LMNEvents.AGENT_TASK_NEEDS_HUMAN,
      source: "system",
      workspaceID: "wrk_1",
      priority: "high",
      idempotencyKey: `nh-${Math.random()}`,
      payload: { reason: "exceeded autonomy ceiling" },
      ...over,
    })
  })

// register the notifier's consumer group so publish records a durable pending delivery for it.
const subscribeNotifier = Effect.gen(function* () {
  const bus = yield* DeepAgentEventBus.Service
  yield* bus
    .subscribe({ group: SupervisorNotifier.NOTIFY_GROUP })
    .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
  yield* Effect.yieldNow
})

const isPending = (eventID: DeepAgentEvent.ID) =>
  Effect.gen(function* () {
    const bus = yield* DeepAgentEventBus.Service
    const due = yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)
    return due.some((d) => d.eventID === eventID && d.subscriptionGroup === SupervisorNotifier.NOTIFY_GROUP)
  })

describe("SupervisorNotifier (flag ON)", () => {
  const it = testEffect(makeLayer({ flag: true }))

  it.effect("§B2 pushes a supervisor notification for agent.task.needs_human", () =>
    Effect.gen(function* () {
      setNow(1_000_000)
      const groupID = yield* seedGroup()
      const notifier = yield* SupervisorNotifier.Service
      const repo = yield* IMRepository

      const event = yield* publishNeedsHuman()
      const attempted = yield* notifier.handle(event)
      expect(attempted).toBe(1)

      // a real IM message landed in the group, authored by the system pusher, carrying the reason.
      const page = yield* repo.listMessages({ groupID, limit: 10 })
      expect(page.messages.length).toBe(1)
      const msg = page.messages[0]
      expect(msg.senderType).toBe("agent")
      expect(msg.senderID).toBe(SupervisorNotifier.SYSTEM_PUSHER_AGENT_ID)
      expect(msg.content).toContain("exceeded autonomy ceiling")
    }),
  )

  it.effect("§B2 a panel.verdict of needs_human is notifiable; approve/revise are NOT", () =>
    Effect.gen(function* () {
      setNow(1_000_000)
      const groupID = yield* seedGroup()
      const notifier = yield* SupervisorNotifier.Service
      const repo = yield* IMRepository

      // an approve verdict is NOT human-facing → skipped (no push).
      const approve = yield* publishNeedsHuman({
        type: LMNEvents.PANEL_VERDICT,
        idempotencyKey: "v-approve",
        payload: { decision: "approve" },
      })
      expect(yield* notifier.handle(approve)).toBe(0)

      // a needs_human verdict IS → pushed.
      const escalate = yield* publishNeedsHuman({
        type: LMNEvents.PANEL_VERDICT,
        idempotencyKey: "v-escalate",
        payload: { decision: "needs_human", question: "risky migration" },
      })
      expect(yield* notifier.handle(escalate)).toBe(1)

      const page = yield* repo.listMessages({ groupID, limit: 10 })
      expect(page.messages.length).toBe(1) // only the needs_human verdict was pushed
      expect(page.messages[0].content).toContain("risky migration")
    }),
  )

  it.effect("§B2 a non-notifiable event (git.push) is acked without a push", () =>
    Effect.gen(function* () {
      setNow(1_000_000)
      const groupID = yield* seedGroup()
      const notifier = yield* SupervisorNotifier.Service
      const repo = yield* IMRepository

      const event = yield* publishNeedsHuman({ type: LMNEvents.GIT_PUSH, idempotencyKey: "g1", payload: {} })
      expect(yield* notifier.handle(event)).toBe(0)
      const page = yield* repo.listMessages({ groupID, limit: 10 })
      expect(page.messages.length).toBe(0)
    }),
  )

  it.effect("§A3 a dlq.alert (operational) IS notified to the operator, but is NOT an approval-queue type", () =>
    Effect.gen(function* () {
      setNow(1_000_000)
      const groupID = yield* seedGroup()
      const notifier = yield* SupervisorNotifier.Service
      const repo = yield* IMRepository

      const alert = yield* publishNeedsHuman({
        type: LMNEvents.DLQ_ALERT,
        idempotencyKey: "dlq-notify-1",
        payload: { deadEventID: "dae_x", subscriptionGroup: "router", reason: "exhausted retries", attempts: 3 },
      })
      // dlq.alert is notified (operator should be told about a dead-letter) …
      expect(yield* notifier.handle(alert)).toBe(1)
      const page = yield* repo.listMessages({ groupID, limit: 10 })
      expect(page.messages.length).toBe(1)
      expect(page.messages[0].content).toContain("dead-letter")
      // … but it is NOT an Approval-Queue candidate (operational notice, not a human-approval decision).
      expect(LMNEvents.shouldQueueForApproval({ type: LMNEvents.DLQ_ALERT, payload: {} })).toBe(false)
    }),
  )

  it.effect("§A3 a notifiable event with a target group is acked (delivery discharged)", () =>
    Effect.gen(function* () {
      setNow(1_000_000)
      yield* seedGroup()
      const notifier = yield* SupervisorNotifier.Service
      yield* subscribeNotifier
      const event = yield* publishNeedsHuman({ idempotencyKey: "ack-1" })
      expect(yield* isPending(event.id)).toBe(true) // pending pre-handle
      yield* notifier.handle(event)
      expect(yield* isPending(event.id)).toBe(false) // acked post-handle
    }),
  )

  it.effect("§B2 idempotent: re-handling the same event does NOT double-push", () =>
    Effect.gen(function* () {
      setNow(1_000_000)
      const groupID = yield* seedGroup()
      const notifier = yield* SupervisorNotifier.Service
      const repo = yield* IMRepository
      const event = yield* publishNeedsHuman({ idempotencyKey: "idem-1" })
      yield* notifier.handle(event)
      yield* notifier.handle(event) // re-drive (idempotent via AgentPush notify:<id>:<group> key)
      const page = yield* repo.listMessages({ groupID, limit: 10 })
      expect(page.messages.length).toBe(1) // exactly one message despite two handles
    }),
  )
})

describe("SupervisorNotifier (flag OFF)", () => {
  const it = testEffect(makeLayer({ flag: false }))

  it.effect("fail-closed: flag OFF → no push, event still acked", () =>
    Effect.gen(function* () {
      setNow(1_000_000)
      const groupID = yield* seedGroup()
      const notifier = yield* SupervisorNotifier.Service
      const repo = yield* IMRepository
      yield* subscribeNotifier
      const event = yield* publishNeedsHuman({ idempotencyKey: "off-1" })
      expect(yield* notifier.handle(event)).toBe(0)
      const page = yield* repo.listMessages({ groupID, limit: 10 })
      expect(page.messages.length).toBe(0) // nothing pushed
      expect(yield* isPending(event.id)).toBe(false) // but the delivery was still discharged
    }),
  )
})
