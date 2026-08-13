import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { Effect, Exit } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import releasedKnowledgeTurnBindingMigration from "../src/database/migration/20260811193000_released_knowledge_turn_binding"
import { DeepAgentReleasedSnapshot, type Binding } from "../src/deepagent/released-snapshot"

const emptyExactRefsFingerprint = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
const activationFingerprint = "a".repeat(64)
const preparedTurnHash = "b".repeat(64)
const systemStableHash = "c".repeat(64)
const systemVolatileHash = "d".repeat(64)
const wireRequestHash = "e".repeat(64)
const namespace = "binding-namespace"
const primaryScope = "binding-primary-scope"
const otherScope = "binding-other-scope"
const sessionId = "binding-session"
const selectionId = "binding-selection"
const ownerToken = "binding-provider-owner"
const contextEligibility = {
  requested: false,
  project: false,
  enabled: {
    contextProjectionV2: false,
    contextQueryToolsV2: false,
    coreV2ExecutionOwner: false,
  },
}
const contextReadiness = {
  observedAt: 0,
  expiresAt: 10_000,
}

describe("released knowledge turn binding migration", () => {
  test("rejects direct advanced-state inserts and permits a canonical unavailable receipt to dispatch", async () => {
    await runCurrent(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* seedAuthority(db)

        const directInsertResults = yield* Effect.all(
          (["dispatching", "streaming"] as const).map((providerState, index) =>
            insertReceipt(db, {
              id: `direct-${providerState}`,
              ordinal: index + 1,
              providerState,
              securityNamespaceId: namespace,
              projectScopeKey: primaryScope,
            }).pipe(Effect.exit),
          ),
        )
        expect(directInsertResults.every(Exit.isFailure)).toBe(true)

        yield* insertReceipt(db, {
          id: "canonical-unavailable",
          ordinal: 3,
          providerState: "preparing",
          securityNamespaceId: namespace,
          projectScopeKey: primaryScope,
          binding: DeepAgentReleasedSnapshot.binding(undefined),
          activation: true,
        })
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET released_knowledge_selected_refs = '[]',
              released_knowledge_selected_refs_fingerprint = ${emptyExactRefsFingerprint}
          WHERE receipt_id = 'canonical-unavailable'
        `)
        const unsealed = yield* db
          .run(
            sql`
            UPDATE session_tool_request_receipt
            SET provider_state = 'prepared'
            WHERE receipt_id = 'canonical-unavailable'
          `,
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(unsealed)).toBe(true)
        const duplicateToolResults = yield* sealPreparedTurn(db, "canonical-unavailable", ["call-1", "call-1"]).pipe(
          Effect.exit,
        )
        expect(Exit.isFailure(duplicateToolResults)).toBe(true)
        yield* sealPreparedTurn(db, "canonical-unavailable", [])
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'dispatching', request_state = 'dispatched', dispatching_at = 3
          WHERE receipt_id = 'canonical-unavailable'
        `)

        expect(
          yield* db.get(sql`
            SELECT provider_state, released_knowledge_binding_state
            FROM session_tool_request_receipt
            WHERE receipt_id = 'canonical-unavailable'
          `),
        ).toEqual({ provider_state: "dispatching", released_knowledge_binding_state: "unavailable" })
      }),
    )
  })

  test("seals one canonical selected-ref subset and rejects non-members, non-canonical order, and rewrites", async () => {
    await runCurrent(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const binding = yield* seedAuthority(db)
        const selected = binding.exactRefs.slice(0, 1)
        yield* insertReceipt(db, {
          id: "bound-selected-subset",
          ordinal: 1,
          providerState: "preparing",
          securityNamespaceId: namespace,
          projectScopeKey: primaryScope,
          binding,
          activation: true,
        })

        const nonMember = yield* db
          .run(
            sql`
            UPDATE session_tool_request_receipt
            SET released_knowledge_selected_refs = ${JSON.stringify([
              { ...binding.exactRefs[0], id: "not-in-snapshot" },
            ])},
                released_knowledge_selected_refs_fingerprint = ${"b".repeat(64)}
            WHERE receipt_id = 'bound-selected-subset'
          `,
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(nonMember)).toBe(true)

        const nonCanonical = yield* db
          .run(
            sql`
            UPDATE session_tool_request_receipt
            SET released_knowledge_selected_refs = ${JSON.stringify([...binding.exactRefs].reverse())},
                released_knowledge_selected_refs_fingerprint = ${binding.exactRefsFingerprint}
            WHERE receipt_id = 'bound-selected-subset'
          `,
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(nonCanonical)).toBe(true)

        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET released_knowledge_selected_refs = ${JSON.stringify(selected)},
              released_knowledge_selected_refs_fingerprint = ${DeepAgentReleasedSnapshot.exactRefsFingerprint(selected)}
          WHERE receipt_id = 'bound-selected-subset'
        `)
        const rewrite = yield* db
          .run(
            sql`
            UPDATE session_tool_request_receipt
            SET released_knowledge_selected_refs = '[]',
                released_knowledge_selected_refs_fingerprint = ${emptyExactRefsFingerprint}
            WHERE receipt_id = 'bound-selected-subset'
          `,
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(rewrite)).toBe(true)

        yield* sealPreparedTurn(db, "bound-selected-subset", ["call-1"])
        const rewritePreparedTurn = yield* db
          .run(
            sql`
            UPDATE session_tool_request_receipt
            SET system_stable_hash = ${"f".repeat(64)}
            WHERE receipt_id = 'bound-selected-subset'
          `,
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(rewritePreparedTurn)).toBe(true)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'dispatching'
          WHERE receipt_id = 'bound-selected-subset'
        `)
        expect(
          yield* db.get(sql`
            SELECT provider_state, released_knowledge_selected_refs
            FROM session_tool_request_receipt
            WHERE receipt_id = 'bound-selected-subset'
          `),
        ).toEqual({ provider_state: "dispatching", released_knowledge_selected_refs: JSON.stringify(selected) })
      }),
    )
  })

  test("rejects malformed bound receipts, wrong scope, and selection binding mismatch", async () => {
    await runCurrent(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const binding = yield* seedAuthority(db)

        const invalidReceipts = [
          insertReceipt(db, {
            id: "wrong-fingerprint",
            ordinal: 1,
            providerState: "preparing",
            securityNamespaceId: namespace,
            projectScopeKey: primaryScope,
            binding,
            exactRefsFingerprint: "b".repeat(64),
          }),
          insertReceipt(db, {
            id: "extra-json-key",
            ordinal: 2,
            providerState: "preparing",
            securityNamespaceId: namespace,
            projectScopeKey: primaryScope,
            binding,
            exactRefsJson: JSON.stringify(binding.exactRefs.map((ref) => ({ ...ref, extra: true }))),
          }),
          insertReceipt(db, {
            id: "wrong-scope",
            ordinal: 3,
            providerState: "preparing",
            securityNamespaceId: namespace,
            projectScopeKey: otherScope,
            binding,
          }),
        ]
        expect(
          (yield* Effect.all(invalidReceipts.map((receipt) => receipt.pipe(Effect.exit)))).every(Exit.isFailure),
        ).toBe(true)

        yield* seedSelection(db, DeepAgentReleasedSnapshot.binding(undefined))
        const mismatchedSelection = yield* insertReceipt(db, {
          id: "selection-binding-mismatch",
          ordinal: 4,
          providerState: "preparing",
          securityNamespaceId: namespace,
          projectScopeKey: primaryScope,
          contextSelectionId: selectionId,
          binding,
        }).pipe(Effect.exit)
        expect(Exit.isFailure(mismatchedSelection)).toBe(true)
      }),
    )
  })

  test("rejects provider attempts from another selection or session", async () => {
    await runCurrent(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const binding = yield* seedAuthority(db)
        yield* seedSelection(db, binding)
        yield* db.run(sql`
          INSERT INTO session_context_selection (
            selection_id, session_id, activity_id, revision, trigger_input_id, location_key,
            security_namespace_id, project_scope_key,
            query_fingerprint, authorization_fingerprint, authorization_epoch,
            execution_fingerprint, selected_source_fingerprint,
            observed_location_mutation_epoch, next_revalidation_at,
            released_knowledge_binding_state, released_knowledge_snapshot_id,
            released_knowledge_generation, released_knowledge_membership_hash,
            released_knowledge_manifest_hash, released_knowledge_exact_refs,
            released_knowledge_exact_refs_fingerprint,
            graph_revisions, graph_statuses, selected_refs, projection,
            projection_hash, token_count, artifact_write_status, artifact_ref, created_at
          )
          SELECT
            'binding-selection-other', session_id, activity_id, revision + 1, trigger_input_id, location_key,
            security_namespace_id, project_scope_key,
            query_fingerprint, authorization_fingerprint, authorization_epoch,
            execution_fingerprint, selected_source_fingerprint,
            observed_location_mutation_epoch, next_revalidation_at,
            released_knowledge_binding_state, released_knowledge_snapshot_id,
            released_knowledge_generation, released_knowledge_membership_hash,
            released_knowledge_manifest_hash, released_knowledge_exact_refs,
            released_knowledge_exact_refs_fingerprint,
            graph_revisions, graph_statuses, selected_refs, projection,
            projection_hash, token_count, artifact_write_status, artifact_ref, created_at
          FROM session_context_selection
          WHERE selection_id = ${selectionId}
        `)
        yield* db.run(sql`
          INSERT INTO session_provider_attempt (
            attempt_id, session_id, activity_id, provider_turn_seq, selection_id,
            projection_hash, request_hash, provider_id, owner_token, state, created_at
          ) VALUES (
            'attempt-other-selection', ${sessionId}, 'binding-activity', 0, 'binding-selection-other',
            'projection-hash', 'request-hash', 'provider', ${ownerToken}, 'prepared', 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES ('binding-session-other', 'binding-project', 'binding-session-other', '/tmp/binding-primary', 'Other', 'test', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session_provider_attempt (
            attempt_id, session_id, activity_id, provider_turn_seq, selection_id,
            projection_hash, request_hash, provider_id, owner_token, state, created_at
          ) VALUES (
            'attempt-other-session', 'binding-session-other', 'binding-activity', 0, ${selectionId},
            'projection-hash', 'request-hash', 'provider', ${ownerToken}, 'prepared', 1
          )
        `)

        const results = yield* Effect.all([
          insertReceipt(db, {
            id: "receipt-attempt-other-selection",
            ordinal: 1,
            providerState: "preparing",
            securityNamespaceId: namespace,
            projectScopeKey: primaryScope,
            contextSelectionId: selectionId,
            providerAttemptId: "attempt-other-selection",
            requestInputHash: "request-hash",
            binding,
          }).pipe(Effect.exit),
          insertReceipt(db, {
            id: "receipt-attempt-other-session",
            ordinal: 2,
            providerState: "preparing",
            securityNamespaceId: namespace,
            projectScopeKey: primaryScope,
            contextSelectionId: selectionId,
            providerAttemptId: "attempt-other-session",
            requestInputHash: "request-hash",
            binding,
          }).pipe(Effect.exit),
        ])
        expect(results.every(Exit.isFailure)).toBe(true)
      }),
    )
  })

  test("backfills historical selections and receipts as legacy_unbound and prevents dispatch", async () => {
    await runRaw(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* createHistoricalSchema(db)
        yield* db.run(sql`
          INSERT INTO session_activity (activity_id, state, created_at)
          VALUES ('historical-activity', 'active', 1)
        `)
        yield* db.run(sql`
          INSERT INTO session_context_selection (selection_id, session_id, activity_id, location_key)
          VALUES ('historical-selection', 'historical-session', 'historical-activity', 'historical-location')
        `)
        yield* db.run(sql`
          INSERT INTO session_tool_request_receipt (
            receipt_id, session_id, context_selection_id, provider_state,
            final_request_hash, adapter_prepared_at, prompt_epoch, prompt_window_id,
            effective_history_hash, context_eligibility, context_readiness,
            context_activation, context_activation_fingerprint
          ) VALUES (
            'historical-receipt', 'historical-session', 'historical-selection', 'prepared',
            'historical-final-hash', 1, 1, 'historical-window',
            'historical-history-hash', '{}', '{}', '{}', ${activationFingerprint}
          )
        `)

        yield* DatabaseMigration.applyOnly(db, [releasedKnowledgeTurnBindingMigration])

        expect(
          yield* db.get(sql`
            SELECT released_knowledge_binding_state
            FROM session_context_selection
            WHERE selection_id = 'historical-selection'
          `),
        ).toEqual({ released_knowledge_binding_state: "legacy_unbound" })
        expect(
          yield* db.get(sql`
            SELECT state, settled_at
            FROM session_activity
            WHERE activity_id = 'historical-activity'
          `),
        ).toEqual({ state: "interrupted", settled_at: 1 })
        expect(
          yield* db.get(sql`
            SELECT released_knowledge_binding_state
            FROM session_tool_request_receipt
            WHERE receipt_id = 'historical-receipt'
          `),
        ).toEqual({ released_knowledge_binding_state: "legacy_unbound" })

        const dispatch = yield* db
          .run(
            sql`
            UPDATE session_tool_request_receipt
            SET provider_state = 'dispatching'
            WHERE receipt_id = 'historical-receipt'
          `,
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(dispatch)).toBe(true)
      }),
    )
  })

  test("exposes the required columns, partial indexes, triggers, and valid foreign keys", async () => {
    await runCurrent(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const expectedBindingColumns = [
          "released_knowledge_binding_state",
          "released_knowledge_snapshot_id",
          "released_knowledge_generation",
          "released_knowledge_membership_hash",
          "released_knowledge_manifest_hash",
          "released_knowledge_exact_refs",
          "released_knowledge_exact_refs_fingerprint",
          "released_knowledge_selected_refs",
          "released_knowledge_selected_refs_fingerprint",
        ]
        const receiptColumns = (yield* db.all<{ name: string }>(sql`
          SELECT name FROM pragma_table_info('session_tool_request_receipt')
        `)).map((column) => column.name)
        const selectionColumns = (yield* db.all<{ name: string }>(sql`
          SELECT name FROM pragma_table_info('session_context_selection')
        `)).map((column) => column.name)
        expect(receiptColumns).toEqual(
          expect.arrayContaining([
            ...expectedBindingColumns,
            "released_knowledge_security_namespace_id",
            "released_knowledge_project_scope_key",
            "prepared_turn_hash",
            "system_stable_hash",
            "system_volatile_hash",
            "wire_request_hash",
            "tool_result_reference_ids",
            "tool_result_reference_count",
          ]),
        )
        expect(selectionColumns).toEqual(
          expect.arrayContaining([
            ...expectedBindingColumns.filter((column) => !column.includes("selected_refs")),
            "security_namespace_id",
            "project_scope_key",
          ]),
        )

        expect(
          yield* db.all<{ name: string; partial: number }>(sql`
            SELECT name, partial
            FROM pragma_index_list('session_tool_request_receipt')
            WHERE name = 'session_tool_request_receipt_released_snapshot_idx'
          `),
        ).toEqual([{ name: "session_tool_request_receipt_released_snapshot_idx", partial: 1 }])
        expect(
          yield* db.all<{ name: string; partial: number }>(sql`
            SELECT name, partial
            FROM pragma_index_list('session_context_selection')
            WHERE name = 'session_context_selection_released_snapshot_idx'
          `),
        ).toEqual([{ name: "session_context_selection_released_snapshot_idx", partial: 1 }])

        expect(
          (yield* db.all<{ name: string }>(sql`
            SELECT name
            FROM sqlite_master
            WHERE type = 'trigger'
              AND name IN (
                'session_tool_request_receipt_released_knowledge_immutable',
                'session_tool_request_receipt_released_knowledge_selected_refs_seal',
                'session_tool_request_receipt_authority_insert_guard',
                'session_tool_request_receipt_released_knowledge_dispatch_guard',
                'session_tool_request_receipt_prepared_turn_insert_guard',
                'session_tool_request_receipt_prepared_turn_seal',
                'session_context_selection_immutable',
                'session_context_selection_released_knowledge_insert_guard'
              )
            ORDER BY name
          `)).map((trigger) => trigger.name),
        ).toEqual([
          "session_context_selection_immutable",
          "session_context_selection_released_knowledge_insert_guard",
          "session_tool_request_receipt_authority_insert_guard",
          "session_tool_request_receipt_prepared_turn_insert_guard",
          "session_tool_request_receipt_prepared_turn_seal",
          "session_tool_request_receipt_released_knowledge_dispatch_guard",
          "session_tool_request_receipt_released_knowledge_immutable",
          "session_tool_request_receipt_released_knowledge_selected_refs_seal",
        ])

        expect(
          yield* db.all<{ table: string; from: string; to: string }>(sql`
            SELECT "table", "from", "to"
            FROM pragma_foreign_key_list('session_tool_request_receipt')
            WHERE "from" = 'released_knowledge_snapshot_id'
          `),
        ).toEqual([
          {
            table: "released_knowledge_snapshot",
            from: "released_knowledge_snapshot_id",
            to: "snapshot_id",
          },
        ])
        expect(
          yield* db.all<{ table: string; from: string; to: string }>(sql`
            SELECT "table", "from", "to"
            FROM pragma_foreign_key_list('session_context_selection')
            WHERE "from" = 'released_knowledge_snapshot_id'
          `),
        ).toEqual([
          {
            table: "released_knowledge_snapshot",
            from: "released_knowledge_snapshot_id",
            to: "snapshot_id",
          },
        ])
        expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
      }),
    )
  })
})

