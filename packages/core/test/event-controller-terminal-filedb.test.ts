import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import { layer } from "../src/database/sqlite.bun"
import { StartupInventory } from "../src/session/runner/startup-inventory"
import { EventWorkDagSchema } from "../src/deepagent/event-work-dag.schema"
import { CanonicalJson } from "../src/util/canonical-json"
import { Hash } from "../src/util/hash"

// The positive reads the actual installed three-node graph. Negative corruption is
// confined to owned copies; none of these history classifications mints a Native permit.
const source = process.env.DAC_EVENT_CONTROLLER_FILEDB
test.skipIf(!source)("known zero-provider Event controller retains exact child, artifact and predecessor history", async () => {
  const original = new Database(source!, { readonly: true })
  const snapshot = original.serialize()
  original.close()
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-event-controller-history-")))
  const results = []
  const inspect = (filename: string) => Effect.runPromise(Effect.gen(function* () {
    const db = yield* EffectDrizzleSqlite.makeWithDefaults()
    yield* db.run("PRAGMA query_only=ON")
    const observe = () => db.get(sql`SELECT (SELECT count(*) FROM session_provider_attempt) providers,
      (SELECT json_group_array(json_object('id',work_id,'role',execution_role,'outcome',outcome,'hash',binding_hash)) FROM work_execution) work,
      (SELECT json_group_array(json_object('state',state,'error',error,'ref',continuation_ref)) FROM event_task_workspace) workspace`)
    const before = yield* observe()
    const verdict = yield* StartupInventory.verifyStartupInventory(db)
    const after = yield* observe()
    expect(after).toEqual(before)
    return verdict
  }).pipe(Effect.provide(layer({ filename, readonly: true })), Effect.scoped))
  const positive = await inspect(source!)
  expect(positive.ok).toBe(true)
  expect(positive.unclassifiedItems).toHaveLength(0)
  results.push({ name: "actual-complete-three-node-history", accepted: positive.ok, items: positive.total })
  const negative = async (name: string, mutate: (db: Database) => void) => {
    const filename = path.join(directory, name + ".sqlite")
    await fs.writeFile(filename, snapshot, { mode: 0o600 })
    const db = new Database(filename)
    db.run("PRAGMA foreign_keys=OFF")
    // Adversarial storage copies deliberately bypass their write guards, never the
    // original DB or any production authority/Native consumer.
    for (const row of db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='trigger'").all())
      db.run(`DROP TRIGGER "${row.name.replaceAll('"', '""')}"`)
    mutate(db)
    db.close()
    const result = await inspect(filename)
    expect(result.ok).toBe(false)
    expect(result.unclassifiedItems.some((row) => row.category === "work_execution" && row.id.startsWith("work_ev_"))).toBe(true)
    results.push({ name, accepted: result.ok, reasons: [...new Set(result.unclassifiedItems.map((row) => row.reason))] })
  }
  const changeAuthority = (db: Database, update: (record: EventWorkDagSchema.Authority) => EventWorkDagSchema.Authority) => {
    const row = db.query<{ record: string; work_id: string }, []>("SELECT record,work_id FROM event_work_node_authority WHERE node_id='read'").get()!
    const record = update(Schema.decodeUnknownSync(Schema.fromJsonString(EventWorkDagSchema.Authority))(row.record))
    const body = CanonicalJson.stringify(record)
    db.run("UPDATE event_work_node_authority SET record=?,record_hash=?,record_bytes=? WHERE work_id=?",
      [body, Hash.sha256(body), Buffer.byteLength(body), row.work_id])
  }
  await negative("missing-original-child-authority", (db) => db.run("DELETE FROM event_work_node_authority WHERE node_id='read'"))
  await negative("corrupt-controller-hash", (db) => db.run("UPDATE event_work_controller SET record_hash=?", ["0".repeat(64)]))
  await negative("foreign-original-placement", (db) => changeAuthority(db, (record) => ({ ...record,
    placement: { ...record.placement!, workspace: { ...record.placement!.workspace, directory: record.placement!.workspace.directory + "-foreign" } } })))
  await negative("terminal-ref-differs-from-sealed-artifact", (db) => changeAuthority(db, (record) => ({ ...record,
    terminal: { ...record.terminal!, workspaceRef: "a".repeat(40) } })))
  await negative("predecessor-ref-differs-from-original-terminal", (db) => changeAuthority(db, (record) => ({ ...record,
    predecessorRefs: record.predecessorRefs.map((terminal) => ({ ...terminal, resultHash: "0".repeat(64) })) })))
  await negative("controller-cannot-own-provider-attempt", (db) => db.run(`UPDATE session_provider_attempt SET session_id=
    (SELECT session_id FROM work_execution WHERE execution_role='dag_controller') WHERE attempt_id=(SELECT attempt_id FROM session_provider_attempt LIMIT 1)`))
  if (process.env.DAC_EVENT_CONTROLLER_RESULT) await Bun.write(process.env.DAC_EVENT_CONTROLLER_RESULT,
    JSON.stringify({ results, positiveItems: positive.total, providerRequests: 0, originalDBWrites: 0, negativeDirectory: directory }, null, 2))
})
