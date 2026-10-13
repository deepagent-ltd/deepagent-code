import { describe, expect, test } from "bun:test"
import path from "node:path"
import { eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Attention } from "../src/attention"
import { AttentionWorkSource } from "../src/attention/work-source"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { GoalControl } from "../src/deepagent/goal-control"
import { GoalControlFixture } from "./fixture/goal-control"
import { TaskRunAuthority } from "../src/session/task-run"
import { SessionTable, TaskRunTable, SessionInputTable } from "../src/session/sql"
import { SessionActivityTable } from "../src/context-federation/session-sql"
import { SessionMessage } from "../src/session/message"
import { SessionSchema } from "../src/session/schema"
import { SessionStore } from "../src/session/store"
import { Prompt } from "../src/session/prompt"
import { AbsolutePath } from "../src/schema"
import { Project } from "../src/project"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionRestart } from "../src/session/execution/restart"
import { GoalChildFixture } from "./fixture/goal-child"
import { GoalTickCheckpoint } from "../src/deepagent/goal-tick-checkpoint"
import { GoalTickProgram } from "../src/deepagent/goal-tick-program"
import { GoalTickState } from "../src/deepagent/goal-tick-state"
import { GoalPlanRebase } from "../src/deepagent/goal-plan-rebase"
import { GoalPlanRebaseSchema } from "../src/deepagent/goal-plan-rebase.schema"
import { DocumentStore } from "../src/deepagent/document-store"
import { createPlanDoc } from "../src/deepagent/plan-controller"
import { Hash } from "../src/util/hash"
import { services, temporary, seedSession, seedActivity } from "./fixture/attention"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
const admit = (db: Database.Interface["db"], parent: SessionSchema.ID, key: string) =>
  TaskRunAuthority.admitRun(db, {
    parentSessionID: parent,
    parentMessageID: SessionMessage.ID.make(`msg_work_${key}`),
    toolCallID: `call_${key}`,
    prompt: new Prompt({ text: "A registered task with the same text in distinct admissions" }),
    deliveryMode: "background",
    agent: "general",
    child: { title: key, location: { directory: AbsolutePath.make("/tmp/project-a") }, permissions: [] },
  })
const census = (db: Database.Interface["db"]) =>
  db
    .all(
      sql`SELECT
  (SELECT count(*) FROM event) AS events,(SELECT count(*) FROM session_input) AS inputs,
  (SELECT count(*) FROM session_v2_provider_turn_receipt) AS providers,
  (SELECT count(*) FROM session_provider_owner_lease) AS owners,
  (SELECT count(*) FROM session WHERE execution_claim_token IS NOT NULL) AS claims,
  (SELECT count(*) FROM task_run_event) AS task_events,(SELECT count(*) FROM goal_control_command) AS goal_commands`,
    )
    .pipe(Effect.orDie)

