export * as TaskContinuation from "./task-continuation"

import { and, desc, eq, sql } from "drizzle-orm"
import { Cause, Context, Effect, Option, Schema } from "effect"
import { ToolCall } from "@deepagent-code/llm"
import type { Database } from "../database/database"
import type { Location } from "../location"
import type { Tool } from "../tool/tool"
import { subagentTimeoutMs } from "../tool/task-policy"
import type { EventV2 } from "../event"
import type { SessionContext } from "../context-federation/session-context"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { SessionActivityTable, SessionProviderAttemptTable, SessionProviderOwnerLeaseTable } from "../context-federation/session-sql"
import { SessionInput } from "./input"
import { SessionInputTable, SessionTable, TaskRunTable, TaskNotificationOutboxTable, SessionV2TaskCallAdmissionTable, TaskAdmissionTable } from "./sql"
import { SessionSchema } from "./schema"
import { SessionMessage } from "./message"
import { V2ProviderTurnReceiptTable } from "./runner/v2-provider-turn.sql"
import { V2ToolEffectAdmissionTable, V2ToolEffectTable } from "./runner/v2-tool-effect.sql"
import { V2TaskRunReceiptTable } from "./runner/v2-task-run-receipt.sql"
import type { V2ProviderTurn } from "./runner/v2-provider-turn"
import type { V2ToolEffect } from "./runner/v2-tool-effect"
import type { TaskRunAuthority } from "./task-run"
import { WorkAuthority } from "./work-authority"
import { SessionV1 } from "../v1/session"
import { PermissionSchema } from "../permission/schema"

type Db = Database.Interface["db"]
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Pick<Tx, "select" | "all">
const digest = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))
const Digest = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)))
const Integer = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)))

/** This record is issued only in a canonical task settlement scope. Old execution specs
 * without it remain readable; neither metadata nor a caller-provided object can register it. */
export const Record = Schema.Struct({
  version: Schema.Literal(1), parentSessionID: Schema.String, parentMessageID: Schema.String,
  toolCallID: Schema.String, admissionID: Schema.String, receiptID: Schema.String,
  providerAttemptID: Schema.String, ownerToken: Schema.String, toolInputHash: Digest,
  activityID: Schema.String, activityOrdinal: Integer, triggerInputID: Schema.String,
  inputSeq: Integer, parentFingerprint: Digest, expiresAt: Integer,
})
export type Record = typeof Record.Type
const ExecutionSpec = Schema.Struct({ runtime: Schema.Literal("core_v2"), agent: Schema.String,
  permissions: PermissionSchema.Ruleset, outputSchema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  workspace: Schema.optional(Schema.Struct({ mode: Schema.Literal("worktree") })),
  fileScope: Schema.optional(Schema.Array(Schema.String)), continuation: Record,
})
export class Refused extends Schema.TaggedErrorClass<Refused>()("TaskContinuation.Refused", {
  reason: Schema.Literals(["unregistered", "changed", "expired", "unknown", "conflict"]),
  message: Schema.String,
}) {}
const refused = (reason: Refused["reason"]) => new Refused({ reason, message: `Task result continuation ${reason}` })

type Entry = {
  active: boolean
  admission: V2ToolEffect.ToolEffectAdmission
  context: Tool.Context
  location: Location.Interface
  input: unknown
  provider: V2ProviderTurn.Interface
}
const entries = new WeakMap<object, Entry>()
const Current = Context.Reference<object | undefined>("@deepagent-code/TaskContinuation/Current", { defaultValue: () => undefined })
export const CurrentDeadline = Context.Reference<number | undefined>("@deepagent-code/TaskContinuation/Deadline", { defaultValue: () => undefined })

/** Runner-owned lifetime capability, distinct from the browser's native scope. */
export function withAdmission<A, E, R>(input: Omit<Entry, "active">, body: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const handle = Object.freeze({})
      entries.set(handle, { ...input, active: true })
      return handle
    }),
    (handle) => body.pipe(Effect.provideService(Current, handle)),
    (handle) => Effect.sync(() => {
      const entry = entries.get(handle)
      if (entry) entry.active = false
      entries.delete(handle)
    }),
  )
}

