import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { SessionProviderRecovery, SessionProviderRecoveryDurable } from "@deepagent-code/core/session/runner"
import { Service as MaintenanceRegistryService, layer } from "../../src/server/routes/instance/httpapi/maintenance-registry"
import type { RecoveryDescriptorRecord } from "../../src/server/routes/instance/httpapi/maintenance-registry"

// C6-01 maintenance surface state (design §11.1) — W2: the recovery command/descriptor/
// records are DURABLE (core's DB-backed store) so these tests exercise
// the exact behaviors the handlers rely on (restore-in-progress 409, per-session
// listing and request-hash lookup) against an in-memory
// database shared with the layer.

const database = Database.layerFromPath(":memory:")
const testLayer = Layer.provideMerge(layer, database)

const run = <A, E = never>(
  self: Effect.Effect<A, E, MaintenanceRegistryService | Database.Service>,
) => Effect.runPromise(self.pipe(Effect.provide(testLayer)))

// Commands are content-addressed (the handler computes the same id), so a fixture
// record derives its commandId from the request hash + attempt identity.
const fixtureAttempt = (record: Partial<RecoveryDescriptorRecord>): SessionProviderRecovery.AttemptIdentity => ({
  sessionId: record.sessionId ?? "sess_1",
  activityId: "",
  attemptId: record.attemptId ?? "attempt_1",
  providerTurnSeq: 0,
  selectionId: "",
  projectionHash: record.requestHash ?? "req_hash_1",
  requestHash: record.requestHash ?? "req_hash_1",
  providerId: "",
})

/** A minimal frozen-shaped recovery descriptor record for listing/lookup. */
const record = (overrides: Partial<RecoveryDescriptorRecord> = {}): RecoveryDescriptorRecord => ({
  commandId: SessionProviderRecovery.recoveryCommandContentAddress({
    requestHash: "req_hash_1",
    attemptIdentity: fixtureAttempt({}),
  }),
  sessionId: "sess_1",
  attemptId: "attempt_1",
  requestHash: "req_hash_1",
  descriptor: {
    schemaVersion: "recovery-descriptor.v1",
    requestHash: "req_hash_1",
    provenance: { origin: "recorded", sourceRefs: ["attempt_1"] },
    baseline: { verified: false },
    terminalBridge: { bridgeId: "none", bridgeType: "none" },
    casTokens: { expectedState: "indeterminate_after_crash", expectedVersion: 0, ownerToken: "" },
    descriptorKind: "resolvable_exact",
    exact: { attemptHash: "a", selectionHash: "s", historyHash: "h", baselineHash: "b", allVerified: true },
  },
  actorType: "user",
  actorId: "actor_1",
  createdAt: 1,
  attemptIdentity: fixtureAttempt({}),
  expectedOwnerToken: "owner_1",
  ...overrides,
})

describe("maintenance registry", () => {
  test("restore-in-progress is tracked and cleared, driving the 409 conflict", () =>
    run(
      Effect.gen(function* () {
        const r = yield* MaintenanceRegistryService
        const idle = yield* r.restore
        expect(idle.inProgress).toBe(false)

        const started = yield* r.setRestoreInProgress({ sourceFile: "/tmp/backup.db" })
        expect(started.inProgress).toBe(true)
        expect(started.restoreId).toBeString()
        expect(started.sourceFile).toBe("/tmp/backup.db")

        const current = yield* r.restore
        expect(current.inProgress).toBe(true)

        yield* r.clearRestore()
        const afterClear = yield* r.restore
        expect(afterClear.inProgress).toBe(false)
      }),
    ))

  test("record/getRecord/listBySession/getByRequestHash round-trip a command", () =>
    run(
      Effect.gen(function* () {
        const r = yield* MaintenanceRegistryService
        const fixture = record()
        const recorded = yield* r.record(fixture)
        expect(recorded.commandId).toBe(fixture.commandId)

        const fetched = yield* r.getRecord(fixture.commandId)
        expect(fetched?.commandId).toBe(fixture.commandId)
        expect(fetched?.requestHash).toBe("req_hash_1")
        expect(fetched?.attemptId).toBe("attempt_1")

        const list = yield* r.listBySession("sess_1")
        expect(list.map((item) => item.commandId)).toEqual([fixture.commandId])

        const byHash = yield* r.getByRequestHash("req_hash_1")
        expect(byHash?.commandId).toBe(fixture.commandId)
        const other = yield* r.listBySession("sess_other")
        expect(other).toEqual([])
      }),
    ))

  test("W2-1 CAS: a second record for the same attempt with the SAME request hash returns the existing command id (200)", () =>
    run(
      Effect.gen(function* () {
        const r = yield* MaintenanceRegistryService
        const first = yield* r.record(record())
        const retry = yield* r.record(record())
        expect(retry.commandId).toBe(first.commandId)
        // No second row: the listing still shows exactly one command.
        const list = yield* r.listBySession("sess_1")
        expect(list).toHaveLength(1)
      }),
    ))

  test("W2-1 CAS: a second record for the same attempt with a DIFFERENT request hash is a typed 409, never a 200", () =>
    run(
      Effect.gen(function* () {
        const r = yield* MaintenanceRegistryService
        yield* r.record(record())
        const conflict = yield* r
          .record(record({ requestHash: "req_hash_2", commandId: `cmd_${"x".repeat(63)}` }))
          .pipe(Effect.flip)
        expect(conflict).toMatchObject({
          name: "ApiConflict",
          data: { code: "recovery_command_hash_mismatch", httpStatus: 409, resource: "req_hash_2" },
        })
        // The original record is untouched and still fetchable.
        const original = yield* r.getByRequestHash("req_hash_1")
        expect(original?.requestHash).toBe("req_hash_1")
      }),
    ))

  test("W2-1: a descriptor-only (no command) settled terminal gates getByRequestHash", () =>
    run(
      Effect.gen(function* () {
        const r = yield* MaintenanceRegistryService
        const databaseService = yield* Database.Service
        const store = SessionProviderRecoveryDurable.makeDurableRecoveryStore(databaseService.db)
        // The turn-terminal descriptor v2-provider-turn.ts writes: settled → resolved(settled),
        // written with NO command row.
        yield* store.putDescriptor({
          descriptor: {
            schemaVersion: "recovery-descriptor.v1",
            requestHash: "req_hash_terminal",
            provenance: { origin: "recorded", sourceRefs: ["receipt_9"] },
            baseline: { verified: false },
            terminalBridge: { bridgeId: "none", bridgeType: "none" },
            casTokens: { expectedState: "settled", expectedVersion: 0, ownerToken: "owner_9" },
            descriptorKind: "resolved",
            resolved: { resolutionRef: "receipt_9", bridgeRef: "none", terminal: "settled" },
          },
          sessionId: "sess_terminal",
          activityId: "act_9",
          turnId: "3",
          createdAt: 1,
        })

        const byHash = yield* r.getByRequestHash("req_hash_terminal")
        // The 410 gate (`evidenceStatus === "settled"`) fires even though no command row exists.
        expect(byHash?.evidenceStatus).toBe("settled")
        expect(byHash?.commandId).toBe("")
        expect(byHash?.descriptor.descriptorKind).toBe("resolved")
      }),
    ))

})
