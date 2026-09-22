import { afterEach, expect, test } from "bun:test"
import { Database } from "@deepagent-code/core/database/database"
import { Backup } from "@deepagent-code/core/database/backup"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import { Database as BunDatabase } from "bun:sqlite"
import { Flag } from "@deepagent-code/core/flag/flag"
import { Effect } from "effect"
import path from "node:path"
import fs from "node:fs/promises"
import { Server } from "../../src/server/server"
import { MaintenancePaths } from "../../src/server/routes/instance/httpapi/groups/maintenance"
import { tmpdir } from "../fixture/fixture"
import { seedIndeterminateProviderAuthority } from "../fixture/provider-recovery"

const originalDatabase = Flag.DEEPAGENT_CODE_DB
const originalPassword = process.env.DEEPAGENT_CODE_SERVER_PASSWORD

afterEach(() => {
  Flag.DEEPAGENT_CODE_DB = originalDatabase
  if (originalPassword === undefined) delete process.env.DEEPAGENT_CODE_SERVER_PASSWORD
  else process.env.DEEPAGENT_CODE_SERVER_PASSWORD = originalPassword
})

test("a non-ready store starts only the authenticated read-only maintenance shell", async () => {
  await using root = await tmpdir()
  const filename = path.join(root.path, "maintenance-boot.db")
  const authority = await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db.run("UPDATE event_sync_backfill SET completed_at = NULL WHERE id = 1")
      return yield* seedIndeterminateProviderAuthority(database.db, {
        sessionId: "ses_incident_recovery",
        activityId: "act_incident_recovery",
        attemptId: "att_incident_recovery",
        requestHash: "i".repeat(64),
      })
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )

  Flag.DEEPAGENT_CODE_DB = filename
  process.env.DEEPAGENT_CODE_SERVER_PASSWORD = "maintenance-secret"
  const state = await Database.bootstrap(filename)
  expect(state.mode).toBe("read_only_recovery")
  expect(state.diagnostics.stableCode).toBe("startup_inventory_unclassified")

  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    const unauthorized = await fetch(new URL(MaintenancePaths.bootstrapStatus, listener.url))
    expect(unauthorized.status).toBe(401)
    const headers = {
      authorization: `Basic ${btoa("deepagent-code:maintenance-secret")}`,
    }
    const status = await fetch(new URL(MaintenancePaths.bootstrapStatus, listener.url), { headers })
    const statusBody = await status.json()
    expect({ status: status.status, body: statusBody }).toMatchObject({ status: 423 })
    expect(statusBody).toMatchObject({
      name: "ApiLocked",
      data: {
        code: "upgrade_run_recovery_required",
        actual: "read_only_recovery",
      },
    })

    const exportResponse = await fetch(
      new URL(`${MaintenancePaths.recoveryEvidenceExport}?export_id=missing`, listener.url),
      { headers },
    )
    expect(exportResponse.status).toBe(503)
    expect(await exportResponse.json()).toMatchObject({
      name: "ApiUnavailable",
      data: { code: "recovery_evidence_export_unavailable" },
    })

    const recovered = await fetch(new URL(MaintenancePaths.recoveryCommand, listener.url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        session_id: authority.attempt.sessionId,
        attempt_id: authority.attempt.attemptId,
        request_hash: authority.attempt.requestHash,
        actor_type: "user",
        actor_id: "incident-operator",
      }),
    })
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toMatchObject({ descriptor: { descriptorKind: "resolvable_exact" } })

    const business = await fetch(new URL("/session", listener.url), { headers })
    expect(business.status).toBe(404)
  } finally {
    await listener.stop(true)
  }
  const recovered = new BunDatabase(filename, { readonly: true })
  try {
    expect(recovered.query("SELECT state FROM session_provider_attempt WHERE attempt_id = ?").get(authority.attempt.attemptId)).toEqual({
      state: "resolved_abandoned",
    })
  } finally {
    recovered.close()
  }
})