function runCurrent<A, E>(effect: Effect.Effect<A, E, Database.Service>) {
  return Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped))
}

function runRaw<A, E>(effect: Effect.Effect<A, E, SqlClientService>) {
  return Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )
}

type DatabaseClient = Database.Interface["db"]

function seedAuthority(db: DatabaseClient) {
  return Effect.gen(function* () {
    yield* db.run(sql`
      INSERT INTO session_provider_owner_lease (
        owner_token, registered_at, heartbeat_at, lease_expires_at
      ) VALUES (
        ${ownerToken},
        CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
        CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
        CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 30000
      )
    `)
    yield* db.run(sql`
      INSERT INTO context_security_namespace (id, kind, binding_hash, created_at)
      VALUES (${namespace}, 'implicit_local', 'binding-authority', 1)
    `)
    yield* db.run(sql`
      INSERT INTO context_project_scope_identity (
        security_namespace_id, project_scope_key, project_kind,
        project_identity_hash, observed_project_id, created_at
      ) VALUES
        (${namespace}, ${primaryScope}, 'registered_root', 'primary-identity', 'project-primary', 1),
        (${namespace}, ${otherScope}, 'registered_root', 'other-identity', 'project-other', 1)
    `)
    yield* db.run(sql`
      INSERT INTO context_location_identity (
        security_namespace_id, location_key, project_scope_key,
        canonical_root, observed_project_id, created_at
      ) VALUES (
        ${namespace}, 'binding-location', ${primaryScope},
        '/tmp/binding-primary', 'project-primary', 1
      )
    `)
    const binding = DeepAgentReleasedSnapshot.binding(
      yield* DeepAgentReleasedSnapshot.publish(
        db,
        {
          snapshotId: "binding-snapshot",
          evaluationId: "binding-evaluation",
          scope: {
            securityNamespaceId: namespace,
            projectScopeKey: primaryScope,
            legacyProjectId: "project-primary",
          },
          expectedParentSnapshotId: null,
          expectedGeneration: 0,
          releaseKind: "legacy_baseline",
          verdict: "passed",
          documents: [
            {
              sourceStore: "project",
              id: "binding-document",
              version: 1,
              hash: `sha256:${"c".repeat(64)}`,
              type: "knowledge",
              scope: "durable:project:project-primary",
            },
            {
              sourceStore: "project",
              id: "binding-skill",
              version: 1,
              hash: `sha256:${"d".repeat(64)}`,
              type: "skill",
              scope: "durable:project:project-primary",
            },
          ],
          evaluationMatrix: { score: 1 },
          baselineRef: "binding-migration-test",
          repetitions: 1,
          actor: { type: "system", id: "test" },
          now: 1,
        },
        {
          userGlobal: { get: () => null },
          project: {
            get: (id, version) => {
              const ref = [
                {
                  sourceStore: "project" as const,
                  id: "binding-document",
                  version: 1,
                  hash: `sha256:${"c".repeat(64)}`,
                  type: "knowledge" as const,
                  scope: "durable:project:project-primary",
                },
                {
                  sourceStore: "project" as const,
                  id: "binding-skill",
                  version: 1,
                  hash: `sha256:${"d".repeat(64)}`,
                  type: "skill" as const,
                  scope: "durable:project:project-primary",
                },
              ].find((document) => document.id === id && document.version === version)
              return ref
                ? {
                    ...ref,
                    status: "active" as const,
                    superseded_by: null,
                    created_round: null,
                    domain: null,
                    tags: [],
                    description: ref.id,
                    provenance: { source: "human" as const },
                    links: [],
                    body: ref.id,
                  }
                : null
            },
          },
        },
      ),
    )
    if (binding.state !== "bound") return yield* Effect.die("expected a released snapshot binding")
    return binding
  })
}

