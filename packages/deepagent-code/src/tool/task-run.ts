import { Database } from "@deepagent-code/core/database/database"
import {
  TaskAdmissionTable,
  TaskNotificationOutboxTable,
  TaskRunEventTable,
  TaskRunTable,
  SessionTable,
} from "@deepagent-code/core/session/sql"
import { and, asc, desc, eq, gt, inArray, isNull, lte, max, ne, or, sql } from "drizzle-orm"
import { Cause, Data, Effect } from "effect"
import { Identifier } from "@/id/id"
import { MessageID, SessionID } from "@/session/schema"
import { Hash } from "@deepagent-code/core/util/hash"
import type { PermissionV1 } from "@deepagent-code/core/v1/permission"

export type State =
  | "admitted"
  | "provisioning"
  | "researching"
  | "finalizing"
  | "completed"
  | "error"
  | "cancelled"
  | "interrupted"
  | "queued"
  | "running"
  | "failed"
  | "closed"
  | "recovery_required"
export type Phase = "admission" | "research" | "finalize" | "settled" | "queue" | "provision"
export type DeliveryMode = "foreground" | "background"
export type ErrorData = { code: string; message: string; data?: Record<string, unknown> }
export type NotificationPayload = { agent: string; variant?: string; text: string }

export type ControlState = "open" | "close_requested" | "closed"
export type OriginKind = "task_tool" | "goal_role"
export type InputState = "pending" | "admitting" | "ready" | "conflict" | "outcome_unknown" | "legacy"
export type MutationCapability = "read_only" | "write"
export type WorkspaceMode = "shared" | "worktree"
export type WorkspaceOwner = "parent" | "run" | "caller" | "goal"

export type Run = {
  runID: string
  rootRunID?: string
  parentRunID?: string
  continuationOfRunID?: string
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
  // L1 new fields (all optional for backward compat with pre-migration rows)
  version: number
  controlState: ControlState
  originKind: OriginKind
  originKey?: string
  depth: number
  mutationCapability: MutationCapability
  toolCapabilityHash: string
  workspaceMode: WorkspaceMode
  workspaceOwner: WorkspaceOwner
  inputState: InputState
  startAttempts: number
  claimGeneration: number
  availableAt: number
  // L3d: child input admission
  childMessageID?: MessageID
  executionSpec?: {
    readonly prompt?: { readonly text?: string }
    readonly agent?: string
    readonly model?: {
      readonly providerID: string
      readonly modelID: string
      readonly variant?: string
    }
    readonly tools?: Record<string, boolean>
    readonly permission?: PermissionV1.Ruleset
    readonly [key: string]: unknown
  } | null
}

export type RunEvent = {
  eventId: string
  runId: string
  version: number
  type: string
  fromState?: string
  toState?: string
  reason?: string
  data?: unknown
  timeCreated: number
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
  readonly reason: "request" | "delivery" | "child" | "join" | "ancestor_closed"
}> {}

class ConcurrentAdmission extends Data.TaggedError("TaskRun.ConcurrentAdmission")<{
  readonly admissionKey: string
}> {}

// terminalStates: states where no further execution can occur and the run is durably settled
const terminalStates: ReadonlyArray<State> = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "closed",
  "error", // legacy vocabulary — kept for backward-compat queries against pre-L1 rows
]
// C-5 (P1-7): recovery_required is NOT terminal — it is a quiescent nonterminal state that
// can only be resolved by explicit user/host action (continue/accept/cancel).
// Foreground polls must not treat it as a settled result.
const quiescentStates: ReadonlyArray<State> = ["recovery_required"]
// activeStates: states where a run may be executing or waiting to execute
const activeStates: ReadonlyArray<State> = [
  "admitted",
  "queued",
  "provisioning",
  "running",
  "researching",
  "finalizing",
]

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
  parentRunID: row.parent_run_id ?? undefined,
  continuationOfRunID: row.continuation_of_run_id ?? undefined,
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
  // L1 fields with safe fallbacks for pre-migration rows
  version: row.version ?? 0,
  controlState: (row.control_state as ControlState | null) ?? "open",
  originKind: (row.origin_kind as OriginKind | null) ?? "task_tool",
  originKey: row.origin_key ?? undefined,
  depth: row.depth ?? 1,
  mutationCapability: (row.mutation_capability as MutationCapability | null) ?? "write",
  toolCapabilityHash: row.tool_capability_hash ?? "legacy-unknown",
  workspaceMode: (row.workspace_mode as WorkspaceMode | null) ?? "shared",
  workspaceOwner: (row.workspace_owner as WorkspaceOwner | null) ?? "parent",
  inputState: (row.input_state as InputState | null) ?? "legacy",
  startAttempts: row.start_attempts ?? 0,
  claimGeneration: row.claim_generation ?? 0,
  availableAt: row.available_at ?? 0,
  childMessageID: row.child_message_id ? MessageID.ascending(row.child_message_id) : undefined,
  // L3d: parse execution_spec JSON (drizzle mode:"json" auto-parses on read)
  executionSpec: row.execution_spec ? (row.execution_spec as Run["executionSpec"]) : undefined,
})

