import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { MultiAgentRuntime } from "../../src/session/multi-agent-runtime"
import type { SubagentTurnRunner } from "../../src/session/goal-loop-wiring"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { Database } from "@deepagent-code/core/database/database"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import { testEffect } from "../lib/effect"

// V4.0 §C Multi-Agent Runtime — verifies the coordination pipeline (partition → gate → arbitrate → run
// → emit) with a fake runner + fake registry. The pure decisions are covered by core tests.

let clock = 0
const now = () => clock
const setNow = (t: number) => {
  clock = t
}

// record which agents the runner was asked to run.
let ran: string[] = []
let runnerOk = true
const resetRunner = () => {
  ran = []
  runnerOk = true
}
const fakeRunner: SubagentTurnRunner = (input) =>
  Effect.sync(() => {
    ran.push(input.agentType)
    return { ok: runnerOk, structured: undefined, text: "done", tokensUsed: 0, cost: 0 }
  })

// registry knobs per-test.
let registry: AgentDescriptor[] = []
const setRegistry = (agents: AgentDescriptor[]) => {
  registry = agents
}
const fakeAgentList = Layer.succeed(AgentListProviderService, {
  listAgents: () => Effect.succeed(registry),
  findByTrigger: () => Effect.succeed([]),
  findByCapability: () => Effect.succeed([]),
})

const agent = (id: string, caps: string[], autonomy?: AgentDescriptor["autonomy"]): AgentDescriptor => ({
  id,
  name: id,
  displayName: id,
  visible: true,
  capabilities: caps,
  ...(autonomy ? { autonomy } : {}),
})

const makeLayer = (opts?: Partial<MultiAgentRuntime.LayerOptions>) => {
  const database = Database.layerFromPath(":memory:")
  // bus + approval queue share the one in-memory DB so autonomy escalations MAR offers are queued.
  const core = Layer.mergeAll(DeepAgentEventBus.layerWith({ now }), ApprovalQueue.layerWith({ now })).pipe(
    Layer.provideMerge(database),
  )
  const runtime = MultiAgentRuntime.layerWith({ runner: fakeRunner, ...opts }).pipe(
    Layer.provide(core),
    Layer.provide(fakeAgentList),
  )
  return Layer.mergeAll(runtime, core)
}

const event = (over?: Partial<DeepAgentEvent.Event>): DeepAgentEvent.Event => ({
  id: DeepAgentEvent.ID.create(1_000),
  type: "ci.failure",
  source: "ci",
  workspaceID: "wrk_1",
  idempotencyKey: "k",
  priority: "normal",
  createdAt: 1_000,
  payload: {},
  ...over,
})

describe("MultiAgentRuntime.coordinate", () => {
  const it = testEffect(makeLayer())

  it.effect("§C runs each subtask against a capable, autonomy+security-cleared agent; emits coordination events", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      // ci.failure partitions into code_edit (level_2) + test_run (level_2); one agent covers both.
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      const runtime = yield* MultiAgentRuntime.Service
      const bus = yield* DeepAgentEventBus.Service
      const summary = yield* runtime.coordinate(event({ payload: { files: ["src/a.ts"] } }))
      expect(summary.outcomes.map((o) => o.status)).toEqual(["completed", "completed"])
      expect(ran).toEqual(["fixer", "fixer"])
      // §C4 coordination events landed on the bus (started + completed per subtask).
      const coord = yield* bus.recentByType({ type: "agent.task.started", windowMs: Number.MAX_SAFE_INTEGER, now: 1_000 })
      expect(coord.length).toBe(2)
      const done = yield* bus.recentByType({ type: "agent.task.completed", windowMs: Number.MAX_SAFE_INTEGER, now: 1_000 })
      expect(done.length).toBe(2)
    }),
  )

  it.effect("§C2 blocks a subtask with no capable agent (agent.task.blocked)", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      setRegistry([agent("tester", ["test_run"], "level_2")]) // no code_edit agent
      const runtime = yield* MultiAgentRuntime.Service
      const summary = yield* runtime.coordinate(event())
      const codeEdit = summary.outcomes.find((o) => o.capability === "code_edit")
      expect(codeEdit?.status).toBe("blocked")
      expect(codeEdit?.reason).toBe("no_capable_agent")
      expect(ran).not.toContain("code_edit")
    }),
  )

  it.effect("§D autonomy gate: an agent below the subtask's required level is blocked, never run", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      // code_edit needs level_2 but this agent is capped at level_1 → blocked.
      setRegistry([agent("weak", ["code_edit", "test_run"], "level_1")])
      const runtime = yield* MultiAgentRuntime.Service
      const summary = yield* runtime.coordinate(event())
      expect(summary.outcomes.every((o) => o.status === "blocked")).toBe(true)
      expect(summary.outcomes[0].reason).toContain("autonomy")
      expect(ran.length).toBe(0)
    }),
  )

  it.effect("§D an autonomy-exceeds-ceiling block is ESCALATED to the human Approval Queue (not dropped)", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      setRegistry([agent("weak", ["code_edit", "test_run"], "level_1")]) // below the required level → blocked
      const runtime = yield* MultiAgentRuntime.Service
      yield* runtime.coordinate(event())
      // the gated subtask must surface for a human, not silently vanish.
      const queue = yield* ApprovalQueue.Service
      const pending = yield* queue.listPending("wrk_1")
      expect(pending.length).toBeGreaterThan(0)
      expect(pending.some((p) => p.eventType === "agent.task.needs_human")).toBe(true)
    }),
  )

  it.effect("§C3 dependency chain does NOT self-conflict (fix→test share scope but are serialized)", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      // ci.failure: test_run dependsOn code_edit; both share the event's file scope. Because they're
      // DAG-serialized (not concurrent), the arbiter must NOT defer the dependent subtask.
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      const runtime = yield* MultiAgentRuntime.Service
      const summary = yield* runtime.coordinate(event({ payload: { files: ["src/x.ts"] } }))
      expect(summary.outcomes.map((o) => o.status)).toEqual(["completed", "completed"])
    }),
  )

  it.effect("§C monitor.alert chain (diagnose → propose-fix) completes without self-conflict", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      setRegistry([agent("ops", ["diagnose", "code_edit"], "level_2")])
      const runtime = yield* MultiAgentRuntime.Service
      const summary = yield* runtime.coordinate(
        event({ type: "monitor.alert", source: "monitor", payload: { files: ["src/y.ts"] } }),
      )
      expect(summary.outcomes.map((o) => o.status)).toEqual(["completed", "completed"])
      expect(ran).toEqual(["ops", "ops"])
    }),
  )
})

