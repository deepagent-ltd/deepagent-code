import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Database } from "@deepagent-code/core/database/database"
import type { BootstrapState } from "@deepagent-code/core/database/bootstrap"
import { Backup } from "@deepagent-code/core/database/backup"
import { BackupVerify } from "@deepagent-code/core/database/backup-verify"
import { DatabaseUpgradeRun } from "@deepagent-code/core/database/upgrade-run"
import { SessionProviderRecovery } from "@deepagent-code/core/session/runner"
import { MaintenanceApi } from "../groups/maintenance"
import { makeApiError, type ApiTypedError } from "../typed-error"
import { Service as MaintenanceRegistryService } from "../maintenance-registry"
import type { MaintenanceRegistry } from "../maintenance-registry"

// C6-01 maintenance handlers (design §11.1). Domain services stay free of HttpApi
// types: expected domain outcomes are translated at the handler boundary into the
// C0-03 `ApiTypedError` envelope. Client decisions use `code`, never `message`.

// -- pure bootstrap->HTTP error mapping (unit-testable, no DB needed) ----------

/**
 * Map a BootstrapState to a C0-03 typed error ONLY when the store is not writable.
 * Returns `undefined` when `mode === "ready"` (caller responds 200).
 *   read_only_recovery -> 423 upgrade_run_recovery_required (indeterminate / operator action)
 *   blocked_schema     -> 423 database_preflight_failed, or 503 database_open_failed
 *                         when the preflight could not even open the DB.
 */
export function mapBootstrapStateToError(state: BootstrapState, resource: string): ApiTypedError | undefined {
  if (state.mode === "ready") return undefined
  if (state.mode === "read_only_recovery") {
    return makeApiError("upgrade_run_recovery_required", {
      resource,
      correlationId: state.diagnostics.correlationId,
      expected: "ready",
      actual: state.mode,
    })
  }
  // blocked_schema
  const code = state.diagnostics.stableCode === "db_open_failed" ? "database_open_failed" : "database_preflight_failed"
  return makeApiError(code, {
    resource,
    correlationId: state.diagnostics.correlationId,
    expected: "ready",
    actual: state.mode,
  })
}

/** Restore blocked-mode mapping: a non-ready store refuses install (design §10.9). */
export function mapRestoreModeToError(state: BootstrapState, resource: string): ApiTypedError {
  return makeApiError("database_preflight_failed", {
    resource,
    correlationId: state.diagnostics.correlationId,
    expected: "ready",
    actual: state.mode,
  })
}

/** Read + structurally validate a backup manifest, mapping ANY problem to a typed 404. */
const readManifestOrMissing = (manifestPath: string): Effect.Effect<Backup.BackupManifest, ApiTypedError, never> =>
  Backup.readManifest(manifestPath).pipe(
    Effect.catchCause(() =>
      Effect.fail(makeApiError("backup_manifest_missing", { resource: manifestPath })),
    ),
  )

/** Map the snake_case DB receipt rows to the camelCase wire schema. */
const toReceiptRow = (row: DatabaseUpgradeRun.ReceiptRow) => ({
  receiptId: row.receipt_id,
  migrationId: row.migration_id,
  contentHash: row.content_hash,
  ordinal: row.ordinal,
  runId: row.run_id,
  result: row.result,
  startedAt: row.started_at,
  completedAt: row.completed_at,
})

