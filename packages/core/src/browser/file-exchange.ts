export * as BrowserFileExchange from "./file-exchange"

import { and, asc, eq, gt, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { BrowserControl } from "./control"
import { BrowserSchema } from "./schema"
import { BrowserFileCapability } from "./file-capability"
import { BrowserFileSchema } from "./file-exchange.schema"
import { BrowserFileGrantTable, BrowserFileArtifactTable, BrowserFileCapacityTable } from "./browser-file.sql"

type Db = Database.Interface["db"]
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Pick<Db, "select">
export const hash = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))
export const failure = (code: BrowserFileSchema.Error["code"] = "BROWSER_FILE_UNAVAILABLE") =>
  new BrowserFileSchema.Error({ code, message: "Browser file custody or its explicit current approval is unavailable or changed" })
const metadataReservation = BrowserFileSchema.MAX_RECORD_BYTES + BrowserFileSchema.ROW_OVERHEAD_BYTES
const native = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(BrowserFileCapability.Service)
  if (Option.isNone(service)) return yield* failure()
  return service.value
})
declare const captured: unique symbol
export interface Capture { readonly [captured]: true }
const captures = new WeakMap<Capture, { db: Db; files: BrowserFileCapability.Interface; native: BrowserFileCapability.Preview;
  control: BrowserSchema.Control; request: BrowserFileSchema.PreviewRequest; preview: BrowserFileSchema.Preview;
  used: boolean; confirmation?: { commandHash: string; handle: BrowserFileCapability.Approval } }>()

function checked<A>(schema: Schema.Decoder<A>, input: unknown): Effect.Effect<A, BrowserFileSchema.Error> {
  const decoded = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(input)
  return Option.isSome(decoded) ? Effect.succeed(decoded.value) : Effect.fail(failure("BROWSER_FILE_INVALID"))
}
function preserve<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.catch((error) => Effect.fail(error instanceof BrowserFileSchema.Error ? error : failure())))
}
const transaction = <A, E>(db: Db, body: (tx: Tx) => Effect.Effect<A, E>) =>
  db.transaction(body, { behavior: "immediate" }).pipe(preserve)
function policy(control: BrowserSchema.Control) {
  return Schema.decodeUnknownOption(Schema.Struct({ profile: Schema.Literal(BrowserFileSchema.PROFILE),
    postPaths: Schema.Array(BrowserFileSchema.PostPath), filePolicy: BrowserFileSchema.Policy }))(control)
}
function current(db: Reader, controlID: string, scope: BrowserSchema.Scope) {
  return Effect.gen(function* () {
    const control = yield* BrowserControl.get(db, controlID).pipe(preserve)
    if (!control || hash(control.scope) !== hash(scope)) return yield* failure("BROWSER_FILE_SCOPE_DENIED")
    yield* BrowserControl.requireScope(db, scope).pipe(preserve)
    if (control.state !== "active" || control.cancel || control.expiresAt <= Date.now()) return yield* failure("BROWSER_FILE_CHANGED")
    if (Option.isNone(policy(control))) return yield* failure("BROWSER_FILE_SCOPE_DENIED")
    return control
  })
}
function permits(control: BrowserSchema.Control, request: BrowserFileSchema.PreviewRequest) {
  const allowed = policy(control)
  if (Option.isNone(allowed) || !allowed.value.filePolicy[request.direction]) return false
  if (request.direction === "upload") return allowed.value.postPaths.includes(request.targetPath)
  return new URL(request.targetURL).origin === control.origin
}

/** Native readonly preview only. No file, identity, grant, quota or execution row is created. */
export const preview = Effect.fn("BrowserFileExchange.preview")(function* (db: Db, input: {
  controlID: string; scope: BrowserSchema.Scope; request: BrowserFileSchema.PreviewRequest
}) {
  const request = yield* checked(BrowserFileSchema.PreviewRequest, input.request)
  const control = yield* current(db, input.controlID, input.scope)
  if (!permits(control, request)) return yield* failure("BROWSER_FILE_SCOPE_DENIED")
  const files = yield* native
  const observed = yield* files.preview({ control, request })
  const description = yield* checked(BrowserFileSchema.Preview, files.describePreview(observed, { control, request }))
  if (description.controlID !== control.controlID || description.controlHash !== hash(control) ||
    description.scopeHash !== hash(control.scope) || description.relative !== request.relative ||
    description.name !== request.relative.split("/").at(-1) || description.direction !== request.direction ||
    (description.direction === "upload" && (request.direction !== "upload" || description.targetPath !== request.targetPath)) ||
    (description.direction === "download" && (request.direction !== "download" || description.targetURL !== request.targetURL || description.maxBytes !== request.maxBytes)))
    return yield* failure("BROWSER_FILE_CHANGED")
  if (Buffer.byteLength(CanonicalJson.stringify(description)) > BrowserFileSchema.MAX_RECORD_BYTES - BrowserFileSchema.TERMINAL_RESERVE_BYTES)
    return yield* failure("BROWSER_FILE_CAPACITY")
  const handle = Object.freeze({}) as Capture
  captures.set(handle, { db, files, native: observed, control, request, preview: description, used: false })
  return handle
}, preserve)

