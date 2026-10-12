import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Option, Ref, Schema, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMBroadcasterLive, IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { LocalOperatorSchema } from "@deepagent-code/core/im/local-operator.schema"
import { LocalTaskAuth } from "@deepagent-code/core/im/local-task-auth"
import { IMTaskAuthority } from "@deepagent-code/core/im/task-authority"
import { IMTaskStatusNotice } from "@deepagent-code/core/im/task-status-notice"
import { IMTaskStatusNoticeSchema } from "@deepagent-code/core/im/task-status-notice.schema"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { WorkAuthorityFixture } from "../../../../core/test/fixture/work-authority"
import { InstanceStore } from "@/project/instance-store"
import { LocalTaskAuthority } from "@/im/local-task-authority"
import { AuthRuntime } from "@/im/auth-runtime"
import { KernelConfig } from "@/im/kernel/config"
import { IMKernelExchange } from "@/im/kernel/exchange"
import { IMKernelSync } from "@/im/kernel/sync"
import { KernelTaskSource } from "@/im/kernel/task-source"
import { IMTaskStatusNoticeHost } from "@/im/task-status-notice"
import { IMTaskStatusDispatch } from "@/im/task-status-dispatch"
import { IMReplyOutbox } from "@/im/im-reply-outbox"
import { ReaderInstanceFixture } from "../reader-instance-fixture"

const root = process.argv[2]!
const mode = process.argv[3]!
const origin = process.argv[4]!
const cold = mode === "cold"
const Census = Schema.Struct({ sessions: Schema.Number, inputs: Schema.Number, work: Schema.Number, grants: Schema.Number,
  providers: Schema.Number, counts: Schema.Number, dispatches: Schema.Number })
const Ready = Schema.Struct({ receipt: IMTaskStatusNoticeSchema.RefuseReceipt, noticeHash: Schema.String,
  deliveryState: Schema.Literals(["unknown", "acknowledged"]), kernelMessageID: Schema.NullOr(Schema.String),
  deliveryHash: Schema.String, outbox: Schema.Struct({ status: Schema.String, attempts: Schema.Number }), zeroExecution: Census })
const stage = { value: "private-installation" }
const wait = <A, E, R>(effect: Effect.Effect<A | undefined, E, R>) => Effect.gen(function* () {
  for (const attempt of Array.from({ length: 250 }, (_, index) => index)) {
    const value = yield* effect
    if (value !== undefined) return value
    assert(attempt < 249, `Observation exceeded its bounded wait: ${stage.value}`)
    yield* Effect.sleep("20 millis")
  }
  return yield* Effect.die(new Error("Unreachable bounded wait"))
})
const save = (name: string, value: unknown) => Effect.promise(() => fs.writeFile(path.join(root, name), JSON.stringify(value), { mode: 0o600 }))

// Only the existing installation identity is shared across cold processes. No model,
// Session runner or Native Work graph is built by this protocol/notice fixture.
await Effect.runPromise(LocalTaskAuthority.initializeInstallation())
const config = { appkey: "status-notice-fault-peer", navigator: origin, token: "private-first-seen-token",
  userID: "receiver", identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" } }
const database = Database.layerFromPath(path.join(root, "authority.sqlite"))
const base = Layer.mergeAll(database, ReaderInstanceFixture.layer, ReaderInstanceFixture.registry, IMBroadcasterLive,
  Layer.mock(AgentListProviderService, {
    listAgents: () => Effect.die("Unexpected model/agent discovery"),
    findByTrigger: () => Effect.die("Unexpected model/agent execution"),
    findByCapability: () => Effect.die("Unexpected model/agent execution"),
  }))
const repository = IMRepositoryLive.pipe(Layer.provide(base))
const sourceLayer = KernelTaskSource.layer.pipe(Layer.provide(base))
const noticeLayer = IMTaskStatusNoticeHost.layer.pipe(Layer.provide(sourceLayer), Layer.provide(base))
const dispatchLayer = IMTaskStatusDispatch.layer.pipe(Layer.provide(noticeLayer))
const engineLayer = IMKernelSync.layerFromConfig(config, {
  inspectConversation: (input) => IMKernelExchange.inspectConversation({ ...input, facadeURL: origin,
    key: "private-witness-key" }).pipe(Effect.provide(FetchHttpClient.layer)),
}).pipe(Layer.provide(dispatchLayer), Layer.provide(repository), Layer.provide(base))
const identity = LocationIdentity.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer))
const services = Layer.mergeAll(base, repository, sourceLayer, noticeLayer, dispatchLayer, engineLayer, identity, LocalTaskAuth.layer)