const admissionKey = (input: { parentSessionID: SessionID; parentMessageID: MessageID; toolCallID: string }) =>
  `${input.parentSessionID}\u0000${input.parentMessageID}\u0000${input.toolCallID}`

export function admitTaskRun(input: {
  parentSessionID: SessionID
  parentMessageID: MessageID
  toolCallID: string
  childSessionID?: SessionID
  joinRunID?: string
  // P0-8: causal run graph — the run_id of the parent session's currently-active task run.
  // When provided the new run is linked as a child; ancestor-open check is enforced.
  parentRunID?: string
  request: unknown
  deliveryMode: DeliveryMode
  mutationCapability?: MutationCapability
  toolCapabilityHash?: string
  now?: number
  // L3d: frozen execution specification written once at admit time; consumed by prepare()
  executionSpec?: unknown
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
                    inArray(TaskRunTable.state, ["researching", "running", "finalizing"]),
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

          // P0-8: ancestor-open check + causal graph resolution.
          // When the parent session is itself a subagent run (depth > 1), parentRunID identifies its
          // active task_run. We must refuse admission if the ancestor is already closed/terminal,
          // and we must propagate the real root_run_id down the chain (invariant 16).
          let resolvedRootRunID: string | undefined
          if (input.parentRunID) {
            const parentRun = yield* tx
              .select({
                run_id: TaskRunTable.run_id,
                root_run_id: TaskRunTable.root_run_id,
                control_state: TaskRunTable.control_state,
                state: TaskRunTable.state,
              })
              .from(TaskRunTable)
              .where(eq(TaskRunTable.run_id, input.parentRunID))
              .get()
              .pipe(Effect.orDie)

            if (!parentRun)
              return yield* Effect.fail(new AdmissionConflict({ admissionKey: key, reason: "ancestor_closed" }))

            const parentIsTerminal = (terminalStates as ReadonlyArray<string>).includes(parentRun.state)
            const parentIsClosed = parentRun.control_state === "closed"
            if (parentIsTerminal || parentIsClosed)
              return yield* Effect.fail(new AdmissionConflict({ admissionKey: key, reason: "ancestor_closed" }))

            // Propagate root: if the parent itself has a root, use it; otherwise the parent IS the root.
            resolvedRootRunID = parentRun.root_run_id ?? input.parentRunID
          }

          const insertedRun = joined
            ? undefined
            : yield* Effect.gen(function* () {
                for (let retry = 0; retry < 4; retry++) {
                  // P1-6: fetch both max generation AND the run_id of the latest run so we can write
                  // continuation_of_run_id for reruns of the same child session (§1.3 #8).
                  const latest = yield* tx
                    .select({ generation: TaskRunTable.generation, run_id: TaskRunTable.run_id })
                    .from(TaskRunTable)
                    .where(eq(TaskRunTable.child_session_id, childSessionID))
                    .orderBy(desc(TaskRunTable.generation))
                    .get()
                    .pipe(Effect.orDie)
                  const runID = Identifier.ascending("job")
                  const newGeneration = (latest?.generation ?? 0) + 1
                  // P0-8: root_run_id — if this run has a parent ancestor chain use the resolved root;
                  // otherwise this run IS the root (depth=1, no parentRunID supplied).
                  const rootRunID = resolvedRootRunID ?? runID
                  // P1-6: continuation_of_run_id — only set when re-running an existing child session
                  const continuationOfRunID = latest?.run_id ?? null
                  const inserted = yield* tx
                    .insert(TaskRunTable)
                    .values({
                      run_id: runID,
                      root_run_id: rootRunID,
                      // P0-8: parent_run_id links this run to its direct parent in the task tree
                      parent_run_id: input.parentRunID ?? null,
                      // P1-6: continuation_of_run_id links sequential reruns of the same child session
                      continuation_of_run_id: newGeneration > 1 ? continuationOfRunID : null,
                      request_hash: hash,
                      parent_session_id: input.parentSessionID,
                      parent_message_id: input.parentMessageID,
                      tool_call_id: input.toolCallID,
                      child_session_id: childSessionID,
                      child_message_id: MessageID.ascending(),
                      generation: newGeneration,
                      delivery_mode: input.deliveryMode,
                      mutation_capability: input.mutationCapability ?? "write",
                      tool_capability_hash: input.toolCapabilityHash ?? "legacy-unknown",
                      phase: "admission",
                      state: "admitted",
                      // L3d: freeze the execution spec at admit time so prepare() can read it
                      execution_spec:
                        input.executionSpec !== undefined ? (input.executionSpec as Record<string, unknown>) : null,
                      time_created: now,
                      time_updated: now,
                    })
                    .onConflictDoNothing()
                    .returning()
                    .get()
                    .pipe(Effect.orDie)
                  if (inserted) {
                    // P0-9: co-transactional run_admitted event — every state transition must have a
                    // matching event so the audit log is complete (design §1.3 #24).
                    yield* tx
                      .insert(TaskRunEventTable)
                      .values({
                        event_id: Identifier.ascending("event"),
                        run_id: inserted.run_id,
                        version: 0,
                        type: "run_admitted",
                        from_state: null,
                        to_state: "admitted",
                        reason: "initial_admission",
                        time_created: now,
                      })
                      .run()
                      .pipe(Effect.orDie)
                    return inserted
                  }
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

/**
 * Settle a newly admitted, unowned run after a pre-execution failure.
 * The row transition and audit event share one transaction and are fenced by
 * generation, version, state, control state, and absence of an execution owner.
 */
export function failAdmittedTaskRun(input: { run: Run; reason: string; error: ErrorData; now?: number }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()

    return yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const updated = yield* tx
            .update(TaskRunTable)
            .set({
              state: "failed",
              phase: "settled",
              control_state: "closed",
              reason: input.reason,
              error: input.error,
              version: input.run.version + 1,
              time_updated: now,
              time_settled: now,
            })
            .where(
              and(
                eq(TaskRunTable.run_id, input.run.runID),
                eq(TaskRunTable.generation, input.run.generation),
                eq(TaskRunTable.version, input.run.version),
                eq(TaskRunTable.state, "admitted"),
                eq(TaskRunTable.control_state, "open"),
                isNull(TaskRunTable.execution_owner),
              ),
            )
            .returning()
            .get()
            .pipe(Effect.orDie)

          if (!updated) return undefined

          yield* tx
            .insert(TaskRunEventTable)
            .values({
              event_id: Identifier.ascending("event"),
              run_id: updated.run_id,
              version: updated.version,
              type: "run_settled",
              from_state: "admitted",
              to_state: "failed",
              reason: input.reason,
              data: input.error,
              time_created: now,
            })
            .run()
            .pipe(Effect.orDie)

          return fromRow(updated)
        }),
      { behavior: "immediate" },
    )
  })
}

