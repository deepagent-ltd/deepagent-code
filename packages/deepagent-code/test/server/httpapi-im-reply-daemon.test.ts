import { expect } from "bun:test"
import { NodeServices } from "@effect/platform-node"
import { DateTime, Effect, Layer, Option, Ref, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { eq, sql } from "drizzle-orm"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { Flag } from "@deepagent-code/core/flag/flag"
import { AgentListProviderLive } from "@deepagent-code/core/im/agent-list-provider"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { IMDacSession } from "@deepagent-code/core/im/dac-session"
import { IMDacBindingTable } from "@deepagent-code/core/im/dac-session.sql"
import { IMKernelDeliveryTable } from "@deepagent-code/core/im/kernel-delivery.sql"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { MessageID } from "@deepagent-code/core/im/id"
import { IMReplyOutboxTable } from "@deepagent-code/core/im/reply-outbox.sql"
import { ReplyBodyRetirement } from "@deepagent-code/core/im/reply-body-retirement"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { MessageTable } from "@deepagent-code/core/im/sql"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionActivityInputTable, SessionActivityTable } from "@deepagent-code/core/context-federation/session-sql"
import { init } from "@deepagent-code/core/util/log"
import { Auth } from "@/auth"
import { InstanceRef } from "@/effect/instance-ref"
import { IMFacade } from "@/im/facade"
import { IMReplyOutbox } from "@/im/im-reply-outbox"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { IMReaderSDKFixture } from "./im-reader-sdk.fixture"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

void init({ print: false })
const it = testEffect(NodeServices.layer)

