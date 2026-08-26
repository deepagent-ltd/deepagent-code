import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import { MultiAgentRuntime } from "../../src/session/multi-agent-runtime"
import type { SubagentTurnRunner } from "../../src/session/goal-loop-wiring"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { Database } from "@deepagent-code/core/database/database"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { AgentExecution } from "@deepagent-code/core/deepagent/agent-execution"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { SecurityResolvers } from "@deepagent-code/core/deepagent/security-resolvers"
import { WorkspaceConfig } from "@deepagent-code/core/deepagent/workspace-config"
import { IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { FileLock } from "@deepagent-code/core/file-lock"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import { BUILTIN_AGENT_DESCRIPTORS } from "@deepagent-code/core/im/builtin-agents"
import { Agent } from "@/agent/agent"
import { ServerAgentListProviderLive } from "@/im/agent-executor-server"
import { InstanceStore } from "@/project/instance-store"
import { awaitWithTimeout, testEffect } from "../lib/effect"

// V4.0 §C Multi-Agent Runtime — verifies the coordination pipeline (partition → gate → arbitrate → run
// → emit) with a fake runner + fake registry. The pure decisions are covered by core tests.

let clock = 0
const now = () => clock
const setNow = (t: number) => {
  clock = t
}

// record which agents the runner was asked to run + the correlationID each turn carried (§F2 trace).
let ran: string[] = []
let runnerOk = true
let correlationIDs: (string | undefined)[] = []
let baseRefs: (string | undefined)[] = []
let writeIsolationRequirements: (boolean | undefined)[] = []
let runnerPrompts: string[] = []
let parentSessionIDs: (string | undefined)[] = []
// a stable synthetic child session id the fake runner "creates" (§F2 artifacts + trace stamping).
let runnerSessionCounter = 0
const resetRunner = () => {
  ran = []
  runnerOk = true
  correlationIDs = []
  baseRefs = []
  writeIsolationRequirements = []
  runnerPrompts = []
  parentSessionIDs = []
  runnerSessionCounter = 0
}
const fakeRunner: SubagentTurnRunner = (input) =>
  Effect.sync(() => {
    ran.push(input.agentType)
    correlationIDs.push(input.correlationID)
    baseRefs.push(input.baseRef)
    writeIsolationRequirements.push(input.requiresWriteIsolation)
    runnerPrompts.push(input.prompt)
    parentSessionIDs.push(input.parentSessionID)
    // mirror the real runners: a successful turn reports the child session it ran in (P1) so the
    // runtime can populate §F2 artifacts from it.
    const turn = ++runnerSessionCounter
    const sessionID = `ses_fake_${turn}`
    const continuationRef = input.requiresWriteIsolation ? `agent/fake-${turn}` : undefined
    return {
      ok: runnerOk,
      structured: undefined,
      text: "done",
      tokensUsed: 0,
      cost: 0,
      sessionID,
      ...(continuationRef ? { continuationRef, artifacts: [`git-ref:${continuationRef}`] } : {}),
    }
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

const agent = (
  id: string,
  caps: string[],
  autonomy?: AgentDescriptor["autonomy"],
  limits?: AgentDescriptor["limits"],
): AgentDescriptor => ({
  id,
  name: id,
  displayName: id,
  visible: true,
  capabilities: caps,
  ...(autonomy ? { autonomy } : {}),
  ...(limits ? { limits } : {}),
})

const makeLayer = (opts?: Partial<MultiAgentRuntime.LayerOptions>) => {
  const database = Database.layerFromPath(":memory:")
  // bus + approval queue share the one in-memory DB so autonomy escalations MAR offers are queued.
  const core = Layer.mergeAll(
    DeepAgentEventBus.layerWith({ now }),
    ApprovalQueue.layerWith({ now }),
    AgentExecution.layerWith({ now }),
  ).pipe(Layer.provideMerge(database))
  const runtime = Layer.unwrap(
    Effect.gen(function* () {
      const execution = yield* AgentExecution.Service
      return MultiAgentRuntime.layerWith({ runner: fakeRunner, execution, ...opts })
    }),
  ).pipe(Layer.provide(core), Layer.provide(fakeAgentList))
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
      const coord = yield* bus.recentByType({
        type: "agent.task.started",
        windowMs: Number.MAX_SAFE_INTEGER,
        now: 1_000,
      })
      expect(coord.length).toBe(2)
      const done = yield* bus.recentByType({
        type: "agent.task.completed",
        windowMs: Number.MAX_SAFE_INTEGER,
        now: 1_000,
      })
      expect(done.length).toBe(2)
    }),
  )

  it.effect("passes event facts to the model without leaking the routing directory", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      const runtime = yield* MultiAgentRuntime.Service
      yield* runtime.coordinate(
        event({
          payload: {
            directory: "/private/parent-checkout",
            files: ["src/a.ts"],
            failure: "expected 42, received -2",
          },
        }),
      )
      expect(runnerPrompts).toHaveLength(2)
      expect(runnerPrompts.every((prompt) => prompt.includes("expected 42, received -2"))).toBe(true)
      expect(runnerPrompts.every((prompt) => prompt.includes("src/a.ts"))).toBe(true)
      expect(runnerPrompts.every((prompt) => !prompt.includes("/private/parent-checkout"))).toBe(true)
      expect(runnerPrompts.every((prompt) => prompt.includes("repo-relative paths"))).toBe(true)
    }),
  )

  it.effect("§F2 threads the event's correlationID into each subtask's runner turn (trace back-half)", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      const runtime = yield* MultiAgentRuntime.Service
      yield* runtime.coordinate(event({ correlationID: "corr-abc", payload: { files: ["src/a.ts"] } }))
      // every turn the runner drove carried the triggering event's correlationID, so the child session it
      // creates (and thus the child's tool calls / message / PR) join back to the trigger's §F2 trace.
      expect(correlationIDs.length).toBe(2)
      expect(correlationIDs.every((c) => c === "corr-abc")).toBe(true)
    }),
  )

  it.effect("§F2 falls back to the event id when it carries no correlationID", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      const runtime = yield* MultiAgentRuntime.Service
      const ev = event({ payload: { files: ["src/a.ts"] } }) // no correlationID set
      yield* runtime.coordinate(ev)
      expect(correlationIDs.every((c) => c === ev.id)).toBe(true)
    }),
  )

  it.effect("§F2 agent.task.completed carries REAL artifacts (≥ the child sessionID), not a hardcoded []", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      const runtime = yield* MultiAgentRuntime.Service
      const bus = yield* DeepAgentEventBus.Service
      yield* runtime.coordinate(event({ payload: { files: ["src/a.ts"] } }))
      const done = yield* bus.recentByType({
        type: "agent.task.completed",
        windowMs: Number.MAX_SAFE_INTEGER,
        now: 1_000,
      })
      expect(done.length).toBe(2)
      // each completed event names the child session the turn ran in — a non-empty artifact the §F2 trace
      // + Oversight pivot on (not the old hardcoded []).
      for (const e of done) {
        const artifacts = (e.payload as { artifacts?: readonly string[] } | null)?.artifacts ?? []
        expect(artifacts.length).toBeGreaterThan(0)
        expect(artifacts.some((a) => a.startsWith("session:ses_fake_"))).toBe(true)
      }
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
      expect(writeIsolationRequirements).toEqual([true, true])
      expect(baseRefs).toEqual([undefined, "agent/fake-1"])
    }),
  )

  it.effect("hands only terminal durable refs to the event-owned PR collaboration boundary", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      const completed: Parameters<NonNullable<MultiAgentRuntime.LayerOptions["onEventCompleted"]>>[0][] = []
      const ev = event({ payload: { files: ["src/x.ts"] } })
      const summary = yield* Effect.gen(function* () {
        const runtime = yield* MultiAgentRuntime.Service
        return yield* runtime.coordinate(ev)
      }).pipe(
        Effect.provide(
          makeLayer({
            onEventCompleted: (input) => Effect.sync(() => completed.push(input)),
          }),
        ),
      )

      expect(summary.hasUnfinished).toBe(false)
      expect(completed).toHaveLength(1)
      expect(completed[0]?.turns).toHaveLength(1)
      expect(completed[0]?.turns[0]).toMatchObject({
        task: { capability: "test_run" },
        agentID: "fixer",
        sessionID: "ses_fake_2",
        continuationRef: "agent/fake-2",
      })
      expect(parentSessionIDs).toEqual([completed[0]?.parentSessionID, completed[0]?.parentSessionID])
      expect(completed[0]?.parentSessionID).toStartWith("ses_v4_")
    }),
  )

  it.effect("§C2 runs independent DAG nodes concurrently and waits for the wave before dependents", () =>
    Effect.gen(function* () {
      setNow(1_000)
      setRegistry([
        agent("left", ["left"], "level_1"),
        agent("right", ["right"], "level_1"),
        agent("joiner", ["join"], "level_1"),
      ])
      const bothRootsStarted = yield* Deferred.make<void>()
      let rootsStarted = 0
      let rootsFinished = 0
      const order: string[] = []
      const parallelRunner: SubagentTurnRunner = (input) =>
        Effect.gen(function* () {
          if (input.agentType === "joiner") {
            expect(rootsFinished).toBe(2)
            order.push("joiner")
            return { ok: true, structured: undefined, text: "joined", tokensUsed: 0, cost: 0 }
          }

          rootsStarted++
          order.push(`${input.agentType}:started`)
          if (rootsStarted === 2) yield* Deferred.succeed(bothRootsStarted, undefined)
          yield* awaitWithTimeout(
            Deferred.await(bothRootsStarted),
            "same-wave runners did not overlap",
            "1 second",
          ).pipe(Effect.orDie)
          rootsFinished++
          order.push(`${input.agentType}:finished`)
          return { ok: true, structured: undefined, text: "done", tokensUsed: 0, cost: 0 }
        })
      const partition: NonNullable<MultiAgentRuntime.LayerOptions["partition"]> = (input) => ({
        event: input,
        subtasks: [
          {
            id: `${input.id}:left`,
            capability: "left",
            intent: "run left",
            dependsOn: [],
            fileScope: ["left.ts"],
            requiredAutonomy: "level_1",
          },
          {
            id: `${input.id}:right`,
            capability: "right",
            intent: "run right",
            dependsOn: [],
            fileScope: ["right.ts"],
            requiredAutonomy: "level_1",
          },
          {
            id: `${input.id}:join`,
            capability: "join",
            intent: "join roots",
            dependsOn: [`${input.id}:left`, `${input.id}:right`],
            fileScope: [],
            requiredAutonomy: "level_1",
          },
        ],
      })
      const summary = yield* Effect.gen(function* () {
        const runtime = yield* MultiAgentRuntime.Service
        return yield* runtime.coordinate(event({ type: "test.parallel" }))
      }).pipe(Effect.provide(makeLayer({ runner: parallelRunner, partition })))

      expect(summary.outcomes.map((outcome) => outcome.status)).toEqual(["completed", "completed", "completed"])
      expect(order.slice(0, 2).sort()).toEqual(["left:started", "right:started"])
      expect(order.at(-1)).toBe("joiner")
    }),
  )

  it.effect("§C3 restores an upstream git ref from completion artifacts when a failed DAG resumes", () =>
    Effect.gen(function* () {
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      const seenBases: (string | undefined)[] = []
      let invocation = 0
      const retryRunner: SubagentTurnRunner = (input) =>
        Effect.sync(() => {
          invocation++
          seenBases.push(input.baseRef)
          if (invocation === 2) {
            return { ok: false, structured: undefined, text: "", tokensUsed: 0, cost: 0 }
          }
          const continuationRef = invocation === 1 ? "agent/retry-upstream" : "agent/retry-verified"
          return {
            ok: true,
            structured: undefined,
            text: "done",
            tokensUsed: 0,
            cost: 0,
            continuationRef,
            artifacts: [`git-ref:${continuationRef}`],
          }
        })
      const ev = event({ payload: { files: ["src/x.ts"] } })
      const summaries = yield* Effect.gen(function* () {
        const runtime = yield* MultiAgentRuntime.Service
        return [yield* runtime.coordinate(ev), yield* runtime.coordinate(ev)] as const
      }).pipe(Effect.provide(makeLayer({ runner: retryRunner })))

      expect(summaries[0].hasUnfinished).toBe(true)
      expect(summaries[1].outcomes[0].reason).toBe("already_completed")
      expect(summaries[1].outcomes[1].status).toBe("completed")
      expect(seenBases).toEqual([undefined, "agent/retry-upstream", "agent/retry-upstream"])
    }),
  )

  it.effect("§E2 concurrency cap: an over-cap subtask DEFERS (retryable), never runs", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      // inject a concurrency gate that is always at cap → acquire is never admitted.
      const cappedRuntime = MultiAgentRuntime.layerWith({
        runner: fakeRunner,
        concurrency: {
          acquire: () => Effect.succeed({ admitted: false as boolean, depth: 5, cap: 5 }),
          release: () => {},
          depth: () => 5,
          totalDepth: () => 5,
        },
      })
      const database = Database.layerFromPath(":memory:")
      const core = Layer.mergeAll(DeepAgentEventBus.layerWith({ now }), ApprovalQueue.layerWith({ now })).pipe(
        Layer.provideMerge(database),
      )
      const summary = yield* MultiAgentRuntime.Service.pipe(
        Effect.flatMap((rt) => rt.coordinate(event())),
        Effect.provide(cappedRuntime.pipe(Layer.provide(core), Layer.provide(fakeAgentList))),
      )
      // the first subtask is capped → deferred; its dependent is then blocked (dependency_not_met).
      // Neither runs, and the event is unfinished (retryable) — the cap never drops work.
      expect(summary.outcomes.some((o) => o.status === "deferred" && o.reason === "concurrency_capped")).toBe(true)
      expect(summary.hasUnfinished).toBe(true) // → dispatch nacks → retry when the workspace drains
      expect(ran.length).toBe(0)
    }),
  )

  it.effect("§C1 max_files_changed: a subtask whose fileScope exceeds the agent's ceiling is BLOCKED (terminal)", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      // the agent's declared max_files_changed=2, but the event carries a 3-file scope → code_edit is
      // blocked (terminal — the partition won't shrink on retry), and its dependent test_run is then
      // dependency_not_met. Neither runs.
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2", { maxFilesChanged: 2 })])
      const runtime = yield* MultiAgentRuntime.Service
      const summary = yield* runtime.coordinate(event({ payload: { files: ["src/a.ts", "src/b.ts", "src/c.ts"] } }))
      const codeEdit = summary.outcomes.find((o) => o.capability === "code_edit")
      expect(codeEdit?.status).toBe("blocked")
      expect(codeEdit?.reason).toBe("max_files_changed")
      expect(ran.length).toBe(0)
      expect(summary.hasUnfinished).toBe(false)
    }),
  )

  it.effect("§C1 max_files_changed: a subtask WITHIN the ceiling runs normally", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2", { maxFilesChanged: 3 })])
      const runtime = yield* MultiAgentRuntime.Service
      const summary = yield* runtime.coordinate(event({ payload: { files: ["src/a.ts", "src/b.ts"] } }))
      expect(summary.outcomes.map((o) => o.status)).toEqual(["completed", "completed"])
    }),
  )

  it.effect("§E2 token budget: an agent already over maxTokensPerHour DEFERS the subtask (retryable)", () =>
    Effect.gen(function* () {
      // a runner that reports a big token spend so the FIRST subtask pushes the agent over budget; the
      // SECOND (dependent) subtask then sees the agent over budget → deferred (retryable, not dropped).
      let calls = 0
      const bigSpendRunner: SubagentTurnRunner = (input) =>
        Effect.sync(() => {
          calls++
          ran.push(input.agentType)
          return {
            ok: true,
            structured: undefined,
            text: "done",
            tokensUsed: 100,
            cost: 0,
            continuationRef: "agent/big-spend",
            artifacts: ["git-ref:agent/big-spend"],
          }
        })
      ran = []
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2", { maxTokensPerHour: 100 })])
      const database = Database.layerFromPath(":memory:")
      const core = Layer.mergeAll(DeepAgentEventBus.layerWith({ now }), ApprovalQueue.layerWith({ now })).pipe(
        Layer.provideMerge(database),
      )
      const rt = MultiAgentRuntime.layerWith({ runner: bigSpendRunner, now }).pipe(
        Layer.provide(core),
        Layer.provide(fakeAgentList),
      )
      const summary = yield* MultiAgentRuntime.Service.pipe(
        Effect.flatMap((r) => r.coordinate(event({ payload: { files: ["src/a.ts"] } }))),
        Effect.provide(rt.pipe(Layer.provide(core), Layer.provide(fakeAgentList))),
      )
      // first subtask ran (was under budget when admitted) and spent 100 → agent now AT the ceiling.
      const first = summary.outcomes[0]
      expect(first.status).toBe("completed")
      // the dependent second subtask sees the agent over budget → deferred (retryable), never runs.
      const second = summary.outcomes[1]
      expect(second.status).toBe("deferred")
      expect(second.reason).toBe("token_budget_exceeded")
      expect(summary.hasUnfinished).toBe(true)
      expect(calls).toBe(1) // only the first turn actually ran
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

describe("MultiAgentRuntime durable multi-owner execution", () => {
  const it = testEffect(makeLayer())
  const oneTask: NonNullable<MultiAgentRuntime.LayerOptions["partition"]> = (input) => ({
    event: input,
    subtasks: [
      {
        id: `${input.id}:work`,
        capability: "code_edit",
        intent: "implement the change",
        dependsOn: [],
        fileScope: ["src/shared.ts"],
        requiredAutonomy: "level_2",
      },
    ],
  })

  it.effect("two runtime owners cannot execute the same event task concurrently", () =>
    Effect.gen(function* () {
      setNow(10_000)
      setRegistry([agent("fixer", ["code_edit"], "level_2")])
      const bus = yield* DeepAgentEventBus.Service
      const queue = yield* ApprovalQueue.Service
      const execution = yield* AgentExecution.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let firstRuns = 0
      let secondRuns = 0
      const firstRunner: SubagentTurnRunner = () =>
        Effect.gen(function* () {
          firstRuns++
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
          return { ok: true, structured: undefined, text: "first", tokensUsed: 0, cost: 0 }
        })
      const secondRunner: SubagentTurnRunner = () =>
        Effect.sync(() => {
          secondRuns++
          return { ok: true, structured: undefined, text: "second", tokensUsed: 0, cost: 0 }
        })
      const dependencies = Layer.mergeAll(
        Layer.succeed(DeepAgentEventBus.Service, bus),
        Layer.succeed(ApprovalQueue.Service, queue),
        Layer.succeed(AgentExecution.Service, execution),
        fakeAgentList,
      )
      const runtime = (ownerID: string, runner: SubagentTurnRunner) =>
        Layer.build(
          MultiAgentRuntime.layerWith({
            runner,
            partition: oneTask,
            execution,
            ownerID,
            leaseMs: 1_000,
          }).pipe(Layer.provide(dependencies)),
        ).pipe(Effect.map((context) => Context.get(context, MultiAgentRuntime.Service)))
      const first = yield* runtime("runtime_a", firstRunner)
      const second = yield* runtime("runtime_b", secondRunner)
      const input = event({ id: DeepAgentEvent.ID.create(10_000), type: "test.multi-owner" })
      const firstFiber = yield* Effect.forkScoped(first.coordinate(input))
      yield* Deferred.await(started)
      const contended = yield* second.coordinate(input)
      expect(contended.outcomes).toEqual([
        expect.objectContaining({ status: "deferred", reason: "execution_busy", agentID: "fixer" }),
      ])
      expect(secondRuns).toBe(0)
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(firstFiber)).outcomes[0]?.status).toBe("completed")
      const replay = yield* second.coordinate(input)
      expect(replay.outcomes[0]).toMatchObject({ status: "completed", reason: "already_completed" })
      expect(firstRuns).toBe(1)
      expect(secondRuns).toBe(0)
    }),
  )

  it.effect("runner failure durably requests handoff to the next capable agent", () =>
    Effect.gen(function* () {
      setNow(20_000)
      setRegistry([agent("agent_a", ["code_edit"], "level_2"), agent("agent_b", ["code_edit"], "level_2")])
      const bus = yield* DeepAgentEventBus.Service
      const queue = yield* ApprovalQueue.Service
      const execution = yield* AgentExecution.Service
      const runtime = Context.get(
        yield* Layer.build(
          MultiAgentRuntime.layerWith({
            partition: oneTask,
            execution,
            ownerID: "runtime_a",
            runner: () =>
              Effect.succeed({
                ok: false,
                reason: "runner_failed",
                structured: undefined,
                text: "",
                tokensUsed: 0,
                cost: 0,
                continuationRef: "agent/partial",
              }),
          }).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(DeepAgentEventBus.Service, bus),
                Layer.succeed(ApprovalQueue.Service, queue),
                Layer.succeed(AgentExecution.Service, execution),
                fakeAgentList,
              ),
            ),
          ),
        ),
        MultiAgentRuntime.Service,
      )
      const input = event({ id: DeepAgentEvent.ID.create(20_000), type: "test.handoff" })
      const summary = yield* runtime.coordinate(input)
      expect(summary.outcomes[0]).toMatchObject({
        status: "deferred",
        agentID: "agent_a",
        reason: "handoff_requested",
      })
      const pending = yield* execution.get({
        workspaceID: input.workspaceID,
        eventID: input.id,
        taskID: `${input.id}:work`,
      })
      expect(pending).toMatchObject({
        status: "handoff_pending",
        agentID: "agent_a",
        handoffToAgentID: "agent_b",
        continuationRef: "agent/partial",
      })
      const handoffs = yield* bus.recentByType({
        type: LMNEvents.AGENT_HANDOFF_REQUESTED,
        workspaceID: input.workspaceID,
        windowMs: Number.MAX_SAFE_INTEGER,
        now: input.createdAt,
      })
      expect(handoffs).toHaveLength(1)
      expect(handoffs[0]?.payload).toMatchObject({
        type: LMNEvents.AGENT_HANDOFF_REQUESTED,
        eventID: input.id,
        taskID: `${input.id}:work`,
        fromAgentID: "agent_a",
        toAgentID: "agent_b",
      })
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

  it.effect("write-isolation failure settles the DAG and escalates to a human instead of retrying forever", () =>
    Effect.gen(function* () {
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      const isolationFailure: SubagentTurnRunner = () =>
        Effect.succeed({
          ok: false,
          reason: "isolation_unavailable",
          structured: undefined,
          text: "",
          tokensUsed: 0,
          cost: 0,
        })
      const result = yield* Effect.gen(function* () {
        const runtime = yield* MultiAgentRuntime.Service
        const summary = yield* runtime.coordinate(event())
        const queue = yield* ApprovalQueue.Service
        return { summary, pending: yield* queue.listPending("wrk_1") }
      }).pipe(Effect.provide(makeLayer({ runner: isolationFailure })))

      expect(result.summary.outcomes[0]).toMatchObject({ status: "blocked", reason: "isolation_unavailable" })
      expect(result.summary.outcomes[1]).toMatchObject({ status: "blocked", reason: "dependency_not_met" })
      expect(result.summary.hasUnfinished).toBe(false)
      expect(result.pending.some((item) => item.eventType === "agent.task.needs_human")).toBe(true)
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
      expect(summary.hasUnfinished).toBe(false)
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
      const exit = yield* runtime.dispatch({ event: event(), priority: "normal", targets: [] }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure") // dispatcher will nack
    }),
  )

  it.effect("dispatch succeeds (→ ack) when every subtask reaches a terminal state", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      const runtime = yield* MultiAgentRuntime.Service
      const exit = yield* runtime.dispatch({ event: event(), priority: "normal", targets: [] }).pipe(Effect.exit)
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

// ─── §E1 PRODUCTION WIRING — the four-layer gate built the way v4-event-runtime builds it ─────────────
// These tests do NOT stub the gate: they inject the REAL SecurityResolvers (over WorkspaceConfig +
// IMRepository + the registry) exactly as v4-event-runtime.runtimeLayer does, then prove the composite
// FAILS CLOSED. Under the OLD default-open wiring (no trustedSourcesFor / actorHasPermission /
// runtimeAllowed) every one of these subtasks would RUN — so each test is a direct regression guard on
// the §E1 default-open defect.

// A descriptor with an explicit toolWhitelist (drives §E1 layer-4). `caps` still feeds layer-3 + binding.
const agentWithTools = (id: string, caps: string[], toolWhitelist: string[]): AgentDescriptor => ({
  id,
  name: id,
  displayName: id,
  visible: true,
  capabilities: caps,
  autonomy: "level_2",
  limits: { toolWhitelist },
})

// The MultiAgentRuntime built the PRODUCTION way — resolvers closed over the live SecurityResolvers,
// byte-for-byte the shape v4-event-runtime.ts injects (L1 per-event, L2 actor, L4 runtime+capability).
const prodRuntimeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const sec = yield* SecurityResolvers.Service
    return MultiAgentRuntime.layerWith({
      runner: fakeRunner,
      trustedSourcesFor: (ev) => sec.resolveTrustedSources(ev.workspaceID),
      actorHasPermission: (ev, ag) =>
        sec.actorHasWorkspacePermission({
          workspaceID: ev.workspaceID,
          ...(ev.actorID != null ? { actorID: ev.actorID } : {}),
          agentID: ag.id,
        }),
      runtimeAllowed: (ev, ag, capability) =>
        sec.runtimeAllowsOperation({ workspaceID: ev.workspaceID, agent: ag, capability }),
    })
  }),
)

// Assemble runtime + real resolvers + WorkspaceConfig (exposed so a test can set trustedSources) over ONE
// shared in-memory DB — the same single-instance discipline server.ts uses.
const makeProdLayer = () => {
  const database = Database.layerFromPath(":memory:")
  const wsConfig = WorkspaceConfig.layer.pipe(Layer.provideMerge(database))
  const imRepo = IMRepositoryLive.pipe(Layer.provideMerge(database))
  const sec = SecurityResolvers.layer.pipe(Layer.provide(Layer.mergeAll(wsConfig, imRepo, fakeAgentList)))
  const core = Layer.mergeAll(DeepAgentEventBus.layerWith({ now }), ApprovalQueue.layerWith({ now })).pipe(
    Layer.provideMerge(database),
  )
  const runtime = prodRuntimeLayer.pipe(Layer.provide(sec), Layer.provide(core), Layer.provide(fakeAgentList))
  return Layer.mergeAll(runtime, core, wsConfig)
}

describe("MultiAgentRuntime §E1 production wiring (real SecurityResolvers) fails closed", () => {
  const it = testEffect(makeProdLayer())

  it.effect(
    "§E1 L1 fail-closed: an event whose source is NOT in the workspace trusted set is BLOCKED (security:event_source)",
    () =>
      Effect.gen(function* () {
        resetRunner()
        setNow(1_000)
        // capable + autonomy-cleared agent — the ONLY reason it must not run is layer 1.
        setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
        // tighten the workspace to trust ONLY "im"; the event below is source "ci" → untrusted.
        const cfg = yield* WorkspaceConfig.Service
        yield* cfg.set("wrk_1", { trustedSources: ["im"] })
        const runtime = yield* MultiAgentRuntime.Service
        const summary = yield* runtime.coordinate(event({ source: "ci" }))
        expect(summary.outcomes.every((o) => o.status === "blocked")).toBe(true)
        expect(summary.outcomes[0].reason).toBe("security:event_source")
        expect(ran).toEqual([]) // nothing ran — the default-open bug would have run both subtasks
      }),
  )

  it.effect("§E1 L1: a TRUSTED source with the same agent DOES run (proves the gate isn't blanket-deny)", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      const cfg = yield* WorkspaceConfig.Service
      yield* cfg.set("wrk_1", { trustedSources: ["ci", "im", "system"] }) // now "ci" is trusted
      const runtime = yield* MultiAgentRuntime.Service
      const summary = yield* runtime.coordinate(event({ source: "ci", payload: { files: ["src/a.ts"] } }))
      expect(summary.outcomes.map((o) => o.status)).toEqual(["completed", "completed"])
      expect(ran).toEqual(["fixer", "fixer"])
    }),
  )

  it.effect(
    "§E1 L4 fail-closed: an agent whose toolWhitelist excludes the capability is BLOCKED (security:runtime_operation)",
    () =>
      Effect.gen(function* () {
        resetRunner()
        setNow(1_000)
        // capable (L3 ok) + autonomy-cleared — but its declared toolWhitelist does NOT permit the required
        // capability, so layer 4 must deny. First trust "ci" so L1 passes and the gate reaches L4.
        const cfg = yield* WorkspaceConfig.Service
        yield* cfg.set("wrk_1", { trustedSources: ["ci", "im", "system"] })
        setRegistry([agentWithTools("locked", ["code_edit", "test_run"], ["read_only"])])
        const runtime = yield* MultiAgentRuntime.Service
        const summary = yield* runtime.coordinate(event())
        expect(summary.outcomes.every((o) => o.status === "blocked")).toBe(true)
        expect(summary.outcomes[0].reason).toBe("security:runtime_operation")
        expect(ran).toEqual([])
      }),
  )
})

