import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Context, Cause, Effect, Layer } from "effect"
import { MultiAgentRuntime } from "../../src/session/multi-agent-runtime"
import { parentSessionIDFor } from "../../src/session/multi-agent-runtime"
import type { SubagentTurnRunner } from "../../src/session/goal-loop-wiring"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { AgentExecution } from "@deepagent-code/core/deepagent/agent-execution"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { Database } from "@deepagent-code/core/database/database"
import { EventAdmission } from "@deepagent-code/core/deepagent/event-admission"
import { EventAdmissionWiring } from "@deepagent-code/core/deepagent/event-admission-wiring"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import type { EventDispatcher } from "../../src/session/event-dispatcher"
import { createRuntimeFeatureRegistry, type RuntimeFeatureRegistry } from "@deepagent-code/core/flag/runtime-features"

// C5-04 — the flag-gated V2 admission dispatch branch in the Multi-Agent Runtime. Design §8.7 (event
// turns through SessionV2/SessionExecution, never the legacy path) + §8.4 (bounded V2 admission).
// The runtime is decoupled from SessionV2/DB/registry via an INJECTED `eventV2Admission` seam, so these
// tests verify the BRANCH logic (flag ON/OFF + seam present/absent) with a fake bridge — no V4 stack.
//
// v2w-j4 durable-only: the hybrid fallback is DELETED. `dispatch` is V2-admission-only — a disabled
// switch or an absent seam is a TYPED refusal (fail-closed; the dispatcher nacks and the retry pump
// re-drives) instead of silently running the legacy §C coordination through the V1 turn runner.

let clock = 0
const now = () => clock
const admissionOff = createRuntimeFeatureRegistry(undefined, {
  [EventAdmission.EVENT_V2_ADMISSION_ENV]: "false",
})

let runnerRan: string[] = []
const resetRunner = () => {
  runnerRan = []
}
let turnCounter = 0
const fakeRunner: SubagentTurnRunner = (input) =>
  Effect.sync(() => {
    runnerRan.push(input.agentType)
    const turn = ++turnCounter
    // Mirror the real runner: write-isolation turns produce a durable continuation ref so a dependent
    // wave is not deferred for a missing continuation (which would leave coordination incomplete).
    const continuationRef = input.requiresWriteIsolation ? `agent/fake-${turn}` : undefined
    return {
      ok: true,
      structured: undefined,
      text: "done",
      tokensUsed: 0,
      cost: 0,
      sessionID: `ses_fake_${turn}`,
      ...(continuationRef ? { continuationRef, artifacts: [`git-ref:${continuationRef}`] } : {}),
    }
  })

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

const makeRuntime = (
  eventV2Admission?: MultiAgentRuntime.EventV2AdmissionBridge,
  runtimeFeatures?: RuntimeFeatureRegistry,
  dagCoordination = false,
  partition?: MultiAgentRuntime.LayerOptions["partition"],
) => {
  const database = Database.layerFromPath(":memory:")
  const core = Layer.mergeAll(
    DeepAgentEventBus.layerWith({ now }),
    ApprovalQueue.layerWith({ now }),
    AgentExecution.layerWith({ now }),
  ).pipe(Layer.provideMerge(database))
  const runtime = Layer.unwrap(
    Effect.gen(function* () {
      const execution = yield* AgentExecution.Service
      return MultiAgentRuntime.layerWith({
        runner: fakeRunner,
        execution,
        dagCoordination,
        ...(partition ? { partition } : {}),
        ...(eventV2Admission ? { eventV2Admission } : {}),
        ...(runtimeFeatures ? { runtimeFeatures } : {}),
      })
    }),
  ).pipe(Layer.provide(core), Layer.provide(fakeAgentList))
  return Layer.mergeAll(runtime, core)
}

/** Build the runtime layer, run `body` against it (keeping its scope alive), and return its result. */
function withRuntime<A>(
  eventV2Admission: MultiAgentRuntime.EventV2AdmissionBridge | undefined,
  body: (runtime: MultiAgentRuntime.Interface, bus: DeepAgentEventBus.Interface) => Effect.Effect<A, unknown>,
  runtimeFeatures?: RuntimeFeatureRegistry,
  dagCoordination = false,
  partition?: MultiAgentRuntime.LayerOptions["partition"],
): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const ctx = yield* Layer.build(makeRuntime(eventV2Admission, runtimeFeatures, dagCoordination, partition))
      const runtime = Context.get(ctx, MultiAgentRuntime.Service)
      return yield* body(runtime, Context.get(ctx, DeepAgentEventBus.Service))
    }).pipe(Effect.scoped),
  )
}

const event = (over?: Partial<DeepAgentEvent.Event>): DeepAgentEvent.Event => ({
  id: DeepAgentEvent.ID.create(1_000),
  type: "ci.failure",
  source: "ci",
  workspaceID: "wrk_1",
  projectID: "proj_1",
  idempotencyKey: "k",
  priority: "normal",
  createdAt: 1_000,
  payload: {},
  ...over,
})

