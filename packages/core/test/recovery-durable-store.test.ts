import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import path from "node:path"
import { RecoveryCommandContract } from "../src/contract/recovery-command"
import { SessionProviderRecoveryDurable } from "../src/session/runner/recovery-durable-store"
import { SessionProviderRecovery } from "../src/session/runner/recovery"
import { StartupInventory } from "../src/session/runner/startup-inventory"
import { V2ProviderTurn } from "../src/session/runner/v2-provider-turn"
import { tmpdir } from "./fixture/tmpdir"

// W2 — durable C1B recovery store (design §W2 自动化验证):
//   - write → NEW store instance / NEW DB connection → the same five descriptor classes;
//   - command CAS: concurrent submissions of the same command → exactly one winner;
//   - kill-9 scenario: descriptors survive a restart and startup-inventory classifies
//     the re-derived inventory correctly.

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

type Db = EffectDrizzleSqlite.EffectSQLiteDatabase

const runDb = <A, E>(filename: string, effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped),
  )

/** The W2 table surface, mirroring the tracked migration (tests focus on the store). */
const createTables = (db: Db) =>
  Effect.gen(function* () {
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run(sql`
      CREATE TABLE session_provider_recovery_descriptor (
        descriptor_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, activity_id TEXT NOT NULL,
        turn_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
    yield* db.run(sql`
      CREATE TABLE recovery_command (
        command_id TEXT PRIMARY KEY,
        descriptor_id TEXT REFERENCES session_provider_recovery_descriptor(descriptor_id) ON DELETE CASCADE,
        attempt TEXT NOT NULL, state TEXT NOT NULL, expected_owner_token TEXT, result_hash TEXT,
        actor_type TEXT, actor_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )
    `)
    yield* db.run(sql`
      CREATE TABLE recovery_evidence_export (
        export_id TEXT PRIMARY KEY,
        descriptor_id TEXT REFERENCES session_provider_recovery_descriptor(descriptor_id) ON DELETE SET NULL,
        manifest_hash TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL
      )
    `)
  })

const H64 = (c: string) => c.repeat(64)

const identity = (overrides: Partial<SessionProviderRecovery.AttemptIdentity> = {}): SessionProviderRecovery.AttemptIdentity => ({
  sessionId: "ses_durable",
  attemptId: "att_durable",
  activityId: "act_durable",
  providerTurnSeq: 1,
  selectionId: "sel_1",
  projectionHash: H64("p"),
  requestHash: H64("r"),
  providerId: "provider-test",
  ...overrides,
})

const baseClassify = (attempt: SessionProviderRecovery.AttemptIdentity): SessionProviderRecovery.ClassifyInput => ({
  attempt,
  attemptState: "indeterminate_after_crash",
  expectedAttemptState: "indeterminate_after_crash",
  ownerToken: "owner_durable",
  expectedVersion: 2,
  baseline: { baselineHash: H64("b"), verified: true, state: "present" },
  historyVerified: true,
  providerLookupComplete: true,
  placementUnresolved: false,
  permissionIncomplete: false,
  workspaceConflict: false,
})

/** The five descriptor classes, classified through the real classifier. */
const fiveClassDescriptors = (): RecoveryCommandContract.RecoveryDescriptor[] => {
  const attempt = identity()
  const exact = SessionProviderRecovery.classify(baseClassify(attempt))
  const repairable = SessionProviderRecovery.classify({
    ...baseClassify(attempt),
    baseline: { verified: false, state: "missing", sourceSnapshotRef: "snap:1" },
  })
  const fork = SessionProviderRecovery.classify({
    ...baseClassify(attempt),
    baseline: { verified: false, state: "present" },
    safeBoundary: { safeBoundaryRef: "boundary:1", safeBoundaryHash: H64("sb") },
  })
  const coordination = SessionProviderRecovery.classify({
    ...baseClassify(attempt),
    baseline: { verified: false, state: "present" },
  })
  const resolved = SessionProviderRecovery.classify({
    ...baseClassify(attempt),
    resolution: { resolutionRef: "resolution:1", bridgeRef: "bridge:1", terminal: "settled" },
  })
  return [exact, repairable, fork, coordination, resolved]
}

describe("SessionProviderRecoveryDurable store (W2)", () => {
  test("write → new store instance → the same five descriptor classes read back", async () => {
    const dir = await tmpdir()
    const file = path.join(dir.path, "recovery.db")
    await runDb(
      file,
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        const store = SessionProviderRecoveryDurable.makeDurableRecoveryStore(db)
        for (const descriptor of fiveClassDescriptors()) {
          const outcome = yield* store.putDescriptor({
            descriptor,
            sessionId: descriptor.requestHash,
            activityId: "act_durable",
            turnId: "1",
            createdAt: 1,
          })
          expect(outcome.status).toBe("recorded")
        }
      }),
    )
    // "Restart": a NEW database connection (new client) over the same file.
    await runDb(
      file,
      Effect.gen(function* () {
        const db = yield* makeDb
        const store = SessionProviderRecoveryDurable.makeDurableRecoveryStore(db)
        const descriptors = yield* store.listDescriptorsBySession(H64("r"))
        expect(descriptors).toHaveLength(5)
        const kinds = descriptors.map((row) => row.kind as string).sort()
        expect(kinds).toEqual(
          ["coordination_required", "fork_only", "repairable_exact", "resolvable_exact", "resolved"].sort(),
        )
        // The full payload survives the round trip byte-identically (canonical content address).
        for (const row of descriptors) {
          expect(SessionProviderRecoveryDurable.recoveryDescriptorId(row.payload)).toBe(row.descriptorId)
          expect(row.contentHash).toBe(RecoveryCommandContract.recoveryDescriptorDigest(row.payload))
          const dedup = yield* store.putDescriptor({
            descriptor: row.payload,
            sessionId: row.sessionId,
            activityId: row.activityId,
            turnId: row.turnId,
          })
          expect(dedup.status).toBe("existing")
        }
      }),
    )
  })

  test("command CAS: concurrent submissions of the same command → exactly one winner", async () => {
    await runDb(
      ":memory:",
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        const storeA = SessionProviderRecoveryDurable.makeDurableRecoveryStore(db)
        const storeB = SessionProviderRecoveryDurable.makeDurableRecoveryStore(db)
        const input = { requestHash: H64("r"), attemptIdentity: identity() }
        const [a, b] = yield* Effect.all([storeA.putCommand(input), storeB.putCommand(input)], {
          concurrency: 2,
        })
        const recorded = [a, b].filter((outcome) => outcome.status === "recorded")
        const existing = [a, b].filter((outcome) => outcome.status === "existing")
        expect(recorded).toHaveLength(1)
        expect(existing).toHaveLength(1)
        const row = yield* storeA.getCommand(recorded[0]!.commandId)
        expect(row?.state).toBe("pending")
        expect(row?.requestHash).toBe(H64("r"))
      }),
    )
  })

  test("command CAS: a different request hash on the same attempt is a typed mismatch, never clobbered", async () => {
    await runDb(
      ":memory:",
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        const store = SessionProviderRecoveryDurable.makeDurableRecoveryStore(db)
        const first = yield* store.putCommand({ requestHash: H64("r"), attemptIdentity: identity() })
        expect(first.status).toBe("recorded")
        const second = yield* store.putCommand({ requestHash: H64("x"), attemptIdentity: identity() })
        expect(second).toMatchObject({ status: "mismatch", reason: "request_hash_mismatch" })
        const row = yield* store.getCommand(first.commandId)
        expect(row?.requestHash).toBe(H64("r"))
      }),
    )
  })

  test("command state transition is a conditional update; the retry is already; a stale from-state mismatches", async () => {
    await runDb(
      ":memory:",
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        const store = SessionProviderRecoveryDurable.makeDurableRecoveryStore(db)
        const input = { requestHash: H64("r"), attemptIdentity: identity() }
        const cas = yield* store.putCommand(input)
        expect(cas.status).toBe("recorded")

        const winner = yield* store.transitionCommand({
          commandId: cas.commandId,
          from: "pending",
          to: "abandoned",
          resultHash: H64("result"),
        })
        expect(winner).toBe("transitioned")
        const retry = yield* store.transitionCommand({
          commandId: cas.commandId,
          from: "pending",
          to: "abandoned",
        })
        expect(retry).toBe("already")
        const stale = yield* store.transitionCommand({ commandId: cas.commandId, from: "pending", to: "settled" })
        expect(stale).toBe("state_mismatch")
        const row = yield* store.getCommand(cas.commandId)
        expect(row?.state).toBe("abandoned")
        expect(row?.resultHash).toBe(H64("result"))
      }),
    )
  })

  test("evidence export survives a restart (new connection reads the same sealed body)", async () => {
    const dir = await tmpdir()
    const file = path.join(dir.path, "export.db")
    const payload = { manifest: { exportId: "exp_1" }, secret: "sealed" }
    await runDb(
      file,
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        const store = SessionProviderRecoveryDurable.makeDurableRecoveryStore(db)
        const created = yield* store.putExport({
          exportId: "exp_1",
          manifestHash: H64("m"),
          state: "issued",
          payload,
          createdAt: 1,
        })
        expect(created.status).toBe("recorded")
        const duplicate = yield* store.putExport({ exportId: "exp_1", manifestHash: H64("m"), state: "issued", payload })
        expect(duplicate.status).toBe("existing")
      }),
    )
    await runDb(
      file,
      Effect.gen(function* () {
        const db = yield* makeDb
        const store = SessionProviderRecoveryDurable.makeDurableRecoveryStore(db)
        const row = yield* store.getExport("exp_1")
        expect(row?.manifestHash).toBe(H64("m"))
        expect(row?.payload).toEqual(payload)
      }),
    )
  })

  test("durable service: resolve records descriptor + pending command; abandonExact transitions it", async () => {
    await runDb(
      ":memory:",
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        const service = yield* SessionProviderRecovery.Service.pipe(
          Effect.provide(SessionProviderRecovery.durableLayerWith(db)),
        )
        const attempt = identity()
        const outcome = yield* service.resolve({
          sessionId: attempt.sessionId,
          attemptId: attempt.attemptId,
          actor: { type: "user", id: "actor_1" },
          requestHash: attempt.requestHash,
          attemptIdentity: attempt,
          expectedAttemptState: "indeterminate_after_crash",
          ownerToken: "owner_durable",
          expectedVersion: 2,
          baseline: { baselineHash: H64("b"), verified: true, state: "present" },
          historyVerified: true,
          providerLookupComplete: true,
        })
        // A NEW store instance over the same db sees the command + descriptor.
        const store = SessionProviderRecoveryDurable.makeDurableRecoveryStore(db)
        const command = yield* store.getCommand(outcome.commandId)
        expect(command?.state).toBe("pending")
        expect(command?.descriptorId).toBe(SessionProviderRecoveryDurable.recoveryDescriptorId(outcome.descriptor))
        const descriptors = yield* store.listDescriptorsBySession(attempt.sessionId)
        expect(descriptors.map((row) => row.kind)).toContain(outcome.descriptor.descriptorKind)

        const abandoned = yield* service.abandonExact({
          actor: { type: "user", id: "actor_1" },
          requestHash: attempt.requestHash,
          attemptIdentity: attempt,
          reasonCode: "network_unknown",
        })
        expect(abandoned.status).toBe("abandoned")
        const after = yield* store.getCommand(outcome.commandId)
        expect(after?.state).toBe("abandoned")
        expect(after?.resultHash).toBeString()
        const resolvedKinds = (yield* store.listDescriptorsBySession(attempt.sessionId)).map((row) => row.kind)
        expect(resolvedKinds).toContain("resolved")
      }),
    )
  })

  test("kill-9 scenario: descriptors survive a restart and startup-inventory classifies them correctly", async () => {
    const dir = await tmpdir()
    const file = path.join(dir.path, "crash.db")
    await runDb(
      file,
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        // Crash-left durable state: one indeterminate attempt + its recovery descriptors.
        yield* db.run(sql`
          CREATE TABLE session_provider_attempt (attempt_id TEXT PRIMARY KEY, state TEXT NOT NULL)
        `)
        yield* db.run(sql`INSERT INTO session_provider_attempt VALUES ('att_durable', 'indeterminate_after_crash')`)
        // The other startup surfaces classifyStartup reads (empty => no items).
        yield* db.run(sql`CREATE TABLE session_v2_tool_effect (effect_id TEXT PRIMARY KEY, state TEXT NOT NULL, grant_state TEXT)`)
        yield* db.run(sql`CREATE TABLE task_run (run_id TEXT PRIMARY KEY, state TEXT NOT NULL, execution_owner TEXT, lease_expires_at INTEGER)`)
        yield* db.run(sql`CREATE TABLE event_snapshot_attempt (snapshot_id TEXT PRIMARY KEY, state TEXT NOT NULL)`)
        yield* db.run(sql`CREATE TABLE event_compaction_receipt (aggregate_id TEXT PRIMARY KEY, state TEXT NOT NULL)`)
        yield* db.run(sql`CREATE TABLE session_facade_activity (activity_id TEXT PRIMARY KEY, state TEXT NOT NULL)`)
        const store = SessionProviderRecoveryDurable.makeDurableRecoveryStore(db)
        for (const descriptor of fiveClassDescriptors()) {
          yield* store.putDescriptor({
            descriptor,
            sessionId: "ses_durable",
            activityId: "act_durable",
            turnId: "1",
            createdAt: 1,
          })
        }
      }),
    )
    // The boot classifies from the SAME rows (no process memory).
    await runDb(
      file,
      Effect.gen(function* () {
        const db = yield* makeDb
        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.byCategory.provider_attempt.recovery).toBe(1)
        expect(inventory.byCategory.provider_attempt.safe_before_dispatch).toBe(0)
        expect(inventory.byCategory.recovery_descriptor.recovery).toBe(4)
        expect(inventory.byCategory.recovery_descriptor.resolved).toBe(1)
        expect(inventory.byCategory.recovery_descriptor.unclassified).toBe(0)
        expect(inventory.ready).toBe(true)
      }),
    )
  })
})

describe("V2ProviderTurn terminal descriptors (W2)", () => {
  const row = (state: string) => ({
    receipt_id: "receipt_1",
    session_id: "ses_1",
    activity_id: "act_1",
    provider_turn_seq: 3,
    provider_attempt_id: null,
    request_input_hash: H64("r"),
    owner_token: "owner_1",
    state,
  })

  test("settled → resolved(settled) with the receipt as resolution ref", () => {
    const descriptor = V2ProviderTurn.turnTerminalDescriptor(row("settled"))
    expect(descriptor).toMatchObject({
      descriptorKind: "resolved",
      requestHash: H64("r"),
      resolved: { resolutionRef: "receipt_1", bridgeRef: "none", terminal: "settled" },
    })
  })

  test("failed → resolved(unknown): terminal locally, no provider verdict", () => {
    const descriptor = V2ProviderTurn.turnTerminalDescriptor(row("failed"))
    expect(descriptor).toMatchObject({
      descriptorKind: "resolved",
      resolved: { terminal: "unknown" },
    })
  })

  test("indeterminate_after_crash → coordination_required(network_unknown), never auto-replayed", () => {
    const descriptor = V2ProviderTurn.turnTerminalDescriptor(row("indeterminate_after_crash"))
    expect(descriptor).toMatchObject({
      descriptorKind: "coordination_required",
      coordination: { reason: "network_unknown", requiredActor: "admin" },
    })
  })

  test("non-terminal states produce no descriptor; digest is content-addressable and stable", () => {
    expect(V2ProviderTurn.turnTerminalDescriptor(row("dispatching"))).toBeUndefined()
    const a = V2ProviderTurn.turnTerminalDescriptor(row("settled"))!
    const b = V2ProviderTurn.turnTerminalDescriptor(row("settled"))!
    expect(RecoveryCommandContract.recoveryDescriptorDigest(a)).toBe(
      RecoveryCommandContract.recoveryDescriptorDigest(b),
    )
  })
})
