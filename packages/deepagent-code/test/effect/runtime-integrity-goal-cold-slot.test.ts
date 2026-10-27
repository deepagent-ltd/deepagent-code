import { expect, test } from "bun:test"
import path from "node:path"
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Catalog } from "@deepagent-code/core/catalog"
import { Database } from "@deepagent-code/core/database/database"
import { Flag } from "@deepagent-code/core/flag/flag"
import { GoalChild } from "@deepagent-code/core/deepagent/goal-child"
import { GoalChildExecution } from "@deepagent-code/core/deepagent/goal-child-execution"
import { GoalChildPolicy } from "@deepagent-code/core/deepagent/goal-child-policy"
import { GoalChildResult } from "@deepagent-code/core/deepagent/goal-child-result"
import { GoalTickCheckpoint } from "@deepagent-code/core/deepagent/goal-tick-checkpoint"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"
import { Hash } from "@deepagent-code/core/util/hash"
import { GoalChildC1Fixture } from "../../../core/test/fixture/goal-child-c1"
import { AppLayer, AppRuntime } from "../../src/effect/app-runtime"
import { CompositionDigest } from "../../src/effect/composition-digest"
import { RuntimeIntegrityIdentity } from "../../src/effect/runtime-integrity-identity"
import { tmpdir } from "../fixture/fixture"
import { EmptySettingsFixture } from "../fixture/empty-settings"
import { NativeWindowsBootstrap } from "../../src/installation/windows-native-bootstrap"

