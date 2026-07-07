import { describe, it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { IMRepository, IMRepositoryLive } from "../src/im/repository"
import { IMBroadcasterService } from "../src/im/broadcaster"
import type { IMBroadcaster, IMWebSocketConnection } from "../src/im/websocket"
import { AgentExecutorService, AgentContextBuilderService } from "../src/im/agent-executor"
import type { AgentExecutionResult, AgentContext } from "../src/im/agent-executor"
import { AgentListProviderService } from "../src/im/agent-list-provider"
import { AgentReplySinkService, type AgentReplySink } from "../src/im/agent-reply-sink"
import type { AgentDescriptor } from "../src/im/mention-parser"
import { executeAgentMentions } from "../src/im/agent-orchestrator"
import { Database } from "@deepagent-code/core/database/database"

/**
 * Verifies the OPTIONAL AgentReplySink seam (Server Edition → gateway hub):
 * when a sink layer is provided, the orchestrator notifies it with the
 * kernel-native (groupID, messageID) + agent outcome; when absent, nothing
 * changes (covered by im-orchestrator.test.ts staying green).
 */
describe("IM AgentReplySink", () => {
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

  // Capture broadcasts so progress-event wiring can be asserted.
  const broadcasts: Array<{ groupID: string; type: string; data: any }> = []
  const fakeBroadcaster: IMBroadcaster = {
    broadcast: (groupID, event) => {
      broadcasts.push({ groupID, type: event.type, data: (event as any).data })
    },
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
    findByTrigger: () => Effect.succeed([]),
    findByCapability: () => Effect.succeed([]),
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

  // Capture sink notifications + progress mirrors.
  const captured: Array<{ groupID: string; messageID: string; agentID: string; status: string; content?: string }> = []
  const progressed: Array<{ messageID: string; agentID: string; count: number }> = []
  const fakeSink: AgentReplySink = {
    notify: (input) =>
      Effect.sync(() => {
        const status = input.result.success ? "success" : input.result.timeout ? "timeout" : "failed"
        captured.push({
          groupID: input.groupID,
          messageID: input.messageID,
          agentID: input.agentID,
          status,
          content: input.result.content,
        })
      }),
    progress: (input) =>
      Effect.sync(() => {
        progressed.push({ messageID: input.messageID, agentID: input.agentID, count: input.parts.length })
      }),
  }
  const FakeSinkLive = Layer.succeed(AgentReplySinkService, fakeSink)

  const baseLayer = Layer.mergeAll(
    Database.defaultLayer,
    IMRepositoryLive.pipe(Layer.provide(Database.defaultLayer)),
    FakeBroadcasterLive,
    FakeAgentListLive,
    FakeContextBuilderLive,
    FakeSinkLive,
  )

  it("notifies the reply sink with the agent outcome on success", async () => {
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
      return group.id
    })

    const layer = Layer.merge(
      baseLayer,
      makeExecutor({ success: true, timeout: false, content: "here is your code" }),
    )
    const groupId = await Effect.runPromise(program.pipe(Effect.provide(layer)))

    expect(captured.length).toBe(1)
    expect(captured[0]).toMatchObject({
      groupID: groupId,
      messageID: "msg-1",
      agentID: "code-agent",
      status: "success",
      content: "here is your code",
    })
  })

  it("notifies the reply sink with failed status when the agent errors", async () => {
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
        content: "@code-agent boom",
        mentionedAgentNames: ["code-agent"],
      })
    })

    const layer = Layer.merge(
      baseLayer,
      makeExecutor({
        success: false,
        timeout: false,
        error: { code: "AGENT_EXECUTION_ERROR", message: "boom", retryable: false },
      }),
    )
    await Effect.runPromise(program.pipe(Effect.provide(layer)))

    expect(captured.length).toBe(1)
    expect(captured[0]?.status).toBe("failed")
    expect(captured[0]?.content).toBeUndefined()
  })

  it("broadcasts agent_progress on the WS plane and mirrors it to the sink", async () => {
    captured.length = 0
    broadcasts.length = 0
    progressed.length = 0

    // An executor that emits one progress batch (as the streamer would) before
    // returning its final result, exercising the orchestrator's onProgress wiring.
    const ProgressingExecutorLive = Layer.succeed(AgentExecutorService, {
      execute: (input) =>
        Effect.gen(function* () {
          if (input.onProgress) {
            yield* input.onProgress([
              { partID: "p1", order: 0, kind: "reasoning", text: "thinking..." },
              { partID: "p2", order: 1, kind: "tool", tool: "read", status: "running" },
            ])
          }
          return { success: true, timeout: false, content: "done" } satisfies AgentExecutionResult
        }),
    })

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
        content: "@code-agent stream please",
        mentionedAgentNames: ["code-agent"],
      })
      return group.id
    })

    const layer = Layer.merge(
      Layer.mergeAll(
        Database.defaultLayer,
        IMRepositoryLive.pipe(Layer.provide(Database.defaultLayer)),
        FakeBroadcasterLive,
        FakeAgentListLive,
        FakeContextBuilderLive,
        FakeSinkLive,
      ),
      ProgressingExecutorLive,
    )
    const groupId = await Effect.runPromise(program.pipe(Effect.provide(layer)))

    // Broadcast on the WS plane (what the chat UI listens to).
    const progressEvents = broadcasts.filter((b) => b.type === "agent_progress")
    expect(progressEvents.length).toBe(1)
    expect(progressEvents[0]?.groupID).toBe(groupId)
    expect(progressEvents[0]?.data).toMatchObject({ messageID: "msg-3", agentID: "code-agent" })
    expect(progressEvents[0]?.data.parts.length).toBe(2)
    expect(progressEvents[0]?.data.parts[0]).toMatchObject({ partID: "p1", kind: "reasoning" })

    // Mirrored to the sink (authoritative hub) with the same batch.
    expect(progressed.length).toBe(1)
    expect(progressed[0]).toMatchObject({ messageID: "msg-3", agentID: "code-agent", count: 2 })

    // Final reply still flows through notify.
    expect(captured.length).toBe(1)
    expect(captured[0]?.status).toBe("success")
  })
})
