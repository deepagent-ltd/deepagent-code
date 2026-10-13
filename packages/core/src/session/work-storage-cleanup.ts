export * as WorkStorageCleanup from "./work-storage-cleanup"

import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Option, Schema, Scope } from "effect"
import type { Database } from "../database/database"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import type { WorkAuthority } from "./work-authority"
import { WorkCommand } from "./work-command"
import { WorkWriteStage } from "./work-write-stage"
import { WorkStorageCleanupSchema } from "./work-storage-cleanup.schema"
import { WorkStorageCleanupWindowsSchema } from "./work-storage-cleanup-windows.schema"
import { WorkStorageCleanupTable } from "./work-storage-cleanup.sql"

type Db = Database.Interface["db"]
type Tx = WorkAuthority.Transaction
declare const identity: unique symbol
export interface Prepared { readonly [identity]: true }
export type Row = Omit<typeof WorkStorageCleanupTable.$inferSelect, "manifest" | "journal" | "proof"> & {
  manifest: WorkStorageCleanupWindowsSchema.StoredManifest
  journal: WorkStorageCleanupWindowsSchema.StoredJournal | null
  proof: WorkStorageCleanupWindowsSchema.StoredProof | null
}
export const failure = (code: WorkStorageCleanupSchema.Error["code"]) => new WorkStorageCleanupSchema.Error({
  code, message: "Explicit known storage cleanup is unavailable, changed or retains custody",
})
export const hash = (input: unknown) => Hash.sha256(CanonicalJson.stringify(input))
export class Authority extends Context.Service<Authority, {
  readonly prepareManifest: (input: { kind: "write" | "command"; admissionID: string }) => Effect.Effect<Prepared, WorkStorageCleanupSchema.Error, Scope.Scope>
  readonly manifest: (tx: Tx, prepared: Prepared) => Effect.Effect<{ value: WorkStorageCleanupWindowsSchema.StoredManifest; mac: string }, WorkStorageCleanupSchema.Error>
  readonly prepare: (request: WorkStorageCleanupSchema.Request, row: Row | undefined) => Effect.Effect<Prepared, WorkStorageCleanupSchema.Error, Scope.Scope>
  readonly current: (tx: Tx, prepared: Prepared, row: Row) => Effect.Effect<{ journal: WorkStorageCleanupWindowsSchema.StoredJournal; mac: string }, WorkStorageCleanupSchema.Error>
  readonly execute: (prepared: Prepared, row: Row) => Effect.Effect<{ proof: WorkStorageCleanupWindowsSchema.StoredProof; mac: string }, WorkStorageCleanupSchema.Error>
  readonly verifyManifest: (value: WorkStorageCleanupWindowsSchema.StoredManifest, mac: string) => Effect.Effect<void, WorkStorageCleanupSchema.Error>
  readonly verifyJournal: (value: WorkStorageCleanupWindowsSchema.StoredJournal, mac: string) => Effect.Effect<void, WorkStorageCleanupSchema.Error>
  readonly verifyProof: (value: WorkStorageCleanupWindowsSchema.StoredProof, mac: string, journal: WorkStorageCleanupWindowsSchema.StoredJournal) => Effect.Effect<void, WorkStorageCleanupSchema.Error>
}>()("@deepagent-code/WorkStorageCleanup.Authority") {}

const authority = Effect.gen(function* () {
  const value = yield* Effect.serviceOption(Authority)
  if (Option.isNone(value)) return yield* failure("STORAGE_UNAVAILABLE")
  return value.value
})

/** Manifest-only hot retirement remains an audit record. Only original custody
 * release facts retire its active slot; an absent or unknown custody keeps the reserve. */
export const usage = Effect.fn("WorkStorageCleanup.usage")(function* (db: Pick<Db,"all">, instanceID: string) {
  const [value] = yield* db.all<{ records: number; active: number; bytes: number }>(sql`WITH inventory AS (
    SELECT c.*,CASE WHEN (c.kind='write' AND w.released_at IS NOT NULL)
      OR (c.kind='command' AND k.released_at IS NOT NULL) THEN 1 ELSE 0 END retired
    FROM work_storage_cleanup c LEFT JOIN work_write_stage w ON w.admission_id=c.admission_id
      LEFT JOIN work_command_intent k ON k.admission_id=c.admission_id WHERE c.instance_id=${instanceID})
    SELECT count(*) records,coalesce(sum(phase!='released' AND retired=0),0) active,
      coalesce(sum(length(CAST(manifest AS BLOB))+coalesce(length(CAST(journal AS BLOB)),CASE retired WHEN 1 THEN 0 ELSE 131072 END)
        +coalesce(length(CAST(proof AS BLOB)),CASE retired WHEN 1 THEN 0 ELSE 16384 END)
        +CASE WHEN journal IS NOT NULL OR retired=0 THEN 16384 ELSE 0 END),0) bytes FROM inventory`)
  if (!value || ![value.records,value.active,value.bytes].every((field) => Number.isSafeInteger(field) && field>=0))
    return yield* failure("STORAGE_INVALID")
  return value
}, preserve)

