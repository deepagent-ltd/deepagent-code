import { Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import path from "node:path"
import { Database } from "../../src/database/database"
import { SessionV2 } from "../../src/session"
import { AbsolutePath } from "../../src/schema"
import { GoalControl } from "../../src/deepagent/goal-control"
import { GoalTickProgram } from "../../src/deepagent/goal-tick-program"
import { GoalTickState } from "../../src/deepagent/goal-tick-state"
import { GoalPlanRebase } from "../../src/deepagent/goal-plan-rebase"
import { GoalPlanRebaseSchema } from "../../src/deepagent/goal-plan-rebase.schema"
import { GoalTickCheckpoint } from "../../src/deepagent/goal-tick-checkpoint"
import { GoalTickCheckpointV2 } from "../../src/deepagent/goal-tick-checkpoint-v2"
import { DocumentStore } from "../../src/deepagent/document-store"
import { createPlanDoc } from "../../src/deepagent/plan-controller"
import { Hash } from "../../src/util/hash"
import { GoalChildFixture } from "../fixture/goal-child"
import { GoalControlFixture } from "../fixture/goal-control"

export const authorize: GoalPlanRebase.Authority = (db, sessionID, goalID) =>
  GoalControl.requireTarget(db, goalID, sessionID).pipe(
    Effect.asVoid,
    Effect.mapError(
      () => new GoalPlanRebaseSchema.Error({ code: "AUTH_CHANGED", message: "Actual native target changed" }),
    ),
  )

export const prepare = (
  directory: string,
  spent?: { tokens: number; costComplete: boolean; maxCost?: number },
  documentRoot?: (sessionID: string) => string,
) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const parent = yield* (yield* SessionV2.Service).create({ location: { directory: AbsolutePath.make(directory) } })
    const requestID = `start-${parent.id}`
    const goalID = `goal_${GoalControl.fingerprint([parent.id, requestID]).slice(0, 40)}`
    const planID = `doc:plan:plan-${parent.id}`
    const spec = {
      ...GoalControlFixture.initialization.spec,
      planDocId: planID,
      limits: {
        ...GoalControlFixture.initialization.spec.limits,
        ...(spent?.maxCost === undefined ? {} : { maxCost: spent.maxCost }),
      },
    }
    const plan = createPlanDoc(parent.id, "Preserve completed work while editing future work", [
      {
        step_id: "done",
        title: "Completed source",
        status: "done",
        acceptance: "verified",
        evidence: ["original-proof"],
      },
      { step_id: "next", title: "Future source", status: "pending", acceptance: "future check" },
    ])
    const state = GoalTickState.requireState({
      version: 2,
      goalId: goalID,
      spec,
      planDocId: planID,
      sessionId: parent.id,
      phase: "running",
      ledger: {
        ticks: 0,
        tokens: spent?.tokens ?? 17,
        cost: 0.125,
        costComplete: spent?.costComplete ?? true,
        wallclockMs: 250,
        startedAtMs: Date.now() - 250,
      },
      stallCount: 2,
      lastFingerprint: "old-progress",
      lastDoneCount: 1,
      lastEvidenceCount: 1,
      lastMetCount: 0,
      lastProcessedVersion: null,
      lastOutcome: null,
      gaps: [],
      lastDeliveredFeedback: [],
      pendingSteers: [],
      budgetTokenScope: "gross",
      lastTransitionHash: null,
      haltReason: null,
    })
    const template = (
      id: string,
      type: GoalTickProgram.DocumentPayload["type"],
      body: string,
    ): GoalTickProgram.DocumentPayload => ({
      id,
      type,
      scope: `run:${parent.id}`,
      status: "draft",
      version: 1,
      superseded_by: null,
      created_round: null,
      domain: null,
      tags: [],
      description: "Goal rebase fixture",
      provenance: { source: "runner", run_ref: `run:${parent.id}` },
      links: [],
      body,
    })
    const documents = [
      template(planID, "plan", JSON.stringify(plan)),
      template(`doc:run_context:${goalID}`, "run_context", GoalTickProgram.canonical(state)),
      template(`doc:worklog:${goalID}`, "worklog", "original-history"),
    ]
    const initial = {
      ...GoalControlFixture.initialization,
      spec,
      planHash: Hash.sha256(documents[0].body),
      executionContract: "owned-goal-v2" as const,
      ownedPreparation: {
        parentHash: GoalControl.fingerprint(GoalTickCheckpoint.authority(yield* GoalControl.session(db, parent.id))),
        panel: { question: "test", lenses: ["correctness"], codeRefs: [] },
        documents: documents.map((doc): typeof GoalTickProgram.FullDocument.Type => ({
          documentID: doc.id,
          expectedVersion: null,
          expectedHash: null,
          payload: GoalTickProgram.canonical(doc),
          payloadHash: GoalTickProgram.hash(GoalTickProgram.canonical(doc)),
          state: "pending",
          observedVersion: null,
          observedHash: null,
        })),
      },
    }
    const input = {
      sessionID: parent.id,
      requestID,
      requestHash: GoalControl.fingerprint(parent.id),
      planDocId: planID,
      initialization: initial,
      driverMode: "event" as const,
    }
    yield* GoalControl.reserveStart(db, input)
    const root = documentRoot?.(parent.id) ?? path.join(directory, "goal-documents")
    const store = DocumentStore.openExactForCreate(
      root,
      documents.map((item) => item.id),
    )
    documents.forEach((document) => store.projectExact(document, null))
    yield* GoalControl.activate(db, { ...input, goalId: goalID })
    return { db, root, parent, goalID, planID, plan, state, documents }
  })

export * as GoalPlanClientFixture from "./goal-plan-client"
