export * as CurrentToolExecution from "./current-tool-execution"

import { and, eq } from "drizzle-orm"
import { Context, Effect } from "effect"
import type { Database } from "../../database/database"
import type { Location } from "../../location"
import type { Tool } from "../../tool/tool"
import { CanonicalJson } from "../../util/canonical-json"
import { Hash } from "../../util/hash"
import { BrowserSchema } from "../../browser/schema"
import { SessionTable } from "../sql"
import { SessionProviderAttemptTable, SessionProviderOwnerLeaseTable, SessionContextSelectionTable } from "../../context-federation/session-sql"
import { SecurityNamespaceTable } from "../../context-federation/sql"
import { V2ToolEffectAdmissionTable, V2ToolEffectTable } from "./v2-tool-effect.sql"
import { V2ProviderTurnReceiptTable } from "./v2-provider-turn.sql"
import type { V2ProviderTurn } from "./v2-provider-turn"
import type { V2ToolEffect } from "./v2-tool-effect"
import { SharedBrowserUserInput } from "../../browser/shared-user-input"

type Db = Pick<Database.Interface["db"], "select">
type Entry = {
  active: boolean
  admission: V2ToolEffect.ToolEffectAdmission
  context: Tool.Context
  location: Location.Interface
  inputHash: string
  provider: V2ProviderTurn.Interface
  selection?: { id: string; projectionHash: string; namespace: string; location: string; project: string; bindingHash: string }
}
const handles = new WeakMap<object, Entry>()
declare const FileFrameType: unique symbol
export type FileFrame = { readonly [FileFrameType]: true }
const fileFrames = new WeakMap<FileFrame, { handle: object; entry: Entry; input: unknown;
  context: Tool.Context; location: Location.Interface; admission: V2ToolEffect.ToolEffectAdmission;
  selection: NonNullable<Entry["selection"]>; inputHash: string }>()
const Current = Context.Reference<object | undefined>("@deepagent-code/CurrentToolExecution", { defaultValue: () => undefined })
const denied = () => new BrowserSchema.Error({ code: "BROWSER_AUTHORITY_REQUIRED", message: "A current canonical tool execution is required" })

declare const PermissionCancellationType: unique symbol
export type PermissionCancellation = { readonly [PermissionCancellationType]: true }
const permissionCancellations = new WeakMap<PermissionCancellation, {
  active: boolean
  context: Tool.Context
  cancelled: boolean
  waiting?: object
}>()
const CurrentPermissionCancellation = Context.Reference<PermissionCancellation | undefined>(
  "@deepagent-code/CurrentToolExecution/PermissionCancellation", { defaultValue: () => undefined },
)

/** This records local settlement evidence, never permission or executable authority. Only the
 * builtin's actual pre-effect permission wait can mark its original live settlement scope. */
export function withPermissionCancellation<A, E, R>(
  admission: V2ToolEffect.ToolEffectAdmission,
  context: Tool.Context,
  body: (witness: PermissionCancellation) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      if (admission.toolName !== "bash" || admission.sessionId !== context.sessionID || admission.toolCallId !== context.toolCallID)
        throw new Error("Permission cancellation must belong to the original tool admission")
      const witness = Object.freeze({}) as PermissionCancellation
      permissionCancellations.set(witness, { active: true, context: Object.freeze({ ...context }), cancelled: false })
      return witness
    }),
    (witness) => body(witness).pipe(Effect.provideService(CurrentPermissionCancellation, witness)),
    (witness) => Effect.sync(() => {
      const entry = permissionCancellations.get(witness)
      if (entry) entry.active = false
      permissionCancellations.delete(witness)
    }),
  )
}

export const beforeEffectPermission = Effect.fn("CurrentToolExecution.beforeEffectPermission")(function* <A, E, R>(
  context: Tool.Context, body: Effect.Effect<A, E, R>,
) {
  const witness = yield* CurrentPermissionCancellation
  const entry = witness && permissionCancellations.get(witness)
  if (!entry?.active || entry.waiting || entry.context.sessionID !== context.sessionID ||
    entry.context.toolCallID !== context.toolCallID || entry.context.assistantMessageID !== context.assistantMessageID ||
    entry.context.agent !== context.agent) return yield* body
  const waiting = Object.freeze({})
  entry.waiting = waiting
  entry.cancelled = false
  return yield* body.pipe(
    Effect.onInterrupt(() => Effect.sync(() => {
      if (entry.active && entry.waiting === waiting) entry.cancelled = true
    })),
    Effect.ensuring(Effect.sync(() => {
      if (entry.waiting === waiting) entry.waiting = undefined
    })),
  )
})

