import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { SessionV2 } from "@deepagent-code/core/session"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { GoalControl } from "@deepagent-code/core/deepagent/goal-control"
import { GoalTickProgram } from "@deepagent-code/core/deepagent/goal-tick-program"
import { GoalTickState } from "@deepagent-code/core/deepagent/goal-tick-state"
import { GoalPlanRebase } from "@deepagent-code/core/deepagent/goal-plan-rebase"
import { GoalPlanRebaseSchema } from "@deepagent-code/core/deepagent/goal-plan-rebase.schema"
import { GoalTickCheckpoint } from "@deepagent-code/core/deepagent/goal-tick-checkpoint"
import { GoalTickCheckpointV2 } from "@deepagent-code/core/deepagent/goal-tick-checkpoint-v2"
import { GoalChildResult } from "@deepagent-code/core/deepagent/goal-child-result"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { createPlanDoc } from "@deepagent-code/core/deepagent/plan-controller"
import { Hash } from "@deepagent-code/core/util/hash"
import { GoalClient } from "@deepagent-code/core/deepagent/goal-client"
import { GoalChildFixture } from "../../../core/test/fixture/goal-child"
import { GoalControlFixture } from "../../../core/test/fixture/goal-control"
import { GoalTickProjection } from "../../src/session/goal-tick-projection"

// Durable reader snapshots using the existing plan-rebase fixture topology:
// real file SQLite, Session and Goal admission, exact documents and plan rebase.
// No model, Native execution, provider receipt or synthetic completed tick is claimed.
const authorize: GoalPlanRebase.Authority = (db, sessionID, goalID) =>
  GoalControl.requireTarget(db, goalID, sessionID).pipe(
    Effect.asVoid,
    Effect.mapError(
      () =>
        new GoalPlanRebaseSchema.Error({
          code: "AUTH_CHANGED",
          message: "Fixture target changed",
        }),
    ),
  )