describe("MultiAgentRuntime §E1 production wiring — L2 actor_permission fails closed", () => {
  // §E1 layer 2 blocks an actor who is (arm 1) NOT a member of any workspace IM group AND (arm 2) cannot
  // see the acting agent in their own registry scope. To exercise this honestly we must let the runtime
  // BIND a capable agent (else it blocks at no_capable_agent, never reaching L2) while the RESOLVER's
  // actor-scoped agent lookup comes up empty — i.e. the runtime can bind from the workspace registry, but
  // the actor themselves is neither a member nor has that agent visible. So the resolver is provided a
  // SEPARATE, actor-empty AgentListProvider, while the runtime binds from the full `fakeAgentList`
  // ([fixer]). IMRepository is real + empty (no membership). Source is trusted so L1 passes and the gate
  // reaches L2. This is precisely the multi-tenant "outsider acting through an agent they don't own" case.
  const database = Database.layerFromPath(":memory:")
  const wsConfig = WorkspaceConfig.layer.pipe(Layer.provideMerge(database))
  const imRepo = IMRepositoryLive.pipe(Layer.provideMerge(database)) // real IM DB, no seeded membership
  // the actor's scope sees NO agents ⇒ resolver arm-2 (agent registered for the actor) fails.
  const actorEmptyAgentList = Layer.succeed(AgentListProviderService, {
    listAgents: () => Effect.succeed([]),
    findByTrigger: () => Effect.succeed([]),
    findByCapability: () => Effect.succeed([]),
  })
  const sec = SecurityResolvers.layer.pipe(Layer.provide(Layer.mergeAll(wsConfig, imRepo, actorEmptyAgentList)))
  const core = Layer.mergeAll(DeepAgentEventBus.layerWith({ now }), ApprovalQueue.layerWith({ now })).pipe(
    Layer.provideMerge(database),
  )
  // the runtime binds from the FULL registry (fakeAgentList → whatever setRegistry set) so binding
  // succeeds; only the resolver sees the actor-empty list, isolating L2 as the failing layer.
  const runtime = prodRuntimeLayer.pipe(Layer.provide(sec), Layer.provide(core), Layer.provide(fakeAgentList))
  const it = testEffect(Layer.mergeAll(runtime, core, wsConfig))

  it.effect(
    "§E1 L2 fail-closed: a NON-member actor whose agent isn't in their scope is BLOCKED (security:actor_permission)",
    () =>
      Effect.gen(function* () {
        resetRunner()
        setNow(1_000)
        // trust the event source so L1 PASSES — we must reach L2 to test it. The bound agent is capable
        // (L3 ok), autonomy-cleared, no toolWhitelist (L4 ok). The ONLY failing layer is L2.
        const cfg = yield* WorkspaceConfig.Service
        yield* cfg.set("wrk_1", { trustedSources: ["ci", "im", "system"] })
        setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
        const runtime = yield* MultiAgentRuntime.Service
        const summary = yield* runtime.coordinate(event({ actorID: "stranger_not_a_member" }))
        expect(summary.outcomes.every((o) => o.status === "blocked")).toBe(true)
        expect(summary.outcomes[0].reason).toBe("security:actor_permission")
        expect(ran).toEqual([])
      }),
  )
})

