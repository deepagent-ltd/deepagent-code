import { describe, it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { IMRepository, IMRepositoryLive } from "../src/im/repository"
import { IMBroadcasterService } from "../src/im/broadcaster"
import type { IMBroadcaster, IMWebSocketConnection, ServerEvent } from "../src/im/websocket"
import { AgentExecutorService, AgentContextBuilderService } from "../src/im/agent-executor"
import type { AgentExecutionResult, AgentContext } from "../src/im/agent-executor"
import { AgentListProviderService } from "../src/im/agent-list-provider"
import type { AgentDescriptor } from "../src/im/mention-parser"
import { executeAgentMentions } from "../src/im/agent-orchestrator"
import { Database } from "@deepagent-code/core/database/database"

/**
 * These tests exercise the agent-mention orchestration end to end with FAKE
 * agent/executor/context layers (no SessionV2 needed), which is the path the
 * two prior reviews found was never covered — the real HTTP handler forks this
 * orchestration and it silently died. Here we assert the broadcast chain and
 * the persisted agent reply.
 */
describe("IM Agent Orchestrator", () => {
  const setupDatabase = Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(`DROP TABLE IF EXISTS im_messages`)
    yield* db.run(`DROP TABLE IF EXISTS im_members`)
    yield* db.run(`DROP TABLE IF EXISTS im_groups`)
    yield* db.run(`
      CREATE TABLE im_groups (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
        project_id TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
      )`)
    yield* db.run(`
      CREATE TABLE im_members (
        group_id TEXT NOT NULL, member_id TEXT NOT NULL, member_type TEXT NOT NULL, role TEXT NOT NULL,
        last_read_at INTEGER, joined_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, member_id, member_type), FOREIGN KEY (group_id) REFERENCES im_groups(id)
      )`)
    yield* db.run(`
      CREATE TABLE im_messages (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL, sender_id TEXT NOT NULL, sender_type TEXT NOT NULL,
        type TEXT NOT NULL, content TEXT NOT NULL, mentions TEXT, metadata TEXT, reply_to_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
        FOREIGN KEY (group_id) REFERENCES im_groups(id)
      )`)
  })

  // Capture broadcasts so tests can assert the event chain.
  const captured: Array<{ groupID: string; event: ServerEvent }> = []
  const fakeBroadcaster: IMBroadcaster = {
    broadcast: (groupID, event) => captured.push({ groupID, event }),
    sendToUser: () => {},
    register: (_conn: IMWebSocketConnection) => {},
    unregister: () => {},
    getConnectionCount: () => 0,
    getUserConnectionCount: () => 0,
  }
  const FakeBroadcasterLive = Layer.succeed(IMBroadcasterService, fakeBroadcaster)

  const AGENT: AgentDescriptor = {
    id: "code-agent",
    name: "code-agent",
    displayName: "Code Agent",
    description: "writes code",
    visible: true,
  }
  const FakeAgentListLive = Layer.succeed(AgentListProviderService, {
    listAgents: () => Effect.succeed([AGENT]),
  })

  const FakeContextBuilderLive = Layer.succeed(AgentContextBuilderService, {
    build: (): Effect.Effect<AgentContext, never, never> =>
      Effect.succeed({
        code: undefined,
        knowledge: [],
        memory: [],
        documents: [],
        conversation: { groupID: "", recentMessages: [] },
      }),
  })

  const makeExecutor = (result: AgentExecutionResult) =>
    Layer.succeed(AgentExecutorService, { execute: () => Effect.succeed(result) })

  const baseLayer = Layer.mergeAll(
    Database.defaultLayer,
    IMRepositoryLive.pipe(Layer.provide(Database.defaultLayer)),
    FakeBroadcasterLive,
    FakeAgentListLive,
    FakeContextBuilderLive,
  )

  it("runs the mention → context → execute → persist → broadcast chain on success", async () => {
    captured.length = 0
    const program = Effect.gen(function* () {
      yield* setupDatabase
      const repo = yield* IMRepository
      const group = yield* repo.createGroup({
        workspaceID: "ws1",
        name: "G",
        type: "project",
        createdBy: "server",
      })

      yield* executeAgentMentions({
        workspaceID: "ws1",
        directory: "/tmp/ws1",
        groupID: group.id,
        messageID: "msg-1",
        userID: "server",
        content: "@code-agent please help",
        mentionedAgentNames: ["code-agent"],
      })

      // The agent reply must have been persisted.
      const page = yield* repo.listMessages({ groupID: group.id, limit: 10 })
      return page.messages
    })

    const layer = Layer.merge(baseLayer, makeExecutor({
      success: true,
      timeout: false,
      content: "here is your code",
    }))

    const messages = await Effect.runPromise(program.pipe(Effect.provide(layer)))

    const agentReply = messages.find((m) => m.senderType === "agent")
    expect(agentReply).toBeDefined()
    expect(agentReply?.content).toBe("here is your code")

    const kinds = captured.map((c) =>
      c.event.type === "agent_status" ? `status:${(c.event as any).data.status}` : c.event.type,
    )
    expect(kinds).toContain("status:started")
    expect(kinds).toContain("message_created")
    expect(kinds).toContain("status:success")
  })

  it("broadcasts timeout status and persists nothing when the agent times out", async () => {
    captured.length = 0
    const program = Effect.gen(function* () {
      yield* setupDatabase
      const repo = yield* IMRepository
      const group = yield* repo.createGroup({
        workspaceID: "ws1",
        name: "G",
        type: "project",
        createdBy: "server",
      })

      yield* executeAgentMentions({
        workspaceID: "ws1",
        directory: "/tmp/ws1",
        groupID: group.id,
        messageID: "msg-2",
        userID: "server",
        content: "@code-agent slow",
        mentionedAgentNames: ["code-agent"],
      })

      const page = yield* repo.listMessages({ groupID: group.id, limit: 10 })
      return page.messages
    })

    const layer = Layer.merge(baseLayer, makeExecutor({
      success: false,
      timeout: true,
      error: { code: "AGENT_TIMEOUT", message: "timed out", retryable: true },
    }))

    const messages = await Effect.runPromise(program.pipe(Effect.provide(layer)))

    expect(messages.find((m) => m.senderType === "agent")).toBeUndefined()
    const kinds = captured.map((c) => (c.event.type === "agent_status" ? `status:${(c.event as any).data.status}` : c.event.type))
    expect(kinds).toContain("status:started")
    expect(kinds).toContain("status:timeout")
    expect(kinds).not.toContain("message_created")
  })

  it("ignores mentions of unknown or invisible agents", async () => {
    captured.length = 0
    const program = Effect.gen(function* () {
      yield* setupDatabase
      const repo = yield* IMRepository
      const group = yield* repo.createGroup({
        workspaceID: "ws1",
        name: "G",
        type: "project",
        createdBy: "server",
      })

      yield* executeAgentMentions({
        workspaceID: "ws1",
        directory: "/tmp/ws1",
        groupID: group.id,
        messageID: "msg-3",
        userID: "server",
        content: "@nonexistent hi",
        mentionedAgentNames: ["nonexistent"],
      })

      const page = yield* repo.listMessages({ groupID: group.id, limit: 10 })
      return page.messages
    })

    const layer = Layer.merge(baseLayer, makeExecutor({ success: true, timeout: false, content: "should not run" }))
    const messages = await Effect.runPromise(program.pipe(Effect.provide(layer)))

    expect(messages.length).toBe(0)
    expect(captured.length).toBe(0)
  })
})