test("the ready runtime abandons one exact indeterminate provider attempt through the maintenance API", async () => {
  await using root = await tmpdir()
  const filename = path.join(root.path, "provider-recovery.db")
  const authority = await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      return yield* seedIndeterminateProviderAuthority(database.db, {
        sessionId: "ses_http_recovery",
        activityId: "act_http_recovery",
        attemptId: "att_http_recovery",
        requestHash: "h".repeat(64),
      })
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )

  Flag.DEEPAGENT_CODE_DB = filename
  process.env.DEEPAGENT_CODE_SERVER_PASSWORD = "maintenance-secret"
  // A classified recovery item locks only its Session (§9.3); it is not an
  // unclassified global-integrity fault, so other Sessions remain available.
  expect(await Database.bootstrap(filename)).toMatchObject({ mode: "ready", ready: true })

  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  let commandId = ""
  try {
    const before = new BunDatabase(filename, { readonly: true })
    try {
      expect(before.query("SELECT state FROM session_activity WHERE activity_id = ?").get(authority.attempt.activityId)).toEqual({ state: "active" })
    } finally {
      before.close()
    }
    const response = await fetch(new URL(MaintenancePaths.recoveryCommand, listener.url), {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa("deepagent-code:maintenance-secret")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_id: authority.attempt.sessionId,
        attempt_id: authority.attempt.attemptId,
        request_hash: authority.attempt.requestHash,
        actor_type: "user",
        actor_id: "http-operator",
        activity_id: authority.attempt.activityId,
        provider_id: authority.attempt.providerId,
      }),
    })
    const body = await response.json()
    expect({ status: response.status, body }).toMatchObject({ status: 200 })
    expect(body).toMatchObject({
      descriptor: { descriptorKind: "resolvable_exact" },
    })
    commandId = body.command_id
  } finally {
    await listener.stop(true)
  }

  const database = new BunDatabase(filename, { readonly: true })
  try {
    expect({
      attempt: database.query("SELECT state, attempt_version FROM session_provider_attempt WHERE attempt_id = ?").get(authority.attempt.attemptId),
      receipt: database.query("SELECT state FROM session_v2_provider_turn_receipt WHERE receipt_id = ?").get(authority.receiptId),
      activity: database.query("SELECT state FROM session_activity WHERE activity_id = ?").get(authority.attempt.activityId),
      command: database.query("SELECT state, actor_type, actor_id FROM recovery_command WHERE command_id = ?").get(commandId),
      bridge: database.query("SELECT attempt_id, receipt_id FROM session_v2_provider_recovery_bridge WHERE command_id = ?").get(commandId),
      session: database.query("SELECT execution_claim_token FROM session WHERE id = ?").get(authority.attempt.sessionId),
    }).toEqual({
      attempt: { state: "resolved_abandoned", attempt_version: 4 },
      // The original receipt remains immutable evidence of the unknown provider outcome;
      // the bridge + resolved attempt carry the local abandon decision.
      receipt: { state: "indeterminate_after_crash" },
      activity: { state: "interrupted" },
      command: { state: "abandoned", actor_type: "user", actor_id: "http-operator" },
      bridge: { attempt_id: authority.attempt.attemptId, receipt_id: authority.receiptId },
      session: { execution_claim_token: null },
    })
  } finally {
    database.close()
  }
  expect(await Database.bootstrap(filename)).toMatchObject({ mode: "ready", ready: true })
}, 60_000)

