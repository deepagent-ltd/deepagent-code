import { expect, test } from "bun:test"
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

const authorize: GoalPlanRebase.Authority = (db, sessionID, goalID) =>
  GoalControl.requireTarget(db, goalID, sessionID).pipe(
    Effect.asVoid,
    Effect.mapError(
      () => new GoalPlanRebaseSchema.Error({ code: "AUTH_CHANGED", message: "Actual native target changed" }),
    ),
  )

const prepare = (directory: string, spent?: { tokens: number; costComplete: boolean; maxCost?: number }) =>
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
    const root = path.join(directory, "goal-documents")
    const store = DocumentStore.openExactForCreate(
      root,
      documents.map((item) => item.id),
    )
    documents.forEach((document) => store.projectExact(document, null))
    yield* GoalControl.activate(db, { ...input, goalId: goalID })
    return { db, root, parent, goalID, planID, plan, state, documents }
  })

test("plan rebase persists exact immutable ACK, all Docs, ledger, and structural generation without execution", async () => {
  await GoalChildFixture.isolated(({ directory, state }) =>
    Effect.gen(function* () {
      const setup = yield* prepare(directory)
      const begin = {
        sessionID: setup.parent.id,
        goalID: setup.goalID,
        expectedControlRevision: 1,
        requestID: "begin-one",
      }
      const first = yield* GoalPlanRebase.begin(setup.db, begin, authorize)
      const row = (yield* GoalPlanRebase.read(setup.db, first.current.editID))!
      const apply: GoalPlanRebaseSchema.Apply = {
        sessionID: setup.parent.id,
        goalID: setup.goalID,
        editID: row.edit_id,
        requestID: "apply-one",
        expectedEditRevision: row.revision,
        expectedControlRevision: first.current.controlRevision,
        expectedPlanRevision: 0,
        expectedDocVersion: row.journal.source!.planDocVersion,
        expectedDocHash: row.journal.source!.planDocHash,
        candidate: {
          steps: [setup.plan.steps[0], { ...setup.plan.steps[1], title: "Revised future title" }],
          activeStepID: null,
          dispositions: [],
        },
        reason: "Refine future acceptance",
      }
      const prepared = yield* GoalPlanRebase.prepare(setup.db, apply, setup.root, authorize)
      expect(prepared.row.journal.fileStarted).toBe(false)
      for (const doc of prepared.row.journal.documents)
        yield* GoalPlanRebase.project(setup.db, row.edit_id, doc.documentID, setup.root, authorize)
      const committed = yield* GoalPlanRebase.settle(setup.db, row.edit_id, setup.root, authorize)
      const ack = yield* GoalPlanRebase.response(setup.db, committed, apply.requestID, false, authorize)
      expect(ack.originalReceipt).toMatchObject({ state: "committed", targetPlanRevision: 1, partial: false })
      expect(ack.current.safeToResume).toBe(true)
      const retry = yield* GoalPlanRebase.prepare(setup.db, apply, setup.root, authorize)
      expect(
        (yield* GoalPlanRebase.response(setup.db, retry.row, apply.requestID, true, authorize)).originalReceipt,
      ).toEqual(ack.originalReceipt)
      expect((yield* GoalPlanRebase.begin(setup.db, begin, authorize)).originalReceipt).toEqual(first.originalReceipt)
      const changed = yield* GoalPlanRebase.prepare(
        setup.db,
        { ...apply, reason: "conflicting retry" },
        setup.root,
        authorize,
      ).pipe(Effect.flip)
      expect(changed).toMatchObject({ code: "REQUEST_CONFLICT" })
      const runtime = Schema.decodeUnknownSync(Schema.fromJsonString(GoalTickState.Runtime))(
        committed.journal.nextState!,
      )
      expect(runtime.ledger).toEqual(setup.state.ledger)
      expect(runtime.version).toBe(3)
      expect(runtime.stallCount).toBe(0)
      const resumed = yield* GoalControl.control(setup.db, {
        sessionID: setup.parent.id,
        goalId: setup.goalID,
        expectedRevision: ack.current.controlRevision,
        requestID: "resume-edit",
        action: "resume",
      })
      expect(
        (yield* GoalPlanRebase.response(setup.db, committed, apply.requestID, true, authorize)).current.execution,
      ).toBe("running")
      const next = yield* GoalControl.beginTick(setup.db, {
        sessionID: setup.parent.id,
        goalId: setup.goalID,
        planDocId: setup.planID,
        revision: resumed.revision,
        seq: 0,
        expectedPlanVersion: 2,
        mode: "event",
      })
      expect(next.permit.plan_version).toBe(2)
      expect(state.runs).toBe(0)
      expect(state.shells).toBe(0)
      expect(yield* setup.db.get<{ count: number }>(sql`SELECT count(*) AS count FROM session_input`)).toEqual({
        count: 0,
      })
    }),
  )
})

