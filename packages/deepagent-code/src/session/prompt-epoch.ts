// BUG-405-005: PromptEpoch — the unique model history boundary authority.
//
// Design contract (docs/4.0.4_r6.md §11, docs/bug-405-005.md §4.4):
//   - One "active" epoch per session at most (enforced by partial unique index).
//   - Epoch 0 is the bootstrap epoch: no checkpoint refs, full transcript selection.
//   - A new epoch is ONLY activated by CompactionCommitted — never by epoch-first writes.
//   - "retired" epochs are kept permanently for audit/replay; nothing is deleted.
//
// This module owns the session_prompt_epoch table.  It does NOT own compaction_run or
// compaction_summary_attempt (those are owned by compaction-sql.ts / compaction.ts).

import { Database } from "@deepagent-code/core/database/database"
import { Effect, Layer, Context } from "effect"
import { SessionID, MessageID } from "./schema"
import { and, desc, eq, ne } from "drizzle-orm"
import { SessionPromptEpochTable, type PromptEpochReason } from "./prompt-epoch.sql"
import { HistoryAuthority } from "./history-authority"
import { MessageTable, SessionPromptEpochMessageTable } from "@deepagent-code/core/session/sql"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"
import { SessionContextSelectionTable } from "@deepagent-code/core/context-federation/session-sql"
import { ContextReference } from "@deepagent-code/core/context-federation/reference"
import { SessionRunnerCanonical } from "@deepagent-code/core/session/runner/canonical-turn"

// ── Types ────────────────────────────────────────────────────────────────────

export interface PromptEpochRow {
  session_id: string
  epoch: number
  state: "active" | "retired"
  checkpoint_user_id: string | null
  checkpoint_assistant_id: string | null
  retained_tail_start_id: string | null
  source_end_message_id: string | null
  checkpoint_hash: string | null
  projection_version: number | null
  canonicalization_version: number | null
  base_message_count: number | null
  effective_history_hash: string | null
  first_window_id: string | null
  previous_window_id: string | null
  window_id: string | null
  world_state_baseline_hash: string | null
  authority_state: "legacy_pending" | "ready" | "recovery_required" | null
  recovery_reason: string | null
  recovery_resolution_id: string | null
  reason: PromptEpochReason
  created_at: number
  retired_at: number | null
}

export interface PromptEpochInterface {
  /**
   * Return the currently active epoch for the session.
   * Returns undefined if no epoch has been created yet (before first bootstrap).
   */
  readonly getActive: (sessionID: SessionID) => Effect.Effect<PromptEpochRow | undefined>

  /**
   * Ensure an Epoch 0 (bootstrap) row exists for the session.
   * Idempotent: if an active epoch already exists, returns it unchanged.
   * Epoch 0 has no checkpoint refs and selects the full transcript.
   */
  readonly bootstrap: (sessionID: SessionID) => Effect.Effect<PromptEpochRow>

  /**
   * Atomically retire the current active epoch and activate a new compaction epoch.
   * Must be called inside the CompactionCommitted transaction (same SQLite tx).
   *
   * Fails (returns undefined) if:
   *   - no active epoch exists, OR
   *   - the active epoch number does not match `fromEpoch` (CAS guard).
   */
  readonly activate: (input: {
    sessionID: SessionID
    fromEpoch: number
    checkpointUserID: MessageID
    checkpointAssistantID: MessageID
    checkpointHash: string
    baseMessageCount: number
    effectiveHistoryHash: string
    retainedTailStartID?: MessageID
    sourceEndMessageID?: MessageID
    worldStateBaselineHash?: string
    replacementMessageIDs: readonly MessageID[]
  }) => Effect.Effect<PromptEpochRow | undefined>
}

// ── Service tag ──────────────────────────────────────────────────────────────

export class Service extends Context.Service<Service, PromptEpochInterface>()("@deepagent-code/PromptEpoch") {}

export type Transaction = Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]

function getActiveInTransaction(tx: Pick<Transaction, "select">, sessionID: SessionID) {
  return tx
    .select()
    .from(SessionPromptEpochTable)
    .where(and(eq(SessionPromptEpochTable.session_id, sessionID), eq(SessionPromptEpochTable.state, "active")))
    .get()
    .pipe(Effect.map((row) => row as PromptEpochRow | undefined))
}

