import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import sessionTransferAuthorityMigration from "@deepagent-code/core/database/migration/20260813133000_session_transfer_authority"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { SessionTransfer } from "@deepagent-code/core/session/transfer"
import type { SessionSchema } from "@deepagent-code/core/session/schema"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
      Effect.scoped,
    ),
  )

// §16.3 order 5 F4 — orchestration over the DB authority pinned by
// session-transfer-authority.test.ts. Minimal tables mirror the real schema's relevant columns.
const setup = Effect.gen(function* () {
  const db = yield* EffectDrizzleSqlite.makeWithDefaults()
  yield* db.run(sql`PRAGMA foreign_keys = ON`)
  // Timestamps (time_created/time_updated) come from the real SessionTable spread; drizzle's
  // $onUpdate makes every session UPDATE write time_updated, so the minimal table must have it.
  yield* db.run(sql`CREATE TABLE session (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    mutation_epoch INTEGER NOT NULL DEFAULT 0,
    time_created INTEGER NOT NULL DEFAULT 0,
    time_updated INTEGER NOT NULL DEFAULT 0
  )`)
  yield* db.run(sql`CREATE TABLE event_sequence (
    aggregate_id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    owner_id TEXT,
    retention_floor_seq INTEGER,
    snapshot_id TEXT
  )`)
  yield* db.run(sql`CREATE TABLE session_input (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL
  )`)
  yield* db.run(sql`INSERT INTO session(id, workspace_id, mutation_epoch) VALUES ('session-a', 'workspace-source', 4)`)
  yield* db.run(sql`INSERT INTO event_sequence(aggregate_id, seq, owner_id) VALUES ('session-a', 9, 'owner-source')`)
  yield* DatabaseMigration.applyOnly(db, [sessionTransferAuthorityMigration])
  return db
})

const request = {
  sessionID: "session-a" as SessionSchema.ID,
  sourceWorkspaceID: "workspace-source",
  targetWorkspaceID: "workspace-target",
  sourceOwnerID: "owner-source",
  targetOwnerID: "owner-target",
}

