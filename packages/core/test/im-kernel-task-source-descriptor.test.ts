import { expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "../src/database/database"
import { KernelReader } from "../src/im/kernel-reader"
import { KernelReaderSchema } from "../src/im/kernel-reader.schema"

// Controlled Core producer boundary. The production native caller is exercised
// separately by kernel-task-source-witness.test.ts through the original SDK.
const fixture = (live: boolean) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const source = {
      realm: "http://127.0.0.1:9/",
      appkey: "descriptor",
      orgID: 1,
      senderID: "receiver",
      credentialFingerprint: "c".repeat(64),
    }
    const now = Date.now()
    const scopeKey = "a".repeat(64)
    const projectionKey = "b".repeat(64)
    const message = {
      effectKey: "d".repeat(64),
      messageId: "original-native",
      sequence: "9007199254740993",
      deliveryCursor: "1",
      messageTime: now,
      expiresAt: now + 86_400_000,
      senderId: "sender",
      targetId: "sender",
      conversationType: 1 as const,
      content: '{"content":"immutable 中文"}',
      isSend: false,
      isRead: false,
    }
    const handle = Object.freeze({})
    const runtime = KernelReader.attach({
      db,
      workspaceID: "descriptor-workspace",
      userID: "server",
      source,
      current: () => Effect.succeed(true),
      inspect: () => Effect.succeed({ name: "Sender" }),
      readCut: () => Effect.fail(KernelReaderSchema.failure("reader_unavailable", "unused")),
      liveObservation: (original) =>
        original === handle
          ? {
              scopeKey,
              projectionKey,
              projectionRevision: "1",
              sourceHash: KernelReader.hash(source),
              receiverID: "receiver",
              transportGeneration: 1,
              receivedAt: now,
              messageID: message.messageId,
              sequence: message.sequence,
              messageTime: now,
              senderID: "sender",
              conversationType: 1,
              conversationID: "sender",
              wireContent: message.content,
            }
          : undefined,
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => KernelReader.close(runtime)))
    yield* KernelReader.bind(runtime, scopeKey)
    yield* KernelReader.ensureScope(runtime)
    yield* KernelReader.applyChanges(runtime, {
      version: 1,
      scopeKey,
      after: "0",
      upper: "1",
      scanCursor: "1",
      scanProjectionKey: projectionKey,
      pageToken: "",
      windowComplete: true,
      caughtUp: true,
      serverNow: now,
      items: [
        {
          visibility: "visible",
          projectionKey,
          revision: "1",
          cursor: "1",
          conversationType: 1,
          targetId: "sender",
          readOrdinal: "0",
          admittedOrdinal: "1",
          liveUnread: "1",
          storedUnread: "1",
          latestMessageId: message.messageId,
          latestSequence: message.sequence,
          latestMessageTime: now,
          nextExpiryAt: message.expiresAt,
        },
      ],
    })
    yield* KernelReader.applyMessages(
      runtime,
      {
        version: 1,
        scopeKey,
        projectionKey,
        projectionRevision: "1",
        direction: "newer",
        nextDeliveryCursor: "1",
        finished: true,
        serverNow: now,
        items: [message],
      },
      undefined,
      live ? handle : undefined,
    )
    const row = (yield* db.get<{ local_message_id: string; metadata: string }>(
      sql`SELECT local_message_id,metadata FROM im_kernel_reader_message`,
    ))!
    const snapshot = () =>
      Effect.gen(function* () {
        return {
          messages: yield* db.all(sql`SELECT * FROM im_kernel_reader_message`),
          scope: yield* db.all(sql`SELECT * FROM im_kernel_reader_scope`),
          projections: yield* db.all(sql`SELECT * FROM im_kernel_reader_projection`),
          meter: yield* db.all(sql`SELECT * FROM im_kernel_reader_meter`),
        }
      })
    return { db, source, scopeKey, runtime, row, message, snapshot }
  })
async function isolated<A, E>(body: Effect.Effect<A, E, Database.Service | import("effect").Scope.Scope>) {
  const directory = await mkdtemp(join(tmpdir(), "dac-task-source-descriptor-"))
  try {
    return await Effect.runPromise(
      body.pipe(Effect.provide(Database.layerFromPath(join(directory, "reader.sqlite"))), Effect.scoped),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("original exact retained descriptor is read only and keeps native decimal identity and provenance", () =>
  isolated(
    Effect.gen(function* () {
      const s = yield* fixture(true)
      const before = yield* s.snapshot()
      const descriptor = yield* KernelReader.taskSourceDescriptor(s.runtime, s.row.local_message_id)
      expect(descriptor).toMatchObject({
        workspaceID: "descriptor-workspace",
        localUserID: "server",
        senderID: "sender",
        receiverID: "receiver",
        sequence: "9007199254740993",
        nativeMessageID: "original-native",
        rawContent: s.message.content,
        firstSeen: { origin: "kernel_live", sourceHash: KernelReader.hash(s.source) },
      })
      expect(yield* s.snapshot()).toEqual(before)
      expect(yield* KernelReader.taskSourceDescriptor(s.runtime, "missing-message").pipe(Effect.flip)).toMatchObject({
        code: "reader_unavailable",
      })
    }),
  ))

test("history retained source cannot become a current descriptor", () =>
  isolated(
    Effect.gen(function* () {
      const s = yield* fixture(false)
      const before = yield* s.snapshot()
      expect(
        yield* KernelReader.taskSourceDescriptor(s.runtime, s.row.local_message_id).pipe(Effect.flip),
      ).toMatchObject({ code: "reader_unavailable" })
      expect(yield* s.snapshot()).toEqual(before)
    }),
  ))

for (const scenario of ["foreign-workspace", "credential-rotation", "retired-owner"] as const)
  test(`descriptor rejects ${scenario} without changing retained rows`, () =>
    isolated(
      Effect.gen(function* () {
        const s = yield* fixture(true)
        const other = KernelReader.attach({
          db: s.db,
          workspaceID: scenario === "foreign-workspace" ? "foreign-workspace" : "descriptor-workspace",
          userID: "server",
          source:
            scenario === "credential-rotation" ? { ...s.source, credentialFingerprint: "e".repeat(64) } : s.source,
          current: () => Effect.succeed(true),
          inspect: () => Effect.succeed({ name: "Sender" }),
          readCut: () => Effect.fail(KernelReaderSchema.failure("reader_unavailable", "unused")),
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => KernelReader.close(other)))
        yield* KernelReader.bind(other, s.scopeKey)
        if (scenario === "retired-owner") KernelReader.close(other)
        const before = yield* s.snapshot()
        expect(yield* KernelReader.taskSourceDescriptor(other, s.row.local_message_id).pipe(Effect.flip)).toMatchObject(
          { code: "reader_unavailable" },
        )
        expect(yield* s.snapshot()).toEqual(before)
      }),
    ))

test("local body replacement cannot retain the immutable native descriptor", () =>
  isolated(
    Effect.gen(function* () {
      const s = yield* fixture(true)
      yield* s.db.run(sql`UPDATE im_messages SET content='replacement' WHERE id=${s.row.local_message_id}`)
      const before = yield* s.snapshot()
      expect(
        yield* KernelReader.taskSourceDescriptor(s.runtime, s.row.local_message_id).pipe(Effect.flip),
      ).toMatchObject({ code: "reader_unavailable" })
      expect(yield* s.snapshot()).toEqual(before)
    }),
  ))