test("completed steps cannot change and prepared partial edits fence resume, cancellation and competing clients", async () => {
  await GoalChildFixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const setup = yield* prepare(directory)
      const first = yield* GoalPlanRebase.begin(
        setup.db,
        { sessionID: setup.parent.id, goalID: setup.goalID, expectedControlRevision: 1, requestID: "begin-partial" },
        authorize,
      )
      const row = (yield* GoalPlanRebase.read(setup.db, first.current.editID))!
      const base: GoalPlanRebaseSchema.Apply = {
        sessionID: setup.parent.id,
        goalID: setup.goalID,
        editID: row.edit_id,
        requestID: "apply-partial",
        expectedEditRevision: row.revision,
        expectedControlRevision: first.current.controlRevision,
        expectedPlanRevision: 0,
        expectedDocVersion: 1,
        expectedDocHash: row.journal.source!.planDocHash,
        candidate: { steps: setup.plan.steps, activeStepID: null, dispositions: [] },
        reason: "Future work",
      }
      expect(
        yield* GoalPlanRebase.prepare(
          setup.db,
          {
            ...base,
            candidate: {
              ...base.candidate,
              steps: [{ ...setup.plan.steps[0], title: "rewrite proof" }, setup.plan.steps[1]],
            },
          },
          setup.root,
          authorize,
        ).pipe(Effect.flip),
      ).toMatchObject({ code: "IMMUTABLE_COMPLETED_STEP" })
      expect(yield* GoalControl.command(setup.db, setup.parent.id, base.requestID)).toBeUndefined()
      const prepared = yield* GoalPlanRebase.prepare(setup.db, base, setup.root, authorize)
      const partial = yield* GoalPlanRebase.project(
        setup.db,
        row.edit_id,
        prepared.row.journal.documents[0].documentID,
        setup.root,
        authorize,
      )
      expect(partial.journal.fileStarted).toBe(true)
      const target = {
        sessionID: base.sessionID,
        goalID: base.goalID,
        editID: base.editID,
        requestID: "cancel-partial",
        expectedEditRevision: partial.revision,
        expectedControlRevision: first.current.controlRevision,
      }
      expect(yield* GoalPlanRebase.cancel(setup.db, target, authorize).pipe(Effect.flip)).toMatchObject({
        code: "RECOVERY_REQUIRED",
      })
      expect(
        (yield* GoalControl.control(setup.db, {
          sessionID: base.sessionID,
          goalId: base.goalID,
          expectedRevision: first.current.controlRevision,
          requestID: "resume-partial",
          action: "resume",
        }).pipe(Effect.flip)).code,
      ).toBe("busy")
      const recovery = { ...target, requestID: "recover-partial" }
      yield* GoalPlanRebase.reconcile(setup.db, recovery, authorize)
      yield* GoalPlanRebase.reconcile(setup.db, recovery, authorize)
      for (const doc of partial.journal.documents)
        yield* GoalPlanRebase.project(setup.db, row.edit_id, doc.documentID, setup.root, authorize)
      const complete = yield* GoalPlanRebase.settle(setup.db, row.edit_id, setup.root, authorize)
      expect(complete.journal.commands).toHaveLength(3)
      expect(complete.journal.commands.every((item) => item.receipt !== null)).toBe(true)
    }),
  )
})

