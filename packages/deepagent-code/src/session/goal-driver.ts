import { Effect } from "effect"
import type { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import type { PlanDoc, PlanInput } from "@deepagent-code/core/deepagent/plan-controller"
import type { SessionMessage } from "@deepagent-code/core/session/message"
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

/**
 * V4.1 §S1.3 — the SessionSteer `delivery` channel goal-directed steering rides. DISTINCT from S1.1's
 * `"steer"` (drained by the parent session's own runLoop): the goal driver drains ONLY `"goal_steer"`
 * rows and the parent runLoop drains ONLY `"steer"` rows, so the two drainers on the same session id read
 * disjoint sets and never contend (the design-level race FIX). GoalManager admits with this delivery and
 * drains with it; kept here as the single source of truth so both sides agree on the channel name.
 */
export const GOAL_STEER_DELIVERY = "goal_steer" as const

/**
 * V4.1 §S1.3 — one pending goal-directed steer, as seen BETWEEN ticks. `id` is the steer's own message
 * id (the durable row key the buffer stamps consumed); `text` is the guidance the driver threads into
 * the next tick's step prompt. The driver never persists these as history messages the way S1.1's
 * child-turn drain does — a goal-tick steer's destination is the next STEP PROMPT (the child turn's
 * user-message tail), not the goal session's own transcript — so the shape is minimal.
 */
export type PendingGoalSteer = {
  readonly id: SessionMessage.ID
  readonly text: string
}

/**
 * V4.1 §S1.3 — the goal-tick steer channel the driver drains BETWEEN ticks. DELIVERY SEMANTICS: this is
 * AT-LEAST-ONCE delivery of ADVISORY guidance, NOT S1.1's exactly-once history materialization. The
 * guidance is a transient prompt string with no id-keyed dedup at the model input, and a tick is itself
 * at-least-once (see goal-loop.ts) — so a crash after the step prompt threaded the guidance but before
 * `markSteerConsumed` commits will RE-THREAD the same guidance on the next drain. That is safe and
 * intended for advisory steering (a duplicated "also handle the edge case" is harmless). What IS
 * guaranteed is NO-LOSS: guidance is never dropped, because the read is non-consuming and the stamp only
 * follows a tick that actually threaded it. Two calls:
 *   1. `pendingSteer()`  — NON-consuming read of the goal session's `goal_steer` rows, in send-order. The
 *      driver reads these, threads their text into the NEXT step prompt, runs the tick, and only THEN
 *      marks them consumed. Reading marks nothing, so a crash before `markSteerConsumed` leaves the rows
 *      pending → re-drained (and re-threaded) next iteration. No guidance is lost (at-least-once).
 *   2. `markSteerConsumed(ids)` — stamp those ids consumed AFTER the tick that absorbed them started.
 *      Backed by SessionSteer.markConsumed (consumed_seq IS NULL guard ⇒ a stamped row is never re-drained
 *      by THIS channel). Idempotent: already-consumed ids are skipped.
 */
export type GoalSteerPort = {
  readonly pendingSteer: () => Effect.Effect<ReadonlyArray<PendingGoalSteer>>
  readonly markSteerConsumed: (ids: ReadonlyArray<SessionMessage.ID>) => Effect.Effect<void>
}

/**
 * V4.1 §S1.3 — the in-memory RELAY that composes the goal-loop (outer tick driver) with S1.1 steering.
 * It is the single channel between the DRIVER (writer, BETWEEN ticks) and the STEP EXECUTOR (reader, at
 * prompt-build time inside `loop.tick`): the core `StepExecutor` signature is fixed (goalId/sessionId/
 * planDocId/activeStepId — see goal-loop.ts) and cannot carry steer text, so the guidance rides this
 * side-channel instead. Created ONCE per goal run and shared by goal-manager into BOTH `runToCompletion`
 * (as `steerRelay`) and `makeGoalLoopWiring` (which threads it through `buildStepExecutor`).
 *
 * Cadence per driver iteration (see runToCompletion): `stage(pending)` → `tick()` (the executor calls
 * `drainForPrompt()` when it builds the step prompt, recording what it actually threaded) → the driver
 * calls `takeDrained()` and marks ONLY those ids consumed. If the tick short-circuits WITHOUT running the
 * executor (terminal replay / pre-breach limit), `drainForPrompt` is never called, `takeDrained` is empty,
 * nothing is stamped consumed, and the buffer stays pending → re-threaded next run (no loss).
 */
export type GoalSteerRelay = {
  /** Driver, pre-tick: REPLACE the staged set with the current pending steers (idempotent — pendingSteer is the truth). */
  readonly stage: (steers: ReadonlyArray<PendingGoalSteer>) => void
  /** Executor, at prompt-build: take the staged steers into the step prompt and record them as threaded-this-tick. */
  readonly drainForPrompt: () => ReadonlyArray<PendingGoalSteer>
  /** Driver, post-tick: return+clear the steers the executor actually threaded, so ONLY those are stamped consumed. */
  readonly takeDrained: () => ReadonlyArray<PendingGoalSteer>
}

export const makeGoalSteerRelay = (): GoalSteerRelay => {
  let staged: ReadonlyArray<PendingGoalSteer> = []
  let drained: ReadonlyArray<PendingGoalSteer> = []
  return {
    stage: (steers) => {
      staged = [...steers]
    },
    drainForPrompt: () => {
      const out = staged
      staged = []
      if (out.length > 0) drained = [...drained, ...out]
      return out
    },
    takeDrained: () => {
      const out = drained
      drained = []
      return out
    },
  }
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
  /**
   * V4.1 §S1.3 — cooperative GOAL-LEVEL steering. Drains any user guidance directed at the GOAL (admitted
   * to the goal session's SessionSteer buffer via GoalManager.steerGoal) and threads it into the NEXT
   * tick's step prompt so the goal-worker absorbs it when selecting/executing the next step. KEYING (the
   * anti-double-consume invariant): this drains the GOAL (parent) session's buffer; the goal-worker turns
   * run in FRESH child session ids, so S1.1's intra-turn child-runLoop drain reads a DIFFERENT buffer and
   * never intercepts a goal-directed steer. Optional so existing callers / noopPorts stay valid.
   */
  readonly pendingSteer?: () => Effect.Effect<ReadonlyArray<PendingGoalSteer>>
  /**
   * V4.1 §S1.3 — mark the drained goal-steer ids consumed, AFTER the tick that absorbed them threaded
   * them into the step prompt (read-stage-then-stamp; at-least-once advisory delivery, no-loss but not
   * exactly-once). Optional; omitted ⇒ drained steers are never stamped (test stubs).
   */
  readonly markSteerConsumed?: (ids: ReadonlyArray<SessionMessage.ID>) => Effect.Effect<void>
  /**
   * V4.1 §S2 — cooperative USER PLAN EDIT. Drains a pending user plan edit (enqueued via
   * GoalManager.editPlan onto the per-session control channel) BETWEEN ticks. Returns the revised PlanDoc
   * or null. The driver applies it via loop.applyPlanEdit (durable-doc upsert + stall re-baseline) using
   * ITS OWN store handle — this is why a running goal observes the edit next tick (a separate store handle
   * from the HTTP fiber would not, DocumentStore reads from its construction-time in-memory map). Applied
   * BEFORE the tick and AFTER the previous tick's mirror-back, so no edit is clobbered by child progress
   * and no child progress is lost (§S2.3). Optional; omitted / null ⇒ no plan edit this iteration.
   */
  readonly pendingPlanEdit?: () => Effect.Effect<PlanInput | null>
  /**
   * V4.1 §S2 — clear the pending plan edit AFTER it was applied+re-baselined (consume-once). Receives the
   * exact edit object the driver drained + applied, so the port can clear the slot ONLY if it still holds
   * that same edit (identity guard) — a newer edit admitted between the drain and this call must survive.
   * Optional.
   */
  readonly markPlanEditConsumed?: (applied: PlanInput) => Effect.Effect<void>
}

/** No-op ports (fire-and-forget usage / tests that only care about the terminal outcome). */
export const noopPorts: GoalDriverPorts = {
  onStatus: () => Effect.void,
  shouldPause: () => Effect.succeed(false),
  shouldStop: () => Effect.succeed(false),
  // §S1.3: no goal-steer by default — pendingSteer yields empty, so the goal runs exactly as before.
  pendingSteer: () => Effect.succeed([]),
  markSteerConsumed: () => Effect.void,
  // §S2: no user plan edit by default — the goal runs exactly as before.
  pendingPlanEdit: () => Effect.succeed(null),
  markPlanEditConsumed: (_applied) => Effect.void,
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
  /**
   * V4.1 §S1.3 — the goal-steer RELAY shared with the StepExecutor (via makeGoalLoopWiring). When set,
   * the driver drains goal-directed steers via `ports.pendingSteer` BEFORE each tick, stages them on the
   * relay so the executor threads them into that tick's step prompt, then stamps ONLY the ids the
   * executor actually threaded as consumed. Omitted ⇒ no goal-tick steering (base behaviour unchanged).
   */
  readonly steerRelay?: GoalSteerRelay
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
        // A steer staged BEFORE a pause is NOT stamped consumed (the tick that would absorb it never
        // ran), so it stays pending and is re-drained on resume — no guidance is lost across a pause.
        // A plan edit enqueued during pause likewise stays pending on the control channel and is applied
        // on resume (drained here on the first post-resume iteration), so no edit is lost across a pause.
        return "continue"
      }

      // §S2 — apply a pending USER PLAN EDIT BETWEEN ticks (after the PREVIOUS tick's mirror-back, before
      // THIS tick). Draining here — not mid-tick — is what prevents the child-bridge clobber: the prior
      // tick's mirrorChildPlan has already written the child's progress back, so applying the user edit on
      // top preserves both (child progress + user revision). loop.applyPlanEdit upserts the durable doc
      // via the DRIVER's store handle (so the next tick's readPlan sees it) and re-baselines stall/version.
      // consume-once: stamp consumed ONLY after a successful apply; a crash before markPlanEditConsumed
      // leaves the edit pending → re-applied next iteration (idempotent: a fingerprint-identical re-upsert
      // is a no-op, and re-baseline to the same values is harmless).
      if (ports.pendingPlanEdit) {
        const editedPlan = yield* safePlanEdit(ports.pendingPlanEdit())
        if (editedPlan != null) {
          yield* safe(loop.applyPlanEdit(input.handle, editedPlan))
          // Pass the exact edit we applied so the port clears the slot ONLY if it still holds THIS edit —
          // a newer edit admitted while we were applying stays pending and is drained next iteration.
          if (ports.markPlanEditConsumed) yield* safe(ports.markPlanEditConsumed(editedPlan))
        }
      }

      // §S1.3 — absorb any GOAL-directed steer BETWEEN ticks. READ-STAGE-THEN-STAMP (at-least-once
      // advisory delivery, NOT exactly-once): drain (non-consuming read) → stage on the relay so THIS
      // tick's step prompt carries it → run the tick → stamp ONLY what the executor threaded as consumed.
      // A crash after staging but before markSteerConsumed leaves the steer pending → RE-THREADED next
      // iteration (guidance is never lost, but MAY be threaded twice — harmless for advisory steering, and
      // a tick is at-least-once anyway). `pendingSteer` is optional, so a caller wiring only pause/stop (or
      // noopPorts without a relay) behaves exactly as before.
      if (input.steerRelay && ports.pendingSteer) {
        const pending = yield* safeSteers(ports.pendingSteer())
        input.steerRelay.stage(pending)
      }

      last = yield* loop.tick(input.handle)

      // Consume-after: stamp ONLY the steers the executor actually threaded into the prompt this tick.
      // If the tick short-circuited without running the executor (terminal replay / pre-breach limit),
      // `takeDrained` is empty and nothing is stamped — the steer stays pending for the next real tick.
      if (input.steerRelay && ports.markSteerConsumed) {
        const threaded = input.steerRelay.takeDrained()
        if (threaded.length > 0) yield* safe(ports.markSteerConsumed(threaded.map((s) => s.id)))
      }

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

// §S1.3 — a pendingSteer port defect must not crash the driver: degrade to "no steer this tick" (the
// steer stays pending in the durable buffer and is re-drained next iteration — no loss).
const safeSteers = (
  effect: Effect.Effect<ReadonlyArray<PendingGoalSteer>>,
): Effect.Effect<ReadonlyArray<PendingGoalSteer>> =>
  effect.pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<PendingGoalSteer>)))

// §S2 — a pendingPlanEdit port defect must not crash the driver: degrade to "no edit this iteration"
// (the edit stays pending on the control channel and is re-drained next iteration — no loss).
const safePlanEdit = (effect: Effect.Effect<PlanInput | null>): Effect.Effect<PlanInput | null> =>
  effect.pipe(Effect.catchCause(() => Effect.succeed(null as PlanInput | null)))

const safeStatus = (
  loop: ReturnType<typeof makeGoalLoop>,
  handle: GoalHandle,
): Effect.Effect<GoalStatus | null> =>
  loop.status(handle).pipe(Effect.catchCause(() => Effect.succeed(null as GoalStatus | null)))

// Re-export the materialize helper's scope so the server route can co-locate other goal docs.
export { planScope as goalPlanScope }

export * as GoalDriver from "./goal-driver"
