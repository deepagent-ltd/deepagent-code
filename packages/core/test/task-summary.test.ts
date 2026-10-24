import { describe, expect, test } from "bun:test"
import { count, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../src/database/database"
import { SessionSchema } from "../src/session/schema"
import { SessionMessage } from "../src/session/message"
import { SessionTable, SessionMessageTable, TaskNotificationOutboxTable, TaskRunTable } from "../src/session/sql"
import { TaskSummary } from "../src/session/task-summary"
import { TaskSummarySchema } from "../src/session/task-summary.schema"
import { TaskRunAuthority } from "../src/session/task-run"
import { Prompt } from "../src/session/prompt"
import { AbsolutePath } from "../src/schema"
import { Project } from "../src/project"
import { SessionV1 } from "../src/v1/session"
import { seedSession } from "./fixture/attention"
import { testEffect } from "./lib/effect"
import { GoalChild } from "../src/deepagent/goal-child"
import { GoalChildPolicy } from "../src/deepagent/goal-child-policy"
import { GoalChildUnitTable } from "../src/deepagent/goal-child.sql"
import { GoalControl } from "../src/deepagent/goal-control"
import { AgentV2 } from "../src/agent"
import { SessionV2 } from "../src/session"
import { GoalChildC1Fixture } from "./fixture/goal-child-c1"

const it = testEffect(Database.layerFromPath(":memory:"))
const scope = { projectID: "project-a", directory: "/tmp/project-a" }
const submit = (db: Database.Interface["db"], parent: SessionSchema.ID, key: string) =>
  TaskRunAuthority.admitRun(db, {
    parentSessionID: parent,
    parentMessageID: SessionMessage.ID.make(`msg_summary_${key}`),
    toolCallID: `call_summary_${key}`,
    deliveryMode: "background",
    prompt: new Prompt({ text: "Inspect the scoped task" }),
    agent: "general",
    child: { title: key, location: { directory: AbsolutePath.make(scope.directory) }, permissions: [] },
  })

describe("parent-scoped task summary read model", () => {
  it.effect("paginates stable child identities without presenting a partial page as complete", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const parent = yield* seedSession(database, "summary-paged")
      yield* database.db
        .insert(SessionTable)
        .values(
          Array.from({ length: 103 }, (_, index) => ({
            id: SessionSchema.ID.make(`ses_summary_page_${String(index).padStart(3, "0")}`),
            parent_id: parent,
            project_id: Project.ID.make(scope.projectID),
            directory: scope.directory,
            slug: `page-${index}`,
            title: `Child ${index}`,
            version: "test",
            v2_authority: true,
          })),
        )
        .run()
      const first = yield* TaskSummary.read(database.db, { ...scope, parentSessionID: parent })
      expect(first.items).toHaveLength(100)
      expect(first.hasMore).toBe(true)
      expect(first.nextCursor).toBe(first.items.at(-1)!.childSessionID)
      const second = yield* TaskSummary.read(database.db, {
        ...scope,
        parentSessionID: parent,
        cursor: first.nextCursor!,
      })
      expect(second.items).toHaveLength(3)
      expect(second.hasMore).toBe(false)
      expect(second.nextCursor).toBeNull()
      expect(new Set([...first.items, ...second.items].map((item) => item.childSessionID)).size).toBe(103)
    }),
  )

  it.effect("includes pre-materialization admissions and historical unknown children without writing or waking", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const parent = yield* seedSession(database, "summary-parent")
      const other = yield* seedSession(database, "summary-other")
      const admitted = yield* submit(database.db, parent, "admitted")
      yield* submit(database.db, other, "foreign")
      const legacy = yield* seedSession(database, "summary-legacy")
      yield* database.db.update(SessionTable).set({ parent_id: parent }).where(eq(SessionTable.id, legacy)).run()
      const before = yield* database.db.select({ total: count() }).from(TaskRunTable).get()
      const result = yield* TaskSummary.read(database.db, { ...scope, parentSessionID: parent })
      expect(result.items).toHaveLength(2)
      expect(result.items.find((item) => item.childSessionID === admitted.run.childSessionID)?.state).toBe("admitted")
      expect(result.items.find((item) => item.childSessionID === legacy)?.state).toBe("unknown")
      expect(result.items.every((item) => item.notification.state === "not_established")).toBe(true)
      expect(result.items.every((item) => item.result.text === null && item.progress === null)).toBe(true)
      expect(Schema.is(TaskSummarySchema.Summary)(result)).toBe(true)
      expect(yield* database.db.select({ total: count() }).from(TaskRunTable).get()).toEqual(before)
      expect(
        (yield* TaskSummary.read(database.db, { ...scope, parentSessionID: parent, projectID: "other-project" }).pipe(
          Effect.flip,
        )).reason,
      ).toBe("scope_changed")
      expect(
        (yield* TaskSummary.read(database.db, { ...scope, parentSessionID: parent, directory: "/tmp/another" }).pipe(
          Effect.flip,
        )).reason,
      ).toBe("scope_changed")
      expect(
        (yield* TaskSummary.read(database.db, {
          ...scope,
          parentSessionID: parent,
          workspaceID: "workspace-other",
        }).pipe(Effect.flip)).reason,
      ).toBe("scope_changed")
    }),
  )

  it.effect("keeps generation, visible progress, result and notification facts independent", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const parent = yield* seedSession(database, "summary-progress")
      const admitted = yield* submit(database.db, parent, "progress")
      // A persisted reader fixture: replayed canonical messages and an existing run generation.
      // No provider, tool executor or Session execution service is installed in this test.
      yield* database.db
        .insert(SessionTable)
        .values({
          id: admitted.run.childSessionID,
          parent_id: parent,
          project_id: Project.ID.make(scope.projectID),
          directory: scope.directory,
          slug: "child",
          title: "Scoped child",
          version: "test",
          v2_authority: true,
        })
        .run()
      const user = Schema.decodeUnknownSync(SessionMessage.Message)({
        id: admitted.run.childMessageID,
        type: "user",
        text: "Inspect the scoped task",
        time: { created: 10 },
      })
      const assistant = Schema.decodeUnknownSync(SessionMessage.Message)({
        id: "msg_summary_assistant",
        type: "assistant",
        agent: "general",
        model: { id: "m", providerID: "p" },
        time: { created: 11 },
        content: [
          { type: "text", id: "text", text: "Checking the handoff boundary" },
          { type: "reasoning", id: "reason", text: "PRIVATE_REASONING_MUST_NOT_LEAK" },
        ],
      })
      yield* database.db
        .insert(SessionMessageTable)
        .values(
          [user, assistant].map((message, index) => ({
            id: message.id,
            session_id: admitted.run.childSessionID,
            type: message.type,
            seq: index + 1,
            data: Schema.encodeSync(SessionMessage.Message)(message),
          })),
        )
        .run()
      const row = yield* database.db
        .select()
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, admitted.run.runID))
        .get()
      if (!row) return yield* Effect.die("Original task admission missing")
      yield* database.db
        .insert(TaskRunTable)
        .values({
          ...row,
          run_id: "summary-new-generation",
          generation: 2,
          state: "recovery_required",
          control_state: "close_requested",
          output: "Existing final result",
          raw_result_message_id: null,
          time_updated: 20,
          time_settled: 21,
        })
        .run()
      yield* database.db
        .insert(TaskNotificationOutboxTable)
        .values({
          id: "summary-outbox",
          run_id: "summary-new-generation",
          parent_session_id: parent,
          message_id: SessionV1.MessageID.make("msg_summary_notify"),
          directory: scope.directory,
          payload: { agent: "general", text: "Existing final result" },
          status: "pending",
          available_at: 100,
          time_created: 21,
          time_updated: 22,
        })
        .run()
      const summary = yield* TaskSummary.read(database.db, { ...scope, parentSessionID: parent })
      expect(summary.items).toHaveLength(1)
      expect(summary.items[0]?.generation).toBe(2)
      expect(summary.items[0]?.state).toBe("recovery_required")
      expect(summary.items[0]?.controlState).toBe("close_requested")
      expect(summary.items[0]?.progress?.text).toBe("Checking the handoff boundary")
      expect(summary.items[0]?.result).toEqual({
        state: "available",
        text: "Existing final result",
        messageID: null,
        truncated: false,
      })
      expect(summary.items[0]?.notification).toEqual({ state: "pending", updatedAt: 22, deliveredAt: null })
      expect(JSON.stringify(summary)).not.toContain("PRIVATE_REASONING")
    }),
  )

  it.effect("rejects missing parent and excludes a corrupt task link into another parent's Session", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      expect(
        (yield* TaskSummary.read(database.db, { ...scope, parentSessionID: "ses_missing_summary" }).pipe(Effect.flip))
          .reason,
      ).toBe("not_found")
      const parent = yield* seedSession(database, "summary-corrupt")
      const other = yield* seedSession(database, "summary-real-parent")
      const admitted = yield* submit(database.db, parent, "corrupt")
      yield* database.db
        .insert(SessionTable)
        .values({
          id: admitted.run.childSessionID,
          parent_id: other,
          project_id: Project.ID.make(scope.projectID),
          directory: scope.directory,
          slug: "foreign",
          title: "DO_NOT_EXPOSE",
          version: "test",
          v2_authority: true,
        })
        .run()
      expect((yield* TaskSummary.read(database.db, { ...scope, parentSessionID: parent })).items).toEqual([])
    }),
  )
})