test("first-file marker permits prepared cancellation before any projection and prevents a second active edit", async () => {
  await GoalChildFixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const setup = yield* prepare(directory)
      const first = yield* GoalPlanRebase.begin(
        setup.db,
        { sessionID: setup.parent.id, goalID: setup.goalID, expectedControlRevision: 1, requestID: "begin-cancel" },
        authorize,
      )
      expect(
        yield* GoalPlanRebase.begin(
          setup.db,
          {
            sessionID: setup.parent.id,
            goalID: setup.goalID,
            expectedControlRevision: first.current.controlRevision,
            requestID: "begin-competing",
          },
          authorize,
        ).pipe(Effect.flip),
      ).toMatchObject({ code: "TARGET_CONFLICT" })
      const row = (yield* GoalPlanRebase.read(setup.db, first.current.editID))!
      const prepared = yield* GoalPlanRebase.prepare(
        setup.db,
        {
          sessionID: setup.parent.id,
          goalID: setup.goalID,
          editID: row.edit_id,
          requestID: "prepare-cancel",
          expectedEditRevision: row.revision,
          expectedControlRevision: first.current.controlRevision,
          expectedPlanRevision: 0,
          expectedDocVersion: 1,
          expectedDocHash: row.journal.source!.planDocHash,
          candidate: { steps: setup.plan.steps, activeStepID: null, dispositions: [] },
          reason: "Cancelled before file work",
        },
        setup.root,
        authorize,
      )
      const cancelled = yield* GoalPlanRebase.cancel(
        setup.db,
        {
          sessionID: setup.parent.id,
          goalID: setup.goalID,
          editID: row.edit_id,
          requestID: "cancel-ready",
          expectedEditRevision: prepared.row.revision,
          expectedControlRevision: first.current.controlRevision,
        },
        authorize,
      )
      expect(cancelled.current).toMatchObject({ state: "cancelled", planRevision: 0, safeToResume: true })
      GoalPlanRebase.requireDocuments(row, setup.root, false)
      const another = yield* GoalPlanRebase.begin(
        setup.db,
        {
          sessionID: setup.parent.id,
          goalID: setup.goalID,
          expectedControlRevision: cancelled.current.controlRevision,
          requestID: "begin-after-cancel",
        },
        authorize,
      )
      expect(another.originalReceipt?.targetPlanRevision).toBe(1)
    }),
  )
})

test("actual parent mutation after readiness and external Doc mutation reject before any file marker", async () => {
  await GoalChildFixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const setup = yield* prepare(directory)
      const first = yield* GoalPlanRebase.begin(
        setup.db,
        {
          sessionID: setup.parent.id,
          goalID: setup.goalID,
          expectedControlRevision: 1,
          requestID: "begin-parent-change",
        },
        authorize,
      )
      const row = (yield* GoalPlanRebase.read(setup.db, first.current.editID))!
      const input = {
        sessionID: setup.parent.id,
        goalID: setup.goalID,
        editID: row.edit_id,
        requestID: "apply-parent-change",
        expectedEditRevision: row.revision,
        expectedControlRevision: first.current.controlRevision,
        expectedPlanRevision: 0,
        expectedDocVersion: 1,
        expectedDocHash: row.journal.source!.planDocHash,
        candidate: { steps: setup.plan.steps, activeStepID: null, dispositions: [] },
        reason: "Refine future work",
      }
      const store = DocumentStore.openExact(
        setup.root,
        setup.documents.map((doc) => doc.id),
      )
      store.update(setup.planID, setup.documents[0].body + " ")
      expect(yield* GoalPlanRebase.prepare(setup.db, input, setup.root, authorize).pipe(Effect.flip)).toMatchObject({
        code: "PLAN_CONFLICT",
      })
      expect((yield* GoalPlanRebase.read(setup.db, row.edit_id))!.journal.fileStarted).toBe(false)
      expect(yield* GoalControl.command(setup.db, setup.parent.id, input.requestID)).toBeUndefined()
      yield* setup.db.run(
        sql`UPDATE session SET permission='[{"action":"plan","resource":"*","effect":"deny"}]' WHERE id=${setup.parent.id}`,
      )
      expect(yield* GoalPlanRebase.prepare(setup.db, input, setup.root, authorize).pipe(Effect.flip)).toMatchObject({
        code: "PARENT_CHANGED",
      })
      expect((yield* GoalPlanRebase.read(setup.db, row.edit_id))!.revision).toBe(row.revision)
    }),
  )
})

