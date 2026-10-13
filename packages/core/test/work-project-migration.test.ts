import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"
import { LocalOperator } from "../src/im/local-operator"
import { WorkCountAcquisition } from "../src/session/work-count-acquisition"
import { WorkCountAcquisitionSchema } from "../src/session/work-count-acquisition.schema"
import { CanonicalJson } from "../src/util/canonical-json"
import { Hash } from "../src/util/hash"
import { WorkAuthorityFixture } from "./fixture/work-authority"
import { WorkRouteApprovalFixture } from "./fixture/work-route-approval"

const boundary = migrations.findIndex((item) => item.id === "20261007135240_project_work_turn_slots")
const successor = migrations[boundary]!
const old = migrations.slice(0, boundary)
const current = migrations.slice(0, boundary + 1)
const tables = "('work_execution','work_count_acquisition','session_v2_tool_effect')"
type Db = Database.Interface["db"]
const snapshot = (db: Db) => Effect.gen(function* () {
  return {
    work: yield* db.all<Record<string, unknown>>("SELECT * FROM work_execution"),
    count: yield* db.all<Record<string, unknown>>("SELECT * FROM work_count_acquisition"),
    tools: yield* db.all<Record<string, unknown>>("SELECT * FROM session_v2_tool_effect"),
    schema: yield* db.all<{ type: string; name: string; tbl_name: string; sql: string }>(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name IN ${tables} ORDER BY type,name`),
    migrations: yield* db.all("SELECT * FROM migration ORDER BY id"),
  }
})

async function fixture(run: (input: {
  filename: string
  original: WorkCountAcquisitionSchema.Record
  execute: <A, E>(effect: Effect.Effect<A, E, Database.Service>) => Promise<A>
}) => Promise<void>) {
  const directory = await fs.mkdtemp("/tmp/dac-project-migration-")
  const proof = WorkRouteApprovalFixture.authority()
  const executeAt = <A, E>(filename: string, effect: Effect.Effect<A, E, Database.Service>) => Effect.runPromise(effect.pipe(
    Effect.provide(Layer.mergeAll(WorkAuthorityFixture.database(filename), proof.route, proof.count, WorkAuthorityFixture.verifier)),
    Effect.provideService(LocalOperator.Runtime, WorkRouteApprovalFixture.runtime), Effect.scoped,
  ))
  const filename = path.join(directory, "old.sqlite")
  const execute = <A, E>(effect: Effect.Effect<A, E, Database.Service>) => executeAt(filename, effect)
  try {
    // Produce a real authenticated v1 slot through the shipped store. Copy its unchanged
    // historical columns into the actual pre-224 schema, including its real predecessor rows.
    const original = await executeAt(path.join(directory, "source.sqlite"), Effect.gen(function* () {
      yield* WorkRouteApprovalFixture.initialize
      yield* WorkRouteApprovalFixture.approve(proof.capture())
      const binding = yield* WorkRouteApprovalFixture.work
      const db = (yield* Database.Service).db
      return yield* WorkCountAcquisition.prepare(db, { acquisitionID: "old-count", binding,
        ownerToken: "count-owner", bootID: "count-boot", deadline: 2000, now: 1000 })
    }))
    await execute(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* DatabaseMigration.applyOnly(db, old)
      yield* db.run(sql`ATTACH DATABASE ${path.join(directory, "source.sqlite")} AS source`)
      const rows = yield* db.all<{ name: string; sql: string }>("SELECT name,sql FROM source.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name NOT IN ('migration','__drizzle_migrations') ORDER BY CASE name WHEN 'project' THEN 0 WHEN 'session' THEN 1 WHEN 'session_input' THEN 2 WHEN 'session_activity' THEN 3 WHEN 'session_activity_input' THEN 4 WHEN 'session_context_selection' THEN 20 WHEN 'session_provider_owner_lease' THEN 21 WHEN 'session_provider_attempt' THEN 22 WHEN 'session_v2_provider_turn_receipt' THEN 23 ELSE 10 END,rowid")
      yield* db.transaction((tx) => Effect.gen(function* () {
        yield* tx.run("PRAGMA defer_foreign_keys=ON")
        // Restoring historical rows is not a new provider admission. Preserve and
        // restore the original trigger SQL around fixture import so database-time
        // lease checks are not falsely rerun on records produced by the real store.
        const triggers = yield* tx.all<{ name: string; sql: string }>("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name")
        for (const trigger of triggers) yield* tx.run(sql`DROP TRIGGER ${sql.identifier(trigger.name)}`)
        for (const row of rows) {
          // These are migration-owned seeds, not the historical Work business fixture.
          if (["database_capability", "event_sync_backfill", "event_snapshot_backfill", "event_sync_sequence", "im_kernel_media_meter"].includes(row.name)) continue
          if (!(yield* tx.all(sql`SELECT 1 FROM source.${sql.identifier(row.name)} LIMIT 1`)).length) continue
          // A current source may seed new, unrelated tables. They did not exist before 224
          // and must be created by their own later migration, never imported as old history.
          if (!(yield* tx.all(sql`SELECT 1 FROM sqlite_master WHERE type='table' AND name=${row.name}`)).length) {
            if (!row.name.startsWith("test_")) continue
            yield* tx.run(row.sql)
          }
          const names = (yield* tx.all<{ name: string }>(sql`PRAGMA table_info(${sql.identifier(row.name)})`)).map((item) => item.name)
          const columns = names.map(sql.identifier)
          // Each historical database keeps its own migration-owned timestamps and
          // cursor secrets. Copy only the actual business fixture, not those seeds.
          const seeded = yield* tx.all(sql`SELECT ${sql.join(columns, sql`,`)} FROM ${sql.identifier(row.name)}`)
          if (seeded.length) {
            // Project insertion legitimately creates its permission epoch. Keep
            // that actual trigger result only when it matches the source exactly.
            expect(yield* tx.all(sql`SELECT ${sql.join(columns, sql`,`)} FROM source.${sql.identifier(row.name)}`)).toEqual(seeded)
            continue
          }
          yield* tx.run(sql`INSERT INTO ${sql.identifier(row.name)} (${sql.join(columns, sql`,`)}) SELECT ${sql.join(columns, sql`,`)} FROM source.${sql.identifier(row.name)}`)
        }
        for (const trigger of triggers) yield* tx.run(trigger.sql)
      }))
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      yield* db.run("DETACH DATABASE source")
    }))
    await run({ filename, original, execute })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

test("224 upgrades populated v1 records without changing their signed bytes or existing triggers; cold retry stays exact", () => fixture(async (input) => {
  const upgraded = await input.execute(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.run("PRAGMA foreign_keys=ON")
    const before = yield* snapshot(db)
    yield* DatabaseMigration.applyOnly(db, current)
    const after = yield* snapshot(db)
    expect(after.work.map(({ binding_version, ...row }) => row)).toEqual(before.work)
    expect(after.count.map(({ slot_version, root_work_id, activity_id, provider_turn_seq, turn_key, ...row }) => row)).toEqual(before.count)
    expect(after.tools.map(({ known_read_proof, ...row }) => row)).toEqual(before.tools)
    const triggers = before.schema.filter((row) => row.type === "trigger")
    expect(triggers.length).toBeGreaterThan(0)
    expect(after.schema.filter((row) => triggers.some((item) => item.name === row.name))).toEqual(triggers)
    // The 224 historical schema proof is complete above. Today's business resolver also
    // requires later additive columns, including execution_role; install them before reopening.
    yield* DatabaseMigration.applyOnly(db, migrations)
    expect(yield* WorkCountAcquisition.get(db, input.original.binding.workID)).toEqual(input.original)
    expect(yield* WorkCountAcquisition.prepare(db, { acquisitionID: input.original.acquisitionID,
      binding: input.original.binding, ownerToken: input.original.ownerToken, bootID: input.original.bootID,
      deadline: input.original.deadline, now: input.original.createdAt })).toEqual(input.original)
    expect(yield* db.all("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }])
    expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
    return yield* snapshot(db)
  }))
  await input.execute(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.run("PRAGMA foreign_keys=ON")
    yield* DatabaseMigration.applyOnly(db, migrations)
    expect(yield* WorkCountAcquisition.get(db, input.original.binding.workID)).toEqual(input.original)
    expect(yield* snapshot(db)).toEqual(upgraded)
  }))
}))

test("224 late DDL failure rolls back all columns, indexes, triggers and migration admission", () => fixture(async (input) => {
  await input.execute(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.run("PRAGMA foreign_keys=ON")
    const before = yield* snapshot(db)
    const failed = yield* DatabaseMigration.applyOnly(db, [...old, { ...successor,
      id: "224-late-failure", bodyHash: undefined,
      up: (tx) => successor.up(tx).pipe(Effect.andThen(tx.run("INSERT INTO missing_224_test_table VALUES (1)"))),
    }]).pipe(Effect.exit)
    expect(Exit.isFailure(failed)).toBe(true)
    expect(yield* snapshot(db)).toEqual(before)
    expect(yield* db.all("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }])
  }))
}))

test("v2 physical slots bind the actual Work, receipt, attempt and context; all turn identity fields are immutable", () => fixture(async (input) => {
  await input.execute(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* DatabaseMigration.applyOnly(db, current)
    const [work] = yield* db.all<{ binding: string }>("SELECT * FROM work_execution")
    const [turn] = yield* db.all<{ activity_id: string; provider_turn_seq: number; selection_id: string; projection_hash: string }>(sql`SELECT a.activity_id,a.provider_turn_seq,a.selection_id,a.projection_hash FROM session_provider_attempt a WHERE a.attempt_id=${input.original.binding.providerAttemptID}`)
    if (!work || !turn) throw new Error("actual predecessor fixture is missing")
    // Deliberately SQL-only: no fake MAC is accepted by a business resolver and this does
    // not claim a production project binding or provider dispatch.
    yield* db.run("DELETE FROM work_count_acquisition")
    const columns = (yield* db.all<{ name: string }>("PRAGMA table_info(work_execution)")).map((row) => row.name)
    yield* db.run("CREATE TEMP TABLE physical_work AS SELECT * FROM work_execution")
    yield* db.run("DELETE FROM work_execution")
    yield* db.run(sql`UPDATE physical_work SET binding_version=2,binding=${JSON.stringify({ ...JSON.parse(work.binding), schemaVersion: "work-execution.v2" })}`)
    yield* db.run(sql`INSERT INTO work_execution (${sql.join(columns.map(sql.identifier), sql`,`)}) SELECT ${sql.join(columns.map(sql.identifier), sql`,`)} FROM physical_work`)
    const record = { ...input.original, version: 2, binding: { ...input.original.binding,
      rootWorkID: input.original.binding.workID, turn: { activityID: turn.activity_id,
        providerTurnSeq: turn.provider_turn_seq, contextSelectionID: turn.selection_id,
        contextProjectionHash: turn.projection_hash, key: "a".repeat(64) } } }
    yield* db.run(sql`INSERT INTO work_count_acquisition
      (acquisition_id,work_id,input_id,session_id,provider_receipt_id,provider_attempt_id,binding_hash,approval_id,approval_revision,state,revision,owner_token,boot_id,deadline,record,record_hash,record_mac,created_at,updated_at,slot_version,root_work_id,activity_id,provider_turn_seq,turn_key)
      VALUES ('project-slot',${record.binding.workID},${record.binding.inputID},${record.binding.sessionID},${record.binding.providerReceiptID},${record.binding.providerAttemptID},${Hash.sha256(CanonicalJson.stringify(record.binding))},${record.binding.approvalID},${record.binding.approvalRevision},'prepared',1,'owner','boot',2000,${CanonicalJson.stringify(record)},${Hash.sha256(CanonicalJson.stringify(record))},${"b".repeat(64)},1000,1000,2,${record.binding.rootWorkID},${turn.activity_id},${turn.provider_turn_seq},${record.binding.turn.key})`)
    const before = yield* snapshot(db)
    for (const column of ["acquisition_id", "work_id", "root_work_id", "input_id", "session_id", "provider_receipt_id", "provider_attempt_id", "binding_hash", "approval_id", "activity_id", "turn_key"])
      expect(Exit.isFailure(yield* db.run(sql`UPDATE work_count_acquisition SET ${sql.identifier(column)}='different'`).pipe(Effect.exit))).toBe(true)
    for (const statement of [
      "UPDATE work_count_acquisition SET provider_turn_seq=2",
      "UPDATE work_count_acquisition SET approval_revision=2",
      "UPDATE work_count_acquisition SET slot_version=1",
      "UPDATE work_count_acquisition SET record=json_set(record,'$.binding.inputID','different')",
      "UPDATE work_execution SET binding_version=1",
      "UPDATE work_execution SET input_id='different'",
      "UPDATE work_execution SET binding=json_set(binding,'$.inputID','different')",
    ]) expect(Exit.isFailure(yield* db.run(statement).pipe(Effect.exit))).toBe(true)
    const countColumns = (yield* db.all<{ name: string }>("PRAGMA table_info(work_count_acquisition)")).map((row) => row.name)
    expect(Exit.isFailure(yield* db.run(sql`INSERT INTO work_count_acquisition (${sql.join(countColumns.map(sql.identifier), sql`,`)} )
      SELECT ${sql.join(countColumns.map((name) => name === "acquisition_id" ? sql`'duplicate-slot'` : sql.identifier(name)), sql`,`)} FROM work_count_acquisition`).pipe(Effect.exit))).toBe(true)
    expect(yield* snapshot(db)).toEqual(before)
  }))
}))

test("known-recovery upgrade preserves authenticated v1 records and rolls back late DDL before cold reapply", () => fixture(async (input) => {
  for (const step of [
    { id: "20261007154408_work_known_recovery", table: "work_known_recovery", triggers: 4 },
    { id: "20261007155850_work_known_recovery_resume", table: "work_known_recovery_resume", triggers: 3 },
  ]) {
    const recoveryBoundary = migrations.findIndex((item) => item.id === step.id)
    expect(recoveryBoundary).toBeGreaterThan(boundary)
    const upgraded = await input.execute(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, recoveryBoundary))
      const before = yield* snapshot(db)
      const failed = yield* Effect.exit(DatabaseMigration.applyOnly(db, [
        ...migrations.slice(0, recoveryBoundary),
        { ...migrations[recoveryBoundary], up: (tx) => Effect.gen(function* () {
          yield* migrations[recoveryBoundary].up(tx)
          yield* tx.run("SELECT * FROM late_known_recovery_migration_failure")
        }) },
      ]))
      expect(Exit.isFailure(failed)).toBe(true)
      expect(yield* snapshot(db)).toEqual(before)
      expect(yield* db.all(sql`SELECT name FROM sqlite_master WHERE tbl_name=${step.table}`)).toEqual([])
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, recoveryBoundary + 1))
      const after = yield* snapshot(db)
      expect({ ...after, migrations: before.migrations }).toEqual(before)
      expect(yield* WorkCountAcquisition.get(db, input.original.binding.workID)).toEqual(input.original)
      expect(yield* db.all(sql`SELECT * FROM ${sql.identifier(step.table)}`)).toEqual([])
      expect((yield* db.all(sql`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=${step.table}`)).length).toBe(step.triggers)
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      return after
    }))
    await input.execute(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, recoveryBoundary + 1))
      expect(yield* snapshot(db)).toEqual(upgraded)
      expect(yield* WorkCountAcquisition.get(db, input.original.binding.workID)).toEqual(input.original)
      expect(yield* db.all(sql`SELECT * FROM ${sql.identifier(step.table)}`)).toEqual([])
    }))
  }
}))