// Replayed durable reader snapshots only. Real Goal/child admission, file SQLite and
// TaskSummary run; no provider, Native proof, execution completion or new TaskRun is claimed.
const recordedGoal = <E>(
  check: (input: {
    db: Database.Interface["db"]
    parent: SessionSchema.Info
    unit: NonNullable<Effect.Success<ReturnType<typeof GoalChild.read>>>
    message: SessionMessage.Assistant
    scope: { projectID: string; directory: string; parentSessionID: string }
  }) => Effect.Effect<void, E>,
) =>
  GoalChildC1Fixture.isolated(({ directory, state }) =>
    Effect.gen(function* () {
      const setup = yield* GoalChildC1Fixture.prepare(directory)
      const db = (yield* Database.Service).db
      const policy = yield* GoalChildPolicy.prepare(db, yield* AgentV2.Service, {
        permitID: setup.permit.permit_id,
        roleKey: setup.admission.roleKey,
        agent: "worker",
        mode: "plain",
      })
      const admitted = yield* GoalChild.admitV2(db, yield* SessionV2.Service, {
        ...setup.admission,
        policy,
      })
      const message = Schema.decodeUnknownSync(SessionMessage.Assistant)({
        id: "msg_summary_goal_recorded",
        type: "assistant",
        agent: "worker",
        finish: "stop",
        model: { id: "m", providerID: "p" },
        time: { created: 11 },
        content: [
          {
            type: "text",
            id: "text-goal-result",
            text: "Exact recorded Goal result",
          },
        ],
      })
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: message.id,
          session_id: SessionSchema.ID.make(admitted.unit.child_session_id),
          type: "assistant",
          seq: 1000,
          data: Schema.encodeSync(SessionMessage.Assistant)(message),
        })
        .run()
      yield* db
        .update(GoalChildUnitTable)
        .set({
          state: "result_recorded",
          inputs: admitted.unit.inputs.map((input) => ({
            ...input,
            activityID: "activity-summary-fixture",
            resultRef: message.id,
            resultHash: GoalControl.fingerprint({
              text: "Exact recorded Goal result",
            }),
            execution: {
              version: 1,
              executionID: "execution-summary-fixture",
              executionInstanceID: "instance-summary-fixture",
              goalOwnerID: "owner-summary-fixture",
              claimToken: 1,
              startedSeq: 1,
              controlRevision: 1,
              state: "settled",
            },
          })),
        })
        .where(eq(GoalChildUnitTable.unit_id, admitted.unit.unit_id))
        .run()
      const unit = yield* GoalChild.read(db, admitted.unit.unit_id)
      if (!unit) return yield* Effect.die("Original Goal child missing")
      yield* check({
        db,
        parent: setup.parent,
        unit,
        message,
        scope: {
          parentSessionID: setup.parent.id,
          projectID: setup.parent.projectID,
          directory,
        },
      })
      expect(state.runs).toBe(0)
    }),
  )

