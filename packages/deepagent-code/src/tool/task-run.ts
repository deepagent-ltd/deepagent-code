import { Database } from "@deepagent-code/core/database/database"
import {
  TaskAdmissionTable,
  TaskNotificationOutboxTable,
  TaskRunTable,
  SessionTable,
} from "@deepagent-code/core/session/sql"
import { and, asc, eq, gt, inArray, isNull, lte, max, or, sql } from "drizzle-orm"
import { Cause, Data, Effect } from "effect"
import { Identifier } from "@/id/id"
import { MessageID, SessionID } from "@/session/schema"
import { Hash } from "@deepagent-code/core/util/hash"

export type State =
  | "admitted"
  | "provisioning"
  | "researching"
  | "finalizing"
  | "completed"
  | "error"
  | "cancelled"
  | "interrupted"
export type Phase = "admission" | "research" | "finalize" | "settled"
export type DeliveryMode = "foreground" | "background"
export type ErrorData = { code: string; message: string; data?: Record<string, unknown> }
export type NotificationPayload = { agent: string; variant?: string; text: string }

export type Run = {
  runID: string
  rootRunID?: string
  requestHash: string
  parentSessionID: SessionID
  parentMessageID: MessageID
  toolCallID: string
  childSessionID: SessionID
  generation: number
  deliveryMode: DeliveryMode
  phase: Phase
  state: State
  reason?: string
  attempts: number
  executionOwner?: string
  leaseExpiresAt?: number
  rawResultMessageID?: MessageID
  structuredResultMessageID?: MessageID
  output?: string
  error?: ErrorData
  timeCreated: number
  timeUpdated: number
  timeSettled?: number
}

export type Admission = {
  run: Run
  exactRetry: boolean
  runCreated: boolean
}

export type OutboxItem = {
  id: string
  runID: string
  messageID: MessageID
  parentSessionID: SessionID
  directory: string
  payload: NotificationPayload
  attempts: number
}

export class AdmissionConflict extends Data.TaggedError("TaskRun.AdmissionConflict")<{
  readonly admissionKey: string
  readonly reason: "request" | "delivery" | "child" | "join"
}> {}

class ConcurrentAdmission extends Data.TaggedError("TaskRun.ConcurrentAdmission")<{
  readonly admissionKey: string
}> {}

const terminalStates: ReadonlyArray<State> = ["completed", "error", "cancelled", "interrupted"]
const activeStates: ReadonlyArray<State> = ["admitted", "provisioning", "researching", "finalizing"]