/** Called inside the run's original admission transaction, after its exact-retry lookup. */
export const capture = Effect.fn("TaskContinuation.capture")(function* (tx: Tx, spec: TaskRunAuthority.SubmitSpec) {
  if (spec.deliveryMode !== "background") return undefined
  const handle = yield* Current
  const entry = handle && entries.get(handle)
  if (!entry?.active) return undefined
  const input = Schema.decodeUnknownOption(Schema.Struct({ prompt: Schema.String, subagent_type: Schema.String,
    background: Schema.Literal(true), task_id: Schema.optional(Schema.String) }))(entry.input)
  if (Option.isNone(input) || input.value.task_id !== undefined || input.value.prompt !== spec.prompt.text ||
    input.value.subagent_type !== String(spec.agent) || entry.context.sessionID !== spec.parentSessionID ||
    entry.context.assistantMessageID !== spec.parentMessageID || entry.context.toolCallID !== spec.toolCallID ||
    entry.admission.toolName !== "task" || entry.admission.sessionId !== spec.parentSessionID ||
    entry.admission.toolCallId !== spec.toolCallID || (yield* entry.provider.currentOwnerToken()) !== entry.admission.ownerToken)
    return yield* refused("conflict")
  const original = yield* tx.select({ admission: V2ToolEffectAdmissionTable, receipt: V2ProviderTurnReceiptTable,
    attempt: SessionProviderAttemptTable, owner: SessionProviderOwnerLeaseTable, activity: SessionActivityTable,
    session: SessionTable, taskCall: SessionV2TaskCallAdmissionTable }).from(V2ToolEffectAdmissionTable)
    .innerJoin(V2ProviderTurnReceiptTable, eq(V2ProviderTurnReceiptTable.receipt_id, V2ToolEffectAdmissionTable.receipt_id))
    .innerJoin(SessionProviderAttemptTable, eq(SessionProviderAttemptTable.attempt_id, V2ToolEffectAdmissionTable.provider_attempt_id))
    .innerJoin(SessionProviderOwnerLeaseTable, eq(SessionProviderOwnerLeaseTable.owner_token, V2ToolEffectAdmissionTable.owner_token))
    .innerJoin(SessionActivityTable, eq(SessionActivityTable.activity_id, V2ProviderTurnReceiptTable.activity_id))
    .innerJoin(SessionTable, eq(SessionTable.id, V2ToolEffectAdmissionTable.session_id))
    .innerJoin(SessionV2TaskCallAdmissionTable, eq(SessionV2TaskCallAdmissionTable.tool_call_id, V2ToolEffectAdmissionTable.tool_call_id))
    .where(eq(V2ToolEffectAdmissionTable.admission_id, entry.admission.admissionId)).get()
  if (!original || original.admission.tool_name !== "task" || original.admission.tool_call_id !== spec.toolCallID ||
    original.admission.session_id !== spec.parentSessionID || original.admission.receipt_id !== entry.admission.receiptId ||
    original.admission.provider_attempt_id !== entry.admission.providerAttemptId || original.admission.owner_token !== entry.admission.ownerToken ||
    original.receipt.session_id !== spec.parentSessionID || !original.receipt.prepared_turn ||
    original.receipt.prepared_turn.assistant_message_id !== undefined && original.receipt.prepared_turn.assistant_message_id !== spec.parentMessageID ||
    original.taskCall.session_id !== spec.parentSessionID || String(original.taskCall.assistant_message_id) !== String(spec.parentMessageID) ||
    original.receipt.provider_attempt_id !== original.attempt.attempt_id || original.receipt.owner_token !== entry.admission.ownerToken ||
    original.attempt.owner_token !== entry.admission.ownerToken || original.attempt.session_id !== spec.parentSessionID ||
    original.attempt.activity_id !== original.activity.activity_id || original.activity.session_id !== spec.parentSessionID ||
    original.activity.state !== "active" || original.activity.settled_at !== null ||
    original.owner.released_at !== null || original.owner.lease_expires_at <= Date.now() ||
    !["streaming", "settled"].includes(original.receipt.state) || !["streaming", "settled"].includes(original.attempt.state) ||
    original.session.execution_claim_token === null || original.session.execution_claim_token !== original.attempt.execution_claim_token ||
    original.session.directory !== entry.location.directory || original.session.project_id !== entry.location.project.id ||
    (original.session.workspace_id ?? undefined) !== entry.location.workspaceID || !original.session.v2_authority ||
    original.session.time_archived !== null) return yield* refused("changed")
  const terminal = yield* tx.select({ id: V2ToolEffectTable.effect_id }).from(V2ToolEffectTable)
    .where(and(eq(V2ToolEffectTable.receipt_id, entry.admission.receiptId), eq(V2ToolEffectTable.tool_call_id, spec.toolCallID))).get()
  if (terminal) return yield* refused("changed")
  // The currently installed restricted profiles deny delegation. Do not turn an ordinary
  // task continuation into an implicit child grant or a fresh root budget.
  if ((yield* WorkAuthority.lookupSession(tx, spec.parentSessionID)).kind !== "ordinary") return yield* refused("unregistered")
  const latest = yield* tx.select({ seq: SessionInputTable.admitted_seq }).from(SessionInputTable)
    .where(eq(SessionInputTable.session_id, spec.parentSessionID)).orderBy(desc(SessionInputTable.admitted_seq)).limit(1).get()
  if (!latest) return yield* refused("changed")
  const expiresAt = Math.min((yield* CurrentDeadline) ?? Number.MAX_SAFE_INTEGER, Date.now() + Math.min(30 * 60_000, subagentTimeoutMs()))
  if (expiresAt <= Date.now()) return yield* refused("expired")
  return {
    version: 1, parentSessionID: spec.parentSessionID, parentMessageID: spec.parentMessageID, toolCallID: spec.toolCallID,
    admissionID: entry.admission.admissionId, receiptID: entry.admission.receiptId,
    providerAttemptID: entry.admission.providerAttemptId, ownerToken: entry.admission.ownerToken,
    toolInputHash: digest(entry.input), activityID: original.activity.activity_id,
    activityOrdinal: original.activity.ordinal, triggerInputID: original.activity.trigger_input_id,
    inputSeq: latest.seq, parentFingerprint: fingerprint(original.session), expiresAt,
  } satisfies Record
})