const prepare = (directory: string, foreign = false) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const parent = yield* (yield* SessionV2.Service).create({
      location: { directory: AbsolutePath.make(directory) },
    })
    const requestID = `start-${parent.id}`
    const goalID = `goal_${GoalControl.fingerprint([parent.id, requestID]).slice(0, 40)}`
    const planID = `doc:plan:plan-${parent.id}`
    const spec = {
      ...GoalControlFixture.initialization.spec,
      planDocId: planID,
      limits: {
        ...GoalControlFixture.initialization.spec.limits,
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
      {
        step_id: "next",
        title: "Future source",
        status: "pending",
        acceptance: "future check",
      },
    ])
    const state = GoalTickState.requireState({
      version: 2,
      goalId: foreign ? "goal_foreign_snapshot" : goalID,
      spec,
      planDocId: planID,
      sessionId: parent.id,
      phase: "running",
      ledger: {
        ticks: 0,
        tokens: 17,
        cost: 0.125,
        costComplete: true,
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
    const root = path.join(directory, "goal-documents")
    const store = DocumentStore.openExactForCreate(
      root,
      documents.map((item) => item.id),
    )
    documents.forEach((document) => store.projectExact(document, null))
    yield* GoalControl.activate(db, { ...input, goalId: goalID })
    return { db, root, parent, goalID, planID, plan, state, documents }
  })

test("cold Goal progress reads exact durable statistics with zero writes or work", async () => {
  await GoalChildFixture.isolated(({ directory, state }) =>
    Effect.gen(function* () {
      const setup = yield* prepare(directory)
      const row = (yield* GoalControl.current(setup.db, setup.parent.id))!
      const before = yield* setup.db.all("SELECT * FROM goal_control")
      expect(yield* GoalTickProjection.progress(setup.db, row)).toEqual({
        ledger: { ticks: 0, tokens: 17, cost: 0.125, wallclockMs: 250 },
        stallCount: 2,
        gaps: [],
      })
      expect(yield* GoalTickProjection.progress(setup.db, row)).toEqual({
        ledger: { ticks: 0, tokens: 17, cost: 0.125, wallclockMs: 250 },
        stallCount: 2,
        gaps: [],
      })
      expect(yield* setup.db.all("SELECT * FROM goal_control")).toEqual(before)
      expect(state.runs).toBe(0)
    }),
  )
})

test("cold Goal progress follows a real committed plan rebase without resetting its ledger", async () => {
  await GoalChildFixture.isolated(({ directory, state }) =>
    Effect.gen(function* () {
      const setup = yield* prepare(directory)
      const first = yield* GoalPlanRebase.begin(
        setup.db,
        {
          sessionID: setup.parent.id,
          goalID: setup.goalID,
          expectedControlRevision: 1,
          requestID: "progress-rebase-begin",
        },
        authorize,
      )
      const edit = (yield* GoalPlanRebase.read(setup.db, first.current.editID))!
      const prepared = yield* GoalPlanRebase.prepare(
        setup.db,
        {
          sessionID: setup.parent.id,
          goalID: setup.goalID,
          editID: edit.edit_id,
          requestID: "progress-rebase-apply",
          expectedEditRevision: edit.revision,
          expectedControlRevision: first.current.controlRevision,
          expectedPlanRevision: 0,
          expectedDocVersion: edit.journal.source!.planDocVersion,
          expectedDocHash: edit.journal.source!.planDocHash,
          candidate: {
            steps: [setup.plan.steps[0], { ...setup.plan.steps[1], title: "Refined future work" }],
            activeStepID: null,
            dispositions: [],
          },
          reason: "Preserve recorded statistics",
        },
        setup.root,
        authorize,
      )
      for (const doc of prepared.row.journal.documents)
        yield* GoalPlanRebase.project(setup.db, edit.edit_id, doc.documentID, setup.root, authorize)
      yield* GoalPlanRebase.settle(setup.db, edit.edit_id, setup.root, authorize)
      const row = (yield* GoalControl.current(setup.db, setup.parent.id))!
      const progress = yield* GoalTickProjection.progress(setup.db, row)
      expect(row.plan_revision).toBe(1)
      expect(progress).toMatchObject({
        ledger: { ticks: 0, tokens: 17, cost: 0.125, wallclockMs: 250 },
        stallCount: 0,
      })
      expect(state.runs).toBe(0)
    }),
  )
})

test("cold Goal progress rejects a foreign runtime snapshot instead of inventing zero", async () => {
  await GoalChildFixture.isolated(({ directory, state }) =>
    Effect.gen(function* () {
      const setup = yield* prepare(directory, true)
      const row = (yield* GoalControl.current(setup.db, setup.parent.id))!
      expect(yield* GoalTickProjection.progress(setup.db, row)).toBeUndefined()
      expect(state.runs).toBe(0)
    }),
  )
})

test("cold Goal progress fences a control revision that changed during observation", async () => {
  await GoalChildFixture.isolated(({ directory, state }) =>
    Effect.gen(function* () {
      const setup = yield* prepare(directory)
      const before = (yield* GoalControl.current(setup.db, setup.parent.id))!
      yield* GoalControl.control(setup.db, {
        sessionID: setup.parent.id,
        goalId: setup.goalID,
        expectedRevision: 1,
        requestID: "progress-pause",
        action: "pause",
      })
      expect(yield* GoalTickProjection.progress(setup.db, before)).toBeUndefined()
      expect(state.runs).toBe(0)
    }),
  )
})

test("committed Goal telemetry avoids execution audits while the control baseline retains its audit", async () => {
  await GoalChildFixture.isolated(({ directory, state }) =>
    Effect.gen(function* () {
      const setup = yield* prepare(directory)
      const started = yield* GoalControl.beginTick(setup.db, {
        sessionID: setup.parent.id,
        goalId: setup.goalID,
        planDocId: setup.planID,
        revision: 1,
        seq: 0,
        expectedPlanVersion: 1,
        mode: "event",
      })
      const program: GoalTickProgram.Program = {
        version: 2,
        contract: "owned-goal-v2",
        roles: [
          {
            key: "worker.0",
            agent: "worker",
            kind: "worker",
            ordinal: 0,
            criterion: null,
            round: null,
            lens: null,
            mode: "plain",
            policyHash: GoalTickProgram.hash("no-provider reader fixture"),
            recipe: {
              id: "goal-worker-v2",
              hash: GoalTickProgram.hash("reader fixture"),
              schemaHash: GoalTickProgram.hash({ type: "string" }),
              dependencies: [],
            },
          },
        ],
        documents: setup.documents.map((document) =>
          GoalTickProgram.documentBudget(
            document,
            document.type === "plan" ? "plan" : document.type === "run_context" ? "state" : "worklog",
            16384,
          ),
        ),
        localEffectSlots: 0,
        nextStateBytes: 16384,
      }
      const begun = yield* GoalTickCheckpointV2.begin(setup.db, {
        permitID: started.permit.permit_id,
        permitToken: started.permit.token,
        program,
      })
      // Exercise the existing controller's explicit skip seam; no child or provider is admitted.
      const skipped = yield* GoalTickCheckpointV2.controllerAuthority(() => ({
        permitID: begun.permit_id,
        journalHash: begun.journal_hash,
        roles: [0],
        rule: "cheap-gate-v2" as const,
      }))(setup.db, undefined)
      const transition: GoalTickState.Transition = {
        priorStateHash: GoalTickProgram.hash(setup.state),
        tickSeq: 0,
        planVersion: 1,
        finishedAt: setup.state.ledger.startedAtMs + 350,
        phase: "running",
        outcome: "continue",
        fingerprint: "reader-only successor",
        doneCount: 1,
        evidenceCount: 1,
        metCount: 0,
        gaps: [],
        deliveredFeedback: [],
        consumedSteers: [],
        usage: [],
      }
      const next = GoalTickState.reduce(setup.state, transition)
      const documents = setup.documents.map((document) =>
        GoalTickProjection.fullDocument(
          document.type === "run_context"
            ? {
                ...document,
                version: document.version + 1,
                body: GoalTickProgram.canonical(next),
              }
            : document,
          {
            version: document.version,
            hash: `sha256:${GoalTickProgram.hash(document)}`,
          },
        ),
      )
      const projected = yield* GoalTickCheckpointV2.prepareProjection(setup.db, {
        permitID: begun.permit_id,
        revision: skipped.revision,
        directory: setup.root,
        transition,
        documents,
      })
      for (const document of documents)
        yield* GoalTickCheckpointV2.projectDocument(setup.db, {
          permitID: begun.permit_id,
          documentID: document.documentID,
          directory: setup.root,
        })
      const confirmed = (yield* GoalTickCheckpointV2.read(setup.db, begun.permit_id))!
      expect(projected.state).toBe("mirror_pending")
      const committed = yield* GoalTickCheckpointV2.settle(setup.db, {
        permitID: begun.permit_id,
        revision: confirmed.revision,
      })
      expect(committed.state).toBe("committed")
      const row = (yield* GoalControl.current(setup.db, setup.parent.id))!
      const before = yield* setup.db.all("SELECT * FROM goal_control")
      // spyOn observes the real implementation; it never supplies an audit result.
      const audit = spyOn(GoalChildResult, "inspectMany")
      try {
        expect(yield* GoalTickProjection.progress(setup.db, row)).toMatchObject({
          ledger: { ticks: 1, tokens: 17, wallclockMs: 350 },
        })
        expect(audit).not.toHaveBeenCalled()
        yield* GoalPlanRebase.baseline(setup.db, row)
        expect(audit).toHaveBeenCalledTimes(1)
      } finally {
        audit.mockRestore()
      }
      expect(yield* setup.db.all("SELECT * FROM goal_control")).toEqual(before)
      expect(state.runs).toBe(0)
    }),
  )
})

for (const invalid of [false, true])
  test(`Goal client validates optional durable progress (invalid ${invalid})`, async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        expect(request.method).toBe("GET")
        return Response.json({
          goal: {
            goalId: "goal_observed",
            planDocId: "doc:plan:observed",
            phase: "done",
            running: false,
            revision: 1,
            requestedPhase: "done",
            preparation: "ready",
            inFlight: false,
            recoveryRequired: false,
            wakeState: "published",
            replayed: false,
            progress: {
              ledger: {
                ticks: 1,
                tokens: invalid ? -1 : 16483,
                cost: 0,
                wallclockMs: 14257,
              },
              stallCount: 0,
              gaps: [],
            },
          },
        })
      },
    })
    const client: GoalClient.Client = {
      client: {
        request: async (input) => {
          const response = await fetch(new URL(input.url, server.url), {
            method: input.method,
          })
          return {
            data: await response.json(),
            response: { status: response.status },
          }
        },
      },
    }
    try {
      if (invalid) {
        await expect(GoalClient.status(client, "session_observed")).rejects.toMatchObject({
          code: "unsupported_snapshot",
        })
        return
      }
      expect((await GoalClient.status(client, "session_observed"))?.progress).toEqual({
        ledger: { ticks: 1, tokens: 16483, cost: 0, wallclockMs: 14257 },
        stallCount: 0,
        gaps: [],
      })
    } finally {
      await server.stop(true)
    }
  })