/** A bounded SQL-only description. It does not load an installation, authenticate a
 * filesystem capability, initialize a Location or interpret PID/terminal state as permission. */
export const read = Effect.fn("WorkStorageCleanup.read")(function* (db: Pick<Db, "select">, admissionID: string) {
  const size = yield* db.select({ manifest: sql<number>`length(CAST(${WorkStorageCleanupTable.manifest} AS BLOB))`,
    journal: sql<number>`coalesce(length(CAST(${WorkStorageCleanupTable.journal} AS BLOB)),0)`,
    proof: sql<number>`coalesce(length(CAST(${WorkStorageCleanupTable.proof} AS BLOB)),0)` })
    .from(WorkStorageCleanupTable).where(eq(WorkStorageCleanupTable.admission_id, admissionID)).get()
  if (!size) return undefined
  if (size.manifest < 1 || size.manifest > WorkStorageCleanupSchema.MAX_MANIFEST_BYTES ||
    size.journal > WorkStorageCleanupSchema.MAX_JOURNAL_BYTES || size.proof > 16384) return yield* failure("STORAGE_INVALID")
  const raw = yield* db.select().from(WorkStorageCleanupTable).where(and(
    eq(WorkStorageCleanupTable.admission_id, admissionID),
    sql`length(CAST(${WorkStorageCleanupTable.manifest} AS BLOB)) BETWEEN 1 AND 65536`,
    sql`coalesce(length(CAST(${WorkStorageCleanupTable.journal} AS BLOB)),0)<=131072`,
    sql`coalesce(length(CAST(${WorkStorageCleanupTable.proof} AS BLOB)),0)<=16384`,
  )).get()
  if (!raw) return yield* failure("STORAGE_INVALID")
  const manifest = yield* decode(Schema.fromJsonString(WorkStorageCleanupWindowsSchema.StoredManifest), raw.manifest)
  const journal = raw.journal === null ? null : yield* decode(Schema.fromJsonString(WorkStorageCleanupWindowsSchema.StoredJournal), raw.journal)
  const proof = raw.proof === null ? null : yield* decode(Schema.fromJsonString(WorkStorageCleanupWindowsSchema.StoredProof), raw.proof)
  if (CanonicalJson.stringify(manifest) !== raw.manifest || hash(manifest) !== raw.manifest_hash ||
    manifest.admissionID !== raw.admission_id || manifest.instanceID !== raw.instance_id || manifest.workID !== raw.work_id ||
    manifest.kind !== raw.kind || manifest.custodyID !== raw.custody_id || manifest.createdAt !== raw.created_at ||
    (journal !== null && (CanonicalJson.stringify(journal) !== raw.journal || hash(journal) !== raw.journal_hash ||
      journal.cleanupID !== raw.cleanup_id || journal.requestHash !== raw.request_hash || journal.manifestHash !== raw.manifest_hash ||
      journal.instanceID !== raw.instance_id || journal.request.admissionID !== raw.admission_id || !sameContract(manifest, journal))) ||
    (proof !== null && (CanonicalJson.stringify(proof) !== raw.proof || hash(proof) !== raw.proof_hash ||
      proof.cleanupID !== raw.cleanup_id || proof.manifestHash !== raw.manifest_hash || !journal || proof.planHash !== hash(journal) ||
      !sameContract(manifest, proof) || hash(proof.dataIdentity) !== hash(manifest.dataIdentity) ||
      hash(proof.baseIdentity) !== hash(manifest.baseIdentity) || hash(proof.containerIdentity) !== hash(manifest.containerIdentity))))
    return yield* failure("STORAGE_INVALID")
  return { ...raw, manifest, journal, proof }
}, preserve)

/** The host factory observes the actual private namespace under the original live
 * native tool frame. There is no JSON/SQL capture-to-authority conversion here. */