export function decode(value: unknown) {
  return Option.getOrUndefined(Schema.decodeUnknownOption(Record, { onExcessProperty: "error" })(value))
}

/** SQL-only checks repeated by the SessionInput commit hook. A successful ended launch
 * activity is eligible; a successor activity or even an unpromoted new user input is not. */
export const requireCurrent = Effect.fn("TaskContinuation.requireCurrent")(function* (tx: Reader, runID: string, messageID: string, execution = false) {
  const run = yield* tx.select().from(TaskRunTable).where(eq(TaskRunTable.run_id, runID)).get()
  if (!run || run.execution_runtime !== "v2" || run.delivery_mode !== "background") return yield* refused("changed")
  const decoded = Schema.decodeUnknownOption(ExecutionSpec, { onExcessProperty: "error" })(run.execution_spec)
  if (Option.isNone(decoded)) return yield* refused("unregistered")
  const spec = decoded.value
  const record = spec.continuation
  if (record.expiresAt <= Date.now()) return yield* refused("expired")
  if (!["completed", "failed"].includes(run.state) || run.time_settled === null || run.interrupt_requested_at !== null || run.close_requested_at !== null)
    return yield* refused("unknown")
  if (run.parent_session_id !== record.parentSessionID || run.parent_message_id !== record.parentMessageID ||
    run.tool_call_id !== record.toolCallID) return yield* refused("conflict")
  const parent = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, run.parent_session_id)).get()
  const activity = yield* tx.select().from(SessionActivityTable).where(eq(SessionActivityTable.session_id, run.parent_session_id))
    .orderBy(desc(SessionActivityTable.ordinal)).limit(1).get()
  const latest = yield* tx.select({ seq: SessionInputTable.admitted_seq, id: SessionInputTable.id }).from(SessionInputTable)
    .where(and(eq(SessionInputTable.session_id, run.parent_session_id), sql`${SessionInputTable.id} != ${messageID}`))
    .orderBy(desc(SessionInputTable.admitted_seq)).limit(1).get()
  if (!parent || !parent.v2_authority || parent.time_archived !== null || fingerprint(parent) !== record.parentFingerprint ||
    !activity || !(activity.activity_id === record.activityID && activity.ordinal === record.activityOrdinal &&
      activity.trigger_input_id === record.triggerInputID || execution && activity.trigger_input_id === messageID &&
      activity.ordinal === record.activityOrdinal + 1) || !["active", "settled"].includes(activity.state) ||
    !latest || latest.seq !== record.inputSeq) return yield* refused("changed")
  if ((yield* WorkAuthority.lookupSession(tx, record.parentSessionID)).kind !== "ordinary") return yield* refused("changed")
  const original = yield* tx.select({ admission: V2ToolEffectAdmissionTable, effect: V2ToolEffectTable, receipt: V2ProviderTurnReceiptTable,
    terminal: V2TaskRunReceiptTable, taskCall: SessionV2TaskCallAdmissionTable }).from(V2ToolEffectAdmissionTable)
    .innerJoin(V2ToolEffectTable, and(eq(V2ToolEffectTable.receipt_id, V2ToolEffectAdmissionTable.receipt_id),
      eq(V2ToolEffectTable.tool_call_id, V2ToolEffectAdmissionTable.tool_call_id)))
    .innerJoin(V2ProviderTurnReceiptTable, eq(V2ProviderTurnReceiptTable.receipt_id, V2ToolEffectAdmissionTable.receipt_id))
    .innerJoin(V2TaskRunReceiptTable, eq(V2TaskRunReceiptTable.run_id, runID))
    .innerJoin(SessionV2TaskCallAdmissionTable, eq(SessionV2TaskCallAdmissionTable.tool_call_id, V2ToolEffectAdmissionTable.tool_call_id))
    .where(eq(V2ToolEffectAdmissionTable.admission_id, record.admissionID)).get()
  const outcome = digest({ state: run.state, reason: run.reason, output: run.state === "completed" ? run.output : null,
    error: run.state === "completed" ? null : run.error ?? { code: run.state, message: run.reason } })
  const offered = original?.receipt.outcome_artifact?.flatMap((event) => {
    const decoded = Schema.decodeUnknownOption(ToolCall)(event)
    return Option.isSome(decoded) && decoded.value.id === record.toolCallID && decoded.value.name === "task"
      ? [decoded.value] : []
  }) ?? []
  if (!original || original.admission.tool_name !== "task" || original.admission.session_id !== record.parentSessionID ||
    original.admission.tool_call_id !== record.toolCallID || original.admission.receipt_id !== record.receiptID ||
    original.admission.provider_attempt_id !== record.providerAttemptID || original.admission.owner_token !== record.ownerToken ||
    original.effect.session_id !== record.parentSessionID || original.effect.provider_attempt_id !== record.providerAttemptID ||
    original.effect.owner_token !== record.ownerToken || original.effect.state !== "settled" || original.effect.error_code !== null ||
    original.receipt.session_id !== record.parentSessionID || original.receipt.activity_id !== record.activityID ||
    !original.receipt.prepared_turn || original.receipt.prepared_turn.assistant_message_id !== undefined &&
      original.receipt.prepared_turn.assistant_message_id !== record.parentMessageID || original.receipt.state !== "settled" ||
    original.taskCall.session_id !== record.parentSessionID || original.taskCall.assistant_message_id !== record.parentMessageID ||
    original.receipt.provider_attempt_id !== record.providerAttemptID || original.receipt.owner_token !== record.ownerToken ||
    offered.length !== 1 || digest(offered[0].input) !== record.toolInputHash ||
    original.terminal.session_id !== record.parentSessionID || original.terminal.child_session_id !== run.child_session_id ||
    original.terminal.generation !== run.generation || original.terminal.state !== run.state || original.terminal.outcome_hash !== outcome)
    return yield* refused("unknown")
  if (!run.child_message_id) return yield* refused("conflict")
  const input = yield* tx.select().from(SessionInputTable).where(eq(SessionInputTable.id, SessionMessage.ID.make(run.child_message_id))).get()
  const admission = yield* tx.select().from(TaskAdmissionTable).where(eq(TaskAdmissionTable.run_id, run.run_id)).get()
  if (!input || input.session_id !== run.child_session_id || !admission || admission.request_hash !== run.request_hash ||
    admission.parent_session_id !== run.parent_session_id || admission.parent_message_id !== run.parent_message_id ||
    admission.tool_call_id !== run.tool_call_id || run.request_hash !== digest({ prompt: input.prompt, agent: spec.agent,
      outputSchema: spec.outputSchema ?? null, deliveryMode: run.delivery_mode, permissions: spec.permissions,
      workspace: spec.workspace ?? null, fileScope: spec.fileScope ?? null, continuation: record })) return yield* refused("conflict")
  const outbox = yield* tx.select().from(TaskNotificationOutboxTable).where(eq(TaskNotificationOutboxTable.run_id, runID)).get()
  const payload = { agent: spec.agent, text: run.output ?? run.error?.message ?? run.reason ?? "" }
  if (!outbox || outbox.parent_session_id !== run.parent_session_id || outbox.correlation_id !== runID ||
    outbox.event_kind !== "terminal" || outbox.message_id !== messageID ||
    messageID !== `msg_tasknotify_${Hash.sha256(runID).slice(0, 24)}` || outbox.payload_hash !== digest(payload) ||
    digest(outbox.payload) !== digest(payload)) return yield* refused("conflict")
  const [unknown] = yield* tx.all<{ count: number }>(sql`SELECT count(*) count FROM (
    SELECT receipt_id FROM session_v2_provider_turn_receipt WHERE session_id=${run.child_session_id}
      AND state IN ('preparing','dispatching','streaming','indeterminate_after_crash')
    UNION ALL SELECT a.admission_id FROM session_v2_tool_effect_admission a
      LEFT JOIN session_v2_tool_effect e ON e.receipt_id=a.receipt_id AND e.tool_call_id=a.tool_call_id
      WHERE a.session_id=${run.child_session_id} AND e.effect_id IS NULL
  )`)
  if (!unknown || unknown.count !== 0) return yield* refused("unknown")
  return record
})

