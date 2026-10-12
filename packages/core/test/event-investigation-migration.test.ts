import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"

const boundary = migrations.findIndex((migration) => migration.id === "20261008014344_event_investigation")
const selected = migrations.slice(0, boundary + 1)
const makeDb = EffectDrizzleSqlite.makeWithDefaults()
type Db = Effect.Success<typeof makeDb>
const hash = "a".repeat(64)

const snapshot = (db: Db) => Effect.gen(function* () {
  const tables = yield* db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  return {
    schema: yield* db.all("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"),
    rows: yield* Effect.forEach(tables, (table) => Effect.gen(function* () {
      if (!/^[a-zA-Z0-9_]+$/.test(table.name)) return yield* Effect.die("Unexpected table identifier")
      return [table.name, (yield* db.all(`SELECT * FROM "${table.name}"`)).map((row) => JSON.stringify(row)).sort()] as const
    })),
  }
})

// These are physical storage facts, not an execution grant or native provenance.
const oldRule = { version: 1, ruleID: "rule", instanceID: "instance", projectKey: hash, revision: 1, state: "disabled",
  operatorID: "operator", operatorRevision: 1, configHash: hash, contentRevision: 0, contentHash: null, runCount: 0,
  pendingFirstAt: null, pendingLastAt: null, dueAt: null, currentRunID: null, lastReason: "disabled", approval: null,
  configuration: { scope: { securityNamespaceID: "namespace" }, expiresAt: 10000 }, createdAt: 1, updatedAt: 1 }
const grant = { version: 1, epoch: 1, ruleID: "rule", principal: { instanceID: "instance" }, createdAt: 2, expiresAt: 9000 }
const authority = { version: 1, epoch: 1, state: "enabled", grant, updatedAt: 2 }
const withAuthority = { ...oldRule, investigationAuthority: authority, updatedAt: 2 }
const encodeRule = (db: Db, rule: typeof oldRule | typeof withAuthority, epoch: number) => db.run(sql`
  UPDATE event_validation_rule SET revision=${rule.revision},state=${rule.state},operator_revision=${rule.operatorRevision},
    config_hash=${rule.configHash},content_revision=${rule.contentRevision},content_hash=${rule.contentHash},
    run_count=${rule.runCount},current_run_id=${rule.currentRunID},last_reason=${rule.lastReason},
    investigation_epoch=${epoch},record=${JSON.stringify(rule)},record_hash=${hash},updated_at=${rule.updatedAt} WHERE rule_id='rule'`)