/**
 * L3d: CAS transition for a run from "admitted" to "admitting" (input_state).
 * This marks the start of the input projection workflow.
 * Returns the updated Run on success, undefined if the CAS missed (concurrent actor).
 *
 * B-3 (P0-9): UPDATE and event INSERT are in the same IMMEDIATE transaction so a process
 * crash between the two cannot leave the run in a state without an audit event.
 */
export function transitionToAdmitting(input: { runID: string; version: number; now?: number }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    return yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const updated = yield* tx
            .update(TaskRunTable)
            .set({
              input_state: "admitting",
              version: input.version + 1,
              time_updated: now,
            })
            .where(
              and(
                eq(TaskRunTable.run_id, input.runID),
                eq(TaskRunTable.version, input.version),
                eq(TaskRunTable.state, "admitted"),
              ),
            )
            .returning()
            .get()
            .pipe(Effect.orDie)
          if (!updated) return undefined

          // B-3 (P0-9): co-transactional event for input admission start
          yield* tx
            .insert(TaskRunEventTable)
            .values({
              event_id: Identifier.ascending("event"),
              run_id: input.runID,
              version: updated.version,
              type: "input_admitting",
              from_state: "admitted",
              to_state: "admitted",
              reason: "input_projection_started",
              time_created: now,
            })
            .run()
            .pipe(Effect.orDie)

          return fromRow(updated)
        }),
      { behavior: "immediate" },
    )
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
        state: "running",
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
          inArray(TaskRunTable.state, ["provisioning", "researching", "running", "finalizing"]),
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
                inArray(TaskRunTable.state, ["provisioning", "researching", "running", "finalizing"]),
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
                    state: "failed",
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
                      inArray(TaskRunTable.state, ["provisioning", "researching", "running", "finalizing"]),
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
    ["researching", "running"],
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
    ["researching", "running", "finalizing"],
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
  state: Extract<State, "completed" | "error" | "failed" | "cancelled" | "interrupted">
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
          // TODO(delivery-receipt): This ack can fire even when no new assistant response was
          // generated (the existing user message was already in the session). A proper fix requires
          // matching assistant.parentID against parent_input_message_id before acknowledging.
          // Tracked as Phase 5C / §3.7 delivery receipt gap.
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
// C-5 (P1-7): isQuiescent covers recovery_required — it is not terminal, not active
export const isQuiescent = (run: Run) => quiescentStates.includes(run.state)

// ---------------------------------------------------------------------------
// L2: Run graph, ancestor guard and recursive close
// Design: subagent-control-plane-design.zh-CN.md §6.2, §6.9, §6.10
// ---------------------------------------------------------------------------

export class AncestorClosedError extends Data.TaggedError("TaskRun.AncestorClosedError")<{
  readonly closedRunID: string
  readonly controlState: ControlState
}> {}

export class RecoveryNotRequiredError extends Data.TaggedError("TaskRun.RecoveryNotRequiredError")<{
  readonly runID: string
  readonly actualState: State
}> {}

