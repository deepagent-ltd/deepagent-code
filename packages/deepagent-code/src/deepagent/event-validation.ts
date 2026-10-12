import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Scope, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import { watch, type FSWatcher } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { EventValidation } from "@deepagent-code/core/deepagent/event-validation"
import { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"
import { EventValidationConsumer } from "@deepagent-code/core/deepagent/event-validation-consumer"
import { ServerAuth } from "@/server/auth"
import { LocalTaskAuthority } from "@/im/local-task-authority"
import { EffectBridge } from "@/effect/bridge"
import { EventValidationNative } from "@/installation/event-validation-native"
import { EventValidationPlatform } from "@/installation/event-validation-platform"
import { EventInvestigationHost } from "@/deepagent/event-investigation"

type Rule = EventValidationSchema.RuleRecord
type Consumer = Effect.Success<ReturnType<typeof EventValidationConsumer.make>>
const failure = () => new EventValidationSchema.Error({ code: "VALIDATION_UNAVAILABLE", message: "Project validation is unavailable or changed" })
export interface Interface {
  readonly candidates: (input: typeof EventValidationSchema.CandidatesRequest.Type) => Effect.Effect<typeof EventValidationSchema.Candidates.Type, EventValidationSchema.Error, LocalOperator.Runtime>
  readonly capture: (input: typeof EventValidationSchema.Capture.Type) => Effect.Effect<typeof EventValidationSchema.Captured.Type, EventValidationSchema.Error, LocalOperator.Runtime | LocalOperator.Mutation>
  readonly configureCaptured: (input: typeof EventValidationSchema.ConfigureCaptured.Type) => Effect.Effect<Effect.Success<ReturnType<typeof EventValidation.configure>>, EventValidationSchema.Error, LocalOperator.Runtime | LocalOperator.Mutation>
  readonly configure: (input: typeof EventValidationSchema.Configure.Type) => Effect.Effect<Effect.Success<ReturnType<typeof EventValidation.configure>>, EventValidationSchema.Error, LocalOperator.Runtime | LocalOperator.Mutation>
  readonly control: (input: typeof EventValidationSchema.Control.Type) => Effect.Effect<Effect.Success<ReturnType<typeof EventValidation.control>>, EventValidationSchema.Error, LocalOperator.Runtime | LocalOperator.Mutation>
  readonly list: Effect.Effect<readonly Rule[], EventValidationSchema.Error>
  readonly history: (ruleID: string) => Effect.Effect<readonly EventValidationSchema.RunRecord[], EventValidationSchema.Error>
  readonly observation: (run: EventValidationSchema.RunRecord) => typeof EventValidationSchema.RunView.Type["observation"]
  readonly start: Effect.Effect<void, EventValidationSchema.Error>
}
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/EventValidationHost") {}

/** One host-scoped adapter. Filesystem callbacks are untrusted hints; only the native
 * captured root and durable current operator/rule can authorize command dispatch. */
export const layer = Layer.effect(Service, Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const config = yield* ServerAuth.Config
  const native = yield* EventValidation.Native
  const investigation = yield* Effect.serviceOption(EventInvestigationHost.Service)
  const scope = yield* Scope.Scope
  const bridge = yield* EffectBridge.make()
  const gate = yield* Semaphore.make(1)
  const runtime = { consumer: undefined as Consumer | undefined, instanceID: undefined as string | undefined, active: true }
  const parents = new Map<string, { watcher: FSWatcher; device: number; inode: number; subscribers: Map<string, { revision: number; configHash: string; files: Set<string> }>; closing: boolean }>()
  const ownedParents = new Set<NonNullable<ReturnType<typeof parents.get>>>()
  const pendingParents = new Map<string, { reserved: boolean; completed: Deferred.Deferred<Exit.Exit<NonNullable<ReturnType<typeof parents.get>>, EventValidationSchema.Error>> }>()
  type Hint = { directory: string; subscribers: NonNullable<ReturnType<typeof parents.get>>["subscribers"]; revision: number; configHash: string; unavailable: boolean }
  const hints = new Map<string, { next: Hint | undefined; fiber?: Fiber.Fiber<void, never> }>()
  const captures = new Map<string, { input: typeof EventValidationSchema.Capture.Type; configuration: EventValidationSchema.Configuration; operatorRevision: number; expiresAt: number }>()
  const capturing = { count: 0 }
  const configured = LocalTaskAuthority.configured(config).pipe(Effect.mapError(failure))
  const getConsumer = gate.withPermit(Effect.gen(function* () {
    const current = yield* configured
    if (!runtime.active || (runtime.instanceID !== undefined && runtime.instanceID !== current.runtime.instanceID)) return yield* failure()
    if (runtime.consumer) return runtime.consumer
    runtime.consumer = yield* EventValidationConsumer.make(db, current.runtime.instanceID,
      Option.isSome(investigation) ? { onKnownFailure: investigation.value.onKnownFailure } : {}).pipe(
      Effect.provideService(LocalOperator.Runtime, current.runtime), Effect.provideService(EventValidation.Native, native), Effect.provideService(Scope.Scope, scope))
    runtime.instanceID = current.runtime.instanceID
    return runtime.consumer
  }))
  const background = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.gen(function* () {
    const current = yield* configured
    return yield* effect.pipe(Effect.provideService(LocalOperator.Runtime, current.runtime))
  })
  const interruptInvestigations = (ruleID: string) => Option.isSome(investigation)
    ? investigation.value.postRuleControl(ruleID).pipe(Effect.mapError(failure)) : Effect.void
  const detach = (ruleID: string, keep?: ReadonlySet<string>) => {
    const pending = hints.get(ruleID)
    if (pending) pending.next = undefined
    for (const [name, parent] of parents) {
      if (keep?.has(name)) continue
      parent.subscribers.delete(ruleID)
      if (parent.subscribers.size === 0 && !parent.closing) { parent.closing = true; parent.watcher.close() }
    }
  }
  const captureParent = (directory: string) => Effect.gen(function* () {
    if (!runtime.active) return yield* failure()
    const pending = pendingParents.get(directory)
    if (pending) return yield* Deferred.await(pending.completed).pipe(Effect.flatMap((exit) => exit))
    const original = parents.get(directory)
    if (original?.closing) return yield* failure()
    if (!original && ownedParents.size + [...pendingParents.values()].filter((entry) => entry.reserved).length >= 256)
      return yield* failure()
    const reservation = { reserved: !original, completed: Deferred.makeUnsafe<Exit.Exit<NonNullable<ReturnType<typeof parents.get>>, EventValidationSchema.Error>>() }
    // Reserve and publish the one original path preparation before filesystem await.
    pendingParents.set(directory, reservation)
    return yield* Effect.gen(function* () {
      const actual = yield* Effect.tryPromise({ try: async () => ({ stat: await fs.lstat(directory), real: await fs.realpath(directory) }), catch: failure })
      if (!runtime.active || !actual.stat.isDirectory() || actual.stat.isSymbolicLink() || actual.real !== directory ||
        parents.get(directory) !== original || original?.closing ||
        (original && (original.device !== actual.stat.dev || original.inode !== actual.stat.ino))) return yield* failure()
      if (original) return original
      const subscribers: NonNullable<ReturnType<typeof parents.get>>["subscribers"] = new Map()
      const hint = (name: string | null, unavailable = false) => {
        if (!runtime.active) return
        for (const [ruleID, observed] of subscribers) {
          if (name !== null && !observed.files.has(name)) continue
          const pending = hints.get(ruleID)
          const next = { directory, subscribers, revision: observed.revision, configHash: observed.configHash,
            unavailable: unavailable || (pending?.next?.revision === observed.revision && pending.next.unavailable) }
          if (pending) { pending.next = next; continue }
          // One observation fiber and one coalesced hint per rule, across all parents.
          const entry: NonNullable<ReturnType<typeof hints.get>> = { next }
          hints.set(ruleID, entry)
          entry.fiber = bridge.fork(background(Effect.gen(function* () {
            while (runtime.active && entry.next) {
              const notification = entry.next; entry.next = undefined
              if (parents.get(notification.directory)?.subscribers !== notification.subscribers) continue
              const current = yield* EventValidation.getRule(db, ruleID)
              if (!current || current.state !== "enabled" || current.revision !== notification.revision || current.configHash !== notification.configHash) continue
              if (notification.unavailable) {
                yield* EventValidation.observationUnavailable(db, current)
                yield* interruptInvestigations(ruleID)
                continue
              }
              const consumer = yield* getConsumer
              yield* consumer.hint(ruleID)
              yield* interruptInvestigations(ruleID)
            }
          })).pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => { if (hints.get(ruleID) === entry) hints.delete(ruleID) }))))
        }
      }
      return yield* Effect.try({ try: () => {
        if (!runtime.active || parents.get(directory) !== original || pendingParents.get(directory) !== reservation) throw failure()
        const watcher = watch(directory, { persistent: false }, (_event, name) => hint(name))
        const parent = { watcher, device: actual.stat.dev, inode: actual.stat.ino, subscribers, closing: false }
        watcher.on("error", () => hint(null, true))
        watcher.once("close", () => {
          hint(null, true)
          // Only this actual watcher close releases its original physical slot.
          if (parents.get(directory) === parent) parents.delete(directory)
          ownedParents.delete(parent)
        })
        // Publish physical custody in the same synchronous constructor boundary.
        // Cancellation cannot strand a live watcher between creation and ownership.
        ownedParents.add(parent)
        parents.set(directory, parent)
        return parent
      }, catch: failure })
    }).pipe(Effect.onExit((exit) => Effect.sync(() => {
      if (pendingParents.get(directory) === reservation) pendingParents.delete(directory)
      Deferred.doneUnsafe(reservation.completed, Effect.succeed(exit))
    })))
  })
  const refresh = (rule: Rule) => Effect.gen(function* () {
    if (!runtime.active || rule.state !== "enabled") { detach(rule.ruleID); return }
    const desired = new Map<string, Set<string>>()
    for (const relative of rule.configuration.watch) {
      const full = path.join(rule.configuration.scope.canonicalRoot, relative)
      const directory = path.dirname(full)
      if (directory !== rule.configuration.scope.canonicalRoot && !directory.startsWith(`${rule.configuration.scope.canonicalRoot}${path.sep}`)) return yield* failure()
      const files = desired.get(directory) ?? new Set<string>()
      files.add(path.basename(full)); desired.set(directory, files)
    }
    // Existing desired paths keep their original watcher; there is no close/reopen gap.
    detach(rule.ruleID, new Set(desired.keys()))
    for (const [directory, files] of desired) {
      const parent = yield* captureParent(directory)
      if (!runtime.active || parent.closing || parents.get(directory) !== parent) return yield* failure()
      parent.subscribers.set(rule.ruleID, { revision: rule.revision, configHash: rule.configHash, files })
    }
  })
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    runtime.active = false
    for (const parent of ownedParents) {
      if (!parent.closing) { parent.closing = true; parent.watcher.close() }
    }
    // Actual close callbacks retain and release the original watcher slots. Pending readonly
    // preparations see active=false after their await and cannot publish a late watcher.
    yield* Fiber.interruptAll([...hints.values()].flatMap((entry) => entry.fiber ? [entry.fiber] : []))
    hints.clear()
    captures.clear()
  }))
  const readable = (ruleID?: string) => Effect.gen(function* () {
    const identity = yield* configured
    const actor = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx)).pipe(
      Effect.provideService(LocalOperator.Runtime, identity.runtime), Effect.mapError(failure))
    if (!ruleID) return actor
    yield* EventValidation.requireReadable(db, ruleID).pipe(Effect.provideService(LocalOperator.Runtime, identity.runtime))
    return actor
  })
  return Service.of({
    observation: (run) => run.state === "unknown" ? "recovery_required" : run.terminalAt !== null ? "known_terminal" :
      runtime.consumer?.owns(run) ? "owned" : "recovery_required",
    candidates: (input) => EventValidation.projectTargets(db, input.sessionID).pipe(Effect.map((result) => ({ targets: result.targets.map((target) => ({ targetID: target.targetID,
      recipes: target.recipes.filter((recipe) => EventValidationPlatform.supports(recipe) && recipe.argv[0]?.kind === "literal" &&
        (recipe.argv[0].value === "test" || recipe.argv[0].value === "build")).map(EventValidationPlatform.request) })) }))),
    capture: (value) => Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(EventValidationSchema.Capture, { onExcessProperty: "error" })(value).pipe(Effect.mapError(failure))
      for (const [id, capture] of captures) if (capture.expiresAt <= Date.now()) captures.delete(id)
      if (!runtime.active || input.expiresAt <= Date.now()) return yield* failure()
      if (captures.size + capturing.count >= 32) return yield* new EventValidationSchema.Error({ code: "VALIDATION_CAPACITY", message: "Validation preview capacity is full" })
      capturing.count++
      return yield* Effect.gen(function* () {
        const current = yield* EventValidation.projectTargets(db, input.sessionID)
        const target = current.targets.find((entry) => entry.targetID === input.targetID)
        const recipe = target?.recipes.find((entry) => entry.logicalID === input.recipeID)
        const first = recipe?.argv[0]
        if (!target || !recipe || first?.kind !== "literal" || (first.value !== "test" && first.value !== "build")) return yield* failure()
        const configuration = yield* Schema.decodeUnknownEffect(EventValidationSchema.Configuration, { onExcessProperty: "error" })({
          profile: "project_validation_v1", scope: target.scope, helperHash: target.helperHash, kind: first.value,
          recipe, parameters: input.parameters, watch: input.watch, recipient: "local_status", maxRuns: input.maxRuns,
          expiresAt: input.expiresAt, investigation: "disabled", autoFix: false }).pipe(
            Effect.tapError(() => Effect.logWarning('event_validation_capture_refused {"stage":"capture-configuration"}')),
            Effect.mapError(failure),
          )
        // Native approval observes the actual signed assets/root, not the policy's
        // descriptive hashes alone. No process or durable rule is created by preview.
        const operatorRevision = yield* EventValidation.approveConfiguration(db, configuration).pipe(
          Effect.tapError(() => Effect.logWarning('event_validation_capture_refused {"stage":"capture-approval"}')),
          Effect.provideService(EventValidation.Native, native),
        )
        const after = yield* EventValidation.projectTargets(db, input.sessionID)
        if (!runtime.active || after.operatorRevision !== current.operatorRevision || operatorRevision !== after.operatorRevision ||
          EventValidation.hash(after.targets.find((entry) => entry.targetID === input.targetID) ?? null) !== EventValidation.hash(target)) return yield* failure()
        const captureID = randomUUID()
        const expiresAt = Math.min(Date.now() + 60_000, input.expiresAt)
        captures.set(captureID, { input: structuredClone(input), configuration: structuredClone(configuration), operatorRevision, expiresAt })
        return { captureID, expiresAt, preview: { kind: configuration.kind, recipe: EventValidationPlatform.request(recipe),
          parameters: input.parameters, watch: input.watch, maxRuns: input.maxRuns, ruleExpiresAt: input.expiresAt } }
      }).pipe(Effect.ensuring(Effect.sync(() => { capturing.count-- })))
    }),
    configureCaptured: (input) => Effect.gen(function* () {
      const replayed = yield* EventValidation.replayCaptured(db, input)
      if (replayed) return replayed
      const captured = captures.get(input.captureID)
      if (!runtime.active || !captured || captured.expiresAt <= Date.now()) return yield* new EventValidationSchema.Error({ code: "VALIDATION_CAPTURE_EXPIRED", message: "Validation preview expired; capture the current project again" })
      const current = yield* EventValidation.projectTargets(db, captured.input.sessionID)
      const target = current.targets.find((entry) => entry.targetID === captured.input.targetID)
      if (!target || current.operatorRevision !== captured.operatorRevision || EventValidation.hash(target.scope) !== EventValidation.hash(captured.configuration.scope) ||
        !target.recipes.some((recipe) => EventValidation.hash(recipe) === EventValidation.hash(captured.configuration.recipe))) return yield* failure()
      const result = yield* EventValidation.configureCaptured(db, input, captured.configuration).pipe(Effect.provideService(EventValidation.Native, native))
      if (!result.replayed) { detach(input.ruleID); if (runtime.consumer) yield* runtime.consumer.cancel(input.ruleID); yield* interruptInvestigations(input.ruleID) }
      return result
    }),
    configure: (input) => EventValidation.configure(db, input).pipe(Effect.provideService(EventValidation.Native, native), Effect.tap((result) => Effect.gen(function* () {
      if (result.replayed) return
      detach(input.ruleID)
      if (runtime.consumer) yield* runtime.consumer.cancel(input.ruleID)
      yield* interruptInvestigations(input.ruleID)
    }))),
    control: (input) => EventValidation.control(db, input).pipe(Effect.provideService(EventValidation.Native, native), Effect.tap((result) => Effect.gen(function* () {
      if (result.replayed) return
      yield* interruptInvestigations(input.ruleID)
      const rule = yield* EventValidation.getRule(db, input.ruleID)
      if (!rule) return
      if (input.action === "pause" || input.action === "revoke" || input.action === "cancel") {
        if (input.action !== "cancel") detach(rule.ruleID)
        if (runtime.consumer) yield* runtime.consumer.cancel(rule.ruleID)
        return
      }
      const consumer = yield* getConsumer
      if (input.action === "enable") {
        yield* refresh(rule)
        yield* background(consumer.hint(rule.ruleID))
      }
      if (input.action === "verify") { yield* consumer.cancel(rule.ruleID); yield* refresh(rule); yield* background(consumer.hint(rule.ruleID, true)) }
    }).pipe(Effect.mapError(failure)))),
    list: Effect.gen(function* () {
      const actor = yield* readable()
      const rules = yield* EventValidation.rules(db, actor.instance_id)
      const identity = yield* configured
      return yield* Effect.forEach(rules.filter((rule): rule is Rule => rule !== undefined && rule.operatorID === actor.operator_id),
        (rule) => EventValidation.requireReadable(db, rule.ruleID).pipe(Effect.provideService(LocalOperator.Runtime, identity.runtime)))
    }),
    history: (ruleID) => readable(ruleID).pipe(Effect.andThen(() => EventValidation.history(db, ruleID)),
      Effect.map((runs) => runs.filter((run): run is EventValidationSchema.RunRecord => run !== undefined))),
    start: background(Effect.gen(function* () {
      const consumer = yield* getConsumer
      const current = yield* configured
      const rules = yield* EventValidation.rules(db, current.runtime.instanceID)
      yield* Effect.forEach(rules, (rule) => rule?.state === "enabled" ? refresh(rule).pipe(Effect.catch(() => EventValidation.observationUnavailable(db, rule))) : Effect.void, { discard: true })
      yield* consumer.reconcile
    })).pipe(Effect.mapError(failure)),
  })
}))
export const defaultLayer = layer.pipe(Layer.provide(EventValidationNative.layer))
export * as EventValidationHost from "./event-validation"
