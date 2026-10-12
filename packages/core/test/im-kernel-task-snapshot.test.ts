import { expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Cause, Effect, Exit, Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "../src/database/database"
import { KernelReader } from "../src/im/kernel-reader"
import { KernelReaderSchema } from "../src/im/kernel-reader.schema"
import { IMKernelReaderMessageTable } from "../src/im/kernel-reader.sql"
import { KernelReceiverMapping } from "../src/im/kernel-receiver-mapping"
import { KernelTaskSnapshot } from "../src/im/kernel-task-snapshot"
import { LocalOperator } from "../src/im/local-operator"
import { LocalOperatorSchema } from "../src/im/local-operator.schema"
import { LocalTaskAuth } from "../src/im/local-task-auth"
import { IMTaskAuthoritySchema } from "../src/im/task-authority.schema"
import { GroupTable, MessageTable } from "../src/im/sql"
import { WorkAuthorityFixture } from "./fixture/work-authority"

const runtimeBinding = { instanceID: "snapshot-instance", installationKeyHash: "1".repeat(64), credentialBinding: "2".repeat(64) }
const nativeSource = { realm: "http://127.0.0.1:9/", appkey: "snapshot", orgID: 1, senderID: "receiver", credentialFingerprint: "c".repeat(64) }
const scopeKey = "a".repeat(64)
const projectionKey = "b".repeat(64)
const passwordVerifier = await Bun.password.hash("snapshot-private-password", { algorithm: "argon2id", memoryCost: 4096, timeCost: 2 })

// Actual file SQLite, reader writer, enrollment and mapping. The Core native callback is
// controlled as in first-seen tests; this suite does not claim live SDK membership proof.
async function isolated<A, E>(body: Effect.Effect<A, E, Database.Service | LocalOperator.Runtime | import("effect").Scope.Scope>) {
  const root = await mkdtemp(join(tmpdir(), "dac-kernel-task-snapshot-"))
  try {
    return await Effect.runPromise(body.pipe(
      Effect.provideService(LocalOperator.Runtime, runtimeBinding),
      Effect.provide(WorkAuthorityFixture.database(join(root, "snapshot.sqlite"))), Effect.scoped,
    ))
  } finally { await rm(root, { recursive: true, force: true }) }
}

const setup = (options?: { history?: boolean; expiryMs?: number }) => Effect.gen(function* () {
  yield* WorkAuthorityFixture.initialize()
  const db = (yield* Database.Service).db
  const target = {
    scope: { ...WorkAuthorityFixture.binding().scope, workspaceID: WorkAuthorityFixture.binding().location.directory },
    location: WorkAuthorityFixture.binding().location, agentID: "build",
    profile: WorkAuthorityFixture.binding().profile, provider: WorkAuthorityFixture.binding().provider,
    budget: WorkAuthorityFixture.binding().budget, durationMs: 60_000,
  }
  yield* db.run(sql`INSERT INTO context_security_namespace (id,kind,binding_hash,created_at)
    VALUES (${target.scope.securityNamespaceID},'implicit_local',${"d".repeat(64)},${Date.now()})`)
  yield* db.run(sql`INSERT INTO context_project_scope_identity (security_namespace_id,project_scope_key,project_kind,project_identity_hash,created_at)
    VALUES (${target.scope.securityNamespaceID},${target.scope.projectScopeKey},'registered_root','snapshot-project',${Date.now()})`)
  yield* db.run(sql`INSERT INTO context_location_identity (security_namespace_id,location_key,project_scope_key,canonical_root,created_at)
    VALUES (${target.scope.securityNamespaceID},'snapshot-location',${target.scope.projectScopeKey},${target.location.directory},${Date.now()})`)
  const mapping = { id: "snapshot-receiver", targetID: "snapshot-target", realmID: nativeSource.realm,
    appkeyID: nativeSource.appkey, orgID: nativeSource.orgID, receiverID: nativeSource.senderID,
    localUserID: "server" as const, issuedAt: Date.now(), expiresAt: Date.now() + LocalOperatorSchema.KERNEL_RECEIVER_LIFETIME_MS }
  // One timestamp is frozen by the mapping's exact fixed-lifetime schema.
  const policy = { version: 1 as const, targets: [{ id: mapping.targetID, locationKey: "snapshot-location",
    namespaceBindingHash: "d".repeat(64), target }], kernelReceivers: [{ ...mapping, expiresAt: mapping.issuedAt + LocalOperatorSchema.KERNEL_RECEIVER_LIFETIME_MS }] }
  yield* LocalOperator.enroll(db, { operationID: "enroll-snapshot", operatorID: target.scope.actorID,
    username: "snapshot-operator", credentialVerifier: passwordVerifier, policy })
  const now = Date.now()
  const message = { effectKey: "e".repeat(64), messageId: "native-source", sequence: "9007199254740993",
    deliveryCursor: "1", messageTime: now, expiresAt: now + (options?.expiryMs ?? 3_600_000),
    senderId: "sender", targetId: "sender", conversationType: 1 as const,
    content: '{"content":"original kernel source 中文"}', isSend: false, isRead: false }
  const observation = { scopeKey, projectionKey, projectionRevision: "1", sourceHash: KernelReader.hash(nativeSource),
    receiverID: nativeSource.senderID, transportGeneration: 1, receivedAt: now, messageID: message.messageId,
    sequence: message.sequence, messageTime: now, senderID: message.senderId, conversationType: message.conversationType,
    conversationID: message.targetId, wireContent: message.content }
  const handle = Object.freeze({})
  const reader = KernelReader.attach({ db, workspaceID: target.scope.workspaceID, userID: "server", source: nativeSource,
    current: () => Effect.succeed(true), inspect: () => Effect.succeed({ name: "Sender" }),
    readCut: () => Effect.fail(KernelReaderSchema.failure("reader_unavailable", "unused")),
    liveObservation: (candidate) => candidate === handle ? observation : undefined })
  yield* Effect.addFinalizer(() => Effect.sync(() => KernelReader.close(reader)))
  yield* KernelReader.bind(reader, scopeKey)
  yield* KernelReader.ensureScope(reader)
  const visible = { visibility: "visible" as const, projectionKey, revision: "1", cursor: "1",
    conversationType: 1 as const, targetId: message.targetId, readOrdinal: "0", admittedOrdinal: "1",
    liveUnread: "1", storedUnread: "1", latestMessageId: message.messageId, latestSequence: message.sequence,
    latestMessageTime: now, nextExpiryAt: message.expiresAt }
  const changes = { version: 1 as const, scopeKey, after: "0", upper: "1", scanCursor: "1", scanProjectionKey: projectionKey,
    pageToken: "", windowComplete: true, caughtUp: true, serverNow: now, items: [visible] }
  yield* KernelReader.applyChanges(reader, changes)
  yield* KernelReader.applyMessages(reader, { version: 1, scopeKey, projectionKey, projectionRevision: "1",
    direction: "newer", nextDeliveryCursor: "1", finished: true, serverNow: now, items: [message] }, undefined,
    options?.history ? undefined : handle)
  yield* KernelReader.checkpoint(reader, [projectionKey], true)
  const row = yield* db.select().from(IMKernelReaderMessageTable).where(eq(IMKernelReaderMessageTable.effect_key, message.effectKey)).get()
  const projection = yield* KernelReader.projection(reader, projectionKey)
  if (!row?.local_message_id || !projection?.local_group_id) throw new Error("Actual reader did not write its original source")
  const enrolled = yield* db.transaction((tx) => KernelReceiverMapping.requireCurrent(tx,
    { targetID: mapping.targetID, workspaceID: target.scope.workspaceID, localUserID: "server", source: nativeSource }))
  const proof = Schema.decodeUnknownSync(IMTaskAuthoritySchema.SourceProof)({
    instanceID: enrolled.principal.instanceID, securityNamespaceID: target.scope.securityNamespaceID,
    namespaceBindingHash: enrolled.registered.namespaceBindingHash, realmID: nativeSource.realm,
    appkeyID: nativeSource.appkey, orgID: String(nativeSource.orgID), senderID: message.senderId,
    receiverID: nativeSource.senderID, conversationType: "1", conversationID: message.targetId,
    kernelMessageID: message.messageId, intentID: null, origin: "kernel_live", revision: enrolled.principal.revision,
    generation: observation.transportGeneration, expiresAt: message.expiresAt, proofHash: "f".repeat(64),
    reader: { readerKey: row.reader_key, effectKey: row.effect_key, bindingKey: row.binding_key,
      projectionKey: row.projection_key, scopeKey, immutableHash: row.immutable_hash,
      sourceHash: observation.sourceHash, observationHash: KernelReader.hash(["deepagent.im.reader.live-observation.v1", observation]),
      mappingID: mapping.id, mappingHash: enrolled.recordHash, targetID: mapping.targetID,
      workspaceID: target.scope.workspaceID, localUserID: "server" },
  })
  const read = () => db.transaction((tx) => Effect.gen(function* () {
    const currentMessage = yield* tx.select().from(MessageTable).where(sql`${MessageTable.id}=${row.local_message_id}`).get()
    const group = yield* tx.select().from(GroupTable).where(sql`${GroupTable.id}=${projection.local_group_id}`).get()
    if (!currentMessage || !group) throw new Error("Actual original rows are unavailable")
    return yield* KernelTaskSnapshot.read(tx, currentMessage, group, proof)
  }), { behavior: "immediate" })
  return { db, reader, proof, row, mapping, policy, message, changes, visible, read }
})

function code<A, E>(exit: Exit.Exit<A, E>) {
  if (Exit.isSuccess(exit)) return "success"
  const error = Cause.squash(exit.cause)
  return typeof error === "object" && error !== null && "code" in error ? error.code : String(error)
}
function zero(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    expect(yield* db.all(`SELECT (SELECT count(*) FROM session) sessions,
      (SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM work_execution) work,
      (SELECT count(*) FROM session_v2_provider_turn_receipt) receipts,(SELECT count(*) FROM session_provider_attempt) attempts,
      (SELECT count(*) FROM work_count_acquisition) counts,(SELECT count(*) FROM work_dispatch_reservation) dispatches`))
      .toEqual([{ sessions: 0, inputs: 0, work: 0, receipts: 0, attempts: 0, counts: 0, dispatches: 0 }])
    expect(yield* db.all("SELECT member_id FROM im_members")).toEqual([{ member_id: "server" }])
  })
}

