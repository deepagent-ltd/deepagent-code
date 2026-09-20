import { expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { ContextQueryAuthorization } from "../../src/context-federation/query-authorization"
import { LocationKey, ProjectScopeKey, SecurityNamespaceID } from "../../src/context-federation/reference"

const envelope: ContextQueryAuthorization.Envelope = {
  principal: {
    securityNamespaceId: SecurityNamespaceID.make("namespace-1"),
    principalId: "principal-1",
    authorizationEpoch: 1,
    locationKeys: [LocationKey.make("location-1")],
    projectScopeKeys: [ProjectScopeKey.make("project-1")],
    sessionIds: ["session-1"],
    subjectIds: [],
    allowBuiltin: false,
  },
  egress: {
    policyId: "provider-1",
    epoch: 1,
    graphs: ["code"],
    sensitivities: ["source_code"],
  },
}

test("query authorization state is isolated per built Location runtime", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const first = yield* Layer.build(ContextQueryAuthorization.layer())
        yield* Context.get(first, ContextQueryAuthorization.Controller).bind({
          sessionId: "session-1",
          envelope,
        })
        expect(yield* Context.get(first, ContextQueryAuthorization.Service).resolve({ sessionId: "session-1", agent: "general" })).toEqual(envelope)

        const second = yield* Layer.build(ContextQueryAuthorization.layer())
        expect(yield* Context.get(second, ContextQueryAuthorization.Service).resolve({ sessionId: "session-1", agent: "general" })).toBeUndefined()
      }),
    ),
  )
})
