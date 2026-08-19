import { describe, expect, test } from "bun:test"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { Database } from "@deepagent-code/core/database/database"
import { Cause, Effect, Exit, Layer, Option, Ref } from "effect"
import { ContextFederationProviderOwnerRuntime } from "../../src/context-federation/provider-owner-runtime"

const makeLease = (ownerToken: string, leaseMs: number): SessionProviderOwner.Lease => ({
  ownerToken,
  registeredAt: 1,
  heartbeatAt: 2,
  leaseExpiresAt: 2 + leaseMs,
})

describe("ContextFederationProviderOwnerRuntime", () => {
  test("rotates to a successor owner generation when the durable lease fences the old token", async () => {
    let recovered = 0
    const registered: string[] = []
    const healthy = await Effect.runPromise(Ref.make(true))
    const owner = await Effect.runPromise(
      Ref.make<ContextFederationProviderOwnerRuntime.OwnerGeneration>({ ownerToken: "base:gen-0:old", generation: 0 }),
    )

    const continued = await Effect.runPromise(
      ContextFederationProviderOwnerRuntime.tick({
        owners: {
          heartbeat: () =>
            Effect.fail(new SessionProviderOwner.ConflictError({ reason: "provider_owner_lease_not_live" })),
          register: ({ ownerToken, leaseMs }) => {
            registered.push(ownerToken)
            return Effect.succeed(makeLease(ownerToken, leaseMs))
          },
        },
        owner,
        ownerBase: "base",
        leaseMs: 30_000,
        healthy,
        label: "test provider",
        recover: Effect.sync(() => recovered++),
      }),
    )

    const rotated = await Effect.runPromise(Ref.get(owner))
    expect(continued).toBe(true)
    expect(await Effect.runPromise(Ref.get(healthy))).toBe(true)
    expect(recovered).toBe(0)
    expect(rotated.generation).toBe(1)
    expect(rotated.ownerToken.startsWith("base:gen-1:")).toBe(true)
    expect(rotated.ownerToken).not.toBe("base:gen-0:old")
    expect(registered).toEqual([rotated.ownerToken])
  })

  test("keeps the fenced generation and retries next tick when successor registration fails", async () => {
    const healthy = await Effect.runPromise(Ref.make(true))
    const owner = await Effect.runPromise(
      Ref.make<ContextFederationProviderOwnerRuntime.OwnerGeneration>({ ownerToken: "base:gen-0:old", generation: 0 }),
    )

    const continued = await Effect.runPromise(
      ContextFederationProviderOwnerRuntime.tick({
        owners: {
          heartbeat: () =>
            Effect.fail(new SessionProviderOwner.ConflictError({ reason: "provider_owner_lease_not_live" })),
          register: () =>
            Effect.fail(new SessionProviderOwner.ConflictError({ reason: "owner_token_already_registered" })),
        },
        owner,
        ownerBase: "base",
        leaseMs: 30_000,
        healthy,
        label: "test provider",
      }),
    )

    expect(continued).toBe(true)
    expect(await Effect.runPromise(Ref.get(healthy))).toBe(true)
    expect(await Effect.runPromise(Ref.get(owner))).toEqual({ ownerToken: "base:gen-0:old", generation: 0 })
  })

  test("keeps the runtime healthy so a transient heartbeat failure can retry", async () => {
    let recovered = 0
    const healthy = await Effect.runPromise(Ref.make(true))
    const owner = await Effect.runPromise(
      Ref.make<ContextFederationProviderOwnerRuntime.OwnerGeneration>({ ownerToken: "retry-owner", generation: 0 }),
    )

    const continued = await Effect.runPromise(
      ContextFederationProviderOwnerRuntime.tick({
        owners: {
          heartbeat: () => Effect.die(new Error("database temporarily unavailable")),
          register: () => Effect.die(new Error("register must not run on a transient heartbeat failure")),
        },
        owner,
        ownerBase: "retry-owner",
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
    const owner = await Effect.runPromise(
      Ref.make<ContextFederationProviderOwnerRuntime.OwnerGeneration>({ ownerToken: "healthy-owner", generation: 0 }),
    )

    const continued = await Effect.runPromise(
      ContextFederationProviderOwnerRuntime.tick({
        owners: {
          heartbeat: ({ ownerToken, leaseMs }) => Effect.succeed(makeLease(ownerToken, leaseMs)),
          register: () => Effect.die(new Error("register must not run on a live heartbeat")),
        },
        owner,
        ownerBase: "healthy-owner",
        leaseMs: 30_000,
        healthy,
        label: "test provider",
        recover: Effect.sync(() => recovered++),
      }),
    )

    expect(continued).toBe(true)
    expect(await Effect.runPromise(Ref.get(healthy))).toBe(true)
    expect(recovered).toBe(1)
    expect(await Effect.runPromise(Ref.get(owner))).toEqual({ ownerToken: "healthy-owner", generation: 0 })
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

  test("d: runtime tick rotates to a live successor generation once the real store fences the lease", async () => {
    const database = Database.layerFromPath(":memory:")
    await Effect.runPromise(
      Effect.gen(function* () {
        const owners = yield* SessionProviderOwner.Service
        const startupToken = "drift-base:gen-0:seed"
        yield* owners.register({ ownerToken: startupToken, leaseMs: driftLeaseMs })
        yield* waitUntilDrifted(() => owners.heartbeat({ ownerToken: startupToken, leaseMs: driftLeaseMs }))

        const healthy = yield* Ref.make(true)
        const owner = yield* Ref.make<ContextFederationProviderOwnerRuntime.OwnerGeneration>({
          ownerToken: startupToken,
          generation: 0,
        })
        const continued = yield* ContextFederationProviderOwnerRuntime.tick({
          owners,
          owner,
          ownerBase: "drift-base",
          leaseMs: SessionProviderOwner.LeaseMs,
          healthy,
          label: "drill provider",
        })
        expect(continued).toBe(true)
        expect(yield* Ref.get(healthy)).toBe(true)
        const rotated = yield* Ref.get(owner)
        expect(rotated.generation).toBe(1)
        expect(rotated.ownerToken.startsWith("drift-base:gen-1:")).toBe(true)

        // The successor token passes the durable lease guards (register + heartbeat clock checks),
        // so attempt/receipt writers holding the current generation pass the lease fence.
        const beat = yield* owners.heartbeat({ ownerToken: rotated.ownerToken, leaseMs: SessionProviderOwner.LeaseMs })
        expect(beat.leaseExpiresAt).toBeGreaterThan(beat.heartbeatAt)

        // The fenced startup token stays dead — rotation never revives or extends it.
        const stillFenced = yield* owners
          .heartbeat({ ownerToken: startupToken, leaseMs: SessionProviderOwner.LeaseMs })
          .pipe(Effect.exit)
        expect(Exit.isFailure(stillFenced)).toBe(true)

        // The following tick heartbeats the successor token and runs recovery without rotating again.
        let recovered = 0
        const nextContinued = yield* ContextFederationProviderOwnerRuntime.tick({
          owners,
          owner,
          ownerBase: "drift-base",
          leaseMs: SessionProviderOwner.LeaseMs,
          healthy,
          label: "drill provider",
          recover: Effect.sync(() => recovered++),
        })
        expect(nextContinued).toBe(true)
        expect(recovered).toBe(1)
        expect(yield* Ref.get(owner)).toEqual(rotated)
        expect(yield* Ref.get(healthy)).toBe(true)
      }).pipe(
        Effect.provide(SessionProviderOwner.layer.pipe(Layer.provide(database))),
        Effect.provide(database),
      ),
    )
  })
})
