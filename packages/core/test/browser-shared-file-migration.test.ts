import os from "node:os"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Exit, Option, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { DatabaseMigration } from "../src/database/migration"
import original from "../src/database/migration/20261007050245_managed_browser_control"
import interaction from "../src/database/migration/20261007192454_browser_interaction_profile"
import publicProfile from "../src/database/migration/20261008213543_browser_public_readonly_profile"
import files from "../src/database/migration/20261008221545_im_task_status_notice"
import fileProfile from "../src/database/migration/20261008223014_browser_file_exchange_profile"
import shared from "../src/database/migration/20261015120000_browser_shared_resource"
import current from "../src/database/migration/20261015140000_browser_shared_file_binding"
import { SharedBrowserFileSchema } from "../src/browser/shared-file-schema"
import { CanonicalJson } from "../src/util/canonical-json"
import { Hash } from "../src/util/hash"

const database = EffectDrizzleSqlite.makeWithDefaults()
type Db = Effect.Success<typeof database>
const digest = "a".repeat(64)
const hash = (input: unknown) => Hash.sha256(CanonicalJson.stringify(input))
const insert = (db: Db, table: string, row: Record<string, string | number | null>) => db.run(sql`
  INSERT INTO ${sql.identifier(table)} (${sql.join(Object.keys(row).map((key) => sql.identifier(key)), sql`,`)})
  VALUES (${sql.join(Object.values(row).map((value) => sql`${value}`), sql`,`)})`)
const snapshot = (db: Db) => Effect.all(["browser_file_grant", "browser_file_artifact", "browser_file_capacity"].map((table) =>
  db.all<Record<string, string | number | null>>(sql`SELECT * FROM ${sql.identifier(table)}`)))

const binding: SharedBrowserFileSchema.Binding = { kind: "shared-v2", resourceID: "shared-resource", rootSessionID: "session",
  mainIncarnation: "main-distinct", sidecarIncarnation: "sidecar-distinct", leaseID: "shared-lease", leaseEpoch: 1,
  manualEpoch: 0, policyHash: digest, scopeHash: digest }
const preview: SharedBrowserFileSchema.Preview = { version: 2, binding, bindingHash: hash(binding), instanceID: "instance",
  scopeHash: digest, helperHash: digest, rootIdentity: { kind: "posix", device: "1", inode: "2" },
  relative: "代码.txt", name: "代码.txt", observedAt: 1, direction: "upload", targetURL: "https://example.com/upload?once=1",
  fileIdentity: { kind: "posix", device: "1", inode: "3" }, bytes: 32, sha256: digest }
const command: SharedBrowserFileSchema.Approve = { requestID: "shared-approve", previewID: "shared-preview",
  expectedResourceRevision: 1, expectedLeaseID: binding.leaseID, expectedLeaseEpoch: 1, expectedManualEpoch: 0, expiresAt: 100 }
const grant: SharedBrowserFileSchema.Grant = { version: 2, binding, bindingHash: hash(binding), grantID: "shared-grant",
  instanceID: "instance", scopeHash: digest, command, commandHash: hash(command), preview,
  confirmation: { previewHash: hash(preview), commandHash: hash(command), confirmationHash: digest, confirmedAt: 1 },
  expiresAt: 100, createdAt: 1 }
const grantRow = (value: SharedBrowserFileSchema.Grant) => ({ grant_id: value.grantID, instance_id: value.instanceID,
  binding_version: 2, control_id: null, control_epoch: null, policy_revision: null,
  shared_resource_id: value.binding.resourceID, shared_lease_id: value.binding.leaseID,
  request_id: value.command.requestID, command_hash: value.commandHash, scope_hash: value.scopeHash,
  direction: value.preview.direction, expires_at: value.expiresAt, record: CanonicalJson.stringify(value), record_hash: hash(value), created_at: value.createdAt })

