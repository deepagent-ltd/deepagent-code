export * as BrowserControl from "./control"

import { and, eq, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import type { Location } from "../location"
import { LocationIdentityTable, ProjectScopeIdentityTable, SecurityNamespaceTable } from "../context-federation/sql"
import { SessionTable } from "../session/sql"
import { SessionSchema } from "../session/schema"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { BrowserSchema } from "./schema"
import { BrowserFileExchange } from "./file-exchange"
import { BrowserControlTable, BrowserActionTable } from "./browser.sql"
import type { V2ToolEffect } from "../session/runner/v2-tool-effect"
import { V2ToolEffectTable } from "../session/runner/v2-tool-effect.sql"
import { SharedBrowserCapacity } from "./shared-capacity"
import { BrowserSharedResourceTable } from "./shared.sql"

type Db = Database.Interface["db"]
type Reader = Pick<Db, "select">
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
export const failure = (code: BrowserSchema.Error["code"]) =>
  new BrowserSchema.Error({ code, message: "Managed browser state is unavailable, changed, or outside its authorized scope" })
export const hash = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))
const query = <A, E>(body: () => Effect.Effect<A, E>) => Effect.suspend(body).pipe(Effect.mapError(() => failure("BROWSER_UNAVAILABLE")))
const transaction = <A, E>(db: Db, body: (tx: Tx) => Effect.Effect<A, E>) =>
  db.transaction(body, { behavior: "immediate" }).pipe(Effect.mapError((error) =>
    error instanceof BrowserSchema.Error ? error : failure("BROWSER_UNAVAILABLE")))

function decode<A>(schema: Schema.Decoder<A>, value: unknown): Effect.Effect<A, BrowserSchema.Error> {
  const decoded = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(value)
  return Option.isSome(decoded) ? Effect.succeed(decoded.value) : Effect.fail(failure("BROWSER_INVALID_RECORD"))
}

/** All reads, including cold and expired history, are SQL-only and never repair a record. */
export const get = Effect.fn("BrowserControl.get")(function* (db: Reader, controlID: string) {
  const size = yield* query(() => db.select({ bytes: sql<number>`length(CAST(${BrowserControlTable.record} AS BLOB))` })
    .from(BrowserControlTable).where(eq(BrowserControlTable.control_id, controlID)).get())
  if (!size) return undefined
  if (!Number.isSafeInteger(size.bytes) || size.bytes < 1 || size.bytes > BrowserSchema.MAX_CONTROL_BYTES)
    return yield* failure("BROWSER_INVALID_RECORD")
  const row = yield* query(() => db.select().from(BrowserControlTable).where(and(eq(BrowserControlTable.control_id, controlID),
    sql`length(CAST(${BrowserControlTable.record} AS BLOB)) BETWEEN 1 AND ${BrowserSchema.MAX_CONTROL_BYTES}`)).get())
  if (!row) return yield* failure("BROWSER_INVALID_RECORD")
  const record = yield* decode(Schema.fromJsonString(BrowserSchema.Control), row.record)
  if (hash(controlColumns(record)) !== hash(row) || record.updatedAt < record.createdAt || record.expiresAt <= record.createdAt ||
    (record.state === "stopped") !== (record.stopConfirmedAt !== null) ||
    (record.cancel !== null && (record.cancel.requestedAt < record.createdAt || record.cancel.expectedRevision >= record.revision)))
    return yield* failure("BROWSER_INVALID_RECORD")
  return record
})

export const getAction = Effect.fn("BrowserControl.getAction")(function* (db: Reader, actionID: string) {
  const size = yield* query(() => db.select({ bytes: sql<number>`length(CAST(${BrowserActionTable.record} AS BLOB))` })
    .from(BrowserActionTable).where(eq(BrowserActionTable.action_id, actionID)).get())
  if (!size) return undefined
  if (!Number.isSafeInteger(size.bytes) || size.bytes < 1 || size.bytes > BrowserSchema.MAX_ACTION_BYTES)
    return yield* failure("BROWSER_INVALID_RECORD")
  const row = yield* query(() => db.select().from(BrowserActionTable).where(and(eq(BrowserActionTable.action_id, actionID),
    sql`length(CAST(${BrowserActionTable.record} AS BLOB)) BETWEEN 1 AND ${BrowserSchema.MAX_ACTION_BYTES}`)).get())
  if (!row) return yield* failure("BROWSER_INVALID_RECORD")
  const record = yield* decode(Schema.fromJsonString(BrowserSchema.Action), row.record)
  if (hash(actionColumns(record)) !== hash(row) || record.updatedAt < record.createdAt || record.deadline <= record.createdAt ||
    (record.outcome === "pending") !== (record.terminalAt === null) ||
    (record.outcome === "completed") !== (record.result !== null) ||
    (record.result !== null && !BrowserSchema.matchesClipboardResult(record.command, record.result)) ||
    (record.result !== null && !BrowserSchema.matchesProgramResult(record.command, record.result)) ||
    (record.result !== null && !BrowserSchema.matchesApiPostResult(record.command, record.result)) ||
    (record.terminalAt !== null && record.terminalAt < record.createdAt)) return yield* failure("BROWSER_INVALID_RECORD")
  return record
})

