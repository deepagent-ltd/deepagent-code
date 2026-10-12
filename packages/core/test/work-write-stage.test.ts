import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { WorkWriteStage } from "../src/session/work-write-stage"

// Optional actual signed-run artifact. This tests factual custody transitions only;
// the original native process, permission and publication are exercised by the host test.
const source = process.env.DAC_WORK_WRITE_STAGE_DB
const releasedSources = process.env.DAC_WORK_WRITE_RELEASED_DBS?.split(",") ?? []
const unknownSource = process.env.DAC_WORK_WRITE_UNKNOWN_DB
test.skipIf(!source)("actual native terminal custody observes growth and releases once, preserving its audit row", async () => {
  if (!source) throw new Error("A completed owned native write database is required")
  const root = await fs.mkdtemp("/tmp/dac-write-stage-terminal-")
  const filename = path.join(root, "copy.sqlite")
  const original = new Database(source, { readonly: true })
  try {
    await fs.writeFile(filename, original.serialize())
  } finally { original.close() }
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run("PRAGMA foreign_keys=ON")
      const rows = yield* db.all<{ admission_id: string }>("SELECT admission_id FROM work_write_stage WHERE released_at IS NULL AND state IN ('published','refused')")
      expect(rows).toHaveLength(1)
      const record = yield* WorkWriteStage.get(db, rows[0]!.admission_id)
      if (!record) throw new Error("The actual native terminal is missing")
      const before = yield* db.get<{ custody_count: number; audit_count: number; retained_bytes: number }>(sql`SELECT custody_count,audit_count,retained_bytes FROM work_write_stage_meter WHERE instance_id=${record.instanceID}`)
      if (!before) throw new Error("The actual custody meter is missing")
      const observed = yield* WorkWriteStage.observed(db, record, record.reservedBytes + 7)
      expect(observed.state).toBe(record.state)
      expect(Exit.isFailure(yield* WorkWriteStage.released(db, record).pipe(Effect.exit))).toBe(true)
      const released = yield* WorkWriteStage.released(db, observed)
      expect(released).toMatchObject({ state: record.state, reservedBytes: 0, observedRetainedBytes: 0 })
      expect(released.releasedAt).toBeGreaterThan(0)
      expect(yield* db.get(sql`SELECT custody_count,audit_count,retained_bytes FROM work_write_stage_meter WHERE instance_id=${record.instanceID}`))
        .toEqual({ custody_count: before.custody_count - 1, audit_count: before.audit_count,
          retained_bytes: before.retained_bytes - Math.max(record.reservedBytes, record.observedRetainedBytes) })
      expect(Exit.isFailure(yield* WorkWriteStage.released(db, released).pipe(Effect.exit))).toBe(true)
      expect(yield* WorkWriteStage.get(db, record.admissionID)).toEqual(released)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

for (const source of releasedSources) test(`actual released custody cannot release or account growth again: ${path.basename(path.dirname(source))}`, async () => {
  const root = await fs.mkdtemp("/tmp/dac-write-stage-released-")
  const filename = path.join(root, "copy.sqlite")
  const original = new Database(source, { readonly: true })
  try { await fs.writeFile(filename, original.serialize()) } finally { original.close() }
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run("PRAGMA foreign_keys=ON")
      const rows = yield* db.all<{ admission_id: string }>("SELECT admission_id FROM work_write_stage WHERE released_at IS NOT NULL")
      expect(rows).toHaveLength(1)
      const record = yield* WorkWriteStage.get(db, rows[0]!.admission_id)
      if (!record) throw new Error("The actual released terminal is missing")
      const before = yield* db.get(sql`SELECT * FROM work_write_stage_meter WHERE instance_id=${record.instanceID}`)
      expect(Exit.isFailure(yield* WorkWriteStage.released(db, record).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* WorkWriteStage.observed(db, record, 7).pipe(Effect.exit))).toBe(true)
      expect(yield* WorkWriteStage.get(db, record.admissionID)).toEqual(record)
      expect(yield* db.get(sql`SELECT * FROM work_write_stage_meter WHERE instance_id=${record.instanceID}`)).toEqual(before)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test.skipIf(!unknownSource)("actual published-without-ACK custody cannot release its reservation", async () => {
  if (!unknownSource) throw new Error("An actual unknown-publication database is required")
  const root = await fs.mkdtemp("/tmp/dac-write-stage-unknown-")
  const filename = path.join(root, "copy.sqlite")
  const original = new Database(unknownSource, { readonly: true })
  try { await fs.writeFile(filename, original.serialize()) } finally { original.close() }
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run("PRAGMA foreign_keys=ON")
      const rows = yield* db.all<{ admission_id: string }>("SELECT admission_id FROM work_write_stage WHERE state='publication_unknown'")
      expect(rows).toHaveLength(1)
      const record = yield* WorkWriteStage.get(db, rows[0]!.admission_id)
      if (!record) throw new Error("The actual unknown publication is missing")
      const before = yield* db.get(sql`SELECT * FROM work_write_stage_meter WHERE instance_id=${record.instanceID}`)
      expect(Exit.isFailure(yield* WorkWriteStage.released(db, record).pipe(Effect.exit))).toBe(true)
      expect(yield* WorkWriteStage.get(db, record.admissionID)).toEqual(record)
      expect(yield* db.get(sql`SELECT * FROM work_write_stage_meter WHERE instance_id=${record.instanceID}`)).toEqual(before)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
