import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Ref } from "effect"
import type { RecoveryDescriptor } from "@deepagent-code/core/contract/recovery-command"

// In-memory HTTP-surface state for the maintenance surface (C6-01). This is a
// process-local, non-durable registry that exists ONLY to give the maintenance
// HTTP contract a coherent request/response + typed-error surface while the
// durable authority (core's SessionProviderRecovery store) is consumed where the
// core service exposes a read. Restore is fixture-gated / dry-run in this lane:
// the registry tracks the restore-in-progress flag that drives the 409 conflict.
//
// Not exported from a package surface; it is provided by the maintenance handler
// layer (deepagent-code) so the route graph stays independent of any core
// persistence wiring.

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

interface MaintenanceRegistryState {
  readonly restore: RestoreStatusRecord
  readonly records: ReadonlyMap<string, RecoveryDescriptorRecord>
  readonly sessionIndex: ReadonlyMap<string, ReadonlyArray<string>>
  readonly exports: ReadonlyMap<string, EvidenceExportRecord>
}

const emptyState = (): MaintenanceRegistryState => ({
  restore: { inProgress: false },
  records: new Map(),
  sessionIndex: new Map(),
  exports: new Map(),
})

const appendSessionCommand = (
  current: ReadonlyMap<string, ReadonlyArray<string>>,
  sessionId: string,
  commandId: string,
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const existing = current.get(sessionId) ?? []
  return new Map(current).set(sessionId, [...existing, commandId])
}

export const layer = Layer.effect(
  Service,
  Ref.make(emptyState()).pipe(
    Effect.map(
      (ref): MaintenanceRegistry => ({
        restore: Effect.map(Ref.get(ref), (value) => value.restore),
        setRestoreInProgress: (input) =>
          Ref.modify(ref, (value) => {
            const restore: RestoreStatusRecord = {
              inProgress: true,
              restoreId: `restore_${randomUUID()}`,
              startedAt: Date.now(),
              sourceFile: input.sourceFile,
            }
            return [restore, { ...value, restore }]
          }),
        clearRestore: () => Ref.update(ref, (value) => ({ ...value, restore: emptyState().restore })),
        listBySession: (sessionId) =>
          Effect.map(Ref.get(ref), (value) => {
            const ids = value.sessionIndex.get(sessionId) ?? []
            return ids.flatMap((id) => {
              const record = value.records.get(id)
              return record ? [record] : []
            })
          }),
        getRecord: (commandId) => Effect.map(Ref.get(ref), (value) => value.records.get(commandId)),
        getByRequestHash: (requestHash) =>
          Effect.map(Ref.get(ref), (value) =>
            [...value.records.values()].find((record) => record.requestHash === requestHash),
          ),
        record: (record) =>
          Effect.gen(function* () {
            yield* Ref.update(ref, (value) => ({
              ...value,
              records: new Map(value.records).set(record.commandId, record),
              sessionIndex: appendSessionCommand(value.sessionIndex, record.sessionId, record.commandId),
            }))
            return record
          }),
        createExport: ({ sessionId, contentHash, ttlMs }) => {
          const now = Date.now()
          const exportRecord: EvidenceExportRecord = {
            exportId: `exp_${randomUUID()}`,
            sessionId,
            ownerSessionId: sessionId,
            exportedAt: now,
            expiresAt: now + (ttlMs ?? DefaultEvidenceExportTtlMs),
            contentHash,
          }
          return Effect.map(
            Ref.update(ref, (value) => ({ ...value, exports: new Map(value.exports).set(exportRecord.exportId, exportRecord) })),
            () => exportRecord,
          )
        },
        getExport: (exportId) => Effect.map(Ref.get(ref), (value) => value.exports.get(exportId)),
      }),
    ),
  ),
)