/** Session.project_id and Context observed_project_id are separate identities (for example a
 * legacy global Session and a registered non-git root). Bind each to its real authority.
 * Registered namespace/placement must still describe the actual Session. Never resolve a
 * missing identity from a GET or dispatch, because resolve may create new authority rows. */
export const requireScope = Effect.fn("BrowserControl.requireScope")(function* (db: Reader, scope: BrowserSchema.Scope, runtime?: Location.Interface) {
  const value = yield* query(() => db.select({ namespace: SecurityNamespaceTable, location: LocationIdentityTable,
    project: ProjectScopeIdentityTable, session: SessionTable }).from(SecurityNamespaceTable)
    .innerJoin(LocationIdentityTable, and(eq(LocationIdentityTable.security_namespace_id, SecurityNamespaceTable.id),
      eq(LocationIdentityTable.location_key, scope.locationKey)))
    .innerJoin(ProjectScopeIdentityTable, and(eq(ProjectScopeIdentityTable.security_namespace_id, SecurityNamespaceTable.id),
      eq(ProjectScopeIdentityTable.project_scope_key, scope.projectScopeKey)))
    .innerJoin(SessionTable, eq(SessionTable.id, SessionSchema.ID.make(scope.sessionID)))
    .where(eq(SecurityNamespaceTable.id, scope.securityNamespaceID)).get())
  if (!value || value.namespace.kind !== "implicit_local" || value.namespace.binding_hash !== scope.namespaceBindingHash ||
    value.namespace.retired_at !== null || value.location.retired_at !== null || value.project.retired_at !== null ||
    value.location.project_scope_key !== scope.projectScopeKey || value.location.canonical_root !== scope.directory ||
    value.location.workspace_binding !== null || value.location.observed_project_id !== value.project.observed_project_id ||
    value.session.project_id !== scope.projectID ||
    (runtime && (runtime.directory !== scope.directory || runtime.workspaceID !== undefined ||
      scope.projectID !== runtime.project.id)) ||
    value.session.directory !== scope.directory || value.session.workspace_id !== null || !value.session.v2_authority)
    return yield* failure("BROWSER_SCOPE_DENIED")
})