export const describePreview = (handle: Capture) => captures.get(handle)?.preview

/** Fresh approval must await the original Main-owned native confirmation. Basic credentials
 * may request this interaction but cannot manufacture its opaque affirmative result. */
export const confirm = Effect.fn("BrowserFileExchange.confirm")(function* (db: Db, handle: Capture, input: BrowserFileSchema.Approve) {
  const command = yield* checked(BrowserFileSchema.Approve, input)
  const capture = captures.get(handle)
  if (!capture || capture.db !== db || capture.used) return yield* failure("BROWSER_FILE_CHANGED")
  if (capture.confirmation) {
    if (capture.confirmation.commandHash !== hash(command)) return yield* failure("BROWSER_FILE_CONFLICT")
    return
  }
  const control = yield* current(db, capture.control.controlID, capture.control.scope)
  if (hash(control) !== hash(capture.control) || command.expectedControlRevision !== control.revision ||
    command.expiresAt <= Date.now() || command.expiresAt > control.expiresAt) return yield* failure("BROWSER_FILE_CHANGED")
  yield* capture.files.currentPreview(capture.native)
  const approval = yield* capture.files.confirm(capture.native, command)
  if (!capture.files.approved(approval, capture.native, command)) return yield* failure("BROWSER_FILE_SCOPE_DENIED")
  capture.confirmation = { commandHash: hash(command), handle: approval }
}, preserve)