function seedSelection(db: DatabaseClient, binding: Binding) {
  return Effect.gen(function* () {
    yield* db.run(sql`
      INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
      VALUES ('binding-project', '/tmp/binding-primary', '[]', 1, 1)
    `)
    yield* db.run(sql`
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (${sessionId}, 'binding-project', 'binding-session', '/tmp/binding-primary', 'Binding session', 'test', 1, 1)
    `)
    yield* db.run(sql`
      INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
      VALUES ('binding-input', ${sessionId}, '{"text":"binding"}', 'steer', 0, 0, 1)
    `)
    yield* db.run(sql`
      INSERT INTO session_activity (
        activity_id, session_id, ordinal, trigger_input_id, delivery, state, created_at
      ) VALUES ('binding-activity', ${sessionId}, 0, 'binding-input', 'steer', 'active', 1)
    `)
    yield* db.run(sql`
      INSERT INTO session_context_selection (
        selection_id, session_id, activity_id, revision, trigger_input_id, location_key,
        security_namespace_id, project_scope_key,
        query_fingerprint, authorization_fingerprint, authorization_epoch,
        execution_fingerprint, selected_source_fingerprint,
        observed_location_mutation_epoch, next_revalidation_at,
        released_knowledge_binding_state, released_knowledge_snapshot_id,
        released_knowledge_generation, released_knowledge_membership_hash,
        released_knowledge_manifest_hash, released_knowledge_exact_refs,
        released_knowledge_exact_refs_fingerprint,
        graph_revisions, graph_statuses, selected_refs, projection,
        projection_hash, token_count, artifact_write_status, artifact_ref, created_at
      ) VALUES (
        ${selectionId}, ${sessionId}, 'binding-activity', 0, 'binding-input', 'binding-location',
        ${namespace}, ${primaryScope},
        'query', 'authorization', 1, 'execution', 'source', 0, 100,
        ${binding.state}, ${binding.state === "bound" ? binding.snapshotId : null},
        ${binding.state === "bound" ? binding.generation : null},
        ${binding.state === "bound" ? binding.membershipHash : null},
        ${binding.state === "bound" ? binding.manifestHash : null},
        ${JSON.stringify(binding.exactRefs)}, ${binding.exactRefsFingerprint},
        '{}', '{}', '[]', 'projection', 'projection-hash', 1, 'available', 'artifact-ref', 1
      )
    `)
  })
}

