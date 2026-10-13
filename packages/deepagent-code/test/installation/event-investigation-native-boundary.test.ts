import { expect } from "bun:test"
import { Effect, Layer, Result } from "effect"
import { LLMClient } from "@deepagent-code/llm"
import { Auth } from "@deepagent-code/llm/route"
import { OpenAIResponses } from "@deepagent-code/llm/protocols/openai-responses"
import { NativeRuntime } from "../../src/installation/native-runtime"
import { EventInvestigationHost } from "../../src/deepagent/event-investigation"
import { EventInvestigationFixture } from "../../../core/test/fixture/event-investigation"
import { EventInvestigationEvidenceFixture } from "./fixture/event-investigation-evidence"
import { EventValidation } from "@deepagent-code/core/deepagent/event-validation"
import { testEffect } from "../lib/effect"

const it = testEffect(
  NativeRuntime.layer.pipe(
    Layer.provide(
      NativeRuntime.clientLayer.pipe(
        Layer.provide(Layer.succeed(LLMClient.Middleware, () => ({ prepare: (next) => next, stream: (next) => next }))),
      ),
    ),
  ),
)

it.live("an investigation purpose cannot authorize an unregistered model or reconstruct actual Native identity", () =>
  Effect.gen(function* () {
    const physical = { requests: 0 }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        physical.requests++
        return new Response("unexpected")
      },
    })
    yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))
    const native = yield* NativeRuntime.Service
    const resolved = {
      model: OpenAIResponses.route
        .with({ endpoint: { baseURL: server.url.origin }, auth: Auth.value("owned-fixture-key").bearer() })
        .model({ id: "owned-fixture" }),
    }
    const defaultRefusal = yield* native.approve(resolved).pipe(Effect.result)
    const eventRefusal = yield* native.approve(resolved, "event_investigate_v1").pipe(Effect.result)
    const readinessRefusal = yield* native.requirePurpose("event_investigate_v1").pipe(Effect.result)
    expect(Result.isFailure(defaultRefusal)).toBe(true)
    expect(Result.isFailure(eventRefusal)).toBe(true)
    expect(Result.isFailure(readinessRefusal)).toBe(true)
    if (Result.isFailure(defaultRefusal)) expect(defaultRefusal.failure.code).toBe("NATIVE_RUNTIME_UNAVAILABLE")
    if (Result.isFailure(eventRefusal)) expect(eventRefusal.failure.code).toBe("NATIVE_RUNTIME_UNAVAILABLE")
    if (Result.isFailure(readinessRefusal)) expect(readinessRefusal.failure.code).toBe("NATIVE_RUNTIME_UNAVAILABLE")
    expect(native.live()).toBe(0)
    expect(physical.requests).toBe(0)
  }),
)

const missing = testEffect(EventInvestigationHost.layer)
missing.live("absent real host services cannot mint grant or failure captures from candidate JSON", () =>
  Effect.gen(function* () {
    const host = yield* EventInvestigationHost.Service
    const binding = EventInvestigationFixture.binding()
    const original = EventInvestigationEvidenceFixture.failed()
    const target = {
      version: 2 as const,
      scope: binding.scope,
      location: binding.location,
      agentID: binding.agentID,
      profile: binding.profile,
      provider: binding.provider,
      budget: binding.budget,
      durationMs: 10000,
      projectScope: binding.projectScope,
      contextPolicy: binding.contextPolicy,
      toolPolicy: binding.toolPolicy,
      childPolicy: binding.childPolicy,
    }
    const input = {
      rule: original.rule,
      targetID: "target",
      target,
      principal: {
        instanceID: original.rule.instanceID,
        actorID: "operator",
        revision: 1,
        identityHash: "a".repeat(64),
      },
      expiresAt: Date.now() + 60000,
    }
    const grant = {
      version: 1 as const,
      grantID: "grant-data",
      epoch: 1,
      ruleID: original.rule.ruleID,
      principal: input.principal,
      credentialGeneration: 1,
      policyRevision: 1,
      policyHash: "b".repeat(64),
      targetID: input.targetID,
      target,
      scopeHash: EventValidation.hash(original.rule.configuration.scope),
      createdAt: Date.now(),
      expiresAt: input.expiresAt,
    }
    const refusedGrant = yield* host.native.approveGrant(input).pipe(Effect.result)
    const refusedFailure = yield* host.native
      .observeFailure({ rule: original.rule, run: original.run, grant })
      .pipe(Effect.result)
    expect(Result.isFailure(refusedGrant)).toBe(true)
    expect(Result.isFailure(refusedFailure)).toBe(true)
    if (Result.isFailure(refusedGrant)) expect(refusedGrant.failure.code).toBe("INVESTIGATION_UNAVAILABLE")
    if (Result.isFailure(refusedFailure)) expect(refusedFailure.failure.code).toBe("INVESTIGATION_UNAVAILABLE")
    expect(Reflect.apply(host.native.approvedGrant, host.native, [{ approved: true }, input])).toBe(false)
    expect(Reflect.apply(host.native.failure, host.native, [{ evidence: original.run }])).toBeUndefined()
  }),
)
