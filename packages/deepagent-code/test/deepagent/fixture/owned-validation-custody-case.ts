import assert from "node:assert/strict"
import { Cause, Effect, Exit } from "effect"
import { OwnedValidation } from "../../../src/deepagent/owned-validation"

const command = { id: "owned-custody", source: "user" as const, display: "owned actual process",
  transport: "argv" as const, executable: "/usr/bin/true", args: [] }
const request = { cwd: process.cwd(), command, profile: "posix-process-group-v1" as const }
const original = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const handle = yield* OwnedValidation.prepare(request)
  const receipt = yield* OwnedValidation.run(handle)
  const view = OwnedValidation.inspect(receipt)
  assert.equal(view?.state, "unknown")
  assert.equal(view.stopProof, "unconfirmed")
  assert.equal(view.reason, "containment_unconfirmed")
  assert.deepEqual(OwnedValidation.inspectCustody(), { limit: 128, live: 0, quarantine: 1 })
  assert(Exit.isFailure(yield* Effect.exit(OwnedValidation.run(handle))))
  return { handle, receipt, view }
})))
assert.strictEqual(OwnedValidation.inspect(original.receipt), original.view)
assert.deepEqual(OwnedValidation.inspectCustody(), { limit: 128, live: 0, quarantine: 1 })
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  for (const _ of Array.from({ length: 127 })) yield* OwnedValidation.prepare(request)
  assert.deepEqual(OwnedValidation.inspectCustody(), { limit: 128, live: 127, quarantine: 1 })
  const refused = yield* Effect.exit(OwnedValidation.prepare(request))
  assert(Exit.isFailure(refused))
  const cause = Cause.squash(refused.cause)
  assert(cause instanceof OwnedValidation.Error && cause.code === "CAPACITY")
})))
assert.deepEqual(OwnedValidation.inspectCustody(), { limit: 128, live: 0, quarantine: 1 })
assert(Exit.isFailure(await Effect.runPromise(Effect.scoped(Effect.exit(OwnedValidation.run(original.handle))))))
assert.strictEqual(OwnedValidation.inspect(original.receipt), original.view)
console.log(JSON.stringify({ unknownQuarantine: 1, unusedHandlesReleased: 127, sharedLimit: 128,
  scopeCannotReleaseUnknown: true, replayRefused: true, originalReceiptPreserved: true, nativeTreeProofClaimed: false }))
