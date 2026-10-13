import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { DatabaseMigration } from "../src/database/migration"
import original from "../src/database/migration/20261007050245_managed_browser_control"
import interaction from "../src/database/migration/20261007192454_browser_interaction_profile"
import publicProfile from "../src/database/migration/20261008213543_browser_public_readonly_profile"
import files from "../src/database/migration/20261008221545_im_task_status_notice"
import previous from "../src/database/migration/20261008223014_browser_file_exchange_profile"
import publicInteraction from "../src/database/migration/20261009014536_browser_public_interaction_profile"
import current from "../src/database/migration/20261009094403_browser_api_post_profile"

const database = EffectDrizzleSqlite.makeWithDefaults()
type Db = Effect.Success<typeof database>
const digest = "a".repeat(64)
const tables = ["browser_control", "browser_action", "browser_file_capacity", "browser_file_grant", "browser_file_artifact"]
const insert = (db: Db, table: string, row: Record<string, string | number | null>) => db.run(sql`
  INSERT INTO ${sql.identifier(table)} (${sql.join(Object.keys(row).map((key) => sql.identifier(key)), sql`,`)})
  VALUES (${sql.join(Object.values(row).map((value) => sql`${value}`), sql`,`)})`)
const snapshot = (db: Db) => Effect.all(tables.map((table) => db.all(sql`SELECT * FROM ${sql.identifier(table)}`)))

