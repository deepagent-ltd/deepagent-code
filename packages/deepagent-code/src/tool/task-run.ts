import { Database } from "@deepagent-code/core/database/database"
import { TaskRunEventTable, TaskRunTable, type TaskStructuredOutputReceipt } from "@deepagent-code/core/session/sql"
import { and, desc, eq, gt, inArray, ne } from "drizzle-orm"
import { Data, Effect } from "effect"
import { Identifier } from "@/id/id"
import { MessageID, SessionID } from "@/session/schema"
import { Hash } from "@deepagent-code/core/util/hash"
import { V2TaskRunReceipt } from "@deepagent-code/core/session/runner/v2-task-run-receipt"
import type { PermissionV1 } from "@deepagent-code/core/v1/permission"

// The durable task ledger's read/control surface. Execution ownership (admit → claim → settle)
// lives ONLY in the Core V2 TaskRunAuthority (packages/core/src/session/task-run.ts); this module
// keeps the row projection types shared by task_status/task_read/task_close/task_recovery, the
// structured-output evidence module, and the goal adapters, plus the explicit control-plane
// resolutions (close subtree, resolve recovery) that remain host actions on the shared table.

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
export type StructuredOutputReceipt = TaskStructuredOutputReceipt

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
  structuredOutputReceipt?: StructuredOutputReceipt
  output?: string
  error?: ErrorData
  timeCreated: number
  timeUpdated: number
  timeSettled?: number
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
    readonly structuredOutput?: {
      readonly schema: Record<string, unknown>
      readonly allowTextFallback: boolean
      readonly receiptVersion: 1
      readonly maxAttempts: 2
    }
    readonly researchBudget?: {
      readonly maxSteps: number
      readonly maxWallMs: number
      readonly maxNoProgress: number
    }
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
  readonly reason: "request" | "delivery" | "child" | "join" | "ancestor_closed" | "recovery_resolution_required"
}> {}

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
  structuredOutputReceipt: row.structured_output_receipt ?? undefined,
  output: row.output ?? undefined,
  error: row.error ?? undefined,
  timeCreated: row.time_created,
  timeUpdated: row.time_updated,
  timeSettled: row.time_settled ?? undefined,
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
  executionSpec: row.execution_spec ? (row.execution_spec as Run["executionSpec"]) : undefined,
})

// Control-plane settlements (close, recovery resolution) have no execution owner; a fixed sentinel
// identifies the settlement source in receipt evidence.
export const CONTROL_PLANE_OWNER = "control-plane"

// Shared compensation-receipt recorder: every terminal settlement path records the durable
// outcome inside its own settlement transaction. Terminal-only; the raw `error` state folds into
// `failed` while staying pinned inside the outcome hash.
export function recordTerminalReceiptInTransaction(
  tx: Parameters<typeof V2TaskRunReceipt.recordInTransaction>[0],
  input: {
    readonly run: {
      readonly runID: string
      readonly parentSessionID: string
      readonly childSessionID: string
      readonly generation: number
    }
    readonly state: V2TaskRunReceipt.TaskRunReceipt["state"] | "error"
    readonly reason: string
    readonly output?: string | null
    readonly error?: ErrorData | null
    readonly ownerToken: string
    readonly now: number
  },
) {
  return V2TaskRunReceipt.recordInTransaction(tx, {
    sessionId: input.run.parentSessionID,
    runId: input.run.runID,
    childSessionId: input.run.childSessionID,
    generation: input.run.generation,
    state: input.state === "error" ? "failed" : input.state,
    reason: input.reason,
    outcomeHash: requestHash({
      state: input.state,
      reason: input.reason,
      output: input.output ?? null,
      error: input.error ?? null,
    }),
    ownerToken: input.ownerToken,
    now: input.now,
  }).pipe(Effect.asVoid)
}

// ---------------------------------------------------------------------------
// L2: Run graph close + recovery resolution (host control-plane actions)
// ---------------------------------------------------------------------------

/**
 * Atomically close a run subtree in a single IMMEDIATE transaction.
 *
 * Collects rootRunID + all descendants (via parent_run_id BFS) + any same-child
 * higher-generation queued continuations, then for each:
 *   admitted / queued / recovery_required  →  state = "closed" (terminal)
 *   provisioning / running / finalizing    →  control_state = "close_requested"
 *   already closed                         →  skip
 */