export const approve = Effect.fn("BrowserFileExchange.approve")(function* (db: Db, input: {
  controlID: string; scope: BrowserSchema.Scope; command: BrowserFileSchema.Approve
}, handle?: Capture) {
  const command = yield* checked(BrowserFileSchema.Approve, input.command)
  const control = yield* BrowserControl.get(db, input.controlID).pipe(preserve)
  if (!control || hash(control.scope) !== hash(input.scope)) return yield* failure("BROWSER_FILE_SCOPE_DENIED")
  yield* BrowserControl.requireScope(db, input.scope).pipe(preserve)
  const prior = yield* db.select({ id: BrowserFileGrantTable.grant_id }).from(BrowserFileGrantTable)
    .where(and(eq(BrowserFileGrantTable.control_id, control.controlID), eq(BrowserFileGrantTable.request_id, command.requestID))).get().pipe(preserve)
  if (prior) {
    const grant = yield* getGrant(db, prior.id)
    if (!grant || grant.commandHash !== hash(command) || grant.scopeHash !== hash(input.scope)) return yield* failure("BROWSER_FILE_CONFLICT")
    return { grant, replayed: true }
  }
  const capture = handle && captures.get(handle)
  const installed = yield* native
  if (!capture || capture.db !== db || capture.used || capture.control.controlID !== control.controlID ||
    hash(capture.control) !== hash(control) || !capture.confirmation || capture.confirmation.commandHash !== hash(command) ||
    capture.files !== installed || !capture.files.approved(capture.confirmation.handle, capture.native, command))
    return yield* failure("BROWSER_FILE_SCOPE_DENIED")
  yield* capture.files.currentPreview(capture.native)
  const confirmation = yield* checked(BrowserFileSchema.Confirmation, capture.files.describeApproval(capture.confirmation.handle))
  if (confirmation.previewHash !== hash(capture.preview) || confirmation.commandHash !== hash(command)) return yield* failure("BROWSER_FILE_CHANGED")
  const result = yield* transaction(db, (tx) => Effect.gen(function* () {
    const fresh = yield* current(tx, control.controlID, input.scope)
    if (hash(fresh) !== hash(capture.control) || fresh.revision !== command.expectedControlRevision || !permits(fresh, capture.request) ||
      command.expiresAt <= Date.now() || command.expiresAt > fresh.expiresAt || confirmation.confirmedAt > Date.now() ||
      confirmation.confirmedAt < capture.preview.observedAt) return yield* failure("BROWSER_FILE_CHANGED")
    const existing = yield* tx.select({ id: BrowserFileGrantTable.grant_id }).from(BrowserFileGrantTable)
      .where(and(eq(BrowserFileGrantTable.control_id, fresh.controlID), eq(BrowserFileGrantTable.request_id, command.requestID))).get()
    if (existing) {
      const grant = yield* getGrant(tx, existing.id)
      if (!grant || grant.commandHash !== hash(command)) return yield* failure("BROWSER_FILE_CONFLICT")
      return { grant, replayed: true }
    }
    const count = yield* tx.select({ count: sql<number>`count(*)` }).from(BrowserFileGrantTable).where(eq(BrowserFileGrantTable.control_id, fresh.controlID)).get()
    if (!count || count.count >= BrowserFileSchema.MAX_GRANTS_PER_CONTROL) return yield* failure("BROWSER_FILE_CAPACITY")
    const grant: BrowserFileSchema.Grant = { version: 1, grantID: crypto.randomUUID(), instanceID: capture.preview.instanceID,
      controlID: fresh.controlID, resourceID: fresh.resourceID, hostIncarnation: fresh.hostIncarnation, controlEpoch: fresh.epoch,
      policyRevision: fresh.policyRevision, scopeHash: hash(fresh.scope), command, commandHash: hash(command),
      preview: capture.preview, confirmation, expiresAt: command.expiresAt, createdAt: Date.now() }
    yield* bounded(BrowserFileSchema.Grant, grant)
    yield* reserveCapacityInTransaction(tx, grant.instanceID, { grants: 1, artifacts: 0, body: 0 })
    yield* tx.insert(BrowserFileGrantTable).values(grantColumns(grant)).run()
    return { grant, replayed: false }
  }))
  if (!result.replayed) {
    capture.used = true
    if (!capture.files.acceptGrant(capture.native, capture.confirmation.handle, result.grant)) return yield* failure("BROWSER_FILE_CHANGED")
  }
  return result
}, preserve)

export const getGrant = Effect.fn("BrowserFileExchange.getGrant")(function* (db: Reader, grantID: string) {
  const row = yield* sized(db, BrowserFileGrantTable, BrowserFileGrantTable.grant_id, grantID)
  if (!row) return undefined
  const grant = yield* checked(Schema.fromJsonString(BrowserFileSchema.Grant), row.record)
  if (hash(grantColumns(grant)) !== hash(row) || grant.commandHash !== hash(grant.command) ||
    grant.scopeHash !== grant.preview.scopeHash || grant.instanceID !== grant.preview.instanceID || grant.controlID !== grant.preview.controlID ||
    grant.confirmation.commandHash !== grant.commandHash || grant.confirmation.previewHash !== hash(grant.preview) ||
    grant.expiresAt !== grant.command.expiresAt || grant.expiresAt <= grant.createdAt || grant.confirmation.confirmedAt > grant.createdAt)
    return yield* failure("BROWSER_FILE_INVALID")
  return grant
}, preserve)

export const requestGrant = Effect.fn("BrowserFileExchange.requestGrant")(function* (db: Reader, input: {
  controlID: string; scope: BrowserSchema.Scope; requestID: string
}) {
  yield* BrowserControl.requireScope(db, input.scope).pipe(preserve)
  const control = yield* BrowserControl.get(db, input.controlID).pipe(preserve)
  if (!control || hash(control.scope) !== hash(input.scope)) return yield* failure("BROWSER_FILE_SCOPE_DENIED")
  const row = yield* db.select({ id: BrowserFileGrantTable.grant_id }).from(BrowserFileGrantTable).where(and(
    eq(BrowserFileGrantTable.control_id, control.controlID), eq(BrowserFileGrantTable.request_id, input.requestID))).get().pipe(preserve)
  return row ? yield* getGrant(db, row.id) : undefined
}, preserve)