describe("Task/Goal attention original-source read model", () => {
  test("proves edited Goal suggestions from the original committed baseline and remaining budget without executing", async () => {
    await GoalChildFixture.isolated(({ directory, state }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const store = yield* SessionStore.Service
        const execution = yield* SessionExecution.Service
        const original = Layer.mergeAll(
          Layer.succeed(Database.Service, database),
          Layer.succeed(SessionStore.Service, store),
          Layer.succeed(SessionExecution.Service, execution),
        )
        const attention = Context.get(
          yield* Layer.build(
            Attention.layer().pipe(
              Layer.provide(SessionRestart.layer.pipe(Layer.provide(original))),
              Layer.provide(original),
              Layer.provide(
                Layer.succeed(
                  Attention.Access,
                  Attention.localCapability({ profile: "implicit-local", gateway: false }),
                ),
              ),
            ),
          ),
          Attention.Service,
        )
        const db = database.db
        const authorize: GoalPlanRebase.Authority = (writer, sessionID, goalID) =>
          GoalControl.requireTarget(writer, goalID, sessionID).pipe(
            Effect.asVoid,
            Effect.mapError(
              () => new GoalPlanRebaseSchema.Error({ code: "AUTH_CHANGED", message: "The actual Goal target changed" }),
            ),
          )
        for (const tokens of [17, 1000]) {
          const parent = yield* (yield* SessionV2.Service).create({
            location: { directory: AbsolutePath.make(directory) },
          })
          const requestID = `owned-advertisement-${parent.id}`
          const goalID = `goal_${GoalControl.fingerprint([parent.id, requestID]).slice(0, 40)}`
          const planID = `doc:plan:plan-${parent.id}`
          const spec = { ...GoalControlFixture.initialization.spec, planDocId: planID }
          const plan = createPlanDoc(parent.id, "A current original Goal plan", [
            { step_id: "next", title: "Future source", status: "pending" },
          ])
          const runtime = GoalTickState.requireState({
            version: 2,
            goalId: goalID,
            spec,
            planDocId: planID,
            sessionId: parent.id,
            phase: "running",
            ledger: { ticks: 0, tokens, cost: 0, costComplete: true, wallclockMs: 0, startedAtMs: Date.now() },
            stallCount: 0,
            lastFingerprint: null,
            lastDoneCount: 0,
            lastEvidenceCount: 0,
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
          const document = (
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
            description: "Original immutable Goal source",
            provenance: { source: "runner", run_ref: `run:${parent.id}` },
            links: [],
            body,
          })
          const documents = [
            document(planID, "plan", JSON.stringify(plan)),
            document(`doc:run_context:${goalID}`, "run_context", GoalTickProgram.canonical(runtime)),
          ]
          const input = {
            sessionID: parent.id,
            requestID,
            requestHash: GoalControl.fingerprint(parent.id),
            planDocId: planID,
            driverMode: "event" as const,
            initialization: {
              ...GoalControlFixture.initialization,
              spec,
              planHash: Hash.sha256(documents[0].body),
              executionContract: "owned-goal-v2" as const,
              ownedPreparation: {
                parentHash: GoalControl.fingerprint(
                  GoalTickCheckpoint.authority(yield* GoalControl.session(db, parent.id)),
                ),
                panel: { question: "A bounded review", lenses: ["correctness"], codeRefs: [] },
                documents: documents.map((doc) => ({
                  documentID: doc.id,
                  expectedVersion: null,
                  expectedHash: null,
                  payload: GoalTickProgram.canonical(doc),
                  payloadHash: GoalTickProgram.hash(GoalTickProgram.canonical(doc)),
                  state: "pending" as const,
                  observedVersion: null,
                  observedHash: null,
                })),
              },
            },
          }
          yield* GoalControl.reserveStart(db, input)
          const folder = path.join(directory, `advertisement-${tokens}`)
          const docs = DocumentStore.openExactForCreate(
            folder,
            documents.map((doc) => doc.id),
          )
          documents.forEach((doc) => docs.projectExact(doc, null))
          yield* GoalControl.activate(db, { ...input, goalId: goalID })
          yield* GoalControl.control(db, {
            sessionID: parent.id,
            goalId: goalID,
            expectedRevision: 1,
            requestID: "initial-pause",
            action: "pause",
          })
          const initial = yield* attention
            .get(`goal:${goalID}`)
            .pipe(Effect.provideService(Attention.GoalActionAccess, true))
          expect(initial.allowedActions).toEqual(["goal_pause", "goal_stop", "goal_resume", "goal_edit"])
          const begin = yield* GoalPlanRebase.begin(
            db,
            { sessionID: parent.id, goalID, expectedControlRevision: 2, requestID: "exact-plan-edit" },
            authorize,
          )
          const edit = (yield* GoalPlanRebase.read(db, begin.current.editID))!
          const apply: GoalPlanRebaseSchema.Apply = {
            sessionID: parent.id,
            goalID,
            editID: edit.edit_id,
            requestID: "exact-plan-apply",
            expectedEditRevision: edit.revision,
            expectedControlRevision: begin.current.controlRevision,
            expectedPlanRevision: 0,
            expectedDocVersion: edit.journal.source!.planDocVersion,
            expectedDocHash: edit.journal.source!.planDocHash,
            candidate: {
              steps: [{ ...plan.steps[0], title: "A human refined future step" }],
              activeStepID: null,
              dispositions: [],
            },
            reason: "Refine the original plan",
          }
          yield* GoalPlanRebase.prepare(db, apply, folder, authorize)
          const prepared = (yield* GoalPlanRebase.read(db, edit.edit_id))!
          for (const doc of prepared.journal.documents)
            yield* GoalPlanRebase.project(db, edit.edit_id, doc.documentID, folder, authorize)
          yield* GoalPlanRebase.settle(db, edit.edit_id, folder, authorize)
          const before = yield* census(db)
          const edited = yield* attention
            .get(`goal:${goalID}`)
            .pipe(Effect.provideService(Attention.GoalActionAccess, true))
          expect(edited.source.goal?.planRevision).toBe(1)
          expect(edited.allowedActions?.includes("goal_resume")).toBe(tokens < 1000)
          expect(edited.allowedActions?.includes("goal_edit")).toBe(true)
          expect(
            (yield* attention
              .seen(edited.id, edited.revision)
              .pipe(Effect.provideService(Attention.GoalActionAccess, true))).allowedActions,
          ).toEqual(edited.allowedActions)
          expect(yield* census(db)).toEqual(before)
          const limited = yield* AttentionWorkSource.actions(
            db,
            edited,
            { task: false, goal: true },
            { bytes: AttentionWorkSource.ACTION_PROOF_BYTES },
          )
          expect(limited.allowedActions).toEqual([])
          expect(limited.state).toBe(edited.state)
          expect(limited.reasonCode).toBe(edited.reasonCode)
          expect(limited.revision).toBe(edited.revision)
          expect(yield* census(db)).toEqual(before)
        }
        expect(state).toMatchObject({ locations: 0, runs: 0, shells: 0 })
      }),
    )
  }, 20000)
  it.live(
    "advertises fresh ordinary controls only from the current host read gate and the original custody frontier",
    () =>
      Effect.gen(function* () {
        const dir = yield* temporary
        yield* Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const attention = yield* Attention.Service
          const parent = yield* seedSession({ db }, "advertised-parent")
          const known = yield* admit(db, parent, "advertised-known")
          yield* db
            .update(TaskRunTable)
            .set({ state: "recovery_required" })
            .where(eq(TaskRunTable.run_id, known.run.runID))
            .run()
            .pipe(Effect.orDie)
          const id = `task:${known.run.childSessionID}:${known.run.generation}`
          const before = yield* census(db)
          const item = yield* attention.get(id)
          expect(item.allowedActions).toEqual([])
          const advertised = yield* attention.get(id).pipe(Effect.provideService(Attention.ActionAccess, true))
          expect(advertised.allowedActions).toEqual([
            "task_request_close",
            "task_resolve_failed",
            "task_resolve_closed",
          ])
          expect(advertised.revision).toBe(item.revision)
          expect((yield* attention.get(id)).allowedActions).toEqual([])
          expect(
            (yield* attention.seen(id, advertised.revision).pipe(Effect.provideService(Attention.ActionAccess, true)))
              .allowedActions,
          ).toEqual(advertised.allowedActions)
          expect(yield* census(db)).toEqual(before)
          const owner = yield* admit(db, parent, "advertised-owner")
          yield* db
            .insert(SessionTable)
            .values({
              id: owner.run.childSessionID,
              project_id: Project.ID.make("project-a"),
              parent_id: parent,
              directory: "/tmp/project-a",
              slug: "owned-advertisement",
              title: "Original owned child",
              version: "test",
              v2_authority: true,
            })
            .run()
            .pipe(Effect.orDie)
          yield* TaskRunAuthority.admitChildInput(
            db,
            yield* EventV2.Service,
            owner.run,
            new Prompt({ text: "An original ready child input" }),
          )
          const claimed = yield* TaskRunAuthority.claim(db, {
            runID: owner.run.runID,
            ownerToken: "actual-held-task-owner",
            leaseMs: 30000,
          })
          expect(claimed).toBeDefined()
          // A nonterminal interrupted owner frontier; the original claim remains durable.
          yield* db
            .update(TaskRunTable)
            .set({ state: "recovery_required" })
            .where(eq(TaskRunTable.run_id, owner.run.runID))
            .run()
            .pipe(Effect.orDie)
          const owned = yield* attention
            .get(`task:${owner.run.childSessionID}:${owner.run.generation}`)
            .pipe(Effect.provideService(Attention.ActionAccess, true))
          expect(owned.source.task?.hasExecutionClaim).toBe(false)
          expect(owned.allowedActions).toEqual(["task_request_close"])
          const pending = yield* admit(db, parent, "advertised-claim")
          yield* db
            .insert(SessionTable)
            .values({
              id: pending.run.childSessionID,
              project_id: Project.ID.make("project-a"),
              parent_id: parent,
              directory: "/tmp/project-a",
              slug: "claimed-advertisement",
              title: "Original claimed child",
              version: "test",
              v2_authority: true,
            })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .update(TaskRunTable)
            .set({ state: "recovery_required" })
            .where(eq(TaskRunTable.run_id, pending.run.runID))
            .run()
            .pipe(Effect.orDie)
          yield* (yield* SessionStore.Service).claim(pending.run.childSessionID)
          const unknown = yield* attention
            .get(`task:${pending.run.childSessionID}:${pending.run.generation}`)
            .pipe(Effect.provideService(Attention.ActionAccess, true))
          expect(unknown.allowedActions).toEqual(["task_request_close"])
          const goal = yield* GoalControlFixture.activate(db, "advertised-goal")
          yield* GoalControl.control(db, {
            sessionID: goal.row.session_id,
            goalId: goal.row.goal_id,
            expectedRevision: 1,
            requestID: "advertised-pause",
            action: "pause",
          })
          const goalID = `goal:${goal.row.goal_id}`
          expect(
            (yield* attention.get(goalID).pipe(Effect.provideService(Attention.ActionAccess, true))).allowedActions,
          ).toEqual([])
          const paused = yield* attention.get(goalID).pipe(Effect.provideService(Attention.GoalActionAccess, true))
          expect(paused.allowedActions).toEqual(["goal_pause", "goal_stop", "goal_resume"])
          expect(
            (yield* attention.list({ kind: "goal" }).pipe(Effect.provideService(Attention.GoalActionAccess, true)))
              .data[0].allowedActions,
          ).toEqual(paused.allowedActions)
          yield* GoalControl.control(db, {
            sessionID: goal.row.session_id,
            goalId: goal.row.goal_id,
            expectedRevision: 2,
            requestID: "advertised-resume",
            action: "resume",
          })
          const tick = yield* GoalControl.beginTick(db, { ...goal.tick, revision: 3 })
          yield* GoalControl.unknown(db, tick.permit)
          const beforeUnknownRead = yield* census(db)
          const recovering = yield* attention.get(goalID).pipe(Effect.provideService(Attention.GoalActionAccess, true))
          expect(recovering.state).toBe("recovery_required")
          expect(recovering.allowedActions).toEqual(["goal_pause", "goal_stop"])
          expect(yield* census(db)).toEqual(beforeUnknownRead)
          yield* GoalControl.control(db, {
            sessionID: goal.row.session_id,
            goalId: goal.row.goal_id,
            expectedRevision: 3,
            requestID: "advertised-stop",
            action: "stop",
          })
          const stopped = yield* attention.get(goalID).pipe(Effect.provideService(Attention.GoalActionAccess, true))
          expect(stopped.source.goal?.phase).toBe("stopped")
          expect(stopped.allowedActions).toEqual([])
          expect((yield* attention.get(id)).allowedActions).toEqual([])
        }).pipe(Effect.provide(services(path.join(dir, "action-sources.db"))))
      }),
  )
  it.live(
    "reads registered sources, exact scope and seen revisions without executing; preserves independent child work",
    () =>
      Effect.gen(function* () {
        const dir = yield* temporary
        yield* Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const attention = yield* Attention.Service
          const parent = yield* seedSession({ db }, "parent")
          const beforeChild = yield* admit(db, parent, "not-created")
          yield* TaskRunAuthority.requestClose(db, {
            rootRunID: beforeChild.run.runID,
            reason: "Known pre-dispatch close",
          })
          const task = (yield* attention.list({ kind: "task" })).data[0]!
          expect(task.state).toBe("closed")
          expect(task.source.task?.childSessionID).toBeNull()
          expect(task.session.id).toBe(parent)
          expect(task.allowedActions).toEqual([])
          const paused = yield* GoalControlFixture.activate(db, "attention-real-pause")
          yield* GoalControl.control(db, {
            sessionID: paused.row.session_id,
            goalId: paused.row.goal_id,
            expectedRevision: 1,
            requestID: "actual-pause",
            action: "pause",
          })
          const goal = (yield* attention.list({ kind: "goal" })).data[0]!
          expect(goal.state).toBe("paused")
          expect(goal.source.goal?.controlRevision).toBe(2)
          expect(goal.allowedActions).toEqual([])
          const before = yield* census(db)
          const changes = yield* db.get<{ value: number }>(sql`SELECT total_changes() AS value`).pipe(Effect.orDie)
          expect((yield* attention.list()).unseenCount).toBe(2)
          const taskPage = yield* attention.list({ limit: 1 })
          expect(taskPage.data.map((item) => item.id)).toEqual([task.id])
          const goalPage = yield* attention.list({ limit: 1, cursor: taskPage.nextCursor })
          expect(goalPage.data.map((item) => item.id)).toEqual([goal.id])
          expect(goalPage.nextCursor).toBeUndefined()
          expect(goalPage.unseenCount).toBe(2)
          expect(yield* attention.get(task.id)).toMatchObject({
            id: task.id,
            revision: task.revision,
            source: task.source,
            session: task.session,
          })
          expect(
            (yield* db.get<{ value: number }>(sql`SELECT total_changes() AS value`).pipe(Effect.orDie))?.value,
          ).toBe(changes?.value)
          yield* attention.seen(task.id, task.revision)
          yield* attention.seen(goal.id, goal.revision)
          expect((yield* attention.list({ view: "unseen" })).unseenCount).toBe(0)
          expect(yield* census(db)).toEqual(before)
          yield* GoalControl.control(db, {
            sessionID: paused.row.session_id,
            goalId: paused.row.goal_id,
            expectedRevision: 2,
            requestID: "actual-stop",
            action: "stop",
          })
          const stopped = yield* attention.get(goal.id)
          expect(stopped.state).toBe("stopped")
          expect(stopped.revision).not.toBe(goal.revision)
          expect(stopped.seen).toBe(false)
          expect(yield* attention.seen(goal.id, goal.revision).pipe(Effect.flip)).toBeInstanceOf(Attention.Stale)

          const original = yield* admit(db, parent, "original-crash")
          // Nonterminal crash facts only. No terminal receipt or success is invented in this fixture.
          yield* db
            .insert(SessionTable)
            .values({
              id: original.run.childSessionID,
              project_id: Project.ID.make("project-a"),
              parent_id: parent,
              directory: "/tmp/project-a",
              slug: "actual-child",
              title: "Actual registered child",
              version: "test",
              v2_authority: true,
            })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(SessionInputTable)
            .values({
              id: original.run.childMessageID,
              session_id: original.run.childSessionID,
              prompt: new Prompt({ text: "Registered first input" }),
              delivery: "queue",
              admitted_seq: 1,
              promoted_seq: 2,
              time_created: 1,
            })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(SessionActivityTable)
            .values({
              activity_id: "activity_original_task",
              session_id: original.run.childSessionID,
              trigger_input_id: original.run.childMessageID,
              ordinal: 1,
              state: "failed",
              delivery: "queue",
              created_at: 1,
              settled_at: 2,
            })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .update(TaskRunTable)
            .set({ state: "recovery_required", phase: "research", input_state: "ready" })
            .where(eq(TaskRunTable.run_id, original.run.runID))
            .run()
            .pipe(Effect.orDie)
          yield* (yield* SessionStore.Service).claim(original.run.childSessionID)
          const aggregate = (yield* attention.list({ kind: "task" })).data.find(
            (item) => item.source.task?.runID === original.run.runID,
          )!
          expect(aggregate.state).toBe("recovery_required")
          expect(aggregate.source.task?.childSessionID).toBe(original.run.childSessionID)
          expect((yield* attention.list({ kind: "activity_failed" })).data).toEqual([])
          expect((yield* attention.list({ kind: "execution_recovery" })).data).toEqual([])
          expect(yield* attention.get("activity:activity_original_task").pipe(Effect.flip)).toBeInstanceOf(
            Attention.NotFound,
          )
          yield* seedActivity({ db }, original.run.childSessionID, "independent-user")
          expect(
            (yield* attention.list({ kind: "activity_failed" })).data.map((item) => item.source.activityID),
          ).toEqual(["activity_independent-user"])
          expect((yield* attention.list({ kind: "execution_recovery" })).data).toHaveLength(1)
          const heartbeat = yield* attention.get(aggregate.id)
          yield* db
            .update(TaskRunTable)
            .set({ lease_expires_at: Date.now() + 60000, time_updated: Date.now() })
            .where(eq(TaskRunTable.run_id, original.run.runID))
            .run()
            .pipe(Effect.orDie)
          expect((yield* attention.get(aggregate.id)).revision).toBe(heartbeat.revision)
          yield* db
            .update(SessionTable)
            .set({ directory: "/tmp/unrelated-project" })
            .where(eq(SessionTable.id, original.run.childSessionID))
            .run()
            .pipe(Effect.orDie)
          expect(yield* attention.get(aggregate.id).pipe(Effect.flip)).toBeInstanceOf(Attention.NotFound)
          expect((yield* attention.list({ project: "project-b" })).data).toEqual([])
        }).pipe(Effect.provide(services(path.join(dir, "work-sources.db"))))
      }),
  )
  it.live("counts all 270 real admissions across a batch boundary with bounded retained pages", () =>
    Effect.gen(function* () {
      const dir = yield* temporary
      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const attention = yield* Attention.Service
        const parent = yield* seedSession({ db }, "batch-parent")
        for (const index of Array.from({ length: 270 }, (_, index) => index)) {
          const run = yield* admit(db, parent, `batch-${index}`)
          yield* TaskRunAuthority.requestClose(db, {
            rootRunID: run.run.runID,
            reason: "Known admission closes without model work",
          })
        }
        const before = yield* census(db)
        const started = performance.now()
        const inventory = yield* AttentionWorkSource.inventory(db, "task", { limit: 2 })
        expect(inventory.scanned).toBe(270)
        expect(inventory.unseenCount).toBe(270)
        expect(inventory.batches).toBe(2)
        expect(inventory.peakBatch).toBe(256)
        expect(inventory.items).toHaveLength(2)
        yield* Effect.promise(() =>
          Bun.write(
            "/tmp/dac-attention-work-source-scan.json",
            JSON.stringify({
              sources: inventory.scanned,
              batches: inventory.batches,
              peakBatch: inventory.peakBatch,
              retained: inventory.items.length,
              milliseconds: performance.now() - started,
            }),
          ),
        )
        const pages = { items: [] as string[], cursor: undefined as string | undefined }
        do {
          const page = yield* attention.list({ limit: 100, kind: "task", cursor: pages.cursor })
          expect(page.unseenCount).toBe(270)
          pages.items.push(...page.data.map((item) => item.id))
          pages.cursor = page.nextCursor
        } while (pages.cursor)
        expect(pages.items).toHaveLength(270)
        expect(new Set(pages.items).size).toBe(270)
        yield* attention.seen(inventory.items[0].id, inventory.items[0].revision)
        expect((yield* attention.list({ limit: 1, kind: "task" })).unseenCount).toBe(269)
        expect(yield* census(db)).toEqual(before)
      }).pipe(Effect.provide(services(path.join(dir, "batch-sources.db"))))
    }),
  )
})
