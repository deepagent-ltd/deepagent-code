import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { Cause, Context, Effect, Exit, Layer, Scope } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { IMRepository, IMRepositoryLive } from "../src/im/repository"
import { IMTaskAuthority } from "../src/im/task-authority"
import { IMTaskStatusNotice } from "../src/im/task-status-notice"
import { IMTaskStatusNoticeSchema } from "../src/im/task-status-notice.schema"
import { LocalOperator } from "../src/im/local-operator"
import { LocalTaskAuth } from "../src/im/local-task-auth"
import { LocalTaskPolicy } from "../src/im/local-task-policy"
import { IMTaskAuthorityFixture } from "./fixture/im-task-authority"
import { WorkAuthorityFixture } from "./fixture/work-authority"
import { WorkAuthority } from "../src/session/work-authority"
import { SessionStore } from "../src/session/store"
import { SessionSchema } from "../src/session/schema"
import { ReplyBodyRetirement } from "../src/im/reply-body-retirement"

const runtime = { instanceID: "notice-local-instance", installationKeyHash: "1".repeat(64), credentialBinding: "2".repeat(64) }
const target = { ...IMTaskAuthorityFixture.target,
  scope: { ...IMTaskAuthorityFixture.target.scope, workspaceID: IMTaskAuthorityFixture.target.location.directory } }
const password = await Bun.password.hash("private-notice-core-password", { algorithm: "argon2id", memoryCost: 4096, timeCost: 2 })
const setup = Effect.gen(function* () {
  yield* IMTaskAuthorityFixture.initialize()
  const db = (yield* Database.Service).db
  const repo = yield* IMRepository
  // Align this controlled placement seed with the original Work projection fixture's
  // location key before any operator/source/request authority is captured.
  yield* db.run(sql`UPDATE context_location_identity SET location_key=${target.location.directory} WHERE location_key='task-location'`)
  yield* LocalOperator.enroll(db, { operationID: "notice-enroll", operatorID: target.scope.actorID,
    username: "notice-operator", credentialVerifier: password, policy: { version: 1, targets: [{ id: "review",
      locationKey: target.location.directory, namespaceBindingHash: IMTaskAuthorityFixture.proof.namespaceBindingHash, target }] } })
  const operator = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
  const witness = LocalOperator.mutationWitness(operator)
  const group = yield* repo.createGroup({ workspaceID: target.location.directory, type: "project", name: "notice", createdBy: "server" })
  yield* LocalTaskPolicy.enable(db, { operationID: "notice-mode", expectedRevision: 0, groupID: group.id, targetID: "review" })
    .pipe(Effect.provideService(LocalOperator.Mutation, witness))
  const original = yield* repo.createMessage({ clientRequestID: "source", groupID: group.id, senderID: "server", senderType: "user",
    type: "text", content: "Explicitly review this task." }).pipe(Effect.provideService(LocalOperator.Mutation, witness))
  const request = yield* IMTaskAuthority.propose(db, { clientRequestID: "review", messageID: original.id,
    auditedText: original.content, target }).pipe(Effect.provideService(LocalOperator.Mutation, witness))
  return { db, repo, witness, request, original }
})
type Env = Effect.Success<typeof setup>
async function isolated(body: (env: Env) => Effect.Effect<void, unknown, IMTaskAuthority.Authority | LocalOperator.Runtime | LocalOperator.Mutation | Database.Service | Scope.Scope>) {
  const directory = await mkdtemp("/tmp/dac-task-status-core-")
  try {
    const database = WorkAuthorityFixture.database(path.join(directory, "private.sqlite"))
    await Effect.runPromise(Effect.gen(function* () {
      const env = yield* setup
      yield* body(env).pipe(Effect.provideService(LocalOperator.Mutation, env.witness))
    }).pipe(Effect.provide(LocalTaskAuth.layer), Effect.provideService(LocalOperator.Runtime, runtime),
      Effect.provide(Layer.provideMerge(IMRepositoryLive, database)), Effect.scoped))
  } finally { await rm(directory, { recursive: true, force: true }) }
}
function code<A, E>(exit: Exit.Exit<A, E>) {
  if (Exit.isSuccess(exit)) return "success"
  const value = Cause.squash(exit.cause)
  return typeof value === "object" && value !== null && "code" in value ? value.code : String(value)
}
const zeroExecution = (db: Env["db"]) => db.get("SELECT (SELECT count(*) FROM session) sessions,(SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM work_execution) work,(SELECT count(*) FROM session_provider_attempt) providers")

