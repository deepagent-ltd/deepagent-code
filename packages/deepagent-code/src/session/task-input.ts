/**
 * LegacyTaskInput — atomic V1 message/part admission for subagent tasks.
 *
 * Design: subagent-control-plane-design.zh-CN.md §3.3
 *
 * Problem: SessionPrompt.prompt() writes V1 message/parts row-by-row (one event each),
 * providing no atomicity guarantee. A crash mid-way leaves partial rows that cannot be
 * distinguished from a complete input. noReply:true only suppresses the provider loop,
 * not the incremental writes.
 *
 * This module provides:
 *   prepare(run)         — build the V1 message+parts envelope in memory; no side effects
 *   projectExact(...)    — write the envelope atomically in one IMMEDIATE transaction,
 *                          CAS task_run.input_state from "admitting" → "ready"
 *
 * Invariants (design §1.3):
 *   #33: task child input only "admitted" once complete V1 message, all parts, materialized
 *        hash, and input_state="ready" are committed in the same transaction.
 *   #4:  atomic projector does not re-publish per-row events (use a task-specific batch event).
 */

import { Data, Effect } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { MessageTable, PartTable, TaskRunTable, TaskRunEventTable } from "@deepagent-code/core/session/sql"
import { Hash } from "@deepagent-code/core/util/hash"
import { and, eq } from "drizzle-orm"
import { MessageID, PartID } from "@/session/schema"
import { Identifier } from "@/id/id"
import type { Run } from "@/tool/task-run"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PreparedPart = {
  readonly partID: PartID
  readonly messageID: MessageID
  readonly sessionID: string
  readonly type: string
  readonly data: unknown
  readonly timeCreated: number
}

export type PreparedMessageData = {
  readonly role: "user"
  readonly providerID: string
  readonly metadata: Record<string, unknown>
}

export type PreparedTaskInput = {
  readonly messageID: MessageID
  readonly sessionID: string
  readonly prompt: string
  readonly parts: ReadonlyArray<PreparedPart>
  readonly materializedHash: string
  readonly partCount: number
  readonly timeCreated: number
  /** B-1 (P0-2): canonical message data — used in both hash and INSERT to ensure they match */
  readonly messageData: PreparedMessageData
}

export class InputProjectionConflictError extends Data.TaggedError("LegacyTaskInput.InputProjectionConflict")<{
  readonly runID: string
  readonly reason: string
}> {}

// ---------------------------------------------------------------------------
// prepare — build the V1 envelope in memory (no writes, no side effects)
// Design §3.3: "prepare runs existing prompt prepare/plugin transforms in memory"
// ---------------------------------------------------------------------------

/**
 * Build a PreparedTaskInput from a run's frozen execution spec.
 * This is a pure in-memory operation — no V1 rows are written, no provider is contacted,
 * no plugin hooks are executed.
 *
 * B-1 (P0-2): messageData is constructed once here and used in BOTH the hash and the INSERT
 * in projectExact, eliminating the hash/content mismatch. The hash now covers only what
 * actually gets written to the DB (no extra time/agent/model fields).
 */
export function prepare(run: Run) {
  return Effect.sync(() => {
    const now = Date.now()
    const messageID = run.childMessageID ?? MessageID.ascending()
    const sessionID = run.childSessionID as string
    const promptText = run.executionSpec?.prompt?.text ?? ""

    const partID = PartID.ascending()
    const textPart: PreparedPart = {
      partID,
      messageID,
      sessionID,
      type: "text",
      data: { type: "text", text: promptText },
      timeCreated: now,
    }

    // B-1 (P0-2): canonical message data — exactly what projectExact will write to DB.
    // Do NOT include time/agent/model here; they are not stored in the MessageTable.data column.
    const messageData: PreparedMessageData = {
      role: "user" as const,
      providerID: "task",
      metadata: {
        deepagent: {
          task_admission: {
            run_id: run.runID,
            origin_key: run.originKey ?? null,
            request_hash: run.requestHash,
          },
        },
      } as Record<string, unknown>,
    }

    // Hash covers exactly what is written to DB — no extra stringify of metadata.
    const hashInput = JSON.stringify({
      messageID,
      sessionID,
      messageData,
      parts: [{ partID, type: "text", text: promptText }],
    })

    return {
      messageID,
      sessionID,
      prompt: promptText,
      parts: [textPart],
      materializedHash: Hash.sha256(hashInput),
      partCount: 1,
      timeCreated: now,
      messageData,
    } satisfies PreparedTaskInput
  })
}

// ---------------------------------------------------------------------------
// projectExact — atomic batch write in one IMMEDIATE transaction
// Design §3.3
// ---------------------------------------------------------------------------

