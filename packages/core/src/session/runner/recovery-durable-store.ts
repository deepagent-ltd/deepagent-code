export * as SessionProviderRecoveryDurable from "./recovery-durable-store"

// W2 — durable recovery store (design §W2 "恢复持久化").
//
// The C1B recovery surfaces (five-class descriptor / command slot / evidence export)
// were process-local (a Ref in `recovery.ts`); a kill-9 restart lost all of them. This
// module is the DB-backed store behind the SAME command-CAS semantics as the pure
// functions in ./recovery-store:
//
//   - descriptors are content-addressed (descriptor_id = descriptor_<descriptor digest>)
//     and append-only, so an exact retry converges on the SAME row (insert-or-ignore);
//   - command CAS is enforced by SQLite: one immediate transaction holds the writer lock,
//     reads the attempt slot, and either inserts (`recorded`), finds the identical
//     command (`existing`) or finds a different request hash on the same attempt
//     (`mismatch`) — exactly one concurrent submission wins;
//   - command state transitions are conditional updates (`state` matched), returning a
//     typed "transitioned / already / state_mismatch" verdict;
//   - evidence exports are stored with their sealed body so unlock works after restart.
//
// Scope note (W2 boundary): C1B evidence records (pending/external/settled statuses),
// baseline repairs, fork fences and abandon receipts are NOT yet table-backed (they
// belong to later waves); this store persists the three W2 surfaces only.

