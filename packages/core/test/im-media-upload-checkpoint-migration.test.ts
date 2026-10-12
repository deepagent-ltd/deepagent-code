import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect, Exit, Layer, Scope } from "effect"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"
import { IMRepository, IMRepositoryLive, clientMessageID } from "../src/im/repository"
import { KernelDelivery } from "../src/im/kernel-delivery"
import { KernelReader } from "../src/im/kernel-reader"
import { MediaUploadCheckpoint } from "../src/im/media-upload-checkpoint"
import { MediaUploadCheckpointMigrationFixture } from "./fixture/im-media-upload-checkpoint-migration"

const boundary = migrations.findIndex((entry) => entry.id === "20261010061146_im_media_upload_checkpoint")
const selected = migrations.slice(0, boundary + 1)
const previous = selected.slice(0, -1)
const migration = selected[boundary]!
const source = { realm: "http://127.0.0.1:9/", appkey: "checkpoint-中文🙂", orgID: 1,
  senderID: "kernel-alice", credentialFingerprint: "a".repeat(64) }
const userID = "server"
const omitted = ["migration", "im_media_upload_meter", "im_media_upload_checkpoint"]

const audit = (db: MediaUploadCheckpointMigrationFixture.Db) => Effect.gen(function* () {
  const rows = yield* db.all<MediaUploadCheckpointMigrationFixture.RawRow>("SELECT * FROM im_media_upload_checkpoint ORDER BY attachment_id")
  const meter = (yield* db.get<MediaUploadCheckpointMigrationFixture.RawRow>("SELECT * FROM im_media_upload_meter"))!
  const singleton = yield* MediaUploadCheckpointMigrationFixture.rowBytes(db, "im_media_upload_meter", "meter_id", 1)
  expect(singleton).toBe(92)
  const bytes = yield* Effect.forEach(rows, (row) => Effect.gen(function* () {
    const count = 1024 + (yield* MediaUploadCheckpointMigrationFixture.rowBytes(db, "im_media_upload_checkpoint", "checkpoint_id", String(row.checkpoint_id)))
    expect(row.accounted_records).toBe(1)
    expect(row.accounted_bytes).toBe(count)
    expect(count).toBeLessThanOrEqual(65_536)
    return count
  }))
  expect(meter.used_records).toBe(1 + rows.length)
  expect(meter.used_bytes).toBe(singleton + bytes.reduce((sum, value) => sum + value, 0))
  return { rows, meter }
})

const run = <A, E>(filename: string, body: Effect.Effect<A, E, Database.Service | IMRepository | Scope.Scope>) =>
  Effect.runPromise(body.pipe(Effect.provide(Layer.provideMerge(IMRepositoryLive, Database.layerFromPath(filename))), Effect.scoped))

/** Real Core issuers/repository/SQLite; controlled current reader ports supply
 * no remote object, file, Native, provider or network authorization evidence. */