test("full journal decoding rejects missing durable first-file proof and cold read performs zero writes", async () => {
  await GoalChildFixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const setup = yield* prepare(directory)
      const first = yield* GoalPlanRebase.begin(
        setup.db,
        {
          sessionID: setup.parent.id,
          goalID: setup.goalID,
          expectedControlRevision: 1,
          requestID: "begin-strict-read",
        },
        authorize,
      )
      const row = (yield* GoalPlanRebase.read(setup.db, first.current.editID))!
      const malformed = Object.fromEntries(Object.entries(row.journal).filter(([key]) => key !== "fileStarted"))
      yield* setup.db.run(
        sql`UPDATE goal_plan_rebase SET journal=${JSON.stringify(malformed)},journal_hash=${GoalTickProgram.hash(malformed)},logical_bytes=${Buffer.byteLength(JSON.stringify(malformed))} WHERE edit_id=${row.edit_id}`,
      )
      const before = yield* setup.db.all("SELECT * FROM goal_plan_rebase")
      expect(yield* GoalPlanRebase.read(setup.db, row.edit_id).pipe(Effect.flip)).toMatchObject({
        code: "RECOVERY_REQUIRED",
      })
      expect(yield* setup.db.all("SELECT * FROM goal_plan_rebase")).toEqual(before)
    }),
  )
})

for (const spent of [
  { tokens: 1000, costComplete: true },
  { tokens: 17, costComplete: false, maxCost: 1 },
]) {
  test(`plan edit preserves exhausted or incomplete original budget ${JSON.stringify(spent)} and cannot mint a resume wake`, async () => {
    await GoalChildFixture.isolated(({ directory, state }) =>
      Effect.gen(function* () {
        const setup = yield* prepare(directory, spent)
        const begin = yield* GoalPlanRebase.begin(
          setup.db,
          { sessionID: setup.parent.id, goalID: setup.goalID, expectedControlRevision: 1, requestID: "begin-budget" },
          authorize,
        )
        const row = (yield* GoalPlanRebase.read(setup.db, begin.current.editID))!
        const input = {
          sessionID: setup.parent.id,
          goalID: setup.goalID,
          editID: row.edit_id,
          requestID: "apply-budget",
          expectedEditRevision: row.revision,
          expectedControlRevision: begin.current.controlRevision,
          expectedPlanRevision: 0,
          expectedDocVersion: 1,
          expectedDocHash: row.journal.source!.planDocHash,
          candidate: {
            steps: [setup.plan.steps[0], { ...setup.plan.steps[1], note: "Clarified future work" }],
            activeStepID: null,
            dispositions: [],
          },
          reason: "Editing does not restore spent budget",
        }
        const prepared = yield* GoalPlanRebase.prepare(setup.db, input, setup.root, authorize)
        for (const doc of prepared.row.journal.documents)
          yield* GoalPlanRebase.project(setup.db, row.edit_id, doc.documentID, setup.root, authorize)
        const done = yield* GoalPlanRebase.settle(setup.db, row.edit_id, setup.root, authorize)
        const response = yield* GoalPlanRebase.response(setup.db, done, input.requestID, false, authorize)
        expect(response.current.safeToResume).toBe(false)
        expect(
          Schema.decodeUnknownSync(Schema.fromJsonString(GoalTickState.Runtime))(done.journal.nextState!).ledger,
        ).toEqual(setup.state.ledger)
        expect(
          yield* GoalControl.control(setup.db, {
            sessionID: setup.parent.id,
            goalId: setup.goalID,
            expectedRevision: response.current.controlRevision,
            requestID: "resume-spent",
            action: "resume",
          }).pipe(Effect.flip),
        ).toMatchObject({ code: "target_conflict" })
        expect(yield* GoalControl.pendingWakes(setup.db)).toEqual([])
        expect(state.runs).toBe(0)
        expect(yield* setup.db.all("SELECT * FROM goal_tick_permit")).toEqual([])
      }),
    )
  })
}