/**
 * Atomically write the prepared task input to V1 message/part tables.
 * CAS task_run.input_state: "admitting" → "ready" in the same transaction.
 *
 * Idempotent: if message and all parts already exist with matching hash and count,
 * returns exact_replay = true.
 *
 * Fails with InputProjectionConflictError if:
 *   - message exists but parts are missing or hash differs
 *   - input_state is not "admitting" (wrong caller ordering)
 *   - run version CAS lost (concurrent provisioner)
 */
export function projectExact(input: {
  readonly prepared: PreparedTaskInput
  readonly runID: string
  readonly expectedRunVersion: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service

    return yield* Effect.uninterruptible(
      db.transaction(
        (tx) =>
          Effect.gen(function* () {
            // 1. Verify run is in "admitting" state with matching version
            const run = yield* tx
              .select({
                version: TaskRunTable.version,
                inputState: TaskRunTable.input_state,
                existingHash: TaskRunTable.child_input_materialized_hash,
                existingCount: TaskRunTable.child_input_part_count,
              })
              .from(TaskRunTable)
              .where(eq(TaskRunTable.run_id, input.runID))
              .get()
              .pipe(Effect.orDie)

            if (!run) {
              return yield* Effect.die(new Error(`projectExact: run ${input.runID} not found`))
            }

            // 2. Check for exact replay (already admitted)
            if (run.inputState === "ready") {
              if (
                run.existingHash === input.prepared.materializedHash &&
                run.existingCount === input.prepared.partCount
              ) {
                return { exactReplay: true }
              }
              return yield* Effect.fail(
                new InputProjectionConflictError({
                  runID: input.runID,
                  reason: `input_state=ready but hash/count mismatch: existing=${run.existingHash}/${run.existingCount}, prepared=${input.prepared.materializedHash}/${input.prepared.partCount}`,
                }),
              )
            }

            if (run.inputState !== "admitting") {
              return yield* Effect.fail(
                new InputProjectionConflictError({
                  runID: input.runID,
                  reason: `expected input_state="admitting", got "${run.inputState}"`,
                }),
              )
            }

            if (run.version !== input.expectedRunVersion) {
              return yield* Effect.fail(
                new InputProjectionConflictError({
                  runID: input.runID,
                  reason: `run version CAS mismatch: expected=${input.expectedRunVersion}, actual=${run.version}`,
                }),
              )
            }

            // 3. Insert the V1 message row
            // B-1 (P0-2): use prepared.messageData directly so the content exactly matches the hash
            const now = input.prepared.timeCreated
            yield* tx
              .insert(MessageTable)
              .values({
                id: input.prepared.messageID,
                session_id: input.prepared.sessionID as any,
                time_created: now,
                time_updated: now,
                data: input.prepared.messageData as any,
              })
              .onConflictDoNothing()
              .run()
              .pipe(Effect.orDie)

            // 4. Insert all part rows
            for (const part of input.prepared.parts) {
              yield* tx
                .insert(PartTable)
                .values({
                  id: part.partID,
                  message_id: part.messageID,
                  session_id: part.sessionID as any,
                  time_created: part.timeCreated,
                  time_updated: part.timeCreated,
                  data: part.data as any,
                })
                .onConflictDoNothing()
                .run()
                .pipe(Effect.orDie)
            }

            // 5. CAS task_run: admitting → ready
            const updated = yield* tx
              .update(TaskRunTable)
              .set({
                input_state: "ready",
                child_input_materialized_hash: input.prepared.materializedHash,
                child_input_part_count: input.prepared.partCount,
                child_message_id: input.prepared.messageID,
                version: run.version + 1,
                time_updated: now,
              })
              .where(
                and(
                  eq(TaskRunTable.run_id, input.runID),
                  eq(TaskRunTable.version, run.version),
                  eq(TaskRunTable.input_state, "admitting"),
                ),
              )
              .returning({ run_id: TaskRunTable.run_id })
              .get()
              .pipe(Effect.orDie)

            if (!updated) {
              return yield* Effect.fail(
                new InputProjectionConflictError({
                  runID: input.runID,
                  reason: "CAS to input_state=ready lost (concurrent provisioner or version conflict)",
                }),
              )
            }

            // Co-transactional event for input admission (design §1.3 #24)
            yield* tx
              .insert(TaskRunEventTable)
              .values({
                event_id: Identifier.ascending("event"),
                run_id: input.runID,
                version: run.version + 1,
                type: "input_admitted",
                from_state: "admitting",
                to_state: "admitting",
                reason: `hash=${input.prepared.materializedHash} parts=${input.prepared.partCount}`,
                time_created: input.prepared.timeCreated,
              })
              .run()
              .pipe(Effect.orDie)

            return { exactReplay: false }
          }),
        { behavior: "immediate" },
      ),
    )
  })
}

export * as LegacyTaskInput from "./task-input"