const setup = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const repo = yield* IMRepository
  const active = { value: true }
  const reader = KernelReader.attach({ db, source, workspaceID: "checkpoint-workspace", userID,
    current: () => Effect.succeed(active.value), inspect: () => Effect.succeed({ name: "verified current group" }),
    readCut: () => Effect.die("History network is outside independent migration/handoff QA") })
  const authority = KernelDelivery.runtime(source)
  yield* Effect.addFinalizer(() => Effect.sync(() => { KernelReader.close(reader); KernelDelivery.close(authority) }))
  yield* KernelReader.bind(reader, "b".repeat(64), 2)
  yield* KernelReader.ensureScope(reader)
  const group = yield* repo.createGroup({ workspaceID: "checkpoint-workspace", type: "project", name: "原群🙂", createdBy: userID })
  yield* repo.bindKernelConversation({ groupID: group.id, kernelConvID: "k:2:checkpoint-native-group" })
  const reserve = (id: string, sizeBytes: number, protectedOrigin = true) => {
    const effect = repo.createAttachment({ id, workspaceID: "checkpoint-workspace", groupID: group.id, uploadedBy: userID,
      storagePath: `/private/never-opened/checkpoint-owned/${id}`, filename: `原文件🙂 é ${sizeBytes}.txt`,
      mime: "text/plain", sizeBytes, checksum: MediaUploadCheckpointMigrationFixture.digest("x".repeat(sizeBytes)) })
    return protectedOrigin ? MediaUploadCheckpoint.withOrigin(reader, group.id, effect) : effect
  }
  const locals = yield* Effect.forEach([0, 1, 2, 3], (size, index) => reserve(`ima_checkpoint_owned_${index}`, size))
  const request = { messageID: clientMessageID(userID, "checkpoint-request"), clientRequestID: "checkpoint-request", groupID: group.id,
    senderID: userID, content: "四件原正文🙂 é <>&", attachmentIDs: locals.map((local) => local.id), batch: true }
  const input = { groupID: group.id, senderID: userID, senderType: "user" as const, type: "file" as const,
    content: request.content, clientRequestID: request.clientRequestID,
    attachments: locals.map((local) => ({ id: local.id, workspaceID: local.workspaceID })),
    metadata: locals.map((local) => ({ type: "attachment_ref" as const, attachmentID: local.id, batch: true as const })) }
  const uploaded = Effect.gen(function* () {
    yield* MediaUploadCheckpoint.plan(reader, request)
    return yield* Effect.forEach(locals, (local, index) => Effect.gen(function* () {
      const attempt = yield* MediaUploadCheckpoint.claim(reader, local.id)
      const remote = { objectID: String(index + 1).repeat(64), uploadID: attempt.plan!.uploadID,
        filename: local.filename, sizeBytes: local.sizeBytes, sha256: local.checksum,
        createdAt: local.createdAt - 1, expiresAt: local.createdAt - 1 + 86_400_000 }
      yield* MediaUploadCheckpoint.updateAttempt(reader, attempt, { bodyVerified: true, beginDispatched: true, remote,
        remoteFacts: { state: "uploaded_unbound", receivedBytes: local.sizeBytes,
          receivedChunks: Math.ceil(local.sizeBytes / 262144), progressHash: null }, phase: "uploaded", outcome: "confirmed" }, true)
      return { local, remote: { attachmentID: remote.objectID, contentRef: remote.objectID, filename: remote.filename,
        mime: "text/plain", sizeBytes: remote.sizeBytes, sha256: remote.sha256, createdAt: remote.createdAt, expiresAt: remote.expiresAt } }
    }))
  })
  return { db, repo, reader, authority, active, group, reserve, locals, request, input, uploaded }
})

test("fresh official checkpoint migration is empty, singleton92/FK-on and exact cold reapply", () => MediaUploadCheckpointMigrationFixture.isolated(async (filename) => {
  const original = await MediaUploadCheckpointMigrationFixture.open(filename, (db) => Effect.gen(function* () {
    expect(boundary).toBeGreaterThan(0)
    yield* DatabaseMigration.applyOnly(db, selected)
    expect((yield* audit(db)).rows).toEqual([])
    const refs = yield* db.all<{ on_delete: string; on_update: string }>("PRAGMA foreign_key_list(im_media_upload_checkpoint)")
    expect(refs).toHaveLength(6)
    expect(refs.every((ref) => ref.on_delete === "RESTRICT" && ref.on_update === "RESTRICT")).toBe(true)
    return yield* MediaUploadCheckpointMigrationFixture.snapshot(db)
  }))
  expect(await MediaUploadCheckpointMigrationFixture.open(filename, (db) => Effect.gen(function* () {
    yield* DatabaseMigration.applyOnly(db, selected)
    yield* audit(db)
    return yield* MediaUploadCheckpointMigrationFixture.snapshot(db)
  }))).toEqual(original)
}), 60_000)

test("previous Unicode local/protected attachments and original objects/children remain exact with no origin backfill", () => MediaUploadCheckpointMigrationFixture.isolated(async (filename) => {
  const original = await MediaUploadCheckpointMigrationFixture.open(filename, (db) => Effect.gen(function* () {
    const ids = yield* MediaUploadCheckpointMigrationFixture.seedLegacy(db, previous)
    yield* db.run("CREATE INDEX checkpoint_original_unicode_idx ON im_attachments(filename,created_at)")
    yield* db.run("CREATE TRIGGER checkpoint_original_guard BEFORE UPDATE OF storage_path ON im_attachments BEGIN SELECT RAISE(ABORT,'original immutable fixture path'); END")
    yield* db.run("CREATE VIEW checkpoint_original_view AS SELECT id,filename,mime,created_at,deleted_at FROM im_attachments")
    for (const [index, action] of ["CASCADE", "SET NULL", "SET DEFAULT"].entries()) {
      yield* db.run(`CREATE TABLE checkpoint_original_child_${index}(id INTEGER PRIMARY KEY,attachment_id TEXT DEFAULT 'ima_checkpoint_legacy_0' REFERENCES im_attachments(id) ON DELETE ${action} ON UPDATE ${action},label TEXT)`)
      yield* db.run(sql`INSERT INTO ${sql.raw(`checkpoint_original_child_${index}`)} VALUES(1,${ids[index]},${"原child🙂 é"})`)
    }
    const before = yield* MediaUploadCheckpointMigrationFixture.snapshot(db, omitted)
    yield* DatabaseMigration.applyOnly(db, selected)
    expect((yield* audit(db)).rows).toEqual([])
    expect(yield* MediaUploadCheckpointMigrationFixture.snapshot(db, omitted)).toEqual(before)
    for (const id of ids) expect(yield* MediaUploadCheckpoint.read(db, id)).toBeUndefined()
    return yield* MediaUploadCheckpointMigrationFixture.snapshot(db)
  }))
  expect(await MediaUploadCheckpointMigrationFixture.open(filename, (db) => Effect.gen(function* () {
    yield* DatabaseMigration.applyOnly(db, selected)
    return yield* MediaUploadCheckpointMigrationFixture.snapshot(db)
  }))).toEqual(original)
}), 60_000)