export function requestClose(input: { rootRunID: string; reason: string; now?: number }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()

    return yield* Effect.uninterruptible(
      db.transaction(
        (tx) =>
          Effect.gen(function* () {
            // Iterative BFS to collect all runs in the subtree (depth is bounded by MAX_SUBAGENT_DEPTH).
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

            const rows = yield* tx
              .select({
                run_id: TaskRunTable.run_id,
                parent_session_id: TaskRunTable.parent_session_id,
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
            const continuations = yield* tx
              .select({
                run_id: TaskRunTable.run_id,
                parent_session_id: TaskRunTable.parent_session_id,
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
                  yield* recordTerminalReceiptInTransaction(tx, {
                    run: {
                      runID: row.run_id,
                      parentSessionID: row.parent_session_id,
                      childSessionID: row.child_session_id,
                      generation: row.generation,
                    },
                    state: "closed",
                    reason: input.reason,
                    ownerToken: CONTROL_PLANE_OWNER,
                    now,
                  })
                  changed.push({ runID: row.run_id, oldState, newState: "closed" })
                }
              } else if (activeStates.includes(oldState)) {
                // Mark close intent; the V2 authority executor settles when its drain finishes.
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

export class RecoveryNotRequiredError extends Data.TaggedError("TaskRun.RecoveryNotRequiredError")<{
  readonly runID: string
  readonly actualState: State
}> {}

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
                execution_owner: null,
                lease_expires_at: null,
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

            yield* recordTerminalReceiptInTransaction(tx, {
              run: fromRow(updated),
              state: input.resolution,
              reason: input.reason,
              ownerToken: CONTROL_PLANE_OWNER,
              now,
            })

            // Design §6.10: close descendants in the SAME IMMEDIATE transaction so a crash
            // between root settlement and descendant close is impossible.
            const closeReason = `parent_resolved:${input.reason}`
            const visited = new Set<string>([updated.run_id])
            const bfsQueue = [updated.run_id]
            const laterGenerations = yield* tx
              .select({ run_id: TaskRunTable.run_id })
              .from(TaskRunTable)
              .where(
                and(
                  eq(TaskRunTable.child_session_id, current.child_session_id),
                  gt(TaskRunTable.generation, current.generation),
                ),
              )
              .all()
              .pipe(Effect.orDie)
            for (const later of laterGenerations) {
              visited.add(later.run_id)
              bfsQueue.push(later.run_id)
            }
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
                  parent_session_id: TaskRunTable.parent_session_id,
                  child_session_id: TaskRunTable.child_session_id,
                  generation: TaskRunTable.generation,
                  state: TaskRunTable.state,
                  control_state: TaskRunTable.control_state,
                  version: TaskRunTable.version,
                })
                .from(TaskRunTable)
                .where(inArray(TaskRunTable.run_id, descendantIDs))
                .all()
                .pipe(Effect.orDie)
              const closable: State[] = [
                "admitted",
                "queued",
                "provisioning",
                "running",
                "researching",
                "finalizing",
                "recovery_required",
              ]
              for (const desc of descendants) {
                if (desc.control_state === "closed") continue
                const oldState = desc.state as State
                if (closable.includes(oldState)) {
                  const upd = yield* tx
                    .update(TaskRunTable)
                    .set({
                      state: "closed",
                      phase: "settled",
                      control_state: "closed",
                      close_requested_at: now,
                      close_reason: closeReason,
                      execution_owner: null,
                      lease_expires_at: null,
                      version: desc.version + 1,
                      time_updated: now,
                      time_settled: now,
                    })
                    .where(and(eq(TaskRunTable.run_id, desc.run_id), eq(TaskRunTable.version, desc.version)))
                    .returning({ run_id: TaskRunTable.run_id, version: TaskRunTable.version })
                    .get()
                    .pipe(Effect.orDie)
                  if (upd) {
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
                    yield* recordTerminalReceiptInTransaction(tx, {
                      run: {
                        runID: desc.run_id,
                        parentSessionID: desc.parent_session_id,
                        childSessionID: desc.child_session_id,
                        generation: desc.generation,
                      },
                      state: "closed",
                      reason: closeReason,
                      ownerToken: CONTROL_PLANE_OWNER,
                      now,
                    })
                  }
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

/**
 * Close a task run by child session ID.
 * Validates the run belongs to the given parent session before closing.
 * Called from task_close (user cancellation) and the facade's task stop control.
 */
export function closeTask(input: {
  childSessionID: SessionID
  parentSessionID: SessionID
  reason: string
  now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service

    // Find the most recent open run for this child
    const run = yield* db
      .select({
        run_id: TaskRunTable.run_id,
        parent_session_id: TaskRunTable.parent_session_id,
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
