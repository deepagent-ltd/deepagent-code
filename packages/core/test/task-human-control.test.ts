import { describe, expect } from "bun:test"
import path from "node:path"
import { eq, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Attention } from "../src/attention"
import { AttentionWorkSource } from "../src/attention/work-source"
import { Database } from "../src/database/database"
import { PermissionSavedEpochTable } from "../src/permission/sql"
import { AbsolutePath } from "../src/schema"
import { SessionMessage } from "../src/session/message"
import { Prompt } from "../src/session/prompt"
import { SessionSchema } from "../src/session/schema"
import { SessionStore } from "../src/session/store"
import { SessionTable, TaskRunEventTable, TaskRunTable } from "../src/session/sql"
import { TaskRunAuthority } from "../src/session/task-run"
import { TaskHumanControl } from "../src/session/task-human-control"
import { TaskHumanControlSchema } from "../src/session/task-human-control.schema"
import { Project } from "../src/project"
import { services, temporary, seedSession, capability } from "./fixture/attention"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
const admit = (db: Database.Interface["db"], parent: SessionSchema.ID, key: string) =>
  TaskRunAuthority.admitRun(db, {
    parentSessionID: parent,
    parentMessageID: SessionMessage.ID.make(`msg_human_${key}`),
    toolCallID: `call_${key}`,
    prompt: new Prompt({ text: "A genuine registered task" }),
    deliveryMode: "background",
    agent: "general",
    child: { title: key, location: { directory: AbsolutePath.make("/tmp/project-a") }, permissions: [] },
  })
const command = (
  db: Database.Interface["db"],
  run: TaskRunAuthority.Run,
  requestID: string,
  action: TaskHumanControlSchema.Action,
) =>
  Effect.gen(function* () {
    const item = yield* AttentionWorkSource.read(db, "task", `task:${run.childSessionID}:${run.generation}`)
    if (!item?.source.task) return yield* Effect.die("Original Task source is missing")
    return {
      runID: run.runID,
      parentSessionID: run.parentSessionID,
      childSessionID: item.source.task.childSessionID,
      generation: run.generation,
      expectedVersion: item.source.task.version,
      itemID: item.id,
      itemRevision: item.revision,
      requestID,
      action,
      reason: "A deliberate human control on the original task",
    }
  })
const counts = (db: Database.Interface["db"]) =>
  db
    .all(
      sql`SELECT
  (SELECT count(*) FROM task_run_event) AS events,(SELECT count(*) FROM session_v2_task_run_receipt) AS terminals,
  (SELECT count(*) FROM task_notification_outbox) AS outbox,(SELECT count(*) FROM session_input) AS inputs,
  (SELECT count(*) FROM session_v2_provider_turn_receipt) AS providers`,
    )
    .pipe(Effect.orDie)
// This Core oracle installs the embedding-host Actor interface and verifies its current parent
// against the actual DB. HTTP credential/Origin evidence belongs to the separate Host adapter.
const operator = (db: Database.Interface["db"]) => ({
  current: (parentID: string) =>
    db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.id, SessionSchema.ID.make(parentID)))
      .get()
      .pipe(
        Effect.orDie,
        Effect.flatMap((row) =>
          row
            ? Effect.succeed({ principal: "operator-fixture" })
            : Effect.fail(
                new TaskHumanControlSchema.Error({
                  code: "auth_required",
                  message: "The real parent is absent",
                }),
              ),
        ),
      ),
})