const request = (): EventDispatcher.DispatchRequest => ({
  event: event(),
  priority: "normal",
  targets: [],
})

const fakeBridge = (calls: Array<Record<string, unknown>>): MultiAgentRuntime.EventV2AdmissionBridge => ({
  securityNamespaceFor: (workspaceID) => Effect.succeed(`ns_${workspaceID}`),
  admit: ({ request: req, scope }) =>
    Effect.sync(() => {
      calls.push({ request: req, scope })
    }),
})

const conflictingWrites: NonNullable<MultiAgentRuntime.LayerOptions["partition"]> = (input) => ({
  event: input,
  subtasks: ["first", "second"].map((name) => ({
    id: `${input.id}:${name}`,
    capability: "code_edit",
    intent: `edit ${name}`,
    dependsOn: [],
    fileScope: ["src/shared.ts"],
    requiredAutonomy: "level_2" as const,
  })),
})
const rankedWrites: NonNullable<MultiAgentRuntime.LayerOptions["partition"]> = (input) => ({
  event: input,
  subtasks: conflictingWrites(input).subtasks.map((subtask, index) => ({
    ...subtask,
    diffSize: index === 0 ? 1 : 2,
  })),
})

const saved = process.env[EventAdmission.EVENT_V2_ADMISSION_ENV]