test("caller outer-defer is refused without clearing its setting or changing old schema/data/journal", () => MediaUploadCheckpointMigrationFixture.isolated(async (filename) => {
  await MediaUploadCheckpointMigrationFixture.open(filename, (db) => Effect.gen(function* () {
    yield* MediaUploadCheckpointMigrationFixture.seedLegacy(db, previous)
    const before = yield* MediaUploadCheckpointMigrationFixture.snapshot(db)
    yield* db.transaction((tx) => Effect.gen(function* () {
      yield* tx.run("PRAGMA defer_foreign_keys=ON")
      expect(yield* tx.get("PRAGMA defer_foreign_keys")).toEqual({ defer_foreign_keys: 1 })
      expect(Exit.isFailure(yield* Effect.exit(migration.up(tx)))).toBe(true)
      expect(yield* tx.get("PRAGMA defer_foreign_keys")).toEqual({ defer_foreign_keys: 1 })
      yield* tx.run("PRAGMA defer_foreign_keys=OFF")
    }), { behavior: "immediate" })
    expect(yield* MediaUploadCheckpointMigrationFixture.snapshot(db)).toEqual(before)
  }))
}), 60_000)

test("pre-existing FK corruption refuses new custody and preserves the exact old database", () => MediaUploadCheckpointMigrationFixture.isolated(async (filename) => {
  await MediaUploadCheckpointMigrationFixture.open(filename, (db) => Effect.gen(function* () {
    yield* MediaUploadCheckpointMigrationFixture.seedLegacy(db, previous)
    yield* db.run("CREATE TABLE checkpoint_bad_child(id INTEGER PRIMARY KEY,attachment_id TEXT REFERENCES im_attachments(id))")
    yield* db.run("PRAGMA foreign_keys=OFF")
    yield* db.run("INSERT INTO checkpoint_bad_child VALUES(1,'missing-original-attachment')")
    yield* db.run("PRAGMA foreign_keys=ON")
    const before = yield* MediaUploadCheckpointMigrationFixture.snapshot(db)
    expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, selected)))).toBe(true)
    expect(yield* MediaUploadCheckpointMigrationFixture.snapshot(db)).toEqual(before)
    expect((yield* db.all("PRAGMA foreign_key_check")).length).toBe(1)
    yield* db.run("DELETE FROM checkpoint_bad_child WHERE id=1")
  }))
}), 60_000)

test("late SQL failure after the original wrapper rolls tables, singleton and migration journal back together", () => MediaUploadCheckpointMigrationFixture.isolated(async (filename) => {
  await MediaUploadCheckpointMigrationFixture.open(filename, (db) => Effect.gen(function* () {
    yield* MediaUploadCheckpointMigrationFixture.seedLegacy(db, previous)
    const before = yield* MediaUploadCheckpointMigrationFixture.snapshot(db)
    const broken = [...previous, { ...migration, up: (tx: Parameters<DatabaseMigration.Migration["up"]>[0]) => Effect.gen(function* () {
      yield* migration.up(tx)
      return yield* tx.run("SELECT * FROM checkpoint_controlled_late_migration_failure")
    }) }]
    expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, broken)))).toBe(true)
    expect(yield* MediaUploadCheckpointMigrationFixture.snapshot(db)).toEqual(before)
  }))
}), 60_000)

