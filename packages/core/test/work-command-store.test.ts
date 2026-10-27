import os from "node:os"
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { WorkCommand } from "../src/session/work-command"

// The source is produced by the actual signed host/canonical command test. Copies
// exercise factual custody CAS only; no copied database grants native execution.
const source = process.env.DAC_WORK_COMMAND_DB
test.skipIf(!source)("actual released command cannot launch, regress or release custody twice", async () => {
  if (!source) throw new Error("An actual signed command result database is required")
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dac-command-store-"))
  const filename = path.join(root, "copy.sqlite")
  const original = new Database(source, { readonly: true })
  try { await fs.writeFile(filename, original.serialize()) } finally { original.close() }
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run("PRAGMA foreign_keys=ON")
      const rows = yield* db.all<{ admission_id: string }>("SELECT admission_id FROM work_command_intent WHERE released_at IS NOT NULL")
      expect(rows).toHaveLength(1)
      const record = yield* WorkCommand.get(db, rows[0]!.admission_id)
      if (!record) throw new Error("Actual command terminal is missing")
      expect(record).toMatchObject({ state: "settled", outcome: "exited", exitCode: 0, stopConfirmed: true,
        reservedBytes: 0, observedRetainedBytes: 0 })
      expect(record.stdout?.complete).toBe(true)
      expect(record.stderr?.complete).toBe(true)
      const meter = yield* db.get(sql`SELECT * FROM work_command_meter WHERE instance_id=${record.instanceID}`)
      const proof = yield* db.get(sql`SELECT known_command_proof FROM session_v2_tool_effect WHERE receipt_id=${record.providerReceiptID} AND tool_call_id=${record.toolCallID}`)
      const result = WorkCommand.resultHash(record)
      for (const action of [WorkCommand.released(db, record), WorkCommand.observed(db, record, 7),
        WorkCommand.unknown(db, record), WorkCommand.beginDispatch(db, record, "new-incarnation"),
        WorkCommand.started(db, record, 1)]) expect(Exit.isFailure(yield* action.pipe(Effect.exit))).toBe(true)
      expect(yield* WorkCommand.get(db, record.admissionID)).toEqual(record)
      expect(WorkCommand.resultHash(record)).toBe(result)
      expect(yield* db.get(sql`SELECT * FROM work_command_meter WHERE instance_id=${record.instanceID}`)).toEqual(meter)
      expect(yield* db.get(sql`SELECT known_command_proof FROM session_v2_tool_effect WHERE receipt_id=${record.providerReceiptID} AND tool_call_id=${record.toolCallID}`)).toEqual(proof)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