await Effect.runPromise(Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const engine = yield* IMKernelSync.Service
  const store = yield* InstanceStore.Service
  const notices = yield* IMTaskStatusNoticeHost.Service
  const source = yield* KernelTaskSource.Service
  const repo = yield* IMRepository
  const broadcaster = yield* IMBroadcasterService
  stage.value = "connecting"
  yield* wait(SubscriptionRef.get(engine.state).pipe(Effect.map((value) => value === "connected" ? true : undefined)))
  const instance = yield* store.load({ directory: path.join(root, "project") })
  const placement = yield* (yield* LocationIdentity.Service).resolve({ boundary: { kind: "implicit_local" },
    directory: AbsolutePath.make(instance.directory), project: { kind: "registered_root", observedProjectId: instance.project.id } })
  const configured = yield* LocalTaskAuthority.configured({ username: "status-fault-operator", password: Option.some("private-status-fault-password") })
  const target = { scope: { actorID: "status-fault-operator", workspaceID: placement.canonicalRoot,
    securityNamespaceID: placement.securityNamespaceId, projectScopeKey: placement.projectScopeKey },
    location: { directory: placement.canonicalRoot }, agentID: "build",
    profile: { id: WorkAuthorityPolicy.TEXT_ONLY_PROFILE.id, version: 1 as const, hash: WorkAuthorityPolicy.TEXT_ONLY_PROFILE_HASH },
    provider: WorkAuthorityFixture.binding().provider,
    budget: { ...WorkAuthorityPolicy.TEXT_ONLY_PROFILE.budget, maxTotalTokens: 8000 }, durationMs: 60_000 }
  if (!cold) {
    const namespace = yield* db.get<{ binding_hash: string }>(sql`SELECT binding_hash FROM context_security_namespace WHERE id=${placement.securityNamespaceId}`)
    assert(namespace)
    const transport = KernelConfig.deliverySource(config)
    const now = Date.now()
    yield* LocalOperator.enroll(db, { operationID: "enroll-status-fault", operatorID: target.scope.actorID,
      username: "status-fault-operator",
      credentialVerifier: yield* Effect.promise(() => AuthRuntime.hash(configured.password)),
      policy: { version: 1, targets: [{ id: "review", locationKey: placement.locationKey,
        namespaceBindingHash: namespace.binding_hash, target }], kernelReceivers: [{ id: "original-receiver", targetID: "review",
        realmID: transport.realm, appkeyID: transport.appkey, orgID: 1, receiverID: "receiver", localUserID: "server",
        issuedAt: now, expiresAt: now + LocalOperatorSchema.KERNEL_RECEIVER_LIFETIME_MS }] } })
      .pipe(Effect.provideService(LocalOperator.Runtime, configured.runtime))
  }
  const witness = yield* LocalTaskAuthority.authenticatePassword(db, configured.runtime, "status-fault-operator", configured.password)
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => LocalTaskAuthority.provide({ runtime: configured.runtime, witness }, effect)
    .pipe(Effect.provideService(LocalTaskAuth.KernelSource, source.verifier))
  const lease = yield* engine.acquireReader!({ instance, workspaceID: placement.canonicalRoot, userID: "server",
    instanceCurrent: store.peek(instance.directory).pipe(Effect.map((value) => value === instance)) })
  yield* lease.engine.catchUp
  yield* wait(SubscriptionRef.get(lease.reader.state).pipe(Effect.map((value) => value.state === "ready" ? true : undefined)))
  yield* source.bindFacade({ engine: yield* Ref.make(Option.some(engine)) })
  const census = () => db.get<{ sessions: number; inputs: number; work: number; grants: number; providers: number; counts: number; dispatches: number }>(sql`
    SELECT (SELECT count(*) FROM session) sessions,(SELECT count(*) FROM session_input) inputs,
      (SELECT count(*) FROM work_execution) work,(SELECT count(*) FROM im_task_grant) grants,
      (SELECT count(*) FROM session_provider_attempt) providers,(SELECT count(*) FROM work_count_acquisition) counts,
      (SELECT count(*) FROM work_dispatch_reservation) dispatches`)
  const prior = cold ? yield* Effect.promise(async () => Schema.decodeUnknownSync(Ready)(await Bun.file(path.join(root, "ready.json")).json())) : undefined
  const receipt = prior ? prior.receipt : yield* Effect.gen(function* () {
    stage.value = "original-live-source"
    yield* Effect.promise(async () => {
      const response = await fetch(new URL("/_fixture/publish-source", origin), { method: "POST" })
      assert.equal(response.status, 200)
    })
    const row = yield* wait(db.get<{ local_message_id: string; metadata: string }>(sql`
      SELECT local_message_id,metadata FROM im_kernel_reader_message WHERE message_id='status-fault-source'`))
    assert.equal(JSON.parse(row.metadata).firstSeen?.origin, "kernel_live")
    yield* source.prepareMessage({ messageID: row.local_message_id })
    const request = yield* provide(IMTaskAuthority.propose(db, { messageID: row.local_message_id,
      target, clientRequestID: "status-fault-proposal", auditedText: JSON.stringify({ content: "native status-fault-source 中文" }) }))
    stage.value = "explicit-refusal"
    return yield* provide(notices.refuse({ requestID: request.request_id, operationID: "refuse-status-fault",
      expectedRevision: request.revision, directory: instance.directory }))
  })
  const notice = yield* notices.read(receipt.noticeID)
  assert(notice)
  const originalNotice = KernelDelivery.hash(notice)
  const delivery = { db, repo, broadcaster, notices, kernelSync: engine }
  if (!cold) {
    const item = yield* IMReplyOutbox.claimDueReply(db, { ownerToken: "status-fault-original-owner", leaseMs: 500 })
    assert(item)
    assert.equal(item.id, notice.outboxID)
    stage.value = "original-deliverReply"
    yield* IMReplyOutbox.deliverReply(delivery, item)
    stage.value = "waiting-for-physical-frontier"
    const frontier = yield* wait(KernelDelivery.read(db, notice.deliveryMessageID).pipe(Effect.map((row) =>
      row?.state === (mode === "pub-no-ack" ? "unknown" : "acknowledged") ? row : undefined)))
    const outbox = yield* db.get<{ status: string; attempts: number }>(sql`SELECT status,attempts FROM im_reply_outbox WHERE id=${notice.outboxID}`)
    assert.equal(outbox?.status, "delivering")
    assert.deepEqual(yield* census(), { sessions: 0, inputs: 0, work: 0, grants: 0, providers: 0, counts: 0, dispatches: 0 })
    yield* save("ready.json", { receipt, noticeHash: originalNotice, deliveryState: frontier.state,
      kernelMessageID: frontier.kernel_message_id, deliveryHash: KernelDelivery.hash(frontier), outbox,
      zeroExecution: yield* census() })
    // The original delivery caller has returned. The parent SIGKILLs this process
    // before markDelivered; no SQL terminal or fake acknowledgement is injected.
    yield* Effect.never
  }
  stage.value = "cold-drainPass"
  assert(prior)
  const drained = yield* IMReplyOutbox.drainPass(delivery, { maxClaims: 1 })
  yield* lease.engine.drainPending
  const current = yield* KernelDelivery.read(db, notice.deliveryMessageID)
  assert(current)
  assert.equal(KernelDelivery.hash(current), prior.deliveryHash)
  assert.equal(KernelDelivery.hash(yield* notices.read(receipt.noticeID)), prior.noticeHash)
  const outbox = yield* db.get<{ status: string; attempts: number }>(sql`SELECT status,attempts FROM im_reply_outbox WHERE id=${notice.outboxID}`)
  assert.deepEqual(outbox, { status: "delivered", attempts: 2 })
  assert.equal(drained, 1)
  assert.equal(yield* IMReplyOutbox.drainPass(delivery, { maxClaims: 1 }), 0)
  assert.deepEqual(yield* census(), prior.zeroExecution)
  yield* save("cold.json", { state: current.state, kernelMessageID: current.kernel_message_id,
    outbox, drained, zeroExecution: yield* census(), immutableNoticeSame: true, originalDeliverySame: true })
}).pipe(Effect.provide(services), Effect.scoped, Effect.onError(() => save("failure-stage.json", { stage: stage.value }))))
