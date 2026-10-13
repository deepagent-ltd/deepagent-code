import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { LocalOperatorPolicy } from "../../src/im/local-operator-policy"

const target = {
  id: "retired",
  directory: "/private/absent-retired-im-policy-target",
  agentID: "auto",
  providerID: "fixture",
  modelID: "fixture",
  budget: { ...WorkAuthorityPolicy.TEXT_ONLY_PROFILE.budget },
}

// These services have no callable ports: an attempted database or identity use
// fails the test. The real resolver must reject old policy data before discovery.
const services = Layer.mergeAll(
  Layer.succeed(Database.Service, {
    get db(): Database.Interface["db"] {
      throw new Error("Retired policy accessed the database")
    },
  }),
  Layer.mock(LocationIdentity.Service, {}),
)

test.each([1, 5] as const)("retained v%s text-only policy data cannot enroll execution", async (version) => {
  const policy = { version, targets: [target] }
  expect(await Effect.runPromise(LocalOperatorPolicy.parse(policy))).toEqual(policy)
  const outcome = await Effect.runPromise(
    LocalOperatorPolicy.resolve(policy, "local-owner").pipe(Effect.provide(services), Effect.scoped, Effect.result),
  )
  expect(outcome._tag).toBe("Failure")
  if (outcome._tag !== "Failure") throw new Error("Retired IM policy enrolled execution")
  expect(outcome.failure).toMatchObject({ code: "LOCAL_TASK_EXECUTION_UNAVAILABLE" })
})
