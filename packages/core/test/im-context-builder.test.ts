import { describe, expect, it } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AgentContext, AgentContextBuilderService } from "../src/im/agent-executor"
import { AgentContextBuilderLive } from "../src/im/context-builder"
import { IMRepository, type IMRepositoryInterface, type MessagePage } from "../src/im/repository"

const makeRepo = (messages: MessagePage["messages"]): IMRepositoryInterface =>
  ({
    listMessages: () => Effect.succeed({ messages, nextCursor: null, hasMore: false } as MessagePage),
  }) as unknown as IMRepositoryInterface

const buildWith = (repo: IMRepositoryInterface) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const builder = yield* AgentContextBuilderService
      return yield* builder.build({
        workspaceID: "wrk_context_builder",
        groupID: "g1",
        messageID: "m1",
        task: "inspect context",
      })
    }).pipe(Effect.provide(AgentContextBuilderLive.pipe(Layer.provide(Layer.succeed(IMRepository, repo))))),
  )

describe("AgentContextBuilder", () => {
  it("builds conversation metadata without pre-querying graph buckets", async () => {
    const context = await buildWith(makeRepo([]))
    expect(() => Schema.decodeUnknownSync(AgentContext)(context)).not.toThrow()
    expect(context).toEqual({ conversation: { groupID: "g1", recentMessages: [] } })
    expect("code" in context).toBe(false)
    expect("knowledge" in context).toBe(false)
    expect("memory" in context).toBe(false)
    expect("documents" in context).toBe(false)
  })

  it("sorts recent messages oldest-first for Session input admission", async () => {
    const now = Date.now()
    const message = (id: string, createdAt: number) => ({
      id,
      groupID: "g1",
      senderID: "u1",
      senderType: "user",
      type: "text",
      content: `msg ${id}`,
      mentions: [],
      metadata: null,
      replyToID: null,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
    })
    const context = await buildWith(makeRepo([message("b", now + 100), message("a", now)]))
    expect(context.conversation.recentMessages.map((item) => item.id)).toEqual(["a", "b"])
  })
})
