import { describe, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Effect, Exit, Layer, Option, Result } from "effect"
import { LocationIdentity } from "../../src/context-federation/identity"
import { Database } from "../../src/database/database"
import { DocumentStore, type Doc } from "../../src/deepagent/document-store"
import { DeepAgentReleasedSnapshot, type DocumentRef, type PublishInput } from "../../src/deepagent/released-snapshot"
import {
  ReleasedKnowledgeEvaluationTable,
  ReleasedKnowledgeSnapshotDocumentTable,
  ReleasedKnowledgeSnapshotHeadTable,
  ReleasedKnowledgeSnapshotTable,
} from "../../src/deepagent/released-snapshot.sql"
import { FSUtil } from "../../src/fs-util"
import { AbsolutePath } from "../../src/schema"
import { CanonicalJson } from "../../src/util/canonical-json"
import { Hash } from "../../src/util/hash"
import { tmpdir } from "../fixture/tmpdir"

const publish = (
  db: Database.Interface["db"],
  value: PublishInput,
  authority = documentAuthority(value.scope.legacyProjectId, value.documents),
) => DeepAgentReleasedSnapshot.publish(db, value, authority)

describe("released knowledge snapshot authority", () => {
  test("replaces one parent revision but rejects duplicate addition authorities", () => {
    const v1 = document("merge-authority", 1)
    const v2 = document("merge-authority", 2)
    expect(DeepAgentReleasedSnapshot.mergeDocuments([v1], [v2])).toEqual([v2])
    expect(() => DeepAgentReleasedSnapshot.mergeDocuments([v1], [v2, v2])).toThrow(
      DeepAgentReleasedSnapshot.SnapshotDocumentError,
    )
    expect(() => DeepAgentReleasedSnapshot.mergeDocuments([], [v1, v2])).toThrow(
      DeepAgentReleasedSnapshot.SnapshotDocumentError,
    )
  })

  test("revokes one exact cross-store authority with head CAS while preserving historical replay", async () => {
    await using tmp = await tmpdir()
    await run(
      tmp.path,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const scope = yield* makeScope(tmp.path)
        const project = document("same-revoke-id", 1)
        const userGlobal = {
          ...project,
          sourceStore: "user_global" as const,
          scope: "durable",
        }
        const authority = documentAuthority(tmp.path, [project, userGlobal])
        const baseline = yield* publish(
          db,
          input({
            snapshotId: "snapshot-revoke-baseline",
            evaluationId: "evaluation-revoke-baseline",
            scope,
            releaseKind: "legacy_baseline",
            documents: [project, userGlobal],
          }),
          authority,
        )
        const competing = yield* publish(
          db,
          input({
            snapshotId: "snapshot-revoke-competing",
            evaluationId: "evaluation-revoke-competing",
            scope,
            expectedParentSnapshotId: baseline!.snapshotId,
            expectedGeneration: baseline!.generation,
            releaseKind: "rollback",
            documents: baseline!.documents,
          }),
          authority,
        )

        const stale = yield* DeepAgentReleasedSnapshot.revoke(
          db,
          {
            scope,
            expectedParent: baseline!,
            document: project,
            actor: { type: "human", id: "reviewer" },
          },
          authority,
        ).pipe(Effect.flip)
        expect(stale).toMatchObject({ _tag: "DeepAgentReleasedSnapshot.SnapshotConflictError" })
        expect(yield* DeepAgentReleasedSnapshot.current(db, scope)).toEqual(competing)
        expect(
          yield* db
            .select({ snapshotId: ReleasedKnowledgeSnapshotTable.snapshot_id })
            .from(ReleasedKnowledgeSnapshotTable)
            .where(sql`${ReleasedKnowledgeSnapshotTable.snapshot_id} LIKE 'snapshot_revocation_%'`)
            .all(),
        ).toEqual([])

        const forged = yield* DeepAgentReleasedSnapshot.revoke(
          db,
          {
            scope,
            expectedParent: { ...competing!, documents: [userGlobal] },
            document: userGlobal,
            actor: { type: "human", id: "reviewer" },
          },
          authority,
        ).pipe(Effect.flip)
        expect(forged).toMatchObject({
          _tag: "DeepAgentReleasedSnapshot.SnapshotIntegrityError",
          reason: "revocation parent does not match the durable released snapshot authority",
        })
        expect(yield* DeepAgentReleasedSnapshot.current(db, scope)).toEqual(competing)

        const revoked = yield* DeepAgentReleasedSnapshot.revoke(
          db,
          {
            scope,
            expectedParent: competing!,
            document: project,
            actor: { type: "human", id: "reviewer" },
          },
          authority,
        )
        expect(revoked.state).toBe("revoked")
        expect(revoked.selection.generation).toBe(3)
        expect(revoked.selection.documents).toEqual([userGlobal])
        expect((yield* DeepAgentReleasedSnapshot.get(db, scope, baseline!.snapshotId))?.documents).toEqual([
          project,
          userGlobal,
        ])
        expect(
          yield* DeepAgentReleasedSnapshot.findRevocation(db, {
            scope,
            document: project,
            actor: { type: "human", id: "reviewer" },
          }),
        ).toMatchObject({ state: "already_revoked", selection: { snapshotId: revoked.selection.snapshotId } })
      }),
    )
  })

  test("publishes an explicit baseline, preserves historical generation, and keeps failed releases off head", async () => {
    await using tmp = await tmpdir()
    await run(
      tmp.path,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const scope = yield* makeScope(tmp.path)
        const baselineInput = input({
          snapshotId: "snapshot-baseline",
          evaluationId: "evaluation-baseline",
          scope,
          releaseKind: "legacy_baseline",
          documents: [document("knowledge", 1)],
          now: 100,
        })
        const authority = documentAuthority(tmp.path, baselineInput.documents)
        const baseline = yield* publish(db, baselineInput, authority)
        expect(baseline).toMatchObject({ snapshotId: "snapshot-baseline", generation: 1 })

        const nextInput = input({
          snapshotId: "snapshot-next",
          evaluationId: "evaluation-next",
          scope,
          expectedParentSnapshotId: "snapshot-baseline",
          expectedGeneration: 1,
          documents: [document("knowledge", 2)],
          now: 200,
        })
        registerDocuments(authority, nextInput.documents)
        const next = yield* publish(db, nextInput, authority)
        expect(next).toMatchObject({ snapshotId: "snapshot-next", generation: 2 })
        expect((yield* DeepAgentReleasedSnapshot.current(db, scope))?.documents[0]?.version).toBe(2)

        const retriedBaseline = yield* publish(db, baselineInput, authority)
        expect(retriedBaseline).toMatchObject({ snapshotId: "snapshot-baseline", generation: 1 })
        expect(retriedBaseline?.documents[0]?.version).toBe(1)

        const failedInput = input({
          snapshotId: "snapshot-failed",
          evaluationId: "evaluation-failed",
          scope,
          expectedParentSnapshotId: "snapshot-next",
          expectedGeneration: 2,
          verdict: "failed",
          failureReason: "regression",
          documents: [document("knowledge", 3)],
          now: 300,
        })
        registerDocuments(authority, failedInput.documents)
        const afterFailure = yield* publish(db, failedInput, authority)
        expect(afterFailure).toMatchObject({ snapshotId: "snapshot-next", generation: 2 })
        expect(yield* publish(db, failedInput, authority)).toEqual(afterFailure)
        expect(yield* DeepAgentReleasedSnapshot.current(db, scope)).toEqual(afterFailure)
        expect(
          yield* db
            .select({ snapshotId: ReleasedKnowledgeSnapshotTable.snapshot_id })
            .from(ReleasedKnowledgeSnapshotTable)
            .where(eq(ReleasedKnowledgeSnapshotTable.snapshot_id, "snapshot-failed"))
            .get(),
        ).toEqual({ snapshotId: "snapshot-failed" })
      }),
    )
  })

  test("requires baseline cutover and exact non-empty membership for a passing evaluated release", async () => {
    await using tmp = await tmpdir()
    await run(
      tmp.path,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const scope = yield* makeScope(tmp.path)
        const missingBaseline = yield* publish(
          db,
          input({
            snapshotId: "snapshot-evaluated-first",
            evaluationId: "evaluation-evaluated-first",
            scope,
            documents: [document("knowledge", 1)],
          }),
        ).pipe(Effect.flip)
        expect(missingBaseline).toMatchObject({
          _tag: "DeepAgentReleasedSnapshot.SnapshotInputError",
          field: "releaseKind",
        })

        yield* publish(
          db,
          input({
            snapshotId: "snapshot-empty-baseline",
            evaluationId: "evaluation-empty-baseline",
            scope,
            releaseKind: "legacy_baseline",
            documents: [],
          }),
        )
        const emptyEvaluated = yield* publish(
          db,
          input({
            snapshotId: "snapshot-empty-evaluated",
            evaluationId: "evaluation-empty-evaluated",
            scope,
            expectedParentSnapshotId: "snapshot-empty-baseline",
            expectedGeneration: 1,
            documents: [],
          }),
        ).pipe(Effect.flip)
        expect(emptyEvaluated).toMatchObject({
          _tag: "DeepAgentReleasedSnapshot.SnapshotInputError",
          field: "documents",
        })
      }),
    )
  })

  test("keeps an upgraded namespace headless until an operator publishes the explicit baseline", async () => {
    await using tmp = await tmpdir()
    await run(
      tmp.path,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const scope = yield* makeScope(tmp.path)

        expect(yield* DeepAgentReleasedSnapshot.current(db, scope)).toBeUndefined()
        expect(
          yield* db
            .select({ snapshotId: ReleasedKnowledgeSnapshotHeadTable.snapshot_id })
            .from(ReleasedKnowledgeSnapshotHeadTable)
            .all(),
        ).toEqual([])

        const baseline = yield* publish(
          db,
          input({
            snapshotId: "snapshot-upgrade-cutover",
            evaluationId: "evaluation-upgrade-cutover",
            scope,
            releaseKind: "legacy_baseline",
            documents: [document("upgrade-cutover", 1)],
          }),
        )

        expect(baseline).toMatchObject({ snapshotId: "snapshot-upgrade-cutover", generation: 1 })
        expect(yield* DeepAgentReleasedSnapshot.current(db, scope)).toEqual(baseline)
      }),
    )
  })

  test("rejects missing, inactive, and wrong-store revisions before writing release state", async () => {
    await using tmp = await tmpdir()
    await run(
      tmp.path,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const scope = yield* makeScope(tmp.path)
        const userGlobal = new DocumentStore(`${tmp.path}/release-user-global`)
        const project = new DocumentStore(`${tmp.path}/release-project`)
        const authority = { userGlobal, project }
        const active = project.seedActive(documentInput("active-project", `durable:project:${scope.legacyProjectId}`))
        const draft = project.create(documentInput("draft-project", `durable:project:${scope.legacyProjectId}`))
        const global = userGlobal.seedActive(documentInput("global-only", "durable"))
        const invalid = [
          { ...DeepAgentReleasedSnapshot.documentRef(active, "project"), id: "missing-project" },
          DeepAgentReleasedSnapshot.documentRef(draft, "project"),
          { ...DeepAgentReleasedSnapshot.documentRef(global, "user_global"), sourceStore: "project" as const },
        ]

        for (const [index, ref] of invalid.entries()) {
          const failed = yield* DeepAgentReleasedSnapshot.publish(
            db,
            input({
              snapshotId: `snapshot-invalid-authority-${index}`,
              evaluationId: `evaluation-invalid-authority-${index}`,
              scope,
              releaseKind: "legacy_baseline",
              documents: [ref],
            }),
            authority,
          ).pipe(Effect.flip)
          expect(failed).toMatchObject({ _tag: "DeepAgentReleasedSnapshot.SnapshotDocumentError" })
        }

        expect(yield* db.select().from(ReleasedKnowledgeEvaluationTable).all()).toEqual([])
        expect(yield* db.select().from(ReleasedKnowledgeSnapshotTable).all()).toEqual([])
        expect(yield* db.select().from(ReleasedKnowledgeSnapshotHeadTable).all()).toEqual([])
      }),
    )
  })

  test("revalidates inherited parent membership before advancing the head", async () => {
    await using tmp = await tmpdir()
    await run(
      tmp.path,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const scope = yield* makeScope(tmp.path)
        const userGlobal = new DocumentStore(`${tmp.path}/parent-user-global`)
        const project = new DocumentStore(`${tmp.path}/parent-project`)
        const active = project.seedActive(documentInput("parent-project", `durable:project:${scope.legacyProjectId}`))
        const ref = DeepAgentReleasedSnapshot.documentRef(active, "project")
        const baseline = yield* DeepAgentReleasedSnapshot.publish(
          db,
          input({
            snapshotId: "snapshot-parent-authority",
            evaluationId: "evaluation-parent-authority",
            scope,
            releaseKind: "legacy_baseline",
            documents: [ref],
          }),
          { userGlobal, project },
        )
        const unavailableAuthority = {
          userGlobal: new DocumentStore(`${tmp.path}/missing-parent-user-global`),
          project: new DocumentStore(`${tmp.path}/missing-parent-project`),
        }

        const failed = yield* DeepAgentReleasedSnapshot.publish(
          db,
          input({
            snapshotId: "snapshot-parent-authority-next",
            evaluationId: "evaluation-parent-authority-next",
            scope,
            expectedParentSnapshotId: baseline?.snapshotId ?? null,
            expectedGeneration: baseline?.generation ?? 0,
            documents: [ref],
          }),
          unavailableAuthority,
        ).pipe(Effect.flip)

        expect(failed).toMatchObject({ _tag: "DeepAgentReleasedSnapshot.SnapshotDocumentError" })
        expect(yield* DeepAgentReleasedSnapshot.current(db, scope)).toEqual(baseline)
        expect(
          yield* db
            .select({ snapshotId: ReleasedKnowledgeSnapshotTable.snapshot_id })
            .from(ReleasedKnowledgeSnapshotTable)
            .all(),
        ).toEqual([{ snapshotId: "snapshot-parent-authority" }])
      }),
    )
  })

  test("enforces immutable release rows and fails closed when stored membership is corrupted", async () => {
    await using tmp = await tmpdir()
    await run(
      tmp.path,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const scope = yield* makeScope(tmp.path)
        yield* publish(
          db,
          input({
            snapshotId: "snapshot-immutable",
            evaluationId: "evaluation-immutable",
            scope,
            releaseKind: "legacy_baseline",
            documents: [document("knowledge", 1)],
          }),
        )

        expect(
          Exit.isFailure(
            yield* db
              .update(ReleasedKnowledgeEvaluationTable)
              .set({ baseline_ref: "tampered" })
              .where(eq(ReleasedKnowledgeEvaluationTable.evaluation_id, "evaluation-immutable"))
              .run()
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run("DROP TRIGGER released_knowledge_evaluation_update_forbidden")
        yield* db
          .update(ReleasedKnowledgeEvaluationTable)
          .set({ matrix_hash: "f".repeat(64) })
          .where(eq(ReleasedKnowledgeEvaluationTable.evaluation_id, "evaluation-immutable"))
          .run()
        expect(yield* DeepAgentReleasedSnapshot.current(db, scope).pipe(Effect.flip)).toMatchObject({
          _tag: "DeepAgentReleasedSnapshot.SnapshotIntegrityError",
          docId: "<evaluation>",
          reason: "released snapshot evaluation matrix hash does not match its immutable evidence",
        })
        yield* db
          .update(ReleasedKnowledgeEvaluationTable)
          .set({ matrix_hash: Hash.sha256(CanonicalJson.stringify({ score: 1 })) })
          .where(eq(ReleasedKnowledgeEvaluationTable.evaluation_id, "evaluation-immutable"))
          .run()
        expect(
          Exit.isFailure(
            yield* db
              .update(ReleasedKnowledgeSnapshotTable)
              .set({ actor_id: "tampered" })
              .where(eq(ReleasedKnowledgeSnapshotTable.snapshot_id, "snapshot-immutable"))
              .run()
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .insert(ReleasedKnowledgeSnapshotDocumentTable)
              .values({
                snapshot_id: "snapshot-immutable",
                ordinal: 1,
                source_store: "project",
                doc_id: "late-document",
                doc_version: 1,
                doc_hash: document("late-document", 1).hash,
                doc_type: "knowledge",
                doc_scope: `durable:project:${scope.legacyProjectId}`,
              })
              .run()
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db
          .insert(ReleasedKnowledgeEvaluationTable)
          .values({
            evaluation_id: "evaluation-prefinalized",
            security_namespace_id: scope.securityNamespaceId,
            project_scope_key: scope.projectScopeKey,
            matrix_hash: "a".repeat(64),
            matrix_json: "{}",
            document_manifest_json: manifest([document("prefinalized", 1)]),
            baseline_ref: "prefinalized-bypass",
            repetitions: 1,
            evaluator_type: "system",
            evaluator_id: "released-snapshot-test",
            created_at: 2,
          })
          .run()
        expect(
          Exit.isFailure(
            yield* db
              .insert(ReleasedKnowledgeSnapshotTable)
              .values({
                snapshot_id: "snapshot-prefinalized",
                security_namespace_id: scope.securityNamespaceId,
                project_scope_key: scope.projectScopeKey,
                legacy_project_id: scope.legacyProjectId,
                parent_snapshot_id: "snapshot-immutable",
                evaluation_id: "evaluation-prefinalized",
                release_kind: "rollback",
                document_count: 1,
                published_generation: 2,
                verdict: "passed",
                actor_type: "system",
                actor_id: "released-snapshot-test",
                created_at: 2,
                finalized_at: 2,
              })
              .run()
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          yield* db
            .select({ snapshotId: ReleasedKnowledgeSnapshotTable.snapshot_id })
            .from(ReleasedKnowledgeSnapshotTable)
            .where(eq(ReleasedKnowledgeSnapshotTable.snapshot_id, "snapshot-prefinalized"))
            .get(),
        ).toBeUndefined()
        yield* db
          .insert(ReleasedKnowledgeEvaluationTable)
          .values({
            evaluation_id: "evaluation-noncanonical",
            security_namespace_id: scope.securityNamespaceId,
            project_scope_key: scope.projectScopeKey,
            matrix_hash: "d".repeat(64),
            matrix_json: "{}",
            document_manifest_json: manifest([document("a-document", 1), document("z-document", 1)]),
            baseline_ref: "noncanonical-order",
            repetitions: 1,
            evaluator_type: "system",
            evaluator_id: "released-snapshot-test",
            created_at: 3,
          })
          .run()
        yield* db
          .insert(ReleasedKnowledgeSnapshotTable)
          .values({
            snapshot_id: "snapshot-noncanonical",
            security_namespace_id: scope.securityNamespaceId,
            project_scope_key: scope.projectScopeKey,
            legacy_project_id: scope.legacyProjectId,
            parent_snapshot_id: "snapshot-immutable",
            evaluation_id: "evaluation-noncanonical",
            release_kind: "rollback",
            document_count: 2,
            published_generation: 2,
            verdict: "passed",
            actor_type: "system",
            actor_id: "released-snapshot-test",
            created_at: 3,
          })
          .run()
        yield* db
          .insert(ReleasedKnowledgeSnapshotDocumentTable)
          .values([
            {
              snapshot_id: "snapshot-noncanonical",
              ordinal: 0,
              source_store: "project",
              doc_id: "z-document",
              doc_version: 1,
              doc_hash: document("z-document", 1).hash,
              doc_type: "knowledge",
              doc_scope: `durable:project:${scope.legacyProjectId}`,
            },
            {
              snapshot_id: "snapshot-noncanonical",
              ordinal: 1,
              source_store: "project",
              doc_id: "a-document",
              doc_version: 1,
              doc_hash: document("a-document", 1).hash,
              doc_type: "knowledge",
              doc_scope: `durable:project:${scope.legacyProjectId}`,
            },
          ])
          .run()
        expect(
          Exit.isFailure(
            yield* db
              .update(ReleasedKnowledgeSnapshotTable)
              .set({ finalized_at: 3 })
              .where(eq(ReleasedKnowledgeSnapshotTable.snapshot_id, "snapshot-noncanonical"))
              .run()
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* DeepAgentReleasedSnapshot.current(db, scope))?.snapshotId).toBe("snapshot-immutable")

        yield* db
          .insert(ReleasedKnowledgeEvaluationTable)
          .values({
            evaluation_id: "evaluation-manifest-mismatch",
            security_namespace_id: scope.securityNamespaceId,
            project_scope_key: scope.projectScopeKey,
            matrix_hash: "e".repeat(64),
            matrix_json: "{}",
            document_manifest_json: manifest([document("evaluated-document", 1)]),
            baseline_ref: "manifest-mismatch",
            repetitions: 1,
            evaluator_type: "system",
            evaluator_id: "released-snapshot-test",
            created_at: 4,
          })
          .run()
        yield* db
          .insert(ReleasedKnowledgeSnapshotTable)
          .values({
            snapshot_id: "snapshot-manifest-mismatch",
            security_namespace_id: scope.securityNamespaceId,
            project_scope_key: scope.projectScopeKey,
            legacy_project_id: scope.legacyProjectId,
            parent_snapshot_id: "snapshot-immutable",
            evaluation_id: "evaluation-manifest-mismatch",
            release_kind: "rollback",
            document_count: 1,
            published_generation: 2,
            verdict: "passed",
            actor_type: "system",
            actor_id: "released-snapshot-test",
            created_at: 4,
          })
          .run()
        const unevaluated = document("unevaluated-document", 2)
        yield* db
          .insert(ReleasedKnowledgeSnapshotDocumentTable)
          .values({
            snapshot_id: "snapshot-manifest-mismatch",
            ordinal: 0,
            source_store: unevaluated.sourceStore,
            doc_id: unevaluated.id,
            doc_version: unevaluated.version,
            doc_hash: unevaluated.hash,
            doc_type: unevaluated.type,
            doc_scope: unevaluated.scope,
          })
          .run()
        expect(
          Exit.isFailure(
            yield* db
              .update(ReleasedKnowledgeSnapshotTable)
              .set({ finalized_at: 4 })
              .where(eq(ReleasedKnowledgeSnapshotTable.snapshot_id, "snapshot-manifest-mismatch"))
              .run()
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* DeepAgentReleasedSnapshot.current(db, scope))?.snapshotId).toBe("snapshot-immutable")
        expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])

        yield* db.run("DROP TRIGGER released_knowledge_snapshot_document_delete_forbidden")
        yield* db
          .delete(ReleasedKnowledgeSnapshotDocumentTable)
          .where(eq(ReleasedKnowledgeSnapshotDocumentTable.snapshot_id, "snapshot-immutable"))
          .run()
        const corrupted = yield* DeepAgentReleasedSnapshot.current(db, scope).pipe(Effect.flip)
        expect(corrupted).toMatchObject({
          _tag: "DeepAgentReleasedSnapshot.SnapshotIntegrityError",
          snapshotId: "snapshot-immutable",
        })
      }),
    )
  })

  test("serializes competing parent CAS publications and leaves no loser rows", async () => {
    await using tmp = await tmpdir()
    await run(
      tmp.path,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const scope = yield* makeScope(tmp.path)
        yield* publish(
          db,
          input({
            snapshotId: "snapshot-cas-baseline",
            evaluationId: "evaluation-cas-baseline",
            scope,
            releaseKind: "legacy_baseline",
            documents: [document("knowledge", 1)],
          }),
        )
        const results = yield* Effect.all(
          [
            publish(
              db,
              input({
                snapshotId: "snapshot-cas-a",
                evaluationId: "evaluation-cas-a",
                scope,
                expectedParentSnapshotId: "snapshot-cas-baseline",
                expectedGeneration: 1,
                documents: [document("knowledge-a", 2)],
              }),
            ).pipe(Effect.result),
            publish(
              db,
              input({
                snapshotId: "snapshot-cas-b",
                evaluationId: "evaluation-cas-b",
                scope,
                expectedParentSnapshotId: "snapshot-cas-baseline",
                expectedGeneration: 1,
                documents: [document("knowledge-b", 2)],
              }),
            ).pipe(Effect.result),
          ],
          { concurrency: "unbounded" },
        )
        expect(results.filter(Result.isSuccess)).toHaveLength(1)
        expect(results.filter(Result.isFailure)).toHaveLength(1)
        expect(Option.getOrUndefined(Result.getFailure(results.find(Result.isFailure)!))).toMatchObject({
          _tag: "DeepAgentReleasedSnapshot.SnapshotConflictError",
        })
        expect(
          yield* db
            .select({ snapshotId: ReleasedKnowledgeSnapshotTable.snapshot_id })
            .from(ReleasedKnowledgeSnapshotTable)
            .all(),
        ).toHaveLength(2)
        expect(
          yield* db
            .select({ generation: ReleasedKnowledgeSnapshotHeadTable.generation })
            .from(ReleasedKnowledgeSnapshotHeadTable)
            .get(),
        ).toEqual({ generation: 2 })
      }),
    )
  })
})

