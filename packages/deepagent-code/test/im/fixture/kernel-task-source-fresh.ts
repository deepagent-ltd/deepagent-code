export * as KernelTaskSourceFreshFixture from "./kernel-task-source-fresh"

import assert from "node:assert/strict"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Scope, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { LocalOperatorSchema } from "@deepagent-code/core/im/local-operator.schema"
import { LocalTaskAuth } from "@deepagent-code/core/im/local-task-auth"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { WorkAuthorityFixture } from "../../../../core/test/fixture/work-authority"
import { InstanceStore } from "@/project/instance-store"
import { LocalTaskAuthority } from "@/im/local-task-authority"
import { AuthRuntime } from "@/im/auth-runtime"
import { KernelConfig } from "@/im/kernel/config"
import { IMKernelExchange } from "@/im/kernel/exchange"
import { IMKernelSync } from "@/im/kernel/sync"
import { KernelTaskSource } from "@/im/kernel/task-source"
import { ReaderInstanceFixture } from "../reader-instance-fixture"
import { KernelTaskSourceWitnessFixture } from "./kernel-task-source-witness"

const wait = <A, E, R>(effect: Effect.Effect<A | undefined, E, R>) =>
  Effect.gen(function* () {
    for (const attempt of Array.from({ length: 200 }, (_, index) => index)) {
      const result = yield* effect
      if (result !== undefined) return result
      if (attempt === 199) return yield* Effect.die(new Error("bounded source-authority observation timed out"))
      yield* Effect.sleep("20 millis")
    }
    return yield* Effect.die(new Error("unreachable source-authority wait"))
  })
const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? error.code : undefined

