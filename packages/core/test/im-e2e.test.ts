import { describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { AgentV2 } from "../src/agent"
import { Database } from "../src/database/database"
import { AgentContextBuilderService } from "../src/im/agent-executor"
import { AgentListProviderService, AgentListProviderLive } from "../src/im/agent-list-provider"
import { IMBroadcasterService, IMBroadcasterLive } from "../src/im/broadcaster"
import { AgentContextBuilderLive } from "../src/im/context-builder"
import { MentionParser } from "../src/im/mention-parser"
import { IMRepository, IMRepositoryLive } from "../src/im/repository"
import type { ServerEvent } from "../src/im/websocket"

describe("IM System E2E Tests", () => {
  const databaseLayer = Database.layerFromPath(":memory:")
  const repositoryLayer = Layer.provideMerge(IMRepositoryLive, databaseLayer)
  const contextBuilderLayer = Layer.provideMerge(AgentContextBuilderLive, repositoryLayer)
  const agentLayer = Layer.provideMerge(AgentListProviderLive, AgentV2.layer)
  const testLayer = Layer.mergeAll(databaseLayer, repositoryLayer, contextBuilderLayer, IMBroadcasterLive, agentLayer)
  type TestServices = Layer.Success<typeof testLayer>

  const run = <A, E>(effect: Effect.Effect<A, E, TestServices | Scope.Scope>) =>
    Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(testLayer)))

  const seedWorkspace = Effect.gen(function* () {
    const now = Date.now()
    const db = (yield* Database.Service).db

    yield* db.run(sql`
      INSERT OR IGNORE INTO project (id, worktree, name, time_created, time_updated, sandboxes)
      VALUES ('proj_im_e2e', '/tmp/deepagent-im-e2e', 'IM E2E', ${now}, ${now}, '[]')
    `)
    yield* db.run(sql`
      INSERT OR IGNORE INTO workspace (id, type, name, directory, project_id, time_used)
      VALUES ('wrk_im_e2e', 'local', 'IM E2E', '/tmp/deepagent-im-e2e', 'proj_im_e2e', ${now})
    `)
  })

  it("persists mentioned messages and builds chronological context on migrated schema", async () => {
    const context = await run(
      Effect.gen(function* () {
        yield* seedWorkspace

        const repo = yield* IMRepository
        const contextBuilder = yield* AgentContextBuilderService
        const group = yield* repo.createGroup({
          workspaceID: "wrk_im_e2e",
          projectID: "proj_im_e2e",
          type: "project",
          name: "Runtime Debug",
          createdBy: "user_1",
        })

        yield* repo.createMessage({
          groupID: group.id,
          senderID: "user_1",
          senderType: "user",
          type: "text",
          content: "First observation",
          mentions: [],
        })
        yield* Effect.sleep("2 millis")
        const content = "Please inspect this @build"
        const message = yield* repo.createMessage({
          groupID: group.id,
          senderID: "user_1",
          senderType: "user",
          type: "text",
          content,
          mentions: MentionParser.parse(content),
        })

        expect(message.mentions).toEqual(["build"])

        return yield* contextBuilder.build({
          workspaceID: "wrk_im_e2e",
          groupID: group.id,
          messageID: message.id,
          task: content,
        })
      }),
    )

    expect(context.conversation.groupID).toMatch(/^img_/)
    expect(context.conversation.recentMessages.map((message) => message.content)).toEqual([
      "First observation",
      "Please inspect this @build",
    ])
  })

  it("broadcasts message and agent status events to registered group connections", async () => {
    const events = await run(
      Effect.gen(function* () {
        yield* seedWorkspace

        const repo = yield* IMRepository
        const broadcaster = yield* IMBroadcasterService
        const group = yield* repo.createGroup({
          workspaceID: "wrk_im_e2e",
          projectID: "proj_im_e2e",
          type: "project",
          name: "Broadcast",
          createdBy: "user_1",
        })

        const receivedEvents: ServerEvent[] = []
        const connection = {
          groupID: group.id,
          userID: "user_1",
          workspaceID: "wrk_im_e2e",
          send: (event: ServerEvent) => {
            receivedEvents.push(event)
          },
          close: () => {},
        }
        broadcaster.register(connection)

        const message = yield* repo.createMessage({
          groupID: group.id,
          senderID: "user_1",
          senderType: "user",
          type: "text",
          content: "Run review",
          mentions: ["build"],
        })

        broadcaster.broadcast(group.id, {
          type: "message_created",
          data: {
            id: message.id,
            groupID: message.groupID,
            senderID: message.senderID,
            senderType: message.senderType,
            messageType: message.type,
            content: message.content,
            mentions: message.mentions,
            metadata: message.metadata,
            replyToID: message.replyToID,
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
          },
        })
        broadcaster.broadcast(group.id, {
          type: "agent_status",
          data: {
            messageID: message.id,
            agentID: "build",
            status: "started",
          },
        })

        broadcaster.unregister(connection)
        return receivedEvents
      }),
    )

    expect(events.map((event) => event.type)).toEqual(["message_created", "agent_status"])
  })

  it("lists only visible IM-capable agents from AgentV2", async () => {
    const agents = await run(
      Effect.gen(function* () {
        const agentService = yield* AgentV2.Service
        yield* agentService.update((editor) => {
          editor.update(AgentV2.ID.make("primary-agent"), (agent) => {
            agent.mode = "primary"
            agent.hidden = false
            agent.description = "Primary"
          })
          editor.update(AgentV2.ID.make("all-agent"), (agent) => {
            agent.mode = "all"
            agent.hidden = false
            agent.description = "All"
          })
          editor.update(AgentV2.ID.make("hidden-agent"), (agent) => {
            agent.mode = "all"
            agent.hidden = true
          })
          editor.update(AgentV2.ID.make("subagent-only"), (agent) => {
            agent.mode = "subagent"
            agent.hidden = false
          })
        })

        const provider = yield* AgentListProviderService
        return yield* provider.listAgents({ workspaceID: "wrk_im_e2e", userID: "user_1" })
      }),
    )

    expect(agents.map((agent) => agent.name).sort()).toEqual(["all-agent", "primary-agent"])
  })
})