export function activateInTransaction(tx: Transaction, input: Parameters<PromptEpochInterface["activate"]>[0]) {
  return Effect.gen(function* () {
    if (
      input.replacementMessageIDs.length !== input.baseMessageCount ||
      new Set(input.replacementMessageIDs).size !== input.replacementMessageIDs.length
    ) {
      return yield* Effect.die(new Error(`invalid replacement membership for ${input.sessionID}`))
    }
    const current = yield* getActiveInTransaction(tx, input.sessionID)
    if (!current || current.epoch !== input.fromEpoch) return undefined

    const now = Date.now()
    const retired = yield* tx
      .update(SessionPromptEpochTable)
      .set({ state: "retired", retired_at: now })
      .where(
        and(
          eq(SessionPromptEpochTable.session_id, input.sessionID),
          eq(SessionPromptEpochTable.epoch, input.fromEpoch),
          eq(SessionPromptEpochTable.state, "active"),
        ),
      )
      .returning({ epoch: SessionPromptEpochTable.epoch })
      .get()
    if (!retired) return undefined

    const next: PromptEpochRow = {
      session_id: input.sessionID,
      epoch: current.epoch + 1,
      state: "active",
      checkpoint_user_id: input.checkpointUserID,
      checkpoint_assistant_id: input.checkpointAssistantID,
      retained_tail_start_id: input.retainedTailStartID ?? null,
      source_end_message_id: input.sourceEndMessageID ?? null,
      checkpoint_hash: input.checkpointHash,
      projection_version: HistoryAuthority.PROJECTION_VERSION,
      canonicalization_version: HistoryAuthority.CANONICALIZATION_VERSION,
      base_message_count: input.baseMessageCount,
      effective_history_hash: input.effectiveHistoryHash,
      first_window_id: current.first_window_id ?? current.window_id ?? HistoryAuthority.windowID(),
      previous_window_id: current.window_id,
      window_id: HistoryAuthority.windowID(),
      world_state_baseline_hash: input.worldStateBaselineHash ?? null,
      authority_state: "ready",
      recovery_reason: null,
      recovery_resolution_id: null,
      reason: "compaction",
      created_at: now,
      retired_at: null,
    }
    yield* tx.insert(SessionPromptEpochTable).values(next).run()
    if (input.replacementMessageIDs.length > 0) {
      yield* tx
        .insert(SessionPromptEpochMessageTable)
        .values(
          input.replacementMessageIDs.map((messageID, ordinal) => ({
            session_id: input.sessionID,
            prompt_epoch: next.epoch,
            ordinal,
            message_id: messageID,
          })),
        )
        .run()
    }
    return next
  })
}

// ── Layer ────────────────────────────────────────────────────────────────────

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const getActive = (sessionID: SessionID) => getActiveInTransaction(db, sessionID).pipe(Effect.orDie)

    const bootstrap = (sessionID: SessionID) =>
      db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const existing = yield* getActiveInTransaction(tx, sessionID)
              if (existing) return existing

              const physicalMessage = yield* tx
                .select({ id: MessageTable.id })
                .from(MessageTable)
                .where(eq(MessageTable.session_id, sessionID))
                .limit(1)
                .get()
              if (physicalMessage) {
                return yield* Effect.die(
                  new Error(
                    `PromptEpoch bootstrap cannot authorize non-empty session ${sessionID}; use prompt history migration`,
                  ),
                )
              }

              const windowID = HistoryAuthority.windowID()
              const row: PromptEpochRow = {
                session_id: sessionID,
                epoch: 0,
                state: "active",
                checkpoint_user_id: null,
                checkpoint_assistant_id: null,
                retained_tail_start_id: null,
                source_end_message_id: null,
                checkpoint_hash: null,
                projection_version: HistoryAuthority.PROJECTION_VERSION,
                canonicalization_version: HistoryAuthority.CANONICALIZATION_VERSION,
                base_message_count: 0,
                effective_history_hash: HistoryAuthority.hash([]),
                first_window_id: windowID,
                previous_window_id: null,
                window_id: windowID,
                world_state_baseline_hash: null,
                authority_state: "ready",
                recovery_reason: null,
                recovery_resolution_id: null,
                reason: "bootstrap",
                created_at: Date.now(),
                retired_at: null,
              }
              yield* tx.insert(SessionPromptEpochTable).values(row).onConflictDoNothing().run()
              const active = yield* getActiveInTransaction(tx, sessionID)
              if (!active) return yield* Effect.die(new Error(`PromptEpoch bootstrap failed for ${sessionID}`))
              return active
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)

    const activate = (input: Parameters<PromptEpochInterface["activate"]>[0]) =>
      db.transaction((tx) => activateInTransaction(tx, input), { behavior: "immediate" }).pipe(Effect.orDie)

    return Service.of({ getActive, bootstrap, activate })
  }),
)

