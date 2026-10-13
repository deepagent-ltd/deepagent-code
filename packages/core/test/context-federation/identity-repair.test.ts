import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "../../src/database/database"
import { FSUtil } from "../../src/fs-util"
import { AbsolutePath } from "../../src/schema"
import { LocationIdentity } from "../../src/context-federation/identity"
import {
  LocationIdentityAliasTable,
  LocationIdentityTable,
  ProjectScopeIdentityTable,
} from "../../src/context-federation/sql"
import { WorkAuthority } from "../../src/session/work-authority"
import { WorkDispatchReservationTable, WorkExecutionTable } from "../../src/session/work-authority.sql"
import { WorkAuthorityFixture } from "../fixture/work-authority"
import { tmpdir } from "../fixture/tmpdir"

function run<A, E>(filename: string, effect: Effect.Effect<A, E, LocationIdentity.Service | Database.Service>) {
  const database = WorkAuthorityFixture.database(filename)
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          database,
          LocationIdentity.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer)),
        ),
      ),
      Effect.provide(WorkAuthorityFixture.verifier),
      Effect.scoped,
    ),
  )
}

test("registered-root repair preserves identity, requires the exact old observation, and leaves sibling roots unchanged", async () => {
  await using tmp = await tmpdir()
  const directory = AbsolutePath.make(path.join(tmp.path, "a", "project"))
  const sibling = AbsolutePath.make(path.join(tmp.path, "b", "project"))
  await Promise.all([fs.mkdir(directory, { recursive: true }), fs.mkdir(sibling, { recursive: true })])
  await run(
    path.join(tmp.path, "database.sqlite"),
    Effect.gen(function* () {
      yield* WorkAuthorityFixture.initialize()
      const db = (yield* Database.Service).db
      const service = yield* LocationIdentity.Service
      const boundary = { kind: "implicit_local" as const }
      const old = yield* service.resolve({
        boundary,
        directory,
        project: { kind: "registered_root", observedProjectId: "global" },
      })
      const other = yield* service.resolve({
        boundary,
        directory: sibling,
        project: { kind: "registered_root", observedProjectId: "global" },
      })
      const before = yield* db.select().from(LocationIdentityTable)
      const expected = yield* service.inspectObservedProjectBinding({ boundary, directory })
      expect(yield* db.select().from(LocationIdentityTable)).toEqual(before)
      expect(expected.locationObservedProjectId).toBe("global")
      expect(expected.projectObservedProjectId).toBe("global")
      const repaired = yield* service.repairObservedProjectBinding({
        boundary,
        directory,
        expected,
        nextObservedProjectId: "actual-observed-project",
      })
      expect(repaired).toEqual({ ...old, observedProjectId: "actual-observed-project" })
      expect(
        yield* service.lookup({
          boundary,
          directory,
          project: { kind: "registered_root", observedProjectId: "actual-observed-project" },
        }),
      ).toEqual(repaired)
      expect(
        yield* service
          .lookup({ boundary, directory, project: { kind: "registered_root", observedProjectId: "global" } })
          .pipe(Effect.flip),
      ).toBeInstanceOf(LocationIdentity.ConflictError)
      expect(
        yield* service.lookup({
          boundary,
          directory: sibling,
          project: { kind: "registered_root", observedProjectId: "global" },
        }),
      ).toEqual(other)
      const after = yield* db.select().from(LocationIdentityTable)
      expect(
        yield* service
          .repairObservedProjectBinding({ boundary, directory, expected, nextObservedProjectId: "different" })
          .pipe(Effect.flip),
      ).toBeInstanceOf(LocationIdentity.ConflictError)
      expect(yield* db.select().from(LocationIdentityTable)).toEqual(after)
      const current = yield* service.inspectObservedProjectBinding({ boundary, directory })
      for (const stale of [
        { ...current, locationCreatedAt: current.locationCreatedAt + 1 },
        { ...current, projectCreatedAt: current.projectCreatedAt + 1 },
        { ...current, projectIdentityHash: "0".repeat(64) },
        { ...current, locationObservedProjectId: "forged" },
        { ...current, projectObservedProjectId: "forged" },
      ]) {
        expect(
          yield* service
            .repairObservedProjectBinding({ boundary, directory, expected: stale, nextObservedProjectId: "different" })
            .pipe(Effect.flip),
        ).toBeInstanceOf(LocationIdentity.ConflictError)
      }
      expect(yield* db.select().from(LocationIdentityTable)).toEqual(after)
    }),
  )
})

