import { Effect } from "effect"
import type { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import type { PlanDoc } from "@deepagent-code/core/deepagent/plan-controller"
import {
  makeGoalLoop,
  type ControllerDeps,
  type GoalHandle,
  type GoalSpec,
  type GoalStatus,
  type TickOutcome,
  type CompletionCriterion,
  type GoalLimits,
} from "@deepagent-code/core/deepagent/goal-loop"

/**
 * V3.9 §D — the GOAL DRIVER. `goal-loop.ts` (core) is a pure tick state machine; `goal-loop-wiring.ts`
 * assembles its ports (`ControllerDeps`). Neither STARTS a goal or DRIVES the ticks — that missing
 * production seam is here. The driver:
 *   1. MATERIALIZES the goal's plan into a `type:"plan"` DocumentStore doc (`materializePlanDoc`) — the
 *      loop reads a store doc as the goal carrier, while the `plan` tool writes in-memory session-state
 *      (two disconnected stores). Per the product decision, a goal is started FROM a plan the user
 *      produced in plan mode: this snapshots that in-memory plan into the store doc the loop grades.
 *   2. STARTS the loop (`makeGoalLoop(deps).start(spec)`), returning a GoalHandle.
 *   3. DRIVES ticks in the background until a terminal outcome (`runToCompletion`), publishing status via
 *      injected ports (so the server wires the real GoalEvent + session-state pointer, and tests assert
 *      the loop mechanics with a stub). Pause is cooperative: the driver checks `shouldPause()` before
 *      each tick and suspends without tearing down the loop (the persisted run_context doc means an
 *      unpause resumes exactly).
 *
 * The driver never elevates permission and never executes tools itself — every step runs through the
 * injected executor (a goal-worker child-session turn), exactly as the loop contract requires (§D.6).
 */

/** A single completion criterion the user's goal must satisfy (mirrors the core union, re-exported for callers). */
export type GoalCriterion = CompletionCriterion

export type MaterializePlanInput = {
  readonly store: DocumentStore
  readonly sessionId: string
  /** The in-memory plan (from the `plan` tool's session-state) to snapshot into the store. */
  readonly plan: PlanDoc
}

/** planScope(sessionId) = "run:<sessionId>" — every goal doc co-locates under the session's run scope. */
const planScope = (sessionId: string): string => `run:${sessionId}`

/**
 * Snapshot an in-memory PlanDoc into a `type:"plan"` store doc (the goal carrier). Idempotent per
 * session: `upsert` keyed on the stable `plan-<sessionId>` slug returns the same doc id and is a no-op
 * when the body is unchanged (INV-4), so re-materializing the same plan does not bump the version.
 * Returns the plan doc id the GoalSpec references.
 */
export const materializePlanDoc = (input: MaterializePlanInput): string => {
  const doc = input.store.upsert({
    type: "plan",
    scope: planScope(input.sessionId),
    description: `goal plan ${input.sessionId}`,
    idSlug: `plan-${input.sessionId}`,
    body: JSON.stringify(input.plan),
    provenance: { source: "model", run_ref: planScope(input.sessionId) },
  })
  return doc.id
}

/** Ports the driver publishes progress through — the server wires real ones; tests inject stubs. */
export type GoalDriverPorts = {
  /** Called with each new status after a tick (server → GoalEvent + session-state pointer). Best-effort. */
  readonly onStatus: (status: GoalStatus) => Effect.Effect<void>
  /**
   * Cooperative pause check evaluated BEFORE each tick. When true, the driver suspends: it stops ticking
   * and returns control WITHOUT marking the loop terminal (the persisted state resumes on the next
   * runToCompletion). The server backs this with the session-state pointer phase === "paused".
   */
  readonly shouldPause: () => Effect.Effect<boolean>
  /** True once the user requested a hard stop — the driver stops the loop and exits. */
  readonly shouldStop: () => Effect.Effect<boolean>
}

/** No-op ports (fire-and-forget usage / tests that only care about the terminal outcome). */
export const noopPorts: GoalDriverPorts = {
  onStatus: () => Effect.void,
  shouldPause: () => Effect.succeed(false),
  shouldStop: () => Effect.succeed(false),
}

export type StartGoalInput = {
  readonly deps: ControllerDeps
  readonly planDocId: string
  readonly criteria: readonly GoalCriterion[]
  readonly limits: GoalLimits
  readonly stallThreshold?: number
}

/** Build the GoalSpec + start the loop. Surfaces the core InvalidGoalError to the caller (route → 400). */
export const startGoal = (input: StartGoalInput) => {
  const loop = makeGoalLoop(input.deps)
  const spec: GoalSpec = {
    planDocId: input.planDocId,
    criteria: input.criteria,
    limits: input.limits,
    stallThreshold: input.stallThreshold ?? 3,
  }
  return Effect.map(loop.start(spec), (handle) => ({ loop, handle }))
}

/** Whether an outcome is terminal (the loop is done / escalated / rolled back — not "continue"). */
const isTerminalOutcome = (outcome: TickOutcome): boolean => outcome !== "continue"

export type RunToCompletionInput = {
  readonly deps: ControllerDeps
  readonly handle: GoalHandle
  readonly ports?: GoalDriverPorts
  /** Hard cap on driver iterations as a belt-and-braces guard above the loop's own maxTicks. */
  readonly maxIterations?: number
}

/**
 * Drive ticks until a terminal outcome, a pause, or a hard stop. Returns the last outcome (or "continue"
 * when it exited due to pause — the caller learns pause via the ports). Never throws: the loop's tick
 * lives on `never`, and the driver wraps status/port calls so a defect cannot crash the background task.
 */
export const runToCompletion = (input: RunToCompletionInput): Effect.Effect<TickOutcome> =>
  Effect.gen(function* () {
    const loop = makeGoalLoop(input.deps)
    const ports = input.ports ?? noopPorts
    const maxIterations = input.maxIterations ?? 10_000
    let last: TickOutcome = "continue"

    for (let i = 0; i < maxIterations; i++) {
      if (yield* safeBool(ports.shouldStop())) {
        yield* safe(loop.stop(input.handle))
        return "needs_human"
      }
      if (yield* safeBool(ports.shouldPause())) {
        // Cooperative suspend: do NOT tick, do NOT mark terminal — the persisted state resumes later.
        return "continue"
      }

      last = yield* loop.tick(input.handle)
      const status = yield* safeStatus(loop, input.handle)
      if (status) yield* safe(ports.onStatus(status))

      if (isTerminalOutcome(last)) return last
    }
    // Exhausted the driver guard without a terminal outcome — treat as needs_human (never loop forever).
    return "needs_human"
  })

// The loop's tick/status/stop already live on `never`, but the injected ports do not — wrap them so a
// port defect degrades to a safe default and never crashes the background driver.
const safe = <A>(effect: Effect.Effect<A>): Effect.Effect<void> =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCause(() => Effect.void),
  )

const safeBool = (effect: Effect.Effect<boolean>): Effect.Effect<boolean> =>
  effect.pipe(Effect.catchCause(() => Effect.succeed(false)))

const safeStatus = (
  loop: ReturnType<typeof makeGoalLoop>,
  handle: GoalHandle,
): Effect.Effect<GoalStatus | null> =>
  loop.status(handle).pipe(Effect.catchCause(() => Effect.succeed(null as GoalStatus | null)))

// Re-export the materialize helper's scope so the server route can co-locate other goal docs.
export { planScope as goalPlanScope }

export * as GoalDriver from "./goal-driver"