test("version 3 program lineage is compared with the actual settled source before checkpoint insertion", async () => {
  await GoalChildFixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const setup = yield* prepare(directory)
      const goal = (yield* GoalControl.get(setup.db, setup.goalID))!
      const tick = yield* GoalControl.beginTick(setup.db, {
        sessionID: setup.parent.id,
        goalId: setup.goalID,
        planDocId: setup.planID,
        revision: goal.revision,
        seq: 0,
        expectedPlanVersion: 1,
        mode: "event",
      })
      const source = yield* GoalPlanRebase.baseline(setup.db, goal)
      const program: GoalTickProgram.Program = {
        version: 3,
        contract: "owned-goal-v2",
        planLineage: {
          version: 1,
          planRevision: 0,
          rebaseID: null,
          sourceReceiptHash: "f".repeat(64),
          planDocID: setup.planID,
          planDocVersion: 1,
          planDocHash: GoalTickProgram.hash(setup.documents[0]),
          baselineDocsHash: GoalTickProgram.hash(source.documents),
        },
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
            policyHash: "a".repeat(64),
            recipe: { id: "goal-worker-v2", hash: "b".repeat(64), schemaHash: "c".repeat(64), dependencies: [] },
          },
        ],
        documents: [],
        localEffectSlots: 0,
        nextStateBytes: 4096,
      }
      expect(
        yield* GoalTickCheckpointV2.begin(setup.db, {
          permitID: tick.permit.permit_id,
          permitToken: tick.permit.token,
          program,
        }).pipe(Effect.flip),
      ).toMatchObject({ code: "CHECKPOINT_CONFLICT" })
      expect(yield* setup.db.all("SELECT * FROM goal_tick_checkpoint")).toEqual([])
      const actual = yield* GoalTickCheckpointV2.begin(setup.db, {
        permitID: tick.permit.permit_id,
        permitToken: tick.permit.token,
        program: { ...program, planLineage: { ...program.planLineage, sourceReceiptHash: source.receiptHash } },
      })
      expect(actual.version).toBe(3)
    }),
  )
})

test("encoded candidate capacity is rejected before command persistence or the first file marker", async () => {
  await GoalChildFixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const setup = yield* prepare(directory)
      const begin = yield* GoalPlanRebase.begin(
        setup.db,
        { sessionID: setup.parent.id, goalID: setup.goalID, expectedControlRevision: 1, requestID: "begin-large" },
        authorize,
      )
      const row = (yield* GoalPlanRebase.read(setup.db, begin.current.editID))!
      expect(
        yield* GoalPlanRebase.prepare(
          setup.db,
          {
            sessionID: setup.parent.id,
            goalID: setup.goalID,
            editID: row.edit_id,
            requestID: "apply-large",
            expectedEditRevision: row.revision,
            expectedControlRevision: begin.current.controlRevision,
            expectedPlanRevision: 0,
            expectedDocVersion: 1,
            expectedDocHash: row.journal.source!.planDocHash,
            candidate: {
              steps: [
                setup.plan.steps[0],
                ...Array.from({ length: 127 }, (_, index) => ({
                  step_id: `future-${index}`,
                  title: "x".repeat(4096),
                  status: "pending" as const,
                })),
              ],
              activeStepID: null,
              dispositions: [],
            },
            reason: "Bound encoded capacity",
          },
          setup.root,
          authorize,
        ).pipe(Effect.flip),
      ).toMatchObject({ code: "CAPACITY" })
      expect((yield* GoalPlanRebase.read(setup.db, row.edit_id))!.journal.commands).toHaveLength(1)
      expect((yield* GoalPlanRebase.read(setup.db, row.edit_id))!.journal.fileStarted).toBe(false)
      GoalPlanRebase.requireDocuments(row, setup.root, false)
    }),
  )
})