test("Goal recorded result uses its receipt instead of a newer assistant and preserves unknown TaskRun facts", () =>
  recordedGoal(({ db, unit, message, scope }) =>
    Effect.gen(function* () {
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make("msg_summary_goal_newer"),
          session_id: SessionSchema.ID.make(unit.child_session_id),
          type: "assistant",
          seq: 1001,
          data: Schema.encodeSync(SessionMessage.Assistant)(
            new SessionMessage.Assistant({
              ...message,
              content: [
                new SessionMessage.AssistantText({
                  type: "text",
                  id: "later",
                  text: "NEWER_ASSISTANT_IS_NOT_A_RESULT",
                }),
              ],
            }),
          ),
        })
        .run()
      const before = yield* db.select({ total: count() }).from(TaskRunTable).get()
      const item = (yield* TaskSummary.read(db, scope)).items[0]
      expect(item?.state).toBe("unknown")
      expect(item?.runID).toBeNull()
      expect(item?.controlState).toBeNull()
      expect(item?.settledAt).toBeNull()
      expect(item?.result).toEqual({
        state: "available",
        text: "Exact recorded Goal result",
        messageID: message.id,
        truncated: false,
      })
      expect(item?.notification).toEqual({
        state: "not_established",
        updatedAt: null,
        deliveredAt: null,
      })
      expect(yield* db.select({ total: count() }).from(TaskRunTable).get()).toEqual(before)
    }),
  ))

