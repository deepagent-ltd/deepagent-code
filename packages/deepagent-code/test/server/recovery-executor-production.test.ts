import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { SessionProviderRecovery, SessionProviderRecoveryDurable } from "@deepagent-code/core/session/runner"
import { RecoveryExecutor } from "@/server/recovery-executor"

// W2.2 — production-level tests for the C1B recovery executor wiring (design §W2/W2.1 +
// §10.7 recovery order): a kill-9 restart leaves the committed-but-unapplied recovery
// commands as `pending` rows; the startup drain (executor layer build) applies the exit
// the descriptor class authorizes via the DURABLE service, idempotently, and a command
// that cannot be applied stays pending without blocking the boot.

const H64 = (c: string) => c.repeat(64)

const identity = (overrides: Partial<SessionProviderRecovery.AttemptIdentity> = {}): SessionProviderRecovery.AttemptIdentity => ({
  sessionId: "ses_prod",
  attemptId: "att_prod",
  activityId: "act_prod",
  providerTurnSeq: 1,
  selectionId: "sel_1",
  projectionHash: H64("p"),
  requestHash: H64("r"),
  providerId: "provider-test",
  ...overrides,
})

const classifyInput = (
  attempt: SessionProviderRecovery.AttemptIdentity,
  kind: "exact" | "repairable" | "fork" | "coordination" | "resolved",
): SessionProviderRecovery.ClassifyInput => {
  const base = {
    attempt,
    attemptState: "indeterminate_after_crash",
    expectedAttemptState: "indeterminate_after_crash",
    ownerToken: "",
    expectedVersion: 0,
    historyVerified: true,
    providerLookupComplete: true,
    placementUnresolved: false,
    permissionIncomplete: false,
    workspaceConflict: false,
  } satisfies SessionProviderRecovery.ClassifyInput
  if (kind === "exact") return { ...base, baseline: { baselineHash: H64("b"), verified: true, state: "present" } }
  if (kind === "repairable") return { ...base, baseline: { verified: false, state: "missing", sourceSnapshotRef: "snap:1" } }
  if (kind === "fork") {
    return { ...base, baseline: { verified: false, state: "present" }, safeBoundary: { safeBoundaryRef: "boundary:1", safeBoundaryHash: H64("sb") } }
  }
  if (kind === "coordination") return { ...base, baseline: { verified: false, state: "present" } }
  return { ...base, resolution: { resolutionRef: "resolution:1", bridgeRef: "bridge:1", terminal: "settled" } }
}

/** Seed a pending command bound to a classified descriptor (the durable record shape). */
const seedPending = (
  db: Database.Interface["db"],
  attempt: SessionProviderRecovery.AttemptIdentity,
  kind: "exact" | "repairable" | "fork" | "coordination" | "resolved",
  command: { readonly actorType?: "user" | "administrator" | "system"; readonly actorId?: string; readonly withDescriptor?: boolean } = {},
) =>
  Effect.gen(function* () {
    const store = SessionProviderRecoveryDurable.makeDurableRecoveryStore(db)
    const descriptor = SessionProviderRecovery.classify(classifyInput(attempt, kind))
    const descriptorWrite = yield* store.putDescriptor({
      descriptor,
      sessionId: attempt.sessionId,
      activityId: attempt.activityId,
      turnId: "1",
      createdAt: 1,
    })
    const cas = yield* store.putCommand({
      requestHash: attempt.requestHash,
      attemptIdentity: attempt,
      ...(command.withDescriptor === false ? {} : { descriptorId: descriptorWrite.descriptorId }),
      ...(command.actorType ? { actorType: command.actorType } : {}),
      ...(command.actorId ? { actorId: command.actorId } : {}),
      createdAt: 1,
    })
    return { commandId: cas.commandId }
  })

const allDescriptors = (db: Database.Interface["db"], sessionId: string) =>
  SessionProviderRecoveryDurable.makeDurableRecoveryStore(db).listDescriptorsBySession(sessionId)

const commandState = (db: Database.Interface["db"], commandId: string) =>
  Effect.map(SessionProviderRecoveryDurable.makeDurableRecoveryStore(db).getCommand(commandId), (row) => row?.state)

/** Open the business Database over a file (full migration + startup-inventory post-verify). */
const openDatabase = (file: string) =>
  Effect.gen(function* () {
    const built = yield* Layer.build(Database.layerFromPath(file))
    return yield* Database.Service.pipe(Effect.provide(built))
  })

/**
 * "Boot": build the production executor layer over an open database. Building it runs
 * the startup drain (process boot = post-crash resume). The durable service is the
 * production composition's `durableLayerWith` over the same db handle.
 */
const bootExecutor = (database: Database.Interface) =>
  Effect.gen(function* () {
    const durable = yield* SessionProviderRecovery.Service.pipe(
      Effect.provide(yield* Effect.scoped(Layer.build(SessionProviderRecovery.durableLayerWith(database.db)))),
    )
    return yield* RecoveryExecutor.Service.pipe(
      Effect.provide(
        yield* Layer.build(
          RecoveryExecutor.layer.pipe(
            Layer.provide(Layer.succeed(Database.Service, database)),
            Layer.provide(Layer.succeed(SessionProviderRecovery.Service, durable)),
          ),
        ),
      ),
    )
  })

