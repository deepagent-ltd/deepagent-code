import { describe, expect } from "bun:test"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Attention } from "../src/attention"
import { AttentionSeenTable } from "../src/attention/sql"
import { Database } from "../src/database/database"
import { DeepAgentActivityAuthority } from "../src/deepagent/activity-authority"
import { PermissionSaved } from "../src/permission/saved"
import { Project } from "../src/project"
import { V2ProviderTurnReceiptTable } from "../src/session/runner/v2-provider-turn.sql"
import { seedActivity, services, temporary } from "./fixture/attention"
import { testEffect } from "./lib/effect"
import { challenge } from "./fixture/attention-permission"

const it = testEffect(Layer.empty)
const changes = (database: Database.Interface) =>
  database.db.get<{ value: number }>(sql`SELECT total_changes() AS value`).pipe(Effect.orDie)

describe("current no-progress attention", () => {
  it.live(
    "projects current approvals across projects, paginates with failures and reads without execution or writes",
    () =>
      Effect.gen(function* () {
        const directory = yield* temporary
        yield* Effect.gen(function* () {
          const database = yield* Database.Service
          const attention = yield* Attention.Service
          const a = yield* challenge(database, "a")
          const b = yield* challenge(database, "b", { project: "project-b" })
          yield* challenge(database, "remote", { workspace: "wrk_remote" })
          yield* seedActivity(database, a.sessionID, "failed", "failed", 200)
          const before = yield* changes(database)
          const first = yield* attention.list({ limit: 1 })
          const second = yield* attention.list({ limit: 1, cursor: first.nextCursor })
          const third = yield* attention.list({ limit: 1, cursor: second.nextCursor })
          expect(first.unseenCount).toBe(3)
          expect(second.unseenCount).toBe(3)
          expect([first.data[0]!.kind, second.data[0]!.kind, third.data[0]!.kind]).toEqual([
            "no_progress",
            "no_progress",
            "activity_failed",
          ])
          expect(third.nextCursor).toBeUndefined()
          const item = yield* attention.get(`approval:${b.requestID}`)
          expect(item).toMatchObject({
            kind: "no_progress",
            state: "needs_human",
            session: { id: b.sessionID, projectID: "project-b" },
            source: { permissionRequestID: b.requestID },
            allowedActions: ["continue_once", "terminate"],
          })
          expect(JSON.stringify(item)).not.toContain(b.ownerID)
          expect((yield* attention.list({ project: "project-b", kind: "no_progress" })).data).toHaveLength(1)
          expect((yield* attention.list({ kind: "activity_failed" })).data).toHaveLength(1)
          expect((yield* attention.list({ kind: "execution_recovery" })).data).toHaveLength(0)
          expect(yield* changes(database)).toEqual(before)
          expect(
            yield* database.db
              .get(sql`SELECT count(*) AS value FROM session_activity_permission_decision`)
              .pipe(Effect.orDie),
          ).toEqual({ value: 0 })
          expect(
            yield* database.db.get(sql`SELECT count(*) AS value FROM ${V2ProviderTurnReceiptTable}`).pipe(Effect.orDie),
          ).toEqual({ value: 0 })
        }).pipe(Effect.provide(services(path.join(directory, "approval.db"))))
      }),
  )

  it.live("keeps seen revision stable across heartbeats and removes a dead owner before recovery rotates it", () =>
    Effect.gen(function* () {
      const directory = yield* temporary
      yield* Effect.gen(function* () {
        const database = yield* Database.Service
        const attention = yield* Attention.Service
        const source = yield* challenge(database, "lease", { leaseMs: 500 })
        const original = yield* attention.get(`approval:${source.requestID}`)
        const marked = yield* attention.seen(original.id, original.revision)
        expect(marked.seen).toBe(true)
        yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({ ownerID: source.ownerID, leaseMs: 1000 })
        expect(yield* attention.get(original.id)).toMatchObject({
          revision: original.revision,
          seen: true,
          seenAt: marked.seenAt,
        })
        // Let the real SQL lease expire; this read model does not initialize a recovery owner.
        yield* Effect.sleep("1100 millis")
        const before = yield* changes(database)
        expect(yield* attention.get(original.id).pipe(Effect.flip)).toBeInstanceOf(Attention.NotFound)
        expect((yield* attention.list()).data).toEqual([])
        expect(yield* attention.seen(original.id, original.revision).pipe(Effect.flip)).toBeInstanceOf(
          Attention.NotFound,
        )
        expect(yield* changes(database)).toEqual(before)
        expect(yield* database.db.select().from(AttentionSeenTable).all().pipe(Effect.orDie)).toHaveLength(1)
      }).pipe(Effect.provide(services(path.join(directory, "lease.db"))))
    }),
  )

  it.live("retains only termination with a new revision after the saved-permission authority advances", () =>
    Effect.gen(function* () {
      const directory = yield* temporary
      yield* Effect.gen(function* () {
        const database = yield* Database.Service
        const attention = yield* Attention.Service
        const source = yield* challenge(database, "epoch")
        const original = yield* attention.get(`approval:${source.requestID}`)
        yield* Effect.gen(function* () {
          yield* (yield* PermissionSaved.Service).add({
            projectID: Project.ID.make("project-a"),
            action: "read",
            resources: ["README.md"],
          })
        }).pipe(Effect.provide(PermissionSaved.layer.pipe(Layer.provide(Layer.succeed(Database.Service, database)))))
        const before = yield* changes(database)
        const changed = yield* attention.get(original.id)
        expect(changed.allowedActions).toEqual(["terminate"])
        expect(changed.revision).not.toBe(original.revision)
        expect(changed.seen).toBe(false)
        expect((yield* attention.list({ kind: "no_progress" })).data[0]).toMatchObject({
          id: original.id, revision: changed.revision, allowedActions: ["terminate"],
        })
        expect(yield* attention.seen(original.id, original.revision).pipe(Effect.flip)).toBeInstanceOf(Attention.Stale)
        expect(yield* changes(database)).toEqual(before)
      }).pipe(Effect.provide(services(path.join(directory, "epoch.db"))))
    }),
  )
})
