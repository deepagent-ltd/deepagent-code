import { expect, test } from "bun:test"
import { Context, Effect, Exit, Layer, Logger, Scope } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { WorkToolPolicy } from "@deepagent-code/core/session/work-tool-policy"
import { LocalTaskAuthority } from "../../src/im/local-task-authority"
import { WorkLeafProof } from "../../src/installation/work-leaf-proof"

test("original file database refusals report fixed stages without exposing the effect identifier", async () => {
  const entries: string[] = []
  const identifier = "private-effect-identifier-not-for-logs"
  const result = await Effect.runPromise(Effect.gen(function* () {
    yield* LocalTaskAuthority.initializeInstallation()
    const context = yield* Layer.build(WorkLeafProof.layer.pipe(Layer.provide(Database.defaultLayer)))
    const proof = Context.get(context, WorkToolPolicy.LeafProof)
    return [yield* proof.verify(identifier).pipe(Effect.result),
      yield* proof.requireVerified(identifier).pipe(Effect.result)]
  }).pipe(Effect.scoped, Effect.provide(Logger.layer([
    Logger.make((options) => { entries.push(String(options.message)) }),
  ]))))
  for (const outcome of result) {
    expect(outcome._tag).toBe("Failure")
    if (outcome._tag !== "Failure") continue
    expect(outcome.failure.code).toBe("WORK_RECOVERY_REQUIRED")
    expect(outcome.failure.message).toBe("The original native read outcome cannot be verified")
  }
  expect(entries).toContain('work_leaf_proof_refused {"stage":"SQL-current","reason":"stored-proof","code":"WORK_RECOVERY_REQUIRED"}')
  expect(entries).toContain('work_leaf_proof_refused {"stage":"verified-cache","reason":"missing","code":"WORK_RECOVERY_REQUIRED"}')
  expect(entries.join("\n")).not.toContain(identifier)
})

test("closing the original Scope reports inactive lifetime and preserves both refusal methods", async () => {
  const entries: string[] = []
  await Effect.runPromise(Effect.gen(function* () {
    yield* LocalTaskAuthority.initializeInstallation()
    const scope = yield* Scope.make()
    const context = yield* Layer.buildWithScope(WorkLeafProof.layer.pipe(Layer.provide(Database.defaultLayer)), scope)
    const proof = Context.get(context, WorkToolPolicy.LeafProof)
    yield* Scope.close(scope, Exit.void)
    for (const outcome of [yield* proof.verify("missing").pipe(Effect.result),
      yield* proof.requireVerified("missing").pipe(Effect.result)]) {
      expect(outcome._tag).toBe("Failure")
      if (outcome._tag !== "Failure") continue
      expect(outcome.failure.code).toBe("WORK_RECOVERY_REQUIRED")
    }
  }).pipe(Effect.scoped, Effect.provide(Logger.layer([
    Logger.make((options) => { entries.push(String(options.message)) }),
  ]))))
  expect(entries.filter((entry) => entry === 'work_leaf_proof_refused {"stage":"lifetime","reason":"inactive","code":"WORK_RECOVERY_REQUIRED"}')).toHaveLength(2)
  expect(entries.some((entry) => entry.includes("verified-cache"))).toBe(false)
})

test("a failing diagnostic logger cannot replace or turn a cache refusal into success", async () => {
  const outcome = await Effect.runPromise(Effect.gen(function* () {
    yield* LocalTaskAuthority.initializeInstallation()
    const context = yield* Layer.build(WorkLeafProof.layer.pipe(Layer.provide(Database.defaultLayer)))
    return yield* Context.get(context, WorkToolPolicy.LeafProof).requireVerified("missing").pipe(Effect.result)
  }).pipe(Effect.scoped, Effect.provide(Logger.layer([
    Logger.make(() => { throw new Error("private-log-failure") }),
  ]))))
  expect(outcome._tag).toBe("Failure")
  if (outcome._tag !== "Failure") return
  expect(outcome.failure.code).toBe("WORK_RECOVERY_REQUIRED")
  expect(outcome.failure.message).toBe("The original native read outcome cannot be verified")
})