describe("C1B recovery executor production wiring (W2.2)", () => {
  test("startup drain (executor layer build) applies a pending resolvable_exact command — state transition", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepagent-recovery-executor-"))
    const file = join(dir, "recovery-executor.sqlite")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const database = yield* openDatabase(file)
            const attempt = identity()
            // Record the committed exit decision (pending command, user actor).
            const seeded = yield* seedPending(database.db, attempt, "exact", { actorType: "user", actorId: "operator" })
            // Boot: the executor layer build runs the startup drain (the real production path).
            const executor = yield* bootExecutor(database)
            // The command moved pending → abandoned (durable state transition).
            expect(yield* commandState(database.db, seeded.commandId)).toBe("abandoned")
            // The abandon wrote its resolved(abandoned) terminal descriptor next to the original.
            const descriptors = yield* allDescriptors(database.db, attempt.sessionId)
            expect(descriptors.map((row) => row.kind).sort()).toEqual(["resolvable_exact", "resolved"])
            expect(descriptors.find((row) => row.kind === "resolved")?.payload.descriptorKind).toBe("resolved")
            // Idempotence: a re-run drains nothing (the slot is terminal).
            const report = yield* executor.drain
            expect(report.scanned).toBe(0)
            expect(report.applied).toBe(0)
          }),
        ),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("kill-9 restart: a NEW connection + executor applies the pending command committed by the dead process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepagent-recovery-executor-crash-"))
    const file = join(dir, "recovery-executor.sqlite")
    try {
      const attempt = identity({ attemptId: "att_crash", requestHash: H64("c") })
      // Process A commits the exit decision then dies (scope closes = connection gone).
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const database = yield* openDatabase(file)
            yield* seedPending(database.db, attempt, "exact", { actorType: "user", actorId: "operator" })
          }),
        ),
      )
      // Process B boots over the same file (fresh migration-ready connection + fresh
      // in-memory recovery state) — the layer build drain applies the pending command.
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const database = yield* openDatabase(file)
            yield* bootExecutor(database)
            const expected = SessionProviderRecovery.recoveryCommandContentAddress({
              requestHash: attempt.requestHash,
              attemptIdentity: attempt,
            })
            expect(yield* commandState(database.db, expected)).toBe("abandoned")
          }),
        ),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a command that cannot be applied stays pending and never blocks the boot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepagent-recovery-executor-keep-"))
    const file = join(dir, "recovery-executor.sqlite")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const database = yield* openDatabase(file)
            const system = yield* seedPending(database.db, { ...identity(), attemptId: "att_system", requestHash: H64("s") }, "exact", { actorType: "system", actorId: "kernel" })
            const unowned = yield* seedPending(database.db, { ...identity(), attemptId: "att_unowned", requestHash: H64("u") }, "exact", {})
            const repairable = yield* seedPending(database.db, { ...identity(), attemptId: "att_repair", requestHash: H64("p") }, "repairable", { actorType: "user", actorId: "operator" })
            const fork = yield* seedPending(database.db, { ...identity(), attemptId: "att_fork", requestHash: H64("f") }, "fork", { actorType: "user", actorId: "operator" })
            const coordination = yield* seedPending(database.db, { ...identity(), attemptId: "att_coord", requestHash: H64("o") }, "coordination", { actorType: "user", actorId: "operator" })
            const resolved = yield* seedPending(database.db, { ...identity(), attemptId: "att_resolved", requestHash: H64("e") }, "resolved", { actorType: "user", actorId: "operator" })
            const orphan = yield* seedPending(database.db, { ...identity(), attemptId: "att_orphan", requestHash: H64("q") }, "exact", { actorType: "user", actorId: "operator", withDescriptor: false })
            // Boot with these rows present: no throw, no half-application.
            const executor = yield* bootExecutor(database)
            const report = yield* executor.drain
            expect(report.applied).toBe(0)
            expect(report.failed).toEqual([])
            expect(report.keptPending.map((item) => item.reason).sort()).toEqual(
              [
                "pending_command_without_actor",
                "pending_command_without_descriptor",
                "requires_admin_coordination",
                "requires_baseline_reconstruction",
                "requires_safe_boundary_history",
                "resolved_descriptor_no_exit",
                "system_actor_exit_refused",
              ].sort(),
            )
            // Every row is still pending (state preserved).
            const states = yield* Effect.all(
              [system, unowned, repairable, fork, coordination, resolved, orphan].map((row) => commandState(database.db, row.commandId)),
            )
            expect(states).toEqual(["pending", "pending", "pending", "pending", "pending", "pending", "pending"])
          }),
        ),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("no pending commands → the drain is a no-op", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepagent-recovery-executor-empty-"))
    const file = join(dir, "recovery-executor.sqlite")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const database = yield* openDatabase(file)
            const executor = yield* bootExecutor(database)
            const report = yield* executor.drain
            expect(report).toEqual({ scanned: 0, applied: 0, keptPending: [], failed: [] })
          }),
        ),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