test("explicit refusal uses original authenticated local origin, is exact and blocks accept before live-source lookup", () => isolated((env) => Effect.gen(function* () {
  const input = { requestID: env.request.request_id, operationID: "refuse-original", expectedRevision: 1, directory: target.location.directory }
  const value = yield* IMTaskStatusNotice.refuse(env.db, input)
  expect(value.receipt.state).toBe("refused")
  expect(value.notice.sessionID).toBeNull()
  expect(value.notice.grantID).toBeNull()
  expect(value.notice.text).toBe(IMTaskStatusNoticeSchema.templates.refused)
  const before = yield* env.db.all("SELECT * FROM im_task_status_notice")
  expect(yield* IMTaskStatusNotice.refuse(env.db, input)).toEqual(value)
  expect(code(yield* IMTaskStatusNotice.refuse(env.db, { ...input, operationID: "another-operation" }).pipe(Effect.exit))).toBe("TASK_NOTICE_CHANGED")
  yield* env.db.run("DELETE FROM im_task_source")
  expect(yield* IMTaskStatusNotice.refuse(env.db, input)).toEqual(value)
  expect(code(yield* IMTaskAuthority.accept(env.db, { requestID: env.request.request_id, operationID: "accept-after-refuse", expectedRevision: 1 }).pipe(Effect.exit))).toBe("IM_TASK_REVISION_CONFLICT")
  expect(yield* env.db.all("SELECT * FROM im_task_status_notice")).toEqual(before)
  expect(yield* zeroExecution(env.db)).toEqual({ sessions: 0, inputs: 0, work: 0, providers: 0 })
})))

test("original unknown dispatch reducer yields one recovery occurrence and cancellation remains a separate notice", () => isolated((env) => Effect.gen(function* () {
  const grant = yield* IMTaskAuthority.accept(env.db, { requestID: env.request.request_id,
    operationID: "accept-unresolved", expectedRevision: 1 })
  const verifier = Context.get(yield* Layer.build(WorkAuthorityFixture.verifier), WorkAuthority.Verifier)
  yield* Effect.gen(function* () {
    yield* WorkAuthority.reserve(env.db, { binding: grant.binding })
    // Existing controlled Session/attempt fixture, followed by the original production
    // reservation and unknown reducer. No SQL manufactures a successful/unknown terminal.
    yield* WorkAuthorityFixture.materialize(grant.binding, { text: env.original.content })
    const reservation = yield* env.db.transaction((tx) => WorkAuthority.reserveDispatchInTransaction(tx,
      WorkAuthorityFixture.dispatch(grant.binding)))
    yield* env.db.transaction((tx) => WorkAuthority.authorizeDispatchInTransaction(tx, WorkAuthorityFixture.seal(reservation)))
    yield* env.db.transaction((tx) => WorkAuthority.settleDispatchInTransaction(tx,
      { reservationID: reservation.reservation_id, outcome: "unknown" }))
  }).pipe(Effect.provideService(WorkAuthority.Verifier, { ...verifier, authorizeSource: IMTaskAuthority.authorizeWorkSource }))
  expect(yield* IMTaskStatusNotice.collect(env.db, env.request.request_id, "recovery_required")).toBeUndefined()
  const store = Context.get(yield* Layer.build(SessionStore.layer), SessionStore.Service)
  expect(yield* store.release(SessionSchema.ID.make(grant.session_id), 7)).toBe(true)
  const recovery = yield* IMTaskStatusNotice.collect(env.db, env.request.request_id, "recovery_required")
  expect(recovery?.basis).toMatchObject({ kind: "recovery_required", evidence: { type: "work_unknown", occurrenceID: grant.work_id } })
  expect(yield* IMTaskStatusNotice.collect(env.db, env.request.request_id, "recovery_required")).toEqual(recovery)
  const before = yield* env.db.get("SELECT state,charged_tokens FROM work_dispatch_reservation")
  yield* IMTaskAuthority.cancelAndControl(env.db, { requestID: env.request.request_id, operationID: "cancel-unresolved",
    expectedGrantRevision: 1, expectedControlRevision: 1, directory: target.location.directory })
  expect((yield* IMTaskStatusNotice.collect(env.db, env.request.request_id, "cancel_requested"))?.kind).toBe("cancel_requested")
  if (!recovery) return yield* Effect.die("Recovery notice missing")
  expect(code(yield* env.db.transaction((tx) => IMTaskStatusNotice.requireCurrentInTransaction(tx, recovery.noticeID)).pipe(Effect.exit))).toBe("TASK_NOTICE_CHANGED")
  expect(yield* env.db.get("SELECT state,charged_tokens FROM work_dispatch_reservation")).toEqual(before)
  expect((yield* env.db.all("SELECT notice_id FROM im_task_status_notice")).length).toBe(2)
})))

