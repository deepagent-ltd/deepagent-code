export * as KernelTaskResultFixture from "./kernel-task-result"

import assert from "node:assert/strict"
import { Effect, Exit, Layer, Option, Schema, Ref, SubscriptionRef } from "effect"
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
import { KernelLiveFirstSeenFixture } from "./kernel-live-first-seen"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { WorkAuthoritySchema } from "@deepagent-code/core/session/work-authority.schema"
import { WorkExecutionProfile } from "@deepagent-code/core/session/work-execution-profile"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionV2 } from "@deepagent-code/core/session"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { IMReplyOutbox } from "@/im/im-reply-outbox"
import { IMTaskResult } from "@/im/task-result"

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

export type Observer = {
  identity: { token: string; userID: string }
  response: NonNullable<Parameters<typeof KernelLiveFirstSeenFixture.make>[0]>["response"]
  observe: (input: {
    db: Database.Interface["db"]
    lease: IMKernelSync.ReaderLease
    context: IMTaskResult.ReadScope
    source: ReturnType<typeof KernelConfig.deliverySource>
    result: Extract<IMTaskResult.Result, { state: "available" }>
    wire: readonly { request: Record<string, unknown>; message: Record<string, unknown>; text: string }[]
    origin: string
  }) => Effect.Effect<void, unknown>
}