export async function run(root: string) {
  const native = KernelTaskSourceWitnessFixture.make()
  const config = {
    appkey: `private-source-authority-${native.server.port}`,
    navigator: native.server.url.origin,
    token: "private-first-seen-token",
    userID: "receiver",
    identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" },
  }
  const database = Database.layerFromPath(`${root}/authority.sqlite`)
  const agents = Layer.mock(AgentListProviderService, {
    listAgents: () => Effect.die(new Error("Unexpected agent lookup in source-only fixture")),
    findByTrigger: () => Effect.die(new Error("Unexpected agent trigger in source-only fixture")),
    findByCapability: () => Effect.die(new Error("Unexpected agent capability in source-only fixture")),
  })
  const base = Layer.mergeAll(
    database,
    ReaderInstanceFixture.layer,
    ReaderInstanceFixture.registry,
    IMBroadcasterLive,
    agents,
  )
  const repository = IMRepositoryLive.pipe(Layer.provide(base))
  const inspection: { hold?: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> } } = {}
  const inspectConversation = (input: IMKernelExchange.InspectConversationInput) => Effect.gen(function* () {
    const hold = inspection.hold
    if (hold) { yield* Deferred.succeed(hold.entered, undefined); yield* Deferred.await(hold.release) }
    return yield* IMKernelExchange.inspectConversation({
      ...input,
      facadeURL: native.server.url.origin,
      key: "private-witness-key",
    }).pipe(Effect.provide(FetchHttpClient.layer))
  })
  const engineLayer = IMKernelSync.layerFromConfig(config, { inspectConversation }).pipe(
    Layer.provide(repository),
    Layer.provide(base),
  )
  const identity = LocationIdentity.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer))
  const services = Layer.mergeAll(base, repository, engineLayer, identity, LocalTaskAuth.layer)
  const stage = { value: "connecting" }
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const testScope = yield* Effect.scope
        const engine = yield* IMKernelSync.Service
        const store = yield* InstanceStore.Service
        yield* wait(
          SubscriptionRef.get(engine.state).pipe(Effect.map((value) => (value === "connected" ? true : undefined))),
        )
        const placement = yield* (yield* LocationIdentity.Service).resolve({
          boundary: { kind: "implicit_local" },
          directory: AbsolutePath.make(`${root}/project`),
          project: { kind: "registered_root" },
        })
        const namespace = (yield* db.get<{ binding_hash: string }>(
          sql`SELECT binding_hash FROM context_security_namespace WHERE id=${placement.securityNamespaceId}`,
        ))!
        const target = {
          scope: {
            actorID: "operator-source-authority",
            workspaceID: placement.canonicalRoot,
            securityNamespaceID: placement.securityNamespaceId,
            projectScopeKey: placement.projectScopeKey,
          },
          location: { directory: placement.canonicalRoot },
          agentID: "build",
          profile: {
            id: WorkAuthorityPolicy.TEXT_ONLY_PROFILE.id,
            version: 1,
            hash: WorkAuthorityPolicy.TEXT_ONLY_PROFILE_HASH,
          },
          provider: WorkAuthorityFixture.binding().provider,
          budget: { ...WorkAuthorityPolicy.TEXT_ONLY_PROFILE.budget, maxTotalTokens: 8_000 },
          durationMs: 60_000,
        }
        const source = KernelConfig.deliverySource(config)
        const now = Date.now()
        const policy = {
          version: 1 as const,
          targets: [
            { id: "review", locationKey: placement.locationKey, namespaceBindingHash: namespace.binding_hash, target },
          ],
          kernelReceivers: [
            {
              id: "receiver-original",
              targetID: "review",
              realmID: source.realm,
              appkeyID: source.appkey,
              orgID: 1,
              receiverID: "receiver",
              localUserID: "server" as const,
              issuedAt: now,
              expiresAt: now + LocalOperatorSchema.KERNEL_RECEIVER_LIFETIME_MS,
            },
          ],
        }
        stage.value = "actual-enrollment-and-password"
        yield* LocalTaskAuthority.initializeInstallation()
        const configured = yield* LocalTaskAuthority.configured({
          username: "private-source-operator",
          password: Option.some("private-source-password"),
        })
        const credentialVerifier = yield* Effect.promise(() => AuthRuntime.hash(configured.password))
        yield* LocalOperator.enroll(db, {
          operationID: "enroll-source-original",
          operatorID: target.scope.actorID,
          username: "private-source-operator",
          credentialVerifier,
          policy,
        }).pipe(Effect.provideService(LocalOperator.Runtime, configured.runtime))
        yield* LocalTaskAuthority.authenticatePassword(
          db,
          configured.runtime,
          "private-source-operator",
          configured.password,
        )
        const instance = yield* store.load({ directory: placement.canonicalRoot })
        const lease = yield* engine.acquireReader!({
          instance,
          workspaceID: placement.canonicalRoot,
          userID: "server",
          instanceCurrent: store.peek(placement.canonicalRoot).pipe(Effect.map((value) => value === instance)),
        })
        // Join the original acquisition hint before delivering a fresh source.
        // A message first committed by that history pass must remain history.
        yield* lease.engine.catchUp
        yield* wait(
          SubscriptionRef.get(lease.reader.state).pipe(
            Effect.map((value) => (value.state === "ready" ? true : undefined)),
          ),
        )
        const resolverScope = yield* Scope.make()
        const resolver = yield* KernelTaskSource.make.pipe(Effect.provideService(Scope.Scope, resolverScope))
        const facade = { engine: yield* Ref.make(Option.some(engine)) }
        yield* resolver.bindFacade(facade)
        stage.value = "actual-first-seen"
        native.add("source-for-authority")
        const row = yield* wait(
          db.get<{ local_message_id: string; metadata: string; immutable_hash: string }>(
            sql`SELECT local_message_id,metadata,immutable_hash FROM im_kernel_reader_message WHERE message_id='source-for-authority'`,
          ),
        )
        const messageID = row.local_message_id
        assert.equal(
          JSON.parse(row.metadata).firstSeen?.origin,
          "kernel_live",
          "Only a newly committed original live source can enter this fixture",
        )
        const verify = () => db.transaction((tx) => resolver.verifier.verify(tx, messageID)).pipe(
          Effect.provideService(LocalOperator.Runtime, configured.runtime),
        )
        const cuts = () => native.queries.filter((query) => query.topic === "qry_delivery_read_cut").length
        const hold = () => ({ entered: Deferred.makeUnsafe<void>(), release: Deferred.makeUnsafe<void>() })
        stage.value = "near-expiry-cache-cannot-satisfy-provider-boundary"
        const initial = cuts()
        const started = performance.now()
        yield* resolver.prepareMessage({ messageID })
        const original = yield* verify()
        assert.equal(cuts() - initial, 1)
        yield* Effect.sleep("850 millis")
        yield* resolver.prepareMessage({ messageID })
        assert.equal(cuts() - initial, 1)
        yield* resolver.prepareMessage({ messageID, fresh: true })
        assert.equal(cuts() - initial, 2)
        yield* Effect.sleep("200 millis")
        assert.ok(performance.now() - started > 1000)
        assert.deepEqual(yield* verify(), original)
        stage.value = "fresh-producer-joins-without-erasing-valid-cache"
        inspection.hold = hold()
        const concurrentCuts = cuts()
        const first = yield* Effect.forkChild(resolver.prepareMessage({ messageID, fresh: true }))
        yield* Deferred.await(inspection.hold.entered)
        assert.deepEqual(yield* verify(), original)
        const peers = yield* Effect.forEach(Array.from({ length: 4 }), () => Effect.forkIn(resolver.prepareMessage({ messageID, fresh: true }), testScope), { concurrency: "unbounded" })
        yield* Effect.sleep("30 millis")
        assert.equal(cuts() - concurrentCuts, 1)
        yield* Fiber.interrupt(first)
        yield* Deferred.succeed(inspection.hold.release, undefined)
        inspection.hold = undefined
        yield* Fiber.joinAll(peers)
        assert.equal(cuts() - concurrentCuts, 1)
        assert.deepEqual(yield* verify(), original)
        stage.value = "ordinary-pending-is-not-a-fresh-producer"
        yield* Effect.sleep("1010 millis")
        inspection.hold = hold()
        const pendingCuts = cuts()
        const ordinary = yield* Effect.forkChild(resolver.prepareMessage({ messageID }))
        yield* Deferred.await(inspection.hold.entered)
        const fresh = yield* Effect.forkChild(resolver.prepareMessage({ messageID, fresh: true }))
        yield* Effect.sleep("30 millis")
        yield* Deferred.succeed(inspection.hold.release, undefined)
        inspection.hold = undefined
        yield* Fiber.join(ordinary)
        yield* Fiber.join(fresh)
        assert.equal(cuts() - pendingCuts, 2)
        assert.deepEqual(yield* verify(), original)
        stage.value = "fresh-refuses-current-membership-without-cache-fallback"
        native.faults.members = ["receiver"]
        const deniedCuts = cuts()
        assert.equal(errorCode(yield* resolver.prepareMessage({ messageID, fresh: true }).pipe(Effect.flip)), "LOCAL_TASK_SOURCE_UNAVAILABLE")
        assert.equal(cuts() - deniedCuts, 1)
        native.faults.members = ["receiver", "sender"]
        yield* resolver.prepareMessage({ messageID, fresh: true })
        assert.deepEqual(yield* verify(), original)
        stage.value = "late-owner-cannot-install-fresh-slot"
        inspection.hold = hold()
        const late = yield* Effect.forkChild(resolver.prepareMessage({ messageID, fresh: true }).pipe(Effect.flip))
        yield* Deferred.await(inspection.hold.entered)
        yield* Ref.set(facade.engine, Option.none())
        yield* Deferred.succeed(inspection.hold.release, undefined)
        inspection.hold = undefined
        assert.equal(errorCode(yield* Fiber.join(late)), "LOCAL_TASK_SOURCE_UNAVAILABLE")
        assert.equal(errorCode(yield* verify().pipe(Effect.flip)), "LOCAL_TASK_SOURCE_UNAVAILABLE")
        yield* Scope.close(resolverScope, Exit.void)
        yield* lease.reader.request(Effect.void)
        const counts = yield* db.get(sql`SELECT (SELECT count(*) FROM im_task_source) sources,(SELECT count(*) FROM im_task_request) requests,(SELECT count(*) FROM im_task_grant) grants,(SELECT count(*) FROM work_execution) work,(SELECT count(*) FROM session_provider_attempt) providers`)
        assert.deepEqual(counts, { sources: 0, requests: 0, grants: 0, work: 0, providers: 0 })
        return { ...counts, nearExpiryCacheReplaced: true, originalProofUnchanged: true, freshConcurrentCallers: 5,
          oneFreshPhysicalCapture: true, cancelledWaiterIsolated: true, ordinaryPendingNotFresh: true,
          validCacheRetainedDuringCapture: true, membershipDenialNoFallback: true, lateOwnerRefused: true }
      }).pipe(Effect.provide(services), Effect.scoped),
    )
    assert.ok(native.state.disconnected >= 1)
    await Bun.write(`${root}/result.json`, JSON.stringify({ ...result, closed: true }))
  } catch (error) {
    console.error({ stage: stage.value, error })
    throw error
  } finally {
    native.server.stop(true)
  }
}

if (process.env.DAC_KERNEL_TASK_SOURCE_FRESH_ROOT) await run(process.env.DAC_KERNEL_TASK_SOURCE_FRESH_ROOT)