// §16.3 order 4 — V2 turn receipt history-window identity bridge. Reads the active authority row
// ONLY (no bootstrap, no writes): sessions without an epoch yet (e.g. fresh V2-driven subagent
// children) return undefined and the runner keeps its pre-seam ContextEpoch-revision identity.
// Read-only + degrade-to-absent is the seam contract: no side effects, never blocks a turn.
export const historyEpochLookup =
  (database: Database.Interface) =>
  (sessionID: string): Effect.Effect<number | undefined> =>
    database.db
      .select({ epoch: SessionPromptEpochTable.epoch })
      .from(SessionPromptEpochTable)
      .where(and(eq(SessionPromptEpochTable.session_id, sessionID), eq(SessionPromptEpochTable.state, "active")))
      .get()
      .pipe(Effect.map((row) => row?.epoch), Effect.orDie)

// §16.3 order 4 package D — federation selection evidence provider: reads the session's latest
// committed federation selection (the legacy durable loop stays the single selection writer) so a
// V2 turn's selection commit records the real graph revisions / source fingerprint instead of the
// empty v2:local evidence. Read-only; absent selection or a fault returns undefined (local
// evidence, exactly the pre-seam behavior).
export const selectionEvidenceLookup =
  (database: Database.Interface) =>
  (sessionID: string): Effect.Effect<SessionRunnerCanonical.SelectionEvidence | undefined> =>
    database.db
      .select({
        graph_revisions: SessionContextSelectionTable.graph_revisions,
        selected_source_fingerprint: SessionContextSelectionTable.selected_source_fingerprint,
        observed_location_mutation_epoch: SessionContextSelectionTable.observed_location_mutation_epoch,
      })
      .from(SessionContextSelectionTable)
      // The V2 runner's own selections (`v2:local` namespace) are not federation evidence; only
      // rows committed by the durable runtime count. Newest by wall clock — revision restarts per
      // activity, so it is NOT a session-wide recency key.
      .where(
        and(
          eq(SessionContextSelectionTable.session_id, sessionID),
          ne(SessionContextSelectionTable.security_namespace_id, ContextReference.SecurityNamespaceID.make("v2:local")),
        ),
      )
      .orderBy(desc(SessionContextSelectionTable.created_at))
      .limit(1)
      .get()
      .pipe(
        Effect.map((row) => {
          if (!row) return undefined
          const parsed: unknown = JSON.parse(row.graph_revisions)
          const revisions = parsed as Partial<Record<"code" | "documents" | "knowledge" | "memory", unknown>>
          if (
            typeof revisions.code !== "string" ||
            typeof revisions.documents !== "string" ||
            typeof revisions.knowledge !== "string" ||
            typeof revisions.memory !== "string"
          )
            return undefined
          return {
            graphRevisions: {
              code: revisions.code,
              documents: revisions.documents,
              knowledge: revisions.knowledge,
              memory: revisions.memory,
            },
            selectedSourceFingerprint: row.selected_source_fingerprint,
            observedLocationMutationEpoch: row.observed_location_mutation_epoch,
          }
        }),
        // Full-cause downgrade by contract: any lookup fault (malformed stored revision, DB
        // failure, anything else) yields undefined and the runner keeps the pre-seam local
        // evidence — a seam fault must never fail the turn.
        Effect.catchCause(() => Effect.succeed(undefined)),
      )

// Composition seam layer: hands BOTH order-4 runner seams (history epoch lookup, selection
// evidence lookup) to the V2 runner scope in any graph where Database is available (AppRuntime
// root graph, instance HTTP route root). Layer.effect pins the SHARED Database service captured
// from the surrounding graph at build time — the layer itself has no open requirements, so
// mergeAll never leaks Database into the root graph's RIn.
export const v2RunnerSeamLayer = Layer.effectContext(
  Effect.gen(function* () {
    const database = yield* Database.Service
    return Context.make(V2ProviderTurn.CurrentHistoryEpochLookup, historyEpochLookup(database)).pipe(
      Context.add(SessionRunnerCanonical.CurrentSelectionEvidenceLookup, selectionEvidenceLookup(database)),
    )
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
export * as PromptEpoch from "./prompt-epoch"