export function cancelledBeforeEffect(witness: PermissionCancellation) {
  const entry = permissionCancellations.get(witness)
  return entry?.active === true && entry.cancelled
}

/** Called only by the canonical settlement scope, after its real durable admission. This is
 * an internal runtime capability, not a security boundary against arbitrary in-process code. */
export function withAdmission<A, E, R>(
  db: Db,
  input: Omit<Entry, "active" | "inputHash" | "selection"> & { input: unknown },
  body: Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const handle = Object.freeze({})
      const entry: Entry = { ...input, active: true, inputHash: Hash.sha256(CanonicalJson.stringify(input.input)) }
      entry.selection = yield* verify(db, entry)
      handles.set(handle, entry)
      return handle
    }),
    (handle) => body.pipe(Effect.provideService(Current, handle)),
    (handle) => Effect.sync(() => {
      const entry = handles.get(handle)
      if (entry) entry.active = false
      handles.delete(handle)
    }),
  )
}

export const requireCurrent = Effect.fn("CurrentToolExecution.requireCurrent")(function* (
  db: Db, context: Tool.Context, location: Location.Interface, input: unknown, scope?: BrowserSchema.Scope,
) {
  const handle = yield* Current
  const entry = handle && handles.get(handle)
  if (!entry?.active || entry.context.sessionID !== context.sessionID ||
    entry.context.toolCallID !== context.toolCallID || entry.context.assistantMessageID !== context.assistantMessageID ||
    entry.context.agent !== context.agent || entry.location.directory !== location.directory ||
    entry.location.workspaceID !== location.workspaceID || entry.location.project.id !== location.project.id ||
    entry.inputHash !== Hash.sha256(CanonicalJson.stringify(input))) return yield* denied()
  const selection = yield* verify(db, entry)
  if (scope && (selection.namespace !== scope.securityNamespaceID || selection.location !== scope.locationKey ||
    selection.project !== scope.projectScopeKey || selection.bindingHash !== scope.namespaceBindingHash ||
    scope.sessionID !== context.sessionID || scope.projectID !== location.project.id || scope.directory !== location.directory))
    return yield* denied()
  return entry.admission
})

/** Derives only from the actual request/selection captured by this canonical tool call. A
 * caller cannot upgrade an old provider response by supplying a newer message or epoch. */
export const sharedWitness = Effect.fn("CurrentToolExecution.sharedWitness")(function* (
  db: Db, context: Tool.Context, location: Location.Interface, input: unknown,
) {
  const admission = yield* requireCurrent(db, context, location, input)
  const witness = yield* SharedBrowserUserInput.witness(db, admission.receiptId)
  if (!witness || witness.rootSessionID !== context.sessionID) return yield* denied()
  return witness
})

/** A file frame can only be captured inside the original canonical settlement scope.
 * It retains no durable or cold-start authority; the original handle must remain current. */
export const captureFileFrame = Effect.fn("CurrentToolExecution.captureFileFrame")(function* (
  db: Db, context: Tool.Context, location: Location.Interface, input: unknown, scope: BrowserSchema.Scope,
) {
  yield* requireCurrent(db, context, location, input, scope)
  const handle = yield* Current
  const entry = handle && handles.get(handle)
  if (!handle || !entry?.active || !entry.selection) return yield* denied()
  const frame = Object.freeze({}) as FileFrame
  fileFrames.set(frame, { handle, entry, input, context: structuredClone(context), location: structuredClone(location),
    admission: structuredClone(entry.admission), selection: structuredClone(entry.selection), inputHash: entry.inputHash })
  return frame
})

export const requireFileFrame = Effect.fn("CurrentToolExecution.requireFileFrame")(function* (frame: FileFrame) {
  const saved = fileFrames.get(frame)
  if (!saved || (yield* Current) !== saved.handle || handles.get(saved.handle) !== saved.entry || !saved.entry.active ||
    CanonicalJson.stringify(saved.entry.context) !== CanonicalJson.stringify(saved.context) ||
    saved.entry.location.directory !== saved.location.directory || saved.entry.location.workspaceID !== saved.location.workspaceID ||
    saved.entry.location.project.id !== saved.location.project.id ||
    saved.entry.inputHash !== saved.inputHash || Hash.sha256(CanonicalJson.stringify(saved.input)) !== saved.inputHash ||
    CanonicalJson.stringify(saved.entry.admission) !== CanonicalJson.stringify(saved.admission) ||
    CanonicalJson.stringify(saved.entry.selection) !== CanonicalJson.stringify(saved.selection) ||
    (yield* saved.entry.provider.currentOwnerToken()) !== saved.admission.ownerToken) return yield* denied()
  return { admission: saved.admission, selection: saved.selection }
})

