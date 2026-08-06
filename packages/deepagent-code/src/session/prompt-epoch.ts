// BUG-005: PromptEpoch — the unique model history boundary authority.
//
// Design contract (docs/4.0.4_r6.md §11, docs/bug-005-405.md §4.4):
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
import { and, eq } from "drizzle-orm"
import { SessionPromptEpochTable, type PromptEpochReason } from "./prompt-epoch.sql"

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
    retainedTailStartID?: MessageID
    sourceEndMessageID?: MessageID
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
      reason: "compaction",
      created_at: now,
      retired_at: null,
    }
    yield* tx.insert(SessionPromptEpochTable).values(next).run()
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

              const row: PromptEpochRow = {
                session_id: sessionID,
                epoch: 0,
                state: "active",
                checkpoint_user_id: null,
                checkpoint_assistant_id: null,
                retained_tail_start_id: null,
                source_end_message_id: null,
                checkpoint_hash: null,
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

    const activate = (input: {
      sessionID: SessionID
      fromEpoch: number
      checkpointUserID: MessageID
      checkpointAssistantID: MessageID
      checkpointHash: string
      retainedTailStartID?: MessageID
      sourceEndMessageID?: MessageID
    }) => db.transaction((tx) => activateInTransaction(tx, input), { behavior: "immediate" }).pipe(Effect.orDie)

    return Service.of({ getActive, bootstrap, activate })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
export * as PromptEpoch from "./prompt-epoch"