describe("C5-04 MultiAgentRuntime V2 admission dispatch branch", () => {
  beforeAll(() => {
    process.env[EventAdmission.EVENT_V2_ADMISSION_ENV] = "true"
  })
  afterAll(() => {
    if (saved === undefined) delete process.env[EventAdmission.EVENT_V2_ADMISSION_ENV]
    else process.env[EventAdmission.EVENT_V2_ADMISSION_ENV] = saved
  })

  test("flag ON + seam present: dispatch routes through the V2 bridge and SKIPS the §C coordination", async () => {
    setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
    resetRunner()
    const calls: Array<Record<string, unknown>> = []
    await withRuntime(fakeBridge(calls), (runtime) => runtime.dispatch(request()))
    // The bridge resolved the scope + admitted; the V4 runner NEVER ran (coordination skipped).
    expect(calls.length).toBe(1)
    const admitted = calls[0] as {
      request: EventDispatcher.DispatchRequest
      scope: EventAdmissionWiring.AdmissionScope
    }
    expect(admitted.request.event.id).toBeDefined()
    expect(admitted.scope.workspaceId).toBe("wrk_1")
    expect(admitted.scope.projectScopeKey).toBe("proj_1")
    expect(admitted.scope.principal).toBe("system")
    expect(admitted.scope.sessionID).toBe(parentSessionIDFor(admitted.request.event.id))
    expect(admitted.scope.authorizedTrigger).toBe(true)
    // The §C coordination path (which would run the runner) was NOT entered.
    expect(runnerRan.length).toBe(0)
  })

  test("DAG mode stays on ordinary admission while the second lane flag is OFF", async () => {
    setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
    resetRunner()
    const calls: string[] = []
    const bridge: MultiAgentRuntime.EventV2AdmissionBridge = {
      securityNamespaceFor: () => Effect.succeed("ns"),
      executionFor: () => "dag",
      admit: () =>
        Effect.sync(() => {
          calls.push("single")
        }),
      admitReceiptOnly: () =>
        Effect.sync(() => {
          calls.push("receipt")
        }),
    }
    await withRuntime(bridge, (runtime) => runtime.dispatch(request()))
    expect(calls).toEqual(["single"])
    expect(runnerRan).toEqual([])
  })

  test("DAG mode admits an ingress receipt and executes V2 child turns when explicitly enabled", async () => {
    setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
    resetRunner()
    const calls: string[] = []
    const bridge: MultiAgentRuntime.EventV2AdmissionBridge = {
      securityNamespaceFor: () => Effect.succeed("ns"),
      executionFor: () => "dag",
      admit: () =>
        Effect.sync(() => {
          calls.push("single")
        }),
      admitReceiptOnly: () =>
        Effect.sync(() => {
          calls.push("receipt")
        }),
    }
    await withRuntime(
      bridge,
      (runtime) =>
        runtime.dispatch({
          ...request(),
          event: event({ payload: { directory: "/tmp/event-repo", files: ["src/a.ts"] } }),
        }),
      undefined,
      true,
    )
    expect(calls).toEqual(["receipt"])
    expect(runnerRan).toEqual(["fixer", "fixer"])
  })

  test("DAG write turn without an absolute root defers before claiming or running", async () => {
    setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
    resetRunner()
    const calls: string[] = []
    const bridge: MultiAgentRuntime.EventV2AdmissionBridge = {
      securityNamespaceFor: () => Effect.succeed("ns"),
      executionFor: () => "dag",
      admit: () =>
        Effect.sync(() => {
          calls.push("single")
        }),
      admitReceiptOnly: () =>
        Effect.sync(() => {
          calls.push("receipt")
        }),
    }
    await withRuntime(
      bridge,
      (runtime) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(runtime.dispatch(request()))
          expect(error).toBeInstanceOf(MultiAgentRuntime.EventDAGUnfinishedError)
        }),
      undefined,
      true,
    )
    expect(calls).toEqual(["receipt"])
    expect(runnerRan).toEqual([])
  })

  test("conflicting DAG work nacks once, then replay skips the completed winner and runs the deferred node", async () => {
    setRegistry([agent("fixer", ["code_edit"], "level_2")])
    resetRunner()
    const calls: string[] = []
    const bridge: MultiAgentRuntime.EventV2AdmissionBridge = {
      securityNamespaceFor: () => Effect.succeed("ns"),
      executionFor: () => "dag",
      admit: () =>
        Effect.sync(() => {
          calls.push("single")
        }),
      admitReceiptOnly: () =>
        Effect.sync(() => {
          calls.push("receipt")
        }),
    }
    const input = {
      ...request(),
      event: event({ payload: { directory: "/tmp/event-repo", files: ["src/shared.ts"] } }),
    }
    await withRuntime(
      bridge,
      (runtime, bus) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(runtime.dispatch(input))
          expect(error).toBeInstanceOf(MultiAgentRuntime.EventDAGUnfinishedError)
          expect(runnerRan).toHaveLength(1)
          expect((yield* bus.recentByType({ type: "agent.task.completed", windowMs: 10_000, now: 1_000 })).length).toBe(
            1,
          )
          yield* runtime.dispatch(input)
          expect(runnerRan).toHaveLength(2)
          yield* runtime.dispatch(input)
          expect(runnerRan).toHaveLength(2)
          expect((yield* bus.recentByType({ type: "agent.task.completed", windowMs: 10_000, now: 1_000 })).length).toBe(
            2,
          )
        }),
      undefined,
      true,
      rankedWrites,
    )
    expect(calls).toEqual(["receipt", "receipt", "receipt"])
  })

  test("an exact conflict tie remains a deferred human arbitration outcome", async () => {
    setRegistry([agent("fixer", ["code_edit"], "level_2")])
    resetRunner()
    await withRuntime(
      fakeBridge([]),
      (runtime) =>
        Effect.gen(function* () {
          const summary = yield* runtime.coordinate(event({ payload: { directory: "/tmp/event-tie" } }))
          expect(summary.outcomes).toHaveLength(2)
          expect(
            summary.outcomes.every(
              (outcome) => outcome.status === "deferred" && outcome.reason === "conflict_needs_human",
            ),
          ).toBe(true)
          expect(summary.hasUnfinished).toBe(true)
          expect(runnerRan).toHaveLength(0)
        }),
      undefined,
      true,
      conflictingWrites,
    )
  })

  test("flag ON + seam ABSENT: dispatch fails with the typed refusal — never a silent legacy run", async () => {
    setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
    resetRunner()
    const outcome = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const ctx = yield* Layer.build(makeRuntime(undefined))
        const runtime = Context.get(ctx, MultiAgentRuntime.Service)
        return yield* runtime.dispatch(request())
      }).pipe(Effect.scoped),
    )
    // No seam → the V2 admission path is unwired; fail closed with the typed refusal.
    expect(outcome._tag).toBe("Failure")
    if (outcome._tag !== "Failure") return
    const error = Cause.squash(outcome.cause)
    expect(error).toBeInstanceOf(MultiAgentRuntime.EventV2AdmissionUnavailableError)
    expect((error as MultiAgentRuntime.EventV2AdmissionUnavailableError).reason).toBe("admission_seam_absent")
    // The legacy §C coordination never ran the turn runner.
    expect(runnerRan.length).toBe(0)
  })

  test("flag OFF + seam present: dispatch fails with the typed refusal — the legacy fallback is deleted", async () => {
    setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
    resetRunner()
    const calls: Array<Record<string, unknown>> = []
    const outcome = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const ctx = yield* Layer.build(makeRuntime(fakeBridge(calls), admissionOff))
        const runtime = Context.get(ctx, MultiAgentRuntime.Service)
        return yield* runtime.dispatch(request())
      }).pipe(Effect.scoped),
    )
    expect(outcome._tag).toBe("Failure")
    if (outcome._tag !== "Failure") return
    const error = Cause.squash(outcome.cause)
    expect(error).toBeInstanceOf(MultiAgentRuntime.EventV2AdmissionUnavailableError)
    expect((error as MultiAgentRuntime.EventV2AdmissionUnavailableError).reason).toBe("admission_switch_off")
    expect(calls.length).toBe(0) // bridge not consulted
    expect(runnerRan.length).toBe(0) // the deleted fallback: no legacy execution either
  })
})