function insertReceipt(
  db: DatabaseClient,
  input: {
    readonly id: string
    readonly ordinal: number
    readonly providerState: "preparing" | "dispatching" | "streaming"
    readonly securityNamespaceId: string
    readonly projectScopeKey: string
    readonly contextSelectionId?: string
    readonly providerAttemptId?: string
    readonly binding?: Binding
    readonly exactRefsJson?: string
    readonly exactRefsFingerprint?: string
    readonly activation?: boolean
    readonly requestInputHash?: string
  },
) {
  return db.run(sql`
    INSERT INTO session_tool_request_receipt (
      receipt_id, request_ordinal, session_id, user_message_id, provider_id, model_id,
      registry_tool_ids, permission_filtered_tool_ids, final_offered_tool_ids, call_ids,
      provider_state, request_state, created_at, context_selection_id, provider_attempt_id,
      owner_token, request_input_hash,
      final_request_hash, adapter_prepared_at, prompt_epoch, prompt_window_id,
      effective_history_hash, context_eligibility, context_readiness,
      context_activation, context_activation_fingerprint,
      released_knowledge_security_namespace_id, released_knowledge_project_scope_key,
      released_knowledge_binding_state, released_knowledge_snapshot_id,
      released_knowledge_generation, released_knowledge_membership_hash,
      released_knowledge_manifest_hash, released_knowledge_exact_refs,
      released_knowledge_exact_refs_fingerprint
    ) VALUES (
      ${input.id}, ${input.ordinal}, ${sessionId}, 'binding-user-message', 'provider', 'model',
      '[]', '[]', '[]', '[]',
      ${input.providerState}, 'prepared', 1, ${input.contextSelectionId ?? null}, ${input.providerAttemptId ?? null},
      ${ownerToken}, ${input.requestInputHash ?? null},
      NULL, NULL,
      ${input.activation ? 1 : null}, ${input.activation ? "prompt-window" : null},
      ${input.activation ? "history-hash" : null}, ${input.activation ? JSON.stringify(contextEligibility) : null},
      ${input.activation ? JSON.stringify(contextReadiness) : null},
      ${input.activation ? contextActivation(input.contextSelectionId) : null},
      ${input.activation ? activationFingerprint : null},
      ${input.securityNamespaceId}, ${input.projectScopeKey},
      ${input.binding?.state ?? null},
      ${input.binding?.state === "bound" ? input.binding.snapshotId : null},
      ${input.binding?.state === "bound" ? input.binding.generation : null},
      ${input.binding?.state === "bound" ? input.binding.membershipHash : null},
      ${input.binding?.state === "bound" ? input.binding.manifestHash : null},
      ${input.exactRefsJson ?? (input.binding ? JSON.stringify(input.binding.exactRefs) : null)},
      ${input.exactRefsFingerprint ?? input.binding?.exactRefsFingerprint ?? null}
    )
  `)
}