test("late immutable receipt insert failure rolls back refusal and the same command can succeed", () => isolated((env) => Effect.gen(function* () {
  const input = { requestID: env.request.request_id, operationID: "late-refuse", expectedRevision: 1, directory: target.location.directory }
  yield* env.db.run("CREATE TEMP TRIGGER reject_notice BEFORE INSERT ON im_task_status_notice BEGIN SELECT RAISE(ABORT,'private late receipt failure'); END")
  expect(Exit.isFailure(yield* IMTaskStatusNotice.refuse(env.db, input).pipe(Effect.exit))).toBe(true)
  expect(yield* env.db.all("SELECT notice_id FROM im_task_status_notice")).toEqual([])
  yield* env.db.run("DROP TRIGGER reject_notice")
  expect((yield* IMTaskStatusNotice.refuse(env.db, input)).receipt.operationID).toBe(input.operationID)
  expect(yield* zeroExecution(env.db)).toEqual({ sessions: 0, inputs: 0, work: 0, providers: 0 })
})))

test("prepared fixed status authority cannot survive real current operator revocation", () => isolated((env) => Effect.gen(function* () {
  const result = yield* IMTaskStatusNotice.refuse(env.db, { requestID: env.request.request_id,
    operationID: "refuse-before-revoke", expectedRevision: 1, directory: target.location.directory })
  expect(yield* env.db.transaction((tx) => IMTaskStatusNotice.requireCurrentInTransaction(tx, result.notice.noticeID))).toEqual(result.notice)
  const before = yield* env.db.all("SELECT * FROM im_task_status_notice")
  yield* LocalOperator.revoke(env.db, { operationID: "revoke-operator", expectedRevision: 1 })
  expect(Exit.isFailure(yield* env.db.transaction((tx) => IMTaskStatusNotice.requireCurrentInTransaction(tx, result.notice.noticeID)).pipe(Effect.exit))).toBe(true)
  expect(yield* env.db.all("SELECT * FROM im_task_status_notice")).toEqual(before)
  expect(yield* zeroExecution(env.db)).toEqual({ sessions: 0, inputs: 0, work: 0, providers: 0 })
})))