function run<A, E>(directory: string, effect: Effect.Effect<A, E, Database.Service | LocationIdentity.Service>) {
  const database = Database.layerFromPath(":memory:")
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.merge(database, LocationIdentity.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer))),
      ),
      Effect.scoped,
    ),
  )
}

const makeScope = Effect.fnUntraced(function* (directory: string) {
  const identity = yield* (yield* LocationIdentity.Service).resolve({
    boundary: { kind: "implicit_local" },
    directory: AbsolutePath.make(directory),
    project: { kind: "registered_root", observedProjectId: "legacy-project" },
  })
  return {
    securityNamespaceId: identity.securityNamespaceId,
    projectScopeKey: identity.projectScopeKey,
    legacyProjectId: "legacy-project",
  }
})

function input(
  value: Pick<PublishInput, "snapshotId" | "evaluationId" | "scope" | "documents"> & Partial<PublishInput>,
): PublishInput {
  return {
    expectedParentSnapshotId: null,
    expectedGeneration: 0,
    releaseKind: "evaluated",
    verdict: "passed",
    evaluationMatrix: { score: 1 },
    baselineRef: "released-snapshot-test",
    repetitions: 1,
    actor: { type: "system", id: "test" },
    ...value,
  }
}

function document(id: string, version: number): DocumentRef {
  return {
    sourceStore: "project",
    id,
    version,
    hash: `sha256:${Hash.sha256(`${id}:${version}`)}`,
    type: "knowledge",
    scope: "durable:project:legacy-project",
  }
}

