import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Ref } from "effect"
import type { RecoveryDescriptor } from "@deepagent-code/core/contract/recovery-command"
import { Database } from "@deepagent-code/core/database/database"
import { SessionProviderRecoveryDurable } from "@deepagent-code/core/session/runner"
type CommandRow = SessionProviderRecoveryDurable.CommandRow
type DescriptorRow = SessionProviderRecoveryDurable.DescriptorRow
type DurableRecoveryStore = SessionProviderRecoveryDurable.DurableRecoveryStore

// C6-01 maintenance HTTP-surface state (design §11.1) — W2: the recovery command /
// descriptor / evidence-export records are now DURABLE (core's DB-backed
// SessionProviderRecoveryDurable store) instead of a synthetic in-memory Ref, so a
// kill-9 restart re-lists the same descriptors/commands/exports. The restore-in-progress
// flag stays process-local by nature (it drives the 409 conflict surface for the
// backup/restore lane).

export interface RecoveryDescriptorRecord {
  readonly commandId: string
  readonly sessionId: string
  readonly attemptId: string
  readonly requestHash: string
  readonly descriptor: RecoveryDescriptor
  readonly actorType: "user" | "administrator" | "system"
  readonly actorId: string
  readonly createdAt: number
  readonly evidenceStatus?: "settled"
}

export interface EvidenceExportRecord {
  readonly exportId: string
  readonly sessionId: string
  readonly ownerSessionId: string
  readonly exportedAt: number
  readonly expiresAt: number
  readonly contentHash: string
}

export interface RestoreStatusRecord {
  readonly inProgress: boolean
  readonly restoreId?: string
  readonly startedAt?: number
  readonly sourceFile?: string
}

export interface MaintenanceRegistry {
  readonly restore: Effect.Effect<RestoreStatusRecord>
  readonly setRestoreInProgress: (input: { sourceFile: string }) => Effect.Effect<RestoreStatusRecord>
  readonly clearRestore: () => Effect.Effect<void>
  readonly listBySession: (sessionId: string) => Effect.Effect<ReadonlyArray<RecoveryDescriptorRecord>>
  readonly getRecord: (commandId: string) => Effect.Effect<RecoveryDescriptorRecord | undefined>
  readonly getByRequestHash: (requestHash: string) => Effect.Effect<RecoveryDescriptorRecord | undefined>
  readonly record: (record: RecoveryDescriptorRecord) => Effect.Effect<RecoveryDescriptorRecord>
  readonly createExport: (input: {
    sessionId: string
    contentHash: string
    ttlMs?: number
  }) => Effect.Effect<EvidenceExportRecord>
  readonly getExport: (exportId: string) => Effect.Effect<EvidenceExportRecord | undefined>
}

export class Service extends Context.Service<Service, MaintenanceRegistry>()(
  "@deepagent-code/maintenance/MaintenanceRegistry",
) {}

/** The default export TTL for evidence (7 days, mirroring the core default). */
export const DefaultEvidenceExportTtlMs = 7 * 24 * 60 * 60_000

// ---------------------------------------------------------------------------
// Pure reconstruction (descriptor row + command row → wire record)
// ---------------------------------------------------------------------------

/** Derive the durable evidence status a descriptor row records (settled terminal → settled). */
const evidenceStatusOf = (descriptor: RecoveryDescriptor): "settled" | undefined =>
  descriptor.descriptorKind === "resolved" && descriptor.resolved.terminal === "settled"
    ? "settled"
    : undefined

/** Rebuild the wire record from a commanded descriptor row (command authorizes it). */
function toRecord(command: CommandRow, descriptor: DescriptorRow): RecoveryDescriptorRecord {
  return {
    commandId: command.commandId,
    sessionId: descriptor.sessionId,
    attemptId: command.attempt.attemptId,
    requestHash: command.requestHash,
    descriptor: descriptor.payload,
    actorType: command.actorType ?? "system",
    actorId: command.actorId ?? `turn_terminal:${descriptor.activityId}`,
    createdAt: descriptor.createdAt,
    ...(evidenceStatusOf(descriptor.payload) ? { evidenceStatus: evidenceStatusOf(descriptor.payload) } : {}),
  }
}

/** Rebuild a system-authored record for a descriptor row without a command (turn terminal). */
function toOrphanRecord(descriptor: DescriptorRow): RecoveryDescriptorRecord {
  return {
    commandId: "",
    sessionId: descriptor.sessionId,
    attemptId: descriptor.payload.provenance.sourceRefs[0] ?? descriptor.descriptorId,
    requestHash: descriptor.payload.requestHash,
    descriptor: descriptor.payload,
    actorType: "system",
    actorId: `turn_terminal:${descriptor.activityId}`,
    createdAt: descriptor.createdAt,
    ...(evidenceStatusOf(descriptor.payload) ? { evidenceStatus: evidenceStatusOf(descriptor.payload) } : {}),
  }
}