test("revoked execution grant permits only its current cancellation template; missing or copied creation proof writes no message", () => isolated((env) => Effect.gen(function* () {
  const grant = yield* IMTaskAuthority.accept(env.db, { requestID: env.request.request_id, operationID: "accept-once", expectedRevision: 1 })
  yield* IMTaskAuthority.cancelAndControl(env.db, { requestID: env.request.request_id, operationID: "cancel-once", expectedGrantRevision: 1,
    expectedControlRevision: null, directory: target.location.directory }).pipe(Effect.provide(WorkAuthorityFixture.verifier))
  const notice = yield* IMTaskStatusNotice.collect(env.db, env.request.request_id)
  expect(notice?.kind).toBe("cancel_requested")
  expect(notice?.grantID).toBe(grant.grant_id)
  expect(notice?.sessionID).toBeNull()
  if (!notice) return yield* Effect.die("Cancellation notice missing")
  expect(yield* env.db.transaction((tx) => IMTaskStatusNotice.requireCurrentInTransaction(tx, notice.noticeID))).toEqual(notice)
  // Only the owned row fixture is seeded here; Host tests exercise appendReply itself.
  yield* env.db.transaction((tx) => Effect.gen(function* () {
    yield* tx.run(sql`INSERT INTO im_reply_outbox(id,delivery_message_id,session_id,group_id,agent_id,trigger_message_id,
      reply_message_id,reply_text,status,attempts,available_at,time_created,time_updated) VALUES
      (${notice.outboxID},${notice.deliveryMessageID},${notice.requestID},${notice.groupID},${notice.agentID},${notice.sourceMessageID},
      ${notice.noticeID},${notice.text},'pending',0,0,${notice.createdAt},${notice.createdAt})`)
    yield* ReplyBodyRetirement.initialize(tx, notice.outboxID)
  }), { behavior: "immediate" })
  const message = { id: notice.deliveryMessageID, groupID: notice.groupID, senderID: notice.agentID, senderType: "agent" as const,
    type: "text" as const, content: notice.text,
    metadata: { type: "task_status_notice" as const, noticeID: notice.noticeID, requestID: notice.requestID, kind: notice.kind } }
  const before = yield* env.db.all("SELECT id FROM im_messages")
  expect(Exit.isFailure(yield* env.repo.createMessage(message).pipe(Effect.exit))).toBe(true)
  const original = {}
  const originals = new WeakSet([original])
  // Controlled purpose facet around the real CurrentOperator/LocalOrigin producer. This
  // tests the SQL/private frame boundary, not a signed Native transport capture.
  const authority = { verify: (tx: Parameters<typeof IMTaskStatusNotice.requireCurrentInTransaction>[0], input: { noticeID: string; original: object }) =>
    originals.has(input.original) ? IMTaskStatusNotice.requireCurrentInTransaction(tx, input.noticeID).pipe(
      Effect.mapError(() => new IMTaskStatusNoticeSchema.Error({ code: "TASK_NOTICE_UNAVAILABLE", message: "Current source unavailable" })),
      Effect.provide(LocalTaskAuth.layer), Effect.provideService(LocalOperator.Runtime, runtime)) :
      Effect.fail(new IMTaskStatusNoticeSchema.Error({ code: "TASK_NOTICE_UNAVAILABLE", message: "Original purpose capture missing" })) }
  expect(Exit.isFailure(yield* IMTaskStatusNotice.withCreation(env.db, notice.noticeID, { ...original }, env.repo.createMessage(message))
    .pipe(Effect.provideService(IMTaskStatusNotice.CreationAuthority, authority), Effect.exit))).toBe(true)
  expect(yield* env.db.all("SELECT id FROM im_messages")).toEqual(before)
  const created = yield* IMTaskStatusNotice.withCreation(env.db, notice.noticeID, original, env.repo.createMessage(message))
    .pipe(Effect.provideService(IMTaskStatusNotice.CreationAuthority, authority))
  expect(created.content).toBe(notice.text)
  expect((yield* env.repo.createMessage(message)).replayed).toBe(true)
  expect(yield* zeroExecution(env.db)).toEqual({ sessions: 0, inputs: 0, work: 0, providers: 0 })
})))
