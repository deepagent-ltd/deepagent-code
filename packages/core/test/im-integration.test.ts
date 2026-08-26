import { describe, it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { IMRepository, IMRepositoryLive } from "../src/im/repository"
import { IMBroadcasterService, IMBroadcasterLive } from "../src/im/broadcaster"
import { AgentContextBuilderService } from "../src/im/agent-executor"
import { AgentListProviderService, AgentListProviderLive } from "../src/im/agent-list-provider"
import { AgentContextBuilderLive } from "../src/im/context-builder"
import { AgentV2 } from "../src/agent"
import { MentionParser } from "../src/im/mention-parser"
import { Database } from "@deepagent-code/core/database/database"
import type { ServerEvent } from "../src/im/websocket"

describe("IM Integration Tests", () => {
  const databaseLayer = Database.layerFromPath(":memory:")
  const repositoryLayer = Layer.provideMerge(IMRepositoryLive, databaseLayer)
  const agentLayer = Layer.provideMerge(AgentListProviderLive, AgentV2.layer)
  const contextBuilderLayer = Layer.provideMerge(AgentContextBuilderLive, repositoryLayer)
  const testLayer = Layer.mergeAll(
    databaseLayer,
    repositoryLayer,
    IMBroadcasterLive,
    agentLayer,
    contextBuilderLayer,
  )

  // Run database migrations before tests
  const setupDatabase = Effect.gen(function* () {
    const dbService = yield* Database.Service
    const db = dbService.db
    // Drop and recreate IM tables for clean state
    yield* db.run(`DROP TABLE IF EXISTS im_messages`)
    yield* db.run(`DROP TABLE IF EXISTS im_members`)
    yield* db.run(`DROP TABLE IF EXISTS im_groups`)

    yield* db.run(`
      CREATE TABLE im_groups (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        project_id TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      )
    `)
    yield* db.run(`
      CREATE TABLE im_members (
        group_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        member_type TEXT NOT NULL,
        role TEXT NOT NULL,
        last_read_at INTEGER,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, member_id, member_type),
        FOREIGN KEY (group_id) REFERENCES im_groups(id)
      )
    `)
    yield* db.run(`
      CREATE TABLE im_messages (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_type TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        mentions TEXT,
        metadata TEXT,
        reply_to_id TEXT,
        event_id TEXT,
        delivery_status TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        FOREIGN KEY (group_id) REFERENCES im_groups(id)
      )
    `)
    yield* db.run(`CREATE INDEX idx_im_messages_group_id ON im_messages(group_id)`)
    yield* db.run(`CREATE INDEX idx_im_messages_created_at ON im_messages(created_at)`)
  })

  it("should parse @mentions from message content", () => {
    const content = "Hello @CodeAgent, can you help me with @ReviewAgent?"
    const mentions = MentionParser.parse(content)

    expect(mentions).toEqual(["CodeAgent", "ReviewAgent"])
  })

  it("should not parse mentions inside code blocks", () => {
    const content = "Check this code:\n```\n@CodeAgent should not be parsed\n```\nBut @ReviewAgent should"
    const mentions = MentionParser.parse(content)

    expect(mentions).toEqual(["ReviewAgent"])
  })

  it("should create group and send message with mention", async () => {
    const program = Effect.gen(function* () {
      // Setup database tables
      yield* setupDatabase

      const repo = yield* IMRepository
      const workspaceID = "test-workspace"
      const userID = "test-user"

      // Create a project group
      const group = yield* repo.createGroup({
        workspaceID,
        name: "Test Project Group",
        type: "project",
        projectID: "test-project",
        createdBy: userID,
      })

      expect(group.name).toBe("Test Project Group")
      expect(group.type).toBe("project")

      // Note: creator is already added as owner by createGroup, no need to add again

      // Send message with agent mention
      const message = yield* repo.createMessage({
        groupID: group.id,
        senderID: userID,
        senderType: "user",
        type: "text",
        content: "Hello @CodeAgent, please help me write a function",
        mentions: ["CodeAgent"],
      })

      expect(message.content).toContain("@CodeAgent")
      expect(message.mentions).toEqual(["CodeAgent"])

      // List messages
      const messagesPage = yield* repo.listMessages({
        groupID: group.id,
        limit: 10,
      })

      expect(messagesPage.messages.length).toBe(1)
      expect(messagesPage.messages[0].id).toBe(message.id)

      return { group, message }
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)))
    expect(result.group).toBeDefined()
    expect(result.message).toBeDefined()
  })

  it("should build context with chronological conversation history", async () => {
    const program = Effect.gen(function* () {
      yield* setupDatabase
      const repo = yield* IMRepository
      const contextBuilder = yield* AgentContextBuilderService

      const workspaceID = "test-workspace"
      const userID = "test-user"

      // Create group and messages
      const group = yield* repo.createGroup({
        workspaceID,
        name: "Test Group",
        type: "project",
        projectID: "test-project",
        createdBy: userID,
      })

      yield* repo.createMessage({
        groupID: group.id,
        senderID: userID,
        senderType: "user",
        type: "text",
        content: "First message",
        mentions: [],
      })

      const msg2 = yield* repo.createMessage({
        groupID: group.id,
        senderID: userID,
        senderType: "user",
        type: "text",
        content: "Second message with @CodeAgent",
        mentions: ["CodeAgent"],
      })

      const context = yield* contextBuilder.build({
        workspaceID,
        groupID: group.id,
        messageID: msg2.id,
        task: "Second message with @CodeAgent",
      })

      expect(context.conversation.recentMessages.length).toBe(2)
      expect(context.conversation.groupID).toBe(group.id)
      expect(context.conversation.recentMessages.map((msg) => msg.content)).toEqual([
        "First message",
        "Second message with @CodeAgent",
      ])

      return context
    })

    const output = await Effect.runPromise(program.pipe(Effect.provide(testLayer)))
    expect(output).toBeDefined()
  })

  it("should list available agents from AgentV2", async () => {
    const program = Effect.gen(function* () {
      const agentListProvider = yield* AgentListProviderService

      const agents = yield* agentListProvider.listAgents({
        workspaceID: "test-workspace",
        userID: "test-user",
      })

      // Should return agents from AgentV2.Service
      // The exact list depends on the agent configuration
      expect(Array.isArray(agents)).toBe(true)

      return agents
    })

    const agents = await Effect.runPromise(program.pipe(Effect.provide(testLayer)))
    expect(agents).toBeDefined()
  })

  it("should broadcast messages via WebSocket broadcaster", async () => {
    const program = Effect.gen(function* () {
      yield* setupDatabase
      const broadcaster = yield* IMBroadcasterService
      const repo = yield* IMRepository

      const workspaceID = "test-workspace"
      const userID = "test-user"

      const group = yield* repo.createGroup({
        workspaceID,
        name: "Test Broadcast Group",
        type: "project",
        projectID: "test-project",
        createdBy: userID,
      })

      // Mock connection
      const receivedEvents: ServerEvent[] = []
      const connection = {
        groupID: group.id,
        userID,
        workspaceID,
        send: (event: ServerEvent) => {
          receivedEvents.push(event)
        },
        close: () => {},
      }

      broadcaster.register(connection)

      // Create a message
      const message = yield* repo.createMessage({
        groupID: group.id,
        senderID: userID,
        senderType: "user",
        type: "text",
        content: "Broadcast test",
        mentions: [],
      })

      // Broadcast message_created event
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

      // Broadcast agent_status event
      broadcaster.broadcast(group.id, {
        type: "agent_status",
        data: {
          messageID: message.id,
          agentID: "build",
          status: "started",
        },
      })

      broadcaster.unregister(connection)

      expect(receivedEvents.length).toBe(2)
      expect(receivedEvents[0].type).toBe("message_created")
      expect(receivedEvents[1].type).toBe("agent_status")

      return receivedEvents
    })

    const events = await Effect.runPromise(program.pipe(Effect.provide(testLayer)))
    expect(events.length).toBe(2)
  })
})
