import { Cause, Effect, Layer, Ref } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseBootstrapError, type BootstrapState } from "@deepagent-code/core/database/bootstrap"
import { Backup } from "@deepagent-code/core/database/backup"
import { Restore } from "@deepagent-code/core/database/restore"
import { BackupVerify } from "@deepagent-code/core/database/backup-verify"
import { DatabaseUpgradeRun } from "@deepagent-code/core/database/upgrade-run"
import { SessionProviderRecovery, SessionProviderRecoveryDurable } from "@deepagent-code/core/session/runner"
import { SessionProviderAttemptTable } from "@deepagent-code/core/context-federation/session-sql"
import { V2ProviderTurnReceiptTable } from "@deepagent-code/core/session/runner/v2-provider-turn.sql"
import { and, eq } from "drizzle-orm"
import { InstanceHttpApi } from "../api"
import { MaintenanceApi, MaintenancePaths } from "../groups/maintenance"
import { CompositionDigest } from "@/effect/composition-digest"
import { makeApiError, type ApiTypedError } from "../typed-error"
import { Service as MaintenanceRegistryService, layer } from "../maintenance-registry"
import type { MaintenanceRegistry } from "../maintenance-registry"
import { RecoveryExecutor } from "@/server/recovery-executor"

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

/** An active owner is the only bootstrap state that forbids an incident-shell restore. */
export function mapRestoreModeToError(state: BootstrapState, resource: string): ApiTypedError {
  return makeApiError(
    state.diagnostics.stableCode === "another_process_active"
      ? "restore_target_not_quarantined"
      : "database_preflight_failed",
    {
      resource,
      correlationId: state.diagnostics.correlationId,
      expected: "exclusive maintenance ownership",
      actual: state.diagnostics.stableCode,
    },
  )
}

/**
 * G7i security F2 — the maintenance backup surface only ever reads under the instance DB
 * directory's `backups` root. A client-supplied dir/manifest/ref path outside that root is a
 * typed refusal (never an arbitrary filesystem read).
 */
const backupsRoot = (filename = Database.path()) => path.resolve(path.join(path.dirname(filename), "backups"))

function withinBackups(input: string, filename = Database.path()): string | undefined {
  const resolved = path.resolve(input)
  return resolved === backupsRoot(filename) || resolved.startsWith(backupsRoot(filename) + path.sep)
    ? resolved
    : undefined
}