test("instance logical reservations stop new edits at 256 MiB without materializing historical journals", async () => {
  await GoalChildFixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const setup = yield* prepare(directory)
      for (let index = 0; index < 256; index++) {
        const begin = yield* GoalPlanRebase.begin(
          setup.db,
          {
            sessionID: setup.parent.id,
            goalID: setup.goalID,
            expectedControlRevision: 1 + index * 2,
            requestID: `capacity-begin-${index}`,
          },
          authorize,
        )
        yield* GoalPlanRebase.cancel(
          setup.db,
          {
            sessionID: setup.parent.id,
            goalID: setup.goalID,
            editID: begin.current.editID,
            requestID: `capacity-cancel-${index}`,
            expectedEditRevision: begin.current.revision,
            expectedControlRevision: begin.current.controlRevision,
          },
          authorize,
        )
      }
      const before = yield* setup.db.get<{ records: number; bytes: number }>(
        sql`SELECT count(*) AS records,sum(reserved_bytes) AS bytes FROM goal_plan_rebase`,
      )
      expect(before).toEqual({ records: 256, bytes: GoalPlanRebaseSchema.MAX_INSTANCE_BYTES })
      expect(
        yield* GoalPlanRebase.begin(
          setup.db,
          {
            sessionID: setup.parent.id,
            goalID: setup.goalID,
            expectedControlRevision: 513,
            requestID: "capacity-overflow",
          },
          authorize,
        ).pipe(Effect.flip),
      ).toMatchObject({ code: "CAPACITY" })
      expect(yield* GoalControl.command(setup.db, setup.parent.id, "capacity-overflow")).toBeUndefined()
      expect(
        yield* setup.db.get<{ records: number; bytes: number }>(
          sql`SELECT count(*) AS records,sum(reserved_bytes) AS bytes FROM goal_plan_rebase`,
        ),
      ).toEqual(before)
    }),
  )
}, 30000)

for (const action of ["pause", "stop"] as const) {
  test(`ordinary ${action} cancels a prepared edit before its first file and preserves the original ACK`, async () => {
    await GoalChildFixture.isolated(({ directory }) =>
      Effect.gen(function* () {
        const setup = yield* prepare(directory)
        const first = yield* GoalPlanRebase.begin(
          setup.db,
          { sessionID: setup.parent.id, goalID: setup.goalID, expectedControlRevision: 1, requestID: "begin-control" },
          authorize,
        )
        const row = (yield* GoalPlanRebase.read(setup.db, first.current.editID))!
        yield* GoalPlanRebase.prepare(
          setup.db,
          {
            sessionID: setup.parent.id,
            goalID: setup.goalID,
            editID: row.edit_id,
            requestID: "apply-control",
            expectedEditRevision: row.revision,
            expectedControlRevision: first.current.controlRevision,
            expectedPlanRevision: 0,
            expectedDocVersion: 1,
            expectedDocHash: row.journal.source!.planDocHash,
            candidate: { steps: setup.plan.steps, activeStepID: null, dispositions: [] },
            reason: "Unwritten edit",
          },
          setup.root,
          authorize,
        )
        const control = yield* GoalControl.control(setup.db, {
          sessionID: setup.parent.id,
          goalId: setup.goalID,
          expectedRevision: first.current.controlRevision,
          requestID: `actual-${action}`,
          action,
        })
        expect(control.requestedPhase).toBe(action === "pause" ? "paused" : "stopped")
        const cancelled = (yield* GoalPlanRebase.read(setup.db, row.edit_id))!
        expect(cancelled.state).toBe("cancelled")
        expect(cancelled.journal.controlInterruption?.reason).toBe(`control_${action}`)
        expect(cancelled.journal.commands[0].receipt).toEqual(first.originalReceipt)
        expect(cancelled.journal.commands[1].receipt?.state).toBe("cancelled")
        expect((yield* GoalControl.get(setup.db, setup.goalID))!.pending_rebase_id).toBeNull()
        GoalPlanRebase.requireDocuments(row, setup.root, false)
        expect(
          yield* GoalPlanRebase.project(
            setup.db,
            row.edit_id,
            row.journal.source!.planDocID,
            setup.root,
            authorize,
          ).pipe(Effect.flip),
        ).toMatchObject({ code: "RECOVERY_REQUIRED" })
      }),
    )
  })
}