const canonicalJson = (value: unknown): string => {
  if (value === null) return "null"
  if (value === undefined) return '"__undefined__"'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value !== "object") return JSON.stringify(value) ?? "null"
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`
}

export const requestHash = (value: unknown) => Hash.sha256(canonicalJson(value))

const fromRow = (row: typeof TaskRunTable.$inferSelect): Run => ({
  runID: row.run_id,
  rootRunID: row.root_run_id ?? undefined,
  requestHash: row.request_hash,
  parentSessionID: SessionID.make(row.parent_session_id),
  parentMessageID: MessageID.ascending(row.parent_message_id),
  toolCallID: row.tool_call_id,
  childSessionID: SessionID.make(row.child_session_id),
  generation: row.generation,
  deliveryMode: row.delivery_mode,
  phase: row.phase,
  state: row.state,
  reason: row.reason ?? undefined,
  attempts: row.attempts,
  executionOwner: row.execution_owner ?? undefined,
  leaseExpiresAt: row.lease_expires_at ?? undefined,
  rawResultMessageID: row.raw_result_message_id ?? undefined,
  structuredResultMessageID: row.structured_result_message_id ?? undefined,
  output: row.output ?? undefined,
  error: row.error ?? undefined,
  timeCreated: row.time_created,
  timeUpdated: row.time_updated,
  timeSettled: row.time_settled ?? undefined,
})

const admissionKey = (input: { parentSessionID: SessionID; parentMessageID: MessageID; toolCallID: string }) =>
  `${input.parentSessionID}\u0000${input.parentMessageID}\u0000${input.toolCallID}`

export function admitTaskRun(input: {
  parentSessionID: SessionID
  parentMessageID: MessageID
  toolCallID: string
  childSessionID?: SessionID
  joinRunID?: string
  request: unknown
  deliveryMode: DeliveryMode
  now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const key = admissionKey(input)
    const hash = requestHash(input.request)
    const childSessionID = input.childSessionID ?? SessionID.create()
    const now = input.now ?? Date.now()
    const transact = () =>
      db.transaction((tx) =>
        Effect.gen(function* () {
          const existingAdmission = yield* tx
            .select()
            .from(TaskAdmissionTable)
            .where(eq(TaskAdmissionTable.admission_key, key))
            .get()
            .pipe(Effect.orDie)
          if (existingAdmission) {
            if (existingAdmission.request_hash !== hash)
              return yield* Effect.fail(new AdmissionConflict({ admissionKey: key, reason: "request" }))
            if (existingAdmission.delivery_mode !== input.deliveryMode)
              return yield* Effect.fail(new AdmissionConflict({ admissionKey: key, reason: "delivery" }))
            const run = yield* tx
              .select()
              .from(TaskRunTable)
              .where(eq(TaskRunTable.run_id, existingAdmission.run_id))
              .get()
              .pipe(Effect.orDie)
            if (!run) return yield* Effect.die(`Task admission ${key} references a missing run`)
            if (input.childSessionID !== undefined && run.child_session_id !== input.childSessionID)
              return yield* Effect.fail(new AdmissionConflict({ admissionKey: key, reason: "child" }))
            return { run: fromRow(run), exactRetry: true, runCreated: false } satisfies Admission
          }

          const joined = input.joinRunID
            ? yield* tx
                .select()
                .from(TaskRunTable)
                .where(
                  and(
                    eq(TaskRunTable.run_id, input.joinRunID),
                    eq(TaskRunTable.child_session_id, childSessionID),
                    inArray(TaskRunTable.state, ["researching", "finalizing"]),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
            : undefined
          if (input.joinRunID && !joined)
            return yield* Effect.fail(new AdmissionConflict({ admissionKey: key, reason: "join" }))

          const conflictingActive =
            !joined && input.childSessionID
              ? yield* tx
                  .select({ run_id: TaskRunTable.run_id })
                  .from(TaskRunTable)
                  .where(
                    and(
                      eq(TaskRunTable.child_session_id, input.childSessionID),
                      inArray(TaskRunTable.state, [...activeStates]),
                    ),
                  )
                  .get()
                  .pipe(Effect.orDie)
              : undefined
          if (conflictingActive) return yield* Effect.fail(new AdmissionConflict({ admissionKey: key, reason: "join" }))

          const insertedRun = joined
            ? undefined
            : yield* Effect.gen(function* () {
                for (let retry = 0; retry < 4; retry++) {
                  const latest = yield* tx
                    .select({ generation: max(TaskRunTable.generation) })
                    .from(TaskRunTable)
                    .where(eq(TaskRunTable.child_session_id, childSessionID))
                    .get()
                    .pipe(Effect.orDie)
                  const runID = Identifier.ascending("job")
                  const inserted = yield* tx
                    .insert(TaskRunTable)
                    .values({
                      run_id: runID,
                      root_run_id: runID,
                      request_hash: hash,
                      parent_session_id: input.parentSessionID,
                      parent_message_id: input.parentMessageID,
                      tool_call_id: input.toolCallID,
                      child_session_id: childSessionID,
                      generation: (latest?.generation ?? 0) + 1,
                      delivery_mode: input.deliveryMode,
                      phase: "admission",
                      state: "admitted",
                      time_created: now,
                      time_updated: now,
                    })
                    .onConflictDoNothing()
                    .returning()
                    .get()
                    .pipe(Effect.orDie)
                  if (inserted) return inserted
                }
                return yield* Effect.die("TaskRun.admit could not allocate a unique child generation")
              })
          const run = joined ?? insertedRun
          if (!run) return yield* Effect.die("TaskRun.admit did not resolve a run")
          const insertedAdmission = yield* tx
            .insert(TaskAdmissionTable)
            .values({
              admission_key: key,
              request_hash: hash,
              run_id: run.run_id,
              parent_session_id: input.parentSessionID,
              parent_message_id: input.parentMessageID,
              tool_call_id: input.toolCallID,
              delivery_mode: input.deliveryMode,
              time_created: now,
            })
            .onConflictDoNothing()
            .returning()
            .get()
            .pipe(Effect.orDie)
          if (!insertedAdmission) return yield* Effect.fail(new ConcurrentAdmission({ admissionKey: key }))
          return { run: fromRow(run), exactRetry: false, runCreated: insertedRun !== undefined } satisfies Admission
        }),
      )
    const attempt = (remaining: number): Effect.Effect<Admission, AdmissionConflict> =>
      transact().pipe(
        Effect.catchTag("SqlError", Effect.die),
        Effect.catchTag("TaskRun.ConcurrentAdmission", () =>
          remaining > 0
            ? attempt(remaining - 1)
            : Effect.die(`Task admission ${key} remained contended after bounded retries`),
        ),
      )
    return yield* attempt(4)
  })
}

export function spawnTaskTakeover(input: { root: Run; childSessionID: SessionID; now?: number }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    return yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const latest = yield* tx
          .select({ generation: max(TaskRunTable.generation) })
          .from(TaskRunTable)
          .where(eq(TaskRunTable.child_session_id, input.childSessionID))
          .get()
          .pipe(Effect.orDie)
        const runID = Identifier.ascending("job")
        const inserted = yield* tx
          .insert(TaskRunTable)
          .values({
            run_id: runID,
            root_run_id: input.root.rootRunID ?? input.root.runID,
            request_hash: input.root.requestHash,
            parent_session_id: input.root.parentSessionID,
            parent_message_id: input.root.parentMessageID,
            tool_call_id: `${input.root.toolCallID}:takeover:${runID}`,
            child_session_id: input.childSessionID,
            generation: (latest?.generation ?? 0) + 1,
            delivery_mode: input.root.deliveryMode,
            phase: "admission",
            state: "admitted",
            time_created: now,
            time_updated: now,
          })
          .returning()
          .get()
          .pipe(Effect.orDie)
        return fromRow(inserted)
      }),
    )
  })
}

export function claimTaskProvisioning(input: { run: Run; owner: string; now?: number; leaseMs?: number }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    const updated = yield* db
      .update(TaskRunTable)
      .set({
        state: "provisioning",
        execution_owner: input.owner,
        lease_expires_at: now + (input.leaseMs ?? 30_000),
        time_updated: now,
      })
      .where(
        and(
          eq(TaskRunTable.run_id, input.run.runID),
          eq(TaskRunTable.generation, input.run.generation),
          or(
            eq(TaskRunTable.state, "admitted"),
            and(
              eq(TaskRunTable.state, "provisioning"),
              or(eq(TaskRunTable.execution_owner, input.owner), lte(TaskRunTable.lease_expires_at, now)),
            ),
          ),
        ),
      )
      .returning()
      .get()
      .pipe(Effect.orDie)
    return updated ? fromRow(updated) : undefined
  })
}

export function startTaskRun(run: Run, owner: string, now = Date.now(), leaseMs = 30_000) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const updated = yield* db
      .update(TaskRunTable)
      .set({
        phase: "research",
        state: "researching",
        execution_owner: owner,
        lease_expires_at: now + leaseMs,
        time_updated: now,
      })
      .where(
        and(
          eq(TaskRunTable.run_id, run.runID),
          eq(TaskRunTable.generation, run.generation),
          eq(TaskRunTable.state, "provisioning"),
          eq(TaskRunTable.execution_owner, owner),
          gt(TaskRunTable.lease_expires_at, now),
        ),
      )
      .returning()
      .get()
      .pipe(Effect.orDie)
    return updated ? fromRow(updated) : undefined
  })
}

export function renewTaskRunLease(input: { run: Run; owner: string; now?: number; leaseMs?: number }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    const updated = yield* db
      .update(TaskRunTable)
      .set({
        lease_expires_at: now + (input.leaseMs ?? 30_000),
        time_updated: now,
      })
      .where(
        and(
          eq(TaskRunTable.run_id, input.run.runID),
          eq(TaskRunTable.generation, input.run.generation),
          eq(TaskRunTable.execution_owner, input.owner),
          inArray(TaskRunTable.state, ["provisioning", "researching", "finalizing"]),
          gt(TaskRunTable.lease_expires_at, now),
        ),
      )
      .returning({ run_id: TaskRunTable.run_id })
      .get()
      .pipe(Effect.orDie)
    return updated !== undefined
  })
}

export function recoverExpiredTaskRuns(input: { directory: string; now?: number; nullLeaseGraceMs?: number }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    const nullLeaseBefore = now - (input.nullLeaseGraceMs ?? 30_000)
    return yield* Effect.uninterruptible(
      db.transaction((tx) =>
        Effect.gen(function* () {
          const candidates = yield* tx
            .select({ run: TaskRunTable, agent: SessionTable.agent })
            .from(TaskRunTable)
            .innerJoin(SessionTable, eq(SessionTable.id, TaskRunTable.parent_session_id))
            .where(
              and(
                eq(SessionTable.directory, input.directory),
                inArray(TaskRunTable.state, ["provisioning", "researching", "finalizing"]),
                or(
                  lte(TaskRunTable.lease_expires_at, now),
                  and(isNull(TaskRunTable.lease_expires_at), lte(TaskRunTable.time_updated, nullLeaseBefore)),
                ),
              ),
            )
            .all()
            .pipe(Effect.orDie)
          return yield* Effect.forEach(
            candidates,
            (candidate) =>
              Effect.gen(function* () {
                const updated = yield* tx
                  .update(TaskRunTable)
                  .set({
                    phase: "settled",
                    state: "error",
                    reason: "execution_lease_expired",
                    error: {
                      code: "execution_lease_expired",
                      message: "The task execution lease expired before the run reached a durable terminal state.",
                    },
                    execution_owner: null,
                    lease_expires_at: null,
                    time_updated: now,
                    time_settled: now,
                  })
                  .where(
                    and(
                      eq(TaskRunTable.run_id, candidate.run.run_id),
                      eq(TaskRunTable.generation, candidate.run.generation),
                      inArray(TaskRunTable.state, ["provisioning", "researching", "finalizing"]),
                      or(
                        lte(TaskRunTable.lease_expires_at, now),
                        and(isNull(TaskRunTable.lease_expires_at), lte(TaskRunTable.time_updated, nullLeaseBefore)),
                      ),
                    ),
                  )
                  .returning()
                  .get()
                  .pipe(Effect.orDie)
                if (!updated) return undefined
                yield* tx
                  .insert(TaskNotificationOutboxTable)
                  .values({
                    id: `task-notify:${updated.run_id}`,
                    run_id: updated.run_id,
                    message_id: MessageID.ascending(),
                    parent_session_id: updated.parent_session_id,
                    directory: input.directory,
                    payload: {
                      agent: candidate.agent ?? "build",
                      text:
                        candidate.run.state === "provisioning"
                          ? [
                              "A subagent stopped while its durable child session was being provisioned.",
                              "No provider work will be resumed automatically. Retry with a new task request; the original tool call remains terminal.",
                            ].join("\n")
                          : [
                              "A subagent stopped because its execution lease expired before a durable result was recorded.",
                              `Partial work is preserved; call task_read({ task_id: "${updated.child_session_id}" }) before retrying.`,
                            ].join("\n"),
                    },
                    status: "pending",
                    attempts: 0,
                    available_at: now,
                    time_created: now,
                    time_updated: now,
                  })
                  .onConflictDoNothing()
                  .run()
                  .pipe(Effect.orDie)
                return fromRow(updated)
              }),
            { concurrency: 1 },
          ).pipe(Effect.map((runs) => runs.filter((run): run is Run => run !== undefined)))
        }),
      ),
    )
  })
}

export function markTaskResearchCompleted(run: Run, owner: string, rawResultMessageID: MessageID, now = Date.now()) {
  return updateActive(
    run,
    owner,
    { raw_result_message_id: rawResultMessageID, time_updated: now },
    ["researching"],
    now,
  )
}

export function markTaskFinalizing(
  run: Run,
  owner: string,
  attempt: number,
  rawResultMessageID: MessageID,
  now = Date.now(),
) {
  return updateActive(
    run,
    owner,
    {
      phase: "finalize",
      state: "finalizing",
      attempts: attempt,
      raw_result_message_id: rawResultMessageID,
      time_updated: now,
    },
    ["researching", "finalizing"],
    now,
  )
}

export function markTaskFinalized(run: Run, owner: string, structuredResultMessageID: MessageID, now = Date.now()) {
  return updateActive(
    run,
    owner,
    { structured_result_message_id: structuredResultMessageID, time_updated: now },
    ["finalizing"],
    now,
  )
}

function updateActive(
  run: Run,
  owner: string,
  values: Partial<typeof TaskRunTable.$inferInsert>,
  states: State[],
  now: number,
) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const updated = yield* db
      .update(TaskRunTable)
      .set(values)
      .where(
        and(
          eq(TaskRunTable.run_id, run.runID),
          eq(TaskRunTable.generation, run.generation),
          eq(TaskRunTable.execution_owner, owner),
          inArray(TaskRunTable.state, states),
          gt(TaskRunTable.lease_expires_at, now),
        ),
      )
      .returning()
      .get()
      .pipe(Effect.orDie)
    return updated ? fromRow(updated) : undefined
  })
}

export function settleTaskRun(input: {
  run: Run
  owner: string
  state: Extract<State, "completed" | "error" | "cancelled" | "interrupted">
  reason: string
  output?: string
  error?: ErrorData
  structuredResultMessageID?: MessageID
  notification?: { directory: string; payload: NotificationPayload }
  now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    return yield* Effect.uninterruptible(
      db.transaction((tx) =>
        Effect.gen(function* () {
          const updated = yield* tx
            .update(TaskRunTable)
            .set({
              phase: "settled",
              state: input.state,
              reason: input.reason,
              output: input.output,
              error: input.error,
              structured_result_message_id: input.structuredResultMessageID,
              execution_owner: null,
              lease_expires_at: null,
              time_updated: now,
              time_settled: now,
            })
            .where(
              and(
                eq(TaskRunTable.run_id, input.run.runID),
                eq(TaskRunTable.generation, input.run.generation),
                eq(TaskRunTable.execution_owner, input.owner),
                inArray(TaskRunTable.state, [...activeStates]),
                gt(TaskRunTable.lease_expires_at, now),
              ),
            )
            .returning()
            .get()
            .pipe(Effect.orDie)
          if (!updated) {
            const existing = yield* tx
              .select()
              .from(TaskRunTable)
              .where(eq(TaskRunTable.run_id, input.run.runID))
              .get()
              .pipe(Effect.orDie)
            return { won: false as const, run: existing ? fromRow(existing) : input.run }
          }
          if (input.notification) {
            yield* tx
              .insert(TaskNotificationOutboxTable)
              .values({
                id: `task-notify:${input.run.runID}`,
                run_id: input.run.runID,
                message_id: MessageID.ascending(),
                parent_session_id: input.run.parentSessionID,
                directory: input.notification.directory,
                payload: input.notification.payload,
                status: "pending",
                attempts: 0,
                available_at: now,
                time_created: now,
                time_updated: now,
              })
              .onConflictDoNothing()
              .run()
              .pipe(Effect.orDie)
          }
          return { won: true as const, run: fromRow(updated) }
        }),
      ),
    )
  })
}

export function getTaskRunByAdmission(input: {
  parentSessionID: SessionID
  parentMessageID: MessageID
  toolCallID: string
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db
      .select({ run: TaskRunTable })
      .from(TaskAdmissionTable)
      .innerJoin(TaskRunTable, eq(TaskRunTable.run_id, TaskAdmissionTable.run_id))
      .where(eq(TaskAdmissionTable.admission_key, admissionKey(input)))
      .get()
      .pipe(Effect.orDie)
    return row ? fromRow(row.run) : undefined
  })
}

export function getActiveTaskRunByChild(childSessionID: SessionID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db
      .select()
      .from(TaskRunTable)
      .where(and(eq(TaskRunTable.child_session_id, childSessionID), inArray(TaskRunTable.state, [...activeStates])))
      .get()
      .pipe(Effect.orDie)
    return row ? fromRow(row) : undefined
  })
}

export function getTaskRun(runID: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db.select().from(TaskRunTable).where(eq(TaskRunTable.run_id, runID)).get().pipe(Effect.orDie)
    return row ? fromRow(row) : undefined
  })
}

export function claimTaskNotifications(input: {
  owner: string
  directory: string
  now?: number
  leaseMs?: number
  limit?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    const leaseUntil = now + (input.leaseMs ?? 30_000)
    return yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const candidates = yield* tx
          .select({ id: TaskNotificationOutboxTable.id })
          .from(TaskNotificationOutboxTable)
          .where(
            and(
              eq(TaskNotificationOutboxTable.directory, input.directory),
              lte(TaskNotificationOutboxTable.available_at, now),
              or(
                eq(TaskNotificationOutboxTable.status, "pending"),
                and(
                  eq(TaskNotificationOutboxTable.status, "delivering"),
                  or(
                    isNull(TaskNotificationOutboxTable.lease_expires_at),
                    lte(TaskNotificationOutboxTable.lease_expires_at, now),
                  ),
                ),
              ),
            ),
          )
          .orderBy(asc(TaskNotificationOutboxTable.available_at), asc(TaskNotificationOutboxTable.id))
          .limit(input.limit ?? 20)
          .all()
          .pipe(Effect.orDie)
        const claimed: OutboxItem[] = []
        for (const candidate of candidates) {
          const row = yield* tx
            .update(TaskNotificationOutboxTable)
            .set({
              status: "delivering",
              lease_owner: input.owner,
              lease_expires_at: leaseUntil,
              attempts: sql`${TaskNotificationOutboxTable.attempts} + 1`,
              time_updated: now,
            })
            .where(
              and(
                eq(TaskNotificationOutboxTable.id, candidate.id),
                eq(TaskNotificationOutboxTable.directory, input.directory),
                or(
                  eq(TaskNotificationOutboxTable.status, "pending"),
                  and(
                    eq(TaskNotificationOutboxTable.status, "delivering"),
                    or(
                      isNull(TaskNotificationOutboxTable.lease_expires_at),
                      lte(TaskNotificationOutboxTable.lease_expires_at, now),
                    ),
                  ),
                ),
              ),
            )
            .returning()
            .get()
            .pipe(Effect.orDie)
          if (!row) continue
          claimed.push({
            id: row.id,
            runID: row.run_id,
            messageID: MessageID.ascending(row.message_id),
            parentSessionID: SessionID.make(row.parent_session_id),
            directory: row.directory,
            payload: row.payload,
            attempts: row.attempts,
          })
        }
        return claimed
      }),
    )
  })
}

export function acknowledgeTaskNotification(input: { id: string; owner: string; attempts: number; now?: number }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    const updated = yield* db
      .update(TaskNotificationOutboxTable)
      .set({
        status: "delivered",
        lease_owner: null,
        lease_expires_at: null,
        last_error: null,
        time_updated: now,
        time_delivered: now,
      })
      .where(
        and(
          eq(TaskNotificationOutboxTable.id, input.id),
          eq(TaskNotificationOutboxTable.status, "delivering"),
          eq(TaskNotificationOutboxTable.lease_owner, input.owner),
          eq(TaskNotificationOutboxTable.attempts, input.attempts),
        ),
      )
      .returning({ id: TaskNotificationOutboxTable.id })
      .get()
      .pipe(Effect.orDie)
    return updated !== undefined
  })
}

export function rejectTaskNotification(input: {
  id: string
  owner: string
  attempts: number
  error: string
  now?: number
  maxAttempts?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    const dead = input.attempts >= (input.maxAttempts ?? 10)
    const delay = Math.min(300_000, 1_000 * 2 ** Math.max(0, input.attempts - 1))
    const updated = yield* db
      .update(TaskNotificationOutboxTable)
      .set({
        status: dead ? "dead" : "pending",
        available_at: dead ? now : now + delay,
        lease_owner: null,
        lease_expires_at: null,
        last_error: input.error.slice(0, 4_000),
        time_updated: now,
      })
      .where(
        and(
          eq(TaskNotificationOutboxTable.id, input.id),
          eq(TaskNotificationOutboxTable.status, "delivering"),
          eq(TaskNotificationOutboxTable.lease_owner, input.owner),
          eq(TaskNotificationOutboxTable.attempts, input.attempts),
        ),
      )
      .returning({ id: TaskNotificationOutboxTable.id })
      .get()
      .pipe(Effect.orDie)
    return updated ? dead : undefined
  })
}

export function deliverTaskNotifications(input: {
  owner: string
  directory: string
  deliver: (item: OutboxItem) => Effect.Effect<void, unknown>
  now?: () => number
  leaseMs?: number
  limit?: number
  maxAttempts?: number
}) {
  return Effect.gen(function* () {
    const items = yield* claimTaskNotifications({
      owner: input.owner,
      directory: input.directory,
      now: input.now?.(),
      leaseMs: input.leaseMs,
      limit: input.limit,
    })
    return yield* Effect.forEach(
      items,
      (item) =>
        input.deliver(item).pipe(
          Effect.flatMap(() =>
            acknowledgeTaskNotification({
              id: item.id,
              owner: input.owner,
              attempts: item.attempts,
              now: input.now?.(),
            }).pipe(
              Effect.tap((acknowledged) =>
                Effect.logInfo("subagent.notification.delivered").pipe(
                  Effect.annotateLogs({
                    run_id: item.runID,
                    outbox_id: item.id,
                    parent_session_id: item.parentSessionID,
                    acknowledged,
                  }),
                ),
              ),
            ),
          ),
          Effect.catchCause((cause) =>
            rejectTaskNotification({
              id: item.id,
              owner: input.owner,
              attempts: item.attempts,
              error: Cause.pretty(cause),
              now: input.now?.(),
              maxAttempts: input.maxAttempts,
            }).pipe(
              Effect.tap((dead) =>
                Effect.logWarning("subagent.notification.failed").pipe(
                  Effect.annotateLogs({
                    run_id: item.runID,
                    outbox_id: item.id,
                    parent_session_id: item.parentSessionID,
                    attempts: item.attempts,
                    dead: dead === true,
                  }),
                ),
              ),
              Effect.as(false),
            ),
          ),
        ),
      { concurrency: 1 },
    )
  })
}

export const isTerminal = (run: Run) => terminalStates.includes(run.state)