test("Goal recorded result rejects changed body and a foreign result reference without using latest text", () =>
  recordedGoal(({ db, unit, message, scope }) =>
    Effect.gen(function* () {
      yield* db
        .update(SessionMessageTable)
        .set({
          data: Schema.encodeSync(SessionMessage.Assistant)(
            new SessionMessage.Assistant({
              ...message,
              content: [
                new SessionMessage.AssistantText({
                  type: "text",
                  id: "changed",
                  text: "CHANGED_BODY_MUST_NOT_BECOME_AVAILABLE",
                }),
              ],
            }),
          ),
        })
        .where(eq(SessionMessageTable.id, message.id))
        .run()
      expect((yield* TaskSummary.read(db, scope)).items[0]?.result).toEqual({
        state: "unknown",
        text: null,
        messageID: null,
        truncated: false,
      })
      yield* db
        .update(SessionMessageTable)
        .set({ data: Schema.encodeSync(SessionMessage.Assistant)(message) })
        .where(eq(SessionMessageTable.id, message.id))
        .run()
      yield* db
        .update(GoalChildUnitTable)
        .set({
          inputs: unit.inputs.map((input) => ({
            ...input,
            resultRef: "msg_summary_foreign_result",
          })),
        })
        .where(eq(GoalChildUnitTable.unit_id, unit.unit_id))
        .run()
      expect((yield* TaskSummary.read(db, scope)).items[0]?.result.state).toBe("unknown")
    }),
  ))

test("Goal recorded result rejects foreign scope binding and unsettled execution", () =>
  recordedGoal(({ db, unit, scope }) =>
    Effect.gen(function* () {
      const foreign = {
        ...unit.binding,
        directory: scope.directory + "-foreign",
      }
      yield* db
        .update(GoalChildUnitTable)
        .set({
          binding: foreign,
          binding_hash: GoalControl.fingerprint(foreign),
        })
        .where(eq(GoalChildUnitTable.unit_id, unit.unit_id))
        .run()
      expect((yield* TaskSummary.read(db, scope)).items[0]?.result.state).toBe("unknown")
      yield* db
        .update(GoalChildUnitTable)
        .set({
          binding: unit.binding,
          binding_hash: unit.binding_hash,
          inputs: unit.inputs.map((input) => ({
            ...input,
            execution: input.execution ? { ...input.execution, state: "recovery_required" } : undefined,
          })),
        })
        .where(eq(GoalChildUnitTable.unit_id, unit.unit_id))
        .run()
      expect((yield* TaskSummary.read(db, scope)).items[0]?.result.state).toBe("unknown")
    }),
  ))