export const create = Effect.fn("BrowserControl.create")(function* (db: Db, input: {
  request: BrowserSchema.Create
  scope: BrowserSchema.Scope
  hostID: string
  hostIncarnation: string
  credentialBinding: string
  sharedMainIncarnation?: string
}) {
  yield* decode(BrowserSchema.Create, input.request)
  yield* decode(BrowserSchema.Scope, input.scope)
  return yield* transaction(db, (tx) => Effect.gen(function* () {
    yield* requireScope(tx, input.scope)
    if (input.request.sessionID !== input.scope.sessionID) return yield* failure("BROWSER_SCOPE_DENIED")
    const prior = yield* query(() => tx.select({ id: BrowserControlTable.control_id }).from(BrowserControlTable)
      .where(and(eq(BrowserControlTable.principal, input.scope.principal), eq(BrowserControlTable.session_id, input.scope.sessionID),
        eq(BrowserControlTable.request_id, input.request.requestID))).get())
    if (prior) {
      const record = yield* get(tx, prior.id)
      if (!record || record.requestDigest !== hash(input.request) || hash(record.scope) !== hash(input.scope))
        return yield* failure("BROWSER_CONFLICT")
      return { record, created: false }
    }
    const now = Date.now()
    if (input.request.expiresAt <= now || input.request.expiresAt > now + 3_600_000) return yield* failure("BROWSER_EXPIRED")
    const active = yield* query(() => tx.select({ count: sql<number>`count(*)` }).from(BrowserControlTable)
      .where(and(eq(BrowserControlTable.host_incarnation, input.hostIncarnation),
        sql`${BrowserControlTable.state} IN ('creating','active','cancel_requested','unknown')`)).get())
    const shared = yield* query(() => tx.select({ count: sql<number>`count(*)` }).from(BrowserSharedResourceTable)
      .where(and(eq(BrowserSharedResourceTable.main_incarnation, input.sharedMainIncarnation ?? input.hostIncarnation),
        sql`${BrowserSharedResourceTable.state} NOT IN ('closed','resource_lost')`)).get())
    if (!active || !shared || active.count + shared.count >= BrowserSchema.MAX_ACTIVE_CONTROLS) return yield* failure("BROWSER_CAPACITY")
    const record: BrowserSchema.Control = { version: 1, controlID: crypto.randomUUID(),
      requestID: input.request.requestID, requestDigest: hash(input.request), scope: input.scope,
      hostID: input.hostID, hostIncarnation: input.hostIncarnation, resourceID: crypto.randomUUID(),
      credentialBinding: input.credentialBinding, origin: input.request.origin,
      ...(input.request.profile === BrowserSchema.INTERACTION_PROFILE
        ? { profile: input.request.profile, postPaths: input.request.postPaths,
          ...(input.request.scriptGrants === undefined ? {} : { scriptGrants: input.request.scriptGrants }),
          ...(input.request.programGrants === undefined ? {} : { programGrants: input.request.programGrants }),
          ...(input.request.clipboardPolicy === undefined ? {} : { clipboardPolicy: input.request.clipboardPolicy }) }
        : input.request.profile === BrowserSchema.FILE_EXCHANGE_PROFILE
          ? { profile: input.request.profile, postPaths: input.request.postPaths, filePolicy: input.request.filePolicy }
        : input.request.profile === BrowserSchema.PUBLIC_READONLY_PROFILE
          ? { profile: input.request.profile, approvedOrigins: input.request.approvedOrigins,
            resolverPolicy: input.request.resolverPolicy }
        : input.request.profile === BrowserSchema.PUBLIC_INTERACTION_PROFILE
          ? { profile: input.request.profile, approvedOrigins: input.request.approvedOrigins,
            resolverPolicy: input.request.resolverPolicy, pageMode: input.request.pageMode, postTargets: input.request.postTargets }
        : input.request.profile === BrowserSchema.API_POST_PROFILE
          ? { profile: input.request.profile, approvedOrigins: input.request.approvedOrigins,
            resolverPolicy: input.request.resolverPolicy, pageMode: input.request.pageMode, apiPostTargets: input.request.apiPostTargets }
          : { profile: input.request.profile }),
      revision: 1, epoch: 1, policyRevision: 1, state: "creating", expiresAt: input.request.expiresAt,
      createdAt: now, updatedAt: now, cancel: null, stopConfirmedAt: null }
    yield* encoded(BrowserSchema.Control, record, BrowserSchema.MAX_CONTROL_BYTES - BrowserSchema.TERMINAL_RESERVE_BYTES)
    yield* reserve(tx, "control")
    yield* query(() => tx.insert(BrowserControlTable).values(controlColumns(record)).run())
    return { record, created: true }
  }))
})

/** Lifecycle observations must come from the same live native descriptor. This function is an
 * internal persistence primitive; neither its arguments nor record hashes prove native effects. */
export const observeControl = Effect.fn("BrowserControl.observeControl")(function* (db: Db, prior: BrowserSchema.Control,
  state: "active" | "stopped" | "unknown") {
  return yield* transaction(db, (tx) => Effect.gen(function* () {
    const current = yield* get(tx, prior.controlID)
    if (!current || hash(current) !== hash(prior)) return yield* failure("BROWSER_CONFLICT")
    if (state === "active" && current.state !== "creating") return yield* failure("BROWSER_CONFLICT")
    if (state === "stopped" && current.state !== "cancel_requested") return yield* failure("BROWSER_CONFLICT")
    const record: BrowserSchema.Control = { ...current, state, revision: current.revision + 1, updatedAt: Date.now(),
      stopConfirmedAt: state === "stopped" ? Date.now() : null }
    yield* writeControl(tx, current, record)
    return record
  }))
})

