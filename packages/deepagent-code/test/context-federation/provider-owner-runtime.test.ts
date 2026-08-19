import { describe, expect, test } from "bun:test"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { Database } from "@deepagent-code/core/database/database"
import { Cause, Effect, Exit, Layer, Option, Ref } from "effect"
import { ContextFederationProviderOwnerRuntime } from "../../src/context-federation/provider-owner-runtime"

describe("ContextFederationProviderOwnerRuntime", () => {
  test("permanently fences mutations after the durable owner lease expires", async () => {
    let recovered = 0
    const healthy = await Effect.runPromise(Ref.make(true))

    const continued = await Effect.runPromise(
      ContextFederationProviderOwnerRuntime.tick({
        owners: {
          heartbeat: () =>
            Effect.fail(new SessionProviderOwner.ConflictError({ reason: "provider_owner_lease_not_live" })),
        },
        ownerToken: "expired-owner",
        leaseMs: 30_000,
        healthy,
        label: "test provider",
        recover: Effect.sync(() => recovered++),
      }),
    )

    expect(continued).toBe(false)
    expect(await Effect.runPromise(Ref.get(healthy))).toBe(false)
    expect(recovered).toBe(0)
  })

  test("keeps the runtime healthy so a transient heartbeat failure can retry", async () => {
    let recovered = 0
    const healthy = await Effect.runPromise(Ref.make(true))

    const continued = await Effect.runPromise(
      ContextFederationProviderOwnerRuntime.tick({
        owners: { heartbeat: () => Effect.die(new Error("database temporarily unavailable")) },
        ownerToken: "retry-owner",
        leaseMs: 30_000,
        healthy,
        label: "test provider",
        recover: Effect.sync(() => recovered++),
      }),
    )

    expect(continued).toBe(true)
    expect(await Effect.runPromise(Ref.get(healthy))).toBe(true)
    expect(recovered).toBe(0)
  })

  test("runs recovery only after a successful heartbeat", async () => {
    let recovered = 0
    const healthy = await Effect.runPromise(Ref.make(true))

    const continued = await Effect.runPromise(
      ContextFederationProviderOwnerRuntime.tick({
        owners: {
          heartbeat: ({ ownerToken, leaseMs }) =>
            Effect.succeed({
              ownerToken,
              registeredAt: 1,
              heartbeatAt: 2,
              leaseExpiresAt: 2 + leaseMs,
            }),
        },
        ownerToken: "healthy-owner",
        leaseMs: 30_000,
        healthy,
        label: "test provider",
        recover: Effect.sync(() => recovered++),
      }),
    )

    expect(continued).toBe(true)
    expect(await Effect.runPromise(Ref.get(healthy))).toBe(true)
    expect(recovered).toBe(1)
  })
})

describe("RISK-004 drill: provider owner lease drift against the real store", () => {
  // The lease table's authority triggers forbid backdating lease_expires_at from outside the
  // heartbeat path, so drift is simulated with a minimal lease and a bounded poll — no fixed sleep.
  const driftLeaseMs = 10
  const waitUntilDrifted = (heartbeat: () => Effect.Effect<unknown, SessionProviderOwner.ConflictError>) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 500; attempt++) {
        const exit = yield* heartbeat().pipe(Effect.exit)
        if (Exit.isFailure(exit)) return
        yield* Effect.sleep("10 millis")
      }
      return yield* Effect.die(new Error("owner lease never drifted past expiry"))
    })

  test("d: a heartbeat gap beyond LeaseMs fences the owner and a successor registers", async () => {
    const database = Database.layerFromPath(":memory:")
    await Effect.runPromise(
      Effect.gen(function* () {
        const owners = yield* SessionProviderOwner.Service
        yield* owners.register({ ownerToken: "owner-a", leaseMs: driftLeaseMs })
        // Stop heartbeating: the lease drifts past expiry on the database clock.
        yield* waitUntilDrifted(() => owners.heartbeat({ ownerToken: "owner-a", leaseMs: driftLeaseMs }))

        const missed = yield* owners.heartbeat({ ownerToken: "owner-a", leaseMs: driftLeaseMs }).pipe(Effect.exit)
        expect(Exit.isFailure(missed)).toBe(true)
        if (!Exit.isFailure(missed)) return
        const missedError = Option.getOrUndefined(Cause.findErrorOption(missed.cause))
        expect(missedError).toBeInstanceOf(SessionProviderOwner.ConflictError)
        if (missedError instanceof SessionProviderOwner.ConflictError) {
          expect(missedError.reason).toBe("provider_owner_lease_not_live")
        }

        const successor = yield* owners.register({ ownerToken: "owner-b", leaseMs: SessionProviderOwner.LeaseMs })
        expect(successor.ownerToken).toBe("owner-b")
        const beat = yield* owners.heartbeat({ ownerToken: "owner-b", leaseMs: SessionProviderOwner.LeaseMs })
        expect(beat.leaseExpiresAt).toBeGreaterThanOrEqual(successor.leaseExpiresAt)

        const stillFenced = yield* owners
          .heartbeat({ ownerToken: "owner-a", leaseMs: SessionProviderOwner.LeaseMs })
          .pipe(Effect.exit)
        expect(Exit.isFailure(stillFenced)).toBe(true)
      }).pipe(
        Effect.provide(SessionProviderOwner.layer.pipe(Layer.provide(database))),
        Effect.provide(database),
      ),
    )
  })

  test("d: runtime tick stops mutations once the real store reports the lease drifted away", async () => {
    const database = Database.layerFromPath(":memory:")
    await Effect.runPromise(
      Effect.gen(function* () {
        const owners = yield* SessionProviderOwner.Service
        yield* owners.register({ ownerToken: "drift-owner", leaseMs: driftLeaseMs })
        yield* waitUntilDrifted(() => owners.heartbeat({ ownerToken: "drift-owner", leaseMs: driftLeaseMs }))

        const healthy = yield* Ref.make(true)
        const continued = yield* ContextFederationProviderOwnerRuntime.tick({
          owners,
          ownerToken: "drift-owner",
          leaseMs: driftLeaseMs,
          healthy,
          label: "drill provider",
        })
        expect(continued).toBe(false)
        expect(yield* Ref.get(healthy)).toBe(false)
      }).pipe(
        Effect.provide(SessionProviderOwner.layer.pipe(Layer.provide(database))),
        Effect.provide(database),
      ),
    )
  })
})