describe("receipt-backed human Task controls", () => {
  it.live(
    "original known recovery closes once; exact retry, conflicting reuse, stale scope and missing actor cannot mutate",
    () =>
      Effect.gen(function* () {
        const dir = yield* temporary
        yield* Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const parent = yield* seedSession({ db }, "human-known")
          const admitted = yield* admit(db, parent, "known-before-dispatch")
          // A pre-dispatch crash frontier, with no provider, owner, tool effect or terminal evidence.
          yield* db
            .update(TaskRunTable)
            .set({ state: "recovery_required" })
            .where(eq(TaskRunTable.run_id, admitted.run.runID))
            .run()
            .pipe(Effect.orDie)
          const input = yield* command(db, admitted.run, "known-close-command", "resolve_closed")
          const before = yield* counts(db)
          expect((yield* TaskHumanControl.control(db, input).pipe(Effect.flip)).code).toBe("auth_required")
          expect(
            (yield* TaskHumanControl.control(db, { ...input, principal: "operator-fixture" }).pipe(Effect.flip)).code,
          ).toBe("invalid_request")
          expect(
            (yield* TaskHumanControl.control(db, { ...input, access: { authorized: true } }).pipe(Effect.flip)).code,
          ).toBe("invalid_request")
          expect(yield* counts(db)).toEqual(before)
          yield* Effect.gen(function* () {
            const closed = yield* TaskHumanControl.control(db, input)
            expect(closed.replayed).toBe(false)
            expect(closed.receipt.state).toBe("closed")
            expect(closed.receipt.controlState).toBe("closed")
            expect(closed.receipt.terminalReceiptID).toBeString()
            expect(closed.receipt.request).toEqual(input)
            expect(closed.receipt.authority.permissionEpoch).toBe(0)
            const after = yield* counts(db)
            expect(yield* TaskHumanControl.control(db, input)).toEqual({ receipt: closed.receipt, replayed: true })
            expect(yield* counts(db)).toEqual(after)
            expect(
              (yield* TaskHumanControl.control(db, { ...input, reason: "Different reason" }).pipe(Effect.flip)).code,
            ).toBe("request_conflict")
            const event = yield* db
              .select()
              .from(TaskRunEventTable)
              .where(eq(TaskRunEventTable.event_id, closed.receipt.receiptID))
              .get()
              .pipe(Effect.orDie)
            expect(event?.type).toBe("recovery_resolved")
            expect(event?.version).toBe(closed.receipt.version)
            expect(event?.data).toEqual(closed.receipt)
            expect(Buffer.byteLength(JSON.stringify(event?.data))).toBeLessThanOrEqual(
              TaskHumanControl.MAX_RECEIPT_BYTES,
            )
            yield* db
              .insert(PermissionSavedEpochTable)
              .values({ project_id: Project.ID.make("project-a"), epoch: 1, updated_at: Date.now() })
              .onConflictDoUpdate({
                target: PermissionSavedEpochTable.project_id,
                set: { epoch: 1, updated_at: Date.now() },
              })
              .run()
              .pipe(Effect.orDie)
            expect((yield* TaskHumanControl.control(db, input).pipe(Effect.flip)).code).toBe("scope_changed")
            expect(yield* counts(db)).toEqual(after)
            const other = yield* admit(db, parent, "another-original-run")
            yield* db
              .update(TaskRunTable)
              .set({ state: "recovery_required" })
              .where(eq(TaskRunTable.run_id, other.run.runID))
              .run()
              .pipe(Effect.orDie)
            const another = yield* command(db, other.run, "known-close-command", "resolve_failed")
            const collisionBefore = yield* counts(db)
            expect((yield* TaskHumanControl.control(db, another).pipe(Effect.flip)).code).toBe("request_conflict")
            expect((yield* TaskRunAuthority.get(db, other.run.runID))?.state).toBe("recovery_required")
            expect(yield* counts(db)).toEqual(collisionBefore)
            const changed = yield* command(db, other.run, "fresh-command", "resolve_failed")
            yield* db
              .update(SessionTable)
              .set({ v2_authority: false })
              .where(eq(SessionTable.id, parent))
              .run()
              .pipe(Effect.orDie)
            expect((yield* TaskHumanControl.control(db, changed).pipe(Effect.flip)).code).toBe("scope_changed")
            expect(yield* counts(db)).toEqual(collisionBefore)
          }).pipe(Effect.provideService(TaskHumanControl.Actor, operator(db)))
        }).pipe(
          Effect.provide(services(path.join(dir, "commands.sqlite"))),
          Effect.provideService(Attention.Access, capability),
        )
      }),
  )
  it.live(
    "a real foreign execution claim permits only close intent; receipt retry and per-run bounds keep unknown custody",
    () =>
      Effect.gen(function* () {
        const dir = yield* temporary
        yield* Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const parent = yield* seedSession({ db }, "human-unknown")
          const admitted = yield* admit(db, parent, "unknown-claim")
          yield* db
            .insert(SessionTable)
            .values({
              id: admitted.run.childSessionID,
              project_id: Project.ID.make("project-a"),
              parent_id: parent,
              directory: "/tmp/project-a",
              slug: "claimed-child",
              title: "Claimed original child",
              version: "test",
              v2_authority: true,
            })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .update(TaskRunTable)
            .set({ state: "recovery_required", phase: "research", input_state: "ready" })
            .where(eq(TaskRunTable.run_id, admitted.run.runID))
            .run()
            .pipe(Effect.orDie)
          const store = yield* SessionStore.Service
          const token = yield* store.claim(admitted.run.childSessionID)
          expect(token).toBeNumber()
          yield* Effect.gen(function* () {
            const resolve = yield* command(db, admitted.run, "unknown-resolve-command", "resolve_closed")
            const before = yield* counts(db)
            expect((yield* TaskHumanControl.control(db, resolve).pipe(Effect.flip)).code).toBe("custody_required")
            expect(yield* counts(db)).toEqual(before)
            const close = yield* command(db, admitted.run, "unknown-close-command", "request_close")
            const result = yield* TaskHumanControl.control(db, close)
            expect(result.receipt.state).toBe("recovery_required")
            expect(result.receipt.controlState).toBe("close_requested")
            expect(result.receipt.terminalReceiptID).toBeNull()
            expect(yield* store.claimToken(admitted.run.childSessionID)).toBe(token)
            const after = yield* counts(db)
            expect(yield* TaskHumanControl.control(db, close)).toEqual({ receipt: result.receipt, replayed: true })
            expect(yield* counts(db)).toEqual(after)
            expect(
              (yield* TaskHumanControl.control(db, { ...resolve, requestID: "stale-command" }).pipe(Effect.flip)).code,
            ).toBe("source_changed")
            for (let index = 1; index < TaskHumanControl.MAX_COMMANDS; index++) {
              yield* TaskHumanControl.control(
                db,
                yield* command(db, admitted.run, `bounded-close-${index}`, "request_close"),
              )
            }
            const bounded = yield* counts(db)
            expect(
              (yield* TaskHumanControl.control(
                db,
                yield* command(db, admitted.run, "limit-plus-one", "request_close"),
              ).pipe(Effect.flip)).code,
            ).toBe("command_limit")
            expect(yield* counts(db)).toEqual(bounded)
            expect(yield* store.claimToken(admitted.run.childSessionID)).toBe(token)
            expect((yield* TaskRunAuthority.get(db, admitted.run.runID))?.state).toBe("recovery_required")
            expect(
              (yield* db
                .select({ count: sql<number>`count(*)` })
                .from(TaskRunEventTable)
                .where(sql`${TaskRunEventTable.event_id} LIKE 'evthuman_%'`)
                .get())?.count,
            ).toBe(TaskHumanControl.MAX_COMMANDS)
            expect(
              (yield* db
                .select({ value: TaskRunTable.time_settled })
                .from(TaskRunTable)
                .where(eq(TaskRunTable.run_id, admitted.run.runID))
                .get())?.value,
            ).toBeNull()
          }).pipe(Effect.provideService(TaskHumanControl.Actor, operator(db)))
        }).pipe(
          Effect.provide(services(path.join(dir, "unknown.sqlite"))),
          Effect.provideService(Attention.Access, capability),
        )
      }),
  )
})
