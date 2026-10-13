import { describe, expect, test } from "bun:test"
import { Effect, Layer, Result } from "effect"
import { IMRepository, IMRepositoryLive } from "../src/im/repository"
import { Database } from "../src/database/database"

const database = Database.layerFromPath(":memory:")
const runtime = Layer.mergeAll(database, IMRepositoryLive.pipe(Layer.provide(database)))
const setup = Effect.gen(function* () {
  const repo = yield* IMRepository
  const group = yield* repo.createGroup({ workspaceID: "ws", type: "project", name: "identity", createdBy: "alice" })
  return { repo, group }
})

describe("IM request identity and lossless local history", () => {
  test("exact concurrent retries preserve one ordinary message without execution; changed bound payloads conflict", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repo, group } = yield* setup
        const input = {
          groupID: group.id,
          senderID: "alice",
          senderType: "user" as const,
          type: "text" as const,
          content: "@auto hello",
          mentions: ["auto"],
          clientRequestID: "request-1",
        }
        const messages = yield* Effect.all(
          Array.from({ length: 8 }, () => repo.createMessage(input)),
          { concurrency: 8 },
        )
        expect(new Set(messages.map((row) => row.id)).size).toBe(1)
        expect(messages.filter((row) => !row.replayed)).toHaveLength(1)
        expect(yield* (yield* Database.Service).db.all("SELECT (SELECT count(*) FROM im_mention_intent) intents, (SELECT count(*) FROM session_input) inputs")).toEqual([{ intents: 0, inputs: 0 }])
        const other = yield* repo.createGroup({ workspaceID: "ws", type: "project", name: "other", createdBy: "alice" })
        for (const change of [
          { content: "different" },
          { type: "code" as const },
          { groupID: other.id },
          { replyToID: messages[0]!.id },
          { mentions: ["other"] },
          { metadata: { type: "error" as const, code: "x", message: "x", retryable: false } },
        ]) {
          const result = yield* Effect.result(repo.createMessage({ ...input, ...change }))
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) expect(result.failure.code).toBe("message_identity_conflict")
        }
        expect((yield* repo.listMessages({ groupID: group.id, limit: 20 })).messages).toHaveLength(1)
        expect((yield* repo.listMessages({ groupID: other.id, limit: 20 })).messages).toHaveLength(0)
      }).pipe(Effect.scoped, Effect.provide(runtime)),
    )
  })

  test("three pages in one millisecond enumerate every message once using composite cursors", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repo, group } = yield* setup
        const rows = yield* Effect.all(
          Array.from({ length: 125 }, (_, index) =>
            repo.createMessage({
              groupID: group.id,
              senderID: "alice",
              senderType: "user",
              type: "text",
              content: `line ${index}`,
              createdAt: 1_700_000_000_000,
            }),
          ),
        )
        const first = yield* repo.listMessages({ groupID: group.id, limit: 50 })
        const second = yield* repo.listMessages({ groupID: group.id, limit: 50, cursor: first.nextCursor! })
        const third = yield* repo.listMessages({ groupID: group.id, limit: 50, cursor: second.nextCursor! })
        expect(first.nextCursor).toContain("_imsg_")
        expect([first.messages.length, second.messages.length, third.messages.length]).toEqual([50, 50, 25])
        expect(third.hasMore).toBe(false)
        expect(new Set([...first.messages, ...second.messages, ...third.messages].map((row) => row.id))).toEqual(
          new Set(rows.map((row) => row.id)),
        )
        expect(
          (yield* repo.listMessages({ groupID: group.id, limit: 50, cursor: "1700000000001" })).messages,
        ).toHaveLength(50)
      }).pipe(Effect.scoped, Effect.provide(runtime)),
    )
  })
})