describe("SessionTransfer orchestration", () => {
  test("admits one operation, captures frontier evidence, and converges on exact retry", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* setup
        const first = yield* SessionTransfer.admit(db, { ...request, now: 1 })
        expect(first.state).toBe("admitted")
        expect(first.source_event_seq).toBe(9)
        expect(first.source_mutation_epoch).toBe(4)
        expect(first.request_hash).toHaveLength(64)

        const retry = yield* SessionTransfer.admit(db, { ...request, now: 2 })
        expect(retry.transfer_id).toBe(first.transfer_id)
        expect(retry.created_at).toBe(1)
      }),
    )
  })

  test("refuses a different request while an operation is active and a session without event authority", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* setup
        yield* SessionTransfer.admit(db, request)
        const conflict = yield* SessionTransfer.admit(db, { ...request, targetWorkspaceID: "workspace-other" }).pipe(Effect.exit)
        expect(Exit.isFailure(conflict)).toBe(true)
        if (Exit.isFailure(conflict)) {
          const cause = conflict.cause as { readonly _tag?: string; readonly error?: { readonly reason?: string } }
          expect(String(conflict.cause)).toContain("SessionTransfer.ConflictError")
        }

        yield* db.run(sql`INSERT INTO session(id, workspace_id, mutation_epoch) VALUES ('session-b', NULL, 0)`)
        const missing = yield* SessionTransfer.admit(db, { ...request, sessionID: "session-b" as SessionSchema.ID }).pipe(Effect.exit)
        expect(Exit.isFailure(missing)).toBe(true)
        expect(String(missing)).toContain("SessionTransfer.ConflictError")
        expect(String(missing)).toContain("no event sequence authority")
      }),
    )
  })

  test("rejects unknown sessions", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* setup
        const result = yield* SessionTransfer.admit(db, { ...request, sessionID: "session-missing" as SessionSchema.ID }).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(String(result)).toContain("SessionTransfer.SessionNotFoundError")
      }),
    )
  })

  test("freezeSource fences the source, converges on same snapshot, and diverges on another", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* setup
        const operation = yield* SessionTransfer.admit(db, request)
        const frozen = yield* SessionTransfer.freezeSource(db, {
          transferID: operation.transfer_id,
          snapshotID: "snapshot-a",
          snapshotHash: "b".repeat(64),
          now: 3,
        })
        expect(frozen.state).toBe("source_frozen")

        const fenced = yield* db.run(sql`INSERT INTO session_input VALUES ('input-x', 'session-a')`).pipe(Effect.exit)
        expect(Exit.isFailure(fenced)).toBe(true)

        const retry = yield* SessionTransfer.freezeSource(db, {
          transferID: operation.transfer_id,
          snapshotID: "snapshot-a",
          snapshotHash: "b".repeat(64),
          now: 4,
        })
        expect(retry.transfer_id).toBe(operation.transfer_id)

        const divergent = yield* SessionTransfer.freezeSource(db, {
          transferID: operation.transfer_id,
          snapshotID: "snapshot-other",
          snapshotHash: "c".repeat(64),
        }).pipe(Effect.exit)
        expect(Exit.isFailure(divergent)).toBe(true)
        expect(String(divergent)).toContain("SessionTransfer.InvalidStateError")
      }),
    )
  })

  test("drives the full phase chain to activation and moves the session placement", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* setup
        const operation = yield* SessionTransfer.admit(db, request)
        yield* SessionTransfer.freezeSource(db, {
          transferID: operation.transfer_id,
          snapshotID: "snapshot-a",
          snapshotHash: "b".repeat(64),
        })
        const staged = yield* SessionTransfer.stageTarget(db, { transferID: operation.transfer_id })
        expect(staged.state).toBe("target_staged")
        const restaged = yield* SessionTransfer.stageTarget(db, { transferID: operation.transfer_id })
        expect(restaged.transfer_id).toBe(operation.transfer_id)

        const committed = yield* SessionTransfer.commitOwner(db, { transferID: operation.transfer_id })
        expect(committed.state).toBe("owner_committed")

        const activated = yield* SessionTransfer.activate(db, {
          transferID: operation.transfer_id,
          activatedSnapshotID: "snapshot-target",
          now: 7,
        })
        expect(activated.state).toBe("target_activated")
        expect(activated.completed_at).toBe(7)

        const placement = yield* db.get(sql`SELECT workspace_id FROM session WHERE id = 'session-a'`)
        expect(placement).toEqual({ workspace_id: "workspace-target" })
        const receipt = yield* db.get(sql`SELECT state, activated_snapshot_id FROM session_transfer_target_receipt`)
        expect(receipt).toEqual({ state: "activated", activated_snapshot_id: "snapshot-target" })

        const replay = yield* SessionTransfer.activate(db, {
          transferID: operation.transfer_id,
          activatedSnapshotID: "snapshot-target",
        })
        expect(replay.state).toBe("target_activated")
      }),
    )
  })

  test("fails closed on phase skips; frozen-source abort keeps the fence and allows a new transfer", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* setup
        const operation = yield* SessionTransfer.admit(db, request)

        const skipActivate = yield* SessionTransfer.activate(db, {
          transferID: operation.transfer_id,
          activatedSnapshotID: "snapshot-x",
        }).pipe(Effect.exit)
        expect(Exit.isFailure(skipActivate)).toBe(true)
        expect(String(skipActivate)).toContain("SessionTransfer.InvalidStateError")

        const skipStage = yield* SessionTransfer.stageTarget(db, { transferID: operation.transfer_id }).pipe(Effect.exit)
        expect(Exit.isFailure(skipStage)).toBe(true)

        yield* SessionTransfer.freezeSource(db, {
          transferID: operation.transfer_id,
          snapshotID: "snapshot-a",
          snapshotHash: "b".repeat(64),
        })
        // Abort IS reachable after the freeze, but the one-way fence survives: the source stays
        // fenced and recovery proceeds through a NEW transfer, never a silent unfence.
        const lateAbort = yield* SessionTransfer.abort(db, { transferID: operation.transfer_id, errorCode: "target_invalid" })
        expect(lateAbort.state).toBe("aborted")

        const fence = yield* db.get(sql`SELECT write_fence_transfer_id FROM event_sequence WHERE aggregate_id = 'session-a'`)
        expect(fence).toEqual({ write_fence_transfer_id: operation.transfer_id })

        const next = yield* SessionTransfer.admit(db, { ...request, targetOwnerID: "owner-target-2" })
        expect(next.state).toBe("admitted")
        expect(next.transfer_id).not.toBe(operation.transfer_id)
      }),
    )
  })

  test("validates the snapshot hash and keeps placement when no target workspace is stated", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* setup
        const operation = yield* SessionTransfer.admit(db, request)

        const badHash = yield* SessionTransfer.freezeSource(db, {
          transferID: operation.transfer_id,
          snapshotID: "snapshot-a",
          snapshotHash: "short",
        }).pipe(Effect.exit)
        expect(Exit.isFailure(badHash)).toBe(true)
        expect(String(badHash)).toContain("SessionTransfer.ValidationError")

        // A transfer without a target workspace activates without touching the session placement.
        yield* db.run(sql`INSERT INTO session(id, workspace_id, mutation_epoch) VALUES ('session-b', 'workspace-b', 0)`)
        yield* db.run(sql`INSERT INTO event_sequence(aggregate_id, seq) VALUES ('session-b', 0)`)
        const noTarget = yield* SessionTransfer.admit(db, {
          ...request,
          sessionID: "session-b" as SessionSchema.ID,
          sourceWorkspaceID: undefined,
          targetWorkspaceID: undefined,
          sourceOwnerID: undefined,
          targetOwnerID: undefined,
        })
        yield* SessionTransfer.freezeSource(db, {
          transferID: noTarget.transfer_id,
          snapshotID: "snapshot-b",
          snapshotHash: "c".repeat(64),
        })
        yield* SessionTransfer.stageTarget(db, { transferID: noTarget.transfer_id })
        yield* SessionTransfer.commitOwner(db, { transferID: noTarget.transfer_id })
        const activated = yield* SessionTransfer.activate(db, {
          transferID: noTarget.transfer_id,
          activatedSnapshotID: "snapshot-b-target",
        })
        expect(activated.state).toBe("target_activated")

        const placement = yield* db.get(sql`SELECT workspace_id FROM session WHERE id = 'session-b'`)
        expect(placement).toEqual({ workspace_id: "workspace-b" })
      }),
    )
  })

  test("aborts an admitted transfer before the fence and frees the session for a new transfer", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* setup
        const operation = yield* SessionTransfer.admit(db, request)
        const aborted = yield* SessionTransfer.abort(db, { transferID: operation.transfer_id, errorCode: "user_cancelled" })
        expect(aborted.state).toBe("aborted")

        const next = yield* SessionTransfer.admit(db, { ...request, targetWorkspaceID: "workspace-other" })
        expect(next.state).toBe("admitted")
        expect(next.transfer_id).not.toBe(operation.transfer_id)
      }),
    )
  })
})
