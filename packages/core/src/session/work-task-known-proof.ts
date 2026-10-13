export * as WorkTaskKnownProof from "./work-task-known-proof"

import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import type { WorkAuthority } from "./work-authority"
import type { WorkChildAuthoritySchema } from "./work-child-authority.schema"
import { WorkTaskKnownProofSchema } from "./work-task-known-proof.schema"
import { WorkTaskKnownProofTable } from "./work-task-known-proof.sql"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import type { V2ToolEffectTable } from "./runner/v2-tool-effect.sql"

type Db = Database.Interface["db"]
type Tx = WorkAuthority.Transaction
declare const settlement: unique symbol
export interface Settlement { readonly [settlement]: true }
export const hash = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))
export const failure = (code: WorkTaskKnownProofSchema.Error["code"]) => new WorkTaskKnownProofSchema.Error({
  code, message: "Original known NativeTask evidence is unavailable, changed or retains custody",
})
/** Trusted installation factory only. seal obtains its record from the canonical one-use
 * settlement token. Neither this port nor any HTTP request accepts sign(payload). */
export class Authority extends Context.Service<Authority, {
  readonly instanceID: string
  readonly seal: (tx: Tx, token: Settlement, effectID: string) => Effect.Effect<{
    record: WorkTaskKnownProofSchema.Record; mac: string
  }, WorkTaskKnownProofSchema.Error>
  readonly verify: (record: WorkTaskKnownProofSchema.Record, mac: string) => Effect.Effect<void, WorkTaskKnownProofSchema.Error>
}>()("@deepagent-code/WorkTaskKnownProof/Authority") {}
const authority = Effect.gen(function* () {
  const value = yield* Effect.serviceOption(Authority)
  if (Option.isNone(value)) return yield* failure("TASK_PROOF_UNAVAILABLE")
  return value.value
})

/** Runs in the original Task admission transaction before child creation/dispatch. Bare
 * Core without the installation port keeps its old normal chain, with no cold proof minted. */
export const reserve = Effect.fn("WorkTaskKnownProof.reserve")(function* (tx: Tx, grant: WorkChildAuthoritySchema.Record) {
  const service = yield* Effect.serviceOption(Authority)
  if (Option.isNone(service)) {
    const { WorkExecutionProfile } = yield* Effect.promise(() => import("./work-execution-profile"))
    if (Option.isSome(yield* Effect.serviceOption(WorkExecutionProfile.Services))) return yield* failure("TASK_PROOF_UNAVAILABLE")
    return
  }
  if (!Schema.is(WorkTaskKnownProofSchema.Text)(service.value.instanceID)) return yield* failure("TASK_PROOF_INVALID")
  if (grant.parentBinding.childPolicy === "deny_all" || grant.parentBinding.childPolicy.kind !== "shared_root_v1" ||
    grant.parentBinding.childPolicy.toolIDs.some((toolID) => toolID !== "read")) return yield* failure("TASK_PROOF_UNAVAILABLE")
  const prior = yield* tx.select({ id: WorkTaskKnownProofTable.proof_id }).from(WorkTaskKnownProofTable)
    .where(eq(WorkTaskKnownProofTable.admission_id, grant.admissionID)).get()
  if (prior) return yield* failure("TASK_PROOF_CONFLICT")
  const [used] = yield* tx.all<{ instance: number; root: number; bytes: number }>(sql`SELECT count(*) instance,
    coalesce(sum(root_work_id=${grant.rootWorkID}),0) root,coalesce(sum(reserved_bytes+8192),0) bytes
    FROM work_task_known_proof WHERE instance_id=${service.value.instanceID}`)
  if (!used || used.instance >= WorkTaskKnownProofSchema.MAX_INSTANCE_PROOFS ||
    used.root >= WorkTaskKnownProofSchema.MAX_ROOT_PROOFS ||
    used.bytes + WorkTaskKnownProofSchema.MAX_RECORD_BYTES + 8192 > WorkTaskKnownProofSchema.MAX_INSTANCE_BYTES)
    return yield* failure("TASK_PROOF_CAPACITY")
  yield* tx.insert(WorkTaskKnownProofTable).values({ proof_id: `wtask_${hash([service.value.instanceID, grant.admissionID])}`,
    version: 2, instance_id: service.value.instanceID, root_work_id: grant.rootWorkID, parent_work_id: grant.parentWorkID,
    child_work_id: grant.childWorkID, task_run_id: grant.taskRunID, admission_id: grant.admissionID,
    parent_binding_hash: grant.parentBindingHash, child_binding_hash: grant.childBindingHash, grant_hash: hash(grant),
    state: "reserved", reserved_bytes: WorkTaskKnownProofSchema.MAX_RECORD_BYTES, created_at: grant.createdAt }).run()
}, preserve)

/** Original effect INSERT transaction only. A failed seal rolls back the effect while the
 * previously committed child reservation retains its quota and unknown-result boundary. */