/** Used at actual provider dispatch as well as before observing Context. A durable outbox
 * relation, rather than a prompt metadata field, identifies a continuation input. */
export const requireExecution = Effect.fn("TaskContinuation.requireExecution")(function* (db: Reader, sessionID: string, inputID: string) {
  if (!inputID.startsWith("msg_tasknotify_")) return
  const outbox = yield* db.select().from(TaskNotificationOutboxTable).where(and(
    eq(TaskNotificationOutboxTable.parent_session_id, SessionSchema.ID.make(sessionID)),
    eq(TaskNotificationOutboxTable.parent_input_message_id, SessionV1.MessageID.make(inputID)),
  )).get()
  if (!outbox) return
  if (outbox.status !== "delivered") return yield* refused("changed")
  yield* requireCurrent(db, outbox.run_id, inputID, true)
})

/** Consume a superseded result with the ordinary prompt projection, retain a real failed
 * activity and the original task outcome, then let the drain continue its user FIFO. No
 * provider or Context observation is needed to discard this already-admitted queue fact. */
export const discardInvalidQueue = Effect.fn("TaskContinuation.discardInvalidQueue")(function* (
  db: Db, events: EventV2.Interface, contexts: SessionContext.Interface, sessionID: SessionSchema.ID,
) {
  const pending = (yield* SessionInput.pendingQueueInputs(db, sessionID))[0]
  if (!pending || !pending.id.startsWith("msg_tasknotify_")) return false
  const outbox = yield* db.select().from(TaskNotificationOutboxTable).where(and(
    eq(TaskNotificationOutboxTable.parent_session_id, sessionID),
    eq(TaskNotificationOutboxTable.parent_input_message_id, SessionV1.MessageID.make(pending.id)),
  )).get()
  if (!outbox) return false
  const current = yield* requireExecution(db, sessionID, pending.id).pipe(Effect.exit)
  if (current._tag === "Success") return false
  // Database defects are not a reason to consume data. Only a precise authority refusal
  // is a known obsolete return; other causes retain the input and fail normally.
  const refusal = Cause.squash(current.cause)
  if (!(refusal instanceof Refused) || current.cause.reasons.length !== 1) return yield* Effect.failCause(current.cause)
  yield* SessionInput.promoteNextQueued(db, events, sessionID)
  const activity = yield* contexts.openActivity({ sessionId: sessionID, triggerInputId: pending.id })
  yield* contexts.settleActivity({ activityId: activity.activityId, state: "failed" })
  yield* db.update(TaskNotificationOutboxTable).set({ status: "dead", last_error: refusal.message,
    time_updated: Date.now() }).where(eq(TaskNotificationOutboxTable.id, outbox.id))
  return true
})

function fingerprint(session: typeof SessionTable.$inferSelect) {
  return digest({ id: session.id, project: session.project_id, directory: session.directory,
    workspace: session.workspace_id, parent: session.parent_id, mutation: session.mutation_epoch,
    interrupt: session.interrupt_seq, permissions: session.permission, agent: session.agent, model: session.model })
}