export const maintenanceHandlers = HttpApiBuilder.group(MaintenanceApi, "maintenance", (handlers) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const registry: MaintenanceRegistry = yield* MaintenanceRegistryService

    const readState = (): BootstrapState | undefined => database.mode

    const getBootstrapStatus = Effect.fn("MaintenanceHttpApi.bootstrapStatus")(function* () {
      const state = readState()
      if (!state) {
        const filename = Database.path()
        const boot = yield* Effect.tryPromise({
          try: () => Database.bootstrap(filename),
          catch: () => makeApiError("internal_error", { resource: "database" }),
        })
        const error = mapBootstrapStateToError(boot, "database")
        if (error) return yield* Effect.fail(error)
        return boot
      }
      const error = mapBootstrapStateToError(state, "database")
      if (error) return yield* Effect.fail(error)
      return state
    })

    const listBackups = Effect.fn("MaintenanceHttpApi.backupList")(function* (ctx: { query: { dir?: string } }) {
      const dir = ctx.query.dir ?? path.join(path.dirname(Database.path()), "backups")
      const entries = yield* Effect.tryPromise(() => fs.readdir(dir)).pipe(Effect.orElseSucceed(() => [] as string[]))
      const backups = yield* Effect.forEach(
        entries
          .filter((entry) => entry.endsWith(".manifest.json"))
          .map((entry) => path.join(dir, entry)),
        (manifestPath) =>
          readManifestOrMissing(manifestPath).pipe(
            Effect.match({
              onFailure: () => undefined,
              onSuccess: (manifest) => ({
                fileName: manifest.backup.fileName,
                filePath: manifest.backup.filePath,
                sizeBytes: manifest.backup.sizeBytes,
                sha256: manifest.backup.sha256,
                createdAt: manifest.backup.createdAt,
              }),
            }),
          ),
        { concurrency: "unbounded" },
      )
      const list = backups.filter((backup): backup is NonNullable<typeof backup> => backup !== undefined)
      return { backups: list, count: list.length }
    })

    const verifyBackup = Effect.fn("MaintenanceHttpApi.backupVerify")(function* (ctx: {
      query: { manifest_path: string }
    }) {
      const { manifest_path: manifestPath } = ctx.query
      const manifest = yield* readManifestOrMissing(manifestPath)
      return yield* BackupVerify.verify(manifest)
    })

    const restoreBackup = Effect.fn("MaintenanceHttpApi.backupRestore")(function* (ctx: {
      payload: { backup_manifest_ref: string; target?: string; dry_run?: boolean }
    }) {
      const { backup_manifest_ref: manifestRef, dry_run } = ctx.payload
      const state = readState()
      if (state && state.mode !== "ready") return yield* Effect.fail(mapRestoreModeToError(state, manifestRef))

      const inProgress = yield* registry.restore
      if (inProgress.inProgress) {
        return yield* Effect.fail(
          makeApiError("restore_target_not_quarantined", {
            resource: manifestRef,
            expected: "no_restore_in_progress",
            actual: inProgress.restoreId ?? "in_progress",
          }),
        )
      }

      const stat = yield* Effect.tryPromise(() => fs.stat(manifestRef)).pipe(Effect.orElseSucceed(() => null))
      if (stat === null) {
        return yield* Effect.fail(makeApiError("backup_manifest_missing", { resource: manifestRef }))
      }

      // Fixture-gated dry-run/status surface (this lane): a `dry_run:false` request
      // records restore-in-progress so a concurrent restore is a 409 (the actual
      // install is a service call owned by C1A-13, not this endpoint).
      let restoreStatus: { inProgress: boolean; restoreId?: string; sourceFile?: string }
      if (dry_run === false) {
        const started = yield* registry.setRestoreInProgress({ sourceFile: manifestRef })
        restoreStatus = started
      } else {
        restoreStatus = { inProgress: false }
      }

      return {
        status: "dry_run" as const,
        inProgress: restoreStatus.inProgress,
        ...(restoreStatus.restoreId ? { restoreId: restoreStatus.restoreId } : {}),
        ...(restoreStatus.sourceFile ? { sourceFile: restoreStatus.sourceFile } : {}),
        message: "Restore is a fixture-gated dry-run/status surface in this lane; install is a service call.",
      }
    })

    const upgradeStatus = Effect.fn("MaintenanceHttpApi.upgradeStatus")(function* () {
      const active = yield* DatabaseUpgradeRun.loadActiveRun(database.db)
      const receipts = active
        ? yield* DatabaseUpgradeRun.loadReceiptsForRun(database.db, active.runId)
        : []
      return { active: active !== undefined, run: active ?? undefined, receipts: receipts.map(toReceiptRow), count: receipts.length }
    })

    const recoveryList = Effect.fn("MaintenanceHttpApi.recoveryList")(function* (ctx: {
      query: { session_id: string }
    }) {
      const records = yield* registry.listBySession(ctx.query.session_id)
      return { descriptors: records.map((record) => record.descriptor), count: records.length }
    })

    const recoveryCommand = Effect.fn("MaintenanceHttpApi.recoveryCommand")(function* (ctx: {
      payload: {
        session_id: string
        attempt_id: string
        request_hash: string
        actor_type: "user" | "administrator" | "system"
        actor_id: string
        activity_id?: string
        provider_id?: string
      }
    }) {
      const payload = ctx.payload
      const attemptIdentity = {
        sessionId: payload.session_id,
        activityId: payload.activity_id ?? "",
        attemptId: payload.attempt_id,
        providerTurnSeq: 0,
        selectionId: "",
        projectionHash: payload.request_hash,
        requestHash: payload.request_hash,
        providerId: payload.provider_id ?? "",
      }

      // Network-unknown path: if a settled evidence already exists for this request
      // hash the attempt may have dispatched — the user is NOT offered abandon (410).
      const settled = yield* registry.getByRequestHash(payload.request_hash)
      if (settled?.evidenceStatus === "settled") {
        return yield* Effect.fail(
          makeApiError("recovery_terminal_bridge_missing", {
            resource: payload.request_hash,
            expected: "pending",
            actual: "settled",
          }),
        )
      }

      const descriptor = SessionProviderRecovery.classify({
        attempt: attemptIdentity,
        attemptState: "indeterminate_after_crash",
        expectedAttemptState: "indeterminate_after_crash",
        ownerToken: "",
        expectedVersion: 0,
        historyVerified: true,
        providerLookupComplete: true,
        placementUnresolved: false,
        permissionIncomplete: false,
        workspaceConflict: false,
      })

      const required = SessionProviderRecovery.requiredPermissionFor(descriptor.descriptorKind)
      yield* SessionProviderRecovery.assertPermission({ type: payload.actor_type }, required).pipe(
        Effect.mapError(() =>
          makeApiError("permission_denied", {
            resource: payload.session_id,
            expected: required,
            actual: payload.actor_type,
          }),
        ),
      )

      const commandId = SessionProviderRecovery.recoveryCommandContentAddress({
        requestHash: payload.request_hash,
        attemptIdentity,
      })
      yield* registry.record({
        commandId,
        sessionId: payload.session_id,
        attemptId: payload.attempt_id,
        requestHash: payload.request_hash,
        descriptor,
        actorType: payload.actor_type,
        actorId: payload.actor_id,
        createdAt: Date.now(),
      })

      return { command_id: commandId, descriptor }
    })

    const recoveryCommandGet = Effect.fn("MaintenanceHttpApi.recoveryCommandGet")(function* (ctx: {
      query: { command_id: string }
    }) {
      const record = yield* registry.getRecord(ctx.query.command_id)
      if (!record) {
        return yield* Effect.fail(makeApiError("resource_not_found", { resource: ctx.query.command_id }))
      }
      return record
    })

    const recoveryEvidenceExportCreate = Effect.fn("MaintenanceHttpApi.recoveryEvidenceExportCreate")(function* (ctx: {
      payload: { session_id: string }
    }) {
      const manifest = yield* registry.createExport({
        sessionId: ctx.payload.session_id,
        contentHash: `sha256:${ctx.payload.session_id}`,
      })
      return manifest
    })

    const recoveryEvidenceExportGet = Effect.fn("MaintenanceHttpApi.recoveryEvidenceExport")(function* (ctx: {
      query: { export_id: string }
    }) {
      const exportRecord = yield* registry.getExport(ctx.query.export_id)
      if (!exportRecord) {
        return yield* Effect.fail(makeApiError("resource_not_found", { resource: ctx.query.export_id }))
      }
      if (Date.now() > exportRecord.expiresAt) {
        return yield* Effect.fail(
          makeApiError("recovery_terminal_bridge_missing", {
            resource: ctx.query.export_id,
            expected: "not_expired",
            actual: "expired",
          }),
        )
      }
      return exportRecord
    })

    return handlers
      .handle("bootstrapStatus", getBootstrapStatus)
      .handle("backupList", listBackups)
      .handle("backupVerify", verifyBackup)
      .handle("backupRestore", restoreBackup)
      .handle("upgradeStatus", upgradeStatus)
      .handle("recoveryList", recoveryList)
      .handle("recoveryCommand", recoveryCommand)
      .handle("recoveryCommandGet", recoveryCommandGet)
      .handle("recoveryEvidenceExportCreate", recoveryEvidenceExportCreate)
      .handle("recoveryEvidenceExport", recoveryEvidenceExportGet)
  }),
)