/**
 * Check that all ancestors of the calling parent run have control_state = "open".
 * Fails with AncestorClosedError if any ancestor is close_requested or closed.
 * Top-level calls (no parent admission row) succeed immediately.
 *
 * Depth is bounded to 3 by design (§1.3 invariant 6), so iterative walk is fine.
 */
export function checkAncestorControl(input: {
  parentSessionID: SessionID
  parentMessageID: MessageID
  toolCallID: string
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    // Must match the admissionKey format: NUL-delimited (same as admissionKey() function above)
    const key = `${input.parentSessionID}\u0000${input.parentMessageID}\u0000${input.toolCallID}`

    // Find parent run via admission record
    const admission = yield* db
      .select({ run_id: TaskAdmissionTable.run_id })
      .from(TaskAdmissionTable)
      .where(eq(TaskAdmissionTable.admission_key, key))
      .get()
      .pipe(Effect.orDie)
    if (!admission) return // top-level: no parent → nothing to check

    // Walk ancestor chain (bounded by MAX_FORK_DEPTH = 3)
    let currentID: string | null = admission.run_id
    while (currentID !== null) {
      const row: { run_id: string; parent_run_id: string | null; control_state: string } | undefined = yield* db
        .select({
          run_id: TaskRunTable.run_id,
          parent_run_id: TaskRunTable.parent_run_id,
          control_state: TaskRunTable.control_state,
        })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, currentID))
        .get()
        .pipe(Effect.orDie)
      if (!row) break
      if (row.control_state !== "open") {
        return yield* Effect.fail(
          new AncestorClosedError({
            closedRunID: row.run_id,
            controlState: row.control_state as ControlState,
          }),
        )
      }
      currentID = row.parent_run_id ?? null
    }
  })
}

/**
 * Atomically close a run subtree in a single IMMEDIATE transaction.
 *
 * Collects rootRunID + all descendants (via parent_run_id BFS) + any
 * same-child higher-generation queued continuations, then for each:
 *   admitted / queued / recovery_required  →  state = "closed" (terminal)
 *   provisioning / running / finalizing    →  control_state = "close_requested"
 *   already closed                         →  skip
 *
 * Each state change writes a matching task_run_event in the same transaction.
 * Design §6.9.
 */
export function requestClose(input: { rootRunID: string; reason: string; now?: number }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()

    return yield* Effect.uninterruptible(
      db.transaction(
        (tx) =>
          Effect.gen(function* () {
            // Iterative BFS to collect all runs in the subtree.
            // Depth is bounded (design §1.3 invariant 6), so this terminates quickly.
            const visited = new Set<string>([input.rootRunID])
            const queue = [input.rootRunID]

            while (queue.length > 0) {
              const batch = queue.splice(0)
              const children = yield* tx
                .select({ run_id: TaskRunTable.run_id })
                .from(TaskRunTable)
                .where(inArray(TaskRunTable.parent_run_id, batch))
                .all()
                .pipe(Effect.orDie)
              for (const c of children) {
                if (!visited.has(c.run_id)) {
                  visited.add(c.run_id)
                  queue.push(c.run_id)
                }
              }
            }

            // Collect all rows at once for processing
            const rows = yield* tx
              .select({
                run_id: TaskRunTable.run_id,
                child_session_id: TaskRunTable.child_session_id,
                generation: TaskRunTable.generation,
                state: TaskRunTable.state,
                control_state: TaskRunTable.control_state,
                version: TaskRunTable.version,
              })
              .from(TaskRunTable)
              .where(inArray(TaskRunTable.run_id, [...visited]))
              .all()
              .pipe(Effect.orDie)

            // Also find same-child higher-generation queued continuations
            const sessionIDs = [...new Set(rows.map((r) => r.child_session_id))]
            const maxGenBySession = new Map<string, number>()
            for (const r of rows) {
              const cur = maxGenBySession.get(r.child_session_id) ?? 0
              if (r.generation > cur) maxGenBySession.set(r.child_session_id, r.generation)
            }
            const continuations = yield* tx
              .select({
                run_id: TaskRunTable.run_id,
                child_session_id: TaskRunTable.child_session_id,
                generation: TaskRunTable.generation,
                state: TaskRunTable.state,
                control_state: TaskRunTable.control_state,
                version: TaskRunTable.version,
              })
              .from(TaskRunTable)
              .where(
                and(
                  inArray(TaskRunTable.child_session_id, sessionIDs),
                  inArray(TaskRunTable.state, ["admitted", "queued"] as State[]),
                ),
              )
              .all()
              .pipe(Effect.orDie)
            for (const c of continuations) {
              if (!visited.has(c.run_id)) rows.push(c)
            }

            const changed: Array<{ runID: string; oldState: State; newState: State }> = []
            const immediateTerminal: State[] = ["admitted", "queued", "recovery_required"]
            const activeStates: State[] = ["provisioning", "running", "researching", "finalizing"]

            for (const row of rows) {
              if (row.control_state === "closed") continue

              const oldState = row.state as State

              if (immediateTerminal.includes(oldState)) {
                // Settle immediately
                const updated = yield* tx
                  .update(TaskRunTable)
                  .set({
                    control_state: "closed",
                    state: "closed",
                    phase: "settled",
                    close_requested_at: now,
                    close_reason: input.reason,
                    version: row.version + 1,
                    time_updated: now,
                    time_settled: now,
                  })
                  .where(and(eq(TaskRunTable.run_id, row.run_id), eq(TaskRunTable.version, row.version)))
                  .returning({ run_id: TaskRunTable.run_id, version: TaskRunTable.version })
                  .get()
                  .pipe(Effect.orDie)
                if (updated) {
                  yield* tx
                    .insert(TaskRunEventTable)
                    .values({
                      event_id: Identifier.ascending("event"),
                      run_id: row.run_id,
                      version: updated.version,
                      type: "run_closed",
                      from_state: oldState,
                      to_state: "closed",
                      reason: input.reason,
                      time_created: now,
                    })
                    .run()
                    .pipe(Effect.orDie)
                  changed.push({ runID: row.run_id, oldState, newState: "closed" })
                }
              } else if (activeStates.includes(oldState)) {
                // Mark close intent; executor settles when it finishes
                const updated = yield* tx
                  .update(TaskRunTable)
                  .set({
                    control_state: "close_requested",
                    close_requested_at: now,
                    close_reason: input.reason,
                    version: row.version + 1,
                    time_updated: now,
                  })
                  .where(
                    and(
                      eq(TaskRunTable.run_id, row.run_id),
                      eq(TaskRunTable.version, row.version),
                      ne(TaskRunTable.control_state, "closed"),
                    ),
                  )
                  .returning({ run_id: TaskRunTable.run_id, version: TaskRunTable.version })
                  .get()
                  .pipe(Effect.orDie)
                if (updated) {
                  yield* tx
                    .insert(TaskRunEventTable)
                    .values({
                      event_id: Identifier.ascending("event"),
                      run_id: row.run_id,
                      version: updated.version,
                      type: "close_requested",
                      from_state: oldState,
                      to_state: oldState,
                      reason: input.reason,
                      time_created: now,
                    })
                    .run()
                    .pipe(Effect.orDie)
                  changed.push({ runID: row.run_id, oldState, newState: oldState })
                }
              }
            }

            return changed as ReadonlyArray<{ runID: string; oldState: State; newState: State }>
          }),
        { behavior: "immediate" },
      ),
    )
  })
}

