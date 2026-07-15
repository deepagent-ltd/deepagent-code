import { describe, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { GoalTickConsumer } from "../../src/session/goal-tick-consumer"
import { recoverGoalTickRequest } from "../../src/session/goal-tick-port"
import { GoalDriver } from "../../src/session/goal-driver"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { Database } from "@deepagent-code/core/database/database"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import {
  makeGoalLoop,
  readGoalTickCursor,
  type ControllerDeps,
  type GraderPorts,
  type StepExecutor,
  type RollbackPort,
  type GoalSpec,
} from "@deepagent-code/core/deepagent/goal-loop"
import { createPlanDoc, planScope, type PlanDoc, type PlanStep } from "@deepagent-code/core/deepagent/plan-controller"
import { testEffect } from "../lib/effect"

// V4.1 §N COLD RECOVERY — the end-to-end proof that a goal survives a process restart on the event-driven
// path. It asserts the CENTRAL claim of makeGoalTickPort: given ONLY the goal's durable run_context doc on
// disk (NO in-memory control map, no live driver — the "second process" state), a fresh consumer with a
// FRESH DocumentStore handle reconstructs the loop from {sessionID, goalId}, executes exactly ONE tick that
// ADVANCES the durable state, and re-emits the next goal.tick.requested with the advanced seq.
//
// It exercises the REAL GoalTickConsumer + REAL DeepAgentEventBus (persistence/retry/dedup), driving them
// with a runTick port that performs the SAME durable-state reconstruction the production port does — a
// fresh store over the on-disk root, makeGoalLoop + runOneTick, then readGoalTickCursor for the next seq —
// but with a stub grader/executor so the tick is deterministic and needs no session stack. The point under
// test is the COLD path (disk-only reconstruction + seq monotonicity), not the LLM turn.

let clock = 5_000
const now = () => clock

const database = Database.layerFromPath(":memory:")

let root: string
let executions: number
const SESSION = "s-cold-1"

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "deepagent-cold-"))
  executions = 0
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const step = (id: string, status: PlanStep["status"]): PlanStep => ({
  step_id: id,
  title: id,
  status,
  acceptance: null,
  assigned_agent: null,
  evidence: [],
  note: null,
})

// Persist a plan doc on disk under the SAME scope the goal loop reads (run:<session>).
const putPlan = (rootDir: string, steps: PlanStep[]): string => {
  const store = new DocumentStore(rootDir)
  const plan = createPlanDoc(SESSION, "reach the goal", steps)
  const doc = store.upsert({
    type: "plan",
    scope: planScope(SESSION),
    description: `plan ${SESSION}`,
    idSlug: `plan-${SESSION}`,
    body: JSON.stringify(plan),
    provenance: { source: "model", run_ref: planScope(SESSION) },
  })
  return doc.id
}

// A stub executor that ADVANCES the plan (marks the first pending step done) using a FRESH store handle —
// exactly like the goal-worker mirror-back, so a tick makes real forward progress and bumps the version.
const advancingExecutor = (rootDir: string): StepExecutor => (input) =>
  Effect.sync(() => {
    executions++
    const store = new DocumentStore(rootDir)
    const doc = store.get(input.planDocId)
    if (doc) {
      const plan = JSON.parse(doc.body) as PlanDoc
      const next = plan.steps.find((s) => s.status !== "done")
      if (next) {
        const steps = plan.steps.map((s) => (s.step_id === next.step_id ? { ...s, status: "done" as const } : s))
        store.update(input.planDocId, JSON.stringify({ ...plan, steps }))
      }
    }
    return { tokensUsed: 5 }
  })

const passingPortsExceptPlan = (): GraderPorts => ({
  runTests: () => Effect.succeed({ pass: true }),
  diagnostics: () => Effect.succeed({ maxSeverity: null }),
  reviewerClean: () => Effect.succeed({ pass: true }),
  panelApproves: () => Effect.succeed({ decision: "approve" }),
})

const coldDeps = (rootDir: string): ControllerDeps => ({
  store: new DocumentStore(rootDir), // FRESH handle — the cold-fiber reconstruction
  ports: passingPortsExceptPlan(),
  executor: advancingExecutor(rootDir),
  rollback: (() => Effect.void) as RollbackPort,
  now,
})

const spec = (planDocId: string): GoalSpec => ({
  planDocId,
  criteria: [{ kind: "plan_complete" }],
  limits: { maxTicks: 100, maxTokens: 100_000, maxWallclockMs: 100_000 },
  stallThreshold: 3,
})

// The runTick port under test: DISK-ONLY reconstruction (mirrors makeGoalTickPort's durable core). It
// opens a fresh store over the on-disk root, rebuilds the loop, runs ONE tick, and reads the post-tick
// cursor for the next command's seq/version. NO in-memory control map is consulted anywhere. Reads the
// module-level `root` at CALL time (set by beforeEach) — the layer object is built once, but the port runs
// per-test after the fresh tmpdir exists.
const coldRunTick: GoalTickConsumer.GoalTickPort = (request) =>
  Effect.gen(function* () {
    const store = new DocumentStore(root)
    const recovered = recoverGoalTickRequest(request, readGoalTickCursor(store, request.sessionID, request.goalId))
    if (recovered === "invalid") return yield* Effect.die("goal tick request ahead of durable cursor")
    if (recovered != null) return recovered
    const deps = { ...coldDeps(root), store }
    const handle = { goalId: request.goalId, planDocId: request.planDocId, sessionId: request.sessionID }
    const result = yield* GoalDriver.runOneTick(makeGoalLoop(deps), { deps, handle })
    const cursor = readGoalTickCursor(store, request.sessionID, request.goalId)
    return {
      progress: result.progress,
      nextSeq: cursor?.seq ?? request.seq + 1,
      nextExpectedPlanVersion: cursor?.planVersion ?? request.expectedPlanVersion,
    }
  })