export const grantArtifact = Effect.fn("BrowserFileExchange.grantArtifact")(function* (db: Reader, grantID: string) {
  const row = yield* db.select({ id: BrowserFileArtifactTable.artifact_id }).from(BrowserFileArtifactTable)
    .where(eq(BrowserFileArtifactTable.grant_id, grantID)).get().pipe(preserve)
  return row ? yield* getArtifact(db, row.id) : undefined
}, preserve)

/** Exact original-action custody, not a new admission or a claim that SQL creates Native authority. */
export const actionFiles = Effect.fn("BrowserFileExchange.actionFiles")(function* (db: Reader, action: BrowserSchema.Action) {
  const rows = yield* db.select({ id: BrowserFileArtifactTable.artifact_id }).from(BrowserFileArtifactTable)
    .where(eq(BrowserFileArtifactTable.action_id, action.actionID)).orderBy(asc(BrowserFileArtifactTable.ordinal)).limit(5).pipe(preserve)
  if (rows.length < 1 || rows.length > BrowserFileSchema.MAX_FILES) return yield* failure("BROWSER_FILE_INVALID")
  return yield* Effect.forEach(rows, (row, ordinal) => Effect.gen(function* () {
    const artifact = yield* getArtifact(db, row.id)
    const grant = artifact && (yield* getGrant(db, artifact.grantID))
    if (!artifact || !grant || artifact.ordinal !== ordinal || artifact.actionID !== action.actionID ||
      artifact.admissionID !== action.admissionID || artifact.sessionID !== action.sessionID ||
      artifact.providerReceiptID !== action.providerReceiptID || artifact.providerAttemptID !== action.providerAttemptID ||
      artifact.toolCallID !== action.toolCallID || artifact.controlEpoch !== action.controlEpoch ||
      artifact.policyRevision !== action.policyRevision || artifact.resourceID !== action.resourceID ||
      artifact.hostIncarnation !== action.hostIncarnation || artifact.grantHash !== hash(grant))
      return yield* failure("BROWSER_FILE_CHANGED")
    return { grant, artifact }
  }))
}, preserve)

/** Stable keyset history. No scan of all grants, no expiry-based deletion or quota refund. */
export const list = Effect.fn("BrowserFileExchange.list")(function* (db: Reader, input: {
  controlID: string; scope: BrowserSchema.Scope; cursor?: string; limit?: number
}) {
  yield* BrowserControl.requireScope(db, input.scope).pipe(preserve)
  const control = yield* BrowserControl.get(db, input.controlID).pipe(preserve)
  if (!control || hash(control.scope) !== hash(input.scope)) return yield* failure("BROWSER_FILE_SCOPE_DENIED")
  const limit = input.limit ?? BrowserFileSchema.MAX_FILES
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > BrowserFileSchema.MAX_FILES ||
    (input.cursor !== undefined && Option.isNone(Schema.decodeUnknownOption(BrowserFileSchema.ID)(input.cursor))))
    return yield* failure("BROWSER_FILE_INVALID")
  const rows = yield* db.select({ id: BrowserFileGrantTable.grant_id }).from(BrowserFileGrantTable)
    .where(and(eq(BrowserFileGrantTable.control_id, control.controlID), input.cursor === undefined ? undefined :
      gt(BrowserFileGrantTable.grant_id, input.cursor))).orderBy(asc(BrowserFileGrantTable.grant_id)).limit(limit + 1).pipe(preserve)
  const records = yield* Effect.forEach(rows.slice(0, limit), (row) => Effect.gen(function* () {
    const grant = yield* getGrant(db, row.id)
    if (!grant || grant.scopeHash !== hash(input.scope)) return yield* failure("BROWSER_FILE_INVALID")
    const artifactRow = yield* db.select({ id: BrowserFileArtifactTable.artifact_id }).from(BrowserFileArtifactTable)
      .where(eq(BrowserFileArtifactTable.grant_id, grant.grantID)).get().pipe(preserve)
    const artifact = artifactRow ? yield* getArtifact(db, artifactRow.id) : undefined
    if (artifactRow && !artifact) return yield* failure("BROWSER_FILE_INVALID")
    return { grant, artifact }
  }))
  return { records,
    nextCursor: rows.length > limit ? rows[limit - 1]!.id : null }
}, preserve)