/** Read + structurally validate a backup manifest, mapping ANY problem to a typed 404. */
const readManifestOrMissing = (manifestPath: string): Effect.Effect<Backup.BackupManifest, ApiTypedError, never> =>
  Backup.readManifest(manifestPath).pipe(
    Effect.catchCause(() => Effect.fail(makeApiError("backup_manifest_missing", { resource: manifestPath }))),
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

const maintenanceOperations = (
  options: {
    readonly allowRecoveryWrite?: boolean
    readonly executeRecovery?: boolean
  } = {},
) =>
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
      const requested = ctx.query.dir ?? backupsRoot()
      const dir = withinBackups(requested)
      if (dir === undefined) {
        return yield* Effect.fail(
          makeApiError("validation_failed", {
            resource: requested,
            expected: "path under the backups root",
            actual: requested,
          }),
        )
      }
      const entries = yield* Effect.tryPromise(() => fs.readdir(dir)).pipe(Effect.orElseSucceed(() => [] as string[]))
      const backups = yield* Effect.forEach(
        entries.filter((entry) => entry.endsWith(".manifest.json")).map((entry) => path.join(dir, entry)),
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
        { concurrency: 16 },
      )
      const list = backups.filter((backup): backup is NonNullable<typeof backup> => backup !== undefined)
      return { backups: list, count: list.length }
    })

    const verifyBackup = Effect.fn("MaintenanceHttpApi.backupVerify")(function* (ctx: {
      query: { manifest_path: string }
    }) {
      const { manifest_path: manifestPath } = ctx.query
      const resolved = withinBackups(manifestPath)
      if (resolved === undefined) {
        return yield* Effect.fail(
          makeApiError("validation_failed", {
            resource: manifestPath,
            expected: "path under the backups root",
            actual: manifestPath,
          }),
        )
      }
      const manifest = yield* readManifestOrMissing(resolved)
      return yield* BackupVerify.verify(manifest)
    })

    const restoreBackup = Effect.fn("MaintenanceHttpApi.backupRestore")(function* (ctx: {
      payload: { backup_manifest_ref: string; target?: string; dry_run?: boolean }
    }) {
      const { backup_manifest_ref: manifestRef, dry_run, target } = ctx.payload
      const resolved = withinBackups(manifestRef)
      if (resolved === undefined) {
        return yield* Effect.fail(
          makeApiError("validation_failed", {
            resource: manifestRef,
            expected: "path under the backups root",
            actual: manifestRef,
          }),
        )
      }
      const state = readState()
      const dbPath = path.resolve(Database.path())
      if (target !== undefined && path.resolve(target) !== dbPath)
        return yield* Effect.fail(
          makeApiError("validation_failed", { resource: target, expected: dbPath, actual: path.resolve(target) }),
        )
      if (state?.mode === "ready" && dry_run === false)
        return yield* Effect.fail(
          makeApiError("restore_target_not_quarantined", {
            resource: dbPath,
            expected: "maintenance shell with no business database connection",
            actual: "active business runtime",
          }),
        )

      const inProgress = yield* registry.restore
      if (inProgress.inProgress) {
        return yield* Effect.fail(
          makeApiError("restore_target_not_quarantined", {
            resource: resolved,
            expected: "no_restore_in_progress",
            actual: inProgress.restoreId ?? "in_progress",
          }),
        )
      }

      const stat = yield* Effect.tryPromise(() => fs.stat(resolved)).pipe(Effect.orElseSucceed(() => null))
      if (stat === null) {
        return yield* Effect.fail(makeApiError("backup_manifest_missing", { resource: resolved }))
      }

      const manifest = yield* readManifestOrMissing(resolved)
      const verification = yield* BackupVerify.verify(manifest)
      if (!verification.ok)
        return yield* Effect.fail(
          makeApiError("restore_failed", {
            resource: resolved,
            expected: "verified backup",
            actual: verification.reason,
          }),
        )

      // A `dry_run:false` request performs the REAL verified restore (C1A-13 service call:
      // verify-before-install + atomic install + forward-migrate, with the incident set retained
      // on any failure). The in-progress flag is ALWAYS cleared (ensuring) so a restore can
      // never 409-stick; a dry_run request is the status-only probe.
      if (dry_run === false) {
        const started = yield* registry.setRestoreInProgress({ sourceFile: resolved })
        const outcome = yield* Effect.gen(function* () {
          return yield* Restore.restoreVerified({ dbPath, backup: manifest })
        }).pipe(
          Effect.ensuring(registry.clearRestore()),
          Effect.catchCause((cause) =>
            Effect.fail(
              makeApiError("restore_failed", {
                resource: resolved,
                expected: "restored",
                actual: String(Cause.squash(cause)),
              }),
            ),
          ),
        )
        return {
          status: outcome.outcome === "restored" ? ("restored" as const) : ("failed" as const),
          inProgress: false,
          restoreId: started.restoreId,
          sourceFile: resolved,
          message:
            outcome.outcome === "restored"
              ? `Restore succeeded; the pre-restore store is retained in the quarantine (${outcome.quarantineDir}).`
              : `Restore failed: ${outcome.failure?.detail ?? "unknown"}; the original store was put back and the quarantine is retained.`,
        }
      }

      return {
        status: "dry_run" as const,
        inProgress: false,
        ...(resolved ? { sourceFile: resolved } : {}),
        message: "Verified restore is available; indicate dry_run:false to restore.",
      }
    })

    const upgradeStatus = Effect.fn("MaintenanceHttpApi.upgradeStatus")(function* () {
      const active = yield* DatabaseUpgradeRun.loadActiveRun(database.db)
      const receipts = active ? yield* DatabaseUpgradeRun.loadReceiptsForRun(database.db, active.runId) : []
      return {
        active: active !== undefined,
        run: active ?? undefined,
        receipts: receipts.map(toReceiptRow),
        count: receipts.length,
      }
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
      const state = readState()
      if (state && state.mode !== "ready" && !options.allowRecoveryWrite)
        return yield* Effect.fail(mapBootstrapStateToError(state, payload.attempt_id)!)
      const attempts = yield* database.db
        .select({
          sessionId: SessionProviderAttemptTable.session_id,
          activityId: SessionProviderAttemptTable.activity_id,
          attemptId: SessionProviderAttemptTable.attempt_id,
          attemptVersion: SessionProviderAttemptTable.attempt_version,
          providerTurnSeq: SessionProviderAttemptTable.provider_turn_seq,
          selectionId: SessionProviderAttemptTable.selection_id,
          projectionHash: SessionProviderAttemptTable.projection_hash,
          requestHash: SessionProviderAttemptTable.request_hash,
          preparedTurnHash: SessionProviderAttemptTable.prepared_turn_hash,
          wireRequestHash: SessionProviderAttemptTable.wire_request_hash,
          providerId: SessionProviderAttemptTable.provider_id,
          ownerToken: SessionProviderAttemptTable.owner_token,
          idempotencyKey: SessionProviderAttemptTable.idempotency_key,
          attemptState: SessionProviderAttemptTable.state,
          receiptActivityId: V2ProviderTurnReceiptTable.activity_id,
          receiptTurnSeq: V2ProviderTurnReceiptTable.provider_turn_seq,
          receiptProviderId: V2ProviderTurnReceiptTable.provider_id,
          receiptOwnerToken: V2ProviderTurnReceiptTable.owner_token,
          receiptState: V2ProviderTurnReceiptTable.state,
          protocol: V2ProviderTurnReceiptTable.protocol,
        })
        .from(SessionProviderAttemptTable)
        .innerJoin(
          V2ProviderTurnReceiptTable,
          eq(V2ProviderTurnReceiptTable.provider_attempt_id, SessionProviderAttemptTable.attempt_id),
        )
        .where(
          and(
            eq(SessionProviderAttemptTable.session_id, payload.session_id),
            eq(SessionProviderAttemptTable.attempt_id, payload.attempt_id),
            eq(SessionProviderAttemptTable.request_hash, payload.request_hash),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      if (attempts.length !== 1) {
        return yield* Effect.fail(
          makeApiError("recovery_terminal_bridge_missing", {
            resource: payload.attempt_id,
            expected: "one exact receipt/provider-attempt binding",
            actual: String(attempts.length),
          }),
        )
      }
      const attempt = attempts[0]!
      if (
        attempt.attemptState !== "indeterminate_after_crash" ||
        attempt.receiptState !== "indeterminate_after_crash" ||
        attempt.ownerToken === null ||
        attempt.ownerToken !== attempt.receiptOwnerToken ||
        attempt.activityId !== attempt.receiptActivityId ||
        attempt.providerTurnSeq !== attempt.receiptTurnSeq ||
        attempt.providerId !== attempt.receiptProviderId ||
        (payload.activity_id !== undefined && payload.activity_id !== attempt.activityId) ||
        (payload.provider_id !== undefined && payload.provider_id !== attempt.providerId)
      ) {
        return yield* Effect.fail(
          makeApiError("recovery_terminal_bridge_missing", {
            resource: payload.attempt_id,
            expected: "matching indeterminate receipt/provider-attempt authority",
            actual: `${attempt.attemptState}/${attempt.receiptState}`,
          }),
        )
      }
      const attemptIdentity = {
        sessionId: attempt.sessionId,
        activityId: attempt.activityId,
        attemptId: attempt.attemptId,
        providerTurnSeq: attempt.providerTurnSeq,
        selectionId: attempt.selectionId,
        projectionHash: attempt.projectionHash,
        requestHash: attempt.requestHash,
        providerId: attempt.providerId,
        protocol: attempt.protocol,
        ...(attempt.idempotencyKey === null ? {} : { idempotencyKey: attempt.idempotencyKey }),
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
        attemptState: attempt.attemptState,
        expectedAttemptState: "indeterminate_after_crash",
        ownerToken: attempt.ownerToken,
        expectedVersion: attempt.attemptVersion,
        baseline: {
          state: "present",
          baselineHash: attempt.preparedTurnHash ?? undefined,
          verified: attempt.preparedTurnHash !== null,
        },
        historyVerified:
          attempt.preparedTurnHash !== null &&
          attempt.wireRequestHash !== null &&
          attempt.projectionHash.length > 0 &&
          attempt.selectionId.length > 0,
        providerLookupComplete: attempt.protocol.length > 0 && attempt.providerId.length > 0,
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
      // The registry verifies the attempt-slot CAS: an idempotent exact retry returns the
      // already-recorded row (its command id is authoritative), and a different request
      // hash on the same attempt is a typed 409 `recovery_command_hash_mismatch`.
      const recorded = yield* registry.record({
        commandId,
        sessionId: payload.session_id,
        attemptId: payload.attempt_id,
        requestHash: payload.request_hash,
        descriptor,
        actorType: payload.actor_type,
        actorId: payload.actor_id,
        createdAt: Date.now(),
        attemptIdentity,
        expectedOwnerToken: attempt.ownerToken,
      })
      if (options.executeRecovery) {
        const report = yield* RecoveryExecutor.makeRecoveryExecutor(database.db).drain
        if (recorded.descriptor.descriptorKind === "resolvable_exact") {
          const command = yield* SessionProviderRecoveryDurable.makeDurableRecoveryStore(database.db).getCommand(
            recorded.commandId,
          )
          if (command?.state !== "abandoned") {
            return yield* Effect.fail(
              makeApiError("internal_error", {
                resource: recorded.commandId,
                expected: "exact recovery command committed as abandoned",
                actual: JSON.stringify(report),
              }),
            )
          }
        }
      }

      return { command_id: recorded.commandId, descriptor: recorded.descriptor }
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
      return yield* Effect.fail(
        makeApiError("recovery_evidence_export_unavailable", {
          resource: ctx.payload.session_id,
          expected: "AES-256-GCM artifact plus durable unlock authority",
          actual: "manifest-only export disabled",
        }),
      )
    })

    const recoveryEvidenceExportGet = Effect.fn("MaintenanceHttpApi.recoveryEvidenceExport")(function* (ctx: {
      query: { export_id: string }
    }) {
      return yield* Effect.fail(
        makeApiError("recovery_evidence_export_unavailable", {
          resource: ctx.query.export_id,
          expected: "AES-256-GCM artifact plus durable unlock authority",
          actual: "manifest-only export disabled",
        }),
      )
    })

    return {
      getBootstrapStatus,
      listBackups,
      verifyBackup,
      restoreBackup,
      upgradeStatus,
      recoveryList,
      recoveryCommand,
      recoveryCommandGet,
      recoveryEvidenceExportCreate,
      recoveryEvidenceExportGet,
    }
  })

export const maintenanceHandlers = HttpApiBuilder.group(MaintenanceApi, "maintenance", (handlers) =>
  Effect.map(maintenanceOperations({ executeRecovery: true }), (operations) =>
    handlers
      .handle("bootstrapStatus", operations.getBootstrapStatus)
      .handle("backupList", operations.listBackups)
      .handle("backupVerify", operations.verifyBackup)
      .handle("backupRestore", operations.restoreBackup)
      .handle("upgradeStatus", operations.upgradeStatus)
      .handle("recoveryList", operations.recoveryList)
      .handle("recoveryCommand", operations.recoveryCommand)
      .handle("recoveryCommandGet", operations.recoveryCommandGet)
      .handle("recoveryEvidenceExportCreate", operations.recoveryEvidenceExportCreate)
      .handle("recoveryEvidenceExport", operations.recoveryEvidenceExportGet)
      // The digest effect's requirements resolve from the shared route-graph context at request
      // time (same open V2 runtime the instance routes run on), not from this group's own layer.
      .handle("compositionDigest", () => CompositionDigest.current),
  ),
)

type Operations = Effect.Success<ReturnType<typeof maintenanceOperations>>

function maintenanceApiError(error: unknown, state: BootstrapState, resource: string): ApiTypedError {
  if (error instanceof DatabaseBootstrapError) return mapBootstrapStateToError(error.state, resource)!
  if (typeof error === "object" && error !== null && "data" in error) return error as ApiTypedError
  return makeApiError("internal_error", {
    resource,
    correlationId: state.diagnostics.correlationId,
    expected: "maintenance operation completed",
    actual: error instanceof Error ? error.name : String(error),
  })
}

function readOnlyOperation<A>(
  filename: string,
  state: BootstrapState,
  select: (operations: Operations) => Effect.Effect<A, ApiTypedError>,
) {
  if (state.mode !== "read_only_recovery") return Effect.fail(mapBootstrapStateToError(state, filename)!)
  return maintenanceOperations().pipe(
    Effect.flatMap(select),
    Effect.provide(layer),
    Effect.provide(Database.readOnlyLayerFromPath(filename)),
    Effect.scoped,
    Effect.mapError((error) => maintenanceApiError(error, state, filename)),
  )
}

function recoveryWriteOperation<A>(
  filename: string,
  state: BootstrapState,
  select: (operations: Operations) => Effect.Effect<A, ApiTypedError>,
) {
  if (state.mode !== "read_only_recovery") return Effect.fail(mapBootstrapStateToError(state, filename)!)
  return maintenanceOperations({ allowRecoveryWrite: true, executeRecovery: true }).pipe(
    Effect.flatMap(select),
    Effect.provide(layer),
    Effect.provide(Database.maintenanceLayerFromPath(filename)),
    Effect.scoped,
    Effect.mapError((error) => maintenanceApiError(error, state, filename)),
  )
}

/**
 * Incident-only handler graph. It owns no persistent SQLite connection: read/recovery operations
 * open a short scope, while restore runs with the database fully closed and acquires the same
 * lifetime owner fence as the business runtime.
 */
export function maintenanceOnlyHandlersFor(filename: string, state: BootstrapState) {
  return HttpApiBuilder.group(MaintenanceApi, "maintenance", (handlers) =>
    Effect.gen(function* () {
      const restartRequired = yield* Ref.make(false)
      const getBootstrapStatus = () => Effect.fail(mapBootstrapStateToError(state, "database")!)
      const listBackups = Effect.fn("MaintenanceHttpApi.incidentBackupList")(function* (ctx: {
        query: { dir?: string }
      }) {
        const requested = ctx.query.dir ?? backupsRoot(filename)
        const dir = withinBackups(requested, filename)
        if (dir === undefined)
          return yield* Effect.fail(
            makeApiError("validation_failed", {
              resource: requested,
              expected: "path under the backups root",
              actual: requested,
            }),
          )
        const entries = yield* Effect.tryPromise(() => fs.readdir(dir)).pipe(Effect.orElseSucceed(() => [] as string[]))
        const backups = yield* Effect.forEach(
          entries.filter((entry) => entry.endsWith(".manifest.json")).map((entry) => path.join(dir, entry)),
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
          { concurrency: 16 },
        )
        const list = backups.filter((backup): backup is NonNullable<typeof backup> => backup !== undefined)
        return { backups: list, count: list.length }
      })
      const verifyBackup = Effect.fn("MaintenanceHttpApi.incidentBackupVerify")(function* (ctx: {
        query: { manifest_path: string }
      }) {
        const resolved = withinBackups(ctx.query.manifest_path, filename)
        if (resolved === undefined)
          return yield* Effect.fail(
            makeApiError("validation_failed", {
              resource: ctx.query.manifest_path,
              expected: "path under the backups root",
              actual: ctx.query.manifest_path,
            }),
          )
        return yield* BackupVerify.verify(yield* readManifestOrMissing(resolved))
      })
      const restoreBackup = Effect.fn("MaintenanceHttpApi.incidentBackupRestore")(function* (ctx: {
        payload: { backup_manifest_ref: string; target?: string; dry_run?: boolean }
      }) {
        const resolved = withinBackups(ctx.payload.backup_manifest_ref, filename)
        if (resolved === undefined)
          return yield* Effect.fail(
            makeApiError("validation_failed", {
              resource: ctx.payload.backup_manifest_ref,
              expected: "path under the backups root",
              actual: ctx.payload.backup_manifest_ref,
            }),
          )
        const target = path.resolve(ctx.payload.target ?? filename)
        if (target !== path.resolve(filename))
          return yield* Effect.fail(
            makeApiError("validation_failed", { resource: target, expected: path.resolve(filename), actual: target }),
          )
        if (state.diagnostics.stableCode === "another_process_active")
          return yield* Effect.fail(mapRestoreModeToError(state, target))
        if (yield* Ref.get(restartRequired))
          return yield* Effect.fail(
            makeApiError("restore_target_not_quarantined", {
              resource: target,
              expected: "process restart after the committed restore",
              actual: "restart_required",
            }),
          )
        const manifest = yield* readManifestOrMissing(resolved)
        const verification = yield* BackupVerify.verify(manifest)
        if (!verification.ok)
          return yield* Effect.fail(
            makeApiError("restore_failed", {
              resource: resolved,
              expected: "verified backup",
              actual: verification.reason,
            }),
          )
        if (ctx.payload.dry_run !== false)
          return {
            status: "dry_run" as const,
            inProgress: false,
            sourceFile: resolved,
            message: "Backup verified; dry_run:false will restore the closed maintenance target.",
          }
        const outcome = yield* Restore.restoreVerified({ dbPath: target, backup: manifest }).pipe(
          Effect.mapError((error) =>
            makeApiError(error.code === "target_busy" ? "restore_target_not_quarantined" : "restore_failed", {
              resource: target,
              expected: "verified restore",
              actual: error.code,
            }),
          ),
        )
        yield* Ref.set(restartRequired, true)
        return {
          status: "restored" as const,
          inProgress: false,
          restoreId: outcome.restoreId,
          sourceFile: resolved,
          message: `Restore succeeded; incident retained at ${outcome.quarantineDir}. Restart is required before business admission.`,
        }
      })
      const evidenceCreate = (ctx: { payload: { session_id: string } }) =>
        Effect.fail(
          makeApiError("recovery_evidence_export_unavailable", {
            resource: ctx.payload.session_id,
            expected: "AES-256-GCM artifact plus durable unlock authority",
            actual: "manifest-only export disabled",
          }),
        )
      const evidenceGet = (ctx: { query: { export_id: string } }) =>
        Effect.fail(
          makeApiError("recovery_evidence_export_unavailable", {
            resource: ctx.query.export_id,
            expected: "AES-256-GCM artifact plus durable unlock authority",
            actual: "manifest-only export disabled",
          }),
        )
      // The incident shell owns no Session/tool/event runtime, so there is no composition to
      // digest — an honest typed 503, never a fabricated fingerprint of the read-only shell.
      const compositionDigest = () =>
        Effect.fail(
          makeApiError("service_unavailable", {
            resource: MaintenancePaths.compositionDigest,
            expected: "ready business runtime composition",
            actual: state.mode,
          }),
        )

      return handlers
        .handle("bootstrapStatus", getBootstrapStatus)
        .handle("backupList", listBackups)
        .handle("backupVerify", verifyBackup)
        .handle("backupRestore", restoreBackup)
        .handle("upgradeStatus", () => readOnlyOperation(filename, state, (operations) => operations.upgradeStatus()))
        .handle("recoveryList", (ctx) =>
          readOnlyOperation(filename, state, (operations) => operations.recoveryList(ctx)),
        )
        .handle("recoveryCommand", (ctx) =>
          recoveryWriteOperation(filename, state, (operations) => operations.recoveryCommand(ctx)),
        )
        .handle("recoveryCommandGet", (ctx) =>
          readOnlyOperation(filename, state, (operations) => operations.recoveryCommandGet(ctx)),
        )
        .handle("recoveryEvidenceExportCreate", evidenceCreate)
        .handle("recoveryEvidenceExport", evidenceGet)
        .handle("compositionDigest", compositionDigest)
    }),
  )
}
