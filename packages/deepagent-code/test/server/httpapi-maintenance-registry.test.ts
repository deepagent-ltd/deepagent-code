import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { SessionProviderRecovery } from "@deepagent-code/core/session/runner"
import { Service as MaintenanceRegistryService, DefaultEvidenceExportTtlMs, layer } from "../../src/server/routes/instance/httpapi/maintenance-registry"
import type { RecoveryDescriptorRecord } from "../../src/server/routes/instance/httpapi/maintenance-registry"

// C6-01 maintenance surface state (design §11.1) — W2: the recovery command/descriptor/
// evidence-export records are DURABLE (core's DB-backed store) so these tests exercise
// the exact behaviors the handlers rely on (restore-in-progress 409, per-session
// listing, request-hash lookup, evidence export TTL/redaction) against an in-memory
// database shared with the layer.

const database = Database.layerFromPath(":memory:")
const testLayer = Layer.provideMerge(layer, database)

const run = <A>(self: Effect.Effect<A, never, MaintenanceRegistryService>) =>
  Effect.runPromise(self.pipe(Effect.provide(testLayer)))

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
        yield* r.record(fixture)

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

  test("evidence export is created with a TTL and read by id; unknown export is undefined", () =>
    run(
      Effect.gen(function* () {
        const r = yield* MaintenanceRegistryService
        const before = Date.now()
        const manifest = yield* r.createExport({ sessionId: "sess_1", contentHash: "sha256:abc" })
        expect(manifest.exportId).toBeString()
        expect(manifest.sessionId).toBe("sess_1")
        expect(manifest.ownerSessionId).toBe("sess_1")
        expect(manifest.contentHash).toBe("sha256:abc")
        // Default TTL is 7 days.
        expect(manifest.expiresAt - manifest.exportedAt).toBe(DefaultEvidenceExportTtlMs)
        expect(manifest.exportedAt).toBeGreaterThanOrEqual(before)

        const fetched = yield* r.getExport(manifest.exportId)
        expect(fetched?.exportId).toBe(manifest.exportId)
        const missing = yield* r.getExport("exp_missing")
        expect(missing).toBeUndefined()
      }),
    ))
})