// ---------------------------------------------------------------------------
// DB-backed layer
// ---------------------------------------------------------------------------

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const store: DurableRecoveryStore = SessionProviderRecoveryDurable.makeDurableRecoveryStore(db)
    const restoreRef = yield* Ref.make<RestoreStatusRecord>({ inProgress: false })

    const listBySession = Effect.fn("MaintenanceRegistry.listBySession")(function* (sessionId: string) {
      const commands = yield* store.listCommandsBySession(sessionId)
      const byDescriptor = new Map(commands.flatMap((row) => (row.descriptorId ? [[row.descriptorId, row] as const] : [])))
      const descriptors = yield* store.listDescriptorsBySession(sessionId)
      return descriptors.map((descriptor) => {
        const command = byDescriptor.get(descriptor.descriptorId)
        return command ? toRecord(command, descriptor) : toOrphanRecord(descriptor)
      })
    })

    const getRecord = Effect.fn("MaintenanceRegistry.getRecord")(function* (commandId: string) {
      const command = yield* store.getCommand(commandId)
      if (!command?.descriptorId) return undefined
      const descriptor = yield* store.getDescriptor(command.descriptorId)
      return descriptor ? toRecord(command, descriptor) : undefined
    })

    const getByRequestHash = Effect.fn("MaintenanceRegistry.getByRequestHash")(function* (requestHash: string) {
      const commands = yield* store.listCommandsByRequestHash(requestHash)
      for (const command of commands) {
        if (!command.descriptorId) continue
        const descriptor = yield* store.getDescriptor(command.descriptorId)
        if (descriptor) return toRecord(command, descriptor)
      }
      return undefined
    })

    const record = Effect.fn("MaintenanceRegistry.record")(function* (record: RecoveryDescriptorRecord) {
      const descriptorWrite = yield* store.putDescriptor({
        descriptor: record.descriptor,
        sessionId: record.sessionId,
        activityId: "",
        turnId: "0",
        createdAt: record.createdAt,
      })
      yield* store.putCommand({
        // The handler pre-computed this exact content address for the response; store
        // the row under it so recoveryCommandGet round-trips the same command id.
        commandId: record.commandId,
        requestHash: record.requestHash,
        attemptIdentity: {
          sessionId: record.sessionId,
          activityId: "",
          attemptId: record.attemptId,
          providerTurnSeq: 0,
          selectionId: "",
          projectionHash: record.requestHash,
          requestHash: record.requestHash,
          providerId: "",
        },
        descriptorId: descriptorWrite.descriptorId,
        actorType: record.actorType,
        actorId: record.actorId,
        createdAt: record.createdAt,
      })
      return record
    })

    const createExport = Effect.fn("MaintenanceRegistry.createExport")(function* (input: {
      sessionId: string
      contentHash: string
      ttlMs?: number
    }) {
      const now = Date.now()
      const exportRecord: EvidenceExportRecord = {
        exportId: `exp_${randomUUID()}`,
        sessionId: input.sessionId,
        ownerSessionId: input.sessionId,
        exportedAt: now,
        expiresAt: now + (input.ttlMs ?? DefaultEvidenceExportTtlMs),
        contentHash: input.contentHash,
      }
      yield* store.putExport({
        exportId: exportRecord.exportId,
        manifestHash: input.contentHash,
        state: "issued",
        payload: { record: exportRecord },
        createdAt: now,
      })
      return exportRecord
    })

    const getExport = Effect.fn("MaintenanceRegistry.getExport")(function* (exportId: string) {
      const row = yield* store.getExport(exportId)
      if (!row) return undefined
      const body = row.payload as { readonly record?: EvidenceExportRecord } | undefined
      return body?.record
    })

    return Service.of({
      restore: Effect.map(Ref.get(restoreRef), (value) => value),
      setRestoreInProgress: (input) =>
        Ref.modify(restoreRef, () => {
          const restore: RestoreStatusRecord = {
            inProgress: true,
            restoreId: `restore_${randomUUID()}`,
            startedAt: Date.now(),
            sourceFile: input.sourceFile,
          }
          return [restore, restore]
        }),
      clearRestore: () => Ref.set(restoreRef, { inProgress: false }),
      listBySession,
      getRecord,
      getByRequestHash,
      record,
      createExport,
      getExport,
    })
  }),
)