function contextActivation(contextSelectionId?: string) {
  return JSON.stringify({
    schemaVersion: 1,
    recordedAt: 1,
    readinessAgeMs: 1,
    readinessExpiresInMs: contextReadiness.expiresAt - 1,
    outcome: "not_requested",
    enabledCapabilities: [],
    fallbackReasons: [],
    decision: contextEligibility,
    ...(contextSelectionId
      ? { selection: { selectionId: contextSelectionId, projectionHash: "projection-hash" } }
      : {}),
  })
}

function sealPreparedTurn(db: DatabaseClient, receiptID: string, toolResultReferenceIDs: readonly string[]) {
  return db.run(sql`
    UPDATE session_tool_request_receipt
    SET provider_state = 'prepared',
        final_request_hash = ${wireRequestHash},
        provider_request_hash = ${wireRequestHash},
        adapter_prepared_at = 2,
        tool_definition_hash = ${preparedTurnHash},
        prepared_turn_hash = ${preparedTurnHash},
        system_stable_hash = ${systemStableHash},
        system_volatile_hash = ${systemVolatileHash},
        wire_request_hash = ${wireRequestHash},
        tool_result_reference_ids = ${JSON.stringify(toolResultReferenceIDs)},
        tool_result_reference_count = ${toolResultReferenceIDs.length}
    WHERE receipt_id = ${receiptID}
  `)
}