export const capture = Effect.fn("WorkStorageCleanup.capture")(function* (db: Db, prepared: Prepared) {
  const host = yield* authority
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const observed = yield* host.manifest(tx, prepared)
    const manifest = yield* decode(WorkStorageCleanupWindowsSchema.StoredManifest, observed.value)
    yield* host.verifyManifest(manifest, observed.mac)
    const prior = yield* read(tx, manifest.admissionID)
    if (prior) {
      if (prior.manifest_hash !== hash(manifest) || prior.manifest_mac !== observed.mac) return yield* failure("STORAGE_CONFLICT")
      return prior
    }
    const capacity = yield* usage(tx, manifest.instanceID)
    if (!capacity || capacity.records >= WorkStorageCleanupSchema.MAX_INSTANCE_RECORDS ||
      capacity.active >= WorkStorageCleanupSchema.MAX_ACTIVE ||
      capacity.bytes + Buffer.byteLength(CanonicalJson.stringify(manifest)) + WorkStorageCleanupSchema.MAX_JOURNAL_BYTES + 32768 >
        WorkStorageCleanupSchema.MAX_INSTANCE_BYTES) return yield* failure("STORAGE_CAPACITY")
    yield* tx.insert(WorkStorageCleanupTable).values({ admission_id: manifest.admissionID, instance_id: manifest.instanceID,
      work_id: manifest.workID, kind: manifest.kind, custody_id: manifest.custodyID,
      manifest: CanonicalJson.stringify(manifest), manifest_hash: hash(manifest), manifest_mac: observed.mac,
      phase: "retained", revision: 1, released_bytes: 0, created_at: manifest.createdAt, updated_at: manifest.createdAt })
    return (yield* read(tx, manifest.admissionID))!
  }), { behavior: "immediate" })
}, preserve)

/** A request admits a fixed cleanup intent before touching the namespace. It never
 * resumes a Session or tools. A failed/partial cleanup retains the original meters. */
