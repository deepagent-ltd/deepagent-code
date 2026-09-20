import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Ref } from "effect"
import type { RecoveryDescriptor } from "@deepagent-code/core/contract/recovery-command"
import { Database } from "@deepagent-code/core/database/database"
import { SessionProviderRecovery, SessionProviderRecoveryDurable } from "@deepagent-code/core/session/runner"
import { makeApiError, type ApiTypedError } from "./typed-error"
type CommandRow = SessionProviderRecoveryDurable.CommandRow
type DescriptorRow = SessionProviderRecoveryDurable.DescriptorRow
type DurableRecoveryStore = SessionProviderRecoveryDurable.DurableRecoveryStore

// C6-01 maintenance HTTP-surface state (design §11.1) — W2: the recovery command /
// descriptor records are now DURABLE (core's DB-backed
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
  /** Exact durable identity read from SessionProviderAttempt; never synthesized from HTTP fields. */
  readonly attemptIdentity?: SessionProviderRecovery.AttemptIdentity
  readonly expectedOwnerToken?: string
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
  readonly record: (record: RecoveryDescriptorRecord) => Effect.Effect<RecoveryDescriptorRecord, ApiTypedError>
}

export class Service extends Context.Service<Service, MaintenanceRegistry>()(
  "@deepagent-code/maintenance/MaintenanceRegistry",
) {}

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
    attemptIdentity: command.attempt,
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
      // W2-1 durable terminal signal: turn-terminal descriptors (written by
      // v2-provider-turn.ts with NO command row) survive a kill-9 restart, so a
      // request that was already settled/failed BEFORE the restart must still gate
      // the network-unknown 410 — the descriptor table is the second authority.
      const descriptors = yield* store.listDescriptorsByRequestHash(requestHash)
      for (const descriptor of descriptors) {
        if (descriptor.payload.descriptorKind !== "resolved") continue
        return toOrphanRecord(descriptor)
      }
      return undefined
    })

    const record = Effect.fn("MaintenanceRegistry.record")(function* (record: RecoveryDescriptorRecord) {
      if (!record.attemptIdentity) {
        return yield* Effect.fail(
          makeApiError("recovery_terminal_bridge_missing", {
            resource: record.attemptId,
            expected: "durable provider attempt identity",
            actual: "missing",
          }),
        )
      }
      // W2-1 CAS verification: the attempt slot is inspected up front, so the verdict is
      // never a silent 200 with a 404-able command id:
      //   - same attempt + SAME request hash  → idempotent exact retry → the existing row
      //     (its command id is authoritative, not the caller's);
      //   - same attempt + DIFFERENT request hash → typed 409 (never clobbered, and
      //     nothing is written — no orphan descriptor row is left behind).
      const slot = yield* store.getCommandForAttempt(record.sessionId, record.attemptId)
      if (slot) {
        if (slot.requestHash !== record.requestHash) {
          return yield* Effect.fail(
            makeApiError("recovery_command_hash_mismatch", {
              resource: record.requestHash,
              expected: slot.requestHash,
              actual: record.requestHash,
            }),
          )
        }
        const descriptor = slot.descriptorId ? yield* store.getDescriptor(slot.descriptorId) : undefined
        return descriptor ? toRecord(slot, descriptor) : { ...record, commandId: slot.commandId }
      }
      const cas = yield* store.putDescriptorAndCommand({
        descriptor: record.descriptor,
        sessionId: record.sessionId,
        activityId: record.attemptIdentity.activityId,
        turnId: String(record.attemptIdentity.providerTurnSeq),
        // The handler pre-computed this exact content address for the response; record the
        // descriptor and command in one writer transaction so CAS loss cannot orphan a descriptor.
        commandId: record.commandId,
        requestHash: record.requestHash,
        attemptIdentity: record.attemptIdentity,
        actorType: record.actorType,
        actorId: record.actorId,
        expectedOwnerToken: record.expectedOwnerToken,
        createdAt: record.createdAt,
      })
      if (cas.status === "mismatch") {
        // A concurrent writer claimed the slot with a DIFFERENT request hash between
        // the pre-check and the CAS — typed 409; the slot is never clobbered.
        return yield* Effect.fail(
          makeApiError("recovery_command_hash_mismatch", {
            resource: record.requestHash,
            expected: "the slot's request hash",
            actual: record.requestHash,
          }),
        )
      }
      if (cas.status === "existing") {
        // A concurrent exact retry won the slot — return the already-recorded row.
        const winner = yield* store.getCommand(cas.commandId)
        const winnerDescriptor = winner?.descriptorId
          ? yield* store.getDescriptor(winner.descriptorId)
          : undefined
        return winnerDescriptor && winner ? toRecord(winner, winnerDescriptor) : record
      }
      return record
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
    })
  }),
)