export const getArtifact = Effect.fn("BrowserFileExchange.getArtifact")(function* (db: Reader, artifactID: string) {
  const row = yield* sized(db, BrowserFileArtifactTable, BrowserFileArtifactTable.artifact_id, artifactID)
  if (!row) return undefined
  const artifact = yield* checked(Schema.fromJsonString(BrowserFileSchema.Artifact), row.record)
  if (hash(artifactColumns(artifact)) !== hash(row) || artifact.updatedAt < artifact.createdAt ||
    artifact.scopeHash !== artifact.manifest.scopeHash || artifact.instanceID !== artifact.manifest.instanceID ||
    artifact.controlID !== artifact.manifest.controlID ||
    (artifact.releasedAt !== null && (!['selected', 'published', 'refused'].includes(artifact.state) || artifact.reservedBytes !== 0 ||
      artifact.stopConfirmedAt === null || artifact.releasedAt < artifact.createdAt || artifact.releasedAt > artifact.updatedAt)) ||
    (artifact.publication !== null && (artifact.publication.artifactID !== artifact.artifactID || artifact.publication.grantID !== artifact.grantID ||
      artifact.publication.direction !== artifact.manifest.direction || artifact.publication.helperHash !== artifact.manifest.helperHash ||
      hash(artifact.publication.rootIdentity) !== hash(artifact.manifest.rootIdentity))) ||
    (['selected', 'published'].includes(artifact.state) && artifact.publication?.outcome !== artifact.state)) return yield* failure("BROWSER_FILE_INVALID")
  return artifact
}, preserve)

/** Called inside the original action admission transaction. Every file is reserved together;
 * no transfer starts here. An existing grant may never acquire a second action after unknown. */
export const reserveArtifactsInTransaction = Effect.fn("BrowserFileExchange.reserveArtifactsInTransaction")(function* (tx: Tx, input: {
  control: BrowserSchema.Control; action: BrowserSchema.Action; grantIDs: readonly string[]
}) {
  const ids = yield* checked(BrowserFileSchema.GrantIDs, input.grantIDs)
  const control = yield* current(tx, input.control.controlID, input.control.scope)
  const action = yield* BrowserControl.getAction(tx, input.action.actionID).pipe(preserve)
  if (hash(control) !== hash(input.control) || !action || hash(action) !== hash(input.action) || action.outcome !== "pending" ||
    action.controlID !== control.controlID || action.controlEpoch !== control.epoch || action.resourceID !== control.resourceID ||
    action.hostIncarnation !== control.hostIncarnation || action.sessionID !== control.scope.sessionID || action.deadline <= Date.now())
    return yield* failure("BROWSER_FILE_CHANGED")
  const grants = yield* Effect.forEach(ids, (id) => requireGrant(tx, control, id))
  if (new Set(grants.map((grant) => grant.instanceID)).size !== 1 || new Set(grants.map((grant) => grant.preview.direction)).size !== 1 ||
    (grants[0]!.preview.direction === "download" && grants.length !== 1)) return yield* failure("BROWSER_FILE_SCOPE_DENIED")
  const direction = grants[0]!.preview.direction
  const command = Schema.decodeUnknownOption(direction === "upload"
    ? Schema.Struct({ type: Schema.Literal("file.upload"), grantIDs: BrowserFileSchema.GrantIDs })
    : Schema.Struct({ type: Schema.Literal("file.download"), grantID: BrowserFileSchema.ID }))(action.command)
  if (Option.isNone(command) || (command.value.type === "file.upload" ? hash(command.value.grantIDs) !== hash(ids) : command.value.grantID !== ids[0]))
    return yield* failure("BROWSER_FILE_SCOPE_DENIED")
  const artifacts = yield* Effect.forEach(grants, (grant, ordinal) => Effect.gen(function* () {
    const prior = yield* tx.select({ id: BrowserFileArtifactTable.artifact_id }).from(BrowserFileArtifactTable).where(eq(BrowserFileArtifactTable.grant_id, grant.grantID)).get()
    if (prior) return yield* failure("BROWSER_FILE_UNKNOWN")
    const now = Date.now()
    const artifact: BrowserFileSchema.Artifact = { version: 1, artifactID: crypto.randomUUID(), instanceID: grant.instanceID,
      grantID: grant.grantID, grantHash: hash(grant), actionID: action.actionID, admissionID: action.admissionID,
      providerReceiptID: action.providerReceiptID, providerAttemptID: action.providerAttemptID, toolCallID: action.toolCallID,
      sessionID: action.sessionID, controlID: control.controlID, resourceID: control.resourceID, hostIncarnation: control.hostIncarnation,
      controlEpoch: control.epoch, policyRevision: control.policyRevision, scopeHash: hash(control.scope), ordinal,
      manifest: grant.preview, state: "reserved", revision: 1,
      reservedBytes: grant.preview.direction === "upload" ? 2 * grant.preview.bytes : 2 * grant.preview.maxBytes,
      publication: null, stopConfirmedAt: null, releasedAt: null, createdAt: now, updatedAt: now }
    yield* bounded(BrowserFileSchema.Artifact, artifact, BrowserFileSchema.MAX_RECORD_BYTES - BrowserFileSchema.TERMINAL_RESERVE_BYTES)
    return artifact
  }))
  // Zero-byte upload still has durable custody. Metadata is never released with its body.
  const normalized = artifacts.map((artifact) => ({ ...artifact, reservedBytes: Math.max(1, artifact.reservedBytes) }))
  yield* reserveCapacityInTransaction(tx, grants[0]!.instanceID, { grants: 0, artifacts: artifacts.length, body: normalized.reduce((sum, artifact) => sum + artifact.reservedBytes, 0) })
  yield* Effect.forEach(normalized, (artifact) => tx.insert(BrowserFileArtifactTable).values(artifactColumns(artifact)).run())
  return { grants, artifacts: normalized }
}, preserve)