export const cancel = Effect.fn("BrowserControl.cancel")(function* (db: Db, controlID: string,
  scope: BrowserSchema.Scope, input: BrowserSchema.Cancel) {
  yield* decode(BrowserSchema.Cancel, input)
  return yield* transaction(db, (tx) => Effect.gen(function* () {
    yield* requireScope(tx, scope)
    const current = yield* get(tx, controlID)
    if (!current) return yield* failure("BROWSER_NOT_FOUND")
    if (hash(current.scope) !== hash(scope)) return yield* failure("BROWSER_SCOPE_DENIED")
    if (current.cancel) {
      if (current.cancel.requestID !== input.requestID || current.cancel.expectedRevision !== input.expectedRevision)
        return yield* failure("BROWSER_CONFLICT")
      return { record: current, changed: false }
    }
    if (current.revision !== input.expectedRevision || current.state === "stopped") return yield* failure("BROWSER_CONFLICT")
    const now = Date.now()
    const record: BrowserSchema.Control = { ...current, state: "cancel_requested", revision: current.revision + 1,
      epoch: current.epoch + 1, updatedAt: now, cancel: { ...input, requestedAt: now }, stopConfirmedAt: null }
    yield* writeControl(tx, current, record)
    return { record, changed: true }
  }))
})

export const requireActive = Effect.fn("BrowserControl.requireActive")(function* (db: Reader, controlID: string,
  scope: BrowserSchema.Scope, native: { hostID: string; hostIncarnation: string; credentialBinding: string }) {
  const current = yield* get(db, controlID)
  if (!current) return yield* failure("BROWSER_NOT_FOUND")
  if (hash(current.scope) !== hash(scope)) return yield* failure("BROWSER_SCOPE_DENIED")
  yield* requireScope(db, current.scope)
  if (current.hostID !== native.hostID || current.hostIncarnation !== native.hostIncarnation ||
    current.credentialBinding !== native.credentialBinding) return yield* failure("BROWSER_HOST_UNAVAILABLE")
  if (current.cancel || current.state !== "active") return yield* failure("BROWSER_CANCELLED")
  if (current.expiresAt <= Date.now()) return yield* failure("BROWSER_EXPIRED")
  return current
})