test("only a genuinely new protected reservation mints origin; legacy/default retries and parent delete cannot lift custody", () => MediaUploadCheckpointMigrationFixture.isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* setup
  expect((yield* audit(s.db)).rows).toHaveLength(4)
  const legacy = yield* s.reserve("ima_checkpoint_no_origin", 1, false)
  const before = yield* MediaUploadCheckpointMigrationFixture.snapshot(s.db)
  expect((yield* s.reserve(legacy.id, 1)).id).toBe(legacy.id)
  expect(yield* MediaUploadCheckpoint.read(s.db, legacy.id)).toBeUndefined()
  expect(Exit.isFailure(yield* Effect.exit(MediaUploadCheckpoint.plan(s.reader, { ...s.request, attachmentIDs: [legacy.id], batch: false })))).toBe(true)
  expect(yield* MediaUploadCheckpointMigrationFixture.snapshot(s.db)).toEqual(before)
  const current = yield* MediaUploadCheckpointMigrationFixture.snapshot(s.db)
  expect(Exit.isFailure(yield* Effect.exit(s.db.run(sql`DELETE FROM im_attachments WHERE id=${s.locals[0]!.id}`)))).toBe(true)
  expect(Exit.isFailure(yield* Effect.exit(s.db.run(sql`DELETE FROM im_groups WHERE id=${s.group.id}`)))).toBe(true)
  expect(yield* MediaUploadCheckpointMigrationFixture.snapshot(s.db)).toEqual(current)
  s.active.value = false
  expect(Exit.isFailure(yield* Effect.exit(s.reserve("ima_checkpoint_closed_origin", 1)))).toBe(true)
  s.active.value = true
  expect(yield* s.repo.getAttachment("ima_checkpoint_closed_origin")).toBeUndefined()
}))), 60_000)

test("complete UTF8 stored origin/plan/remote copies are metered and physical budget bounds reject without mutation", () => MediaUploadCheckpointMigrationFixture.isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* setup
  const origin = yield* audit(s.db)
  yield* MediaUploadCheckpoint.plan(s.reader, s.request)
  const planned = yield* audit(s.db)
  expect(Number(planned.meter.used_bytes)).toBeGreaterThan(Number(origin.meter.used_bytes))
  yield* s.uploaded
  const uploaded = yield* audit(s.db)
  expect(Number(uploaded.meter.used_bytes)).toBeGreaterThan(Number(planned.meter.used_bytes))
  const before = yield* MediaUploadCheckpointMigrationFixture.snapshot(s.db)
  for (const statement of [
    "UPDATE im_media_upload_meter SET used_records=100001", "UPDATE im_media_upload_meter SET used_bytes=268435457",
    "UPDATE im_media_upload_meter SET used_bytes=91", "UPDATE im_media_upload_checkpoint SET accounted_bytes=65537",
  ]) expect(Exit.isFailure(yield* Effect.exit(s.db.run(statement)))).toBe(true)
  expect(yield* MediaUploadCheckpointMigrationFixture.snapshot(s.db)).toEqual(before)
}))), 60_000)

test("complete ordered first-plan conflicts and late member loss roll the whole batch and meter back", () => MediaUploadCheckpointMigrationFixture.isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* setup
  yield* s.db.run("CREATE TRIGGER checkpoint_plan_late_member AFTER UPDATE OF phase ON im_media_upload_checkpoint WHEN NEW.phase='planned' AND json_extract(NEW.record,'$.plan.index')=1 BEGIN DELETE FROM im_members WHERE group_id=NEW.group_id; END")
  const before = yield* MediaUploadCheckpointMigrationFixture.snapshot(s.db)
  expect(Exit.isFailure(yield* Effect.exit(MediaUploadCheckpoint.plan(s.reader, s.request)))).toBe(true)
  expect(yield* MediaUploadCheckpointMigrationFixture.snapshot(s.db)).toEqual(before)
  yield* s.db.run("DROP TRIGGER checkpoint_plan_late_member")
  yield* MediaUploadCheckpoint.plan(s.reader, s.request)
  const planned = yield* MediaUploadCheckpointMigrationFixture.snapshot(s.db)
  expect(Exit.isFailure(yield* Effect.exit(MediaUploadCheckpoint.plan(s.reader, { ...s.request, content: "changed caption" })))).toBe(true)
  expect(Exit.isFailure(yield* Effect.exit(MediaUploadCheckpoint.plan(s.reader, { ...s.request, attachmentIDs: [...s.request.attachmentIDs].reverse() })))).toBe(true)
  expect(yield* MediaUploadCheckpointMigrationFixture.snapshot(s.db)).toEqual(planned)
  yield* audit(s.db)
}))), 60_000)

