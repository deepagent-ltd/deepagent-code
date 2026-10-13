// Test-only observation hooks expose the original Host owner. No grant, rule or command is created.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import type { FSWatcher } from "node:fs"
import { Effect, Exit, Fiber, Layer, Option, Scope } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { EventValidation } from "@deepagent-code/core/deepagent/event-validation"
import type { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"
import { EventValidationHost } from "../../../src/deepagent/event-validation"
import { ServerAuth } from "../../../src/server/auth"
const root = process.argv[2]!
type Parent = { watcher: FSWatcher; closing: boolean }
type Owner = { capture: (directory: string) => Effect.Effect<Parent, EventValidationSchema.Error>;
  detach: (ruleID: string) => void; counts: () => { owned: number; pending: number; named: number } }
const globals = globalThis as typeof globalThis & { __RI94WatchOwner?: Owner; __RI94WatchAwait?: () => Promise<void> }
const ready = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const entered = { value: 0 }
globals.__RI94WatchAwait = () => { if (++entered.value === 256) ready.resolve(); return release.promise }
const db = Database.layerFromPath(path.join(root, "own.sqlite"))
const forbidden = () => { throw new Error("The observation-only fixture must never access Native authority") }
const layers = EventValidationHost.layer.pipe(Layer.provideMerge(db), Layer.provide(Layer.succeed(ServerAuth.Config,
  { username: "private-watch-observer", password: Option.none() })), Layer.provide(Layer.mock(EventValidation.Native, { approved: forbidden, content: forbidden, disposition: forbidden, snapshot: forbidden, result: forbidden, cleaned: forbidden })))
const lifetime = Effect.runSync(Scope.make())
const context = await Effect.runPromise(Layer.build(layers).pipe(Effect.provideService(Scope.Scope, lifetime)))
const facts = await Effect.runPromise(Effect.gen(function* () {
  yield* EventValidationHost.Service
  const owner = globals.__RI94WatchOwner!
  assert(owner)
  const paths = Array.from({ length: 257 }, (_, index) => path.join(root, `parent-${index}`))
  yield* Effect.promise(() => Promise.all(paths.map((directory) => fs.mkdir(directory, { mode: 0o700 }))))
  const pending = yield* Effect.forEach(paths.slice(0, 256), (directory) => owner.capture(directory).pipe(Effect.forkScoped))
  yield* Effect.promise(() => ready.promise)
  assert.deepEqual(owner.counts(), { owned: 0, pending: 256, named: 0 })
  const joined = yield* owner.capture(paths[0]!).pipe(Effect.forkScoped)
  assert.equal(Exit.isFailure(yield* owner.capture(paths[256]!).pipe(Effect.exit)), true)
  assert.equal(entered.value, 256)
  globals.__RI94WatchAwait = undefined
  release.resolve()
  const parents = yield* Effect.forEach(pending, Fiber.join)
  assert.equal(yield* Fiber.join(joined), parents[0])
  assert.deepEqual(owner.counts(), { owned: 256, pending: 0, named: 256 })
  assert.equal(yield* owner.capture(paths[0]!), parents[0])
  const original = parents[0]!
  const close = original.watcher.close.bind(original.watcher)
  const closed = Promise.withResolvers<void>()
  original.watcher.once("close", closed.resolve)
  const closeCalls = { value: 0 }
  original.watcher.close = () => { closeCalls.value++ }
  owner.detach("no-rule-execution")
  assert.equal(closeCalls.value, 1)
  while (owner.counts().owned !== 1) yield* Effect.sleep("1 millis")
  assert.deepEqual(owner.counts(), { owned: 1, pending: 0, named: 1 })
  assert.equal(Exit.isFailure(yield* owner.capture(paths[0]!).pipe(Effect.exit)), true)
  owner.detach("no-rule-execution")
  assert.equal(closeCalls.value, 1)
  close()
  yield* Effect.promise(() => closed.promise)
  assert.deepEqual(owner.counts(), { owned: 0, pending: 0, named: 0 })
  const replacement = yield* owner.capture(paths[0]!)
  assert.notEqual(replacement, original)
  const replacementClosed = Promise.withResolvers<void>()
  replacement.watcher.once("close", replacementClosed.resolve)
  yield* Scope.close(lifetime, Exit.void)
  yield* Effect.promise(() => replacementClosed.promise)
  assert.deepEqual(owner.counts(), { owned: 0, pending: 0, named: 0 })
  return { bound: 256, exactJoined: true, knownReleased: 255, unknownRetained: 1, unknownCloseCalls: closeCalls.value,
    lateOriginalCloseReleased: true, final: owner.counts(), provider: 0, nativeCommands: 0, authority: false }
}).pipe(Effect.provide(context), Effect.provideService(Scope.Scope, lifetime), Effect.scoped, Effect.timeout("10 seconds")))
console.log(JSON.stringify(facts))