describe("MultiAgentRuntime §E1 production wiring — L1 resolver ERROR fails closed", () => {
  // A WorkspaceConfig whose `get` DEFECTS (transient store failure). The per-event L1 resolver must
  // resolve the source to NOT trusted (fail closed), never open. Built the production way otherwise.
  const failingConfig = Layer.succeed(
    WorkspaceConfig.Service,
    WorkspaceConfig.Service.of({
      get: () => Effect.die(new Error("config store down")),
      set: () => Effect.die(new Error("config store down")),
    }),
  )
  const database = Database.layerFromPath(":memory:")
  const imRepo = IMRepositoryLive.pipe(Layer.provideMerge(database))
  const sec = SecurityResolvers.layer.pipe(Layer.provide(Layer.mergeAll(failingConfig, imRepo, fakeAgentList)))
  const core = Layer.mergeAll(DeepAgentEventBus.layerWith({ now }), ApprovalQueue.layerWith({ now })).pipe(
    Layer.provideMerge(database),
  )
  const runtime = prodRuntimeLayer.pipe(Layer.provide(sec), Layer.provide(core), Layer.provide(fakeAgentList))
  const it = testEffect(Layer.mergeAll(runtime, core))

  it.effect("a trusted-source lookup DEFECT ⇒ source not trusted ⇒ BLOCKED (security:event_source), never open", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      const runtime = yield* MultiAgentRuntime.Service
      const summary = yield* runtime.coordinate(event())
      expect(summary.outcomes.every((o) => o.status === "blocked")).toBe(true)
      expect(summary.outcomes[0].reason).toBe("security:event_source")
      expect(ran).toEqual([])
    }),
  )
})