test("236 preserves populated 235 bytes, rolls back late DDL and cold reapply, and enforces investigation storage boundaries", async () => {
  expect(boundary).toBe(235)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-event-investigation-migration-"))
  const filename = path.join(directory, "database.sqlite")
  try {
    const after = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* DatabaseMigration.applyOnly(db, selected.slice(0, -1))
      yield* db.run(sql`INSERT INTO event_validation_rule VALUES ('rule','instance',${hash},1,'disabled','operator',1,${hash},0,NULL,0,NULL,NULL,NULL,NULL,'disabled',${JSON.stringify(oldRule)},${hash},1,1)`)
      const command = { version: 1, instanceID: "instance", requestID: "old-command", ruleID: "rule", action: "create", ruleRevision: 1, runID: null, createdAt: 1 }
      yield* db.run(sql`INSERT INTO event_validation_command VALUES ('instance','old-command','rule','create',${hash},${JSON.stringify(command)},1)`)
      yield* db.run(sql`INSERT INTO event_validation_project VALUES (${hash},'instance',NULL,NULL,1,1)`)
      yield* db.run(sql`INSERT INTO context_security_namespace VALUES ('namespace','implicit_local',${hash},1,NULL)`)
      const before = yield* snapshot(db)
      const failed: DatabaseMigration.Migration[] = [...selected.slice(0, -1), { ...selected[boundary]!, up: (tx) => Effect.gen(function* () {
        yield* selected[boundary]!.up(tx)
        return yield* tx.run("SELECT * FROM investigation_late_failure")
      }) }]
      expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, failed)))).toBe(true)
      expect(yield* snapshot(db)).toEqual(before)
      yield* DatabaseMigration.applyOnly(db, selected)
      const upgraded = yield* snapshot(db)
      const previousRows = new Map(before.rows)
      for (const [name, rows] of upgraded.rows) {
        if (name === "migration" || name.startsWith("database_upgrade_") || name === "event_validation_investigation_receipt") continue
        if (name === "event_validation_rule") {
          expect(rows.map((row) => {
            const original: Record<string, unknown> = JSON.parse(row)
            expect(original.investigation_epoch).toBe(0)
            delete original.investigation_epoch
            return JSON.stringify(original)
          })).toEqual(previousRows.get(name) ?? [])
          continue
        }
        expect(previousRows.has(name)).toBe(true)
        expect(rows).toEqual(previousRows.get(name) ?? [])
      }
      expect(yield* db.get("SELECT record FROM event_validation_rule")).toEqual({ record: JSON.stringify(oldRule) })
      expect(yield* db.all("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }])
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      expect(yield* db.get("PRAGMA quick_check")).toEqual({ quick_check: "ok" })
      const refuse = (effect: Effect.Effect<unknown, unknown>) => Effect.gen(function* () {
        const before = yield* snapshot(db)
        expect(Exit.isFailure(yield* Effect.exit(effect))).toBe(true)
        expect(yield* snapshot(db)).toEqual(before)
      })
      yield* refuse(encodeRule(db, { ...withAuthority, investigationAuthority: { ...authority, epoch: 2 } }, 1))
      yield* refuse(encodeRule(db, { ...withAuthority, investigationAuthority: { ...authority, grant: null } } as unknown as typeof withAuthority, 1))
      yield* refuse(encodeRule(db, { ...withAuthority, runCount: 1 }, 1))
      yield* refuse(encodeRule(db, { ...withAuthority, revision: 2, configuration: { ...oldRule.configuration, expiresAt: 9999 } }, 1))
      yield* encodeRule(db, withAuthority, 1)
      yield* refuse(encodeRule(db, { ...withAuthority, investigationAuthority: undefined } as unknown as typeof withAuthority, 0))
      yield* refuse(encodeRule(db, { ...withAuthority, configHash: "b".repeat(64), revision: 2, updatedAt: 3 }, 1))
      yield* refuse(encodeRule(db, { ...withAuthority, state: "paused", revision: 2, updatedAt: 3 }, 1))
      yield* refuse(encodeRule(db, { ...withAuthority, state: "paused", revision: 2, updatedAt: 3,
        configuration: { ...oldRule.configuration, expiresAt: 9999 },
        investigationAuthority: { version: 1, epoch: 2, state: "disabled", grant: null, updatedAt: 3 } } as unknown as typeof withAuthority, 2))
      const enabled = { ...withAuthority, state: "enabled", revision: 2, contentRevision: 1, contentHash: hash, updatedAt: 3 }
      yield* encodeRule(db, enabled as unknown as typeof withAuthority, 1)
      const queued = { version: 1, runID: "run", ruleID: "rule", instanceID: "instance", projectKey: hash,
        ruleRevision: 2, contentRevision: 1, contentHash: hash, recipeHash: hash, configHash: hash,
        state: "queued", outcome: null, ownerToken: "owner", revision: 1, cancelRequested: false,
        content: {}, testRunID: "run", previewBuildID: null, workspaceBasename: "private", workspaceIdentity: null,
        snapshotHash: null, processIncarnation: null, processID: null, result: null, resultCurrent: false,
        retainedBytes: 102825984, releasedAt: null, createdAt: 3, startedAt: null, terminalAt: null, deadline: 100 }
      yield* db.run(sql`INSERT INTO event_validation_run VALUES ('run','rule','instance',${hash},2,1,${hash},${hash},'queued',NULL,'owner',1,0,${JSON.stringify(queued)},${hash},102825984,NULL,3,NULL,NULL,100)`)
      const preparing = { ...queued, state: "preparing", revision: 2 }
      yield* db.run(sql`UPDATE event_validation_run SET state='preparing',revision=2,record=${JSON.stringify(preparing)}`)
      const prepared = { ...preparing, revision: 3, snapshotHash: hash, processIncarnation: "incarnation", workspaceIdentity: { kind: "posix", device: "1", inode: "2" } }
      yield* db.run(sql`UPDATE event_validation_run SET revision=3,record=${JSON.stringify(prepared)}`)
      const dispatching = { ...prepared, state: "dispatching", revision: 4, startedAt: 4 }
      yield* db.run(sql`UPDATE event_validation_run SET state='dispatching',revision=4,started_at=4,record=${JSON.stringify(dispatching)}`)
      const stream = { sha256: hash, bytes: 0, capturedBytes: 0, truncated: false, complete: true, excerptTruncated: false }
      const result = { outcome: "failed", exitCode: 1, signal: null, stopConfirmed: true, endedAt: 5, stdout: stream, stderr: stream }
      const settled = { ...dispatching, state: "settled", outcome: "failed", revision: 5, terminalAt: 5, result, resultCurrent: true }
      yield* db.run(sql`UPDATE event_validation_run SET state='settled',outcome='failed',revision=5,terminal_at=5,record=${JSON.stringify(settled)}`)
      const current = { ...enabled, currentRunID: "run", updatedAt: 5 }
      yield* encodeRule(db, current as unknown as typeof withAuthority, 1)
      const evidence = { version: 1, instanceID: "instance", ruleID: "rule", runID: "run", testRunID: "run", previewBuildID: null,
        ruleRevision: 2, contentRevision: 1, contentHash: hash, recipeHash: hash, configHash: hash, snapshotHash: hash,
        processIncarnation: "incarnation", scopeHash: hash, resultHash: hash, content: {}, result }
      const record = { version: 1, receiptID: "receipt", instanceID: "instance", ruleID: "rule", projectKey: hash,
        securityNamespaceID: "namespace", contentRevision: 1, contentHash: hash, recipeHash: hash, failureKey: hash,
        runID: "run", grantEpoch: 1, authorityHash: hash, workID: "work", rootWorkID: "work", sessionID: "session", inputID: "input",
        sourceRequestID: hash, bindingHash: hash, deadline: 1000, createdAt: 6, grant, grantHash: hash, evidence, evidenceHash: hash,
        auditedText: "诊断", auditedTextBytes: 6, auditedTextHash: hash }
      const insert = (value: typeof record) => db.run(sql`INSERT INTO event_validation_investigation_receipt VALUES
        (${value.receiptID},${value.instanceID},${value.ruleID},${value.projectKey},${value.securityNamespaceID},${value.contentRevision},
         ${value.contentHash},${value.recipeHash},${value.failureKey},${value.runID},${value.grantEpoch},${value.authorityHash},
         ${value.workID},${value.rootWorkID},${value.sessionID},${value.inputID},${value.sourceRequestID},${value.bindingHash},
         ${value.deadline},${value.createdAt},${JSON.stringify(value)},${hash},${Buffer.byteLength(JSON.stringify(value))})`)
      // Known failed without real retained-custody release is still ineligible.
      yield* refuse(insert(record))
      const released = { ...settled, revision: 6, retainedBytes: 0, releasedAt: 6 }
      yield* db.run(sql`UPDATE event_validation_run SET revision=6,retained_bytes=0,released_at=6,record=${JSON.stringify(released)}`)
      yield* refuse(insert({ ...record, evidence: { ...evidence, result: { ...result, stopConfirmed: false } } } as unknown as typeof record))
      yield* refuse(insert({ ...record, securityNamespaceID: "foreign" }))
      yield* refuse(insert({ ...record, runID: "foreign" }))
      yield* refuse(insert({ ...record, grantEpoch: 2 }))
      yield* refuse(insert({ ...record, evidence: { ...evidence, contentHash: "b".repeat(64) } }))
      yield* refuse(insert({ ...record, evidence: { ...evidence, previewBuildID: undefined } } as unknown as typeof record))
      yield* refuse(insert({ ...record, evidence: { ...evidence, result: { ...result, signal: undefined } } } as unknown as typeof record))
      yield* refuse(insert({ ...record, evidence: { ...evidence, result: { ...result, endedAt: 100 } } }))
      yield* refuse(insert({ ...record, auditedText: "x".repeat(65537), auditedTextBytes: 65537 }))
      yield* refuse(insert({ ...record, auditedTextBytes: 7 }))
      yield* refuse(insert({ ...record, evidence: { ...evidence, padding: "x".repeat(65536) } } as unknown as typeof record))
      yield* refuse(insert({ ...record, inputID: undefined } as unknown as typeof record))
      yield* insert(record)
      yield* refuse(insert(record))
      yield* refuse(db.run("UPDATE event_validation_investigation_receipt SET deadline=2000"))
      yield* refuse(db.run("DELETE FROM event_validation_investigation_receipt"))
      yield* refuse(db.run("DELETE FROM context_security_namespace WHERE id='namespace'"))
      yield* refuse(db.run(sql`INSERT INTO event_validation_command VALUES ('instance','invalid-operation','rule','update',${hash},${JSON.stringify({ ...command, requestID: "invalid-operation", action: "update", investigation: { version: 1, operation: "write", epoch: 2 } })},1)`))
      const disabled = { ...current, state: "paused", revision: 3, updatedAt: 7,
        investigationAuthority: { version: 1, epoch: 2, state: "disabled", grant: null, updatedAt: 7 } }
      yield* encodeRule(db, disabled as unknown as typeof withAuthority, 2)
      yield* refuse(encodeRule(db, { ...disabled, investigationAuthority: { ...disabled.investigationAuthority, epoch: 1 } } as unknown as typeof withAuthority, 1))
      // The original physical 64KiB cap still applies to configuration plus grant.
      yield* refuse(encodeRule(db, { ...disabled, configuration: { ...oldRule.configuration, padding: "x".repeat(65536) } } as unknown as typeof withAuthority, 2))
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      expect(yield* db.get("SELECT count(*) count FROM work_execution")).toEqual({ count: 0 })
      expect(yield* db.get("SELECT count(*) count FROM session_input")).toEqual({ count: 0 })
      return yield* snapshot(db)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    const reopened = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* DatabaseMigration.applyOnly(db, selected)
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      return yield* snapshot(db)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    expect(reopened).toEqual(after)
  } finally {
    await fs.rm(directory, { recursive: true })
  }
}, 60000)
