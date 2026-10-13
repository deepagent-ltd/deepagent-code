export * as TaskHumanControl from "./task-human-control"

import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Option, Schema } from "effect"
import { Attention } from "../attention"
import { AttentionWorkSource } from "../attention/work-source"
import type { Database } from "../database/database"
import { GoalChild } from "../deepagent/goal-child"
import { PermissionSavedEpochTable } from "../permission/sql"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { SessionSchema } from "./schema"
import { SessionTable, TaskAdmissionTable, TaskRunEventTable, TaskRunTable } from "./sql"
import { TaskHumanControlSchema } from "./task-human-control.schema"
import { TaskRunAuthority } from "./task-run"
import { V2TaskRunReceiptTable } from "./runner/v2-task-run-receipt.sql"
import { WorkSessionGuard } from "./work-session-guard"

type Db = Database.Interface["db"]
export const MAX_COMMANDS = 32
export const MAX_RECEIPT_BYTES = 16 * 1024
const failure = (code: TaskHumanControlSchema.Error["code"], message: string) =>
  new TaskHumanControlSchema.Error({ code, message })
const digest = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))

/** Pure original-ledger observation, shared with read-only action advertisements. */
export const beforeDispatch = (db: Pick<Db, "all">, childSessionID: string) =>
  db
    .all<{ receipts: number; attempts: number; tools: number }>(
      sql`SELECT
  (SELECT count(*) FROM session_v2_provider_turn_receipt WHERE session_id=${childSessionID}) AS receipts,
  (SELECT count(*) FROM session_provider_attempt WHERE session_id=${childSessionID}) AS attempts,
  (SELECT count(*) FROM session_v2_tool_effect_admission WHERE session_id=${childSessionID}) AS tools`,
    )
    .pipe(
      Effect.orDie,
      Effect.map(([external]) => !!external && !external.receipts && !external.attempts && !external.tools),
    )

/** Installed only by the trusted host. A request body has neither an actor nor a permit.
 * The host's callback consumes its actual authentication witness and Session mutation scope. */
export class Actor extends Context.Service<
  Actor,
  {
    readonly current: (
      parentSessionID: string,
    ) => Effect.Effect<{ readonly principal: string }, TaskHumanControlSchema.Error>
  }
>()("@deepagent-code/TaskHumanControl/Actor") {}