test("api-post forward preserves populated RESTRICT children, audit objects and every record through rollback and file reopen", async () => {
  const root = await fs.mkdtemp("/tmp/dac-api-post-forward-")
  const filename = path.join(root, "profile.sqlite")
  try {
    const saved = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* database
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* DatabaseMigration.applyOnly(db, [original, interaction, publicProfile, files, previous, publicInteraction])
      // This is a storage-only DDL oracle. No row below grants execution authority.
      yield* db.run("CREATE TABLE im_task_request(request_id TEXT PRIMARY KEY)")
      yield* insert(db, "browser_control", { control_id: "control", request_id: "create", request_digest: digest,
        principal: "operator", security_namespace_id: "namespace", location_key: "location", project_scope_key: "project",
        namespace_binding_hash: digest, session_id: "session", project_id: "project", directory: "/private/project 中文",
        host_id: "host", host_incarnation: "incarnation", resource_id: "resource", credential_binding: digest,
        profile: "managed-loopback-preview-v1", origin: "http://127.0.0.1:3000", revision: 1, epoch: 1, policy_revision: 1,
        state: "active", expires_at: 100, record: '{"version":1,"text":"原始\\n记录"}', record_hash: digest, created_at: 1, updated_at: 1 })
      const originalRow = yield* db.get<Record<string, string | number | null>>("SELECT * FROM browser_control WHERE control_id='control'")
      if (!originalRow) return yield* Effect.fail(new Error("Missing storage fixture control"))
      yield* Effect.forEach(["managed-loopback-interaction-v1", "managed-public-readonly-v1", "managed-loopback-exchange-v1", "managed-public-interaction-v1"],
        (profile, ordinal) => insert(db, "browser_control", { ...originalRow, control_id: `old-${ordinal}`,
          request_id: `old-request-${ordinal}`, resource_id: `old-resource-${ordinal}`, profile }), { discard: true })
      yield* insert(db, "browser_action", { action_id: "action", control_id: "control", request_id: "action-request",
        command_digest: digest, admission_id: "admission", provider_receipt_id: "receipt", provider_attempt_id: "attempt",
        tool_call_id: "tool", session_id: "session", host_incarnation: "incarnation", resource_id: "resource",
        control_epoch: 1, policy_revision: 1, revision: 1, deadline: 100, outcome: "unknown", record: "{}",
        record_hash: digest, created_at: 1, updated_at: 1 })
      yield* insert(db, "browser_file_capacity", { instance_id: "instance", grant_count: 1, artifact_count: 1,
        reserved_bytes: 20_000, metadata_bytes: 10_000, revision: 1, updated_at: 1 })
      yield* insert(db, "browser_file_grant", { grant_id: "grant", instance_id: "instance", control_id: "control",
        request_id: "approve", command_hash: digest, scope_hash: digest, control_epoch: 1, policy_revision: 1,
        direction: "upload", expires_at: 100, record_hash: digest, created_at: 1,
        record: JSON.stringify({ version: 1, grantID: "grant", instanceID: "instance", controlID: "control",
          commandHash: digest, scopeHash: digest, controlEpoch: 1, policyRevision: 1, expiresAt: 100, createdAt: 1,
          command: { requestID: "approve" }, preview: { direction: "upload" } }) })
      yield* insert(db, "browser_file_artifact", { artifact_id: "artifact", instance_id: "instance", grant_id: "grant",
        grant_hash: digest, action_id: "action", control_id: "control", scope_hash: digest, ordinal: 0, state: "unknown",
        revision: 1, reserved_bytes: 20_000, record_hash: digest, created_at: 1, updated_at: 1, released_at: null,
        record: JSON.stringify({ version: 1, artifactID: "artifact", instanceID: "instance", grantID: "grant",
          grantHash: digest, actionID: "action", controlID: "control", scopeHash: digest, ordinal: 0, state: "unknown",
          revision: 1, reservedBytes: 20_000, createdAt: 1, updatedAt: 1, releasedAt: null }) })
      yield* db.run("CREATE INDEX local_browser_audit_idx ON browser_control(directory,revision)")
      yield* db.run("CREATE TRIGGER local_browser_no_delete BEFORE DELETE ON browser_control BEGIN SELECT RAISE(ABORT,'audit retained'); END")
      const before = yield* snapshot(db)
      const failed = yield* DatabaseMigration.applyOnly(db, [{ ...current,
        up: (tx) => current.up(tx).pipe(Effect.andThen(tx.run("SELECT * FROM missing_late_file_profile_table"))),
      }]).pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBeTrue()
      expect(yield* snapshot(db)).toEqual(before)
      expect(yield* db.all("SELECT * FROM migration WHERE id='20261009094403_browser_api_post_profile'")).toEqual([])
      yield* DatabaseMigration.applyOnly(db, [current])
      expect(yield* snapshot(db)).toEqual(before)
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      expect((yield* db.get<{ foreign_keys: number }>("PRAGMA foreign_keys"))?.foreign_keys).toBe(1)
      expect((yield* db.get<{ defer_foreign_keys: number }>("PRAGMA defer_foreign_keys"))?.defer_foreign_keys).toBe(0)
      yield* db.run("UPDATE browser_control SET profile='managed-public-api-v1' WHERE control_id='control'")
      expect((yield* db.get<{ profile: string }>("SELECT profile FROM browser_control WHERE control_id='control'"))?.profile)
        .toBe("managed-public-api-v1")
      yield* db.run("UPDATE browser_control SET profile='managed-loopback-preview-v1' WHERE control_id='control'")
      expect(yield* snapshot(db)).toEqual(before)
      return before
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    await Effect.runPromise(Effect.gen(function* () {
      const db = yield* database
      yield* DatabaseMigration.applyOnly(db, [current])
      expect(yield* snapshot(db)).toEqual(saved)
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      expect(yield* db.all("PRAGMA quick_check")).toEqual([{ quick_check: "ok" }])
      expect((yield* db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE name IN ('local_browser_audit_idx','local_browser_no_delete') ORDER BY name"))
        .map((row) => row.name)).toEqual(["local_browser_audit_idx", "local_browser_no_delete"])
      expect(Exit.isFailure(yield* db.run("DELETE FROM browser_control WHERE control_id='control'").pipe(Effect.exit))).toBeTrue()
      expect(yield* snapshot(db)).toEqual(saved)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