import { and, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { RecoveryCommandContract } from "../../contract/recovery-command"
import type {
  AttemptIdentity,
  CommandRecord,
  CommandWriteOutcome,
} from "./recovery-store"
import { recoveryCommandContentAddress } from "./recovery-store"
import {
  RecoveryCommandTable,
  RecoveryEvidenceExportTable,
  SessionProviderRecoveryDescriptorTable,
} from "./recovery-store.sql"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase

// ---------------------------------------------------------------------------
// Row shapes (snake_case columns; JSON columns round-tripped in JS)
// ---------------------------------------------------------------------------

/** One durable recovery descriptor row (payload decoded). */
export type DescriptorRow = {
  readonly descriptorId: string
  readonly sessionId: string
  readonly activityId: string
  readonly turnId: string
  readonly kind: RecoveryCommandContract.RecoveryDescriptorKind
  readonly payload: RecoveryCommandContract.RecoveryDescriptor
  readonly contentHash: string
  readonly createdAt: number
}

/** Command slot states. `pending` is the single-writer slot before its terminal effect. */
export const CommandState = {
  pending: "pending",
  abandoned: "abandoned",
  forked: "forked",
  settled: "settled",
} as const
export type CommandState = (typeof CommandState)[keyof typeof CommandState]

/** One durable recovery-command row (attempt identity decoded). */
export type CommandRow = {
  readonly commandId: string
  readonly descriptorId?: string
  readonly attempt: AttemptIdentity
  readonly requestHash: string
  readonly state: CommandState
  readonly expectedOwnerToken?: string
  readonly resultHash?: string
  readonly actorType?: "user" | "administrator" | "system"
  readonly actorId?: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** One durable evidence-export row (sealed body decoded). */
export type ExportRow = {
  readonly exportId: string
  readonly descriptorId?: string
  readonly manifestHash: string
  readonly state: string
  readonly createdAt: number
  readonly payload: unknown
}

/** Raw row as stored (JSON columns as text). */
type DescriptorDbRow = {
  descriptor_id: string
  session_id: string
  activity_id: string
  turn_id: string
  kind: string
  payload: string
  content_hash: string
  created_at: number
}

type CommandDbRow = {
  command_id: string
  descriptor_id: string | null
  attempt: string
  state: string
  expected_owner_token: string | null
  result_hash: string | null
  actor_type: string | null
  actor_id: string | null
  created_at: number
  updated_at: number
}

type ExportDbRow = {
  export_id: string
  descriptor_id: string | null
  manifest_hash: string
  state: string
  created_at: number
  payload: string
}

// ---------------------------------------------------------------------------
// Pure row mapping (deterministic; separately unit-testable)
// ---------------------------------------------------------------------------

/** Deterministic descriptor id: content-addressed by the descriptor digest. */
export function recoveryDescriptorId(descriptor: RecoveryCommandContract.RecoveryDescriptor): string {
  return `descriptor_${RecoveryCommandContract.recoveryDescriptorDigest(descriptor)}`
}

/** Decode a stored descriptor row into the typed shape. Unknown kind is a typed refusal. */
export function decodeDescriptorRow(row: DescriptorDbRow): DescriptorRow | undefined {
  let payload: RecoveryCommandContract.RecoveryDescriptor
  try {
    payload = RecoveryCommandContract.decodeRecoveryDescriptor(JSON.parse(row.payload))
  } catch {
    return undefined
  }
  if (payload.descriptorKind !== row.kind) return undefined
  return {
    descriptorId: row.descriptor_id,
    sessionId: row.session_id,
    activityId: row.activity_id,
    turnId: row.turn_id,
    kind: payload.descriptorKind,
    payload,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  }
}

/** Decode a stored command row into the typed shape (attempt JSON carries the request hash). */
export function decodeCommandRow(row: CommandDbRow): CommandRow | undefined {
  let attempt: unknown
  try {
    attempt = JSON.parse(row.attempt)
  } catch {
    return undefined
  }
  const raw = attempt as Record<string, unknown>
  const identity = decodeAttemptIdentity(raw)
  if (!identity) return undefined
  const commandState = row.state as CommandState
  const actorType =
    row.actor_type === "user" || row.actor_type === "administrator" || row.actor_type === "system"
      ? row.actor_type
      : undefined
  return {
    commandId: row.command_id,
    ...(row.descriptor_id !== null ? { descriptorId: row.descriptor_id } : {}),
    attempt: identity,
    requestHash: identity.requestHash,
    state: commandState,
    ...(row.expected_owner_token !== null ? { expectedOwnerToken: row.expected_owner_token } : {}),
    ...(row.result_hash !== null ? { resultHash: row.result_hash } : {}),
    ...(actorType !== undefined && row.actor_id !== null
      ? { actorType, actorId: row.actor_id }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Validate the stored attempt JSON and rebuild the typed AttemptIdentity. A malformed
 * row (any missing/mistyped required field) decodes to `undefined` — never a partial
 * identity used to re-derive a command/request hash.
 */
function decodeAttemptIdentity(raw: unknown): AttemptIdentity | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const fields = {
    sessionId: record.sessionId,
    activityId: record.activityId,
    attemptId: record.attemptId,
    providerTurnSeq: record.providerTurnSeq,
    selectionId: record.selectionId,
    projectionHash: record.projectionHash,
    requestHash: record.requestHash,
    providerId: record.providerId,
  }
  if (Object.values(fields).some((value) => typeof value !== "string" && typeof value !== "number")) {
    return undefined
  }
  if (typeof fields.providerTurnSeq !== "number") return undefined
  return {
    sessionId: fields.sessionId as string,
    activityId: fields.activityId as string,
    attemptId: fields.attemptId as string,
    providerTurnSeq: fields.providerTurnSeq,
    selectionId: fields.selectionId as string,
    projectionHash: fields.projectionHash as string,
    requestHash: fields.requestHash as string,
    providerId: fields.providerId as string,
    ...(typeof record.protocol === "string" ? { protocol: record.protocol } : {}),
    ...(typeof record.idempotencyKey === "string" ? { idempotencyKey: record.idempotencyKey } : {}),
  }
}

/** Decode a stored export row. */
export function decodeExportRow(row: ExportDbRow): ExportRow {
  return {
    exportId: row.export_id,
    ...(row.descriptor_id !== null ? { descriptorId: row.descriptor_id } : {}),
    manifestHash: row.manifest_hash,
    state: row.state,
    createdAt: row.created_at,
    payload: JSON.parse(row.payload),
  }
}

/** Map a decoded command row back to the store-level CommandRecord contract. */
export function toCommandRecord(row: CommandRow): CommandRecord {
  return {
    commandId: row.commandId,
    requestHash: row.requestHash,
    attemptIdentity: row.attempt,
    recordedAt: row.createdAt,
  }
}

/** Build a CommandRecord for an insert-just-won command. */
export function newCommandRecord(input: {
  readonly requestHash: string
  readonly attemptIdentity: AttemptIdentity
  readonly commandId: string
  readonly now: number
}): CommandRecord {
  return {
    commandId: input.commandId,
    requestHash: input.requestHash,
    attemptIdentity: input.attemptIdentity,
    recordedAt: input.now,
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface DurableRecoveryStore {
  /** Insert-or-ignore a content-addressed descriptor. Same payload → `existing`. */
  readonly putDescriptor: (input: {
    readonly descriptor: RecoveryCommandContract.RecoveryDescriptor
    readonly sessionId: string
    readonly activityId: string
    readonly turnId: string
    readonly createdAt?: number
  }) => Effect.Effect<{ readonly status: "recorded" | "existing"; readonly descriptorId: string }, never>
  readonly getDescriptor: (descriptorId: string) => Effect.Effect<DescriptorRow | undefined, never>
  /** All descriptors for a session, newest first (lifecycle order). */
  readonly listDescriptorsBySession: (sessionId: string) => Effect.Effect<readonly DescriptorRow[], never>
  /**
   * Command slot CAS. One immediate transaction: the attempt slot is read under the
   * writer lock, so of two concurrent submissions exactly one wins:
   *   - empty slot              → `recorded` (insert);
   *   - same request hash       → `existing` (idempotent, no second row);
   *   - different request hash  → typed `mismatch` (never clobber).
   */
  readonly putCommand: (input: {
    readonly requestHash: string
    readonly attemptIdentity: AttemptIdentity
    /** Explicit content address (the maintenance handler computes it up front). */
    readonly commandId?: string
    readonly descriptorId?: string
    readonly expectedOwnerToken?: string
    readonly actorType?: "user" | "administrator" | "system"
    readonly actorId?: string
    readonly createdAt?: number
  }) => Effect.Effect<CommandWriteOutcome, never>
  /**
   * Conditional state transition (CAS by `state` match). `result_hash` is written back
   * with the transition; only the winner of the race reports `transitioned`, and an
   * idempotent retry of an already-transitioned command reports `already`.
   */
  readonly transitionCommand: (input: {
    readonly commandId: string
    readonly from: CommandState
    readonly to: CommandState
    readonly resultHash?: string
    readonly now?: number
  }) => Effect.Effect<"transitioned" | "already" | "state_mismatch", never>
  readonly getCommand: (commandId: string) => Effect.Effect<CommandRow | undefined, never>
  /** Commands for a session (joined through their descriptor rows), newest first. */
  readonly listCommandsBySession: (sessionId: string) => Effect.Effect<readonly CommandRow[], never>
  /** Commands whose attempt identity carries the exact request hash. */
  readonly listCommandsByRequestHash: (requestHash: string) => Effect.Effect<readonly CommandRow[], never>
  /** Insert-or-ignore an evidence export (sealed body kept for post-restart unlock). */
  readonly putExport: (input: {
    readonly exportId: string
    readonly descriptorId?: string
    readonly manifestHash: string
    readonly state: string
    readonly payload: unknown
    readonly createdAt?: number
  }) => Effect.Effect<{ readonly status: "recorded" | "existing"; readonly exportId: string }, never>
  readonly getExport: (exportId: string) => Effect.Effect<ExportRow | undefined, never>
}

/** Build the durable store over an open database (its own transactions are immediate). */
export const makeDurableRecoveryStore = (db: Database): DurableRecoveryStore => {
  const putDescriptor = Effect.fn("RecoveryDurableStore.putDescriptor")(function* (input: {
    readonly descriptor: RecoveryCommandContract.RecoveryDescriptor
    readonly sessionId: string
    readonly activityId: string
    readonly turnId: string
    readonly createdAt?: number
  }) {
    const now = input.createdAt ?? Date.now()
    const winner = yield* db
      .insert(SessionProviderRecoveryDescriptorTable)
      .values({
        descriptor_id: recoveryDescriptorId(input.descriptor),
        session_id: input.sessionId,
        activity_id: input.activityId,
        turn_id: input.turnId,
        kind: input.descriptor.descriptorKind,
        payload: input.descriptor,
        content_hash: RecoveryCommandContract.recoveryDescriptorDigest(input.descriptor),
        created_at: now,
      })
      .onConflictDoNothing()
      .returning({ descriptor_id: SessionProviderRecoveryDescriptorTable.descriptor_id })
      .get()
      .pipe(Effect.orDie)
    return {
      status: winner ? ("recorded" as const) : ("existing" as const),
      descriptorId: recoveryDescriptorId(input.descriptor),
    }
  })

  const getDescriptor = Effect.fn("RecoveryDurableStore.getDescriptor")(function* (descriptorId: string) {
    const row = yield* db.get<DescriptorDbRow | undefined>(sql`
      SELECT descriptor_id, session_id, activity_id, turn_id, kind, payload, content_hash, created_at
      FROM session_provider_recovery_descriptor WHERE descriptor_id = ${descriptorId}
    `).pipe(Effect.orDie)
    return row ? decodeDescriptorRow(row) : undefined
  })

  const listDescriptorsBySession = Effect.fn("RecoveryDurableStore.listDescriptorsBySession")(function* (
    sessionId: string,
  ) {
    const rows = yield* db.all<DescriptorDbRow>(sql`
      SELECT descriptor_id, session_id, activity_id, turn_id, kind, payload, content_hash, created_at
      FROM session_provider_recovery_descriptor
      WHERE session_id = ${sessionId}
      ORDER BY created_at DESC, descriptor_id DESC
    `).pipe(Effect.orDie)
    return rows.flatMap((row) => {
      const decoded = decodeDescriptorRow(row)
      return decoded ? [decoded] : []
    })
  })

  const putCommand = Effect.fn("RecoveryDurableStore.putCommand")(function* (input: {
    readonly requestHash: string
    readonly attemptIdentity: AttemptIdentity
    readonly commandId?: string
    readonly descriptorId?: string
    readonly expectedOwnerToken?: string
    readonly actorType?: "user" | "administrator" | "system"
    readonly actorId?: string
    readonly createdAt?: number
  }) {
    // One immediate transaction: the writer lock makes select-then-insert atomic across
    // connections (Bun's single-connection pool serializes within the process too).
    return yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const address =
            input.commandId ??
            recoveryCommandContentAddress({
              requestHash: input.requestHash,
              attemptIdentity: input.attemptIdentity,
            })
          // Attempt slot: any command already bound to this attempt identity (same
          // session + attempt id) is the slot owner; a different request hash is a
          // typed mismatch and is never clobbered.
          const prior = yield* tx.get<CommandDbRow | undefined>(sql`
            SELECT command_id, descriptor_id, attempt, state, expected_owner_token, result_hash,
                   actor_type, actor_id, created_at, updated_at
            FROM recovery_command
            WHERE json_extract(attempt, '$.sessionId') = ${input.attemptIdentity.sessionId}
              AND json_extract(attempt, '$.attemptId') = ${input.attemptIdentity.attemptId}
          `)
          if (prior) {
            const decoded = decodeCommandRow(prior)
            if (!decoded) return yield* Effect.die(new Error("recovery_command attempt decode failed"))
            if (decoded.requestHash !== input.requestHash) {
              return { status: "mismatch" as const, commandId: address, reason: "request_hash_mismatch" as const }
            }
            return {
              status: "existing" as const,
              commandId: prior.command_id,
              record: toCommandRecord(decoded),
            } satisfies CommandWriteOutcome
          }
          const now = input.createdAt ?? Date.now()
          yield* tx
            .insert(RecoveryCommandTable)
            .values({
              command_id: address,
              descriptor_id: input.descriptorId ?? null,
              attempt: input.attemptIdentity,
              state: CommandState.pending,
              expected_owner_token: input.expectedOwnerToken ?? null,
              result_hash: null,
              actor_type: input.actorType ?? null,
              actor_id: input.actorId ?? null,
              created_at: now,
              updated_at: now,
            })
            .onConflictDoNothing()
            .run()
          return {
            status: "recorded" as const,
            commandId: address,
            record: newCommandRecord({ ...input, commandId: address, now }),
          } satisfies CommandWriteOutcome
        }),
      { behavior: "immediate" as const },
    ).pipe(Effect.orDie)
  })

  const transitionCommand = Effect.fn("RecoveryDurableStore.transitionCommand")(function* (input: {
    readonly commandId: string
    readonly from: CommandState
    readonly to: CommandState
    readonly resultHash?: string
    readonly now?: number
  }) {
    const now = input.now ?? Date.now()
    const winner = yield* db
      .update(RecoveryCommandTable)
      .set({
        state: input.to,
        ...(input.resultHash === undefined ? {} : { result_hash: input.resultHash }),
        updated_at: now,
      })
      .where(
        and(
          eq(RecoveryCommandTable.command_id, input.commandId),
          eq(RecoveryCommandTable.state, input.from),
        ),
      )
      .returning({ command_id: RecoveryCommandTable.command_id })
      .get()
      .pipe(Effect.orDie)
    if (winner) return "transitioned" as const
    const current = yield* db.get<{ state: string } | undefined>(sql`
      SELECT state FROM recovery_command WHERE command_id = ${input.commandId}
    `).pipe(Effect.orDie)
    if (current?.state === input.to) return "already" as const
    return "state_mismatch" as const
  })

  const getCommand = Effect.fn("RecoveryDurableStore.getCommand")(function* (commandId: string) {
    const row = yield* db.get<CommandDbRow | undefined>(sql`
      SELECT command_id, descriptor_id, attempt, state, expected_owner_token, result_hash,
             actor_type, actor_id, created_at, updated_at
      FROM recovery_command WHERE command_id = ${commandId}
    `).pipe(Effect.orDie)
    return row ? decodeCommandRow(row) : undefined
  })

  const listCommandsBySession = Effect.fn("RecoveryDurableStore.listCommandsBySession")(function* (sessionId: string) {
    const rows = yield* db.all<CommandDbRow>(sql`
      SELECT c.command_id, c.descriptor_id, c.attempt, c.state, c.expected_owner_token,
             c.result_hash, c.actor_type, c.actor_id, c.created_at, c.updated_at
      FROM recovery_command c
      JOIN session_provider_recovery_descriptor d ON d.descriptor_id = c.descriptor_id
      WHERE d.session_id = ${sessionId}
      ORDER BY c.created_at DESC, c.command_id DESC
    `).pipe(Effect.orDie)
    return rows.flatMap((row) => {
      const decoded = decodeCommandRow(row)
      return decoded ? [decoded] : []
    })
  })

  const listCommandsByRequestHash = Effect.fn("RecoveryDurableStore.listCommandsByRequestHash")(function* (
    requestHash: string,
  ) {
    const rows = yield* db.all<CommandDbRow>(sql`
      SELECT command_id, descriptor_id, attempt, state, expected_owner_token, result_hash,
             actor_type, actor_id, created_at, updated_at
      FROM recovery_command
      WHERE json_extract(attempt, '$.requestHash') = ${requestHash}
      ORDER BY created_at DESC, command_id DESC
    `).pipe(Effect.orDie)
    return rows.flatMap((row) => {
      const decoded = decodeCommandRow(row)
      return decoded ? [decoded] : []
    })
  })

  const putExport = Effect.fn("RecoveryDurableStore.putExport")(function* (input: {
    readonly exportId: string
    readonly descriptorId?: string
    readonly manifestHash: string
    readonly state: string
    readonly payload: unknown
    readonly createdAt?: number
  }) {
    const now = input.createdAt ?? Date.now()
    const winner = yield* db
      .insert(RecoveryEvidenceExportTable)
      .values({
        export_id: input.exportId,
        descriptor_id: input.descriptorId ?? null,
        manifest_hash: input.manifestHash,
        state: input.state,
        created_at: now,
        payload: JSON.stringify(input.payload),
      })
      .onConflictDoNothing()
      .returning({ export_id: RecoveryEvidenceExportTable.export_id })
      .get()
      .pipe(Effect.orDie)
    return {
      status: winner ? ("recorded" as const) : ("existing" as const),
      exportId: input.exportId,
    }
  })

  const getExport = Effect.fn("RecoveryDurableStore.getExport")(function* (exportId: string) {
    const row = yield* db.get<ExportDbRow | undefined>(sql`
      SELECT export_id, descriptor_id, manifest_hash, state, created_at, payload
      FROM recovery_evidence_export WHERE export_id = ${exportId}
    `).pipe(Effect.orDie)
    return row ? decodeExportRow(row) : undefined
  })

  return {
    putDescriptor,
    getDescriptor,
    listDescriptorsBySession,
    putCommand,
    transitionCommand,
    getCommand,
    listCommandsBySession,
    listCommandsByRequestHash,
    putExport,
    getExport,
  }
}