export const prepareAction = Effect.fn("BrowserControl.prepareAction")(function* (db: Db, input: {
  control: BrowserSchema.Control; command: BrowserSchema.Command; admission: V2ToolEffect.ToolEffectAdmission; timeoutMs: number
}, current: (tx: Tx) => Effect.Effect<void, BrowserSchema.Error>) {
  return yield* transaction(db, (tx) => Effect.gen(function* () {
    yield* current(tx)
    const control = yield* get(tx, input.control.controlID)
    if (!control || hash(control) !== hash(input.control)) return yield* failure("BROWSER_CONFLICT")
    if ((control.profile === BrowserSchema.PUBLIC_READONLY_PROFILE || control.profile === BrowserSchema.PUBLIC_INTERACTION_PROFILE ||
      control.profile === BrowserSchema.API_POST_PROFILE) &&
      "url" in input.command && input.command.url) {
      if (!URL.canParse(input.command.url)) return yield* failure("BROWSER_NETWORK_DENIED")
      const target = new URL(input.command.url)
      if (target.username || target.password || !control.approvedOrigins.includes(target.origin))
        return yield* failure("BROWSER_NETWORK_DENIED")
    }
    if ("ref" in input.command && control.profile !== BrowserSchema.INTERACTION_PROFILE &&
      control.profile !== BrowserSchema.FILE_EXCHANGE_PROFILE && control.profile !== BrowserSchema.PUBLIC_INTERACTION_PROFILE)
      return yield* failure("BROWSER_SCOPE_DENIED")
    if (input.command.type === "file.upload" || input.command.type === "file.download" || input.command.type === "files.list") {
      if (control.profile !== BrowserSchema.FILE_EXCHANGE_PROFILE) return yield* failure("BROWSER_SCOPE_DENIED")
      if (input.command.type === "file.upload" && !control.filePolicy.upload ||
        input.command.type === "file.download" && !control.filePolicy.download) return yield* failure("BROWSER_SCOPE_DENIED")
    }
    if (input.command.type === "evaluate" && !BrowserSchema.allowsScript(control, input.command))
      return yield* failure("BROWSER_SCOPE_DENIED")
    if (input.command.type === "api.post" && !BrowserSchema.allowsApiPost(control, input.command))
      return yield* failure("BROWSER_SCOPE_DENIED")
    if (input.command.type === "program" && !BrowserSchema.allowsProgram(control, input.command))
      return yield* failure("BROWSER_SCOPE_DENIED")
    if ((input.command.type === "clipboard.read" || input.command.type === "clipboard.write") &&
      !BrowserSchema.allowsClipboard(control, input.command)) return yield* failure("BROWSER_SCOPE_DENIED")
    const prior = yield* query(() => tx.select({ id: BrowserActionTable.action_id }).from(BrowserActionTable)
      .where(eq(BrowserActionTable.admission_id, input.admission.admissionId)).get())
    if (prior) {
      const record = yield* getAction(tx, prior.id)
      if (!record || record.commandDigest !== hash(input.command) || record.controlID !== control.controlID)
        return yield* failure("BROWSER_CONFLICT")
      // Re-entering an admitted call cannot acquire another dispatch. Query the original receipt.
      return yield* failure(record.outcome === "pending" || record.outcome === "unknown" ? "BROWSER_UNKNOWN" : "BROWSER_CONFLICT")
    }
    const pending = yield* query(() => tx.select({ count: sql<number>`count(*)` }).from(BrowserActionTable)
      .where(and(eq(BrowserActionTable.control_id, control.controlID), eq(BrowserActionTable.outcome, "pending"))).get())
    if (!pending || pending.count >= BrowserSchema.MAX_WAITING + 1) return yield* failure("BROWSER_CAPACITY")
    const now = Date.now()
    const record: BrowserSchema.Action = { version: 1, actionID: crypto.randomUUID(), controlID: control.controlID,
      requestID: input.admission.admissionId, commandDigest: hash(input.command), command: input.command,
      admissionID: input.admission.admissionId, providerReceiptID: input.admission.receiptId,
      providerAttemptID: input.admission.providerAttemptId, toolCallID: input.admission.toolCallId,
      sessionID: input.admission.sessionId, hostIncarnation: control.hostIncarnation, resourceID: control.resourceID,
      controlEpoch: control.epoch, policyRevision: control.policyRevision, revision: 1,
      deadline: Math.min(control.expiresAt, now + input.timeoutMs), outcome: "pending", result: null,
      errorCode: null, createdAt: now, updatedAt: now, terminalAt: null, stopConfirmedAt: null }
    yield* encoded(BrowserSchema.Action, record, BrowserSchema.MAX_ACTION_BYTES - BrowserSchema.TERMINAL_RESERVE_BYTES)
    yield* reserve(tx, "action")
    yield* query(() => tx.insert(BrowserActionTable).values(actionColumns(record)).run())
    if (input.command.type === "file.upload" || input.command.type === "file.download") {
      yield* BrowserFileExchange.reserveArtifactsInTransaction(tx, { control, action: record,
        grantIDs: input.command.type === "file.upload" ? input.command.grantIDs : [input.command.grantID] }).pipe(
          Effect.mapError((error) => failure(error.code === "BROWSER_FILE_CAPACITY" ? "BROWSER_CAPACITY" :
            error.code === "BROWSER_FILE_CONFLICT" ? "BROWSER_CONFLICT" : "BROWSER_SCOPE_DENIED")))
    }
    return record
  }))
})

export const observeAction = Effect.fn("BrowserControl.observeAction")(function* (db: Db, prior: BrowserSchema.Action,
  observation: { outcome: Exclude<BrowserSchema.Action["outcome"], "pending">; result?: BrowserSchema.Result;
    errorCode?: BrowserSchema.Error["code"]; stopConfirmed?: boolean }) {
  return yield* transaction(db, (tx) => Effect.gen(function* () {
    const current = yield* getAction(tx, prior.actionID)
    if (!current || hash(current) !== hash(prior)) return yield* failure("BROWSER_CONFLICT")
    if (current.outcome !== "pending") return yield* failure("BROWSER_CONFLICT")
    if ((observation.outcome === "completed") !== (observation.result !== undefined) ||
      (observation.outcome === "completed" && observation.errorCode !== undefined))
      return yield* failure("BROWSER_INVALID_RECORD")
    if (observation.result && !BrowserSchema.matchesClipboardResult(current.command, observation.result))
      return yield* failure("BROWSER_INVALID_RECORD")
    if (observation.result && !BrowserSchema.matchesProgramResult(current.command, observation.result))
      return yield* failure("BROWSER_INVALID_RECORD")
    if (observation.result && !BrowserSchema.matchesApiPostResult(current.command, observation.result))
      return yield* failure("BROWSER_INVALID_RECORD")
    const now = Date.now()
    const record: BrowserSchema.Action = { ...current, outcome: observation.outcome, result: observation.result ?? null,
      errorCode: observation.errorCode ?? null, revision: current.revision + 1, updatedAt: now, terminalAt: now,
      stopConfirmedAt: observation.stopConfirmed ? now : null }
    yield* encoded(BrowserSchema.Action, record, BrowserSchema.MAX_ACTION_BYTES)
    const rows = yield* query(() => tx.update(BrowserActionTable).set(actionColumns(record))
      .where(and(eq(BrowserActionTable.action_id, prior.actionID), eq(BrowserActionTable.revision, prior.revision)))
      .returning({ id: BrowserActionTable.action_id }))
    if (rows.length !== 1) return yield* failure("BROWSER_CONFLICT")
    return record
  }))
})

