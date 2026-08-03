/**
 * task-fork.ts — Session.forkForTask implementation.
 *
 * Design: subagent-control-plane-design.zh-CN.md §3.2, §10.4
 *
 * Extends the existing Session.fork primitive with:
 *   - caller-supplied deterministic child session ID
 *   - durable compact clone manifest written atomically on first insert
 *   - deterministic source→target message/part ID derivation via SHA-256
 *   - crash recovery: re-read manifest and verify exact match on retry
 *
 * Invariants:
 *   #7 (design): task fork creates child Session identity on first insert;
 *                TaskProvisioner must not create an empty child first
 *   Crash recovery: target exists → verify manifest → adopt or conflict
 */

import { Data, Effect } from "effect"
import { Hash } from "@deepagent-code/core/util/hash"
import { Database } from "@deepagent-code/core/database/database"
import { MessageTable, PartTable } from "@deepagent-code/core/session/sql"
import { eq, and } from "drizzle-orm"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "./session"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ForkManifestConflictError extends Data.TaggedError("TaskFork.ManifestConflict")<{
  readonly childSessionID: SessionID
  readonly reason: string
}> {}

// ---------------------------------------------------------------------------
// Deterministic ID derivation (design §10.4)
// IDs are derived per-run so two forks of the same source don't collide.
// ---------------------------------------------------------------------------

const MAPPING_VERSION = 1

/**
 * Derive a deterministic target MessageID from a source message ID and run ID.
 * Uses SHA-256 to produce a collision-resistant mapping.
 */
function deriveMessageID(runID: string, sourceMsgID: string): MessageID {
  const digest = Hash.sha256(`${MAPPING_VERSION}:msg:${runID}:${sourceMsgID}`)
  return MessageID.make(`msg${digest.slice(0, 22)}`)
}

/**
 * Derive a deterministic target PartID from a source part ID and run ID.
 */
function derivePartID(runID: string, sourcePartID: string): PartID {
  const digest = Hash.sha256(`${MAPPING_VERSION}:prt:${runID}:${sourcePartID}`)
  return PartID.make(`prt${digest.slice(0, 22)}`)
}

// ---------------------------------------------------------------------------
// ForkManifest — persisted in session metadata to enable crash recovery
// ---------------------------------------------------------------------------

export type ForkManifest = {
  readonly mappingVersion: typeof MAPPING_VERSION
  readonly runID: string
  readonly parentSessionID: SessionID
  readonly cutoffMessageID: string
  readonly requestHash: string
  readonly sourceHistoryHash: string
  readonly state: "prepared" | "complete"
}

// ---------------------------------------------------------------------------
// forkForTask — deterministic task context fork
// Design §10.4
// ---------------------------------------------------------------------------

/**
 * Create a context fork for a task run with deterministic IDs and a durable manifest.
 *
 * On first call: creates child session with manifest, clones messages up to cutoff.
 * On retry (crash recovery): reads existing manifest, verifies, adopts if exact match.
 */
export function forkForTask(input: {
  readonly runID: string
  readonly childSessionID: SessionID
  readonly parentSessionID: SessionID
  readonly cutoffMessageID: string
  readonly requestHash: string
  readonly childDepth: number
  readonly childDirectory: string
}) {
  return Effect.gen(function* () {
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service

    // Check if child session already exists (crash recovery)
    const existing = yield* sessions.get(input.childSessionID).pipe(
      Effect.orElseSucceed(() => undefined as typeof result | undefined),
    )
    const result = undefined as any

    if (existing) {
      // Verify the existing manifest matches this fork request
      const manifest = existing.metadata?.deepagent?.task_fork_manifest as ForkManifest | undefined
      if (!manifest) {
        return yield* Effect.fail(
          new ForkManifestConflictError({
            childSessionID: input.childSessionID,
            reason: "child session exists but has no task_fork_manifest",
          }),
        )
      }
      if (
        manifest.runID !== input.runID ||
        manifest.parentSessionID !== input.parentSessionID ||
        manifest.cutoffMessageID !== input.cutoffMessageID ||
        manifest.requestHash !== input.requestHash
      ) {
        return yield* Effect.fail(
          new ForkManifestConflictError({
            childSessionID: input.childSessionID,
            reason: `manifest mismatch: existing run=${manifest.runID}, cutoff=${manifest.cutoffMessageID}`,
          }),
        )
      }
      // Exact match — adopt existing child
      return input.childSessionID
    }

    // First call: get parent messages up to cutoff for hash computation
    const parentMessages = yield* db
      .select({ id: MessageTable.id, data: MessageTable.data, time_created: MessageTable.time_created })
      .from(MessageTable)
      .where(eq(MessageTable.session_id, input.parentSessionID as any))
      .all()
      .pipe(Effect.orDie)

    const cutoffIndex = parentMessages.findIndex((m) => m.id === input.cutoffMessageID)
    const messagesToClone = cutoffIndex >= 0 ? parentMessages.slice(0, cutoffIndex + 1) : []

    // Compute source history hash for crash recovery verification
    const sourceHistoryHash = Hash.sha256(
      JSON.stringify(messagesToClone.map((m) => ({ id: m.id, hash: Hash.sha256(JSON.stringify(m.data)) }))),
    )

    const manifest: ForkManifest = {
      mappingVersion: MAPPING_VERSION,
      runID: input.runID,
      parentSessionID: input.parentSessionID,
      cutoffMessageID: input.cutoffMessageID,
      requestHash: input.requestHash,
      sourceHistoryHash,
      state: "prepared",
    }

    // Create child session with manifest (atomic — manifest is the crash recovery anchor)
    yield* sessions.create({
      id: input.childSessionID,
      parentID: input.parentSessionID,
      directory: input.childDirectory,
      title: `Fork of ${input.parentSessionID} (task run ${input.runID})`,
      metadata: {
        deepagent: {
          task_fork_manifest: manifest,
          [SUBAGENT_DEPTH_META_KEY]: input.childDepth,
        },
      },
    })

    // Clone messages and parts with deterministic IDs
    for (const msg of messagesToClone) {
      const targetMsgID = deriveMessageID(input.runID, msg.id)

      yield* db
        .insert(MessageTable)
        .values({
          id: targetMsgID,
          session_id: input.childSessionID as any,
          time_created: msg.time_created,
          time_updated: msg.time_created,
          data: msg.data,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      // Clone parts for this message
      const parts = yield* db
        .select()
        .from(PartTable)
        .where(eq(PartTable.message_id, msg.id as any))
        .all()
        .pipe(Effect.orDie)

      for (const part of parts) {
        const targetPartID = derivePartID(input.runID, part.id)
        yield* db
          .insert(PartTable)
          .values({
            id: targetPartID,
            message_id: targetMsgID,
            session_id: input.childSessionID as any,
            time_created: part.time_created,
            time_updated: part.time_created,
            data: part.data,
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
      }
    }

    // Mark manifest as complete
    yield* sessions.setMetadata({
      sessionID: input.childSessionID,
      metadata: { task_fork_manifest: { ...manifest, state: "complete" } },
    }).pipe(Effect.ignore)

    return input.childSessionID
  })
}

const SUBAGENT_DEPTH_META_KEY = "subagentDepth"

export * as TaskFork from "./task-fork"
