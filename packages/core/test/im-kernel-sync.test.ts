import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { IMRepository, IMRepositoryLive } from "../src/im/repository"
import { KernelDelivery } from "../src/im/kernel-delivery"
import { Database } from "../src/database/database"

// JuggleIM B1 kernel-sync persistence: im_messages.kernel_msg_id (dedup identity), im_groups
// .kernel_conv_id (conversation binding), im_sync_cursors (per-conversation high-water marks).
const migrationID = "20261005005816_im_kernel_sync"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const runMigration = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

describe("im_kernel_sync migration", () => {
  test("is registered once before later authority migrations", () => {
    expect(migrations.filter((migration) => migration.id === migrationID)).toHaveLength(1)
  })

  test("upgrades an old-lineage database: new columns/table appear, pre-existing rows survive", async () => {
    await runMigration(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(`PRAGMA foreign_keys = ON`)
        const prior = migrations.slice(0, migrations.findIndex((migration) => migration.id === migrationID))
        const kernel = migrations.find((migration) => migration.id === migrationID)
        expect(kernel).toBeDefined()
        yield* DatabaseMigration.applyOnly(db, prior)

        // Rows written under the OLD schema (no kernel columns).
        yield* db.run(`
          INSERT INTO im_groups (id, workspace_id, project_id, type, name, created_by, created_at, updated_at, deleted_at)
          VALUES ('img_legacy', 'ws_legacy', NULL, 'project', 'Legacy', 'user_1', 1, 1, NULL)
        `)
        yield* db.run(`
          INSERT INTO im_messages (id, group_id, sender_id, sender_type, type, content, created_at, updated_at)
          VALUES ('imm_legacy', 'img_legacy', 'user_1', 'user', 'text', 'old content', 1, 1)
        `)

        yield* DatabaseMigration.applyOnly(db, [kernel!])

        const groupColumns = (yield* db.all<{ name: string }>(`PRAGMA table_info('im_groups')`)).map((c) => c.name)
        const messageColumns = (yield* db.all<{ name: string }>(`PRAGMA table_info('im_messages')`)).map((c) => c.name)
        expect(groupColumns).toContain("kernel_conv_id")
        expect(messageColumns).toContain("kernel_msg_id")
        expect(yield* db.get(`SELECT count(*) AS count FROM im_sync_cursors`)).toEqual({ count: 0 })

        const group = yield* db.get<{ kernel_conv_id: string | null }>(
          `SELECT kernel_conv_id FROM im_groups WHERE id = 'img_legacy'`,
        )
        const message = yield* db.get<{ kernel_msg_id: string | null; content: string }>(
          `SELECT kernel_msg_id, content FROM im_messages WHERE id = 'imm_legacy'`,
        )
        expect(group?.kernel_conv_id).toBe(null)
        expect(message?.kernel_msg_id).toBe(null)
        expect(message?.content).toBe("old content")
      }),
    )
  })

  test("unique indexes allow any number of NULLs but reject duplicate kernel identities", async () => {
    await runMigration(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(`PRAGMA foreign_keys = ON`)
        yield* DatabaseMigration.apply(db)

        for (const id of ["img_a", "img_b", "img_c"]) {
          yield* db.run(`
            INSERT INTO im_groups (id, workspace_id, project_id, type, name, created_by, created_at, updated_at, deleted_at)
            VALUES ('${id}', 'ws', NULL, 'project', '${id}', 'user_1', 1, 1, NULL)
          `)
        }
        // Many unbound (NULL) groups coexist…
        expect(yield* db.get(`SELECT count(*) AS count FROM im_groups WHERE kernel_conv_id IS NULL`)).toEqual({
          count: 3,
        })
        // …but one kernel conversation binds exactly one group.
        yield* db.run(`UPDATE im_groups SET kernel_conv_id = 'k:2:grp_1' WHERE id = 'img_a'`)
        const dupConv = yield* db
          .run(`UPDATE im_groups SET kernel_conv_id = 'k:2:grp_1' WHERE id = 'img_b'`)
          .pipe(Effect.exit)
        expect(dupConv._tag).toBe("Failure")

        for (const id of ["imm_a", "imm_b"]) {
          yield* db.run(`
            INSERT INTO im_messages (id, group_id, sender_id, sender_type, type, content, created_at, updated_at)
            VALUES ('${id}', 'img_a', 'user_1', 'user', 'text', '${id}', 1, 1)
          `)
        }
        expect(yield* db.get(`SELECT count(*) AS count FROM im_messages WHERE kernel_msg_id IS NULL`)).toEqual({
          count: 2,
        })
        yield* db.run(`UPDATE im_messages SET kernel_msg_id = 'kmsg_1' WHERE id = 'imm_a'`)
        const dupMsg = yield* db
          .run(`UPDATE im_messages SET kernel_msg_id = 'kmsg_1' WHERE id = 'imm_b'`)
          .pipe(Effect.exit)
        expect(dupMsg._tag).toBe("Failure")
      }),
    )
  })
})