export const actionView = Effect.fn("BrowserControl.actionView")(function* (db: Reader, action: BrowserSchema.Action, control: BrowserSchema.Control,
  native?: Pick<typeof BrowserSchema.ControlView.Type, "nativeVerification" | "stopConfirmed">) {
  const effect = yield* query(() => db.select({ effectID: V2ToolEffectTable.effect_id, effectState: V2ToolEffectTable.state })
    .from(V2ToolEffectTable).where(and(eq(V2ToolEffectTable.receipt_id, action.providerReceiptID),
      eq(V2ToolEffectTable.tool_call_id, action.toolCallID))).get())
  return { action, effectID: effect?.effectID ?? null, effectState: effect?.effectState ?? null, cancelRequested: control.cancel !== null,
    nativeVerification: native?.nativeVerification ?? "unavailable",
    observedOutcome: action.outcome === "pending" && (native?.nativeVerification !== "verified" || native.stopConfirmed || action.deadline <= Date.now())
      ? "unknown" as const : action.outcome,
    stopConfirmed: native?.nativeVerification === "verified" && native.stopConfirmed }
})

function reserve(tx: Tx, kind: "control" | "action") {
  return SharedBrowserCapacity.reserve(tx, kind).pipe(Effect.mapError(() => failure("BROWSER_CAPACITY")))
}
function encoded<A>(schema: Schema.Decoder<A>, record: A, max: number) {
  return decode(schema, record).pipe(Effect.flatMap(() =>
    Buffer.byteLength(CanonicalJson.stringify(record), "utf8") <= max ? Effect.void : Effect.fail(failure("BROWSER_CAPACITY"))))
}
function writeControl(tx: Tx, prior: BrowserSchema.Control, record: BrowserSchema.Control) {
  return Effect.gen(function* () {
    yield* encoded(BrowserSchema.Control, record, BrowserSchema.MAX_CONTROL_BYTES)
    const rows = yield* query(() => tx.update(BrowserControlTable).set(controlColumns(record))
      .where(and(eq(BrowserControlTable.control_id, prior.controlID), eq(BrowserControlTable.revision, prior.revision)))
      .returning({ id: BrowserControlTable.control_id }))
    if (rows.length !== 1) return yield* failure("BROWSER_CONFLICT")
  })
}
function controlColumns(record: BrowserSchema.Control) {
  return { control_id: record.controlID, request_id: record.requestID, request_digest: record.requestDigest,
    principal: record.scope.principal, security_namespace_id: record.scope.securityNamespaceID,
    location_key: record.scope.locationKey, project_scope_key: record.scope.projectScopeKey,
    namespace_binding_hash: record.scope.namespaceBindingHash, session_id: record.scope.sessionID,
    project_id: record.scope.projectID, directory: record.scope.directory, host_id: record.hostID,
    host_incarnation: record.hostIncarnation, resource_id: record.resourceID, credential_binding: record.credentialBinding,
    profile: record.profile, origin: record.origin, revision: record.revision, epoch: record.epoch,
    policy_revision: record.policyRevision, state: record.state, expires_at: record.expiresAt,
    record: CanonicalJson.stringify(record), record_hash: hash(record), created_at: record.createdAt, updated_at: record.updatedAt }
}
function actionColumns(record: BrowserSchema.Action) {
  return { action_id: record.actionID, control_id: record.controlID, request_id: record.requestID,
    command_digest: record.commandDigest, admission_id: record.admissionID, provider_receipt_id: record.providerReceiptID,
    provider_attempt_id: record.providerAttemptID, tool_call_id: record.toolCallID, session_id: record.sessionID,
    host_incarnation: record.hostIncarnation, resource_id: record.resourceID, control_epoch: record.controlEpoch,
    policy_revision: record.policyRevision, revision: record.revision, deadline: record.deadline, outcome: record.outcome,
    record: CanonicalJson.stringify(record), record_hash: hash(record), created_at: record.createdAt, updated_at: record.updatedAt }
}