export const seal = Effect.fn("WorkTaskKnownProof.seal")(function* (tx: Tx, token: Settlement, effectID: string) {
  const service = yield* Effect.serviceOption(Authority)
  if (Option.isNone(service)) {
    const { WorkExecutionProfile } = yield* Effect.promise(() => import("./work-execution-profile"))
    if (Option.isSome(yield* Effect.serviceOption(WorkExecutionProfile.Services))) return yield* failure("TASK_PROOF_UNAVAILABLE")
    return
  }
  const sealed = yield* service.value.seal(tx, token, effectID)
  const record = yield* decode(sealed.record)
  const prior = yield* tx.select().from(WorkTaskKnownProofTable)
    .where(eq(WorkTaskKnownProofTable.admission_id, record.admissionID)).get()
  if (!prior || prior.state !== "reserved" || prior.proof_id !== record.proofID || prior.instance_id !== record.instanceID ||
    prior.root_work_id !== record.rootWorkID || prior.parent_work_id !== record.parentWorkID ||
    prior.child_work_id !== record.childWorkID || prior.task_run_id !== record.taskRunID ||
    prior.parent_binding_hash !== record.parentBindingHash || prior.child_binding_hash !== record.childBindingHash ||
    prior.grant_hash !== record.grantHash || record.effectID !== effectID || record.createdAt < prior.created_at)
    return yield* failure("TASK_PROOF_CONFLICT")
  const text = CanonicalJson.stringify(record)
  if (Buffer.byteLength(text) > WorkTaskKnownProofSchema.MAX_RECORD_BYTES) return yield* failure("TASK_PROOF_CAPACITY")
  yield* service.value.verify(record, sealed.mac)
  const changed = yield* tx.update(WorkTaskKnownProofTable).set({ state: "sealed", effect_id: effectID,
    record: text, record_hash: hash(record), mac: sealed.mac, sealed_at: record.createdAt }).where(and(
      eq(WorkTaskKnownProofTable.proof_id, prior.proof_id), eq(WorkTaskKnownProofTable.state, "reserved"),
    )).returning({ id: WorkTaskKnownProofTable.proof_id }).get()
  if (!changed) return yield* failure("TASK_PROOF_CONFLICT")
}, preserve)

/** Bounded historical authentication. The returned record carries no execution authority. */
export const read = Effect.fn("WorkTaskKnownProof.read")(function* (db: Pick<Db,"select">, admissionID: string) {
  const size = yield* db.select({ bytes: sql<number>`length(CAST(${WorkTaskKnownProofTable.record} AS BLOB))`,
    state: WorkTaskKnownProofTable.state }).from(WorkTaskKnownProofTable)
    .where(eq(WorkTaskKnownProofTable.admission_id, admissionID)).get()
  if (!size) return undefined
  if (size.state !== "sealed") return yield* failure("TASK_PROOF_UNKNOWN")
  if (!Number.isSafeInteger(size.bytes) || size.bytes < 1 || size.bytes > WorkTaskKnownProofSchema.MAX_RECORD_BYTES)
    return yield* failure("TASK_PROOF_INVALID")
  const row = yield* db.select().from(WorkTaskKnownProofTable).where(and(
    eq(WorkTaskKnownProofTable.admission_id, admissionID), eq(WorkTaskKnownProofTable.state, "sealed"),
    sql`length(CAST(${WorkTaskKnownProofTable.record} AS BLOB)) BETWEEN 1 AND 65536`,
  )).get()
  if (!row?.record || !row.mac || !row.record_hash || row.sealed_at === null) return yield* failure("TASK_PROOF_INVALID")
  const record = yield* decodeJson(row.record)
  if (CanonicalJson.stringify(record) !== row.record || hash(record) !== row.record_hash || record.proofID !== row.proof_id ||
    record.instanceID !== row.instance_id || record.rootWorkID !== row.root_work_id || record.parentWorkID !== row.parent_work_id ||
    record.childWorkID !== row.child_work_id || record.taskRunID !== row.task_run_id || record.admissionID !== row.admission_id ||
    record.parentBindingHash !== row.parent_binding_hash || record.childBindingHash !== row.child_binding_hash ||
    record.grantHash !== row.grant_hash || record.effectID !== row.effect_id || record.createdAt !== row.sealed_at ||
    record.createdAt < row.created_at) return yield* failure("TASK_PROOF_INVALID")
  yield* (yield* authority).verify(record, row.mac)
  return record
}, preserve)

/** Keep the original public effect digest domain: newly private proofs never alter old hashes. */
export function publicEffect(row: typeof V2ToolEffectTable.$inferSelect) {
  return { effect_id: row.effect_id, session_id: row.session_id, provider_attempt_id: row.provider_attempt_id,
    receipt_id: row.receipt_id, tool_call_id: row.tool_call_id, tool_name: row.tool_name, effect_kind: row.effect_kind,
    state: row.state, outcome_hash: row.outcome_hash, error_code: row.error_code, grant_receipt_id: row.grant_receipt_id,
    grant_owner_id: row.grant_owner_id, grant_state: row.grant_state, grant_version: row.grant_version,
    owner_token: row.owner_token, time_created: row.time_created }
}
function decode(value: unknown) {
  const parsed = Schema.decodeUnknownOption(WorkTaskKnownProofSchema.Record, { onExcessProperty: "error" })(value)
  return Option.isSome(parsed) ? Effect.succeed(parsed.value) : Effect.fail(failure("TASK_PROOF_INVALID"))
}
function decodeJson(value: string) {
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(WorkTaskKnownProofSchema.Record), { onExcessProperty: "error" })(value)
  return Option.isSome(parsed) ? Effect.succeed(parsed.value) : Effect.fail(failure("TASK_PROOF_INVALID"))
}
function preserve<A,E,R>(effect: Effect.Effect<A,E,R>) {
  return effect.pipe(Effect.mapError((error) => error instanceof WorkTaskKnownProofSchema.Error ? error : failure("TASK_PROOF_UNAVAILABLE")))
}
