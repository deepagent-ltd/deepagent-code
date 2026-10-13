import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Cause, Effect, Exit, Schema } from "effect"
import { sql } from "drizzle-orm"
import { layer } from "../src/database/sqlite.bun"
import { CanonicalJson } from "../src/util/canonical-json"
import { Hash } from "../src/util/hash"
import { EventWorkDagSchema } from "../src/deepagent/event-work-dag.schema"
import migration from "../src/database/migration/20261011235910_event_artifact_custody_lifecycle"

// Actual predecessor file SQLite, only owned copies. These are storage transition
// fixtures, not Native execution witnesses or evidence of complete graph acceptance.
const source = process.env.DAC_EVENT_ARTIFACT_FILEDB
test.skipIf(!source)("forward Event custody permits accounting lifecycle while preserving immutable authorities and unknown debt", async () => {
  const original = new Database(source!, { readonly: true })
  const snapshot = original.serialize()
  original.close()
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-event-artifact-lifecycle-")))
  const results: { name: string; accepted: boolean }[] = []
  const sample = async (name: string, run: (db: Effect.Success<ReturnType<typeof EffectDrizzleSqlite.makeWithDefaults>>) => Effect.Effect<void, unknown>) => {
    const filename = path.join(directory, name + ".sqlite")
    await fs.writeFile(filename, snapshot)
    await fs.chmod(filename, 0o600)
    return Effect.runPromise(Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run("PRAGMA foreign_keys=ON")
      const before = yield* db.all(sql`SELECT work_id,binding_hash,outcome FROM work_execution ORDER BY work_id`)
      yield* db.transaction((tx) => migration.up(tx), { behavior: "immediate" })
      expect(yield* db.all(sql`SELECT work_id,binding_hash,outcome FROM work_execution ORDER BY work_id`)).toEqual(before)
      return yield* run(db).pipe(Effect.exit)
    }).pipe(Effect.provide(layer({ filename })), Effect.scoped))
  }
  const row = (db: Effect.Success<ReturnType<typeof EffectDrizzleSqlite.makeWithDefaults>>) => db.get<{ record: string; work_id: string }>(
    sql`SELECT record,work_id FROM event_work_node_authority LIMIT 1`)
  const write = (db: Effect.Success<ReturnType<typeof EffectDrizzleSqlite.makeWithDefaults>>, workID: string, record: Record<string, unknown>, state: string) => {
    const body = CanonicalJson.stringify(record)
    return db.run(sql`UPDATE event_work_node_authority SET record=${body},record_hash=${Hash.sha256(body)},record_bytes=${Buffer.byteLength(body)},state=${state} WHERE work_id=${workID}`).pipe(Effect.asVoid)
  }
  const seal = (record: EventWorkDagSchema.Authority) => ({ ...record, artifactCustody: { version: 1, commit: "b".repeat(40),
    manifestSha256: "c".repeat(64), files: 2, bytes: 178, worktreeAllocatedBytes: 8192, gitAllocatedBytes: 16384,
    indexAllocatedBytes: 4096, sealedAt: Number(record.createdAt) + 1 } })
  const terminal = (record: ReturnType<typeof seal>) => ({ ...record, terminal: { fixture: "SQL-contract-only" } })
  const lifecycle = await sample("known-lifecycle", (db) => Effect.gen(function* () {
    const original = yield* row(db)
    const record = seal(Schema.decodeUnknownSync(Schema.fromJsonString(EventWorkDagSchema.Authority))(original!.record))
    yield* write(db, original!.work_id, record, "bound")
    const ended = terminal(record)
    yield* write(db, original!.work_id, ended, "terminal")
    const preparing = { ...ended, artifactCustody: { ...ended.artifactCustody,
      cleanup: { state: "preparing", startedAt: ended.artifactCustody.sealedAt + 1 } } }
    yield* write(db, original!.work_id, preparing, "terminal")
    const collected = { ...preparing, artifactCustody: { ...preparing.artifactCustody, worktreeAllocatedBytes: 4096,
      cleanup: { ...preparing.artifactCustody.cleanup, state: "collected", completedAt: preparing.artifactCustody.cleanup.startedAt + 1 } } }
    yield* write(db, original!.work_id, collected, "terminal")
    expect(JSON.parse((yield* row(db))!.record)).toEqual(collected)
    expect((yield* db.get<{ error: string }>(sql`SELECT error FROM event_task_workspace`))?.error).toBe("formal_physical_unknown")
  }))
  expect(Exit.isSuccess(lifecycle)).toBe(true)
  results.push({ name: "known-lifecycle", accepted: Exit.isSuccess(lifecycle) })
  for (const name of ["missing-seal", "replace-seal", "placement-change", "terminal-change", "skip-prepare", "allocation-increase", "unknown-retry", "collected-retry", "seal-time", "cleanup-time", "root-change"]) {
    const refused = await sample(name, (db) => Effect.gen(function* () {
      const original = yield* row(db)
      const record = seal(Schema.decodeUnknownSync(Schema.fromJsonString(EventWorkDagSchema.Authority))(original!.record))
      if (name === "root-change") {
        yield* write(db, original!.work_id, { ...record, rootRevision: 999 }, "bound")
        return
      }
      if (name === "seal-time") {
        yield* write(db, original!.work_id, { ...record, artifactCustody: { ...record.artifactCustody, sealedAt: Number(record.createdAt) - 1 } }, "bound")
        return
      }
      if (name === "missing-seal") {
        const missing = { ...record.artifactCustody, manifestSha256: undefined }
        yield* write(db, original!.work_id, { ...record, artifactCustody: missing }, "bound")
        return
      }
      if (name === "placement-change") {
        yield* write(db, original!.work_id, { ...record, placement: {} }, "bound")
        return
      }
      yield* write(db, original!.work_id, record, "bound")
      if (name === "replace-seal") {
        yield* write(db, original!.work_id, { ...record, artifactCustody: { ...record.artifactCustody, commit: "d".repeat(40) } }, "bound")
        return
      }
      const ended = terminal(record)
      yield* write(db, original!.work_id, ended, "terminal")
      if (name === "terminal-change") {
        yield* write(db, original!.work_id, { ...ended, terminal: { fixture: "different" } }, "terminal")
        return
      }
      const preparing = { ...ended, artifactCustody: { ...ended.artifactCustody,
        cleanup: { state: "preparing", startedAt: ended.artifactCustody.sealedAt + 1 } } }
      if (name === "cleanup-time") {
        yield* write(db, original!.work_id, { ...preparing, artifactCustody: { ...preparing.artifactCustody,
          cleanup: { state: "preparing", startedAt: ended.artifactCustody.sealedAt - 1 } } }, "terminal")
        return
      }
      if (name === "skip-prepare") {
        yield* write(db, original!.work_id, { ...preparing, artifactCustody: { ...preparing.artifactCustody,
          cleanup: { ...preparing.artifactCustody.cleanup, state: "collected", completedAt: preparing.artifactCustody.cleanup.startedAt + 1 } } }, "terminal")
        return
      }
      yield* write(db, original!.work_id, preparing, "terminal")
      const next = { ...preparing, artifactCustody: { ...preparing.artifactCustody,
        cleanup: { ...preparing.artifactCustody.cleanup, state: name === "unknown-retry" ? "unknown" : "collected",
          ...(name === "unknown-retry" ? {} : { completedAt: preparing.artifactCustody.cleanup.startedAt + 1 }) },
        worktreeAllocatedBytes: name === "allocation-increase" ? 16384 : 4096 } }
      if (name === "unknown-retry") next.artifactCustody.worktreeAllocatedBytes = preparing.artifactCustody.worktreeAllocatedBytes
      yield* write(db, original!.work_id, next, "terminal")
      yield* write(db, original!.work_id, preparing, "terminal")
    }))
    expect(Exit.isFailure(refused)).toBe(true)
    expect(Exit.isFailure(refused) && Cause.pretty(refused.cause).includes("event_dag_node_immutable")).toBe(true)
    results.push({ name, accepted: Exit.isSuccess(refused) })
  }
  const header = await sample("initial-header-artifact", (db) => Effect.gen(function* () {
    const original = yield* row(db)
    const record = seal(Schema.decodeUnknownSync(Schema.fromJsonString(EventWorkDagSchema.Authority))(original!.record))
    const next = { ...record, authorityID: "fixture-new-authority", childWorkID: "fixture-new-work", nodeID: "fixture-new-node" }
    const body = CanonicalJson.stringify(next)
    yield* db.run(sql`INSERT INTO event_work_node_authority(authority_id,receipt_id,node_id,work_id,state,record,record_hash,record_bytes)
      VALUES (${next.authorityID},${record.receiptID},${next.nodeID},${next.childWorkID},'pending',${body},${Hash.sha256(body)},${Buffer.byteLength(body)})`)
  }))
  expect(Exit.isFailure(header) && Cause.pretty(header.cause).includes("event_dag_node_header")).toBe(true)
  results.push({ name: "initial-header-artifact", accepted: Exit.isSuccess(header) })
  const controller = await sample("terminal-controller-accounting", (db) => Effect.gen(function* () {
    const original = yield* db.get<{ controller_id: string; record: string }>(sql`SELECT controller_id,record FROM event_work_controller LIMIT 1`)
    const record = Schema.decodeUnknownSync(Schema.fromJsonString(EventWorkDagSchema.Controller))(original!.record)
    const update = (value: typeof record) => {
      const body = CanonicalJson.stringify(value)
      return db.run(sql`UPDATE event_work_controller SET record=${body},record_hash=${Hash.sha256(body)},record_bytes=${Buffer.byteLength(body)},revision=${value.revision},state=${value.state} WHERE controller_id=${original!.controller_id}`)
    }
    const baseline = record.baseline
    if (!baseline || baseline.state !== "sealed") return yield* Effect.die("Actual sealed baseline fixture is absent")
    const ended = { ...record, baseline, revision: record.revision + 1, state: "succeeded" as const, activeNodeID: null }
    yield* update(ended)
    for (const changed of [
      { ...ended, revision: ended.revision + 1, baseline: { ...ended.baseline, settledRetentionAt: ended.baseline.sealedAt - 1 } },
      { ...ended, revision: ended.revision + 1, expiresAt: ended.expiresAt + 1,
        baseline: { ...ended.baseline, settledRetentionAt: ended.baseline.sealedAt + 1 } },
      { ...ended, revision: ended.revision + 1, plan: { ...ended.plan, id: "foreign" },
        baseline: { ...ended.baseline, settledRetentionAt: ended.baseline.sealedAt + 1 } },
    ]) {
      const refused = yield* update(changed).pipe(Effect.exit)
      expect(Exit.isFailure(refused) && Cause.pretty(refused.cause).includes("event_dag_controller_identity")).toBe(true)
    }
    const released = { ...ended, revision: ended.revision + 1, baseline: { ...ended.baseline, settledRetentionAt: ended.baseline.sealedAt + 1 } }
    yield* update(released)
    expect(JSON.parse((yield* db.get<{ record: string }>(sql`SELECT record FROM event_work_controller`))!.record)).toEqual(released)
    expect(Exit.isFailure(yield* update({ ...released, revision: released.revision + 1, state: "running" as const }).pipe(Effect.exit))).toBe(true)
    expect(Exit.isFailure(yield* update({ ...released, revision: released.revision + 1,
      baseline: { ...released.baseline, settledRetentionAt: released.baseline.settledRetentionAt + 1 } }).pipe(Effect.exit))).toBe(true)
  }))
  expect(Exit.isSuccess(controller)).toBe(true)
  results.push({ name: "terminal-controller-accounting", accepted: Exit.isSuccess(controller) })
  const guardedFile = path.join(directory, "foreign-trigger-rollback.sqlite")
  await fs.writeFile(guardedFile, snapshot)
  await Effect.runPromise(Effect.gen(function* () {
    const db = yield* EffectDrizzleSqlite.makeWithDefaults()
    yield* db.run("PRAGMA foreign_keys=ON")
    yield* db.run("DROP TRIGGER event_work_controller_identity")
    yield* db.run("CREATE TRIGGER event_work_controller_identity BEFORE UPDATE ON event_work_controller BEGIN SELECT RAISE(ABORT,'foreign'); END")
    const before = yield* db.all(sql`SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN
      ('event_work_node_header','event_work_node_identity','event_work_controller_identity') ORDER BY name`)
    const refused = yield* db.transaction((tx) => migration.up(tx), { behavior: "immediate" }).pipe(Effect.exit)
    expect(Exit.isFailure(refused)).toBe(true)
    expect(yield* db.all(sql`SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN
      ('event_work_node_header','event_work_node_identity','event_work_controller_identity') ORDER BY name`)).toEqual(before)
  }).pipe(Effect.provide(layer({ filename: guardedFile })), Effect.scoped))
  results.push({ name: "foreign-trigger-atomic-refusal", accepted: false })
  if (process.env.DAC_EVENT_ARTIFACT_RESULT) await Bun.write(process.env.DAC_EVENT_ARTIFACT_RESULT,
    JSON.stringify({ directory, results, providerRequests: 0, originalDBWrites: 0, scope: "actual-fileSQLite-storage-contract-only" }, null, 2))
})
