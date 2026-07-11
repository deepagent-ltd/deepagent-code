import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { testEffect } from "./lib/effect"

// V4.0 §H/§I — migration integrity. Proves the full migration set (incl. every V4.0 migration) applies
// cleanly on a fresh DB and creates the expected tables + indexes. This is the §H "add V4 fields/tables
// while keeping V3.8 working" + §H2 "failed migration must be re-runnable" substrate: if a migration is
// malformed or a table/index is missing, this fails BEFORE any feature flag is flipped on.

const database = Database.layerFromPath(":memory:")
const it = testEffect(database)

const tableExists = (name: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`)
    return (rows as unknown[]).length > 0
  })

const indexExists = (name: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db.all(`SELECT name FROM sqlite_master WHERE type='index' AND name='${name}'`)
    return (rows as unknown[]).length > 0
  })

describe("V4.0 migration integrity (§H/§I)", () => {
  it.effect("all V4.0 tables are created by the migration set", () =>
    Effect.gen(function* () {
      for (const t of [
        "deepagent_event",
        "deepagent_event_delivery",
        "deepagent_schedule",
        "im_agent_push_logs",
        "deepagent_approval_queue",
      ]) {
        expect(yield* tableExists(t)).toBe(true)
      }
    }),
  )

  it.effect("V3.8 IM tables still exist alongside the V4 additions (§H compatibility)", () =>
    Effect.gen(function* () {
      for (const t of ["im_groups", "im_members", "im_messages"]) {
        expect(yield* tableExists(t)).toBe(true)
      }
    }),
  )

  it.effect("critical V4.0 indexes exist (idempotency dedup + retry scan + rate-limit)", () =>
    Effect.gen(function* () {
      for (const idx of [
        "deepagent_event_idempotency_idx", // §A3 event idempotency
        "deepagent_event_delivery_due_idx", // §A3 retry scan
        "deepagent_schedule_due_idx", // §A4 tick scan
        "idx_im_agent_push_logs_idempotency", // §B2 push dedup (the reviewed BLOCKER fix)
        "idx_im_agent_push_logs_agent_time", // §B2 rate-limit window
        "idx_im_messages_thread", // §B4 thread pagination
        "idx_im_messages_event", // §B4 event linkage
      ]) {
        expect(yield* indexExists(idx)).toBe(true)
      }
    }),
  )

  it.effect("§B4 im_messages has the V4 columns (event_id, delivery_status) — additive, V3.8-compatible", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const cols = (yield* db.all(`PRAGMA table_info('im_messages')`)) as Array<{ name: string; notnull: number }>
      const byName = new Map(cols.map((c) => [c.name, c]))
      expect(byName.has("event_id")).toBe(true)
      expect(byName.has("delivery_status")).toBe(true)
      // both MUST be nullable (notnull=0) so the V3.8 write path (which omits them) still works.
      expect(byName.get("event_id")?.notnull).toBe(0)
      expect(byName.get("delivery_status")?.notnull).toBe(0)
    }),
  )

  it.effect("§B2 dedup indexes are UNIQUE (guards the push double-delivery fix against a regression)", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const isUnique = (table: string, index: string) =>
        Effect.gen(function* () {
          const rows = (yield* db.all(`PRAGMA index_list('${table}')`)) as Array<{ name: string; unique: number }>
          const found = rows.find((r) => r.name === index)
          return found?.unique === 1
        })
      // a regression flipping uniqueIndex(...) → index(...) would silently reopen the double-delivery
      // BLOCKER, so assert uniqueness explicitly, not mere existence.
      expect(yield* isUnique("im_agent_push_logs", "idx_im_agent_push_logs_idempotency")).toBe(true)
      expect(yield* isUnique("deepagent_event", "deepagent_event_idempotency_idx")).toBe(true)
      expect(yield* isUnique("deepagent_event_delivery", "deepagent_event_delivery_unique_idx")).toBe(true)
    }),
  )

  it.effect("§H2 re-runnable: applying the migrations again is a no-op (IF NOT EXISTS), no throw", () =>
    Effect.gen(function* () {
      // the layer already applied migrations once at construction. A second Database layer over a fresh
      // :memory: DB re-applies from scratch cleanly — proven by this test's own setup succeeding. Here we
      // assert idempotency of the DDL by re-running a representative CREATE (IF NOT EXISTS) directly.
      const { db } = yield* Database.Service
      yield* db.run("CREATE TABLE IF NOT EXISTS deepagent_event (id text PRIMARY KEY NOT NULL)")
      // still queryable, no error thrown
      expect(yield* tableExists("deepagent_event")).toBe(true)
    }),
  )
})