describe("MultiAgentRuntime security layer-2 fail", () => {
  const it = testEffect(makeLayer({ actorHasPermission: () => Effect.succeed(false) }))

  it.effect("§E1 fail-closed: actor without permission blocks every subtask (security:actor_permission)", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      const runtime = yield* MultiAgentRuntime.Service
      const summary = yield* runtime.coordinate(event())
      expect(summary.outcomes.every((o) => o.status === "blocked")).toBe(true)
      expect(summary.outcomes[0].reason).toBe("security:actor_permission")
      expect(ran.length).toBe(0)
    }),
  )
})

describe("MultiAgentRuntime runner failure", () => {
  const it = testEffect(makeLayer())

  it.effect("a failing runner turn → subtask blocked (runner_failed), marks unfinished for retry", () =>
    Effect.gen(function* () {
      resetRunner()
      runnerOk = false
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      const runtime = yield* MultiAgentRuntime.Service
      const summary = yield* runtime.coordinate(event())
      expect(summary.outcomes[0].status).toBe("blocked")
      expect(summary.outcomes[0].reason).toBe("runner_failed")
      expect(summary.hasUnfinished).toBe(true) // → dispatch fails → bus retries
    }),
  )
})

describe("MultiAgentRuntime DAG + idempotency + retry semantics", () => {
  const it = testEffect(makeLayer())

  it.effect("§C2 DAG gate: a dependent is blocked (dependency_not_met) when its dep can't run", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      // ci.failure: test_run dependsOn code_edit. No code_edit-capable agent → fix blocked → test must
      // NOT run against a fix that never happened.
      setRegistry([agent("tester", ["test_run"], "level_2")])
      const runtime = yield* MultiAgentRuntime.Service
      const summary = yield* runtime.coordinate(event())
      const test = summary.outcomes.find((o) => o.capability === "test_run")
      expect(test?.status).toBe("blocked")
      expect(test?.reason).toBe("dependency_not_met")
      expect(ran).toEqual([]) // nothing ran
      expect(summary.hasUnfinished).toBe(true)
    }),
  )

  it.effect("idempotent: re-coordinating the same event does NOT re-run already-started subtasks", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      const runtime = yield* MultiAgentRuntime.Service
      const ev = event({ idempotencyKey: "idem-1" }) // SAME event object (same id) across both passes
      yield* runtime.coordinate(ev)
      expect(ran).toEqual(["fixer", "fixer"])
      // second pass over the SAME event id → started markers already on the bus → skip re-execution.
      const again = yield* runtime.coordinate(ev)
      expect(ran).toEqual(["fixer", "fixer"]) // unchanged — no duplicate runner calls
      expect(again.outcomes.every((o) => o.status === "completed")).toBe(true)
    }),
  )

  it.effect("dispatch fails (→ nack) when coordination is unfinished", () =>
    Effect.gen(function* () {
      resetRunner()
      runnerOk = false
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      const runtime = yield* MultiAgentRuntime.Service
      const exit = yield* runtime
        .dispatch({ event: event(), priority: "normal", targets: [] })
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure") // dispatcher will nack
    }),
  )

  it.effect("dispatch succeeds (→ ack) when every subtask reaches a terminal state", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      const runtime = yield* MultiAgentRuntime.Service
      const exit = yield* runtime
        .dispatch({ event: event(), priority: "normal", targets: [] })
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Success")
    }),
  )
})

describe("MultiAgentRuntime registry failure", () => {
  // a registry provider that FAILS (transient) — coordinate must fail (→ nack), not fail-open to [].
  const failingAgentList = Layer.succeed(AgentListProviderService, {
    listAgents: () => Effect.fail(new Error("registry down")),
    findByTrigger: () => Effect.succeed([]),
    findByCapability: () => Effect.succeed([]),
  })
  const database = Database.layerFromPath(":memory:")
  const core = Layer.mergeAll(DeepAgentEventBus.layerWith({ now }), ApprovalQueue.layerWith({ now })).pipe(
    Layer.provideMerge(database),
  )
  const layer = Layer.mergeAll(
    MultiAgentRuntime.layerWith({ runner: fakeRunner }).pipe(Layer.provide(core), Layer.provide(failingAgentList)),
    core,
  )
  const it = testEffect(layer)

  it.effect("§E1 fail-closed: a registry lookup error fails coordinate (bus retries), not fail-open drop", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      const runtime = yield* MultiAgentRuntime.Service
      const exit = yield* runtime.coordinate(event()).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(ran).toEqual([])
    }),
  )
})