/**
 * Resolve a recovery_required run via explicit host/user action.
 * The only two valid resolutions are "failed" and "closed" (design §6.10).
 * Closes all descendants in the same transaction.
 */
export function resolveRecovery(input: {
  runID: string
  resolution: "failed" | "closed"
  reason: string
  now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()

    return yield* Effect.uninterruptible(
      db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const current = yield* tx
              .select()
              .from(TaskRunTable)
              .where(eq(TaskRunTable.run_id, input.runID))
              .get()
              .pipe(Effect.orDie)
            if (!current || current.state !== "recovery_required") {
              return yield* Effect.fail(
                new RecoveryNotRequiredError({
                  runID: input.runID,
                  actualState: (current?.state ?? "absent") as State,
                }),
              )
            }

            const updated = yield* tx
              .update(TaskRunTable)
              .set({
                state: input.resolution,
                phase: "settled",
                control_state: "closed",
                close_requested_at: now,
                close_reason: input.reason,
                version: current.version + 1,
                time_updated: now,
                time_settled: now,
              })
              .where(and(eq(TaskRunTable.run_id, input.runID), eq(TaskRunTable.version, current.version)))
              .returning()
              .get()
              .pipe(Effect.orDie)

            if (!updated) {
              return yield* Effect.die(
                new Error(`resolveRecovery CAS lost for run ${input.runID} — concurrent mutation won the version race`),
              )
            }

            yield* tx
              .insert(TaskRunEventTable)
              .values({
                event_id: Identifier.ascending("event"),
                run_id: input.runID,
                version: updated.version,
                type: "recovery_resolved",
                from_state: "recovery_required",
                to_state: input.resolution,
                reason: input.reason,
                time_created: now,
              })
              .run()
              .pipe(Effect.orDie)

            // Design §6.10: close descendants in the SAME IMMEDIATE transaction so a crash
            // between root settlement and descendant close is impossible.
            const closeReason = `parent_resolved:${input.reason}`
            const visited = new Set<string>([updated.run_id])
            const bfsQueue = [updated.run_id]
            while (bfsQueue.length > 0) {
              const batch = bfsQueue.splice(0)
              const children = yield* tx
                .select({ run_id: TaskRunTable.run_id })
                .from(TaskRunTable)
                .where(inArray(TaskRunTable.parent_run_id, batch))
                .all()
                .pipe(Effect.orDie)
              for (const c of children) {
                if (!visited.has(c.run_id)) {
                  visited.add(c.run_id)
                  bfsQueue.push(c.run_id)
                }
              }
            }
            const descendantIDs = [...visited].filter((id) => id !== updated.run_id)
            if (descendantIDs.length > 0) {
              const descendants = yield* tx
                .select({
                  run_id: TaskRunTable.run_id,
                  state: TaskRunTable.state,
                  control_state: TaskRunTable.control_state,
                  version: TaskRunTable.version,
                })
                .from(TaskRunTable)
                .where(inArray(TaskRunTable.run_id, descendantIDs))
                .all()
                .pipe(Effect.orDie)
              const immediateTerminal: State[] = ["admitted", "queued", "recovery_required"]
              const activeDesc: State[] = ["provisioning", "running", "researching", "finalizing"]
              for (const desc of descendants) {
                if (desc.control_state === "closed") continue
                const oldState = desc.state as State
                if (immediateTerminal.includes(oldState)) {
                  const upd = yield* tx
                    .update(TaskRunTable)
                    .set({
                      state: "closed",
                      phase: "settled",
                      control_state: "closed",
                      close_requested_at: now,
                      close_reason: closeReason,
                      version: desc.version + 1,
                      time_updated: now,
                      time_settled: now,
                    })
                    .where(and(eq(TaskRunTable.run_id, desc.run_id), eq(TaskRunTable.version, desc.version)))
                    .returning({ run_id: TaskRunTable.run_id, version: TaskRunTable.version })
                    .get()
                    .pipe(Effect.orDie)
                  if (upd)
                    yield* tx
                      .insert(TaskRunEventTable)
                      .values({
                        event_id: Identifier.ascending("event"),
                        run_id: desc.run_id,
                        version: upd.version,
                        type: "run_closed",
                        from_state: oldState,
                        to_state: "closed",
                        reason: closeReason,
                        time_created: now,
                      })
                      .run()
                      .pipe(Effect.orDie)
                } else if (activeDesc.includes(oldState)) {
                  const upd = yield* tx
                    .update(TaskRunTable)
                    .set({
                      control_state: "close_requested",
                      close_requested_at: now,
                      close_reason: closeReason,
                      version: desc.version + 1,
                      time_updated: now,
                    })
                    .where(
                      and(
                        eq(TaskRunTable.run_id, desc.run_id),
                        eq(TaskRunTable.version, desc.version),
                        ne(TaskRunTable.control_state, "closed"),
                      ),
                    )
                    .returning({ run_id: TaskRunTable.run_id, version: TaskRunTable.version })
                    .get()
                    .pipe(Effect.orDie)
                  if (upd)
                    yield* tx
                      .insert(TaskRunEventTable)
                      .values({
                        event_id: Identifier.ascending("event"),
                        run_id: desc.run_id,
                        version: upd.version,
                        type: "close_requested",
                        from_state: oldState,
                        to_state: oldState,
                        reason: closeReason,
                        time_created: now,
                      })
                      .run()
                      .pipe(Effect.orDie)
                }
              }
            }

            return fromRow(updated)
          }),
        { behavior: "immediate" },
      ),
    )
  })
}