export const control = Effect.fn("TaskHumanControl.control")(function* (db: Db, raw: unknown) {
  const input = Schema.decodeUnknownOption(TaskHumanControlSchema.Input, { onExcessProperty: "error" })(raw)
  if (Option.isNone(input)) return yield* failure("invalid_request", "Task control requires one exact, bounded command")
  const capability = yield* Attention.Access
  if (!capability.enabled || capability.scope !== "implicit-local")
    return yield* failure("unavailable", "Task controls require the local attention profile")
  const actor = yield* Effect.serviceOption(Actor)
  if (Option.isNone(actor))
    return yield* failure("auth_required", "A current host-authenticated human operator is required")
  const before = yield* actor.value.current(input.value.parentSessionID)
  const principal = Schema.decodeUnknownOption(TaskHumanControlSchema.Receipt.fields.authority.fields.principal)(
    before.principal,
  )
  if (Option.isNone(principal))
    return yield* failure("auth_required", "The current human operator has no valid identity")
  const command = input.value
  const eventID = `evthuman_${digest(["task-human-control-v1", capability.scope, principal.value, command.requestID])}`
  const requestHash = digest(command)
  const interruptions = new Set<SessionSchema.ID>()
  return yield* Effect.uninterruptible(
    db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const current = yield* actor.value.current(command.parentSessionID)
            if (current.principal !== principal.value)
              return yield* failure("auth_required", "The human operator changed during admission")
            yield* WorkSessionGuard.requireOrdinary(tx, command.parentSessionID).pipe(
              Effect.mapError(() => failure("unsupported", "Bound work uses its original source control authority")),
            )
            yield* GoalChild.requireOrdinary(tx, command.parentSessionID).pipe(
              Effect.mapError(() =>
                failure("unsupported", "Managed Goal children use their original Goal control authority"),
              ),
            )
            const parent = yield* tx
              .select({
                id: SessionTable.id,
                project: SessionTable.project_id,
                directory: SessionTable.directory,
                workspace: SessionTable.workspace_id,
                v2: SessionTable.v2_authority,
              })
              .from(SessionTable)
              .where(eq(SessionTable.id, SessionSchema.ID.make(command.parentSessionID)))
              .get()
              .pipe(Effect.orDie)
            if (
              !parent ||
              !parent.v2 ||
              parent.workspace !== null ||
              parent.id.startsWith(SessionSchema.LEARNING_REVIEWER_SESSION_PREFIX)
            )
              return yield* failure(
                "scope_changed",
                "The original parent is no longer an implicit-local writable Session",
              )
            const epoch = yield* tx
              .select({ value: PermissionSavedEpochTable.epoch })
              .from(PermissionSavedEpochTable)
              .where(eq(PermissionSavedEpochTable.project_id, parent.project))
              .get()
              .pipe(Effect.orDie)
            const prior = yield* tx
              .select({
                run: TaskRunEventTable.run_id,
                version: TaskRunEventTable.version,
                type: TaskRunEventTable.type,
                state: TaskRunEventTable.to_state,
                time: TaskRunEventTable.time_created,
                data: TaskRunEventTable.data,
              })
              .from(TaskRunEventTable)
              .where(eq(TaskRunEventTable.event_id, eventID))
              .get()
              .pipe(Effect.orDie)
            if (prior) {
              const receipt = parseReceipt(prior.data)
              if (
                !receipt ||
                receipt.receiptID !== eventID ||
                receipt.requestHash !== requestHash ||
                digest(receipt.request) !== requestHash ||
                receipt.request.runID !== prior.run ||
                receipt.version !== prior.version ||
                receipt.version !== receipt.request.expectedVersion + 1 ||
                receipt.state !== prior.state ||
                receipt.time !== prior.time ||
                (receipt.request.action === "request_close"
                  ? !["close_requested", "run_closed"].includes(prior.type)
                  : prior.type !== "recovery_resolved")
              )
                return yield* failure("request_conflict", "Task control requestID was already used for another command")
              const original = yield* tx
                .select({
                  parent: TaskRunTable.parent_session_id,
                  child: TaskRunTable.child_session_id,
                  generation: TaskRunTable.generation,
                })
                .from(TaskRunTable)
                .innerJoin(
                  TaskAdmissionTable,
                  and(
                    eq(TaskAdmissionTable.run_id, TaskRunTable.run_id),
                    eq(TaskAdmissionTable.request_hash, TaskRunTable.request_hash),
                    eq(TaskAdmissionTable.parent_session_id, TaskRunTable.parent_session_id),
                    eq(TaskAdmissionTable.parent_message_id, TaskRunTable.parent_message_id),
                    eq(TaskAdmissionTable.tool_call_id, TaskRunTable.tool_call_id),
                  ),
                )
                .where(eq(TaskRunTable.run_id, prior.run))
                .get()
                .pipe(Effect.orDie)
              if (
                !original ||
                original.parent !== command.parentSessionID ||
                original.child !== receipt.recordedChildSessionID ||
                original.generation !== command.generation
              )
                return yield* failure(
                  "scope_changed",
                  "The original Task registration no longer matches its control receipt",
                )
              if (
                receipt.authority.principal !== principal.value ||
                receipt.authority.projectID !== parent.project ||
                receipt.authority.directory !== parent.directory ||
                receipt.authority.permissionEpoch !== (epoch?.value ?? 0)
              )
                return yield* failure(
                  "scope_changed",
                  "The original command authority changed; its receipt remains readable",
                )
              return { receipt, replayed: true }
            }
            const item = yield* AttentionWorkSource.read(tx, "task", command.itemID)
            const source = item?.source.task
            if (
              !item ||
              !source ||
              item.revision !== command.itemRevision ||
              source.runID !== command.runID ||
              source.parentSessionID !== parent.id ||
              source.childSessionID !== command.childSessionID ||
              source.generation !== command.generation ||
              source.version !== command.expectedVersion ||
              item.session.projectID !== parent.project
            )
              return yield* failure(
                "source_changed",
                "The Task source changed; refresh its original facts before acting",
              )
            const commands = yield* tx
              .all<{ event_id: string }>(
                sql`SELECT event_id FROM task_run_event
      WHERE run_id=${command.runID} AND event_id LIKE 'evthuman_%' LIMIT ${MAX_COMMANDS + 1}`,
              )
              .pipe(Effect.orDie)
            if (commands.length >= MAX_COMMANDS)
              return yield* failure("command_limit", "This run reached its durable human command limit")
            const terminal = ["completed", "failed", "error", "closed", "interrupted", "cancelled"].includes(
              source.state,
            )
            if (terminal || source.controlState === "closed")
              return yield* failure("unsupported", "A settled Task cannot be reopened or controlled")
            if (command.action !== "request_close") {
              if (!(yield* beforeDispatch(tx, source.recordedChildSessionID)))
                return yield* failure(
                  "custody_required",
                  "Human recovery resolution requires a genuine before-dispatch frontier; the original execution evidence stays in custody",
                )
            }
            const now = Date.now()
            const affected =
              command.action === "request_close"
                ? (yield* TaskRunAuthority.requestCloseInTransaction(
                    tx,
                    { rootRunID: command.runID, reason: command.reason, now },
                    interruptions,
                  )).length
                : (yield* TaskRunAuthority.resolveRecoveryInTransaction(tx, {
                    runID: command.runID,
                    resolution: command.action === "resolve_failed" ? "failed" : "closed",
                    reason: command.reason,
                    now,
                  }),
                  1)
            const row = yield* tx
              .select({ version: TaskRunTable.version, state: TaskRunTable.state, control: TaskRunTable.control_state })
              .from(TaskRunTable)
              .where(eq(TaskRunTable.run_id, command.runID))
              .get()
              .pipe(Effect.orDie)
            if (!row || row.version !== command.expectedVersion + 1)
              return yield* failure("source_changed", "The original Task reducer did not accept this control")
            const terminalReceipt = yield* tx
              .select({ id: V2TaskRunReceiptTable.receipt_id })
              .from(V2TaskRunReceiptTable)
              .where(
                and(
                  eq(V2TaskRunReceiptTable.run_id, command.runID),
                  eq(V2TaskRunReceiptTable.generation, command.generation),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            const receipt: TaskHumanControlSchema.Receipt = {
              contract: "task-human-control-v1",
              receiptID: eventID,
              requestHash,
              request: command,
              authority: {
                scope: "implicit-local",
                principal: principal.value,
                projectID: parent.project,
                directory: parent.directory,
                permissionEpoch: epoch?.value ?? 0,
              },
              recordedChildSessionID: source.recordedChildSessionID,
              version: row.version,
              state: row.state,
              controlState: row.control,
              terminalReceiptID: terminalReceipt?.id ?? null,
              affectedRuns: affected,
              time: now,
            }
            if (!parseReceipt(receipt))
              return yield* failure("invalid_request", "The durable Task control receipt exceeds its bounded contract")
            const written = yield* tx
              .update(TaskRunEventTable)
              .set({ event_id: eventID, data: receipt })
              .where(and(eq(TaskRunEventTable.run_id, command.runID), eq(TaskRunEventTable.version, row.version)))
              .returning({ id: TaskRunEventTable.event_id })
              .get()
              .pipe(Effect.orDie)
            if (!written) return yield* failure("unavailable", "The original Task mutation event is unavailable")
            if (command.action === "request_close" && row.control === "close_requested")
              interruptions.add(SessionSchema.ID.make(source.recordedChildSessionID))
            return { receipt, replayed: false }
          }),
        { behavior: "immediate" },
      )
      .pipe(
        Effect.tap(() => TaskRunAuthority.interruptClosedSessions(interruptions)),
        Effect.catch((error) =>
          error instanceof TaskHumanControlSchema.Error
            ? Effect.fail(error)
            : error instanceof TaskRunAuthority.RecoveryCustodyRequired
              ? Effect.fail(
                  failure(
                    "custody_required",
                    "Unknown execution remains in custody; only a close request is supported",
                  ),
                )
              : error instanceof TaskRunAuthority.RecoveryNotRequired
                ? Effect.fail(failure("source_changed", "Task recovery state changed"))
                : Effect.fail(failure("unavailable", "The original Task control storage is unavailable")),
        ),
      ),
  )
})

function parseReceipt(value: unknown) {
  if (Buffer.byteLength(CanonicalJson.stringify(value), "utf8") > MAX_RECEIPT_BYTES) return undefined
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(TaskHumanControlSchema.Receipt, { onExcessProperty: "error" })(value),
  )
}
