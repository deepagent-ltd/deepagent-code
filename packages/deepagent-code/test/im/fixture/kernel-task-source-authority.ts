export * as KernelTaskSourceAuthorityFixture from "./kernel-task-source-authority"

import assert from "node:assert/strict"
import { Context, Effect, Layer, Option, Ref, SubscriptionRef } from "effect"
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
import { LocalTaskPolicy } from "@deepagent-code/core/im/local-task-policy"
import { IMTaskAuthority } from "@deepagent-code/core/im/task-authority"
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

export async function run(root: string, accepted?: (input: {
  db: Database.Interface["db"]
  resolver: KernelTaskSource.Interface
  runtime: Context.Service.Shape<typeof LocalOperator.Runtime>
  native: ReturnType<typeof KernelTaskSourceWitnessFixture.make>
  grant: Effect.Success<ReturnType<typeof IMTaskAuthority.accept>>
  request: Effect.Success<ReturnType<typeof IMTaskAuthority.propose>>
  messageID: string
  projectID: string
}) => Effect.Effect<Record<string, number | boolean>, unknown>, options?: { durationMs?: number }) {
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
  const inspectConversation = (input: IMKernelExchange.InspectConversationInput) =>
    IMKernelExchange.inspectConversation({
      ...input,
      facadeURL: native.server.url.origin,
      key: "private-witness-key",
    }).pipe(Effect.provide(FetchHttpClient.layer))
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
        const engine = yield* IMKernelSync.Service
        const store = yield* InstanceStore.Service
        const repo = yield* IMRepository
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
          durationMs: options?.durationMs ?? 60_000,
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
        const witness = yield* LocalTaskAuthority.authenticatePassword(
          db,
          configured.runtime,
          "private-source-operator",
          configured.password,
        )
        const authorization = { runtime: configured.runtime, witness }
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
        const resolver = yield* KernelTaskSource.make
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
        const proposal = {
          messageID,
          target,
          auditedText: native.messages[0].content,
          clientRequestID: "source-proposal-original",
        }
        const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          LocalTaskAuthority.provide(authorization, effect).pipe(
            Effect.provideService(LocalTaskAuth.KernelSource, resolver.verifier),
          )
        const emptyAuthority = () =>
          db.all(
            `SELECT (SELECT count(*) FROM im_task_source) sources,(SELECT count(*) FROM im_task_request) requests,(SELECT count(*) FROM im_task_grant) grants,(SELECT count(*) FROM work_execution) work`,
          )
        const zero = [{ sources: 0, requests: 0, grants: 0, work: 0 }]
        stage.value = "no-private-service-witness"
        assert.equal(
          errorCode(yield* provide(IMTaskAuthority.propose(db, proposal)).pipe(Effect.flip)),
          "IM_TASK_SOURCE_UNAVAILABLE",
        )
        assert.deepEqual(yield* emptyAuthority(), zero)
        const outside = yield* engine.withTaskSource!(
          { workspaceID: placement.canonicalRoot, localUserID: "server", messageID },
          (source) => Effect.succeed({ reader: source.reader, handle: source.handle }),
        )
        assert.equal(outside.reader.readTaskSource({ ...outside.handle }), undefined)
        assert.equal(
          errorCode(yield* provide(IMTaskAuthority.propose(db, proposal)).pipe(Effect.flip)),
          "IM_TASK_SOURCE_UNAVAILABLE",
        )
        assert.deepEqual(yield* emptyAuthority(), zero)
        stage.value = "expired-private-service-witness"
        yield* resolver.prepareMessage({ messageID })
        yield* Effect.sleep("1010 millis")
        assert.equal(
          errorCode(yield* provide(IMTaskAuthority.propose(db, proposal)).pipe(Effect.flip)),
          "IM_TASK_SOURCE_UNAVAILABLE",
        )
        assert.deepEqual(yield* emptyAuthority(), zero)
        stage.value = "native-mismatch-cannot-install-slot"
        native.faults.tupleMismatch = true
        assert.equal(
          (yield* resolver.prepareMessage({ messageID }).pipe(Effect.flip)).code,
          "LOCAL_TASK_SOURCE_UNAVAILABLE",
        )
        native.faults.tupleMismatch = false
        assert.equal(
          errorCode(yield* provide(IMTaskAuthority.propose(db, proposal)).pipe(Effect.flip)),
          "IM_TASK_SOURCE_UNAVAILABLE",
        )
        assert.deepEqual(yield* emptyAuthority(), zero)
        stage.value = "conflicting-source-owner"
        const conflicted = yield* KernelTaskSource.make
        yield* conflicted.bindFacade(facade)
        yield* conflicted.bindFacade({ engine: facade.engine })
        assert.equal(
          (yield* conflicted.prepareMessage({ messageID }).pipe(Effect.flip)).code,
          "LOCAL_TASK_SOURCE_UNAVAILABLE",
        )
        stage.value = "production-source-propose-accept"
        yield* resolver.prepareMessage({ messageID })
        const request = yield* provide(IMTaskAuthority.propose(db, proposal))
        assert.equal(request.state, "proposed")
        yield* resolver.prepareMessage({ messageID })
        const grant = yield* provide(
          IMTaskAuthority.accept(db, {
            requestID: request.request_id,
            operationID: "accept-source-original",
            expectedRevision: 1,
          }),
        )
        assert.equal(grant.state, "active")
        if (accepted) return yield* accepted({ db, resolver, runtime: configured.runtime, native, grant, request, messageID,
          projectID: instance.project.id })
        const storedSource = (yield* db.get<{ proof: string; snapshot_hash: string }>(
          sql`SELECT proof,snapshot_hash FROM im_task_source WHERE source_id=${request.source_id}`,
        ))!
        assert.equal(JSON.parse(storedSource.proof).reader.mappingID, "receiver-original")
        assert.equal(JSON.parse(storedSource.proof).intentID, null)
        assert.deepEqual(
          yield* db.all(
            `SELECT member_id FROM im_members WHERE group_id=(SELECT group_id FROM im_messages WHERE id='${messageID}') ORDER BY member_id`,
          ),
          [{ member_id: "server" }],
        )
        stage.value = "normal-native-progress-keeps-fixed-proof"
        native.add("ordinary-history-progress", { publish: false })
        yield* lease.reader.sync
        yield* resolver.prepareMessage({ messageID })
        const exact = yield* provide(
          IMTaskAuthority.accept(db, {
            requestID: request.request_id,
            operationID: "accept-source-original",
            expectedRevision: 1,
          }),
        )
        assert.deepEqual(exact, grant)
        assert.deepEqual(
          yield* db.get(sql`SELECT proof,snapshot_hash FROM im_task_source WHERE source_id=${request.source_id}`),
          storedSource,
        )
        stage.value = "mapping-revocation"
        yield* LocalTaskAuthority.provide(
          authorization,
          LocalOperator.rotate(db, {
            operationID: "remove-receiver-mapping",
            expectedRevision: 1,
            username: "private-source-operator",
            credentialVerifier,
            policy: { version: 1, targets: policy.targets },
          }),
        )
        yield* resolver.prepareMessage({ messageID })
        assert.equal(
          errorCode(
            yield* db
              .transaction((tx) => resolver.verifier.verify(tx, messageID))
              .pipe(Effect.provideService(LocalOperator.Runtime, configured.runtime), Effect.flip),
          ),
          "LOCAL_TASK_SOURCE_UNAVAILABLE",
        )
        assert.equal(
          errorCode(
            yield* db
              .transaction((tx) => IMTaskAuthority.authorizeWorkSource(tx, grant.binding))
              .pipe(
                Effect.provideService(LocalTaskAuth.KernelSource, resolver.verifier),
                Effect.provideService(LocalOperator.Runtime, configured.runtime),
                Effect.flip,
              ),
          ),
          "WORK_REVOKED",
        )
        stage.value = "local-chat-with-kernel-unavailable"
        lease.reader.revoke()
        yield* Ref.set(facade.engine, Option.none())
        const currentWitness = yield* LocalTaskAuthority.authenticatePassword(
          db,
          configured.runtime,
          "private-source-operator",
          configured.password,
        )
        const localAuth = { runtime: configured.runtime, witness: currentWitness }
        const group = yield* repo.createGroup({
          workspaceID: placement.canonicalRoot,
          type: "project",
          name: "ordinary local",
          createdBy: "server",
        })
        yield* LocalTaskAuthority.provide(
          localAuth,
          LocalTaskPolicy.enable(db, {
            operationID: "enable-local-mode",
            expectedRevision: 0,
            groupID: group.id,
            targetID: "review",
          }),
        )
        const localMessage = yield* LocalTaskAuthority.provide(
          localAuth,
          repo.createMessage({
            groupID: group.id,
            senderID: "server",
            senderType: "user",
            type: "text",
            content: "local source while kernel unavailable",
            clientRequestID: "ordinary-local-original",
          }),
        )
        const disabled = yield* KernelTaskSource.make
        const localQueries = native.queries.length
        yield* disabled.prepareMessage({ messageID: localMessage.id })
        const localRequest = yield* LocalTaskAuthority.provide(
          localAuth,
          IMTaskAuthority.propose(db, {
            messageID: localMessage.id,
            target,
            auditedText: localMessage.content,
            clientRequestID: "local-ordinary-proposal",
          }),
        ).pipe(Effect.provideService(LocalTaskAuth.KernelSource, disabled.verifier))
        assert.equal(localRequest.state, "proposed")
        assert.equal(native.queries.length, localQueries)
        const counts = (yield* db.get<{
          sources: number
          requests: number
          grants: number
          sessions: number
          inputs: number
          work: number
          providers: number
          counts: number
          dispatches: number
          intents: number
        }>(
          sql`SELECT (SELECT count(*) FROM im_task_source) sources,(SELECT count(*) FROM im_task_request) requests,(SELECT count(*) FROM im_task_grant) grants,(SELECT count(*) FROM session) sessions,(SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM work_execution) work,(SELECT count(*) FROM session_provider_attempt) providers,(SELECT count(*) FROM work_count_acquisition) counts,(SELECT count(*) FROM work_dispatch_reservation) dispatches,(SELECT count(*) FROM im_mention_intent) intents`,
        ))!
        assert.deepEqual(counts, {
          sources: 2,
          requests: 2,
          grants: 1,
          sessions: 0,
          inputs: 0,
          work: 0,
          providers: 0,
          counts: 0,
          dispatches: 0,
          intents: 0,
        })
        return {
          ...counts,
          noWitness: true,
          copy: true,
          expired: true,
          tupleMismatch: true,
          ownerConflict: true,
          mappingRevoked: true,
          ordinaryLocal: true,
          fixedProofAcrossReadProgress: true,
          remoteMembers: 0,
        }
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

if (process.env.DAC_KERNEL_TASK_SOURCE_AUTHORITY_ROOT) await run(process.env.DAC_KERNEL_TASK_SOURCE_AUTHORITY_ROOT)