// ─── §C3.1 FileLock enforcement — a REAL FileLock.Service instance drives contention/release ──────────
// The runtime acquires an AGENT lock on each file a subtask writes before running it; a file already
// held (by another agent OR by a human) DEFERS the subtask (retryable), so two concurrently-admitted
// subtasks never edit the same file. Tests 1+2 share ONE FileLock instance (the same singleton the file
// HTTP handlers use) so an external lock held in test 1 is observed by the runtime.
describe("MultiAgentRuntime §C3.1 file-lock enforcement", () => {
  // The process-wide FileLock singleton (Layer.succeed value) — the exact instance production shares.
  const testFileLock = Effect.runSync(FileLock.Service.pipe(Effect.provide(FileLock.layer)))
  const it = testEffect(makeLayer({ fileLock: testFileLock }))
  // carried from test 1 → test 2: the external agent lock we hold, then release.
  let externalLockId = ""

  it.effect("§C3.1 a pre-held EXTERNAL agent lock on a file defers a subtask touching it", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      // an OTHER agent already holds the lock on the file the code_edit subtask will touch.
      const held = testFileLock.acquire("src/locked.ts", "agent")
      expect(held).not.toBeNull()
      externalLockId = held!.lockId
      const runtime = yield* MultiAgentRuntime.Service
      const summary = yield* runtime.coordinate(event({ payload: { files: ["src/locked.ts"] } }))
      // code_edit can't get the lock → deferred (file_locked); its dependent test_run is then blocked.
      const codeEdit = summary.outcomes.find((o) => o.capability === "code_edit")
      expect(codeEdit?.status).toBe("deferred")
      expect(codeEdit?.reason).toBe("file_locked")
      expect(summary.hasUnfinished).toBe(true) // retryable — the lock will clear
      expect(ran).toEqual([]) // the runner was NEVER called
    }),
  )

  it.effect("§C3.1 after the external lock releases, re-coordination runs", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      // release the external lock held in the previous test → the file is now free.
      testFileLock.release(externalLockId)
      const runtime = yield* MultiAgentRuntime.Service
      const summary = yield* runtime.coordinate(event({ payload: { files: ["src/locked.ts"] } }))
      expect(summary.outcomes.map((o) => o.status)).toEqual(["completed", "completed"])
      expect(ran).toEqual(["fixer", "fixer"]) // the runner ran now that the file is unlocked
    }),
  )

  it.effect("§C3.1 a HUMAN lock blocks an agent subtask (human wins)", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      // a HUMAN is editing the file — an agent acquire returns null (human precedence).
      const human = testFileLock.acquire("src/human.ts", "human")
      expect(human).not.toBeNull()
      const runtime = yield* MultiAgentRuntime.Service
      const summary = yield* runtime.coordinate(event({ payload: { files: ["src/human.ts"] } }))
      const codeEdit = summary.outcomes.find((o) => o.capability === "code_edit")
      expect(codeEdit?.status).toBe("deferred")
      expect(codeEdit?.reason).toBe("file_locked")
      expect(ran).toEqual([])
      testFileLock.release(human!.lockId) // cleanup
    }),
  )
})

