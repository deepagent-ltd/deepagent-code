import { expect, test } from "bun:test"
import { Effect, Scope } from "effect"
import { sql } from "drizzle-orm"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "../src/database/database"
import { groupPageCandidates } from "../src/im/repository"
import { KernelReader } from "../src/im/kernel-reader"
import { KernelReaderSchema } from "../src/im/kernel-reader.schema"

const source = { realm: "http://127.0.0.1:9/", appkey: "empty-page", orgID: 1, senderID: "alice", credentialFingerprint: "c".repeat(64) }
const context = { workspaceID: "workspace", userID: "server", groupIDs: [] }
const fixture = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const permission = { current: true }
  const runtime = KernelReader.attach({ db, workspaceID: context.workspaceID, userID: context.userID, source,
    current: () => Effect.sync(() => permission.current),
    inspect: () => Effect.fail(KernelReaderSchema.failure("reader_mapping_conflict", "unexpected-inspect")),
    readCut: () => Effect.fail(KernelReaderSchema.failure("reader_mapping_conflict", "unexpected-cut")) })
  yield* Effect.addFinalizer(() => Effect.sync(() => KernelReader.close(runtime)))
  yield* KernelReader.bind(runtime, "a".repeat(64), 2)
  const scope = yield* KernelReader.ensureScope(runtime)
  return { db, runtime, permission, scope }
})
async function isolated<A, E>(effect: Effect.Effect<A, E, Database.Service | Scope.Scope>) {
  const directory = await mkdtemp(join(tmpdir(), "dac-reader-empty-page-"))
  try {
    return await Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromPath(join(directory, "reader.sqlite"))), Effect.scoped))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("current empty protected group page returns the original scoped proof without granting a group", () => isolated(Effect.gen(function* () {
  const s = yield* fixture
  const before = yield* s.db.get(sql`SELECT * FROM im_kernel_reader_meter`)
  const identity = yield* KernelReader.pageIdentity(s.runtime, context)
  const candidates = yield* groupPageCandidates(s.db, { workspaceID: context.workspaceID, userID: context.userID,
    lane: "protected", readerKey: identity.readerKey, limit: 2 })
  expect(candidates.rows).toEqual([])
  const result = yield* KernelReader.withOutput(s.runtime, context, KernelReader.groupPageState(s.db))
  expect(result).toMatchObject({ displayEpoch: s.runtime.displayEpoch, nextExpiryAt: null })
  expect(result?.proofWindowMs).toBeGreaterThanOrEqual(999)
  expect(result?.proofWindowMs).toBeLessThanOrEqual(1000)
  expect(KernelReaderSchema.encode(KernelReaderSchema.GroupPageReader, result, 4096)).toContain(s.runtime.displayEpoch)
  const repeated = yield* KernelReader.withOutput(s.runtime, context, KernelReader.groupPageState(s.db))
  expect(repeated).toMatchObject({ displayEpoch: s.runtime.displayEpoch, nextExpiryAt: null })
  expect(repeated?.proofWindowMs).toBeGreaterThanOrEqual(999)
  expect(repeated?.proofWindowMs).toBeLessThanOrEqual(1000)
  expect(yield* KernelReader.groupPageState(s.db)).toBeUndefined()
  expect(yield* s.db.get(sql`SELECT * FROM im_kernel_reader_meter`)).toEqual(before)
  expect((yield* s.db.get<{ count: number }>(sql`SELECT count(*) count FROM im_kernel_reader_projection`))?.count).toBe(0)
})))

test("empty proof refuses foreign missing changed and expired custody and checks the return boundary", () => isolated(Effect.gen(function* () {
  const s = yield* fixture
  expect(yield* KernelReader.withOutput({ ...s.runtime }, context, KernelReader.groupPageState(s.db))).toBeUndefined()
  expect(yield* KernelReader.withOutput(s.runtime, { ...context, userID: "foreign" }, KernelReader.groupPageState(s.db))).toBeUndefined()
  expect(yield* KernelReader.withOutput(s.runtime, { ...context, workspaceID: "foreign" }, KernelReader.groupPageState(s.db))).toBeUndefined()
  expect(yield* KernelReader.withOutput(s.runtime, context, Effect.gen(function* () {
    s.permission.current = false
    return yield* KernelReader.groupPageState(s.db)
  })).pipe(Effect.flip)).toMatchObject({ code: "reader_unavailable" })
  s.permission.current = true
  expect(yield* KernelReader.withOutput(s.runtime, context, Effect.gen(function* () {
    const proof = yield* KernelReader.groupPageState(s.db)
    s.permission.current = false
    return proof
  })).pipe(Effect.flip)).toMatchObject({ code: "reader_unavailable" })
  s.permission.current = true
  expect(yield* KernelReader.withOutput(s.runtime, context, Effect.gen(function* () {
    const proof = yield* KernelReader.groupPageState(s.db)
    yield* Effect.sleep("1010 millis")
    return proof
  })).pipe(Effect.flip)).toMatchObject({ code: "reader_stale", operation: "output-deadline" })
  expect(yield* KernelReader.withOutput(s.runtime, context, Effect.gen(function* () {
    const proof = yield* KernelReader.groupPageState(s.db)
    yield* s.db.run(sql`DELETE FROM im_kernel_reader_scope WHERE reader_key=${s.scope.reader_key}`)
    return proof
  })).pipe(Effect.flip)).toMatchObject({ code: "reader_scope_mismatch", operation: "group-page" })
  expect(yield* KernelReader.withOutput(s.runtime, context, KernelReader.groupPageState(s.db)).pipe(Effect.flip))
    .toMatchObject({ code: "reader_scope_mismatch", operation: "group-page" })
  // No page proof was requested: the existing ordinary read does not gain a new scope gate.
  expect(yield* KernelReader.withOutput(s.runtime, context, Effect.succeed("ordinary read"))).toBe("ordinary read")
  KernelReader.close(s.runtime)
  expect(yield* KernelReader.withOutput(s.runtime, context, KernelReader.groupPageState(s.db))).toBeUndefined()
})))