function createHistoricalSchema(db: DatabaseClient) {
  return Effect.gen(function* () {
    yield* db.run(sql`
      CREATE TABLE released_knowledge_snapshot (
        snapshot_id TEXT PRIMARY KEY,
        security_namespace_id TEXT,
        project_scope_key TEXT,
        published_generation INTEGER,
        membership_hash TEXT,
        manifest_hash TEXT,
        verdict TEXT,
        finalized_at INTEGER,
        document_count INTEGER
      )
    `)
    yield* db.run(sql`
      CREATE TABLE released_knowledge_snapshot_document (
        snapshot_id TEXT,
        ordinal INTEGER,
        source_store TEXT,
        doc_id TEXT,
        doc_version INTEGER,
        doc_hash TEXT,
        doc_type TEXT,
        doc_scope TEXT
      )
    `)
    yield* db.run(sql`
      CREATE TABLE context_project_scope_identity (
        security_namespace_id TEXT,
        project_scope_key TEXT,
        retired_at INTEGER
      )
    `)
    yield* db.run(sql`
      CREATE TABLE context_location_identity (
        security_namespace_id TEXT,
        project_scope_key TEXT,
        location_key TEXT,
        retired_at INTEGER
      )
    `)
    yield* db.run(sql`
      CREATE TABLE session_activity (
        activity_id TEXT PRIMARY KEY,
        session_id TEXT,
        ordinal INTEGER,
        trigger_input_id TEXT,
        delivery TEXT,
        state TEXT,
        created_at INTEGER,
        settled_at INTEGER
      )
    `)
    yield* db.run(sql`
      CREATE TABLE session_context_selection (
        selection_id TEXT PRIMARY KEY,
        session_id TEXT,
        activity_id TEXT,
        location_key TEXT
      )
    `)
    yield* db.run(sql`
      CREATE TRIGGER session_context_selection_immutable
      BEFORE UPDATE ON session_context_selection
      BEGIN
        SELECT RAISE(ABORT, 'session_context_selection is immutable');
      END
    `)
    yield* db.run(sql`
      CREATE TABLE session_provider_attempt (
        attempt_id TEXT PRIMARY KEY,
        session_id TEXT,
        selection_id TEXT
      )
    `)
    yield* db.run(sql`
      CREATE TABLE session_tool_request_receipt (
        receipt_id TEXT PRIMARY KEY,
        session_id TEXT,
        context_selection_id TEXT,
        provider_attempt_id TEXT,
        provider_state TEXT,
        final_request_hash TEXT,
        adapter_prepared_at INTEGER,
        prompt_epoch INTEGER,
        prompt_window_id TEXT,
        effective_history_hash TEXT,
        context_eligibility TEXT,
        context_readiness TEXT,
        context_activation TEXT,
        context_activation_fingerprint TEXT
      )
    `)
  })
}