// ── Repository kernel methods ────────────────────────────────────────────────────────────────────

const databaseLayer = Database.layerFromPath(":memory:")
const testLayer = Layer.provideMerge(IMRepositoryLive, databaseLayer)
type TestServices = Layer.Success<typeof testLayer>

const run = <A, E>(effect: Effect.Effect<A, E, TestServices | Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(testLayer)))

const makeGroup = (name: string) =>
  Effect.gen(function* () {
    const repo = yield* IMRepository
    return yield* repo.createGroup({ workspaceID: "ws_kernel", type: "project", name, createdBy: "user_local" })
  })

describe("IMRepository kernel sync (B1)", () => {
  test("bindKernelConversation + getGroupByKernelConvID roundtrip; unbind with null", async () => {
    await run(
      Effect.gen(function* () {
        const group = yield* makeGroup("kernel-bound")
        const repo = yield* IMRepository

        expect(yield* repo.getGroupByKernelConvID("k:2:grp_42")).toBeUndefined()
        yield* repo.bindKernelConversation({ groupID: group.id, kernelConvID: "k:2:grp_42" })

        const bound = yield* repo.getGroupByKernelConvID("k:2:grp_42")
        expect(bound?.id).toBe(group.id)
        expect(bound?.kernelConvID).toBe("k:2:grp_42")
        // A legacy binding has no authenticated reader projection; storage identity alone
        // cannot make a remote conversation visible through the user-facing repository.
        expect(yield* repo.getGroup({ groupID: group.id, userID: "user_local" }).pipe(Effect.flip))
          .toMatchObject({ code: "reader_legacy_unverified" })

        yield* repo.bindKernelConversation({ groupID: group.id, kernelConvID: null })
        expect(yield* repo.getGroupByKernelConvID("k:2:grp_42")).toBeUndefined()
      }),
    )
  })

  test("a second group cannot bind an already-bound kernel conversation (unique index)", async () => {
    await run(
      Effect.gen(function* () {
        const a = yield* makeGroup("a")
        const b = yield* makeGroup("b")
        const repo = yield* IMRepository
        yield* repo.bindKernelConversation({ groupID: a.id, kernelConvID: "k:1:peer_9" })
        const dup = yield* repo
          .bindKernelConversation({ groupID: b.id, kernelConvID: "k:1:peer_9" })
          .pipe(Effect.exit)
        expect(dup._tag).toBe("Failure")
      }),
    )
  })

  test("createMessage honors kernelMsgID + createdAt; the kernel id is the dedup identity", async () => {
    await run(
      Effect.gen(function* () {
        const group = yield* makeGroup("dedup")
        const repo = yield* IMRepository

        const message = yield* repo.createMessage({
          groupID: group.id,
          senderID: "kernel_user_7",
          senderType: "user",
          type: "text",
          content: "inbound from kernel",
          kernelMsgID: "kmsg_100",
          createdAt: 1_700_000_000_000,
        })
        expect(message.kernelMsgID).toBe("kmsg_100")
        expect(message.createdAt).toBe(1_700_000_000_000)

        const found = yield* repo.getMessageByKernelMsgID("kmsg_100")
        expect(found?.id).toBe(message.id)
        expect(yield* repo.getMessageByKernelMsgID("kmsg_absent")).toBeUndefined()

        // The unique index is the backstop: a second row with the same kernel id is refused.
        const dup = yield* repo
          .createMessage({
            groupID: group.id,
            senderID: "kernel_user_7",
            senderType: "user",
            type: "text",
            content: "redelivery",
            kernelMsgID: "kmsg_100",
          })
          .pipe(Effect.exit)
        expect(dup._tag).toBe("Failure")
      }),
    )
  })

  test("setMessageKernelMsgID writes the ack back exactly once", async () => {
    await run(
      Effect.gen(function* () {
        const group = yield* makeGroup("ack")
        const repo = yield* IMRepository
        const message = yield* repo.createMessage({
          groupID: group.id,
          senderID: "user_local",
          senderType: "user",
          type: "text",
          content: "outbound",
        })
        expect(message.kernelMsgID).toBe(null)

        expect(yield* repo.setMessageKernelMsgID({ messageID: message.id, kernelMsgID: "kmsg_200" })).toBe(true)
        expect((yield* repo.getMessageByKernelMsgID("kmsg_200"))?.id).toBe(message.id)
        expect(yield* repo.getMessage(message.id).pipe(Effect.flip)).toMatchObject({ code: "reader_legacy_unverified" })
        // Already acked: a second write (echo/redrive) is a no-op.
        expect(yield* repo.setMessageKernelMsgID({ messageID: message.id, kernelMsgID: "kmsg_201" })).toBe(false)
        expect((yield* repo.getMessageByKernelMsgID("kmsg_200"))?.id).toBe(message.id)
        expect(yield* repo.getMessageByKernelMsgID("kmsg_201")).toBeUndefined()
        expect(yield* repo.setMessageKernelMsgID({ messageID: "imm_missing", kernelMsgID: "kmsg_x" })).toBe(false)
      }),
    )
  })

  test("listPendingKernelMessages requires a current prepared receipt, excluding raw unacked rows", async () => {
    await run(
      Effect.gen(function* () {
        const bound = yield* makeGroup("bound")
        const unbound = yield* makeGroup("unbound")
        const repo = yield* IMRepository
        yield* repo.bindKernelConversation({ groupID: bound.id, kernelConvID: "k:2:grp_pending" })
        const runtime = KernelDelivery.runtime({ realm: "http://127.0.0.1:9/", appkey: "fixture", orgID: 1,
          senderID: "user_local", credentialFingerprint: "a".repeat(64) })
        const now = Date.now()

        const pendingUser = yield* KernelDelivery.withCreation(runtime, bound.id, repo.createMessage({
          groupID: bound.id, senderID: "user_local", senderType: "user", type: "text", content: "u1", createdAt: now,
        }))
        const pendingAgent = yield* KernelDelivery.withCreation(runtime, bound.id, repo.createMessage({
          groupID: bound.id, senderID: "auto", senderType: "agent", type: "text", content: "a1", createdAt: now - 1,
        }))
        // Excluded: already-acked rows, inbound rows (kernel id set), non-text, system rows, unbound groups.
        yield* repo.createMessage({
          groupID: bound.id, senderID: "user_local", senderType: "user", type: "text", content: "acked",
          kernelMsgID: "kmsg_9", createdAt: 3,
        })
        yield* repo.createMessage({
          groupID: bound.id, senderID: "user_local", senderType: "user", type: "code", content: "code", createdAt: 4,
        })
        yield* repo.createMessage({
          groupID: bound.id, senderID: "system", senderType: "system", type: "system", content: "sys", createdAt: 5,
        })
        yield* repo.createMessage({
          groupID: unbound.id, senderID: "user_local", senderType: "user", type: "text", content: "local only", createdAt: 6,
        })

        expect(yield* repo.listPendingKernelMessages({ limit: 50 })).toEqual([])
        const pending = yield* repo.listPendingKernelMessages({ limit: 50, runtime })
        expect(pending.map((row) => row.message.id)).toEqual([pendingAgent.id, pendingUser.id])
        expect(pending.map((row) => row.kernelConvID)).toEqual(["k:2:grp_pending", "k:2:grp_pending"])

        // listKernelBoundGroups: only the bound group, unbound/deleted excluded.
        const boundGroups = yield* repo.listKernelBoundGroups
        expect(boundGroups.map((g) => g.id)).toEqual([bound.id])
        expect(boundGroups[0]?.kernelConvID).toBe("k:2:grp_pending")
      }),
    )
  })

  test("upsertSyncCursor only advances the watermark", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* IMRepository
        expect(yield* repo.getSyncCursor("k:2:grp_1")).toBeUndefined()

        yield* repo.upsertSyncCursor({ conversationID: "k:2:grp_1", lastSyncTime: 100, lastSyncSeq: 7 })
        expect(yield* repo.getSyncCursor("k:2:grp_1")).toMatchObject({
          conversationID: "k:2:grp_1",
          lastSyncTime: 100,
          lastSyncSeq: 7,
        })

        // Late/out-of-order redelivery never regresses time; a provided seq wins, omitted seq keeps.
        yield* repo.upsertSyncCursor({ conversationID: "k:2:grp_1", lastSyncTime: 50 })
        expect((yield* repo.getSyncCursor("k:2:grp_1"))?.lastSyncTime).toBe(100)
        expect((yield* repo.getSyncCursor("k:2:grp_1"))?.lastSyncSeq).toBe(7)

        yield* repo.upsertSyncCursor({ conversationID: "k:2:grp_1", lastSyncTime: 150, lastSyncSeq: 9 })
        expect((yield* repo.getSyncCursor("k:2:grp_1"))?.lastSyncTime).toBe(150)
        expect((yield* repo.getSyncCursor("k:2:grp_1"))?.lastSyncSeq).toBe(9)
      }),
    )
  })
})
