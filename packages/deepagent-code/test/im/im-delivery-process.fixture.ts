import { Effect, Layer, DateTime } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { ProjectV2 } from "@deepagent-code/core/project"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionInput } from "@deepagent-code/core/session/input"
import { SessionInputTable } from "@deepagent-code/core/session/sql"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionContext } from "@deepagent-code/core/context-federation/session-context"
import { ContextArtifactStore } from "@deepagent-code/core/context-federation/artifact-store"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMMentionIntentTable } from "@deepagent-code/core/im/mention-intent.sql"
import { MessageTable, MemberTable } from "@deepagent-code/core/im/sql"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { IMAgentExecution } from "@/im/im-agent-execution"
import { IMReplyOutbox } from "@/im/im-reply-outbox"

const directory = process.env.IM_ORACLE_ROOT!
const stage = process.argv[2]
const database = Database.layerFromPath(`${directory}/oracle.db`)
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const projects = ProjectV2.layer.pipe(
  Layer.provide(database),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
)
const session = SessionV2.layer.pipe(
  Layer.provide(SessionExecution.noopLayer),
  Layer.provide(store),
  Layer.provide(projector),
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(projects),
  Layer.orDie,
)
const repository = IMRepositoryLive.pipe(Layer.provide(database))
const contexts = SessionContext.layer.pipe(
  Layer.provide(database),
  Layer.provide(Layer.mock(ContextArtifactStore.Service, { policy: "best_effort" })),
)
const runtime = Layer.mergeAll(database, events, session, repository, contexts)
const broadcaster = {
  broadcast: () => {},
  sendToUser: () => {},
  register: () => true,
  unregister: () => {},
  getConnectionCount: () => 0,
  getUserConnectionCount: () => 0,
}
const agents = {
  listAgents: () =>
    Effect.succeed([
      { id: "auto", name: "auto", displayName: "Auto", visible: true, triggers: [{ event: "mention" }] },
    ]),
  findByTrigger: () => Effect.succeed([]),
  findByCapability: () => Effect.succeed([]),
}
const demand = (condition: boolean, description: string) => {
  if (!condition) throw new Error(description)
}
await Effect.runPromise(
  Effect.gen(function* () {
    const repo = yield* IMRepository
    const db = (yield* Database.Service).db
    const v2Session = yield* SessionV2.Service
    if (stage === "seed") {
      const group = yield* repo.createGroup({ workspaceID: "ws", name: "Oracle", type: "project", createdBy: "server" })
      yield* repo.createMessage({
        groupID: group.id,
        senderID: "server",
        senderType: "user",
        type: "text",
        content: "@auto live",
        clientRequestID: "live-request",
        mentionIntent: { names: ["auto"], directory, workspaceID: "ws", userID: "server", origin: "local" },
      })
      yield* repo.createMessage({
        groupID: group.id,
        senderID: "remote",
        senderType: "user",
        type: "text",
        content: "@auto history",
        kernelMsgID: "history-only",
      })
      process.exit(71)
    }
    if (stage === "admit-crash") {
      const intent = (yield* repo.listPendingMentions({ origin: "local" }))[0]!
      yield* repo.bindMention({
        id: intent.id,
        agent: "auto",
        sessionID: IMAgentExecution.imSessionIDFor(intent.message.groupID, "auto"),
        inputID: IMAgentExecution.imPromptIDFor(intent.message_id, "auto"),
      })
      yield* IMAgentExecution.admitMention(v2Session, {
        groupID: intent.message.groupID,
        messageID: intent.message_id,
        agent: "auto",
        senderID: intent.message.senderID,
        content: intent.message.content,
        directory,
      })
      process.exit(72)
    }
    if (stage === "revoke")
      yield* db.delete(MemberTable).where(eq(MemberTable.member_id, "server")).run().pipe(Effect.orDie)
    if (stage === "recover" || stage === "revoke") {
      yield* IMAgentExecution.reconcileMentions({ repo, v2Session, agents, broadcaster, origin: "local" })
      yield* IMAgentExecution.reconcileMentions({ repo, v2Session, agents, broadcaster, origin: "local" })
    }
    if (stage === "finalize") {
      const intent = (yield* db.select().from(IMMentionIntentTable).all().pipe(Effect.orDie))[0]!
      const sessionID = SessionV2.ID.make(intent.session_id!)
      const inputID = SessionMessage.ID.make(intent.input_id!)
      const publisher = yield* EventV2.Service
      yield* SessionInput.promoteSteers(db, publisher, sessionID, Number.MAX_SAFE_INTEGER)
      const context = yield* SessionContext.Service
      const activity = yield* context.openActivity({ sessionId: sessionID, triggerInputId: inputID })
      const project = (id: string, text: string) =>
        Effect.gen(function* () {
          const assistantMessageID = SessionMessage.ID.make(id)
          yield* publisher.publish(SessionEvent.Step.Started, {
            sessionID,
            assistantMessageID,
            timestamp: DateTime.makeUnsafe(1),
            agent: "auto",
            model: { id: ModelV2.ID.make("fixed"), providerID: ProviderV2.ID.make("test") },
          })
          yield* publisher.publish(SessionEvent.Text.Started, {
            sessionID,
            assistantMessageID,
            timestamp: DateTime.makeUnsafe(2),
            textID: id,
          })
          yield* publisher.publish(SessionEvent.Text.Ended, {
            sessionID,
            assistantMessageID,
            timestamp: DateTime.makeUnsafe(3),
            textID: id,
            text,
          })
        })
      yield* project("msg_intermediate", "draft before tools")
      demand(
        !(yield* IMReplyOutbox.collectSessionReply({ db, v2Session }, sessionID)),
        "intermediate text was collected",
      )
      yield* project("msg_final_oracle", "complete final answer")
      demand(
        !(yield* IMReplyOutbox.collectSessionReply({ db, v2Session }, sessionID)),
        "unsettled final text was collected",
      )
      yield* publisher.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID: SessionMessage.ID.make("msg_final_oracle"),
        timestamp: DateTime.makeUnsafe(4),
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      yield* context.settleActivity({
        activityId: activity.activityId,
        state: "settled",
        finalMessageId: "msg_final_oracle",
      })
      for (let i = 0; i < 60; i++) yield* project(`msg_unrelated_${i}`, "newer unrelated draft")
      demand(
        yield* IMReplyOutbox.collectSessionReply({ db, v2Session }, sessionID),
        "explicit final pointer was not collected",
      )
      demand(!(yield* IMReplyOutbox.collectSessionReply({ db, v2Session }, sessionID)), "duplicate outcome")
    }
    if (stage === "deliver-crash") {
      const item = yield* IMReplyOutbox.claimDueReply(db, { ownerToken: "crashed", now: Date.now(), leaseMs: 1 })
      demand(!!item, "reply missing")
      yield* IMReplyOutbox.deliverReply({ db, repo, broadcaster }, item!)
      process.exit(73)
    }
    if (stage === "deliver-recover")
      yield* IMReplyOutbox.drainPass({ db, repo, broadcaster }, { now: Date.now() + 1_000 })
    const inputs = yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)
    const intents = yield* db.select().from(IMMentionIntentTable).all().pipe(Effect.orDie)
    const messages = yield* db.select().from(MessageTable).all().pipe(Effect.orDie)
    const replies = yield* db.select().from(IMReplyOutbox.IMReplyOutboxTable).all().pipe(Effect.orDie)
    console.log(
      JSON.stringify({
        inputs: inputs.length,
        intents: intents.map((row) => row.status),
        messageCount: messages.length,
        replies: replies.map((row) => ({ text: row.reply_text, status: row.status })),
        agentMessages: messages.filter((row) => row.sender_type === "agent").map((row) => row.content),
      }),
    )
  }).pipe(Effect.scoped, Effect.provide(runtime)),
)
