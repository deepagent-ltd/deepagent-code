import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { sql } from "drizzle-orm"
import { IMRepository, IMRepositoryLive } from "../src/im/repository"
import { Database } from "../src/database/database"
import { GroupTable, MemberTable, MessageTable } from "../src/im/sql"

const databaseLayer = Database.layerFromPath(":memory:")
const testLayer = Layer.provideMerge(IMRepositoryLive, databaseLayer)
type TestServices = Layer.Success<typeof testLayer>

const run = <A, E>(effect: Effect.Effect<A, E, TestServices | Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(testLayer)))

const makeTestEnv = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const now = Date.now()

  yield* db.run(`
    INSERT OR IGNORE INTO project (id, worktree, name, time_created, time_updated, sandboxes)
    VALUES ('proj_test', '/tmp/deepagent-im-repository', 'Test Project', ${now}, ${now}, '[]')
  `)
  yield* db.run(`
    INSERT OR IGNORE INTO workspace (id, type, name, directory, project_id, time_used)
    VALUES ('ws_test', 'local', 'Test Workspace', '/tmp/deepagent-im-repository', 'proj_test', ${now})
  `)

  const repo = yield* IMRepository

  return { db, repo }
})

describe("IMRepository", () => {
  test("creates a project group", async () => {
    await run(
      Effect.gen(function* () {
        const { repo } = yield* makeTestEnv

        const group = yield* repo.createGroup({
          workspaceID: "ws_test",
          projectID: "proj_test",
          type: "project",
          name: "Test Group",
          createdBy: "user_123",
        })

        expect(group.id).toStartWith("img_")
        expect(group.workspaceID).toBe("ws_test")
        expect(group.projectID).toBe("proj_test")
        expect(group.type).toBe("project")
        expect(group.name).toBe("Test Group")
        expect(group.createdBy).toBe("user_123")
        expect(group.deletedAt).toBe(null)
      }),
    )
  })

  test("adds creator as owner when creating group", async () => {
    await run(
      Effect.gen(function* () {
        const { db, repo } = yield* makeTestEnv

        const group = yield* repo.createGroup({
          workspaceID: "ws_test",
          type: "system",
          name: "System Group",
          createdBy: "user_123",
        })

        const members = yield* db.select().from(MemberTable).where(sql`group_id = ${group.id}`)

        expect(members).toHaveLength(1)
        expect(members[0].member_id).toBe("user_123")
        expect(members[0].member_type).toBe("user")
        expect(members[0].role).toBe("owner")
      }),
    )
  })

  test("lists groups in workspace", async () => {
    await run(
      Effect.gen(function* () {
        const { repo } = yield* makeTestEnv

        yield* repo.createGroup({
          workspaceID: "ws_test",
          type: "project",
          name: "Group 1",
          createdBy: "user_123",
        })

        yield* repo.createGroup({
          workspaceID: "ws_test",
          type: "system",
          name: "Group 2",
          createdBy: "user_123",
        })

        const groups = yield* repo.listGroups({ workspaceID: "ws_test", userID: "user_123" })

        expect(groups).toHaveLength(2)
        expect(groups.map((g) => g.name)).toContain("Group 1")
        expect(groups.map((g) => g.name)).toContain("Group 2")
      }),
    )
  })

  test("adds user and agent members", async () => {
    await run(
      Effect.gen(function* () {
        const { db, repo } = yield* makeTestEnv

        const group = yield* repo.createGroup({
          workspaceID: "ws_test",
          type: "project",
          name: "Test Group",
          createdBy: "user_123",
        })

        yield* repo.addMember({
          groupID: group.id,
          memberID: "user_456",
          memberType: "user",
          role: "member",
        })

        yield* repo.addMember({
          groupID: group.id,
          memberID: "agent_001",
          memberType: "agent",
          role: "agent",
        })

        const members = yield* db.select().from(MemberTable).where(sql`group_id = ${group.id}`)

        expect(members).toHaveLength(3) // owner + 2 new members
        expect(members.filter((m) => m.member_type === "user")).toHaveLength(2)
        expect(members.filter((m) => m.member_type === "agent")).toHaveLength(1)
      }),
    )
  })

  test("creates messages with different sender types", async () => {
    await run(
      Effect.gen(function* () {
        const { repo } = yield* makeTestEnv

        const group = yield* repo.createGroup({
          workspaceID: "ws_test",
          type: "project",
          name: "Test Group",
          createdBy: "user_123",
        })

        const userMsg = yield* repo.createMessage({
          groupID: group.id,
          senderID: "user_123",
          senderType: "user",
          type: "text",
          content: "Hello from user",
        })

        const agentMsg = yield* repo.createMessage({
          groupID: group.id,
          senderID: "agent_001",
          senderType: "agent",
          type: "text",
          content: "Hello from agent",
        })

        const systemMsg = yield* repo.createMessage({
          groupID: group.id,
          senderID: "system",
          senderType: "system",
          type: "system",
          content: "System notification",
        })

        expect(userMsg.senderType).toBe("user")
        expect(agentMsg.senderType).toBe("agent")
        expect(systemMsg.senderType).toBe("system")
      }),
    )
  })

  test("deduplicates mentions", async () => {
    await run(
      Effect.gen(function* () {
        const { repo } = yield* makeTestEnv

        const group = yield* repo.createGroup({
          workspaceID: "ws_test",
          type: "project",
          name: "Test Group",
          createdBy: "user_123",
        })

        const message = yield* repo.createMessage({
          groupID: group.id,
          senderID: "user_123",
          senderType: "user",
          type: "text",
          content: "@agent1 @agent2 @agent1",
          mentions: ["agent1", "agent2", "agent1"],
        })

        expect(message.mentions).toHaveLength(2)
        expect(message.mentions).toContain("agent1")
        expect(message.mentions).toContain("agent2")
      }),
    )
  })

  test("lists messages in descending order", async () => {
    await run(
      Effect.gen(function* () {
        const { repo } = yield* makeTestEnv

        const group = yield* repo.createGroup({
          workspaceID: "ws_test",
          type: "project",
          name: "Test Group",
          createdBy: "user_123",
        })

        const msg1 = yield* repo.createMessage({
          groupID: group.id,
          senderID: "user_123",
          senderType: "user",
          type: "text",
          content: "First message",
        })

        yield* Effect.sleep("10 millis")

        const msg2 = yield* repo.createMessage({
          groupID: group.id,
          senderID: "user_123",
          senderType: "user",
          type: "text",
          content: "Second message",
        })

        const page = yield* repo.listMessages({
          groupID: group.id,
          limit: 10,
        })

        expect(page.messages).toHaveLength(2)
        expect(page.messages[0].id).toBe(msg2.id) // Most recent first
        expect(page.messages[1].id).toBe(msg1.id)
      }),
    )
  })

  test("paginates messages with cursor", async () => {
    await run(
      Effect.gen(function* () {
        const { repo } = yield* makeTestEnv

        const group = yield* repo.createGroup({
          workspaceID: "ws_test",
          type: "project",
          name: "Test Group",
          createdBy: "user_123",
        })

        // Create 5 messages
        for (let i = 0; i < 5; i++) {
          yield* repo.createMessage({
            groupID: group.id,
            senderID: "user_123",
            senderType: "user",
            type: "text",
            content: `Message ${i}`,
          })
          yield* Effect.sleep("5 millis")
        }

        // First page: limit 2
        const page1 = yield* repo.listMessages({
          groupID: group.id,
          limit: 2,
        })

        expect(page1.messages).toHaveLength(2)
        expect(page1.hasMore).toBe(true)
        expect(page1.nextCursor).not.toBe(null)

        // Second page: use cursor
        const page2 = yield* repo.listMessages({
          groupID: group.id,
          limit: 2,
          cursor: page1.nextCursor!,
        })

        expect(page2.messages).toHaveLength(2)
        expect(page2.messages[0].id).not.toBe(page1.messages[0].id)
        expect(page2.messages[0].id).not.toBe(page1.messages[1].id)
      }),
    )
  })

  test("filters out soft-deleted messages", async () => {
    await run(
      Effect.gen(function* () {
        const { db, repo } = yield* makeTestEnv

        const group = yield* repo.createGroup({
          workspaceID: "ws_test",
          type: "project",
          name: "Test Group",
          createdBy: "user_123",
        })

        const msg1 = yield* repo.createMessage({
          groupID: group.id,
          senderID: "user_123",
          senderType: "user",
          type: "text",
          content: "Active message",
        })

        const msg2 = yield* repo.createMessage({
          groupID: group.id,
          senderID: "user_123",
          senderType: "user",
          type: "text",
          content: "Deleted message",
        })

        // Soft delete msg2
        yield* db.update(MessageTable).set({ deleted_at: Date.now() }).where(sql`id = ${msg2.id}`)

        const page = yield* repo.listMessages({
          groupID: group.id,
          limit: 10,
        })

        expect(page.messages).toHaveLength(1)
        expect(page.messages[0].id).toBe(msg1.id)
      }),
    )
  })

  test("marks messages as read", async () => {
    await run(
      Effect.gen(function* () {
        const { db, repo } = yield* makeTestEnv

        const group = yield* repo.createGroup({
          workspaceID: "ws_test",
          type: "project",
          name: "Test Group",
          createdBy: "user_123",
        })

        const readAt = Date.now()
        yield* repo.markRead({
          groupID: group.id,
          memberID: "user_123",
          readAt,
        })

        const member = yield* db
          .select()
          .from(MemberTable)
          .where(sql`group_id = ${group.id} AND member_id = 'user_123'`)
          .get()

        expect(member?.last_read_at).toBe(readAt)
      }),
    )
  })

  test("filters out soft-deleted groups", async () => {
    await run(
      Effect.gen(function* () {
        const { db, repo } = yield* makeTestEnv

        const group1 = yield* repo.createGroup({
          workspaceID: "ws_test",
          type: "project",
          name: "Active Group",
          createdBy: "user_123",
        })

        const group2 = yield* repo.createGroup({
          workspaceID: "ws_test",
          type: "project",
          name: "Deleted Group",
          createdBy: "user_123",
        })

        // Soft delete group2
        yield* db.update(GroupTable).set({ deleted_at: Date.now() }).where(sql`id = ${group2.id}`)

        const groups = yield* repo.listGroups({ workspaceID: "ws_test", userID: "user_123" })

        expect(groups).toHaveLength(1)
        expect(groups[0].id).toBe(group1.id)
      }),
    )
  })
})