// ─── §C3.3 code-graph symbols — the resolver is consulted per subtask + fails safe ────────────────────
// symbolsForFiles feeds the ConflictArbiter's SEMANTIC layer (symbol overlap). The partitioner gives
// uniform fileScope to a single event's subtasks, so two same-symbol disjoint-file subtasks can't be
// naturally constructed here — the arbiter's symbol-overlap logic is unit-tested directly in
// packages/core/test/conflict-arbiter.test.ts. Here we prove the resolver is INVOKED with the subtask's
// fileScope and that a THROWING resolver fails safe (coordination still completes).
describe("MultiAgentRuntime §C3.3 symbolsForFiles resolver", () => {
  const it = testEffect(makeLayer())

  it.effect("§C3.3 symbolsForFiles is invoked with the subtask fileScope", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      const calls: ReadonlyArray<string>[] = []
      const spyLayer = makeLayer({
        symbolsForFiles: (_event, files) =>
          Effect.sync(() => {
            calls.push(files)
            return ["src/s.ts#Foo.bar"]
          }),
      })
      const summary = yield* MultiAgentRuntime.Service.pipe(
        Effect.flatMap((rt) => rt.coordinate(event({ payload: { files: ["src/s.ts"] } }))),
        Effect.provide(spyLayer),
      )
      expect(summary.outcomes.map((o) => o.status)).toEqual(["completed", "completed"])
      // the resolver was consulted once per admitted subtask, with that subtask's declared fileScope.
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.every((files) => files.includes("src/s.ts"))).toBe(true)
    }),
  )

  it.effect("§C3.3 a THROWING symbolsForFiles resolver fails safe — coordination still completes", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
      const throwingLayer = makeLayer({
        symbolsForFiles: () => Effect.die(new Error("code graph unavailable")),
      })
      const summary = yield* MultiAgentRuntime.Service.pipe(
        Effect.flatMap((rt) => rt.coordinate(event({ payload: { files: ["src/s.ts"] } }))),
        Effect.provide(throwingLayer),
      )
      // symbols fall back to [] → file-level detection still works → the subtasks run normally.
      expect(summary.outcomes.map((o) => o.status)).toEqual(["completed", "completed"])
      expect(ran).toEqual(["fixer", "fixer"])
    }),
  )
})