test("handoff refuses incomplete remote custody and changed planned caption before deleting any checkpoint", () => MediaUploadCheckpointMigrationFixture.isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* setup
  const attempts = yield* s.uploaded
  const capture = { messageID: s.request.messageID, groupID: s.group.id, senderID: userID, content: s.request.content, attachments: attempts }
  const before = yield* MediaUploadCheckpointMigrationFixture.snapshot(s.db)
  const changed = { ...s.input, content: "changed caption after upload" }
  expect(Exit.isFailure(yield* Effect.exit(KernelDelivery.withMediaCreation(s.authority,
    { ...capture, content: changed.content }, s.repo.createMessage(changed))))).toBe(true)
  expect(yield* MediaUploadCheckpointMigrationFixture.snapshot(s.db)).toEqual(before)
  expect(Exit.isFailure(yield* Effect.exit(KernelDelivery.withMediaCreation(s.authority,
    { ...capture, attachments: attempts.slice(0, -1) }, s.repo.createMessage({ ...s.input,
      attachments: s.input.attachments.slice(0, -1), metadata: s.input.metadata.slice(0, -1) }))))).toBe(true)
  expect(yield* MediaUploadCheckpointMigrationFixture.snapshot(s.db)).toEqual(before)
  yield* audit(s.db)
}))), 60_000)

test("real receipt/media custody atomically replaces all four checkpoint copies, exact retry and cold remain original", () => MediaUploadCheckpointMigrationFixture.isolated(async (filename) => {
  const original = await run(filename, Effect.gen(function* () {
    const s = yield* setup
    const attachments = yield* s.uploaded
    const capture = { messageID: s.request.messageID, groupID: s.group.id, senderID: userID, content: s.request.content, attachments }
    const create = () => KernelDelivery.withMediaCreation(s.authority, capture, s.repo.createMessage(s.input))
    const message = yield* create()
    expect(message.id).toBe(s.request.messageID)
    expect(message.replayed).toBe(false)
    expect((yield* audit(s.db)).rows).toEqual([])
    expect(yield* s.db.get("SELECT count(*) total FROM im_kernel_media_body")).toEqual({ total: 1 })
    expect((yield* KernelDelivery.history(s.db, message.id)).kind).toBe("live")
    const before = yield* MediaUploadCheckpointMigrationFixture.snapshot(s.db)
    expect((yield* create()).replayed).toBe(true)
    expect(yield* MediaUploadCheckpointMigrationFixture.snapshot(s.db)).toEqual(before)
    expect(Exit.isFailure(yield* Effect.exit(MediaUploadCheckpoint.plan(s.reader, s.request)))).toBe(true)
    expect(yield* MediaUploadCheckpointMigrationFixture.snapshot(s.db)).toEqual(before)
    return { messageID: message.id, snapshot: before }
  }))
  await MediaUploadCheckpointMigrationFixture.open(filename, (db) => Effect.gen(function* () {
    yield* DatabaseMigration.applyOnly(db, selected)
    expect(yield* MediaUploadCheckpointMigrationFixture.snapshot(db)).toEqual(original.snapshot)
    expect((yield* KernelDelivery.history(db, original.messageID)).kind).toBe("live")
    expect((yield* audit(db)).rows).toEqual([])
  }))
}), 60_000)

test("late SQL fault during handoff restores original checkpoint, meter, Message/receipt and attachment bindings together", () => MediaUploadCheckpointMigrationFixture.isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* setup
  const attachments = yield* s.uploaded
  yield* s.db.run("CREATE TRIGGER checkpoint_handoff_late_fault AFTER DELETE ON im_media_upload_checkpoint BEGIN SELECT RAISE(ABORT,'controlled handoff fault'); END")
  const before = yield* MediaUploadCheckpointMigrationFixture.snapshot(s.db)
  expect(Exit.isFailure(yield* Effect.exit(KernelDelivery.withMediaCreation(s.authority,
    { messageID: s.request.messageID, groupID: s.group.id, senderID: userID, content: s.request.content, attachments }, s.repo.createMessage(s.input))))).toBe(true)
  expect(yield* MediaUploadCheckpointMigrationFixture.snapshot(s.db)).toEqual(before)
  expect(yield* s.repo.getMessage(s.request.messageID)).toBeUndefined()
  expect(yield* s.db.get("SELECT count(*) total FROM im_kernel_media_body")).toEqual({ total: 0 })
  expect((yield* audit(s.db)).rows).toHaveLength(4)
}))), 60_000)