// ---------------------------------------------------------------------------
// L6: Interrupt, shutdown and reconciliation
// Design: subagent-control-plane-design.zh-CN.md §6.8, §11
// ---------------------------------------------------------------------------

/**
 * Request interrupt for a run.
 * - admitted/queued: immediately settled as "cancelled"
 * - provisioning/running/finalizing: writes interrupt intent; executor settles it
 * - already terminal: no-op
 * Design §6.8
 */
export function requestInterrupt(input: { runID: string; reason: string; now?: number }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()

    return yield* Effect.uninterruptible(
      db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const run = yield* tx
              .select()
              .from(TaskRunTable)
              .where(eq(TaskRunTable.run_id, input.runID))
              .get()
              .pipe(Effect.orDie)
            if (!run) return yield* Effect.die(new Error(`requestInterrupt: run ${input.runID} not found`))

            const terminalStates: State[] = ["completed", "failed", "cancelled", "interrupted", "closed"]
            if (terminalStates.includes(run.state as State)) {
              return fromRow(run) // already terminal
            }

            const immediateCancel: State[] = ["admitted", "queued"]
            if (immediateCancel.includes(run.state as State)) {
              const updated = yield* tx
                .update(TaskRunTable)
                .set({
                  state: "cancelled",
                  phase: "settled",
                  control_state: "closed",
                  interrupt_requested_at: now,
                  interrupt_reason: input.reason,
                  version: run.version + 1,
                  time_updated: now,
                  time_settled: now,
                })
                .where(and(eq(TaskRunTable.run_id, input.runID), eq(TaskRunTable.version, run.version)))
                .returning()
                .get()
                .pipe(Effect.orDie)
              if (updated) {
                yield* tx
                  .insert(TaskRunEventTable)
                  .values({
                    event_id: Identifier.ascending("event"),
                    run_id: input.runID,
                    version: updated.version,
                    type: "run_settled",
                    from_state: run.state,
                    to_state: "cancelled",
                    reason: input.reason,
                    time_created: now,
                  })
                  .run()
                  .pipe(Effect.orDie)
                return fromRow(updated)
              }
              return fromRow(run)
            }

            // active run — write interrupt intent; executor will settle
            const updated = yield* tx
              .update(TaskRunTable)
              .set({
                interrupt_requested_at: now,
                interrupt_reason: input.reason,
                version: run.version + 1,
                time_updated: now,
              })
              .where(and(eq(TaskRunTable.run_id, input.runID), eq(TaskRunTable.version, run.version)))
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (updated) {
              yield* tx
                .insert(TaskRunEventTable)
                .values({
                  event_id: Identifier.ascending("event"),
                  run_id: input.runID,
                  version: updated.version,
                  type: "interrupt_requested",
                  from_state: run.state,
                  to_state: run.state,
                  reason: input.reason,
                  time_created: now,
                })
                .run()
                .pipe(Effect.orDie)
              return fromRow(updated)
            }
            return fromRow(run)
          }),
        { behavior: "immediate" },
      ),
    )
  })
}