// A new isolated root and two loopback requests exercise the cold transaction boundary.
// No precomputed fixture identity, database proof rewrite, model account or Native qualification.
test("a real cold root slot fails inside Goal transactions and warms outside before retained proof reads", async () => {
  await using fixture = await tmpdir()
  const original = Flag.DEEPAGENT_CODE_DB
  const filename = path.join(fixture.path, "cold-goal-proof.sqlite")
  Flag.DEEPAGENT_CODE_DB = filename
  const observed = { requests: 0 }
  const runtime = process.platform === "win32"
    ? ManagedRuntime.make(
      AppLayer.pipe(
        Layer.provideMerge(
          Layer.unwrap(Effect.gen(function* () {
            if (yield* NativeWindowsBootstrap.Registered)
              return yield* Effect.die(new Error("Empty settings cold Root fixture cannot replace registered Native storage"))
            return EmptySettingsFixture.layer
          })),
        ),
      ),
    )
    : AppRuntime
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    observed.requests++
    if (observed.requests === 1)
      return Response.json({ error: { message: "Local temporary refusal", type: "server_error" } }, {
        status: 503, headers: { "retry-after-ms": "1" },
      })
    return new Response([
      { id: "cold-slot-local", choices: [{ index: 0, delta: { content: "Retained cold-slot proof" }, finish_reason: null }] },
      { id: "cold-slot-local", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: {
        prompt_tokens: 20, completion_tokens: 5, total_tokens: 25,
        prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 },
      } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    })
  } })
  try {
    await runtime.runPromise(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      expect((yield* db.all<{ file: string }>("PRAGMA database_list"))[0]?.file)
        .toBe(filename)
      const slot = yield* RuntimeIntegrityIdentity.RootIdentitySlot
      const resolver = RuntimeIntegrityIdentity.slotResolver(slot)
      expect(slot.context).toBeDefined()
      const actualIdentity = yield* resolver.resolve(yield* Effect.context()).pipe(Effect.timeout("15 seconds"))
      expect(actualIdentity.rootCompositionDigest).toBe((yield* CompositionDigest.current).digest)
      const placement = (yield* LocationServiceMap).get({ directory: AbsolutePath.make(fixture.path) })
      yield* Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const transform = yield* catalog.transform()
        yield* transform((editor) => {
          editor.provider.update(ProviderV2.ID.make("goal-fixture"), (provider) => {
            provider.enabled = { via: "custom", data: {} }
            provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url.origin}/v1` }
          })
          editor.model.update(ProviderV2.ID.make("goal-fixture"), ModelV2.ID.make("never-called"), (model) => {
            model.enabled = true
            model.api = { id: model.id, type: "aisdk", package: "@ai-sdk/openai-compatible",
              url: `${server.url.origin}/v1`, protocol: "openai-compatible.chat" }
            model.limit = { context: 128_000, output: 1_024 }
          })
        })
        const goal = yield* GoalChildC1Fixture.prepare(fixture.path)
        const policy = yield* GoalChildPolicy.prepare(db, yield* AgentV2.Service, {
          permitID: goal.permit.permit_id, roleKey: goal.admission.roleKey, agent: "worker", mode: "plain",
        })
        const child = yield* GoalChild.admitV2(db, yield* SessionV2.Service, { ...goal.admission, policy })
        const owned = yield* SessionExecution.requireOwned(yield* SessionExecution.Service)
        const run = yield* owned.run(GoalChildExecution.target(child.unit))
        if (run.status !== "started") throw new Error(run.status)
        const completed = yield* owned.await(run.receipt)
        if (completed.status === "settled" && Exit.isFailure(completed.exit)) return yield* Effect.failCause(completed.exit.cause)
        expect(completed.status === "settled" && Exit.isSuccess(completed.exit)).toBe(true)
        expect(observed.requests).toBe(2)
        const proof = yield* GoalChildResult.inspect(db, child.unit.unit_id, "plain")
        const before = yield* GoalChildResult.recheck(db, proof)

        // Only this test root's cache is cleared. The captured production context remains real.
        slot.identity = undefined
        slot.derivation = undefined
        const cold = yield* db.transaction(() => GoalChildResult.inspect(db, child.unit.unit_id, "plain"), {
          behavior: "deferred",
        }).pipe(
          Effect.timeout("2 seconds"), Effect.exit,
        )
        expect(Exit.isFailure(cold) && Cause.squash(cold.cause)).toMatchObject({ _tag: "GoalChild.Error" })
        expect(slot.identity).toBeUndefined()
        expect(slot.derivation).toBeUndefined()
        const direct = yield* GoalChildResult.inspect(db, child.unit.unit_id, "plain").pipe(Effect.timeout("15 seconds"))
        expect((yield* GoalChildResult.recheck(db, direct)).result).toEqual(before.result)
        expect(resolver.current?.()).toEqual(actualIdentity)

        slot.identity = undefined
        slot.derivation = undefined
        const warmed = yield* GoalChildResult.withRuntimeIdentity(db)(
          db.transaction((tx) => GoalChildResult.recheck(tx, proof), { behavior: "deferred" }),
        ).pipe(Effect.timeout("15 seconds"))
        expect(resolver.current?.()).toEqual(actualIdentity)
        expect(warmed.result).toEqual(before.result)
        expect(warmed.result.usageDerivation.refusals).toMatchObject({ count: 1, billing: "unknown" })

        slot.identity = undefined
        slot.derivation = undefined
        yield* GoalTickCheckpoint.recordResult(db, proof).pipe(Effect.timeout("15 seconds"))
        expect(resolver.current?.()).toEqual(actualIdentity)
        expect((yield* GoalChildResult.recheck(db, proof)).result).toEqual(before.result)
        const wrong = RuntimeIntegrityIdentity.slotResolver({
          identity: { ...actualIdentity, rootCompositionDigest: Hash.sha256("wrong isolated root") },
        })
        const rejected = yield* GoalChildResult.inspect(db, child.unit.unit_id, "plain").pipe(
          Effect.provideService(V2ProviderTurn.CurrentRuntimeIntegrityIdentity, wrong), Effect.exit,
        )
        expect(Exit.isFailure(rejected)).toBe(true)
        expect(observed.requests).toBe(2)
      }).pipe(Effect.provide(placement))
    }).pipe(Effect.scoped))
  } finally {
    await server.stop(true)
    await runtime.dispose()
    Flag.DEEPAGENT_CODE_DB = original
  }
}, 45_000)