export const requireGrant = Effect.fn("BrowserFileExchange.requireGrant")(function* (db: Reader, control: BrowserSchema.Control, grantID: string) {
  const grant = yield* getGrant(db, grantID)
  if (!grant || grant.controlID !== control.controlID || grant.resourceID !== control.resourceID ||
    grant.hostIncarnation !== control.hostIncarnation || grant.controlEpoch !== control.epoch || grant.policyRevision !== control.policyRevision ||
    grant.scopeHash !== hash(control.scope) || grant.expiresAt <= Date.now() || grant.expiresAt > control.expiresAt || !permits(control,
      grant.preview.direction === "upload" ? { direction: "upload", relative: grant.preview.relative, targetPath: grant.preview.targetPath }
        : { direction: "download", relative: grant.preview.relative, targetURL: grant.preview.targetURL, maxBytes: grant.preview.maxBytes }))
    return yield* failure("BROWSER_FILE_SCOPE_DENIED")
  return grant
}, preserve)

/** Only an opaque observation produced by the same installed capability may settle bytes. */
export const observed = Effect.fn("BrowserFileExchange.observed")(function* (db: Db, prior: BrowserFileSchema.Artifact,
  observation: BrowserFileCapability.Observation) {
  const files = yield* native
  const publication = yield* checked(BrowserFileSchema.Publication, files.describe(observation))
  if (!publicationMatches(prior, publication)) return yield* failure("BROWSER_FILE_CHANGED")
  return yield* transition(db, prior, publication.outcome, publication)
}, preserve)
/** Shared custody uses the identical helper/FD publication evidence rules. */
export function publicationMatches(prior: { artifactID: string; grantID: string; manifest: {
  direction: "upload"; helperHash: string; rootIdentity: BrowserFileSchema.Identity; bytes: number; sha256: string; fileIdentity: BrowserFileSchema.Identity
} | { direction: "download"; helperHash: string; rootIdentity: BrowserFileSchema.Identity; maxBytes: number } }, publication: BrowserFileSchema.Publication) {
  return publication.artifactID === prior.artifactID && publication.grantID === prior.grantID && publication.direction === prior.manifest.direction &&
    publication.helperHash === prior.manifest.helperHash && hash(publication.rootIdentity) === hash(prior.manifest.rootIdentity) &&
    (prior.manifest.direction === "upload" ? publication.bytes === prior.manifest.bytes && publication.sha256 === prior.manifest.sha256 &&
      hash(publication.fileIdentity) === hash(prior.manifest.fileIdentity) && publication.outcome === "selected" :
      publication.bytes <= prior.manifest.maxBytes && publication.outcome === "published")
}
export const staged = (db: Db, prior: BrowserFileSchema.Artifact) => transition(db, prior, "staged")
export const unknown = (db: Db, prior: BrowserFileSchema.Artifact) => transition(db, prior, "unknown")
export const refused = (db: Db, prior: BrowserFileSchema.Artifact) => transition(db, prior, "refused")

/** An unknown transfer never refunds quota. Known terminal custody needs real native cleanup;
 * the original artifact CAS and the original meter CAS commit in the same transaction. */