/**
 * Classify runs for a directory on process startup.
 * Called before new admissions are accepted (design §11.1).
 * - provisioning + input_state=admitting → recovery_required(input_admission_outcome_unknown)
 * - provisioning + input_state=ready/pending + no execution_started_at → re-enqueue to queued
 * - running/finalizing or execution_started_at set → recovery_required(execution_owner_lost)
 */
export function classifyOnStartup(input: { directory: string; now?: number }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()

    const candidates = yield* db
      .select({ run: TaskRunTable })
      .from(TaskRunTable)
      .innerJoin(SessionTable, eq(SessionTable.id, TaskRunTable.parent_session_id))
      .where(
        and(
          eq(SessionTable.directory, input.directory),
          inArray(TaskRunTable.state, ["admitted", "queued", "provisioning", "running", "researching", "finalizing"]),
          // Only classify runs whose lease has expired or was never set.
          // Runs with a valid non-expired lease belong to a healthy process in another PID — skip them.
          or(isNull(TaskRunTable.lease_expires_at), lte(TaskRunTable.lease_expires_at, now)),
        ),
      )
      .all()
      .pipe(Effect.orDie)

    let classified = 0
    let requeued = 0

    for (const { run } of candidates) {
      // B-6 (P1-3): admitted + ready/legacy/pending → safe to re-enqueue
      // "pending" represents admission that created the run row but process died before
      // input projection started — no provider activity occurred, safe to re-enqueue.
      const canEnqueue =
        run.state === "admitted" &&
        (run.input_state === "ready" || run.input_state === "legacy" || run.input_state === "pending")

      // provisioning/queued without execution started: safe to re-enqueue
      const canRequeue =
        (run.state === "provisioning" || run.state === "queued") &&
        (run.input_state === "ready" || run.input_state === "pending" || run.input_state === "legacy") &&
        !run.execution_started_at

      if (canEnqueue) {
        // B-6 (P1-4): UPDATE + event in same IMMEDIATE transaction — crash-safe
        const updated = yield* db.transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .update(TaskRunTable)
                .set({
                  state: "queued",
                  phase: "queue",
                  available_at: now,
                  version: (run.version ?? 0) + 1,
                  time_updated: now,
                })
                .where(and(eq(TaskRunTable.run_id, run.run_id), eq(TaskRunTable.version, run.version ?? 0)))
                .returning({ run_id: TaskRunTable.run_id, version: TaskRunTable.version })
                .get()
                .pipe(Effect.orDie)
              if (!row) return undefined
              yield* tx
                .insert(TaskRunEventTable)
                .values({
                  event_id: Identifier.ascending("event"),
                  run_id: run.run_id,
                  version: row.version,
                  type: "run_requeued_on_startup",
                  from_state: run.state,
                  to_state: "queued",
                  reason: "admitted_enqueue_recovery",
                  time_created: now,
                })
                .run()
                .pipe(Effect.orDie)
              return row
            }),
          { behavior: "immediate" },
        )
        if (updated) requeued++
      } else if (canRequeue) {
        // B-6 (P1-4): same IMMEDIATE transaction for requeue
        const updated = yield* db.transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .update(TaskRunTable)
                .set({
                  state: "queued",
                  phase: "queue",
                  execution_owner: null,
                  lease_expires_at: null,
                  available_at: now,
                  version: (run.version ?? 0) + 1,
                  time_updated: now,
                })
                .where(and(eq(TaskRunTable.run_id, run.run_id), eq(TaskRunTable.version, run.version ?? 0)))
                .returning({ run_id: TaskRunTable.run_id, version: TaskRunTable.version })
                .get()
                .pipe(Effect.orDie)
              if (!row) return undefined
              yield* tx
                .insert(TaskRunEventTable)
                .values({
                  event_id: Identifier.ascending("event"),
                  run_id: run.run_id,
                  version: row.version,
                  type: "run_requeued_on_startup",
                  from_state: run.state,
                  to_state: "queued",
                  reason: "safe_requeue",
                  time_created: now,
                })
                .run()
                .pipe(Effect.orDie)
              return row
            }),
          { behavior: "immediate" },
        )
        if (updated) requeued++
      } else {
        const reason = run.input_state === "admitting" ? "input_admission_outcome_unknown" : "execution_owner_lost"
        // B-6 (P1-4): same IMMEDIATE transaction for recovery_required
        const updated = yield* db.transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .update(TaskRunTable)
                .set({
                  state: "recovery_required",
                  execution_owner: null,
                  lease_expires_at: null,
                  version: (run.version ?? 0) + 1,
                  time_updated: now,
                })
                .where(and(eq(TaskRunTable.run_id, run.run_id), eq(TaskRunTable.version, run.version ?? 0)))
                .returning({ run_id: TaskRunTable.run_id, version: TaskRunTable.version })
                .get()
                .pipe(Effect.orDie)
              if (!row) return undefined
              yield* tx
                .insert(TaskRunEventTable)
                .values({
                  event_id: Identifier.ascending("event"),
                  run_id: run.run_id,
                  version: row.version,
                  type: "recovery_required",
                  from_state: run.state,
                  to_state: "recovery_required",
                  reason,
                  time_created: now,
                })
                .run()
                .pipe(Effect.orDie)
              return row
            }),
          { behavior: "immediate" },
        )
        if (updated) classified++
      }
    }

    return { classified, requeued }
  })
}