function verify(db: Db, entry: Entry) {
  return Effect.gen(function* () {
    if (!entry.active || entry.admission.toolName !== "browser" || entry.admission.sessionId !== entry.context.sessionID ||
      entry.admission.toolCallId !== entry.context.toolCallID || entry.location.workspaceID !== undefined ||
      (yield* entry.provider.currentOwnerToken()) !== entry.admission.ownerToken) return yield* denied()
    const row = yield* db.select({ admission: V2ToolEffectAdmissionTable, receipt: V2ProviderTurnReceiptTable,
      selection: SessionContextSelectionTable, namespace: SecurityNamespaceTable, attempt: SessionProviderAttemptTable, owner: SessionProviderOwnerLeaseTable, session: SessionTable,
    }).from(V2ToolEffectAdmissionTable)
      .innerJoin(V2ProviderTurnReceiptTable, eq(V2ProviderTurnReceiptTable.receipt_id, V2ToolEffectAdmissionTable.receipt_id))
      .innerJoin(SessionProviderAttemptTable, eq(SessionProviderAttemptTable.attempt_id, V2ToolEffectAdmissionTable.provider_attempt_id))
      .innerJoin(SessionContextSelectionTable, eq(SessionContextSelectionTable.selection_id, SessionProviderAttemptTable.selection_id))
      .innerJoin(SecurityNamespaceTable, eq(SecurityNamespaceTable.id, SessionContextSelectionTable.security_namespace_id))
      .innerJoin(SessionProviderOwnerLeaseTable, eq(SessionProviderOwnerLeaseTable.owner_token, V2ToolEffectAdmissionTable.owner_token))
      .innerJoin(SessionTable, eq(SessionTable.id, V2ToolEffectAdmissionTable.session_id))
      .where(eq(V2ToolEffectAdmissionTable.admission_id, entry.admission.admissionId)).get()
      .pipe(Effect.mapError(() => denied()))
    if (!row || row.admission.receipt_id !== entry.admission.receiptId ||
      row.admission.provider_attempt_id !== entry.admission.providerAttemptId ||
      row.admission.session_id !== entry.admission.sessionId || row.admission.owner_token !== entry.admission.ownerToken || row.admission.tool_name !== "browser" ||
      row.admission.tool_call_id !== entry.context.toolCallID || row.receipt.session_id !== entry.context.sessionID ||
      row.receipt.provider_attempt_id !== row.attempt.attempt_id || row.receipt.owner_token !== entry.admission.ownerToken ||
      row.attempt.owner_token !== entry.admission.ownerToken || row.attempt.session_id !== entry.context.sessionID ||
      row.owner.released_at !== null || row.owner.lease_expires_at <= Date.now() ||
      !["streaming", "settled"].includes(row.receipt.state) || !["streaming", "settled"].includes(row.attempt.state) ||
      row.session.execution_claim_token === null || row.session.execution_claim_token !== row.attempt.execution_claim_token ||
      row.session.directory !== entry.location.directory || row.session.project_id !== entry.location.project.id ||
      row.session.workspace_id !== null || !row.session.v2_authority) return yield* denied()
    if (!row.selection.security_namespace_id || !row.selection.project_scope_key || row.namespace.retired_at !== null ||
      row.selection.session_id !== entry.context.sessionID ||
      row.receipt.prepared_turn?.context_selection_id !== row.selection.selection_id ||
      row.receipt.prepared_turn.context_projection_hash !== row.selection.projection_hash ||
      row.attempt.projection_hash !== row.selection.projection_hash ||
      Hash.sha256(row.selection.projection) !== row.selection.projection_hash) return yield* denied()
    const selection = { id: row.selection.selection_id, projectionHash: row.selection.projection_hash, namespace: row.selection.security_namespace_id, location: row.selection.location_key,
      project: row.selection.project_scope_key, bindingHash: row.namespace.binding_hash }
    if (entry.selection && CanonicalJson.stringify(entry.selection) !== CanonicalJson.stringify(selection)) return yield* denied()
    const terminal = yield* db.select({ id: V2ToolEffectTable.effect_id }).from(V2ToolEffectTable)
      .where(and(eq(V2ToolEffectTable.receipt_id, entry.admission.receiptId), eq(V2ToolEffectTable.tool_call_id, entry.admission.toolCallId)))
      .get().pipe(Effect.mapError(() => denied()))
    if (terminal) return yield* denied()
    return selection
  })
}