export async function run(root: string, observer?: Observer) {
  const wire: { request: Record<string, unknown>; message: Record<string, unknown>; text: string }[] = []
  const native = KernelLiveFirstSeenFixture.make({
    secondIdentity: observer?.identity,
    fetch(request) {
      if (new URL(request.url).pathname !== "/api/im/conversations/inspect") return
      if (request.method !== "POST" || request.headers.get("authorization") !== "Bearer private-witness-key")
        return Response.json({ success: false }, { status: 403 })
      if (observer) return request.clone().json().then((value: unknown) => {
        const body = Schema.decodeUnknownSync(Schema.Struct({ sender_uuid: Schema.String, conversation_type: Schema.Literal(1), conversation_id: Schema.String }))(value)
        if (body.sender_uuid === observer.identity.userID && body.conversation_id === "receiver")
          return Response.json({ success: true, data: { conversation_type: 1, conversation_id: "receiver", org_id: 1,
            name: "Receiver", member_uuids: ["receiver", observer.identity.userID] } })
        return Response.json({ success: true, data: { conversation_type: 1, conversation_id: "sender", org_id: 1,
          name: "Sender", member_uuids: ["receiver", "sender"] } })
      })
      return Response.json({ success: true, data: { conversation_type: 1, conversation_id: "sender",
        org_id: 1, name: "Sender", member_uuids: ["receiver", "sender"] } })
    },
    response(topic, request, original, userID) {
      if (userID !== "receiver") return observer?.response?.(topic, request, original, userID)
      if (topic === "qry_delivery_capabilities") return { name: "DeliveryCapabilities", value: {
        version: 1, profile: "mysql-receipt-v1", maxLifetimeMs: 259200000, maxContentBytes: 65536, eventualDelivery: false } }
      if (topic === "qry_delivery_read_cut") return { name: "DeliveryReadCutResult", value: {
        version: 1, scopeKey: request.scopeKey, projectionKey: request.projectionKey, projectionRevision: request.projectionRevision,
        throughOrdinal: "0", targetAdmittedOrdinal: String(native.messages.length), readOrdinal: "0",
        liveUnread: String(native.messages.length), storedUnread: String(native.messages.length),
        complete: native.messages.length === 0, serverNow: Date.now() } }
      return original
    },
    outboundPublish(request, message) {
      assert.equal(request.targetId, "sender")
      assert.equal(message.msgType, "jg:text")
      assert.equal(message.deliveryVersion, 1)
      assert.ok(message.msgContent instanceof Uint8Array)
      const content = JSON.parse(new TextDecoder().decode(message.msgContent))
      wire.push({ request, message, text: content.content })
      return { code: 0, msgId: "native-original-result", timestamp: Date.now(), msgIndex: 2,
        clientMsgId: message.clientUid, deliveryVersion: 1,
        deliveryExpiresAt: Number(String(message.deliveryExpiresAt)),
        deliveryRequestHash: Hash.sha256(JSON.stringify(["dac.delivery.request.v1", 1, request.targetId,
          message.clientUid, "jg:text", content.content, 10, Number(String(message.deliveryExpiresAt))])
          .replace(/[<>&\u2028\u2029]/g, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"))) }
    },
  })
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
  const storeLayer = SessionStore.layer.pipe(Layer.provide(database))
  const sessions = Layer.unwrap(Effect.gen(function* () {
    const store = yield* SessionStore.Service
    return Layer.mock(SessionV2.Service, {
      get: (id) => store.get(id).pipe(Effect.flatMap((found) => found ? Effect.succeed(found) : Effect.die(new Error("Missing original result Session")))),
      message: (input) => store.message(input.messageID).pipe(Effect.map((found) => found?.message)),
    })
  })).pipe(Layer.provide(storeLayer))
  const services = Layer.mergeAll(base, repository, engineLayer, identity, LocalTaskAuth.layer, storeLayer, sessions)
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
        const instance = yield* store.load({ directory: `${root}/project` })
        const placement = yield* (yield* LocationIdentity.Service).resolve({
          boundary: { kind: "implicit_local" },
          directory: AbsolutePath.make(`${root}/project`),
          project: { kind: "registered_root", observedProjectId: instance.project.id },
        })
        assert.equal(instance.directory, placement.canonicalRoot)
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
        const witness = yield* LocalTaskAuthority.authenticatePassword(
          db,
          configured.runtime,
          "private-source-operator",
          configured.password,
        )
        const authorization = { runtime: configured.runtime, witness }
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
        native.add("source-for-result")
        const row = yield* wait(
          db.get<{ local_message_id: string; metadata: string; immutable_hash: string }>(
            sql`SELECT local_message_id,metadata,immutable_hash FROM im_kernel_reader_message WHERE message_id='source-for-result'`,
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
          clientRequestID: "result-proposal-original",
        }
        const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          LocalTaskAuthority.provide(authorization, effect).pipe(
            Effect.provideService(LocalTaskAuth.KernelSource, resolver.verifier),
          )
        stage.value = "actual-source-and-controlled-terminal"
        yield* resolver.prepareMessage({ messageID })
        const request = yield* provide(IMTaskAuthority.propose(db, proposal))
        yield* resolver.prepareMessage({ messageID })
        const grant = yield* provide(IMTaskAuthority.accept(db, {
          requestID: request.request_id, operationID: "accept-result-original", expectedRevision: 1,
        }))
        const forbidden = () => Effect.die(new Error("Unexpected provider/route execution in result-only fixture"))
        const workError = (error: { message: string }) => new WorkAuthoritySchema.Error({ code: "WORK_REVOKED", message: error.message })
        const installed: WorkExecutionProfile.Installed = {
          profile: { preflight: forbidden, observe: forbidden, bind: forbidden, current: forbidden, acquireCount: forbidden,
            prepareSource: (work) => resolver.prepareWork(work).pipe(Effect.mapError(workError)) },
          verifier: {
            authorizeSource: (tx, binding) => provide(IMTaskAuthority.authorizeWorkSource(tx, binding)).pipe(Effect.mapError(workError)),
            resolveRoute: (_tx, binding) => Effect.succeed({ evidenceID: binding.provider.evidenceID,
              evidenceHash: binding.provider.evidenceHash, configurationHash: binding.provider.configurationHash }),
          },
          evidence: { resolve: forbidden, readCount: forbidden },
          approval: { captured: forbidden, authenticate: forbidden, verify: forbidden },
          count: { requireCapture: forbidden, authenticate: forbidden, verify: forbidden },
        }
        yield* resolver.prepareMessage({ messageID })
        yield* WorkAuthority.reserve(db, { binding: grant.binding }).pipe(Effect.provideService(WorkAuthority.Verifier, installed.verifier))
        const created = Date.now()
        // Existing controlled terminal store oracle: no runner, model, count, or provider is invoked.
        yield* db.run(sql`INSERT OR IGNORE INTO project(id,worktree,sandboxes,time_created,time_updated)
          VALUES (${instance.project.id},${placement.canonicalRoot},'[]',${created},${created})`)
        yield* db.run(sql`INSERT INTO session(id,project_id,slug,directory,title,version,v2_authority,agent,model,time_created,time_updated)
          VALUES (${grant.session_id},${instance.project.id},'kernel-result',${placement.canonicalRoot},'Original result','2',1,${target.agentID},
          ${JSON.stringify({ id: target.provider.modelID, providerID: target.provider.providerID })},${created},${created})`)
        yield* resolver.prepareMessage({ messageID })
        yield* db.transaction((tx) => Effect.gen(function* () {
          yield* tx.run(sql`INSERT INTO session_input(id,session_id,prompt,delivery,admitted_seq,promoted_seq,time_created)
            VALUES (${grant.input_id},${grant.session_id},${JSON.stringify({ text: request.audited_text })},'queue',1,1,${created})`)
          yield* WorkAuthority.bindInputInTransaction(tx, { workID: grant.work_id, inputID: grant.input_id,
            sessionID: grant.session_id, promptHash: grant.binding.auditedText.hash, admittedSeq: 1, expectedRevision: 1 })
        }), { behavior: "immediate" }).pipe(Effect.provideService(WorkAuthority.Verifier, installed.verifier))
        const reply = "Original delegated result 中文"
        const finalID = "msg_kernel_original_final"
        yield* db.run(sql`UPDATE work_execution SET outcome='succeeded' WHERE work_id=${grant.work_id}`)
        yield* db.run(sql`INSERT INTO session_activity(activity_id,session_id,ordinal,trigger_input_id,delivery,state,created_at,settled_at,final_message_id)
          VALUES ('activity-kernel-result',${grant.session_id},1,${grant.input_id},'queue','settled',${created},${created+1},${finalID})`)
        yield* db.run(sql`INSERT INTO session_message(id,session_id,type,seq,time_created,time_updated,data)
          VALUES (${finalID},${grant.session_id},'assistant',2,${created},${created},${JSON.stringify({ agent: target.agentID,
            model: { id: target.provider.modelID, providerID: target.provider.providerID },
            content: [{ type: "text", id: "part-result", text: reply }], time: { created, completed: created+1 }, finish: "stop" })})`)
        const v2Session = yield* SessionV2.Service
        // The source's original 1000ms witness expires; collection must capture it outside SQL.
        yield* Effect.sleep("1010 millis")
        assert.equal(yield* IMReplyOutbox.collectSessionReply({ db, v2Session, work: installed }, grant.session_id), true)
        const outbox = yield* IMReplyOutbox.claimDueReply(db, { ownerToken: "result-owner" })
        assert.ok(outbox)
        stage.value = "actual-sdk-pub-and-ack"
        const delivered = yield* IMReplyOutbox.deliverReply({ db, repo, broadcaster: yield* IMBroadcasterService, work: installed, v2Session, kernelSync: engine }, outbox)
        yield* IMReplyOutbox.markDelivered(db, { item: outbox, ownerToken: "result-owner" })
        const delivery = yield* wait(KernelDelivery.read(db, delivered.id).pipe(Effect.map((receipt) => receipt?.state === "acknowledged" ? receipt : undefined))).pipe(
          Effect.onExit((exit) => Exit.isFailure(exit) ? Effect.gen(function* () {
            const receipt = yield* KernelDelivery.read(db, delivered.id)
            process.stderr.write(`KERNEL_RESULT_TRANSPORT ${JSON.stringify({ state: receipt?.state, reason: receipt?.reason,
              wire: wire.length, topics: native.topics, outbox: yield* db.all("SELECT status,last_error FROM im_reply_outbox") })}\n`)
          }) : Effect.void),
        )
        assert.equal(wire.length, 1)
        assert.equal(wire[0].text, `[Agent·${target.agentID}] ${reply}`)
        assert.equal(delivery.kernel_message_id, "native-original-result")
        const context = { messageID: delivered.id, instanceID: configured.runtime.instanceID,
          workspaceID: placement.canonicalRoot, userID: "server", directory: placement.canonicalRoot }
        const read = (id = delivered.id) => lease.reader.withOutput({ workspaceID: context.workspaceID,
          userID: context.userID, groupIDs: [delivered.groupID] }, IMTaskResult.read(db, { ...context, messageID: id }))
        const protectedFacts = () => db.all(`SELECT
          (SELECT count(*) FROM session) sessions,(SELECT count(*) FROM session_input) inputs,
          (SELECT count(*) FROM work_execution) work,(SELECT count(*) FROM session_provider_attempt) providers,
          (SELECT count(*) FROM work_count_acquisition) counts,(SELECT count(*) FROM work_dispatch_reservation) dispatches,
          (SELECT count(*) FROM im_task_source) sources,(SELECT count(*) FROM im_task_request) requests,(SELECT count(*) FROM im_task_grant) grants`)
        const before = yield* protectedFacts()
        stage.value = "historical-current-reader-locator"
        assert.deepEqual(yield* IMTaskResult.read(db, context), { version: 1, messageID: delivered.id,
          groupID: delivered.groupID, state: "unavailable", code: "remote_result_unlinked" })
        assert.deepEqual(yield* read(messageID), { version: 1, messageID,
          groupID: delivered.groupID, state: "unavailable", code: "remote_result_unlinked" })
        const available = yield* read()
        assert.equal(available?.state, "available", JSON.stringify(available))
        if (available?.state !== "available") throw new Error(`Unexpected historical result ${JSON.stringify(available)}`)
        assert.equal(available.placement.sessionID, grant.session_id)
        assert.equal(available.attempt.workID, grant.work_id)
        assert.deepEqual(yield* protectedFacts(), before)
        const stable = yield* db.all(`SELECT proof,snapshot,proof_hash,snapshot_hash FROM im_task_source`)
        yield* provide(IMTaskAuthority.revoke(db, { grantID: grant.grant_id, operationID: "revoke-completed-result", expectedRevision: 1 }))
        assert.equal((yield* read())?.state, "available")
        assert.deepEqual(yield* db.all(`SELECT proof,snapshot,proof_hash,snapshot_hash FROM im_task_source`), stable)
        const owned = yield* repo.getRawMessageForKernelDelivery!(delivered.id)
        assert.ok(owned)
        const rowHashes = () => Effect.gen(function* () {
          const tables = yield* db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          return yield* Effect.forEach(tables, (table) => db.all<Record<string, unknown>>(`SELECT * FROM "${table.name.replaceAll('"','""')}"`).pipe(
            Effect.map((rows) => [table.name, rows.map((row) => Hash.sha256(CanonicalJson.stringify(row))).sort()])))
        })
        yield* lease.engine.catchUp
        const queryBefore = native.topics.filter((topic) => topic === "qry_delivery_messages").length
        yield* lease.reader.withOutput({ workspaceID: context.workspaceID, userID: context.userID,
          groupIDs: [delivered.groupID] }, Effect.gen(function* () {
          const finalBefore = yield* rowHashes()
          assert.equal((yield* IMTaskResult.read(db, context))?.state, "available")
          assert.deepEqual(yield* rowHashes(), finalBefore)
        }))
        assert.equal(native.topics.filter((topic) => topic === "qry_delivery_messages").length, queryBefore)
        assert.equal(wire.length, 1)
        assert.deepEqual(yield* protectedFacts(), before)
        if (observer) yield* observer.observe({ db, lease, context, source, result: available, wire, origin: native.server.url.origin })
        return { sessions: 1, inputs: 1, work: 1, providers: 0, counts: 0, dispatches: 0,
          sources: 1, requests: 1, grants: 1, wire: wire.length, acknowledged: true,
          revokedHistoryAvailable: true, getZeroWrites: true, noReaderUnlinked: true, sourceMessageUnlinked: true, closed: true }
      }).pipe(Effect.provide(services), Effect.scoped),
    )
    await Bun.write(`${root}/result.json`, JSON.stringify(result))
    return result
  } catch (error) {
    process.stderr.write(`KERNEL_TASK_RESULT_STAGE ${stage.value}\n`)
    throw error
  } finally {
    native.server.stop(true)
  }
}

if (process.env.DAC_KERNEL_TASK_RESULT_ROOT) await run(process.env.DAC_KERNEL_TASK_RESULT_ROOT)
