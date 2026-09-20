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
  body: (runtime: MultiAgentRuntime.Interface) => Effect.Effect<A, unknown>,
  runtimeFeatures?: RuntimeFeatureRegistry,
): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const ctx = yield* Layer.build(makeRuntime(eventV2Admission, runtimeFeatures))
      const runtime = Context.get(ctx, MultiAgentRuntime.Service)
      return yield* body(runtime)
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
    const admitted = calls[0] as { request: EventDispatcher.DispatchRequest; scope: EventAdmissionWiring.AdmissionScope }
    expect(admitted.request.event.id).toBeDefined()
    expect(admitted.scope.workspaceId).toBe("wrk_1")
    expect(admitted.scope.projectScopeKey).toBe("proj_1")
    expect(admitted.scope.principal).toBe("system")
    expect(admitted.scope.sessionID).toBe(parentSessionIDFor(admitted.request.event.id))
    expect(admitted.scope.authorizedTrigger).toBe(true)
    // The §C coordination path (which would run the runner) was NOT entered.
    expect(runnerRan.length).toBe(0)
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
