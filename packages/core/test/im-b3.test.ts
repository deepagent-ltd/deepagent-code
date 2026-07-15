import { describe, it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { IMRepository, IMRepositoryLive, IMRepositoryError } from "../src/im/repository"
import { Database } from "@deepagent-code/core/database/database"

// §B3 repository-level tests. These run against a real in-memory database with the FULL migration set
// applied (Database.layerFromPath runs migrations), so the FTS5 table + triggers and im_attachments
// table exist exactly as they will in production.
describe("IM §B3 — Thread / Direct / Search / Attachments", () => {
  const databaseLayer = Database.layerFromPath(":memory:")
  const repositoryLayer = Layer.provideMerge(IMRepositoryLive, databaseLayer)

  const run = <A>(program: Effect.Effect<A, unknown, IMRepository | Database.Service>) =>
    Effect.runPromise(program.pipe(Effect.provide(repositoryLayer)) as Effect.Effect<A, unknown, never>)

  const WS = "ws-b3"
  const USER = "server"

  // ── THREAD ──────────────────────────────────────────────────────────────────────────────────────
  describe("listThread", () => {
    it("returns only replies to the given parent, ASC, and paginates by keyset", async () => {
      const result = await run(
        Effect.gen(function* () {
          const repo = yield* IMRepository
          const group = yield* repo.createGroup({
            workspaceID: WS,
            name: "Thread Group",
            type: "project",
            createdBy: USER,
          })
          const parent = yield* repo.createMessage({
            groupID: group.id,
            senderID: USER,
            senderType: "user",
            type: "text",
            content: "parent",
          })
          const other = yield* repo.createMessage({
            groupID: group.id,
            senderID: USER,
            senderType: "user",
            type: "text",
            content: "unrelated root message",
          })
          // Five replies to `parent` + one reply to `other` (must NOT appear in parent's thread).
          const replies = []
          for (let i = 0; i < 5; i++) {
            replies.push(
              yield* repo.createMessage({
                groupID: group.id,
                senderID: USER,
                senderType: "user",
                type: "text",
                content: `reply ${i}`,
                replyToID: parent.id,
              }),
            )
          }
          yield* repo.createMessage({
            groupID: group.id,
            senderID: USER,
            senderType: "user",
            type: "text",
            content: "reply to OTHER",
            replyToID: other.id,
          })

          // Page 1: limit 2.
          const page1 = yield* repo.listThread({ groupID: group.id, replyToID: parent.id, limit: 2 })
          const page2 = yield* repo.listThread({
            groupID: group.id,
            replyToID: parent.id,
            cursor: page1.nextCursor ?? undefined,
            limit: 2,
          })
          const page3 = yield* repo.listThread({
            groupID: group.id,
            replyToID: parent.id,
            cursor: page2.nextCursor ?? undefined,
            limit: 2,
          })

          return { replies, page1, page2, page3 }
        }),
      )

      expect(result.page1.messages.map((m) => m.content)).toEqual(["reply 0", "reply 1"])
      expect(result.page1.hasMore).toBe(true)
      expect(result.page2.messages.map((m) => m.content)).toEqual(["reply 2", "reply 3"])
      expect(result.page3.messages.map((m) => m.content)).toEqual(["reply 4"])
      expect(result.page3.hasMore).toBe(false)
      expect(result.page3.nextCursor).toBeNull()
      // Every returned message replies to the parent; the reply to OTHER never appears.
      const all = [...result.page1.messages, ...result.page2.messages, ...result.page3.messages]
      expect(all.every((m) => m.content.startsWith("reply "))).toBe(true)
      expect(all.some((m) => m.content === "reply to OTHER")).toBe(false)
    })

    it("excludes soft-deleted replies", async () => {
      const rows = await run(
        Effect.gen(function* () {
          const repo = yield* IMRepository
          const { db } = yield* Database.Service
          const group = yield* repo.createGroup({ workspaceID: WS, name: "G", type: "project", createdBy: USER })
          const parent = yield* repo.createMessage({
            groupID: group.id, senderID: USER, senderType: "user", type: "text", content: "p",
          })
          const r1 = yield* repo.createMessage({
            groupID: group.id, senderID: USER, senderType: "user", type: "text", content: "keep", replyToID: parent.id,
          })
          const r2 = yield* repo.createMessage({
            groupID: group.id, senderID: USER, senderType: "user", type: "text", content: "gone", replyToID: parent.id,
          })
          yield* db.run(`UPDATE im_messages SET deleted_at = ${Date.now()} WHERE id = '${r2.id}'`)
          void r1
          const page = yield* repo.listThread({ groupID: group.id, replyToID: parent.id, limit: 10 })
          return page.messages.map((m) => m.content)
        }),
      )
      expect(rows).toEqual(["keep"])
    })
  })

  // ── DIRECT GROUP ────────────────────────────────────────────────────────────────────────────────
  describe("createDirectGroup", () => {
    it("creates a user+agent direct group and is idempotent on the pair", async () => {
      const result = await run(
        Effect.gen(function* () {
          const repo = yield* IMRepository
          const first = yield* repo.createDirectGroup({
            workspaceID: WS,
            createdBy: USER,
            members: [
              { memberID: USER, memberType: "user" },
              { memberID: "CodeAgent", memberType: "agent" },
            ],
          })
          // Same pair, reversed order → must return the SAME group (canonicalized, deduped).
          const second = yield* repo.createDirectGroup({
            workspaceID: WS,
            createdBy: USER,
            members: [
              { memberID: "CodeAgent", memberType: "agent" },
              { memberID: USER, memberType: "user" },
            ],
          })
          return { first, second }
        }),
      )
      expect(result.first.type).toBe("direct")
      expect(result.second.id).toBe(result.first.id)
    })

    it("rejects != 2 members", async () => {
      const err = await run(
        Effect.gen(function* () {
          const repo = yield* IMRepository
          return yield* repo
            .createDirectGroup({
              workspaceID: WS,
              createdBy: USER,
              members: [{ memberID: USER, memberType: "user" }],
            })
            .pipe(Effect.flip)
        }),
      )
      expect(err).toBeInstanceOf(IMRepositoryError)
    })

    it("rejects agent+agent (no user participant)", async () => {
      const err = await run(
        Effect.gen(function* () {
          const repo = yield* IMRepository
          return yield* repo
            .createDirectGroup({
              workspaceID: WS,
              createdBy: USER,
              members: [
                { memberID: "A1", memberType: "agent" },
                { memberID: "A2", memberType: "agent" },
              ],
            })
            .pipe(Effect.flip)
        }),
      )
      expect(err).toBeInstanceOf(IMRepositoryError)
    })

    it("rejects when the creator is not a participant", async () => {
      const err = await run(
        Effect.gen(function* () {
          const repo = yield* IMRepository
          return yield* repo
            .createDirectGroup({
              workspaceID: WS,
              createdBy: USER,
              members: [
                { memberID: "someoneElse", memberType: "user" },
                { memberID: "CodeAgent", memberType: "agent" },
              ],
            })
            .pipe(Effect.flip)
        }),
      )
      expect(err).toBeInstanceOf(IMRepositoryError)
    })
  })

  // ── SEARCH ──────────────────────────────────────────────────────────────────────────────────────
  describe("searchMessages", () => {
    it("finds matching messages only in groups the caller belongs to (permission scoping)", async () => {
      const result = await run(
        Effect.gen(function* () {
          const repo = yield* IMRepository
          // Group the caller belongs to (creator ⇒ owner member).
          const mine = yield* repo.createGroup({ workspaceID: WS, name: "Mine", type: "project", createdBy: USER })
          yield* repo.createMessage({
            groupID: mine.id, senderID: USER, senderType: "user", type: "text",
            content: "the quick brown fox jumps",
          })
          // Group owned by another user; the caller is NOT a member.
          const theirs = yield* repo.createGroup({
            workspaceID: WS, name: "Theirs", type: "project", createdBy: "otherUser",
          })
          yield* repo.createMessage({
            groupID: theirs.id, senderID: "otherUser", senderType: "user", type: "text",
            content: "the quick brown dog runs",
          })

          const hits = yield* repo.searchMessages({ workspaceID: WS, userID: USER, query: "quick", limit: 50 })
          return hits.messages.map((m) => m.content)
        }),
      )
      // Only the message in the caller's own group is returned; "dog runs" (foreign group) is scoped out.
      expect(result).toEqual(["the quick brown fox jumps"])
    })

    it("does not leak a foreign group even when an explicit groupId is supplied", async () => {
      const result = await run(
        Effect.gen(function* () {
          const repo = yield* IMRepository
          const theirs = yield* repo.createGroup({
            workspaceID: WS, name: "Theirs2", type: "project", createdBy: "otherUser",
          })
          yield* repo.createMessage({
            groupID: theirs.id, senderID: "otherUser", senderType: "user", type: "text",
            content: "secret plans",
          })
          const hits = yield* repo.searchMessages({
            workspaceID: WS, userID: USER, query: "secret", groupID: theirs.id, limit: 50,
          })
          return hits.messages.length
        }),
      )
      expect(result).toBe(0)
    })

    it("supports a metadata.type filter via json_extract", async () => {
      const result = await run(
        Effect.gen(function* () {
          const repo = yield* IMRepository
          const g = yield* repo.createGroup({ workspaceID: WS, name: "Meta", type: "project", createdBy: USER })
          yield* repo.createMessage({
            groupID: g.id, senderID: USER, senderType: "user", type: "code",
            content: "review function foo",
            metadata: { type: "code_ref", path: "a.ts", language: "ts" },
          })
          yield* repo.createMessage({
            groupID: g.id, senderID: USER, senderType: "user", type: "text",
            content: "review the function later",
          })
          const withMeta = yield* repo.searchMessages({
            workspaceID: WS, userID: USER, query: "review", metadataType: "code_ref", limit: 50,
          })
          const all = yield* repo.searchMessages({ workspaceID: WS, userID: USER, query: "review", limit: 50 })
          return { metaCount: withMeta.messages.length, allCount: all.messages.length }
        }),
      )
      expect(result.metaCount).toBe(1)
      expect(result.allCount).toBe(2)
    })

    // §B3 [NEW] correctness — FTS5 MATCH injection guard. The primary FTS path fed the RAW query into
    // `content MATCH ${query}`; FTS5 grammar (column filter `foo:`, prefix `*`, boolean/parens, an
    // unbalanced quote) then raised a SQLite syntax error surfacing as a 500 rather than empty results.
    // These queries must ALL resolve to results-or-empty and never throw.
    it("does not throw on FTS5-grammar / malformed queries (injection guard)", async () => {
      const hostile = ['foo:', '"unbalanced', "foo*", "(paren", "^caret", "AND", "NEAR", 'a"b', "   ", "NOT bar"]
      const result = await run(
        Effect.gen(function* () {
          const repo = yield* IMRepository
          const g = yield* repo.createGroup({ workspaceID: WS, name: "Fts", type: "project", createdBy: USER })
          yield* repo.createMessage({
            groupID: g.id, senderID: USER, senderType: "user", type: "text",
            content: "hello world foo bar",
          })
          const counts: number[] = []
          for (const q of hostile) {
            // must not throw — returns results-or-empty
            const hits = yield* repo.searchMessages({ workspaceID: WS, userID: USER, query: q, limit: 50 })
            counts.push(hits.messages.length)
          }
          return counts
        }),
      )
      // No throw ⇒ we get a count array back; each entry is a valid (non-negative) result count.
      expect(result.length).toBe(hostile.length)
      expect(result.every((n) => n >= 0)).toBe(true)
    })

    it("still matches a normal query after escaping, and preserves membership scoping on the FTS path", async () => {
      const result = await run(
        Effect.gen(function* () {
          const repo = yield* IMRepository
          const mine = yield* repo.createGroup({ workspaceID: WS, name: "FtsMine", type: "project", createdBy: USER })
          yield* repo.createMessage({
            groupID: mine.id, senderID: USER, senderType: "user", type: "text",
            content: "escaping keeps ordinary words matchable",
          })
          const theirs = yield* repo.createGroup({
            workspaceID: WS, name: "FtsTheirs", type: "project", createdBy: "otherUser",
          })
          yield* repo.createMessage({
            groupID: theirs.id, senderID: "otherUser", senderType: "user", type: "text",
            content: "matchable but foreign",
          })
          // multi-term query exercises the term-AND escaping (both terms quoted, implicit AND).
          const hits = yield* repo.searchMessages({ workspaceID: WS, userID: USER, query: "ordinary matchable", limit: 50 })
          return hits.messages.map((m) => m.content)
        }),
      )
      // Only the caller's own group message matches; the foreign "matchable" row is scoped out on the FTS path.
      expect(result).toEqual(["escaping keeps ordinary words matchable"])
    })
  })

  // ── ATTACHMENTS ─────────────────────────────────────────────────────────────────────────────────
  describe("attachments", () => {
    it("creates a message-decoupled attachment and lists it by workspace, group, and message", async () => {
      const result = await run(
        Effect.gen(function* () {
          const repo = yield* IMRepository
          const g = yield* repo.createGroup({ workspaceID: WS, name: "Files", type: "project", createdBy: USER })
          // Decoupled: no message id.
          const standalone = yield* repo.createAttachment({
            workspaceID: WS,
            groupID: g.id,
            uploadedBy: USER,
            storagePath: "/data/im-attachments/ws/ima_x",
            filename: "notes.txt",
            mime: "text/plain",
            sizeBytes: 12,
            checksum: "abc123",
          })
          // Bound to a message.
          const msg = yield* repo.createMessage({
            groupID: g.id, senderID: USER, senderType: "user", type: "file", content: "see attached",
          })
          const bound = yield* repo.createAttachment({
            workspaceID: WS,
            groupID: g.id,
            messageID: msg.id,
            uploadedBy: USER,
            storagePath: "/data/im-attachments/ws/ima_y",
            filename: "report.pdf",
            mime: "application/pdf",
            sizeBytes: 2048,
            checksum: "def456",
          })

          const byWorkspace = yield* repo.listAttachments({ workspaceID: WS, groupID: g.id, limit: 50 })
          const byMessage = yield* repo.listAttachments({ workspaceID: WS, messageID: msg.id, limit: 50 })
          const fetched = yield* repo.getAttachment(standalone.id)
          return { standalone, bound, byWorkspace, byMessage, fetched }
        }),
      )
      expect(result.standalone.messageID).toBeNull()
      expect(result.standalone.checksum).toBe("abc123")
      expect(result.bound.messageID).not.toBeNull()
      expect(result.byWorkspace.length).toBe(2)
      expect(result.byMessage.map((a) => a.filename)).toEqual(["report.pdf"])
      expect(result.fetched?.id).toBe(result.standalone.id)
    })
  })
})