// ─── V4.0 §A1 BUILT-IN descriptors drive the autonomous path (the money test) ─────────────────────────
// The audit's core defect: the core AgentListProvider emitted metadata-less descriptors, so NO agent
// matched an autonomous event's capability → every event blocked with `no_capable_agent` → the
// autonomous half never ran. These tests feed the REAL BUILTIN_AGENT_DESCRIPTORS (verbatim from the
// core provider) into the runtime's registry and prove each autonomous event now BINDS a capable agent
// and REACHES the gates — no subtask blocks with no_capable_agent.
describe("MultiAgentRuntime with BUILT-IN descriptors — autonomous path is no longer dead", () => {
  const it = testEffect(makeLayer())

  it.effect("§A1 ci.failure binds a capable agent (NOT no_capable_agent) and runs the fix→test DAG", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      // the exact built-ins the core AgentListProviderImpl now appends.
      setRegistry([...BUILTIN_AGENT_DESCRIPTORS])
      const runtime = yield* MultiAgentRuntime.Service
      const summary = yield* runtime.coordinate(
        event({ type: "ci.failure", source: "ci", payload: { files: ["src/a.ts"] } }),
      )
      // NO subtask blocked for lack of a capable agent — the whole point of §A1.
      expect(summary.outcomes.some((o) => o.reason === "no_capable_agent")).toBe(false)
      // code_edit binds CodeFixAgent(name:auto), test_run binds CodeFixAgent too (first in registry order).
      expect(summary.outcomes.map((o) => o.status)).toEqual(["completed", "completed"])
      expect(ran).toEqual(["auto", "auto"])
    }),
  )

  it.effect(
    "§A1 monitor.alert binds diagnose(general) + code_edit(auto) — reaches the gates, no no_capable_agent",
    () =>
      Effect.gen(function* () {
        resetRunner()
        setNow(1_000)
        setRegistry([...BUILTIN_AGENT_DESCRIPTORS])
        const runtime = yield* MultiAgentRuntime.Service
        const summary = yield* runtime.coordinate(
          event({ type: "monitor.alert", source: "monitor", payload: { files: ["src/y.ts"] } }),
        )
        expect(summary.outcomes.some((o) => o.reason === "no_capable_agent")).toBe(false)
        // diagnose → DiagnosisAgent(general), propose-fix code_edit → CodeFixAgent(auto).
        expect(ran).toEqual(["general", "auto"])
        expect(summary.outcomes.map((o) => o.status)).toEqual(["completed", "completed"])
      }),
  )

  it.effect("§A1 pr.comment (analyze→code_edit→review) all bind capable agents — no no_capable_agent", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      setRegistry([...BUILTIN_AGENT_DESCRIPTORS])
      const runtime = yield* MultiAgentRuntime.Service
      const summary = yield* runtime.coordinate(
        event({ type: "pr.comment", source: "im", payload: { files: ["src/z.ts"] } }),
      )
      expect(summary.outcomes.some((o) => o.reason === "no_capable_agent")).toBe(false)
      // analyze→CodeReviewAgent(general), code_edit→ChangeAgent OR CodeFixAgent (auto), review→CodeReviewAgent(general).
      expect(summary.outcomes.length).toBe(3)
      expect(summary.outcomes.every((o) => o.status === "completed")).toBe(true)
    }),
  )
})

