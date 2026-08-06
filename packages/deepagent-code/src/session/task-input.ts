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
 *   prepare(run, input)  — normalize the already prepared V1 envelope in memory; no writes
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
import { and, eq, inArray } from "drizzle-orm"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Identifier } from "@/id/id"
import type { Run } from "@/tool/task-run"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PreparedPart = {
  readonly partID: PartID
  readonly messageID: MessageID
  readonly sessionID: SessionID
  readonly type: string
  readonly data: unknown
  readonly timeCreated: number
}

export type PreparedMessageData = Omit<SessionV1.User, "id" | "sessionID">

export type PreparedTaskInput = {
  readonly messageID: MessageID
  readonly sessionID: SessionID
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
 * Build a PreparedTaskInput from a run's frozen execution spec and the envelope prepared by
 * SessionPrompt. This function performs no V1 writes and contacts no provider; reference, file,
 * image, and plugin preparation has already run in SessionPrompt.prepareTaskInput().
 * The fallback envelope is retained for historical rows and embedders without that API.
 *
 * B-1 (P0-2): messageData is constructed once here and used in BOTH the hash and the INSERT
 * in projectExact, eliminating the hash/content mismatch. The hash now covers only what
 * actually gets written to the DB (no extra time/agent/model fields).
 */
export function prepare(run: Run, envelope?: SessionV1.WithParts) {
  return Effect.sync(() => {
    const now = run.timeCreated
    const messageID = run.childMessageID ?? MessageID.ascending()
    const sessionID = run.childSessionID
    const promptText = run.executionSpec?.prompt?.text ?? ""
    if (envelope) {
      if (
        envelope.info.role !== "user" ||
        envelope.info.id !== messageID ||
        envelope.info.sessionID !== sessionID ||
        envelope.parts.some((part) => part.messageID !== messageID || part.sessionID !== sessionID)
      ) {
        throw new Error(`Prepared task input does not match the frozen child identity for run ${run.runID}`)
      }

      const messageData = { ...envelope.info } as Partial<SessionV1.User>
      delete messageData.id
      delete messageData.sessionID
      const parts = envelope.parts.map((part) => {
        const data = { ...part } as Partial<SessionV1.Part>
        delete data.id
        delete data.messageID
        delete data.sessionID
        return {
          partID: part.id,
          messageID,
          sessionID,
          type: part.type,
          data,
          timeCreated: now,
        } satisfies PreparedPart
      })
      const prepared = {
        messageID,
        sessionID,
        prompt: envelope.parts
          .filter((part): part is SessionV1.TextPart => part.type === "text" && part.synthetic !== true)
          .map((part) => part.text)
          .join("\n"),
        parts,
        materializedHash: materializedHash({
          messageID,
          sessionID,
          timeCreated: now,
          messageData,
          parts,
        }),
        partCount: parts.length,
        timeCreated: now,
        messageData: messageData as PreparedMessageData,
      } satisfies PreparedTaskInput
      return prepared
    }

    const agent = typeof run.executionSpec?.agent === "string" ? run.executionSpec.agent : "build"
    const modelCandidate = run.executionSpec?.model
    const model =
      modelCandidate &&
      typeof modelCandidate === "object" &&
      "providerID" in modelCandidate &&
      typeof modelCandidate.providerID === "string" &&
      "modelID" in modelCandidate &&
      typeof modelCandidate.modelID === "string"
        ? {
            providerID: modelCandidate.providerID,
            modelID: modelCandidate.modelID,
            ...("variant" in modelCandidate && typeof modelCandidate.variant === "string"
              ? { variant: modelCandidate.variant }
              : {}),
          }
        : { providerID: "task", modelID: "task" }
    const partID = PartID.ascending(`prt_task_${Hash.sha256(messageID).slice(0, 24)}`)
    const textPart: PreparedPart = {
      partID,
      messageID,
      sessionID,
      type: "text",
      data: { type: "text", text: promptText },
      timeCreated: now,
    }

    const messageData: PreparedMessageData = {
      role: "user" as const,
      time: { created: now },
      agent,
      model: {
        providerID: ProviderV2.ID.make(model.providerID),
        modelID: ModelV2.ID.make(model.modelID),
        ...(typeof model.variant === "string" ? { variant: model.variant } : {}),
      },
      ...(run.executionSpec?.tools ? { tools: run.executionSpec.tools } : {}),
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

    return {
      messageID,
      sessionID,
      prompt: promptText,
      parts: [textPart],
      materializedHash: materializedHash({
        messageID,
        sessionID,
        timeCreated: now,
        messageData,
        parts: [textPart],
      }),
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

            const verifyEnvelope = Effect.fnUntraced(function* () {
              const message = yield* tx
                .select()
                .from(MessageTable)
                .where(eq(MessageTable.id, input.prepared.messageID))
                .get()
                .pipe(Effect.orDie)
              const parts = yield* tx
                .select()
                .from(PartTable)
                .where(
                  inArray(
                    PartTable.id,
                    input.prepared.parts.map((part) => part.partID),
                  ),
                )
                .all()
                .pipe(Effect.orDie)
              if (!message || parts.length !== input.prepared.partCount) return false
              return (
                message.session_id === input.prepared.sessionID &&
                materializedHash({
                  messageID: message.id,
                  sessionID: message.session_id,
                  timeCreated: message.time_created,
                  messageData: message.data,
                  parts: parts
                    .map((part) => ({
                      partID: part.id,
                      messageID: part.message_id,
                      sessionID: part.session_id,
                      type:
                        typeof part.data === "object" && part.data && "type" in part.data
                          ? String(part.data.type)
                          : "unknown",
                      data: part.data,
                      timeCreated: part.time_created,
                    }))
                    .sort((a, b) => a.partID.localeCompare(b.partID)),
                }) === input.prepared.materializedHash
              )
            })

            // 2. Check for exact replay (already admitted)
            if (run.inputState === "ready") {
              if (
                run.existingHash === input.prepared.materializedHash &&
                run.existingCount === input.prepared.partCount &&
                (yield* verifyEnvelope())
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
            const now = input.prepared.timeCreated
            yield* tx
              .insert(MessageTable)
              .values({
                id: input.prepared.messageID,
                session_id: input.prepared.sessionID as any,
                time_created: now,
                time_updated: now,
                data: input.prepared.messageData,
              })
              .onConflictDoNothing()
              .run()
              .pipe(Effect.orDie)

            // 4. Insert all part rows
            yield* Effect.forEach(
              input.prepared.parts,
              (part) =>
                tx
                  .insert(PartTable)
                  .values({
                    id: part.partID,
                    message_id: part.messageID,
                    session_id: part.sessionID,
                    time_created: part.timeCreated,
                    time_updated: part.timeCreated,
                    data: part.data as typeof PartTable.$inferInsert.data,
                  })
                  .onConflictDoNothing()
                  .run()
                  .pipe(Effect.orDie),
              { discard: true },
            )

            if (!(yield* verifyEnvelope())) {
              return yield* Effect.fail(
                new InputProjectionConflictError({
                  runID: input.runID,
                  reason: "target message/part IDs already exist with a partial or conflicting envelope",
                }),
              )
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
    ).pipe(
      Effect.catchTag("LegacyTaskInput.InputProjectionConflict", (error) =>
        markProjectionConflict({
          runID: input.runID,
          expectedRunVersion: input.expectedRunVersion,
          reason: error.reason,
        }).pipe(Effect.andThen(Effect.fail(error))),
      ),
    )
  })
}

/** Verify a persisted ready receipt without rebuilding or replaying prompt preparation hooks. */
export function verifyPersisted(runID: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const run = yield* db
      .select({
        messageID: TaskRunTable.child_message_id,
        hash: TaskRunTable.child_input_materialized_hash,
        partCount: TaskRunTable.child_input_part_count,
        inputState: TaskRunTable.input_state,
      })
      .from(TaskRunTable)
      .where(eq(TaskRunTable.run_id, runID))
      .get()
      .pipe(Effect.orDie)
    if (
      !run ||
      run.inputState !== "ready" ||
      !run.messageID ||
      !run.hash ||
      run.partCount === null ||
      run.partCount < 1
    ) {
      return false
    }
    const message = yield* db
      .select()
      .from(MessageTable)
      .where(eq(MessageTable.id, run.messageID))
      .get()
      .pipe(Effect.orDie)
    if (!message) return false
    const parts = yield* db
      .select()
      .from(PartTable)
      .where(eq(PartTable.message_id, run.messageID))
      .all()
      .pipe(Effect.orDie)
    if (
      parts.length !== run.partCount ||
      parts.some((part) => part.message_id !== run.messageID || part.session_id !== message.session_id)
    ) {
      return false
    }
    return (
      materializedHash({
        messageID: message.id,
        sessionID: message.session_id,
        timeCreated: message.time_created,
        messageData: message.data,
        parts: parts
          .map((part) => ({
            partID: part.id,
            messageID: part.message_id,
            sessionID: part.session_id,
            type:
              typeof part.data === "object" && part.data && "type" in part.data ? String(part.data.type) : "unknown",
            data: part.data,
            timeCreated: part.time_created,
          }))
          .toSorted((a, b) => a.partID.localeCompare(b.partID)),
      }) === run.hash
    )
  })
}

function markProjectionConflict(input: {
  readonly runID: string
  readonly expectedRunVersion: number
  readonly reason: string
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = Date.now()
    return yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const updated = yield* tx
            .update(TaskRunTable)
            .set({
              state: "recovery_required",
              input_state: "conflict",
              reason: "input_projection_conflict",
              error: { code: "input_projection_conflict", message: input.reason },
              version: input.expectedRunVersion + 1,
              time_updated: now,
            })
            .where(
              and(
                eq(TaskRunTable.run_id, input.runID),
                eq(TaskRunTable.version, input.expectedRunVersion),
                eq(TaskRunTable.state, "admitted"),
                inArray(TaskRunTable.input_state, ["admitting", "ready"]),
              ),
            )
            .returning({ version: TaskRunTable.version })
            .get()
            .pipe(Effect.orDie)
          if (!updated) return false

          yield* tx
            .insert(TaskRunEventTable)
            .values({
              event_id: Identifier.ascending("event"),
              run_id: input.runID,
              version: updated.version,
              type: "input_projection_conflict",
              from_state: "admitted",
              to_state: "recovery_required",
              reason: input.reason,
              time_created: now,
            })
            .run()
            .pipe(Effect.orDie)
          return true
        }),
      { behavior: "immediate" },
    )
  })
}

function materializedHash(input: {
  readonly messageID: string
  readonly sessionID: string
  readonly timeCreated: number
  readonly messageData: unknown
  readonly parts: ReadonlyArray<{
    readonly partID: string
    readonly messageID: string
    readonly sessionID: string
    readonly type: string
    readonly data: unknown
    readonly timeCreated: number
  }>
}) {
  return Hash.sha256(JSON.stringify(input))
}

export * as LegacyTaskInput from "./task-input"