/**
 * Ordered shutdown: signal interrupt for active runs, classify provisioning runs.
 * Called before closing the process (design §11.3).
 */
export function orderedShutdown(input: { directory: string; now?: number }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()

    const candidates = yield* db
      .select({
        run_id: TaskRunTable.run_id,
        state: TaskRunTable.state,
        version: TaskRunTable.version,
        input_state: TaskRunTable.input_state,
        execution_started_at: TaskRunTable.execution_started_at,
      })
      .from(TaskRunTable)
      .innerJoin(SessionTable, eq(SessionTable.id, TaskRunTable.parent_session_id))
      .where(
        and(
          eq(SessionTable.directory, input.directory),
          inArray(TaskRunTable.state, ["provisioning", "running", "researching", "finalizing"]),
        ),
      )
      .all()
      .pipe(Effect.orDie)

    let signalled = 0
    for (const run of candidates) {
      const isActive = (["running", "researching", "finalizing"] as State[]).includes(run.state as State)
      const canRequeue = run.state === "provisioning" && run.input_state === "ready" && !run.execution_started_at

      if (canRequeue) {
        yield* requestInterrupt({ runID: run.run_id, reason: "shutdown_interrupt", now }).pipe(Effect.ignore)
      } else if (isActive) {
        yield* requestInterrupt({ runID: run.run_id, reason: "shutdown_interrupt", now }).pipe(Effect.ignore)
        signalled++
      } else {
        // provisioning, not safe to requeue — classify as recovery_required
        const updated = yield* db
          .update(TaskRunTable)
          .set({
            state: "recovery_required",
            execution_owner: null,
            lease_expires_at: null,
            version: (run.version ?? 0) + 1,
            time_updated: now,
          })
          .where(and(eq(TaskRunTable.run_id, run.run_id), eq(TaskRunTable.version, run.version ?? 0)))
          .returning({ run_id: TaskRunTable.run_id, version: TaskRunTable.version })
          .get()
          .pipe(Effect.orDie)
        if (updated) {
          yield* db
            .insert(TaskRunEventTable)
            .values({
              event_id: Identifier.ascending("event"),
              run_id: run.run_id,
              version: updated.version,
              type: "recovery_required",
              from_state: run.state,
              to_state: "recovery_required",
              reason: "shutdown_owner_lost",
              time_created: now,
            })
            .run()
            .pipe(Effect.orDie)
        }
      }
    }

    return { signalled }
  })
}

/**
 * Close a task run by child session ID.
 * Validates the run belongs to the given parent session before closing.
 * Called from the task tool when a user cancels an active task.
 * Design §6.9 product entry.
 */
export function closeTask(input: {
  childSessionID: SessionID
  parentSessionID: SessionID
  reason: string
  now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service

    // Find the most recent non-terminal run for this child
    const run = yield* db
      .select({
        run_id: TaskRunTable.run_id,
        parent_session_id: TaskRunTable.parent_session_id,
        state: TaskRunTable.state,
        control_state: TaskRunTable.control_state,
      })
      .from(TaskRunTable)
      .where(and(eq(TaskRunTable.child_session_id, input.childSessionID), eq(TaskRunTable.control_state, "open")))
      .orderBy(desc(TaskRunTable.generation))
      .get()
      .pipe(Effect.orDie)

    if (!run) {
      // No open run — already closed or never started
      return { closed: false, reason: "no_open_run" } as const
    }

    if (run.parent_session_id !== (input.parentSessionID as string)) {
      return yield* Effect.fail(
        new AdmissionConflict({
          admissionKey: String(input.childSessionID),
          reason: "child",
        }),
      )
    }

    yield* requestClose({ rootRunID: run.run_id, reason: input.reason, now: input.now })
    return { closed: true, runID: run.run_id } as const
  })
}