test("shared file schema stays strict, browser-compatible and distinct from v1 controls", () => {
  const prior = globalThis.Buffer
  try {
    Reflect.set(globalThis, "Buffer", undefined)
    const decode = Schema.decodeUnknownOption(SharedBrowserFileSchema.Grant, { onExcessProperty: "error" })
    expect(Option.isSome(decode(grant))).toBe(true)
    expect(Option.isNone(decode({ ...grant, controlID: "shadow-control" }))).toBe(true)
    expect(Option.isNone(decode({ ...grant, version: 1 }))).toBe(true)
    expect(Option.isNone(decode({ ...grant, binding: { ...binding, manualEpoch: "0" } }))).toBe(true)
    expect(Option.isNone(decode({ ...grant, command: { ...command, expectedLeaseID: "different-lease" } }))).toBe(true)
    expect(Option.isNone(Schema.decodeUnknownOption(SharedBrowserFileSchema.PreviewRequest)({ direction: "upload",
      relative: "../secret", targetURL: "https://example.com/upload" }))).toBe(true)
    expect(Option.isNone(Schema.decodeUnknownOption(SharedBrowserFileSchema.TargetURL)("https://user:pass@example.com/upload"))).toBe(true)
    expect(Option.isNone(Schema.decodeUnknownOption(SharedBrowserFileSchema.TargetURL)("https://example.com/upload#fragment"))).toBe(true)
  } finally { Reflect.set(globalThis, "Buffer", prior) }
})