test("an unreadable schema still starts the bootstrap-only incident shell", async () => {
  await using root = await tmpdir()
  const filename = path.join(root.path, "blocked-schema.db")
  await Bun.write(filename, "not a sqlite database")
  Flag.DEEPAGENT_CODE_DB = filename
  process.env.DEEPAGENT_CODE_SERVER_PASSWORD = "maintenance-secret"

  const state = await Database.bootstrap(filename)
  expect(state.mode).toBe("blocked_schema")
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    const headers = {
      authorization: `Basic ${btoa("deepagent-code:maintenance-secret")}`,
    }
    const status = await fetch(new URL(MaintenancePaths.bootstrapStatus, listener.url), { headers })
    expect(status.status).toBe(423)
    expect(await status.json()).toMatchObject({
      name: "ApiLocked",
      data: {
        code: "database_preflight_failed",
        actual: "blocked_schema",
      },
    })
    const backups = await fetch(new URL(MaintenancePaths.backupList, listener.url), { headers })
    expect(backups.status).toBe(200)
    expect(await backups.json()).toEqual({ backups: [], count: 0 })
    expect((await fetch(new URL("/session", listener.url), { headers })).status).toBe(404)
  } finally {
    await listener.stop(true)
  }
})

test("the blocked-schema shell restores a verified backup while the business database is closed", async () => {
  await using root = await tmpdir()
  const filename = path.join(root.path, "restore-target.db")
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db.run("CREATE TABLE restore_marker (value TEXT NOT NULL)")
      yield* database.db.run("INSERT INTO restore_marker VALUES ('known-good')")
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )
  const backupDir = path.join(root.path, "backups")
  await fs.mkdir(backupDir)
  const manifest = await Effect.runPromise(
    Backup.create({ sourcePath: filename, destDir: backupDir, buildId: "maintenance-http-test" }),
  )
  await Bun.write(filename, "not a sqlite database")
  await fs.rm(`${filename}-wal`, { force: true })
  await fs.rm(`${filename}-shm`, { force: true })

  Flag.DEEPAGENT_CODE_DB = filename
  process.env.DEEPAGENT_CODE_SERVER_PASSWORD = "maintenance-secret"
  expect((await Database.bootstrap(filename)).mode).toBe("blocked_schema")
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    const headers = {
      authorization: `Basic ${btoa("deepagent-code:maintenance-secret")}`,
      "content-type": "application/json",
    }
    const listed = await fetch(new URL(MaintenancePaths.backupList, listener.url), { headers })
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({ count: 1 })

    const restored = await fetch(new URL(MaintenancePaths.backupRestore, listener.url), {
      method: "POST",
      headers,
      body: JSON.stringify({
        backup_manifest_ref: Backup.manifestPathFor(manifest.backup.filePath),
        target: filename,
        dry_run: false,
      }),
    })
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({ status: "restored", inProgress: false })
  } finally {
    await listener.stop(true)
  }

  expect((await Database.bootstrap(filename)).mode).toBe("ready")
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      expect(yield* database.db.get("SELECT value FROM restore_marker")).toEqual({ value: "known-good" })
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )
}, 60_000)

test("a backup failure during full runtime construction falls back to the incident shell", async () => {
  await using root = await tmpdir()
  const filename = path.join(root.path, "backup-fallback.db")
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* Database.Service
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )
  const latest = migrations.at(-1)!.id
  const seeded = new BunDatabase(filename)
  seeded.query("DELETE FROM migration WHERE id = ?").run(latest)
  seeded.close()
  await Bun.write(path.join(root.path, "backups"), "not a directory")
  expect(await Database.bootstrap(filename)).toMatchObject({ mode: "ready", phase: "backup_required" })

  Flag.DEEPAGENT_CODE_DB = filename
  process.env.DEEPAGENT_CODE_SERVER_PASSWORD = "maintenance-secret"
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    const headers = {
      authorization: `Basic ${btoa("deepagent-code:maintenance-secret")}`,
    }
    const status = await fetch(new URL(MaintenancePaths.bootstrapStatus, listener.url), { headers })
    expect(status.status).toBe(423)
    expect(await status.json()).toMatchObject({
      data: { code: "database_preflight_failed", actual: "blocked_schema" },
    })
    expect((await fetch(new URL("/session", listener.url), { headers })).status).toBe(404)
  } finally {
    await listener.stop(true)
  }
  const untouched = new BunDatabase(filename, { readonly: true })
  expect(untouched.query("SELECT id FROM migration WHERE id = ?").get(latest)).toBeNull()
  untouched.close()
}, 60_000)