test("actual kr1 snapshot hash survives ordinary projection revision and unread changes", () => isolated(Effect.gen(function* () {
  const s = yield* setup()
  const original = yield* s.read()
  expect(original.reader.immutableHash).toBe(s.row.immutable_hash)
  expect(original.membership).toHaveLength(1)
  yield* KernelReader.applyChanges(s.reader, { ...s.changes, after: "1", upper: "2", scanCursor: "2",
    items: [{ ...s.visible, revision: "2", cursor: "2", readOrdinal: "1", liveUnread: "0", storedUnread: "0" }] })
  const updated = yield* s.read()
  expect(KernelReader.hash(updated)).toBe(KernelReader.hash(original))
  expect(updated).toEqual(original)
  yield* zero(s.db)
})))

test("history-first source cannot become a task snapshot", () => isolated(Effect.gen(function* () {
  const s = yield* setup({ history: true })
  expect(code(yield* s.read().pipe(Effect.exit))).toBe("IM_TASK_SOURCE_UNAVAILABLE")
  yield* zero(s.db)
})))

for (const scenario of ["absent-source-hash", "immutable-hash", "body", "mapping-hash"] as const)
  test(`actual kr1 ${scenario} mismatch refuses without execution`, () => isolated(Effect.gen(function* () {
    const s = yield* setup()
    expect(code(yield* s.read().pipe(Effect.exit))).toBe("success")
    if (scenario === "absent-source-hash") yield* s.db.run(sql`UPDATE im_kernel_reader_message
      SET metadata=json_remove(metadata,'$.firstSeen.sourceHash') WHERE effect_key=${s.row.effect_key}`)
    if (scenario === "immutable-hash") yield* s.db.run(sql`UPDATE im_kernel_reader_message
      SET immutable_hash=${"9".repeat(64)} WHERE effect_key=${s.row.effect_key}`)
    if (scenario === "body") yield* s.db.run(sql`UPDATE im_messages SET content='{"content":"changed"}' WHERE id=${s.row.local_message_id}`)
    if (scenario === "mapping-hash") {
      const current = yield* s.db.transaction((tx) => LocalOperator.requireCurrent(tx))
      yield* LocalOperator.rotate(s.db, { operationID: "rotate-mapping", expectedRevision: current.revision,
        username: current.username, credentialVerifier: passwordVerifier,
        policy: { ...s.policy, kernelReceivers: [{ ...s.policy.kernelReceivers[0], id: "replacement-mapping" }] },
      }).pipe(Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(current)))
    }
    expect(code(yield* s.read().pipe(Effect.exit))).toBe("IM_TASK_SOURCE_UNAVAILABLE")
    yield* zero(s.db)
  })))