// ─── V4.0 §A1 CRITICAL — the runtime over the REAL PRODUCTION provider (ServerAgentListProviderLive) ────
// The money test above used the fake registry, which bypassed the two real providers. THIS test wires the
// runtime's AgentListProviderService to the actual ServerAgentListProviderLive over an Agent.Service that
// mirrors production (auto/general/plan with NO trigger/capability metadata). If the built-ins weren't
// appended INSIDE ServerAgentListProvider, coordinate() would block with no_capable_agent here — this is
// the direct regression guard on the "built-ins in the wrong provider" defect.
describe("MultiAgentRuntime over the REAL ServerAgentListProvider (production wiring) — no no_capable_agent", () => {
  // Agent.Service mirroring production: real primary agents, none carrying autonomous metadata.
  const agentInfo = (partial: Record<string, unknown>): Agent.Info =>
    ({ options: {}, permission: [], mode: "all", ...partial }) as unknown as Agent.Info
  const agentMock = {
    list: () =>
      Effect.succeed([
        agentInfo({ name: "auto", mode: "primary", description: "default" }),
        agentInfo({ name: "general", mode: "all" }),
        agentInfo({ name: "plan", mode: "primary" }),
      ]),
  } as unknown as Agent.Interface
  // InstanceStore stub — the provider uses it to establish a context around agents.list() on a bare
  // daemon fiber (the BLOCKER fix). These events carry a "wrk_" workspaceID (no directory), so the
  // provider degrades to the built-in autonomous descriptors — which is exactly what binds CodeFixAgent
  // as the "auto" agent below; it never dies.
  const instanceStoreStub = {
    load: (input: { directory: string }) =>
      Effect.succeed({ directory: input.directory, worktree: input.directory, project: {} }),
  } as unknown as InstanceStore.Interface
  const realProvider = ServerAgentListProviderLive.pipe(
    Layer.provide(Layer.succeed(Agent.Service, agentMock)),
    Layer.provide(Layer.succeed(InstanceStore.Service, instanceStoreStub)),
  )

  const makeRealLayer = () => {
    const database = Database.layerFromPath(":memory:")
    const core = Layer.mergeAll(
      DeepAgentEventBus.layerWith({ now }),
      ApprovalQueue.layerWith({ now }),
      AgentExecution.layerWith({ now }),
    ).pipe(Layer.provideMerge(database))
    const runtime = Layer.unwrap(
      Effect.gen(function* () {
        const execution = yield* AgentExecution.Service
        return MultiAgentRuntime.layerWith({ runner: fakeRunner, execution })
      }),
    ).pipe(Layer.provide(core), Layer.provide(realProvider))
    return Layer.mergeAll(runtime, core)
  }
  const it = testEffect(makeRealLayer())

  it.effect("§A1 ci.failure over the PRODUCTION provider binds a capable agent (no no_capable_agent)", () =>
    Effect.gen(function* () {
      resetRunner()
      setNow(1_000)
      const runtime = yield* MultiAgentRuntime.Service
      const summary = yield* runtime.coordinate(
        event({ type: "ci.failure", source: "ci", payload: { files: ["src/a.ts"] } }),
      )
      // the built-ins are appended INSIDE ServerAgentListProvider → the production path is live.
      expect(summary.outcomes.some((o) => o.reason === "no_capable_agent")).toBe(false)
      expect(summary.outcomes.map((o) => o.status)).toEqual(["completed", "completed"])
      expect(ran).toEqual(["auto", "auto"]) // CodeFixAgent runs as the real "auto" agent
    }),
  )

  it.effect("§A1 all six autonomous event types bind via the production provider (none no_capable_agent)", () =>
    Effect.gen(function* () {
      const runtime = yield* MultiAgentRuntime.Service
      for (const [type, source] of [
        ["ci.failure", "ci"],
        ["ci.repair.requested", "ci"],
        ["pr.comment", "im"],
        ["monitor.alert", "monitor"],
        ["git.push", "git"],
        ["schedule.scan", "system"],
      ] as const) {
        resetRunner()
        setNow(1_000)
        const summary = yield* runtime.coordinate(event({ type, source, payload: { files: ["src/a.ts"] } }))
        expect(summary.outcomes.length).toBeGreaterThan(0)
        expect(summary.outcomes.some((o) => o.reason === "no_capable_agent")).toBe(false)
      }
    }),
  )
})