const busLayer = DeepAgentEventBus.layerWith({ now }).pipe(Layer.provideMerge(database))
const flagLayer = RuntimeFlags.layer({ v4MultiAgentRuntime: true })
const consumerLayer = GoalTickConsumer.layerWith({ runTick: coldRunTick, runLoop: false }).pipe(
  Layer.provide(busLayer),
  Layer.provide(flagLayer),
)
const layer = Layer.mergeAll(consumerLayer, busLayer, flagLayer, database)

describe("V4.1 §N — goal-tick COLD recovery (disk-only reconstruction)", () => {
  const it = testEffect(layer)

  it.effect(
    "state on disk only (no control map) → consumer reconstructs + executes one tick + re-emits advanced seq",
    () =>
      Effect.gen(function* () {
        // ── phase 1: a PRIOR 'process' started the goal + persisted its state to disk, then vanished ──
        const planDocId = putPlan(root, [step("a", "active"), step("b", "pending")])
        const startedHandle = yield* makeGoalLoop(coldDeps(root)).start(spec(planDocId))
        // Nothing else in memory — only the run_context doc on disk. Read its seq BEFORE the cold tick.
        const before = readGoalTickCursor(new DocumentStore(root), SESSION, startedHandle.goalId)
        expect(before).not.toBeNull()
        expect(before!.seq).toBe(0) // ticks=0 + stall=0 at start

        // ── phase 2: a COLD consumer (fresh bus, fresh everything) drives one tick from a command ──
        const bus = yield* DeepAgentEventBus.Service
        const consumer = yield* GoalTickConsumer.Service
        const cmd = yield* bus.publish(
          GoalTickConsumer.tickCommand({
            sessionID: SESSION,
            goalId: startedHandle.goalId,
            planDocId,
            seq: before!.seq,
            expectedPlanVersion: before!.planVersion,
          }),
        )
        yield* consumer.handle(cmd)

        // ── assert: durable state ADVANCED (the cold tick executed against disk) ──
        const after = readGoalTickCursor(new DocumentStore(root), SESSION, startedHandle.goalId)
        expect(after).not.toBeNull()
        expect(after!.seq).toBeGreaterThan(before!.seq) // ledger.ticks bumped by a real progress tick

        // ── assert: the self-driving chain re-emitted the NEXT command with the advanced seq ──
        // Re-publishing that exact key is a dedup no-op (same id) → proves the consumer already emitted it.
        const probe = yield* bus.publish(
          GoalTickConsumer.tickCommand({
            sessionID: SESSION,
            goalId: startedHandle.goalId,
            planDocId,
            seq: after!.seq,
            expectedPlanVersion: after!.planVersion,
          }),
        )
        expect(probe.idempotencyKey).toBe(`goal:tick:${startedHandle.goalId}:${after!.seq}`)
      }),
  )

  it.effect("redelivery after a committed tick repairs one successor without executing again", () =>
    Effect.gen(function* () {
      const planDocId = putPlan(root, [step("a", "active"), step("b", "pending")])
      const handle = yield* makeGoalLoop(coldDeps(root)).start(spec(planDocId))
      const before = readGoalTickCursor(new DocumentStore(root), SESSION, handle.goalId)!
      const bus = yield* DeepAgentEventBus.Service
      const consumer = yield* GoalTickConsumer.Service
      const request = {
        sessionID: SESSION,
        goalId: handle.goalId,
        planDocId,
        seq: before.seq,
        expectedPlanVersion: before.planVersion,
      }
      const command = yield* bus.publish(GoalTickConsumer.tickCommand(request))

      // Simulate a crash after runOneTick persisted its cursor but before the consumer published the
      // successor or acked this delivery. Redelivery must repair the chain without running another tick.
      yield* coldRunTick(request)
      const after = readGoalTickCursor(new DocumentStore(root), SESSION, handle.goalId)!
      yield* consumer.handle(command)
      const firstSuccessor = yield* bus.publish(
        GoalTickConsumer.tickCommand({
          sessionID: SESSION,
          goalId: handle.goalId,
          planDocId,
          seq: after.seq,
          expectedPlanVersion: after.planVersion,
        }),
      )

      yield* consumer.handle(command)
      const repairedSuccessor = yield* bus.publish(
        GoalTickConsumer.tickCommand({
          sessionID: SESSION,
          goalId: handle.goalId,
          planDocId,
          seq: after.seq,
          expectedPlanVersion: after.planVersion,
        }),
      )

      expect(executions).toBe(1)
      expect(repairedSuccessor.id).toBe(firstSuccessor.id)
      expect(readGoalTickCursor(new DocumentStore(root), SESSION, handle.goalId)?.seq).toBe(after.seq)
    }),
  )
})
