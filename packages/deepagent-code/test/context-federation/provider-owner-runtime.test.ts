import { describe, expect, test } from "bun:test"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { Effect, Ref } from "effect"
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
