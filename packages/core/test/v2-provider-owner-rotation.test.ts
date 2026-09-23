import { expect, describe } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { Database } from "../src/database/database"
import { SessionProviderOwner } from "../src/context-federation/provider-owner"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionSchema } from "../src/session/schema"
import { SessionTable } from "../src/session/sql"
import { V2ProviderTurn } from "../src/session/runner/v2-provider-turn"
import { Hash } from "../src/util/hash"
import { testEffect } from "./lib/effect"

// Regression: a heartbeat gap past the lease (stalled event loop / long DB wait) must NOT brick the
// process. The previous owner heartbeat latched `healthy` false forever on
// `provider_owner_lease_not_live`, so every later turn failed with
// `v2_provider_owner_not_healthy`. The fixed maintenance loop rotates to a successor generation and
// keeps serving turns, matching ContextFederationProviderOwnerRuntime (the deepagent-code twin).
//
// The heartbeat is wrapped around the REAL durable owner store, so the receipt's owner_token FK and
// lease liveness behave exactly as production; only the first heartbeat is made to report the fenced
// condition (which production reaches by drifting the wall clock past the lease).

const ownerBase = "v2-rotation-base"
const sessionID = SessionSchema.ID.make("ses_v2_owner_rotation")

const seedSession = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "owner-rotation",
      directory: "/project",
      title: "owner rotation",
      version: "test",
      execution_claim_token: 104,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const admit = (service: V2ProviderTurn.Interface, suffix: string) =>
  service.admit({
    sessionId: sessionID,
    userMessageId: `msg-${suffix}`,
    historyPromptEpoch: 0,
    requestInputHash: Hash.sha256(`rotation-${suffix}`),
    providerId: "provider-test",
    modelId: "model-test",
    protocol: "openai-chat",
    ownerMode: "v2",
  })

/** Fresh database; `heartbeatFailures` fenced heartbeats are injected before the store behaves normally. */
function harness(heartbeatFailures: number) {
  const database = Database.layerFromPath(":memory:")
  const realOwners = SessionProviderOwner.layer.pipe(Layer.provide(database))
  const owners = Layer.effect(
    SessionProviderOwner.Service,
    Effect.gen(function* () {
      const real = yield* SessionProviderOwner.Service
      const failures = yield* Ref.make(heartbeatFailures)
      return SessionProviderOwner.Service.of({
        get: real.get,
        register: real.register,
        release: real.release,
        heartbeat: (input) =>
          Effect.gen(function* () {
            const remaining = yield* Ref.get(failures)
            if (remaining > 0) {
              yield* Ref.set(failures, remaining - 1)
              return yield* new SessionProviderOwner.ConflictError({ reason: "provider_owner_lease_not_live" })
            }
            return yield* real.heartbeat(input)
          }),
      })
    }),
  ).pipe(Layer.provide(realOwners))
  // A long lease means every real heartbeat keeps the generation live, so exactly the injected
  // failure drives one rotation and no further churn.
  const turns = V2ProviderTurn.layerWith({ ownerToken: ownerBase, leaseMs: 600_000 }).pipe(
    Layer.provide(owners),
    Layer.provide(database),
  )
  return testEffect(Layer.mergeAll(database, realOwners, owners, turns))
}

describe("V2 provider owner rotation", () => {
  const fenced = harness(1)

  fenced.live("rotates to a successor generation on a fenced lease and keeps serving turns", () =>
    Effect.gen(function* () {
      yield* seedSession
      const service = yield* V2ProviderTurn.Service
      expect(yield* service.currentOwnerToken()).toBe(ownerBase)

      // Bounded poll (no fixed sleep) for the maintenance loop's fenced heartbeat to rotate.
      const rotated = yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 2000; attempt++) {
          const token = yield* service.currentOwnerToken()
          if (token !== ownerBase) return token
          yield* Effect.sleep("5 millis")
        }
        return yield* Effect.die(new Error("owner never rotated after the fenced lease"))
      })

      expect(rotated.startsWith(`${ownerBase}:gen-1:`)).toBe(true)

      // The reason the fix exists: a post-fence turn must still be admitted. The old behavior
      // latched `healthy` false and failed this with `v2_provider_owner_not_healthy`.
      const receipt = yield* admit(service, "after-fence")
      expect(receipt.ownerToken).toBe(rotated)
      expect(receipt.state).toBe("preparing")
    }),
  )

  const steady = harness(0)

  steady.live("does not rotate while heartbeats stay live", () =>
    Effect.gen(function* () {
      yield* seedSession
      const service = yield* V2ProviderTurn.Service
      yield* Effect.sleep("50 millis")
      expect(yield* service.currentOwnerToken()).toBe(ownerBase)
      expect((yield* admit(service, "steady")).ownerToken).toBe(ownerBase)
    }),
  )
})