test("actual source expiry rejects its original fixed proof", () => isolated(Effect.gen(function* () {
  const s = yield* setup({ expiryMs: 250 })
  expect(code(yield* s.read().pipe(Effect.exit))).toBe("success")
  yield* Effect.sleep(Math.max(0, s.message.expiresAt - Date.now()) + 2)
  expect(code(yield* s.read().pipe(Effect.exit))).toBe("IM_TASK_SOURCE_UNAVAILABLE")
  yield* zero(s.db)
})))

test("actual projection revoke refuses retained original source", () => isolated(Effect.gen(function* () {
  const s = yield* setup()
  yield* KernelReader.applyChanges(s.reader, { ...s.changes, after: "1", upper: "2", scanCursor: "2",
    items: [{ visibility: "revoked", projectionKey, revision: "2", cursor: "2" }] })
  expect(code(yield* s.read().pipe(Effect.exit))).toBe("IM_TASK_SOURCE_UNAVAILABLE")
  yield* zero(s.db)
})))

test("actual operator revoke refuses retained snapshot and absent host seam grants nothing", () => isolated(Effect.gen(function* () {
  const s = yield* setup()
  expect(code(yield* s.db.transaction((tx) => LocalTaskAuth.verifySource(tx, s.row.local_message_id!)).pipe(Effect.exit)))
    .toBe("LOCAL_TASK_SOURCE_UNAVAILABLE")
  const current = yield* s.db.transaction((tx) => LocalOperator.requireCurrent(tx))
  yield* LocalOperator.revoke(s.db, { operationID: "revoke-snapshot", expectedRevision: current.revision })
    .pipe(Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(current)))
  expect(code(yield* s.read().pipe(Effect.exit))).toBe("IM_TASK_SOURCE_UNAVAILABLE")
  yield* zero(s.db)
})))