function documentAuthority(directory: string, documents: readonly DocumentRef[] = []) {
  const refs = new Map<string, DocumentRef>()
  const store = (sourceStore: DocumentRef["sourceStore"]) =>
    ({
      get: (id: string, version?: number) => {
        const ref = refs.get(`${sourceStore}:${id}@${version ?? "latest"}`)
        return ref ? storedDocument(ref) : null
      },
    }) as unknown as DocumentStore
  const authority = {
    userGlobal: store("user_global"),
    project: store("project"),
    register: (next: readonly DocumentRef[]) =>
      next.forEach((ref) => {
        refs.set(`${ref.sourceStore}:${ref.id}@${ref.version}`, ref)
        refs.set(`${ref.sourceStore}:${ref.id}@latest`, ref)
      }),
  }
  authority.register(documents)
  return authority
}

function registerDocuments(
  authority: DeepAgentReleasedSnapshot.DocumentAuthority & {
    readonly register?: (documents: readonly DocumentRef[]) => void
  },
  documents: readonly DocumentRef[],
) {
  authority.register?.(documents)
}

function storedDocument(ref: DocumentRef): Doc {
  return {
    id: ref.id,
    type: ref.type,
    scope: ref.scope,
    status: "active",
    version: ref.version,
    superseded_by: null,
    hash: ref.hash,
    created_round: null,
    domain: null,
    tags: [],
    description: ref.id,
    provenance: { source: "human" },
    links: [],
    confidence: { evidence_strength: "strong", support_count: 1 },
    body: `${ref.id}@${ref.version}`,
  }
}

function documentInput(idSlug: string, scope: string) {
  return {
    type: "knowledge" as const,
    scope,
    description: idSlug,
    body: idSlug,
    idSlug,
    provenance: { source: "human" as const },
    confidence: { evidence_strength: "strong" as const, support_count: 1 },
  }
}

function manifest(documents: readonly DocumentRef[]) {
  return CanonicalJson.stringify(DeepAgentReleasedSnapshot.normalizeDocumentRefs(documents))
}