it.live("the global reply daemon retains an existing real Instance for original final custody, SDK send and ACK", () => Effect.gen(function* () {
  const root = yield* tmpdirScoped({ git: false })
  const directory = yield* tmpdirScoped({ git: false, config: { formatter: false, lsp: false } })
  const original = Flag.DEEPAGENT_CODE_DB
  Flag.DEEPAGENT_CODE_DB = join(root, "reply-daemon.sqlite")
  yield* Effect.addFinalizer(() => Effect.sync(() => { Flag.DEEPAGENT_CODE_DB = original }))
  const sdk = IMReaderSDKFixture.make()
  const metadata = { delayMs: 0, inspections: 0 }
  const platform = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = []
    incoming.on("data", (chunk) => chunks.push(chunk))
    incoming.on("end", () => {
      const url = new URL(incoming.url ?? "/", "http://localhost")
      const input = url.pathname.endsWith("/inspect") && chunks.length ? Schema.decodeUnknownSync(Schema.Struct({ conversation_type: Schema.Literals([1, 2]), conversation_id: Schema.String }).pipe(Schema.fromJsonString))(Buffer.concat(chunks).toString("utf8")) : undefined
      if (input) metadata.inspections++
      const payload = url.pathname.endsWith("/login") ? { kernel_token: "controlled-token", navigator_url: "http://127.0.0.1:9", appkey: "appkey_1", identity: { uuid: "uuid-alice", name: "alice", org_id: 7, org_all_group_id: "org7" }, ttl: { msg_life_time_ms: 259200000 } }
        : url.pathname.endsWith("/resolve") ? { uuid: `uuid-${url.searchParams.get("name")}`, name: url.searchParams.get("name") }
        : url.pathname.endsWith("/inspect") && input ? { conversation_type: input.conversation_type, conversation_id: input.conversation_id, org_id: 7, member_uuids: sdk.conversation(input.conversation_type, input.conversation_id).allowed ? ["uuid-alice", input.conversation_id] : [input.conversation_id], name: input.conversation_id }
        : {}
      outgoing.writeHead(200, { "content-type": "application/json" })
      const body = JSON.stringify({ success: true, message: "", data: payload })
      if (input && metadata.delayMs) { setTimeout(() => outgoing.end(body), metadata.delayMs); return }
      outgoing.end(body)
    })
  })
  yield* Effect.promise(() => new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve)))
  yield* Effect.addFinalizer(() => Effect.promise(() => new Promise<void>((resolve) => platform.close(() => resolve()))))
  const address = platform.address()
  if (!address || typeof address === "string") return yield* Effect.die("controlled platform did not listen")
  const database = Database.defaultLayer
  const events = EventV2.layer.pipe(Layer.provide(database))
  const projects = ProjectV2.defaultLayer
  const sessions = SessionV2.layer.pipe(
    Layer.provide(SessionExecution.noopLayer),
    Layer.provide(SessionStore.layer.pipe(Layer.provide(database))),
    Layer.provide(SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))),
    Layer.provide(events), Layer.provide(database), Layer.provide(projects), Layer.orDie,
  )
  const instances = InstanceStore.defaultLayer.pipe(Layer.provide(Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })))
  const dependencies = Layer.mergeAll(database, events, projects, sessions, instances, IMBroadcasterLive,
    IMRepositoryLive.pipe(Layer.provide(database)),
    AgentListProviderLive.pipe(Layer.provide(AgentV2.layer)),
    Layer.succeed(Auth.Service, { get: () => Effect.succeed(undefined), all: () => Effect.succeed({}),
      set: () => Effect.die("controlled credentials must not be persisted"), remove: () => Effect.die("controlled credentials must not be removed") }),
    FetchHttpClient.layer,
  )
  const context = yield* Layer.build(IMFacade.layer({ buildEngine: sdk.buildEngine, env: {
    DEEPAGENT_IM_FACADE_URL: `http://127.0.0.1:${address.port}`, DEEPAGENT_IM_FACADE_KEY: "sk-controlled",
  } }).pipe(Layer.provideMerge(dependencies)))
  yield* Effect.gen(function* () {
    const facade = yield* IMFacade.Service
    const instanceStore = yield* InstanceStore.Service
    const instance = yield* instanceStore.load({ directory })
    const direct = yield* facade.openDirect({ workspaceID: directory, name: "replypeer" }).pipe(Effect.provideService(InstanceRef, instance))
    const db = (yield* Database.Service).db
    const repo = yield* IMRepository
    const v2Session = yield* SessionV2.Service
    const lease = sdk.observed.lease.get(directory)!
    const account = KernelReaderSchema.decode(KernelReaderSchema.Binding, (yield* KernelReader.scope(lease.reader.runtime))!.binding, 8192)
    const project = yield* (yield* ProjectV2.Service).resolve(AbsolutePath.make(directory))
    const scope = { ownerID: "server", accountKey: createHash("sha256").update(JSON.stringify([account.realm, account.appkey, account.orgID, account.userID])).digest("hex"),
      executorID: account.instanceID, conversationKey: JSON.stringify([1, "uuid-replypeer"]), groupID: direct.id,
      projectID: project.id, directory, workspaceID: null }
    const command = yield* IMDacSession.make(db, v2Session).submit(scope, { commandID: "daemon-original-final", text: "private synthetic ordinary command", delivery: "queue" }, Effect.succeed([]))
    const binding = yield* db.select().from(IMDacBindingTable).where(eq(IMDacBindingTable.current_session_id, command.sessionID)).get()
    if (!binding) return yield* Effect.die("ordinary admission did not persist its binding")
    const kernelSync = Option.getOrUndefined(yield* Ref.get(facade.engine))
    const deps = { db, repo, facade, kernelSync, instanceStore }
    expect(yield* InstanceRef).toBeUndefined()
    expect(yield* IMReplyOutbox.authorizeReply(deps, binding, Effect.succeed("authorized")).pipe(Effect.flip))
      .toMatchObject({ code: "reader_scope_mismatch", operation: "workspace-lease" })
    expect(sdk.observed.sends).toBe(0)
    expect(yield* instanceStore.peek(root)).toBeUndefined()
    expect(yield* IMReplyOutbox.authorizeRegisteredReply(deps, { ...binding, directory: root }, Effect.succeed("must not authorize")).pipe(Effect.flip))
      .toMatchObject({ code: "reader_scope_mismatch", operation: "workspace-lease" })
    expect(yield* instanceStore.peek(root)).toBeUndefined()
    expect(yield* IMReplyOutbox.authorizeRegisteredReply(deps, { ...binding, project_id: "foreign-project" }, Effect.succeed("must not authorize")).pipe(Effect.flip))
      .toMatchObject({ code: "reader_scope_mismatch", operation: "workspace-lease" })
    expect(sdk.observed.sends).toBe(0)
    expect(yield* IMReplyOutbox.authorizeRegisteredReply(deps, binding, (engine) => Effect.sync(() => engine === sdk.observed.lease.get(directory)?.engine))).toBe(true)
    expect(yield* InstanceRef).toBeUndefined()
    const finalID = SessionMessage.ID.make(`msg_${crypto.randomUUID()}`)
    const publisher = yield* EventV2.Service
    const timestamp = DateTime.makeUnsafe(Date.now())
    yield* publisher.publish(SessionEvent.Step.Started, { sessionID: SessionV2.ID.make(command.sessionID), timestamp, assistantMessageID: finalID,
      agent: "build", model: { id: ModelV2.ID.make("deepseek-flash"), providerID: ProviderV2.ID.make("deepseek") } })
    yield* publisher.publish(SessionEvent.Text.Started, { sessionID: SessionV2.ID.make(command.sessionID), timestamp, assistantMessageID: finalID, textID: "answer" })
    yield* publisher.publish(SessionEvent.Text.Ended, { sessionID: SessionV2.ID.make(command.sessionID), timestamp, assistantMessageID: finalID, textID: "answer", text: "原始最终回复🙂" })
    const activityID = `activity_${crypto.randomUUID()}`
    yield* db.insert(SessionActivityTable).values({ activity_id: activityID, session_id: command.sessionID, ordinal: 1,
      trigger_input_id: command.inputID, delivery: "queue", state: "settled", created_at: Date.now(), settled_at: Date.now(), final_message_id: finalID }).run()
    yield* db.insert(SessionActivityInputTable).values({ activity_id: activityID, input_id: command.inputID, ordinal: 1,
      admitted_seq: 1, role: "trigger", promoted_at: Date.now() }).run()
    // The same production layer runs outside InstanceRef and performs the complete
    // original collect / custody / fixed-entry create / SDK dispatch / ACK path.
    // Both authenticated create/send inspections now take longer than the short
    // protected metadata output frame, without extending reader authority.
    metadata.delayMs = 1100
    const inspected = metadata.inspections
    const started = performance.now()
    yield* Layer.build(IMReplyOutbox.layer.pipe(Layer.provide(Layer.succeedContext(context))))
    const row = yield* pollWithTimeout(db.select().from(IMReplyOutboxTable).where(eq(IMReplyOutboxTable.session_id, command.sessionID)).get().pipe(
      Effect.map((item) => item?.status === "delivered" ? item : undefined)), "original final daemon did not complete transport ACK", "15 seconds")
    if (!row.delivery_message_id) return yield* Effect.die("delivered original reply is missing its transport identity")
    expect(row.reply_message_id).toBe(finalID)
    expect(performance.now() - started).toBeGreaterThan(2200)
    expect(metadata.inspections - inspected).toBeGreaterThanOrEqual(2)
    expect(row.reply_text).toBe("原始最终回复🙂")
    expect(row.attempts).toBe(1)
    expect(sdk.observed.sends).toBe(1)
    expect(sdk.observed.sent).toHaveLength(1)
    expect(sdk.observed.sent[0]?.text).toBe("[Agent·build] 原始最终回复🙂")
    const message = yield* db.select().from(MessageTable).where(eq(MessageTable.id, MessageID.make(row.delivery_message_id))).get()
    expect(message).toMatchObject({ sender_id: "build", sender_type: "agent", content: "原始最终回复🙂" })
    const receipt = yield* db.select().from(IMKernelDeliveryTable).where(eq(IMKernelDeliveryTable.message_id, row.delivery_message_id)).get()
    expect(receipt).toMatchObject({ state: "acknowledged", kernel_message_id: sdk.observed.sent[0]?.messageID })
    const custody = yield* ReplyBodyRetirement.read(db, row.id)
    expect(custody.record).toMatchObject({ bodyState: "live", custody: "kernel", origin: { kind: "dac_session", replyMessageID: finalID } })
    expect(custody.record.message?.messageID).toBe(row.delivery_message_id)
    expect(custody.record.transport?.binding.messageID).toBe(row.delivery_message_id)
    expect((yield* db.get<{ count: number }>(sql`SELECT count(*) count FROM session_input`))?.count).toBe(1)
    expect((yield* db.get<{ count: number }>(sql`SELECT count(*) count FROM session_provider_attempt`))?.count).toBe(0)
    yield* instanceStore.dispose(instance)
    expect(yield* instanceStore.peek(directory)).toBeUndefined()
    expect(yield* IMReplyOutbox.authorizeRegisteredReply(deps, binding, (engine) => engine!.createMessage({
      id: "imsg_retired_instance_final", groupID: direct.id, senderID: "build", senderType: "agent", type: "text", content: "must not send", mentions: [],
    })).pipe(Effect.flip)).toMatchObject({ code: "reader_scope_mismatch", operation: "workspace-lease" })
    expect(yield* db.select().from(MessageTable).where(eq(MessageTable.id, MessageID.make("imsg_retired_instance_final"))).get()).toBeUndefined()
    expect(sdk.observed.sends).toBe(1)
    expect((yield* db.get<{ count: number }>(sql`SELECT count(*) count FROM session_input`))?.count).toBe(1)
  }).pipe(Effect.provide(context))
}), 30000)