export const cleanup = Effect.fn("WorkStorageCleanup.cleanup")(function* (db: Db, input: WorkStorageCleanupSchema.Request) {
  const request = yield* decode(WorkStorageCleanupSchema.Request, input)
  const host = yield* authority
  const previous = yield* read(db, request.admissionID)
  const witness = yield* host.prepare(request, previous)
  // Only an authenticated empty legacy write can acquire a new retirement manifest.
  // The host refuses old commands whose copied-input manifest was never captured.
  const row = previous ?? (yield* capture(db, witness))
  const admitted = yield* db.transaction((tx) => Effect.gen(function* () {
    const actual = yield* read(tx, request.admissionID)
    if (!actual || actual.manifest_hash !== row.manifest_hash) return yield* failure("STORAGE_CONFLICT")
    yield* host.verifyManifest(actual.manifest, actual.manifest_mac)
    const current = yield* host.current(tx, witness, actual)
    const journal = yield* decode(WorkStorageCleanupWindowsSchema.StoredJournal, current.journal)
    if (!sameContract(actual.manifest, journal)) return yield* failure("STORAGE_CONFLICT")
    yield* host.verifyJournal(journal, current.mac)
    if (actual.journal) {
      yield* host.verifyJournal(actual.journal, actual.journal_mac!)
      if (hash(journal) !== actual.journal_hash || current.mac !== actual.journal_mac) return yield* failure("STORAGE_CONFLICT")
      return { row: actual, replayed: true }
    }
    const changed = yield* tx.update(WorkStorageCleanupTable).set({ phase: "cleanup_pending",
      revision: actual.revision + 1, journal: CanonicalJson.stringify(journal), journal_hash: hash(journal),
      journal_mac: current.mac, cleanup_id: journal.cleanupID, request_hash: journal.requestHash, updated_at: Date.now() })
      .where(and(eq(WorkStorageCleanupTable.admission_id, actual.admission_id), eq(WorkStorageCleanupTable.revision, actual.revision),
        eq(WorkStorageCleanupTable.phase, "retained"))).returning({ id: WorkStorageCleanupTable.admission_id }).get()
    if (!changed) return yield* failure("STORAGE_CONFLICT")
    return { row: (yield* read(tx, request.admissionID))!, replayed: false }
  }), { behavior: "immediate" })
  if (admitted.row.phase === "released") return receipt(admitted.row, true)
  const outcome = yield* host.execute(witness, admitted.row).pipe(Effect.result)
  if (outcome._tag === "Failure") {
    yield* db.transaction((tx) => tx.update(WorkStorageCleanupTable).set({ phase: "cleanup_recovery",
      revision: admitted.row.revision + 1, updated_at: Date.now() }).where(and(
        eq(WorkStorageCleanupTable.admission_id, request.admissionID), eq(WorkStorageCleanupTable.revision, admitted.row.revision),
        sql`${WorkStorageCleanupTable.phase} IN ('cleanup_pending','cleanup_recovery')`,
      )).run(), { behavior: "immediate" })
    return yield* outcome.failure
  }
  const completed = yield* db.transaction((tx) => Effect.gen(function* () {
    const actual = yield* read(tx, request.admissionID)
    if (!actual || !actual.journal || actual.journal_hash !== admitted.row.journal_hash) return yield* failure("STORAGE_CONFLICT")
    yield* host.verifyManifest(actual.manifest, actual.manifest_mac)
    yield* host.verifyJournal(actual.journal, actual.journal_mac!)
    const current = yield* host.current(tx, witness, actual)
    if (hash(current.journal) !== actual.journal_hash) return yield* failure("STORAGE_CONFLICT")
    if (actual.phase === "released") return actual
    if (!sameContract(actual.manifest, outcome.success.proof)) return yield* failure("STORAGE_CONFLICT")
    yield* host.verifyProof(outcome.success.proof, outcome.success.mac, actual.journal)
    if (outcome.success.proof.cleanupID !== actual.cleanup_id || outcome.success.proof.manifestHash !== actual.manifest_hash ||
      outcome.success.proof.planHash !== actual.journal_hash || outcome.success.proof.quarantine !== actual.journal.quarantine ||
      hash(outcome.success.proof.dataIdentity) !== hash(actual.manifest.dataIdentity) ||
      hash(outcome.success.proof.baseIdentity) !== hash(actual.manifest.baseIdentity) ||
      hash(outcome.success.proof.containerIdentity) !== hash(actual.manifest.containerIdentity)) return yield* failure("STORAGE_CONFLICT")
    const custody = actual.kind === "write" ? yield* WorkWriteStage.get(tx, actual.admission_id)
      : yield* WorkCommand.get(tx, actual.admission_id)
    if (!custody || hash(custody) !== actual.journal.custodyRecordHash || custody.releasedAt !== null ||
      custody.version !== (actual.manifest.version === 2 && actual.manifest.kind === "write" ? 1 : actual.manifest.version) ||
      (actual.manifest.version === 2 && actual.manifest.kind === "command" &&
        (!("target" in custody) || custody.target !== actual.manifest.target)))
      return yield* failure("STORAGE_CONFLICT")
    const releasedBytes = Math.max(custody.reservedBytes, custody.observedRetainedBytes)
    if (actual.kind === "write") {
      const stage = yield* WorkWriteStage.get(tx, actual.admission_id)
      if (!stage) return yield* failure("STORAGE_CONFLICT")
      yield* WorkWriteStage.releasedInTransaction(tx, stage)
    }
    if (actual.kind === "command") {
      const command = yield* WorkCommand.get(tx, actual.admission_id)
      if (!command) return yield* failure("STORAGE_CONFLICT")
      yield* WorkCommand.releasedInTransaction(tx, command)
    }
    const proof = yield* decode(WorkStorageCleanupWindowsSchema.StoredProof, outcome.success.proof)
    const changed = yield* tx.update(WorkStorageCleanupTable).set({ phase: "released", revision: actual.revision + 1,
      proof: CanonicalJson.stringify(proof), proof_hash: hash(proof), proof_mac: outcome.success.mac,
      released_bytes: releasedBytes, updated_at: Date.now() }).where(and(
        eq(WorkStorageCleanupTable.admission_id, actual.admission_id), eq(WorkStorageCleanupTable.revision, actual.revision),
        sql`${WorkStorageCleanupTable.phase} IN ('cleanup_pending','cleanup_recovery','cleanup_verified')`,
      )).returning({ id: WorkStorageCleanupTable.admission_id }).get()
    if (!changed) return yield* failure("STORAGE_CONFLICT")
    return (yield* read(tx, request.admissionID))!
  }), { behavior: "immediate" })
  return receipt(completed, admitted.replayed)
}, preserve)

function receipt(row: Row, replayed: boolean): WorkStorageCleanupSchema.Receipt {
  return { contract: "work-storage-cleanup.v1", cleanupID: row.cleanup_id!, admissionID: row.admission_id,
    workID: row.work_id, requestHash: row.request_hash!, phase: row.phase, revision: row.revision,
    releasedBytes: row.released_bytes, recordedAt: row.updated_at, replayed }
}
function sameContract(manifest: WorkStorageCleanupWindowsSchema.StoredManifest,
  component: WorkStorageCleanupWindowsSchema.StoredJournal | WorkStorageCleanupWindowsSchema.StoredProof) {
  if (manifest.version === 1) return component.version === 1
  if (manifest.kind === "write") return component.version === 2 && "purpose" in component &&
    component.purpose === "work_write" && component.target === manifest.target
  return component.version === 2 && "security" in component && component.target === manifest.target &&
    hash(component.security) === hash(manifest.security)
}
function decode<A>(schema: Schema.Decoder<A>, input: unknown) {
  const decoded = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(input)
  return Option.isSome(decoded) ? Effect.succeed(decoded.value) : Effect.fail(failure("STORAGE_INVALID"))
}
function preserve<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.mapError((error) => error instanceof WorkStorageCleanupSchema.Error ? error : failure("STORAGE_UNAVAILABLE")))
}
