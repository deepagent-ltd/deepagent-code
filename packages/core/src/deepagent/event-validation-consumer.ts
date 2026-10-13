export * as EventValidationConsumer from "./event-validation-consumer"

import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { randomUUID } from "node:crypto"
import type { Database } from "../database/database"
import { EventValidation } from "./event-validation"
import { EventValidationSchema } from "./event-validation.schema"

/** Scoped handles and debounce wakeups only. SQL owns the queue, project slot and all
 * execution truth. No Session, prompt, provider or model loop is constructed here. */
export const make = Effect.fn("EventValidationConsumer.make")(function* (db: Database.Interface["db"], instanceID: string,
  options: { readonly onKnownFailure?: (run: EventValidationSchema.RunRecord) => Effect.Effect<void, unknown> } = {}) {
  const scope = yield* Scope.Scope
  const native = yield* EventValidation.Native
  const owner = randomUUID()
  const timers = new Map<string, Fiber.Fiber<void, never>>()
  const running = new Map<string, { ruleID: string; fiber: Fiber.Fiber<unknown, unknown> }>()
  const backoff = new Map<string, { attempts: number; until: number }>()
  const state = { active: true }
  const handleFailure = (rule: EventValidationSchema.RuleRecord, error: unknown) => EventValidation.observationUnavailable(db, rule,
    error instanceof EventValidationSchema.Error ? error.code : "VALIDATION_UNAVAILABLE").pipe(Effect.ignore)
  const run = (ruleID: string) => Effect.gen(function* () {
    const observation = yield* EventValidation.observe(db, ruleID)
    const claimed = yield* EventValidation.claim(db, ruleID, observation.observation, owner)
    if (!claimed) return
    // The whole lifecycle is one fiber. Interruption of execute joins native shutdown
    // before recording its real result or the durable unknown barrier.
    yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      const preparation = yield* EventValidation.startPreparation(db, claimed.run, observation.observation)
      const prepared = yield* Effect.scoped(Effect.gen(function* () {
        yield* EventValidation.preparing(db, claimed.run.runID, owner)
        const handle = yield* restore(native.prepare(claimed.rule.configuration, observation.observation, claimed.run.workspaceBasename, claimed.run.deadline, preparation))
        yield* EventValidation.prepared(db, claimed.run.runID, owner, handle)
        const execution = yield* restore(native.execute(handle, {
          beforeDispatch: EventValidation.dispatch(db, claimed.run.runID, owner, handle).pipe(Effect.provideService(EventValidation.Native, native), Effect.asVoid),
          started: (pid) => EventValidation.started(db, claimed.run.runID, owner, pid,
            claimed.rule.configuration.recipe.schemaVersion === "work-command-recipe.v2" ? "before_continue" : "observe").pipe(
            Effect.andThen(() => EventValidation.checkRun(db, claimed.run.runID, owner)), Effect.asVoid),
        }).pipe(Effect.raceFirst(Effect.gen(function* () {
          // Current control can change outside this host's request path. A failed read
          // also stops the owned handle; it never fabricates a successful result.
          while (true) {
            yield* Effect.sleep(100)
            yield* EventValidation.checkRun(db, claimed.run.runID, owner)
          }
        })))).pipe(Effect.exit)
        // Re-read actual working bytes before the result CAS. A watcher callback is
        // advisory and may have been coalesced or delayed by the OS.
        const beforeObservation = yield* EventValidation.getRule(db, ruleID)
        yield* EventValidation.observe(db, ruleID).pipe(Effect.catch((error) => beforeObservation ? handleFailure(beforeObservation, error) : Effect.void))
        const actual = yield* EventValidation.getRun(db, claimed.run.runID)
        if (actual?.state === "dispatching") {
          const result = yield* EventValidation.finish(db, claimed.run.runID, owner, handle)
          if (result.state !== "unknown") {
            yield* native.cleanup(handle).pipe(Effect.andThen(() => EventValidation.released(db, result.runID, handle)), Effect.ignore)
          }
          const released = options.onKnownFailure && native.cleaned(handle)
            ? yield* EventValidation.getRun(db, result.runID) : undefined
          if (result.state === "settled" && result.outcome === "failed" && result.resultCurrent && result.result?.stopConfirmed &&
            result.result.stdout.complete && result.result.stderr.complete && released?.releasedAt !== null &&
            released?.retainedBytes === 0 && options.onKnownFailure)
            yield* options.onKnownFailure(released).pipe(Effect.ignore)
        }
        if (actual?.state === "queued" || actual?.state === "preparing") {
          const refused = yield* EventValidation.finishBeforeDispatch(db, claimed.run.runID, owner)
          yield* native.cleanup(handle).pipe(Effect.andThen(() => EventValidation.released(db, refused.runID, handle)), Effect.ignore)
        }
        if (Exit.isFailure(execution)) return yield* Effect.failCause(execution.cause)
      }).pipe(Effect.onExit((exit) => Exit.isFailure(exit) ? native.cleanupPreparation(preparation).pipe(Effect.ignore) : Effect.void))).pipe(Effect.exit)
      if (Exit.isFailure(prepared)) {
        const actual = yield* EventValidation.getRun(db, claimed.run.runID)
        if (actual?.state === "dispatching") yield* EventValidation.markUnknown(db, actual.runID, owner)
        if (actual?.state === "queued" || actual?.state === "preparing") {
          yield* EventValidation.finishBeforeDispatch(db, actual.runID, owner)
          yield* EventValidation.releasedPreparation(db, actual.runID, owner, preparation).pipe(Effect.ignore)
        }
        return yield* Effect.failCause(prepared.cause)
      }
    }))
  }).pipe(Effect.provideService(EventValidation.Native, native))
  const schedule = (ruleID: string): Effect.Effect<void> => Effect.gen(function* () {
    if (!state.active || timers.has(ruleID)) return
    const rule = yield* EventValidation.getRule(db, ruleID).pipe(Effect.orElseSucceed(() => undefined))
    if (!rule || rule.instanceID !== instanceID || rule.state !== "enabled" || rule.dueAt === null || running.has(rule.projectKey)) return
    if (!(yield* EventValidation.canSchedule(db, rule.projectKey).pipe(Effect.orElseSucceed(() => false)))) return
    const ready = yield* Deferred.make<void>()
    const fiber = yield* Effect.gen(function* () {
      yield* Deferred.await(ready)
      yield* Effect.sleep(Math.max(0, rule.dueAt! - Date.now(), (backoff.get(ruleID)?.until ?? 0) - Date.now()))
      timers.delete(ruleID)
      const current = yield* EventValidation.getRule(db, ruleID)
      if (!current || current.dueAt === null || !state.active) return
      if (current.dueAt > Date.now()) { yield* schedule(ruleID); return }
      if (running.has(current.projectKey)) return
      // The timer fiber becomes the owner; no fork begins before publishing the map.
      const self = yield* Effect.fiber
      running.set(current.projectKey, { ruleID, fiber: self })
      const outcome = { failed: false, capacity: false }
      yield* run(ruleID).pipe(Effect.catch((error) => {
        outcome.failed = true
        outcome.capacity = error instanceof EventValidationSchema.Error && error.code === "VALIDATION_CAPACITY"
        if (outcome.capacity) {
          const attempts = Math.min(6, (backoff.get(ruleID)?.attempts ?? 0) + 1)
          backoff.set(ruleID, { attempts, until: Date.now() + Math.min(30_000, 1000 * 2 ** (attempts - 1)) })
        }
        return handleFailure(current, error)
      }), Effect.ensuring(Effect.gen(function* () {
        running.delete(current.projectKey)
        if (!outcome.capacity) backoff.delete(ruleID)
        const pending = yield* EventValidation.due(db, instanceID).pipe(Effect.orElseSucceed(() => []))
        yield* Effect.forEach(pending.filter((item) => !outcome.failed || outcome.capacity || item.rule_id !== ruleID), (item) => schedule(item.rule_id), { discard: true })
      })))
    }).pipe(Effect.catch((error) => handleFailure(rule, error)), Effect.ignore, Effect.forkIn(scope))
    timers.set(ruleID, fiber)
    yield* Deferred.succeed(ready, undefined)
  })
  yield* Effect.addFinalizer(() => Effect.sync(() => { state.active = false }))
  return {
    hint: (ruleID: string, immediate = false) => Effect.gen(function* () {
      const rule = yield* EventValidation.getRule(db, ruleID)
      if (!rule) return
      if (backoff.has(ruleID)) {
        backoff.delete(ruleID)
        const timer = timers.get(ruleID)
        if (timer) { timers.delete(ruleID); yield* Fiber.interrupt(timer) }
      }
      yield* EventValidation.observe(db, ruleID, immediate).pipe(Effect.andThen(() => schedule(ruleID)), Effect.catch((error) => handleFailure(rule, error)))
    }).pipe(Effect.provideService(EventValidation.Native, native)),
    cancel: (ruleID: string) => Effect.gen(function* () {
      backoff.delete(ruleID)
      const timer = timers.get(ruleID)
      if (timer) { timers.delete(ruleID); yield* Fiber.interrupt(timer) }
      const entry = [...running.values()].find((item) => item.ruleID === ruleID)
      if (entry) yield* Fiber.interrupt(entry.fiber)
    }).pipe(Effect.provideService(EventValidation.Native, native)),
    reconcile: Effect.gen(function* () {
      // Cold dispatching/unknown is deliberately not adopted. Only enabled rules with
      // an empty project slot can claim a never-executed content revision.
      const rules = yield* EventValidation.rules(db, instanceID)
      yield* Effect.forEach(rules.filter((rule) => rule?.state === "enabled"), (rule) =>
        EventValidation.observe(db, rule!.ruleID).pipe(Effect.andThen(() => schedule(rule!.ruleID)), Effect.ignore), { discard: true })
    }).pipe(Effect.provideService(EventValidation.Native, native)),
    live: () => ({ timers: timers.size, running: running.size }),
    owns: (run: EventValidationSchema.RunRecord) => state.active && run.ownerToken === owner && running.get(run.projectKey)?.ruleID === run.ruleID,
  }
})