test("repair refuses pending, ready-pending, unknown and unresolved provider custody in its actual SQLite transaction", async () => {
  await using tmp = await tmpdir()
  const directory = AbsolutePath.make(path.join(tmp.path, "project"))
  await fs.mkdir(directory)
  await run(
    path.join(tmp.path, "database.sqlite"),
    Effect.gen(function* () {
      yield* WorkAuthorityFixture.initialize()
      const db = (yield* Database.Service).db
      const service = yield* LocationIdentity.Service
      const boundary = { kind: "implicit_local" as const }
      const old = yield* service.resolve({
        boundary,
        directory,
        project: { kind: "registered_root", observedProjectId: "global" },
      })
      const expected = yield* service.inspectObservedProjectBinding({ boundary, directory })
      const input = WorkAuthorityFixture.binding("repair")
      const binding = {
        ...input,
        location: { directory },
        scope: { ...input.scope, securityNamespaceID: old.securityNamespaceId, projectScopeKey: old.projectScopeKey },
      }
      // Actual reserve through the existing controlled source verifier; no Session runner or provider is built.
      yield* WorkAuthority.reserve(db, { binding, now: WorkAuthorityFixture.NOW })
      const repair = () =>
        service.repairObservedProjectBinding({
          boundary,
          directory,
          expected,
          nextObservedProjectId: "actual-observed-project",
        })
      expect(yield* repair().pipe(Effect.flip)).toBeInstanceOf(LocationIdentity.WorkUnsettledError)
      yield* db
        .update(WorkExecutionTable)
        .set({ admission_state: "ready", admitted_seq: 1 })
        .where(eq(WorkExecutionTable.work_id, binding.workID))
        .run()
      expect(yield* repair().pipe(Effect.flip)).toBeInstanceOf(LocationIdentity.WorkUnsettledError)
      yield* db
        .update(WorkExecutionTable)
        .set({ outcome: "unknown", control_state: "revoked" })
        .where(eq(WorkExecutionTable.work_id, binding.workID))
        .run()
      expect(yield* repair().pipe(Effect.flip)).toBeInstanceOf(LocationIdentity.WorkUnsettledError)
      yield* db
        .update(WorkExecutionTable)
        .set({ outcome: "failed" })
        .where(eq(WorkExecutionTable.work_id, binding.workID))
        .run()
      yield* db
        .insert(WorkDispatchReservationTable)
        .values({
          reservation_id: "reservation-repair",
          work_id: binding.workID,
          root_work_id: binding.rootWorkID,
          kind: "provider",
          dispatch_key: "dispatch-repair",
          request_hash: "a".repeat(64),
          receipt_id: "receipt-repair",
          attempt_id: "attempt-repair",
          session_claim_token: 1,
          owner_token: "owner-repair",
          control_revision: 1,
          context_selection_id: "selection-repair",
          context_projection_hash: "b".repeat(64),
          state: "unknown",
          input_bound: { tokens: 1, kind: "exact", evidenceID: "count-repair", evidenceHash: "c".repeat(64) },
          reserved_input_tokens: 1,
          reserved_completion_tokens: 1,
          reserved_total_tokens: 2,
          charged_tokens: 2,
          wire_hash: "d".repeat(64),
          endpoint: "https://example.invalid",
          created_at: 1,
          dispatching_at: 1,
        })
        .run()
      expect(yield* repair().pipe(Effect.flip)).toBeInstanceOf(LocationIdentity.WorkUnsettledError)
      expect(yield* service.inspectObservedProjectBinding({ boundary, directory })).toEqual(expected)
      yield* db
        .update(WorkDispatchReservationTable)
        .set({ state: "settled", actual_usage: { inputTokens: 1, completionTokens: 1 }, settled_at: 2 })
        .run()
      const workBefore = yield* db.select().from(WorkExecutionTable)
      const dispatchBefore = yield* db.select().from(WorkDispatchReservationTable)
      expect((yield* repair()).observedProjectId).toBe("actual-observed-project")
      expect(yield* db.select().from(WorkExecutionTable)).toEqual(workBefore)
      expect(yield* db.select().from(WorkDispatchReservationTable)).toEqual(dispatchBefore)
    }),
  )
})

test("inspect and repair never adopt a symlink, migrated alias, wrong namespace or retired scope", async () => {
  await using tmp = await tmpdir()
  const directory = AbsolutePath.make(path.join(tmp.path, "project"))
  const alias = AbsolutePath.make(path.join(tmp.path, "alias"))
  await fs.mkdir(directory)
  await fs.symlink(directory, alias)
  await run(
    path.join(tmp.path, "database.sqlite"),
    Effect.gen(function* () {
      yield* WorkAuthorityFixture.initialize()
      const db = (yield* Database.Service).db
      const service = yield* LocationIdentity.Service
      const boundary = { kind: "implicit_local" as const }
      const old = yield* service.resolve({
        boundary,
        directory,
        project: { kind: "registered_root", observedProjectId: "global" },
      })
      const expected = yield* service.inspectObservedProjectBinding({ boundary, directory })
      expect(
        yield* service.inspectObservedProjectBinding({ boundary, directory: alias }).pipe(Effect.flip),
      ).toBeInstanceOf(LocationIdentity.ConflictError)
      expect(
        yield* service
          .repairObservedProjectBinding({
            boundary: { kind: "workspace", tenantId: "different", workspaceId: "different" },
            directory,
            expected,
            nextObservedProjectId: "different",
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(LocationIdentity.NotFoundError)
      yield* db
        .insert(LocationIdentityAliasTable)
        .values({
          security_namespace_id: old.securityNamespaceId,
          location_key: old.locationKey,
          old_canonical_root: path.join(tmp.path, "old"),
          reason: "existing explicit move",
          created_at: 1,
        })
        .run()
      expect(yield* service.inspectObservedProjectBinding({ boundary, directory }).pipe(Effect.flip)).toBeInstanceOf(
        LocationIdentity.ConflictError,
      )
      yield* db.delete(LocationIdentityAliasTable).run()
      yield* db.update(ProjectScopeIdentityTable).set({ retired_at: 1 }).run()
      expect(
        yield* service
          .repairObservedProjectBinding({ boundary, directory, expected, nextObservedProjectId: "different" })
          .pipe(Effect.flip),
      ).toBeInstanceOf(LocationIdentity.RetiredError)
      expect((yield* db.select().from(LocationIdentityTable).get())?.observed_project_id).toBe("global")
    }),
  )
})