export const released = Effect.fn("BrowserFileExchange.released")(function* (db: Db, priors: readonly BrowserFileSchema.Artifact[],
  confirmation: BrowserFileCapability.Released) {
  const files = yield* native
  const ids = files.describeReleased(confirmation)
  if (!ids || ids.length !== priors.length || new Set(ids).size !== ids.length || priors.some((prior) => !ids.includes(prior.artifactID)))
    return yield* failure("BROWSER_FILE_CHANGED")
  return yield* transaction(db, (tx) => Effect.forEach(priors, (prior) => Effect.gen(function* () {
    const actual = yield* getArtifact(tx, prior.artifactID)
    if (!actual || hash(actual) !== hash(prior) || actual.releasedAt !== null || !['selected', 'published', 'refused'].includes(actual.state))
      return yield* failure("BROWSER_FILE_UNKNOWN")
    const action = yield* BrowserControl.getAction(tx, actual.actionID).pipe(preserve)
    if (!action || action.outcome === "pending" || action.outcome === "unknown") return yield* failure("BROWSER_FILE_UNKNOWN")
    const now = Date.now()
    const result = { ...actual, revision: actual.revision + 1, updatedAt: now, stopConfirmedAt: now, releasedAt: now, reservedBytes: 0 }
    yield* writeArtifact(tx, actual, result)
    const meter = yield* readCapacityInTransaction(tx, actual.instanceID)
    if (meter.reserved_bytes < actual.reservedBytes + meter.metadata_bytes) return yield* failure("BROWSER_FILE_INVALID")
    yield* writeCapacityInTransaction(tx, meter, { ...meter, reserved_bytes: meter.reserved_bytes - actual.reservedBytes })
    return result
  })))
}, preserve)

