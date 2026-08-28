import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Service as MaintenanceRegistryService, DefaultEvidenceExportTtlMs, layer } from "../../src/server/routes/instance/httpapi/maintenance-registry"
import type { RecoveryDescriptorRecord } from "../../src/server/routes/instance/httpapi/maintenance-registry"

// C6-01 in-memory maintenance surface state (design §11.1). The registry gives the
// maintenance/recovery HTTP contract a coherent request/response surface with a
// deterministic, process-local store. These tests exercise the exact behaviors the
// handlers rely on (restore-in-progress 409, per-session listing, request-hash
// lookup, evidence export TTL/redaction).

const run = <A>(self: Effect.Effect<A, never, MaintenanceRegistryService>) =>
  Effect.runPromise(self.pipe(Effect.provide(layer)))

/** A minimal frozen-shaped recovery descriptor record for listing/lookup. */
const record = (overrides: Partial<RecoveryDescriptorRecord> = {}): RecoveryDescriptorRecord => ({
  commandId: "cmd_1",
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
        yield* r.record(record())

        const fetched = yield* r.getRecord("cmd_1")
        expect(fetched?.commandId).toBe("cmd_1")
        expect(fetched?.requestHash).toBe("req_hash_1")

        const list = yield* r.listBySession("sess_1")
        expect(list.map((item) => item.commandId)).toEqual(["cmd_1"])

        const byHash = yield* r.getByRequestHash("req_hash_1")
        expect(byHash?.commandId).toBe("cmd_1")
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
