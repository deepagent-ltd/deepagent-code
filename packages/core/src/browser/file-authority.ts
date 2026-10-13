export * as BrowserFileAuthority from "./file-authority"

import { and, eq, inArray, isNull, notExists, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import type { Location } from "../location"
import type { Tool } from "../tool/tool"
import { PermissionV2 } from "../permission"
import { PermissionSavedEpochTable } from "../permission/sql"
import { GoalChild } from "../deepagent/goal-child"
import { WorkAuthority } from "../session/work-authority"
import { SessionTable } from "../session/sql"
import { CurrentToolExecution } from "../session/runner/current-tool-execution"
import { V2ToolEffectAdmissionTable, V2ToolEffectTable } from "../session/runner/v2-tool-effect.sql"
import { V2ProviderTurnReceiptTable } from "../session/runner/v2-provider-turn.sql"
import { SessionContextSelectionTable, SessionProviderAttemptTable, SessionProviderOwnerLeaseTable } from "../context-federation/session-sql"
import { LocationIdentityTable, ProjectScopeIdentityTable, SecurityNamespaceTable } from "../context-federation/sql"
import { BrowserControlTable } from "./browser.sql"
import { BrowserControl } from "./control"
import type { BrowserHost } from "./host"
import { BrowserSchema } from "./schema"

type Db = Database.Interface["db"]
type Reader = Db | Parameters<Parameters<Db["transaction"]>[0]>[0]
type Capture = {
  context: Tool.Context; location: Location.Interface; input: BrowserSchema.Invoke; control: BrowserSchema.Control;
  host: Pick<BrowserHost.Interface, "hostID" | "hostIncarnation" | "credentialBinding" | "alive" | "verify">;
  permission: PermissionV2.Interface;
  browser: { permit: PermissionV2.ActionPermit; input: PermissionV2.AssertInput };
  file: { permit: PermissionV2.ActionPermit; input: PermissionV2.AssertInput };
}
declare const LeaseType: unique symbol
export type Lease = { readonly [LeaseType]: true }
type Entry = { active: boolean; frame: CurrentToolExecution.FileFrame; actions: PermissionV2.FileActions;
  input: Capture; row: NonNullable<Effect.Success<ReturnType<typeof snapshot>>> }
const leases = new WeakMap<Lease, Entry>()
const denied = () => BrowserControl.failure("BROWSER_AUTHORITY_REQUIRED")

/** One full check and capture in one DB snapshot. A missing optional runtime capability
 * retains the original complete current closure; no serialized value can create a lease. */
export const capture = Effect.fn("BrowserFileAuthority.capture")(function* (db: Db, input: Capture) {
  if (!input.permission.captureFileActions ||
    (input.input.command.type !== "file.upload" && input.input.command.type !== "file.download")) return undefined
  const acquired = yield* db.transaction((tx) => Effect.gen(function* () {
    if ((yield* GoalChild.owner(tx, input.context.sessionID)) ||
      (yield* WorkAuthority.lookupSession(tx, input.context.sessionID)).kind !== "ordinary") return undefined
    const actions = yield* input.permission.captureFileActions!(input.browser, input.file)
      .pipe(Effect.mapError(() => BrowserControl.failure("BROWSER_SCOPE_DENIED")))
    if (!actions) return undefined
    const frame = yield* CurrentToolExecution.captureFileFrame(tx, input.context, input.location, input.input, input.control.scope)
    yield* BrowserControl.requireScope(tx, input.control.scope, input.location)
    const fresh = yield* BrowserControl.requireActive(tx, input.control.controlID, input.control.scope, input.host)
    if (BrowserControl.hash(fresh) !== BrowserControl.hash(input.control) || !input.host.alive() || !input.host.verify(fresh).matched)
      return yield* BrowserControl.failure("BROWSER_STALE_TARGET")
    const current = yield* CurrentToolExecution.requireFileFrame(frame)
    const row = yield* snapshot(tx, input, current.admission.admissionId)
    const approval = PermissionV2.fileActionsView(actions)
    if (!row || !approval || approval.sessionID !== input.context.sessionID || approval.projectID !== input.location.project.id ||
      approval.directory !== input.location.directory || approval.workspaceID !== input.location.workspaceID ||
      row.permissionRaw !== approval.permissionRaw || row.savedEpoch !== approval.savedEpoch ||
      !/^[0-9a-f]{64}$/.test(row.preparedTurnHash ?? "") || !/^[0-9a-f]{64}$/.test(row.wireRequestHash ?? ""))
      return yield* denied()
    return { active: true, frame, actions, input, row }
  }), { behavior: "immediate" }).pipe(Effect.mapError((error) =>
    error instanceof BrowserSchema.Error ? error : denied()))
  if (!acquired) return undefined
  return yield* Effect.acquireRelease(Effect.sync(() => {
    const lease = Object.freeze({}) as Lease
    leases.set(lease, acquired)
    return lease
  }), (lease) => Effect.sync(() => {
    acquired.active = false
    leases.delete(lease)
  }))
})

/** Classification remains uncached because ancestor/event/IM writers have no synchronous
 * in-memory fence. The joined probe avoids repeated policy decoding and Task context loads. */
export const requireCurrent = Effect.fn("BrowserFileAuthority.requireCurrent")(function* (db: Reader, lease: Lease) {
  // The original negative classification has several SQL reads. Hold one short writer
  // fence until its joined current probe and final memory checks finish, then release it
  // before any real file/FD/network operation. Existing action transactions use a savepoint.
  return yield* db.transaction((tx) => probeCurrent(tx, lease), { behavior: "immediate" })
    .pipe(Effect.mapError((error) => error instanceof BrowserSchema.Error ? error : denied()))
})

function probeCurrent(db: Reader, lease: Lease) {
  return Effect.gen(function* () {
    const entry = leases.get(lease)
    if (!entry?.active) return yield* denied()
    yield* localCurrent(entry)
    if ((yield* GoalChild.owner(db, entry.input.context.sessionID).pipe(Effect.mapError(() => denied()))) ||
      (yield* WorkAuthority.lookupSession(db, entry.input.context.sessionID).pipe(Effect.mapError(() => denied()))).kind !== "ordinary")
      return yield* denied()
    const admission = (yield* CurrentToolExecution.requireFileFrame(entry.frame)).admission
    const scope = entry.input.control.scope
    const row = entry.row
    const found = yield* db.select({ leaseExpiresAt: SessionProviderOwnerLeaseTable.lease_expires_at,
      controlExpiresAt: BrowserControlTable.expires_at }).from(V2ToolEffectAdmissionTable)
      .innerJoin(V2ProviderTurnReceiptTable, eq(V2ProviderTurnReceiptTable.receipt_id, V2ToolEffectAdmissionTable.receipt_id))
      .innerJoin(SessionProviderAttemptTable, eq(SessionProviderAttemptTable.attempt_id, V2ToolEffectAdmissionTable.provider_attempt_id))
      .innerJoin(SessionContextSelectionTable, eq(SessionContextSelectionTable.selection_id, SessionProviderAttemptTable.selection_id))
      .innerJoin(SessionProviderOwnerLeaseTable, eq(SessionProviderOwnerLeaseTable.owner_token, V2ToolEffectAdmissionTable.owner_token))
      .innerJoin(SessionTable, eq(SessionTable.id, V2ToolEffectAdmissionTable.session_id))
      .innerJoin(SecurityNamespaceTable, eq(SecurityNamespaceTable.id, SessionContextSelectionTable.security_namespace_id))
      .innerJoin(LocationIdentityTable, and(eq(LocationIdentityTable.security_namespace_id, SecurityNamespaceTable.id), eq(LocationIdentityTable.location_key, scope.locationKey)))
      .innerJoin(ProjectScopeIdentityTable, and(eq(ProjectScopeIdentityTable.security_namespace_id, SecurityNamespaceTable.id), eq(ProjectScopeIdentityTable.project_scope_key, scope.projectScopeKey)))
      .innerJoin(PermissionSavedEpochTable, eq(PermissionSavedEpochTable.project_id, SessionTable.project_id))
      .innerJoin(BrowserControlTable, eq(BrowserControlTable.control_id, entry.input.control.controlID))
      .where(and(eq(V2ToolEffectAdmissionTable.admission_id, admission.admissionId),
        eq(V2ToolEffectAdmissionTable.session_id, admission.sessionId), eq(V2ToolEffectAdmissionTable.receipt_id, admission.receiptId),
        eq(V2ToolEffectAdmissionTable.provider_attempt_id, admission.providerAttemptId), eq(V2ToolEffectAdmissionTable.owner_token, admission.ownerToken),
        eq(V2ToolEffectAdmissionTable.tool_call_id, admission.toolCallId), eq(V2ToolEffectAdmissionTable.tool_name, "browser"),
        eq(V2ToolEffectAdmissionTable.effect_kind, admission.effectKind),
        eq(V2ProviderTurnReceiptTable.session_id, entry.input.context.sessionID), eq(V2ProviderTurnReceiptTable.provider_attempt_id, admission.providerAttemptId),
        eq(V2ProviderTurnReceiptTable.owner_token, admission.ownerToken), inArray(V2ProviderTurnReceiptTable.state, ["streaming", "settled"]),
        // The full capture verified the prepared turn. Original receipt triggers make its
        // non-null JSON and both digests immutable, so each leaf binds only fixed-size hashes.
        sql`${V2ProviderTurnReceiptTable.prepared_turn_hash} IS ${row.preparedTurnHash}`,
        sql`${V2ProviderTurnReceiptTable.wire_request_hash} IS ${row.wireRequestHash}`,
        eq(SessionProviderAttemptTable.session_id, admission.sessionId), eq(SessionProviderAttemptTable.owner_token, admission.ownerToken),
        inArray(SessionProviderAttemptTable.state, ["streaming", "settled"]), eq(SessionProviderAttemptTable.selection_id, row.selectionID),
        eq(SessionProviderAttemptTable.projection_hash, row.projectionHash), eq(SessionProviderAttemptTable.execution_claim_token, row.claim),
        isNull(SessionProviderOwnerLeaseTable.released_at), eq(SessionTable.execution_claim_token, row.claim),
        eq(SessionTable.project_id, entry.input.location.project.id), eq(SessionTable.directory, entry.input.location.directory),
        isNull(SessionTable.workspace_id), eq(SessionTable.v2_authority, true), sql`${SessionTable.permission} IS ${row.permissionRaw}`,
        sql`${SessionTable.parent_id} IS ${row.parentID}`, eq(PermissionSavedEpochTable.epoch, row.savedEpoch),
        eq(SessionContextSelectionTable.selection_id, row.selectionID), eq(SessionContextSelectionTable.session_id, admission.sessionId),
        eq(SessionContextSelectionTable.projection_hash, row.projectionHash), eq(SessionContextSelectionTable.location_key, scope.locationKey),
        sql`${SessionContextSelectionTable.security_namespace_id} = ${scope.securityNamespaceID}`, sql`${SessionContextSelectionTable.project_scope_key} = ${scope.projectScopeKey}`,
        eq(SecurityNamespaceTable.kind, "implicit_local"), eq(SecurityNamespaceTable.binding_hash, scope.namespaceBindingHash), isNull(SecurityNamespaceTable.retired_at),
        eq(LocationIdentityTable.project_scope_key, scope.projectScopeKey), eq(LocationIdentityTable.canonical_root, scope.directory),
        isNull(LocationIdentityTable.workspace_binding), isNull(LocationIdentityTable.retired_at), isNull(ProjectScopeIdentityTable.retired_at),
        sql`${LocationIdentityTable.observed_project_id} IS ${row.observedProjectID}`,
        sql`${ProjectScopeIdentityTable.observed_project_id} IS ${row.observedProjectID}`,
        ...Object.entries(row.control).map(([name, value]) => sql`${sql.identifier("browser_control")}.${sql.identifier(name)} IS ${value}`),
        notExists(db.select({ id: V2ToolEffectTable.effect_id }).from(V2ToolEffectTable)
          .where(and(eq(V2ToolEffectTable.receipt_id, admission.receiptId), eq(V2ToolEffectTable.tool_call_id, admission.toolCallId)))),
      )).get().pipe(Effect.mapError(() => denied()))
    // Re-read the wall clock after the SQL await; heartbeat extension is valid, expiry is not.
    if (!found) return yield* denied()
    yield* localCurrent(entry)
    if (found.leaseExpiresAt <= Date.now() || found.controlExpiresAt <= Date.now()) return yield* denied()
  })
}

function localCurrent(entry: Entry) {
  return Effect.gen(function* () {
    if (!entry.active || !PermissionV2.fileActionsView(entry.actions) || !entry.input.host.alive() ||
      !entry.input.host.verify(entry.input.control).matched) return yield* denied()
    yield* CurrentToolExecution.requireFileFrame(entry.frame)
  })
}

function snapshot(db: Reader, input: Capture, admissionID: string) {
  return db.select({ control: BrowserControlTable, permissionRaw: sql<string | null>`${SessionTable.permission}`,
    savedEpoch: PermissionSavedEpochTable.epoch, parentID: SessionTable.parent_id, claim: SessionProviderAttemptTable.execution_claim_token,
    selectionID: SessionContextSelectionTable.selection_id, projectionHash: SessionContextSelectionTable.projection_hash,
    preparedTurnHash: V2ProviderTurnReceiptTable.prepared_turn_hash, wireRequestHash: V2ProviderTurnReceiptTable.wire_request_hash,
    observedProjectID: LocationIdentityTable.observed_project_id,
  }).from(V2ToolEffectAdmissionTable)
    .innerJoin(V2ProviderTurnReceiptTable, eq(V2ProviderTurnReceiptTable.receipt_id, V2ToolEffectAdmissionTable.receipt_id))
    .innerJoin(SessionProviderAttemptTable, eq(SessionProviderAttemptTable.attempt_id, V2ToolEffectAdmissionTable.provider_attempt_id))
    .innerJoin(SessionContextSelectionTable, eq(SessionContextSelectionTable.selection_id, SessionProviderAttemptTable.selection_id))
    .innerJoin(SessionTable, eq(SessionTable.id, V2ToolEffectAdmissionTable.session_id))
    .innerJoin(PermissionSavedEpochTable, eq(PermissionSavedEpochTable.project_id, SessionTable.project_id))
    .innerJoin(LocationIdentityTable, and(eq(LocationIdentityTable.security_namespace_id, input.control.scope.securityNamespaceID),
      eq(LocationIdentityTable.location_key, input.control.scope.locationKey)))
    .innerJoin(BrowserControlTable, eq(BrowserControlTable.control_id, input.control.controlID))
    .where(eq(V2ToolEffectAdmissionTable.admission_id, admissionID)).get()
}
