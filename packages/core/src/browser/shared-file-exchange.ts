export * as SharedBrowserFileExchange from "./shared-file-exchange"

import { and, asc, eq, gt, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { CanonicalJson } from "../util/canonical-json"
import { BrowserControl } from "./control"
import { BrowserSchema } from "./schema"
import { BrowserFileCapability } from "./file-capability"
import { BrowserFileExchange } from "./file-exchange"
import { BrowserFileSchema } from "./file-exchange.schema"
import { BrowserFileGrantTable, BrowserFileArtifactTable } from "./browser-file.sql"
import { SharedBrowserControl } from "./shared-control"
import { SharedBrowserSchema } from "./shared-schema"
import { SharedBrowserFileSchema } from "./shared-file-schema"
import { SharedBrowserFileBinding } from "./shared-file-binding"

type Db = Database.Interface["db"]
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Pick<Db, "select">
const hash = BrowserFileExchange.hash
const failure = BrowserFileExchange.failure
const installed = Effect.gen(function* () {
  const native = yield* Effect.serviceOption(BrowserFileCapability.Service)
  if (Option.isNone(native) || !native.value.shared) return yield* failure()
  return { native: native.value, shared: native.value.shared }
})
declare const captured: unique symbol
export interface Capture { readonly [captured]: true }
const captures = new WeakMap<Capture, { db: Db; files: BrowserFileCapability.Shared; native: BrowserFileCapability.Preview;
  resource: SharedBrowserSchema.Resource; lease: SharedBrowserSchema.Lease; request: SharedBrowserFileSchema.PreviewRequest;
  preview: SharedBrowserFileSchema.Preview; used: boolean; approval?: { hash: string; handle: BrowserFileCapability.Approval };
  cancellation?: { hash: string; value: SharedBrowserFileSchema.Cancellation } }>()

/** SQL facts never establish current Main custody; the installed factory brackets these with its live probe. */
function current(db: Reader, resourceID: string, scope: BrowserSchema.Scope) {
  return Effect.gen(function* () {
    yield* BrowserControl.requireScope(db, scope).pipe(preserve)
    const active = yield* SharedBrowserControl.requireActive(db, resourceID, scope).pipe(preserve)
    if (active.lease.resourceID !== active.resource.resourceID || active.resource.expiresAt <= Date.now())
      return yield* failure("BROWSER_FILE_CHANGED")
    return active
  })
}
function permits(resource: SharedBrowserSchema.Resource, request: SharedBrowserFileSchema.PreviewRequest) {
  return !!resource.policy.filePolicy?.[request.direction] && resource.policy.approvedOrigins.includes(new URL(request.targetURL).origin)
}
export const preview = Effect.fn("SharedBrowserFileExchange.preview")(function* (db: Db, input: {
  resourceID: string; scope: BrowserSchema.Scope; request: SharedBrowserFileSchema.PreviewRequest
}) {
  const request = yield* checked(SharedBrowserFileSchema.PreviewRequest, input.request)
  const active = yield* current(db, input.resourceID, input.scope)
  if (!permits(active.resource, request)) return yield* failure("BROWSER_FILE_SCOPE_DENIED")
  const files = (yield* installed).shared
  const handle = yield* files.preview({ ...active, request })
  const description = yield* checked(SharedBrowserFileSchema.Preview, files.describePreview(handle, { ...active, request }))
  const binding = SharedBrowserFileBinding.from(active.resource, active.lease)
  if (description.bindingHash !== hash(binding) || hash(description.binding) !== hash(binding) ||
    description.relative !== request.relative || description.direction !== request.direction || description.targetURL !== request.targetURL ||
    (request.direction === "download" && (description.direction !== "download" || description.maxBytes !== request.maxBytes)))
    return yield* failure("BROWSER_FILE_CHANGED")
  yield* bounded(SharedBrowserFileSchema.Preview, description, BrowserFileSchema.MAX_RECORD_BYTES - BrowserFileSchema.TERMINAL_RESERVE_BYTES)
  const capture = Object.freeze({}) as Capture
  captures.set(capture, { db, files, native: handle, ...active, request, preview: description, used: false })
  return capture
}, preserve)
export const describePreview = (handle: Capture) => captures.get(handle)?.preview
export const confirm = Effect.fn("SharedBrowserFileExchange.confirm")(function* (db: Db, handle: Capture, input: SharedBrowserFileSchema.Approve) {
  const command = yield* checked(SharedBrowserFileSchema.Approve, input)
  const capture = captures.get(handle)
  if (!capture || capture.db !== db || capture.used) return yield* failure("BROWSER_FILE_CHANGED")
  if (capture.cancellation) {
    if (capture.cancellation.hash !== hash(command)) return yield* failure("BROWSER_FILE_CONFLICT")
    return capture.cancellation.value
  }
  if (capture.approval) {
    if (capture.approval.hash !== hash(command)) return yield* failure("BROWSER_FILE_CONFLICT")
    return
  }
  const active = yield* current(db, capture.resource.resourceID, capture.resource.scope)
  yield* matchesApproval(active, capture, command)
  yield* capture.files.currentPreview(capture.native)
  const approved = yield* capture.files.confirm(capture.native, command)
  if ("kind" in approved) {
    const decision = yield* checked(SharedBrowserFileSchema.Cancellation, approved)
    if (!cancellationMatches(capture, command, decision)) return yield* failure("BROWSER_FILE_CHANGED")
    capture.cancellation = { hash: hash(command), value: decision }
    return decision
  }
  if (!capture.files.approved(approved, capture.native, command)) return yield* failure("BROWSER_FILE_SCOPE_DENIED")
  capture.approval = { hash: hash(command), handle: approved }
}, preserve)
export const cancellation = Effect.fn("SharedBrowserFileExchange.cancellation")(function* (db: Db, handle: Capture,
  input: SharedBrowserFileSchema.Approve) {
  const command = yield* checked(SharedBrowserFileSchema.Approve, input)
  const capture = captures.get(handle)
  if (!capture || capture.db !== db || capture.used) return undefined
  yield* BrowserControl.requireScope(db, capture.resource.scope).pipe(preserve)
  if (capture.cancellation) {
    if (capture.cancellation.hash !== hash(command)) return yield* failure("BROWSER_FILE_CONFLICT")
    return capture.cancellation.value
  }
  if (!capture.files.cancellation || capture.files !== (yield* installed).shared) return undefined
  const observed = yield* capture.files.cancellation(capture.native, command)
  if (!observed) return undefined
  const decision = yield* checked(SharedBrowserFileSchema.Cancellation, observed)
  if (!cancellationMatches(capture, command, decision)) return yield* failure("BROWSER_FILE_CHANGED")
  capture.cancellation = { hash: hash(command), value: decision }
  return decision
}, preserve)
function cancellationMatches(capture: { resource: SharedBrowserSchema.Resource; preview: SharedBrowserFileSchema.Preview },
  command: SharedBrowserFileSchema.Approve, decision: SharedBrowserFileSchema.Cancellation) {
  return decision.resourceID === capture.resource.resourceID && decision.requestID === command.requestID &&
    decision.bindingHash === capture.preview.bindingHash && decision.previewHash === hash(capture.preview) &&
    decision.commandHash === hash(command) && decision.cancelledAt >= capture.preview.observedAt &&
    decision.cancelledAt <= command.expiresAt && decision.cancelledAt <= Date.now()
}
export const approve = Effect.fn("SharedBrowserFileExchange.approve")(function* (db: Db, input: {
  resourceID: string; scope: BrowserSchema.Scope; command: SharedBrowserFileSchema.Approve
}, handle?: Capture) {
  const command = yield* checked(SharedBrowserFileSchema.Approve, input.command)
  const prior = yield* requestGrant(db, { ...input, requestID: command.requestID })
  if (prior) {
    if (prior.commandHash !== hash(command)) return yield* failure("BROWSER_FILE_CONFLICT")
    return { grant: prior, replayed: true }
  }
  const capture = handle && captures.get(handle)
  const files = (yield* installed).shared
  if (!capture || capture.db !== db || capture.used || capture.files !== files || !capture.approval ||
    capture.resource.resourceID !== input.resourceID || hash(capture.resource.scope) !== hash(input.scope) ||
    capture.approval.hash !== hash(command) || !files.approved(capture.approval.handle, capture.native, command))
    return yield* failure("BROWSER_FILE_SCOPE_DENIED")
  yield* files.currentPreview(capture.native)
  const confirmation = yield* checked(BrowserFileSchema.Confirmation, files.describeApproval(capture.approval.handle))
  if (confirmation.previewHash !== hash(capture.preview) || confirmation.commandHash !== hash(command) ||
    confirmation.confirmedAt < capture.preview.observedAt || confirmation.confirmedAt > Date.now()) return yield* failure("BROWSER_FILE_CHANGED")
  const result = yield* transaction(db, (tx) => Effect.gen(function* () {
    const active = yield* current(tx, input.resourceID, input.scope)
    yield* matchesApproval(active, capture, command)
    const existing = yield* requestGrant(tx, { ...input, requestID: command.requestID })
    if (existing) {
      if (existing.commandHash !== hash(command)) return yield* failure("BROWSER_FILE_CONFLICT")
      return { grant: existing, replayed: true }
    }
    const count = yield* tx.select({ n: sql<number>`count(*)` }).from(BrowserFileGrantTable)
      .where(eq(BrowserFileGrantTable.shared_resource_id, input.resourceID)).get()
    if (!count || count.n >= BrowserFileSchema.MAX_GRANTS_PER_CONTROL) return yield* failure("BROWSER_FILE_CAPACITY")
    const grant: SharedBrowserFileSchema.Grant = { version: 2, binding: capture.preview.binding, bindingHash: capture.preview.bindingHash,
      grantID: crypto.randomUUID(), instanceID: capture.preview.instanceID, scopeHash: hash(input.scope), command, commandHash: hash(command),
      preview: capture.preview, confirmation, expiresAt: command.expiresAt, createdAt: Date.now() }
    yield* bounded(SharedBrowserFileSchema.Grant, grant)
    yield* BrowserFileExchange.reserveCapacityInTransaction(tx, grant.instanceID, { grants: 1, artifacts: 0, body: 0 })
    yield* tx.insert(BrowserFileGrantTable).values(grantColumns(grant)).run()
    return { grant, replayed: false }
  }))
  if (!result.replayed) {
    capture.used = true
    if (!files.acceptGrant(capture.native, capture.approval.handle, result.grant)) return yield* failure("BROWSER_FILE_CHANGED")
  }
  return result
}, preserve)
function matchesApproval(active: { resource: SharedBrowserSchema.Resource; lease: SharedBrowserSchema.Lease },
  capture: { resource: SharedBrowserSchema.Resource; lease: SharedBrowserSchema.Lease; request: SharedBrowserFileSchema.PreviewRequest },
  command: SharedBrowserFileSchema.Approve) {
  return hash(active.resource) === hash(capture.resource) && hash(active.lease) === hash(capture.lease) &&
    command.expectedResourceRevision === active.resource.revision && command.expectedLeaseID === active.lease.leaseID &&
    command.expectedLeaseEpoch === active.lease.leaseEpoch && command.expectedManualEpoch === active.resource.manualEpoch &&
    command.expiresAt > Date.now() && command.expiresAt <= Math.min(active.resource.expiresAt, active.lease.expiresAt) &&
    permits(active.resource, capture.request) ? Effect.void : Effect.fail(failure("BROWSER_FILE_CHANGED"))
}
export const requestGrant = Effect.fn("SharedBrowserFileExchange.requestGrant")(function* (db: Reader, input: {
  resourceID: string; scope: BrowserSchema.Scope; requestID: string
}) {
  yield* BrowserControl.requireScope(db, input.scope).pipe(preserve)
  const resource = yield* SharedBrowserControl.get(db, input.resourceID).pipe(preserve)
  if (!resource || hash(resource.scope) !== hash(input.scope)) return yield* failure("BROWSER_FILE_SCOPE_DENIED")
  const row = yield* db.select({ id: BrowserFileGrantTable.grant_id }).from(BrowserFileGrantTable).where(and(
    eq(BrowserFileGrantTable.binding_version, 2), eq(BrowserFileGrantTable.shared_resource_id, input.resourceID),
    eq(BrowserFileGrantTable.request_id, input.requestID))).get().pipe(preserve)
  return row ? yield* getGrant(db, row.id) : undefined
}, preserve)
export const getGrant = Effect.fn("SharedBrowserFileExchange.getGrant")(function* (db: Reader, id: string) {
  const row = yield* sized(db, BrowserFileGrantTable, BrowserFileGrantTable.grant_id, id)
  if (!row) return undefined
  const record = yield* checked(Schema.fromJsonString(SharedBrowserFileSchema.Grant), row.record)
  if (hash(grantColumns(record)) !== hash(row) || record.bindingHash !== hash(record.binding) ||
    hash(record.preview.binding) !== hash(record.binding) || record.commandHash !== hash(record.command) ||
    record.confirmation.commandHash !== record.commandHash || record.confirmation.previewHash !== hash(record.preview) ||
    record.confirmation.confirmedAt < record.preview.observedAt || record.confirmation.confirmedAt > record.createdAt)
    return yield* failure("BROWSER_FILE_INVALID")
  return record
}, preserve)
export const getArtifact = Effect.fn("SharedBrowserFileExchange.getArtifact")(function* (db: Reader, id: string) {
  const row = yield* sized(db, BrowserFileArtifactTable, BrowserFileArtifactTable.artifact_id, id)
  if (!row) return undefined
  const record = yield* checked(Schema.fromJsonString(SharedBrowserFileSchema.Artifact), row.record)
  if (hash(artifactColumns(record)) !== hash(row) || record.bindingHash !== hash(record.binding) ||
    hash(record.manifest.binding) !== hash(record.binding) ||
    (record.publication && !BrowserFileExchange.publicationMatches(record, record.publication)) ||
    (["selected", "published"].includes(record.state) && record.publication?.outcome !== record.state) ||
    (record.releasedAt !== null && (!["selected", "published", "refused"].includes(record.state) || record.reservedBytes !== 0 ||
      record.stopConfirmedAt === null || record.releasedAt < record.createdAt || record.releasedAt > record.updatedAt)))
    return yield* failure("BROWSER_FILE_INVALID")
  return record
}, preserve)
export const grantArtifact = Effect.fn("SharedBrowserFileExchange.grantArtifact")(function* (db: Reader, grantID: string) {
  const row = yield* db.select({ id: BrowserFileArtifactTable.artifact_id }).from(BrowserFileArtifactTable)
    .where(and(eq(BrowserFileArtifactTable.binding_version, 2), eq(BrowserFileArtifactTable.grant_id, grantID))).get().pipe(preserve)
  return row ? yield* getArtifact(db, row.id) : undefined
}, preserve)
export const requireGrant = Effect.fn("SharedBrowserFileExchange.requireGrant")(function* (db: Reader,
  resource: SharedBrowserSchema.Resource, lease: SharedBrowserSchema.Lease, id: string) {
  const grant = yield* getGrant(db, id)
  const binding = SharedBrowserFileBinding.from(resource, lease)
  if (!grant || grant.bindingHash !== hash(binding) || hash(grant.binding) !== hash(binding) || grant.expiresAt <= Date.now() ||
    grant.expiresAt > Math.min(resource.expiresAt, lease.expiresAt) || !permits(resource, grant.preview))
    return yield* failure("BROWSER_FILE_SCOPE_DENIED")
  return grant
}, preserve)
/** Same action transaction and capacity meter as v1; no Native/helper/network work occurs here. */
export const reserveArtifactsInTransaction = Effect.fn("SharedBrowserFileExchange.reserveArtifactsInTransaction")(function* (tx: Tx, input: {
  resource: SharedBrowserSchema.Resource; lease: SharedBrowserSchema.Lease; action: SharedBrowserSchema.ActionRecord; grantIDs: readonly string[]
}) {
  const ids = yield* checked(BrowserFileSchema.GrantIDs, input.grantIDs)
  const active = yield* current(tx, input.resource.resourceID, input.resource.scope)
  const action = yield* SharedBrowserControl.getAction(tx, input.action.actionID).pipe(preserve)
  if (hash(active.resource) !== hash(input.resource) || hash(active.lease) !== hash(input.lease) || !action || hash(action) !== hash(input.action) ||
    action.outcome !== "pending" || action.resourceID !== active.resource.resourceID || action.leaseID !== active.lease.leaseID ||
    action.leaseEpoch !== active.lease.leaseEpoch || action.manualEpoch !== active.resource.manualEpoch ||
    action.rootSessionID !== active.resource.rootSessionID || action.deadline <= Date.now()) return yield* failure("BROWSER_FILE_CHANGED")
  const grants = yield* Effect.forEach(ids, (id) => requireGrant(tx, active.resource, active.lease, id))
  if (new Set(grants.map((grant) => grant.instanceID)).size !== 1 || new Set(grants.map((grant) => grant.preview.direction)).size !== 1 ||
    (grants[0]!.preview.direction === "download" && grants.length !== 1) ||
    (action.command.type === "file.upload" ? grants[0]!.preview.direction !== "upload" || hash(action.command.grantIDs) !== hash(ids) :
      action.command.type !== "file.download" || grants[0]!.preview.direction !== "download" || action.command.grantID !== ids[0]))
    return yield* failure("BROWSER_FILE_SCOPE_DENIED")
  const artifacts = yield* Effect.forEach(grants, (grant, ordinal) => Effect.gen(function* () {
    if (yield* tx.select({ id: BrowserFileArtifactTable.artifact_id }).from(BrowserFileArtifactTable)
      .where(eq(BrowserFileArtifactTable.grant_id, grant.grantID)).get()) return yield* failure("BROWSER_FILE_UNKNOWN")
    const now = Date.now()
    const artifact: SharedBrowserFileSchema.Artifact = { version: 2, binding: grant.binding, bindingHash: grant.bindingHash,
      artifactID: crypto.randomUUID(), instanceID: grant.instanceID, grantID: grant.grantID, grantHash: hash(grant),
      actionID: action.actionID, admissionID: action.admissionID, providerReceiptID: action.providerReceiptID,
      providerAttemptID: action.providerAttemptID, toolCallID: action.toolCallID, sessionID: action.rootSessionID, scopeHash: hash(active.resource.scope),
      ordinal, manifest: grant.preview, state: "reserved", revision: 1,
      reservedBytes: Math.max(1, 2 * (grant.preview.direction === "upload" ? grant.preview.bytes : grant.preview.maxBytes)),
      publication: null, stopConfirmedAt: null, releasedAt: null, createdAt: now, updatedAt: now }
    yield* bounded(SharedBrowserFileSchema.Artifact, artifact, BrowserFileSchema.MAX_RECORD_BYTES - BrowserFileSchema.TERMINAL_RESERVE_BYTES)
    return artifact
  }))
  yield* BrowserFileExchange.reserveCapacityInTransaction(tx, grants[0]!.instanceID,
    { grants: 0, artifacts: artifacts.length, body: artifacts.reduce((sum, artifact) => sum + artifact.reservedBytes, 0) })
  yield* Effect.forEach(artifacts, (artifact) => tx.insert(BrowserFileArtifactTable).values(artifactColumns(artifact)).run())
  return { grants, artifacts }
}, preserve)
export const actionFiles = Effect.fn("SharedBrowserFileExchange.actionFiles")(function* (db: Reader, action: SharedBrowserSchema.Action) {
  const original = yield* SharedBrowserControl.getAction(db, action.actionID).pipe(preserve)
  const immutable = original && Schema.decodeUnknownOption(SharedBrowserSchema.Action)(original)
  const expected = Schema.decodeUnknownOption(SharedBrowserSchema.Action)(action)
  if (!original || original.outcome !== "pending" || original.deadline <= Date.now() || !immutable || Option.isNone(immutable) ||
    Option.isNone(expected) || hash(immutable.value) !== hash(expected.value)) return yield* failure("BROWSER_FILE_CHANGED")
  const rows = yield* db.select({ id: BrowserFileArtifactTable.artifact_id }).from(BrowserFileArtifactTable)
    .where(eq(BrowserFileArtifactTable.shared_action_id, action.actionID)).orderBy(asc(BrowserFileArtifactTable.ordinal)).limit(5).pipe(preserve)
  if (rows.length < 1 || rows.length > BrowserFileSchema.MAX_FILES) return yield* failure("BROWSER_FILE_INVALID")
  return yield* Effect.forEach(rows, (row, ordinal) => Effect.gen(function* () {
    const artifact = yield* getArtifact(db, row.id)
    const grant = artifact && (yield* getGrant(db, artifact.grantID))
    if (!artifact || !grant || artifact.ordinal !== ordinal || artifact.actionID !== action.actionID || artifact.admissionID !== action.admissionID ||
      artifact.providerReceiptID !== action.providerReceiptID || artifact.providerAttemptID !== action.providerAttemptID || artifact.toolCallID !== action.toolCallID ||
      artifact.sessionID !== action.rootSessionID || artifact.binding.resourceID !== action.resourceID || artifact.binding.leaseID !== action.leaseID ||
      artifact.binding.leaseEpoch !== action.leaseEpoch || artifact.binding.manualEpoch !== action.manualEpoch || artifact.grantHash !== hash(grant) ||
      artifact.bindingHash !== grant.bindingHash || hash(artifact.binding) !== hash(grant.binding) || hash(artifact.manifest) !== hash(grant.preview))
      return yield* failure("BROWSER_FILE_CHANGED")
    return { grant, artifact }
  }))
}, preserve)
export const list = Effect.fn("SharedBrowserFileExchange.list")(function* (db: Reader, input: {
  resourceID: string; scope: BrowserSchema.Scope; cursor?: string; limit?: number
}) {
  yield* BrowserControl.requireScope(db, input.scope).pipe(preserve)
  const resource = yield* SharedBrowserControl.get(db, input.resourceID).pipe(preserve)
  if (!resource || hash(resource.scope) !== hash(input.scope)) return yield* failure("BROWSER_FILE_SCOPE_DENIED")
  const limit = input.limit ?? BrowserFileSchema.MAX_FILES
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > BrowserFileSchema.MAX_FILES ||
    (input.cursor !== undefined && Option.isNone(Schema.decodeUnknownOption(BrowserFileSchema.ID)(input.cursor)))) return yield* failure("BROWSER_FILE_INVALID")
  const rows = yield* db.select({ id: BrowserFileGrantTable.grant_id }).from(BrowserFileGrantTable).where(and(
    eq(BrowserFileGrantTable.binding_version, 2), eq(BrowserFileGrantTable.shared_resource_id, input.resourceID),
    input.cursor === undefined ? undefined : gt(BrowserFileGrantTable.grant_id, input.cursor)))
    .orderBy(asc(BrowserFileGrantTable.grant_id)).limit(limit + 1).pipe(preserve)
  const records = yield* Effect.forEach(rows.slice(0, limit), (row) => Effect.gen(function* () {
    const grant = yield* getGrant(db, row.id)
    if (!grant || grant.scopeHash !== hash(input.scope)) return yield* failure("BROWSER_FILE_INVALID")
    return { grant, artifact: yield* grantArtifact(db, grant.grantID) }
  }))
  return { records, nextCursor: rows.length > limit ? rows[limit - 1]!.id : null }
}, preserve)
export const observed = Effect.fn("SharedBrowserFileExchange.observed")(function* (db: Db, prior: SharedBrowserFileSchema.Artifact,
  observation: BrowserFileCapability.Observation) {
  const native = yield* Effect.serviceOption(BrowserFileCapability.Service)
  if (Option.isNone(native)) return yield* failure()
  const publication = yield* checked(BrowserFileSchema.Publication, native.value.describe(observation))
  if (!BrowserFileExchange.publicationMatches(prior, publication)) return yield* failure("BROWSER_FILE_CHANGED")
  return yield* transition(db, prior, publication.outcome, publication)
}, preserve)
export const unknown = (db: Db, prior: SharedBrowserFileSchema.Artifact) => transition(db, prior, "unknown")
export const staged = (db: Db, prior: SharedBrowserFileSchema.Artifact) => transition(db, prior, "staged")
export const refused = (db: Db, prior: SharedBrowserFileSchema.Artifact) => transition(db, prior, "refused")
export const released = Effect.fn("SharedBrowserFileExchange.released")(function* (db: Db, priors: readonly SharedBrowserFileSchema.Artifact[],
  confirmation: BrowserFileCapability.Released) {
  const native = yield* Effect.serviceOption(BrowserFileCapability.Service)
  const ids = Option.isSome(native) ? native.value.describeReleased(confirmation) : undefined
  if (!ids || ids.length !== priors.length || new Set(ids).size !== ids.length || priors.some((prior) => !ids.includes(prior.artifactID)))
    return yield* failure("BROWSER_FILE_CHANGED")
  return yield* transaction(db, (tx) => Effect.forEach(priors, (prior) => Effect.gen(function* () {
    const actual = yield* getArtifact(tx, prior.artifactID)
    if (!actual || hash(actual) !== hash(prior) || actual.releasedAt !== null || !["selected", "published", "refused"].includes(actual.state))
      return yield* failure("BROWSER_FILE_UNKNOWN")
    const action = yield* SharedBrowserControl.getAction(tx, actual.actionID).pipe(preserve)
    if (!action || action.outcome === "pending" || action.outcome === "unknown") return yield* failure("BROWSER_FILE_UNKNOWN")
    const now = Date.now()
    const next = { ...actual, revision: actual.revision + 1, updatedAt: now, stopConfirmedAt: now, releasedAt: now, reservedBytes: 0 }
    yield* writeArtifact(tx, actual, next)
    const meter = yield* BrowserFileExchange.readCapacityInTransaction(tx, actual.instanceID)
    if (meter.reserved_bytes < actual.reservedBytes + meter.metadata_bytes) return yield* failure("BROWSER_FILE_INVALID")
    yield* BrowserFileExchange.writeCapacityInTransaction(tx, meter, { ...meter, reserved_bytes: meter.reserved_bytes - actual.reservedBytes })
    return next
  })))
}, preserve)
function transition(db: Db, prior: SharedBrowserFileSchema.Artifact, state: SharedBrowserFileSchema.Artifact["state"], publication?: BrowserFileSchema.Publication) {
  return transaction(db, (tx) => Effect.gen(function* () {
    const actual = yield* getArtifact(tx, prior.artifactID)
    if (!actual || hash(actual) !== hash(prior) || actual.releasedAt !== null || !["reserved", "staged"].includes(actual.state) ||
      (state === "staged" && actual.state !== "reserved")) return yield* failure("BROWSER_FILE_CONFLICT")
    const next = { ...actual, state, publication: publication ?? null, revision: actual.revision + 1, updatedAt: Date.now() }
    yield* writeArtifact(tx, actual, next)
    return next
  }))
}
function writeArtifact(tx: Tx, prior: SharedBrowserFileSchema.Artifact, next: SharedBrowserFileSchema.Artifact) {
  return Effect.gen(function* () {
    yield* bounded(SharedBrowserFileSchema.Artifact, next)
    const changed = yield* tx.update(BrowserFileArtifactTable).set(artifactColumns(next)).where(and(
      eq(BrowserFileArtifactTable.artifact_id, prior.artifactID), eq(BrowserFileArtifactTable.revision, prior.revision),
      eq(BrowserFileArtifactTable.binding_version, 2))).returning({ id: BrowserFileArtifactTable.artifact_id })
    if (changed.length !== 1) return yield* failure("BROWSER_FILE_CONFLICT")
  })
}
function grantColumns(record: SharedBrowserFileSchema.Grant) {
  return { grant_id: record.grantID, instance_id: record.instanceID, binding_version: 2,
    control_id: null, control_epoch: null, policy_revision: null, shared_resource_id: record.binding.resourceID, shared_lease_id: record.binding.leaseID,
    request_id: record.command.requestID, command_hash: record.commandHash, scope_hash: record.scopeHash, direction: record.preview.direction,
    expires_at: record.expiresAt, record: CanonicalJson.stringify(record), record_hash: hash(record), created_at: record.createdAt }
}
function artifactColumns(record: SharedBrowserFileSchema.Artifact) {
  return { artifact_id: record.artifactID, instance_id: record.instanceID, grant_id: record.grantID, grant_hash: record.grantHash,
    binding_version: 2, action_id: null, control_id: null, shared_resource_id: record.binding.resourceID, shared_lease_id: record.binding.leaseID,
    shared_action_id: record.actionID, scope_hash: record.scopeHash, ordinal: record.ordinal, state: record.state, revision: record.revision,
    reserved_bytes: record.reservedBytes, record: CanonicalJson.stringify(record), record_hash: hash(record),
    created_at: record.createdAt, updated_at: record.updatedAt, released_at: record.releasedAt }
}
function checked<A>(schema: Schema.Decoder<A>, input: unknown): Effect.Effect<A, BrowserFileSchema.Error> {
  const result = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(input)
  return Option.isSome(result) ? Effect.succeed(result.value) : Effect.fail(failure("BROWSER_FILE_INVALID"))
}
function bounded<A>(schema: Schema.Decoder<A>, input: A, max = BrowserFileSchema.MAX_RECORD_BYTES) {
  return checked(schema, input).pipe(Effect.flatMap(() => Buffer.byteLength(CanonicalJson.stringify(input)) <= max ? Effect.void :
    Effect.fail(failure("BROWSER_FILE_CAPACITY"))))
}
function preserve<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.catch((error) => Effect.fail(error instanceof BrowserFileSchema.Error ? error : failure())))
}
const transaction = <A, E>(db: Db, body: (tx: Tx) => Effect.Effect<A, E>) => db.transaction(body, { behavior: "immediate" }).pipe(preserve)
function sized<T extends typeof BrowserFileGrantTable | typeof BrowserFileArtifactTable>(db: Reader, table: T,
  column: T extends typeof BrowserFileGrantTable ? typeof BrowserFileGrantTable.grant_id : typeof BrowserFileArtifactTable.artifact_id, id: string) {
  return Effect.gen(function* () {
    const size = yield* db.select({ bytes: sql<number>`length(CAST(${table.record} AS BLOB))` }).from(table).where(and(eq(column, id), eq(table.binding_version, 2))).get()
    if (!size) return undefined
    if (!Number.isSafeInteger(size.bytes) || size.bytes < 1 || size.bytes > BrowserFileSchema.MAX_RECORD_BYTES) return yield* failure("BROWSER_FILE_INVALID")
    return yield* db.select().from(table).where(and(eq(column, id), eq(table.binding_version, 2), sql`length(CAST(${table.record} AS BLOB)) BETWEEN 1 AND 8192`)).get()
  })
}