test("same file tables migrate byte-exact under immediate FKs, roll back atomically and retain v2 FK and once boundaries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dac-shared-file-forward-"))
  const filename = path.join(root, "files.sqlite")
  try {
    const saved = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* database
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* DatabaseMigration.applyOnly(db, [original, interaction, publicProfile, files, fileProfile, shared])
      // Storage-only DDL fixtures: none of these rows creates a Native or provider capability.
      yield* db.run("CREATE TABLE im_task_request(request_id TEXT PRIMARY KEY)")
      yield* insert(db, "browser_control", { control_id: "control", request_id: "create", request_digest: digest,
        principal: "operator", security_namespace_id: "namespace", location_key: "location", project_scope_key: "project",
        namespace_binding_hash: digest, session_id: "session", project_id: "project", directory: "/private/project 中文",
        host_id: "host", host_incarnation: "sidecar-distinct", resource_id: "legacy-resource", credential_binding: digest,
        profile: "managed-loopback-exchange-v1", origin: "http://127.0.0.1:3000", revision: 1, epoch: 1, policy_revision: 1,
        state: "active", expires_at: 100, record: "{}", record_hash: digest, created_at: 1, updated_at: 1 })
      yield* insert(db, "browser_action", { action_id: "action", control_id: "control", request_id: "action-request",
        command_digest: digest, admission_id: "admission", provider_receipt_id: "receipt", provider_attempt_id: "attempt",
        tool_call_id: "tool", session_id: "session", host_incarnation: "sidecar-distinct", resource_id: "legacy-resource",
        control_epoch: 1, policy_revision: 1, revision: 1, deadline: 100, outcome: "unknown", record: "{}",
        record_hash: digest, created_at: 1, updated_at: 1 })
      yield* insert(db, "browser_file_capacity", { instance_id: "instance", grant_count: 1, artifact_count: 1,
        reserved_bytes: 20_000, metadata_bytes: 10_000, revision: 1, updated_at: 1 })
      yield* insert(db, "browser_file_grant", { grant_id: "grant", instance_id: "instance", control_id: "control",
        request_id: "approve", command_hash: digest, scope_hash: digest, control_epoch: 1, policy_revision: 1,
        direction: "upload", expires_at: 100, record_hash: digest, created_at: 1,
        record: JSON.stringify({ version: 1, grantID: "grant", instanceID: "instance", controlID: "control",
          commandHash: digest, scopeHash: digest, controlEpoch: 1, policyRevision: 1, expiresAt: 100, createdAt: 1,
          command: { requestID: "approve" }, preview: { direction: "upload" }, text: "原始\n记录" }, null, 2) })
      yield* insert(db, "browser_file_artifact", { artifact_id: "artifact", instance_id: "instance", grant_id: "grant",
        grant_hash: digest, action_id: "action", control_id: "control", scope_hash: digest, ordinal: 0, state: "unknown",
        revision: 1, reserved_bytes: 20_000, record_hash: digest, created_at: 1, updated_at: 1, released_at: null,
        record: JSON.stringify({ version: 1, artifactID: "artifact", instanceID: "instance", grantID: "grant",
          grantHash: digest, actionID: "action", controlID: "control", scopeHash: digest, ordinal: 0, state: "unknown",
          revision: 1, reservedBytes: 20_000, createdAt: 1, updatedAt: 1, releasedAt: null }, null, 2) })
      yield* db.run("CREATE INDEX local_file_audit_idx ON browser_file_grant(instance_id,direction)")
      yield* db.run("CREATE TRIGGER local_file_no_delete BEFORE DELETE ON browser_file_artifact BEGIN SELECT RAISE(ABORT,'audit retained'); END")
      const before = yield* snapshot(db)
      const failed = yield* DatabaseMigration.applyOnly(db, [{ ...current,
        up: (tx) => current.up(tx).pipe(Effect.andThen(tx.run("SELECT * FROM missing_late_shared_file_table"))),
      }]).pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      expect(yield* snapshot(db)).toEqual(before)
      expect(yield* db.all("SELECT * FROM migration WHERE id='20261015140000_browser_shared_file_binding'")).toEqual([])
      yield* DatabaseMigration.applyOnly(db, [current])
      const migrated = yield* snapshot(db)
      expect(migrated.map((rows, index) => rows.map((row) => Object.fromEntries(Object.keys(before[index][0])
        .map((key) => [key, row[key]]))))).toEqual(before)
      expect(migrated[0][0].binding_version).toBe(1)
      expect(migrated[1][0].binding_version).toBe(1)
      expect(migrated[0][0].shared_resource_id).toBe(null)
      expect(migrated[1][0].shared_action_id).toBe(null)
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      expect((yield* db.get<{ foreign_keys: number }>("PRAGMA foreign_keys"))?.foreign_keys).toBe(1)
      expect((yield* db.get<{ defer_foreign_keys: number }>("PRAGMA defer_foreign_keys"))?.defer_foreign_keys).toBe(0)
      expect(Exit.isFailure(yield* db.run("DELETE FROM browser_file_artifact WHERE artifact_id='artifact'").pipe(Effect.exit))).toBe(true)
      yield* insert(db, "browser_shared_resource", { resource_id: binding.resourceID, request_id: "shared-create", request_digest: digest,
        principal: "operator", session_id: "session", main_incarnation: binding.mainIncarnation, state: "agent_owned", revision: 1,
        manual_epoch: 0, barrier_order: 0, core_cutoff: -1, live_lease_id: binding.leaseID, record: "{}", record_hash: digest, created_at: 1, updated_at: 1 })
      yield* insert(db, "browser_shared_lease", { lease_id: binding.leaseID, resource_id: binding.resourceID, request_id: "lease-create",
        session_id: "session", main_incarnation: binding.mainIncarnation, sidecar_incarnation: binding.sidecarIncarnation,
        lease_epoch: 1, manual_epoch: 0, state: "active", origin_input_id: null, record: "{}", record_hash: digest, created_at: 1, updated_at: 1 })
      yield* insert(db, "browser_shared_action", { action_id: "shared-action", admission_id: "shared-admission", resource_id: binding.resourceID,
        lease_id: binding.leaseID, outcome: "pending", record: "{}", record_hash: digest })
      yield* insert(db, "browser_file_grant", grantRow(grant))
      const mixed = { ...grant, grantID: "mixed-binding", command: { ...command, requestID: "mixed-binding" } }
      expect(Exit.isFailure(yield* insert(db, "browser_file_grant", { ...grantRow(mixed), control_id: "control" }).pipe(Effect.exit))).toBe(true)
      const invalidLease = { ...grant, grantID: "invalid-lease", command: { ...command, requestID: "invalid-lease" },
        binding: { ...binding, leaseID: "missing-lease" } }
      expect(Exit.isFailure(yield* insert(db, "browser_file_grant", grantRow(invalidLease)).pipe(Effect.exit))).toBe(true)
      const duplicate = { ...grant, grantID: "duplicate-request" }
      expect(Exit.isFailure(yield* insert(db, "browser_file_grant", grantRow(duplicate)).pipe(Effect.exit))).toBe(true)
      yield* insert(db, "browser_shared_lease", { lease_id: "next-shared-lease", resource_id: binding.resourceID, request_id: "next-lease-create",
        session_id: "session", main_incarnation: binding.mainIncarnation, sidecar_incarnation: binding.sidecarIncarnation,
        lease_epoch: 2, manual_epoch: 1, state: "revoked", origin_input_id: null, record: "{}", record_hash: digest, created_at: 1, updated_at: 1 })
      const otherLease = { ...grant, grantID: "same-request-other-lease", binding: { ...binding, leaseID: "next-shared-lease" } }
      expect(Exit.isFailure(yield* insert(db, "browser_file_grant", grantRow(otherLease)).pipe(Effect.exit))).toBe(true)
      const artifact: SharedBrowserFileSchema.Artifact = { version: 2, binding, bindingHash: hash(binding), artifactID: "shared-artifact",
        instanceID: "instance", grantID: grant.grantID, grantHash: hash(grant), actionID: "shared-action", admissionID: "shared-admission",
        providerReceiptID: "receipt", providerAttemptID: "attempt", toolCallID: "tool", sessionID: "session", scopeHash: digest,
        ordinal: 0, manifest: preview, state: "unknown", revision: 1, reservedBytes: 64, publication: null,
        stopConfirmedAt: null, releasedAt: null, createdAt: 1, updatedAt: 1 }
      yield* insert(db, "browser_file_artifact", { artifact_id: artifact.artifactID, instance_id: "instance", grant_id: grant.grantID,
        grant_hash: hash(grant), binding_version: 2, action_id: null, control_id: null, shared_resource_id: binding.resourceID,
        shared_lease_id: binding.leaseID, shared_action_id: artifact.actionID, scope_hash: digest, ordinal: 0,
        state: "unknown", revision: 1, reserved_bytes: 64, record: CanonicalJson.stringify(artifact), record_hash: hash(artifact),
        created_at: 1, updated_at: 1, released_at: null })
      expect(Exit.isFailure(yield* db.run("UPDATE browser_file_artifact SET shared_action_id='missing-action', record=json_set(record,'$.actionID','missing-action') WHERE artifact_id='shared-artifact'")
        .pipe(Effect.exit))).toBe(true)
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      expect(yield* db.all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%browser_file%' ORDER BY name"))
        .toEqual([{ name: "browser_file_artifact" }, { name: "browser_file_capacity" }, { name: "browser_file_grant" }])
      expect((yield* snapshot(db))[2]).toEqual(before[2])
      return yield* snapshot(db)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    await Effect.runPromise(Effect.gen(function* () {
      const db = yield* database
      yield* DatabaseMigration.applyOnly(db, [current])
      expect(yield* snapshot(db)).toEqual(saved)
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      expect(yield* db.all("PRAGMA quick_check")).toEqual([{ quick_check: "ok" }])
      expect((yield* db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE name IN ('local_file_audit_idx','local_file_no_delete') ORDER BY name"))
        .map((row) => row.name)).toEqual(["local_file_audit_idx", "local_file_no_delete"])
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