function transition(db: Db, prior: BrowserFileSchema.Artifact, state: BrowserFileSchema.Artifact["state"], publication?: BrowserFileSchema.Publication) {
  return transaction(db, (tx) => Effect.gen(function* () {
    const actual = yield* getArtifact(tx, prior.artifactID)
    if (!actual || hash(actual) !== hash(prior) || actual.releasedAt !== null || !['reserved', 'staged'].includes(actual.state) ||
      (state === "staged" && actual.state !== "reserved")) return yield* failure("BROWSER_FILE_CONFLICT")
    const record = { ...actual, state, publication: publication ?? null, revision: actual.revision + 1, updatedAt: Date.now() }
    yield* writeArtifact(tx, actual, record)
    return record
  }))
}
function bounded<A>(schema: Schema.Decoder<A>, record: A, bytes = BrowserFileSchema.MAX_RECORD_BYTES) {
  return checked(schema, record).pipe(Effect.flatMap(() => Buffer.byteLength(CanonicalJson.stringify(record)) <= bytes
    ? Effect.void : Effect.fail(failure("BROWSER_FILE_CAPACITY"))))
}
export function readCapacityInTransaction(tx: Tx, instanceID: string) {
  return Effect.gen(function* () {
    const meter = yield* tx.select().from(BrowserFileCapacityTable).where(eq(BrowserFileCapacityTable.instance_id, instanceID)).get()
    if (!meter || ![meter.grant_count, meter.artifact_count, meter.reserved_bytes, meter.metadata_bytes, meter.revision, meter.updated_at].every(Number.isSafeInteger) ||
      meter.grant_count < 0 || meter.artifact_count < 0 || meter.artifact_count > BrowserFileSchema.MAX_ARTIFACTS ||
      meter.reserved_bytes < meter.metadata_bytes || meter.reserved_bytes > BrowserFileSchema.MAX_RESERVED_BYTES ||
      meter.metadata_bytes < 0 || meter.metadata_bytes > BrowserFileSchema.MAX_METADATA_BYTES || meter.revision < 1 || meter.updated_at < 1)
      return yield* failure("BROWSER_FILE_INVALID")
    return meter
  })
}
export function writeCapacityInTransaction(tx: Tx, prior: typeof BrowserFileCapacityTable.$inferSelect, next: typeof BrowserFileCapacityTable.$inferSelect) {
  return Effect.gen(function* () {
    const changed = yield* tx.update(BrowserFileCapacityTable).set({ ...next, revision: prior.revision + 1, updated_at: Date.now() })
      .where(and(eq(BrowserFileCapacityTable.instance_id, prior.instance_id), eq(BrowserFileCapacityTable.revision, prior.revision)))
      .returning({ id: BrowserFileCapacityTable.instance_id })
    if (changed.length !== 1) return yield* failure("BROWSER_FILE_CONFLICT")
  })
}
export function reserveCapacityInTransaction(tx: Tx, instanceID: string, input: { grants: number; artifacts: number; body: number }) {
  return Effect.gen(function* () {
    yield* tx.insert(BrowserFileCapacityTable).values({ instance_id: instanceID, grant_count: 0, artifact_count: 0,
      metadata_bytes: 0, reserved_bytes: 0, revision: 1, updated_at: Date.now() }).onConflictDoNothing().run()
    const meter = yield* readCapacityInTransaction(tx, instanceID)
    const metadata = (input.grants + input.artifacts) * metadataReservation
    const next = { ...meter, grant_count: meter.grant_count + input.grants, artifact_count: meter.artifact_count + input.artifacts,
      metadata_bytes: meter.metadata_bytes + metadata, reserved_bytes: meter.reserved_bytes + metadata + input.body }
    if (next.artifact_count > BrowserFileSchema.MAX_ARTIFACTS || next.metadata_bytes > BrowserFileSchema.MAX_METADATA_BYTES ||
      next.reserved_bytes > BrowserFileSchema.MAX_RESERVED_BYTES || !Number.isSafeInteger(next.reserved_bytes)) return yield* failure("BROWSER_FILE_CAPACITY")
    yield* writeCapacityInTransaction(tx, meter, next)
  })
}
function writeArtifact(tx: Tx, prior: BrowserFileSchema.Artifact, next: BrowserFileSchema.Artifact) {
  return Effect.gen(function* () {
    yield* bounded(BrowserFileSchema.Artifact, next)
    const changed = yield* tx.update(BrowserFileArtifactTable).set(artifactColumns(next)).where(and(
      eq(BrowserFileArtifactTable.artifact_id, prior.artifactID), eq(BrowserFileArtifactTable.revision, prior.revision))).returning({ id: BrowserFileArtifactTable.artifact_id })
    if (changed.length !== 1) return yield* failure("BROWSER_FILE_CONFLICT")
  })
}
function grantColumns(record: BrowserFileSchema.Grant) {
  return { grant_id: record.grantID, instance_id: record.instanceID, control_id: record.controlID,
    binding_version: 1, shared_resource_id: null, shared_lease_id: null,
    request_id: record.command.requestID, command_hash: record.commandHash, scope_hash: record.scopeHash,
    control_epoch: record.controlEpoch, policy_revision: record.policyRevision, direction: record.preview.direction,
    expires_at: record.expiresAt, record: CanonicalJson.stringify(record), record_hash: hash(record), created_at: record.createdAt }
}
function artifactColumns(record: BrowserFileSchema.Artifact) {
  return { artifact_id: record.artifactID, instance_id: record.instanceID, grant_id: record.grantID, grant_hash: record.grantHash,
    binding_version: 1, shared_resource_id: null, shared_lease_id: null, shared_action_id: null,
    action_id: record.actionID, control_id: record.controlID, scope_hash: record.scopeHash, ordinal: record.ordinal,
    state: record.state, revision: record.revision, reserved_bytes: record.reservedBytes, record: CanonicalJson.stringify(record),
    record_hash: hash(record), created_at: record.createdAt, updated_at: record.updatedAt, released_at: record.releasedAt }
}
function sized<T extends typeof BrowserFileGrantTable | typeof BrowserFileArtifactTable>(db: Reader, table: T,
  column: T extends typeof BrowserFileGrantTable ? typeof BrowserFileGrantTable.grant_id : typeof BrowserFileArtifactTable.artifact_id, id: string) {
  return Effect.gen(function* () {
    const size = yield* db.select({ bytes: sql<number>`length(CAST(${table.record} AS BLOB))` }).from(table).where(eq(column, id)).get()
    if (!size) return undefined
    if (!Number.isSafeInteger(size.bytes) || size.bytes < 1 || size.bytes > BrowserFileSchema.MAX_RECORD_BYTES) return yield* failure("BROWSER_FILE_INVALID")
    return yield* db.select().from(table).where(and(eq(column, id), sql`length(CAST(${table.record} AS BLOB)) BETWEEN 1 AND 8192`)).get()
  })
}
