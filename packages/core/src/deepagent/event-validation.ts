export * as EventValidation from "./event-validation"

import { Context, Effect, Option, Schema, Scope } from "effect"
import { sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import type { Database } from "../database/database"
import { LocalOperator } from "../im/local-operator"
import type { LocalOperatorSchema } from "../im/local-operator.schema"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { EventValidationSchema } from "./event-validation.schema"

type Db = Database.Interface["db"]
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Pick<Db, "get" | "all">
type Rule = EventValidationSchema.RuleRecord
type Run = EventValidationSchema.RunRecord
declare const approved: unique symbol
declare const observed: unique symbol
declare const preparedHandle: unique symbol
declare const preparationHandle: unique symbol
declare const preparationClaim: unique symbol
export interface Approval { readonly [approved]: true }
export interface Observation { readonly [observed]: true }
export interface Handle { readonly [preparedHandle]: true }
export interface Preparation { readonly [preparationHandle]: true }
export interface PreparationClaim { readonly [preparationClaim]: true }
export type PreparationInput = { readonly runID: string; readonly ownerToken: string; readonly workspaceBasename: string; readonly deadline: number;
  readonly supervisorBinding?: { readonly instanceID: string; readonly ruleID: string; readonly ruleRevision: number } }
export type PreparationDisposition = PreparationInput & { readonly configHash: string; readonly contentHash: string;
  readonly preparationID: string; readonly kind: "no_workspace_created" | "partial_workspace_cleaned";
  readonly workspaceIdentity: Run["workspaceIdentity"]; readonly observedAt: number;
  readonly snapshotHash: string | null; readonly incarnation: string | null }
/** A same-Root installed native service, absent by default. JSON never recreates these
 * objects. The host must inspect its own WeakMaps, not accept caller-supplied digests. */
export class Native extends Context.Service<Native, {
  readonly approve: (configuration: EventValidationSchema.Configuration) => Effect.Effect<Approval, EventValidationSchema.Error>
  readonly approved: (approval: Approval, configuration: EventValidationSchema.Configuration) => boolean
  readonly observe: (configuration: EventValidationSchema.Configuration) => Effect.Effect<Observation, EventValidationSchema.Error>
  readonly content: (observation: Observation, configuration: EventValidationSchema.Configuration) => EventValidationSchema.Content | undefined
  readonly preparation: (configuration: EventValidationSchema.Configuration, observation: Observation, claim: PreparationClaim) => Effect.Effect<Preparation, EventValidationSchema.Error>
  readonly prepare: (configuration: EventValidationSchema.Configuration, observation: Observation, workspaceBasename: string, deadline: number, preparation?: Preparation) => Effect.Effect<Handle, EventValidationSchema.Error, Scope.Scope>
  readonly cleanupPreparation: (preparation: Preparation) => Effect.Effect<void, EventValidationSchema.Error>
  readonly disposition: (preparation: Preparation) => PreparationDisposition | undefined
  readonly snapshot: (handle: Handle) => { readonly snapshotHash: string; readonly incarnation: string;
    readonly configHash: string; readonly contentHash: string; readonly workspaceBasename: string;
    readonly workspaceIdentity: NonNullable<Run["workspaceIdentity"]> } | undefined
  readonly execute: (handle: Handle, hooks: {
    readonly beforeDispatch: Effect.Effect<void, EventValidationSchema.Error>
    readonly started: (pid: number) => Effect.Effect<void, EventValidationSchema.Error>
  }) => Effect.Effect<void, EventValidationSchema.Error>
  readonly result: (handle: Handle) => EventValidationSchema.Result | undefined
  readonly cleanup: (handle: Handle) => Effect.Effect<void, EventValidationSchema.Error>
  readonly cleaned: (handle: Handle) => boolean
}>()("@deepagent-code/EventValidation/Native") {}

const claims = new WeakMap<Run, { db: Db; native: Native["Service"]; run: Run; configuration: EventValidationSchema.Configuration; used: boolean }>()
const preparationClaims = new WeakMap<PreparationClaim, PreparationInput & { native: Native["Service"]; configHash: string; contentHash: string }>()
const preparations = new WeakMap<Preparation, { db: Db; native: Native["Service"]; runID: string; ownerToken: string }>()
export function inspectPreparationClaim(claim: PreparationClaim, native: Native["Service"]) {
  const entry = preparationClaims.get(claim)
  if (!entry || entry.native !== native) return undefined
  return { runID: entry.runID, ownerToken: entry.ownerToken, workspaceBasename: entry.workspaceBasename,
    deadline: entry.deadline, configHash: entry.configHash, contentHash: entry.contentHash,
    supervisorBinding: entry.supervisorBinding }
}
export const startPreparation = Effect.fn("EventValidation.startPreparation")(function* (db: Db, run: Run, observation: Observation) {
  const entry = claims.get(run)
  const native = yield* Native
  if (!entry || entry.db !== db || entry.native !== native || entry.used || hash(entry.run) !== hash(run)) return yield* failure()
  entry.used = true
  const ticket = Object.freeze({}) as PreparationClaim
  preparationClaims.set(ticket, { native, runID: run.runID, ownerToken: run.ownerToken, workspaceBasename: run.workspaceBasename,
    deadline: run.deadline, configHash: run.configHash, contentHash: run.contentHash,
    supervisorBinding: Object.freeze({ instanceID: run.instanceID, ruleID: run.ruleID, ruleRevision: run.ruleRevision }) })
  const preparation = yield* native.preparation(entry.configuration, observation, ticket)
  preparations.set(preparation, { db, native, runID: run.runID, ownerToken: run.ownerToken })
  return preparation
})

export const hash = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))
const failure = (code: EventValidationSchema.Error["code"] = "VALIDATION_UNAVAILABLE") =>
  new EventValidationSchema.Error({ code, message: "Project validation is unavailable, changed, or requires reconciliation" })
function checked<A>(schema: Schema.Decoder<A>, value: unknown) {
  const decoded = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(value)
  return Option.isSome(decoded) ? Effect.succeed(decoded.value) : Effect.fail(failure("VALIDATION_INVALID"))
}
function preserve<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.catch((error) => Effect.fail(error instanceof EventValidationSchema.Error ? error : failure())))
}

/** Bounded SELECTs only; callers authenticate the requested scope before returning data. */
export const getRule = Effect.fn("EventValidation.getRule")(function* (db: Reader, ruleID: string) {
  const size = yield* db.get<{ bytes: number }>(sql`SELECT length(CAST(record AS BLOB)) bytes FROM event_validation_rule WHERE rule_id=${ruleID}`)
  if (!size) return undefined
  if (size.bytes < 1 || size.bytes > EventValidationSchema.MAX_RULE_BYTES) return yield* failure("VALIDATION_INVALID")
  const row = yield* db.get<ReturnType<typeof ruleColumns>>(sql`SELECT * FROM event_validation_rule WHERE rule_id=${ruleID}
    AND length(CAST(record AS BLOB))<=${EventValidationSchema.MAX_RULE_BYTES}`)
  if (!row) return yield* failure("VALIDATION_INVALID")
  const rule = yield* checked(Schema.fromJsonString(EventValidationSchema.RuleRecord), row.record)
  if (hash(ruleColumns(rule)) !== hash(row) || rule.configHash !== hash(rule.configuration) ||
    rule.instanceID !== rule.configuration.scope.instanceID || rule.projectKey !== projectKey(rule.configuration.scope))
    return yield* failure("VALIDATION_INVALID")
  return rule
}, preserve)
export const getRun = Effect.fn("EventValidation.getRun")(function* (db: Reader, runID: string) {
  const size = yield* db.get<{ bytes: number }>(sql`SELECT length(CAST(record AS BLOB)) bytes FROM event_validation_run WHERE run_id=${runID}`)
  if (!size) return undefined
  if (size.bytes < 1 || size.bytes > EventValidationSchema.MAX_RUN_BYTES) return yield* failure("VALIDATION_INVALID")
  const row = yield* db.get<ReturnType<typeof runColumns>>(sql`SELECT * FROM event_validation_run WHERE run_id=${runID}
    AND length(CAST(record AS BLOB))<=${EventValidationSchema.MAX_RUN_BYTES}`)
  if (!row) return yield* failure("VALIDATION_INVALID")
  const run = yield* checked(Schema.fromJsonString(EventValidationSchema.RunRecord), row.record)
  if (hash(runColumns(run)) !== hash(row) || run.contentHash !== run.content.contentHash) return yield* failure("VALIDATION_INVALID")
  return run
}, preserve)
export const requireReadable = Effect.fn("EventValidation.requireReadable")(function* (db: Db, ruleID: string) {
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const actor = yield* LocalOperator.requireCurrent(tx).pipe(Effect.mapError(() => failure("VALIDATION_AUTH_REQUIRED")))
    const rule = yield* getRule(tx, ruleID)
    if (!rule || rule.instanceID !== actor.instance_id || rule.operatorID !== actor.operator_id)
      return yield* failure("VALIDATION_NOT_FOUND")
    yield* requireScope(tx, rule.configuration.scope, actor.instance_id)
    return rule
  }))
}, preserve)
export const projectKey = (scope: EventValidationSchema.Scope) =>
  hash([scope.instanceID, scope.securityNamespaceID, scope.projectScopeKey])
export const approveConfiguration = Effect.fn("EventValidation.approveConfiguration")(function* (db: Db, configuration: EventValidationSchema.Configuration) {
  const current = db.transaction((tx) => Effect.gen(function* () {
    const actor = yield* LocalOperator.requireMutation(tx).pipe(Effect.mapError(() => failure("VALIDATION_AUTH_REQUIRED")))
    yield* requireScope(tx, configuration.scope, actor.instance_id)
    yield* requirePolicy(actor, configuration)
    return actor.revision
  }))
  const revision = yield* current
  const native = yield* Native
  const approval = yield* native.approve(configuration)
  if ((yield* current) !== revision || !native.approved(approval, configuration)) return yield* failure("VALIDATION_SCOPE_CHANGED")
  return revision
}, preserve)

/** Current durable project policy and actual Session placement, without resolving a
 * Location or starting a Session. Merely registering a Location grants no recipe. */
export const projectTargets = Effect.fn("EventValidation.projectTargets")(function* (db: Db, sessionID: string) {
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const actor = yield* LocalOperator.requireCurrent(tx).pipe(Effect.mapError(() => failure("VALIDATION_AUTH_REQUIRED")))
    const session = yield* tx.get<{ project_id: string; directory: string; workspace_id: string | null }>(sql`SELECT project_id,directory,workspace_id FROM session WHERE id=${sessionID}`)
    if (!session) return yield* failure("VALIDATION_NOT_FOUND")
    const targets = []
    for (const entry of actor.policy.targets) {
      const scope = targetScope(actor, entry)
      if (!scope || scope.projectID !== session.project_id || scope.canonicalRoot !== session.directory || scope.workspaceID !== session.workspace_id || !("version" in entry.target)) continue
      yield* requireScope(tx, scope, actor.instance_id)
      if (!entry.target.toolPolicy.capabilities.some((tool) => tool.toolID === "managed_command" && tool.operations.includes("run"))) continue
      targets.push({ targetID: entry.id, scope, helperHash: entry.target.projectScope.helperHash,
        recipes: entry.target.toolPolicy.commandRecipes?.filter((recipe) => Schema.is(EventValidationSchema.Recipe)(recipe)) ?? [] })
    }
    return { operatorRevision: actor.revision, targets }
  }))
}, preserve)

/** Configuration alone is disabled. Only a subsequent, explicit authenticated enable
 * binds the current rule revision and installed native recipe. */
export const configure = Effect.fn("EventValidation.configure")(function* (db: Db, value: typeof EventValidationSchema.Configure.Type) {
  const input = yield* checked(EventValidationSchema.Configure, value)
  return yield* configureCommand(db, input, hash(input))
}, preserve)

export const replayCaptured = Effect.fn("EventValidation.replayCaptured")(function* (db: Db, value: typeof EventValidationSchema.ConfigureCaptured.Type) {
  const input = yield* checked(EventValidationSchema.ConfigureCaptured, value)
  const prior = yield* db.transaction((tx) => retry(tx, input.requestID, hash({ domain: "event-validation-captured-command.v1", ...input })), { behavior: "immediate" })
  return prior ? { receipt: prior, replayed: true } : undefined
}, preserve)
export const configureCaptured = Effect.fn("EventValidation.configureCaptured")(function* (db: Db,
  value: typeof EventValidationSchema.ConfigureCaptured.Type, configuration: EventValidationSchema.Configuration) {
  const input = yield* checked(EventValidationSchema.ConfigureCaptured, value)
  return yield* configureCommand(db, { ruleID: input.ruleID, requestID: input.requestID, expectedRevision: input.expectedRevision,
    configuration: yield* checked(EventValidationSchema.Configuration, configuration) },
    hash({ domain: "event-validation-captured-command.v1", ...input }))
}, preserve)

function configureCommand(db: Db, input: typeof EventValidationSchema.Configure.Type, requestHash: string) {
  return Effect.gen(function* () {
  const prior = yield* db.transaction((tx) => retry(tx, input.requestID, requestHash), { behavior: "immediate" })
  if (prior) return { receipt: prior, replayed: true }
  const native = yield* Native
  const approval = yield* native.approve(input.configuration)
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const actor = yield* LocalOperator.requireMutation(tx).pipe(Effect.mapError(() => failure("VALIDATION_AUTH_REQUIRED")))
    const previousCommand = yield* command(tx, actor.instance_id, input.requestID, requestHash)
    if (previousCommand) return { receipt: previousCommand, replayed: true }
    yield* requireScope(tx, input.configuration.scope, actor.instance_id)
    yield* requirePolicy(actor, input.configuration)
    if (!native.approved(approval, input.configuration)) return yield* failure("VALIDATION_SCOPE_CHANGED")
    const previous = yield* getRule(tx, input.ruleID)
    if ((previous?.revision ?? 0) !== input.expectedRevision || (previous && (previous.state === "revoked" ||
      previous.instanceID !== actor.instance_id || previous.operatorID !== actor.operator_id ||
      hash(previous.configuration.scope) !== hash(input.configuration.scope)))) return yield* failure("VALIDATION_CONFLICT")
    if (!previous) yield* capacity(tx, "event_validation_rule", actor.instance_id, EventValidationSchema.MAX_RULES)
    const now = Date.now()
    if (input.configuration.expiresAt <= now) return yield* failure("VALIDATION_INVALID")
    const next = yield* checked(EventValidationSchema.RuleRecord, withInvestigation({
      version: 1, ruleID: input.ruleID, instanceID: actor.instance_id, projectKey: projectKey(input.configuration.scope),
      revision: (previous?.revision ?? 0) + 1, state: "disabled", operatorID: actor.operator_id,
      operatorRevision: actor.revision, configuration: input.configuration, configHash: hash(input.configuration), approval: null,
      contentRevision: previous?.contentRevision ?? 0, contentHash: null, runCount: 0,
      pendingFirstAt: null, pendingLastAt: null, dueAt: null, currentRunID: null,
      lastReason: "disabled", createdAt: previous?.createdAt ?? now, updatedAt: now,
    }, previous))
    yield* writeRule(tx, next, previous)
    yield* cancelRuleRuns(tx, next.ruleID)
    const receipt = yield* saveCommand(tx, next, input.requestID, requestHash, previous ? "update" : "create", null)
    return { receipt, replayed: false }
  }), { behavior: "immediate" })
  }).pipe(preserve)
}

export const control = Effect.fn("EventValidation.control")(function* (db: Db, value: typeof EventValidationSchema.Control.Type) {
  const input = yield* checked(EventValidationSchema.Control, value)
  const requestHash = hash(input)
  const prior = yield* db.transaction((tx) => retry(tx, input.requestID, requestHash), { behavior: "immediate" })
  if (prior) return { receipt: prior, replayed: true }
  const captured = yield* getRule(db, input.ruleID)
  if (!captured) return yield* failure("VALIDATION_NOT_FOUND")
  const native = yield* Native
  const approval = input.action === "enable" || input.action === "verify" ? yield* native.approve(captured.configuration) : undefined
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const actor = yield* LocalOperator.requireMutation(tx).pipe(Effect.mapError(() => failure("VALIDATION_AUTH_REQUIRED")))
    const previousCommand = yield* command(tx, actor.instance_id, input.requestID, requestHash)
    if (previousCommand) return { receipt: previousCommand, replayed: true }
    const current = yield* getRule(tx, input.ruleID)
    if (!current || current.instanceID !== actor.instance_id || current.operatorID !== actor.operator_id)
      return yield* failure("VALIDATION_NOT_FOUND")
    if (current.revision !== input.expectedRevision || current.configHash !== captured.configHash || current.state === "revoked")
      return yield* failure("VALIDATION_CONFLICT")
    yield* requireScope(tx, current.configuration.scope, actor.instance_id)
    if (approval && !native.approved(approval, current.configuration)) return yield* failure("VALIDATION_SCOPE_CHANGED")
    if (approval) yield* requirePolicy(actor, current.configuration)
    const now = Date.now()
    if (input.action === "verify") {
      yield* requireEnabled(tx, current)
      // An explicit fresh manual command reapproves this exact configuration. Its new
      // control revision permits a run of unchanged content; content revision stays real.
      const revision = current.revision + 1
      const next = { ...current, revision, operatorRevision: actor.revision,
        approval: { ruleRevision: revision, operatorRevision: actor.revision, configHash: current.configHash },
        currentRunID: null, dueAt: now, pendingFirstAt: now, pendingLastAt: now, lastReason: "ready" as const, updatedAt: now }
      yield* writeRule(tx, next, current)
      yield* cancelRuleRuns(tx, next.ruleID)
      return { receipt: yield* saveCommand(tx, next, input.requestID, requestHash, input.action, null), replayed: false }
    }
    if (input.action === "cancel") {
      const active = yield* tx.get<{ run_id: string }>(sql`SELECT run_id FROM event_validation_run WHERE rule_id=${current.ruleID}
        AND state IN ('queued','preparing','dispatching') AND cancel_requested=0 LIMIT 1`)
      if (!active && current.dueAt === null) return yield* failure("VALIDATION_CONFLICT")
      yield* cancelRuleRuns(tx, current.ruleID)
      const next = { ...current, pendingFirstAt: null, pendingLastAt: null, dueAt: null, lastReason: "cancelled" as const, updatedAt: now }
      yield* writeRule(tx, next, current)
      return { receipt: yield* saveCommand(tx, next, input.requestID, requestHash, input.action, current.currentRunID), replayed: false }
    }
    const revision = current.revision + 1
    if (input.action === "pause" && current.state !== "enabled") return yield* failure("VALIDATION_CONFLICT")
    if (input.action === "enable" && (current.configuration.expiresAt <= now || current.runCount >= current.configuration.maxRuns))
      return yield* failure("VALIDATION_CONFLICT")
    const next = yield* checked(EventValidationSchema.RuleRecord, withInvestigation({ ...current, revision,
      state: input.action === "enable" ? "enabled" : input.action === "pause" ? "paused" : "revoked",
      operatorRevision: actor.revision,
      approval: input.action === "enable" ? { ruleRevision: revision, operatorRevision: actor.revision, configHash: current.configHash } : null,
      pendingFirstAt: null, pendingLastAt: null, dueAt: null,
      lastReason: input.action === "enable" ? "ready" : input.action === "pause" ? "paused" : "revoked", updatedAt: now,
    }, current))
    yield* writeRule(tx, next, current)
    yield* cancelRuleRuns(tx, next.ruleID)
    return { receipt: yield* saveCommand(tx, next, input.requestID, requestHash, input.action, current.currentRunID), replayed: false }
  }), { behavior: "immediate" })
}, preserve)

/** Watcher data only causes this fresh native observation; its payload is never a
 * content digest, source grant, shell command or execution capability. */
export const observe = Effect.fn("EventValidation.observe")(function* (db: Db, ruleID: string, immediate = false) {
  const original = yield* getRule(db, ruleID)
  if (!original) return yield* failure("VALIDATION_NOT_FOUND")
  yield* db.transaction((tx) => requireEnabled(tx, original, true), { behavior: "immediate" })
  const native = yield* Native
  const observation = yield* native.observe(original.configuration)
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const current = yield* getRule(tx, ruleID)
    if (!current || current.revision !== original.revision || current.configHash !== original.configHash) return yield* failure("VALIDATION_CONFLICT")
    yield* requireEnabled(tx, current, true)
    const content = native.content(observation, current.configuration)
    if (!content) return yield* failure("VALIDATION_SCOPE_CHANGED")
    yield* checked(EventValidationSchema.Content, content)
    const now = Date.now()
    if (current.contentHash === content.contentHash) {
      if (!immediate) return { rule: current, observation, changed: false }
      const next = { ...current, dueAt: now, pendingFirstAt: current.pendingFirstAt ?? now, pendingLastAt: now, updatedAt: now }
      yield* writeRule(tx, next, current)
      return { rule: next, observation, changed: false }
    }
    const first = current.pendingFirstAt ?? now
    const next = { ...current, contentRevision: current.contentRevision + 1, contentHash: content.contentHash,
      pendingFirstAt: first, pendingLastAt: now, dueAt: immediate ? now : Math.min(now + EventValidationSchema.DEBOUNCE_MS, first + EventValidationSchema.MAX_MERGE_MS),
      currentRunID: null, lastReason: "debouncing" as const, updatedAt: now }
    yield* writeRule(tx, next, current)
    return { rule: next, observation, changed: true }
  }), { behavior: "immediate" })
}, preserve)

export const claim = Effect.fn("EventValidation.claim")(function* (db: Db, ruleID: string, observation: Observation, ownerToken: string) {
  const native = yield* Native
  const claimed = yield* db.transaction((tx) => Effect.gen(function* () {
    const rule = yield* getRule(tx, ruleID)
    if (!rule) return yield* failure("VALIDATION_NOT_FOUND")
    yield* requireEnabled(tx, rule)
    const content = native.content(observation, rule.configuration)
    const now = Date.now()
    if (!content || content.contentHash !== rule.contentHash || rule.dueAt === null || rule.dueAt > now) return undefined
    if (rule.configuration.recipe.inputs.some((relative) => !content.files.some((file) => file.relative === relative && !file.missing)))
      return yield* failure("VALIDATION_UNAVAILABLE")
    const old = yield* tx.get<{ run_id: string }>(sql`SELECT run_id FROM event_validation_run WHERE rule_id=${rule.ruleID}
      AND rule_revision=${rule.revision} AND content_revision=${rule.contentRevision}`)
    if (old) {
      yield* writeRule(tx, { ...rule, pendingFirstAt: null, pendingLastAt: null, dueAt: null, updatedAt: now }, rule)
      return undefined
    }
    yield* capacity(tx, "event_validation_run", rule.instanceID, EventValidationSchema.MAX_RUNS)
    const custody = yield* tx.get<{ count: number; bytes: number }>(sql`SELECT count(*) count,coalesce(sum(retained_bytes),0) bytes FROM event_validation_run
      WHERE instance_id=${rule.instanceID} AND released_at IS NULL`)
    const commands = yield* tx.get<{ custody_count: number; retained_bytes: number }>(sql`SELECT custody_count,retained_bytes
      FROM work_command_meter WHERE instance_id=${rule.instanceID}`)
    if (!custody || !Number.isSafeInteger(custody.count) || !Number.isSafeInteger(custody.bytes) ||
      custody.count + (commands?.custody_count ?? 0) >= EventValidationSchema.MAX_CUSTODY ||
      custody.bytes + (commands?.retained_bytes ?? 0) + EventValidationSchema.RESERVATION_BYTES > 822_607_872)
      return yield* failure("VALIDATION_CAPACITY")
    yield* tx.run(sql`INSERT INTO event_validation_project(project_key,instance_id,active_run_id,owner_token,revision,updated_at)
      VALUES(${rule.projectKey},${rule.instanceID},NULL,NULL,1,${now}) ON CONFLICT(project_key) DO NOTHING`)
    const project = yield* tx.get<{ active_run_id: string | null }>(sql`SELECT active_run_id FROM event_validation_project WHERE project_key=${rule.projectKey}`)
    if (!project || project.active_run_id !== null) return undefined
    const runID = `validation_${randomUUID()}`
    const run = yield* checked(EventValidationSchema.RunRecord, { version: 1, runID, ruleID, instanceID: rule.instanceID,
      projectKey: rule.projectKey, ruleRevision: rule.revision, contentRevision: rule.contentRevision, contentHash: content.contentHash,
      recipeHash: hash(rule.configuration.recipe), configHash: rule.configHash, state: "queued", outcome: null, ownerToken, revision: 1, cancelRequested: false,
      content, testRunID: rule.configuration.kind === "test" ? runID : null, previewBuildID: rule.configuration.kind === "build" ? runID : null,
      snapshotHash: null, processIncarnation: null, processID: null, result: null, resultCurrent: false,
      workspaceBasename: `cmd_${randomUUID().replaceAll("-", "")}`, workspaceIdentity: null,
      retainedBytes: EventValidationSchema.RESERVATION_BYTES, releasedAt: null,
      createdAt: now, startedAt: null, terminalAt: null, deadline: Math.min(rule.configuration.expiresAt, now + rule.configuration.recipe.timeoutMs) })
    if (Buffer.byteLength(CanonicalJson.stringify(run)) > EventValidationSchema.MAX_RUN_BYTES - 8192)
      return yield* failure("VALIDATION_CAPACITY")
    yield* insert(tx, "event_validation_run", runColumns(run))
    const changed = yield* tx.all(sql`UPDATE event_validation_project SET active_run_id=${runID},owner_token=${ownerToken},revision=revision+1,updated_at=${now}
      WHERE project_key=${rule.projectKey} AND active_run_id IS NULL RETURNING project_key`)
    if (changed.length !== 1) return yield* failure("VALIDATION_CONFLICT")
    yield* writeRule(tx, { ...rule, runCount: rule.runCount + 1, pendingFirstAt: null, pendingLastAt: null, dueAt: null,
      lastReason: "running", updatedAt: now }, rule)
    return { rule, run }
  }), { behavior: "immediate" })
  if (claimed) claims.set(claimed.run, { db, native, run: structuredClone(claimed.run), configuration: structuredClone(claimed.rule.configuration), used: false })
  return claimed
}, preserve)

/** Preparation, launch and settlement share the project's durable owner. No lease expiry
 * transfers a possibly live process to another consumer. */
export const preparing = Effect.fn("EventValidation.preparing")(function* (db: Db, runID: string, ownerToken: string) {
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const run = yield* owned(tx, runID, ownerToken)
    if (run.state !== "queued") return yield* failure("VALIDATION_CONFLICT")
    yield* requireRunCurrent(tx, run)
    const next = { ...run, state: "preparing" as const, revision: run.revision + 1 }
    yield* writeRun(tx, next, run)
    return next
  }), { behavior: "immediate" })
}, preserve)
export const prepared = Effect.fn("EventValidation.prepared")(function* (db: Db, runID: string, ownerToken: string, handle: Handle) {
  const native = yield* Native
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const run = yield* owned(tx, runID, ownerToken)
    const snapshot = native.snapshot(handle)
    if (run.state !== "preparing" || run.snapshotHash !== null || run.processIncarnation !== null || run.workspaceIdentity !== null ||
      !snapshot || snapshot.configHash !== run.configHash || snapshot.contentHash !== run.contentHash || snapshot.workspaceBasename !== run.workspaceBasename)
      return yield* failure("VALIDATION_CONFLICT")
    // Custody is an observed resource, not dispatch authorization. It remains recordable
    // after cancellation so a still-owned, never-dispatched snapshot can be cleaned.
    const next = { ...run, snapshotHash: snapshot.snapshotHash, processIncarnation: snapshot.incarnation,
      workspaceIdentity: snapshot.workspaceIdentity, revision: run.revision + 1 }
    yield* writeRun(tx, next, run)
    return next
  }), { behavior: "immediate" })
}, preserve)
export const dispatch = Effect.fn("EventValidation.dispatch")(function* (db: Db, runID: string, ownerToken: string, handle: Handle) {
  const native = yield* Native
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const run = yield* owned(tx, runID, ownerToken)
    if (run.state !== "preparing") return yield* failure("VALIDATION_CONFLICT")
    const rule = yield* requireRunCurrent(tx, run)
    const snapshot = native.snapshot(handle)
    if (!snapshot || snapshot.configHash !== rule.configHash || snapshot.configHash !== run.configHash || snapshot.contentHash !== run.contentHash ||
      snapshot.workspaceBasename !== run.workspaceBasename || snapshot.snapshotHash !== run.snapshotHash ||
      snapshot.incarnation !== run.processIncarnation || hash(snapshot.workspaceIdentity) !== hash(run.workspaceIdentity))
      return yield* failure("VALIDATION_UNAVAILABLE")
    const next = { ...run, state: "dispatching" as const, snapshotHash: snapshot.snapshotHash,
      processIncarnation: snapshot.incarnation, revision: run.revision + 1, startedAt: Date.now() }
    next.workspaceIdentity = snapshot.workspaceIdentity
    yield* writeRun(tx, next, run)
    return next
  }), { behavior: "immediate" })
}, preserve)
export const started = Effect.fn("EventValidation.started")(function* (db: Db, runID: string, ownerToken: string, pid: number,
  mode: "observe" | "before_continue" = "observe") {
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const run = yield* owned(tx, runID, ownerToken)
    if (run.state !== "dispatching" || run.processID !== null || !Number.isSafeInteger(pid) || pid <= 0)
      return yield* failure("VALIDATION_CONFLICT")
    // Linux's payload is still blocked on the original Ready pipe. Current
    // authority and its observed PID must commit together before Continue.
    if (mode === "before_continue") yield* requireRunCurrent(tx, run)
    // Persist the exact observed handle even if cancellation won after dispatch. The
    // native runner still checks its cancellation signal before providing command input.
    const next = { ...run, processID: pid, revision: run.revision + 1 }
    yield* writeRun(tx, next, run)
    return next
  }), { behavior: "immediate" })
}, preserve)
export const checkRun = Effect.fn("EventValidation.checkRun")(function* (db: Db, runID: string, ownerToken: string) {
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const run = yield* owned(tx, runID, ownerToken)
    yield* requireRunCurrent(tx, run)
    return run
  }), { behavior: "immediate" })
}, preserve)
export const finish = Effect.fn("EventValidation.finish")(function* (db: Db, runID: string, ownerToken: string, handle: Handle) {
  const native = yield* Native
  const result = native.result(handle)
  const snapshot = native.snapshot(handle)
  if (!result || !snapshot || !result.stopConfirmed || !result.stdout.complete || !result.stderr.complete)
    return yield* markUnknown(db, runID, ownerToken)
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const run = yield* owned(tx, runID, ownerToken)
    if (run.state !== "dispatching" || run.snapshotHash !== snapshot.snapshotHash || run.processIncarnation !== snapshot.incarnation)
      return yield* failure("VALIDATION_CONFLICT")
    const rule = yield* getRule(tx, run.ruleID)
    if (!rule) return yield* failure("VALIDATION_INVALID")
    const authority = yield* requireEnabled(tx, rule, true).pipe(Effect.option)
    const current = Option.isSome(authority) && !run.cancelRequested && rule.revision === run.ruleRevision &&
      rule.contentRevision === run.contentRevision && rule.contentHash === run.contentHash
    const next = fitResult({ ...run, state: current ? "settled" as const : "superseded" as const,
      outcome: result.outcome, result, resultCurrent: current, revision: run.revision + 1, terminalAt: Date.now() }
    )
    yield* writeRun(tx, next, run)
    yield* release(tx, run)
    if (current) yield* writeRule(tx, { ...rule, currentRunID: run.runID, lastReason: "completed", updatedAt: Date.now() }, rule)
    return next
  }), { behavior: "immediate" })
}, preserve)
/** Refusal before physical dispatch is safe to release. An unknown launch/result is
 * deliberately a different transition and retains the project barrier after restart. */
export const finishBeforeDispatch = Effect.fn("EventValidation.finishBeforeDispatch")(function* (db: Db, runID: string, ownerToken: string) {
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const run = yield* owned(tx, runID, ownerToken)
    if (run.state !== "queued" && run.state !== "preparing") return yield* failure("VALIDATION_CONFLICT")
    const next = { ...run, state: run.cancelRequested ? "cancelled" as const : "superseded" as const,
      outcome: run.cancelRequested ? "cancelled" as const : "refused" as const, revision: run.revision + 1, terminalAt: Date.now() }
    yield* writeRun(tx, next, run)
    yield* release(tx, run)
    return next
  }), { behavior: "immediate" })
}, preserve)
export const markUnknown = Effect.fn("EventValidation.markUnknown")(function* (db: Db, runID: string, ownerToken: string) {
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const run = yield* owned(tx, runID, ownerToken)
    if (run.state === "unknown") return run
    if (run.state !== "dispatching") return yield* failure("VALIDATION_CONFLICT")
    const next = { ...run, state: "unknown" as const, outcome: null, result: null, resultCurrent: false,
      revision: run.revision + 1, terminalAt: Date.now() }
    yield* writeRun(tx, next, run)
    const rule = yield* getRule(tx, run.ruleID)
    if (rule?.state === "enabled") yield* writeRule(tx, { ...rule, currentRunID: null, lastReason: "unknown", updatedAt: Date.now() }, rule)
    return next
  }), { behavior: "immediate" })
}, preserve)
export const released = Effect.fn("EventValidation.released")(function* (db: Db, runID: string, handle: Handle) {
  const native = yield* Native
  const snapshot = native.snapshot(handle)
  if (!snapshot || !native.cleaned(handle)) return yield* failure("VALIDATION_UNAVAILABLE")
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const run = yield* getRun(tx, runID)
    if (!run || run.state === "unknown" || run.terminalAt === null || run.snapshotHash !== snapshot.snapshotHash ||
      run.processIncarnation !== snapshot.incarnation || run.workspaceBasename !== snapshot.workspaceBasename)
      return yield* failure("VALIDATION_CONFLICT")
    if (run.releasedAt !== null) return run
    const next = { ...run, retainedBytes: 0, releasedAt: Date.now(), revision: run.revision + 1 }
    yield* writeRun(tx, next, run)
    return next
  }), { behavior: "immediate" })
}, preserve)
/** Only a live native producer can attest that preparation created nothing or cleaned
 * its own held workspace. Neither cold JSON nor an absent pathname grants disposal. */
export const releasedPreparation = Effect.fn("EventValidation.releasedPreparation")(function* (db: Db, runID: string, ownerToken: string, preparation: Preparation) {
  const native = yield* Native
  const binding = preparations.get(preparation)
  const disposition = native.disposition(preparation)
  if (!binding || binding.db !== db || binding.native !== native || binding.runID !== runID || binding.ownerToken !== ownerToken ||
    !disposition || disposition.runID !== runID || disposition.ownerToken !== ownerToken) return yield* failure()
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const run = yield* getRun(tx, runID)
    if (!run || run.ownerToken !== ownerToken || (run.state !== "cancelled" && run.state !== "superseded") || run.terminalAt === null || run.result !== null || run.resultCurrent ||
      run.processID !== null || run.startedAt !== null || !["cancelled", "refused"].includes(run.outcome ?? "") ||
      run.workspaceBasename !== disposition.workspaceBasename || run.configHash !== disposition.configHash || run.contentHash !== disposition.contentHash ||
      run.deadline !== disposition.deadline || disposition.observedAt < run.createdAt || disposition.observedAt > Date.now() ||
      (run.snapshotHash !== null && (run.snapshotHash !== disposition.snapshotHash || run.processIncarnation !== disposition.incarnation ||
        hash(run.workspaceIdentity) !== hash(disposition.workspaceIdentity))) ||
      (disposition.kind === "no_workspace_created" ? disposition.workspaceIdentity !== null : disposition.workspaceIdentity === null)) return yield* failure("VALIDATION_CONFLICT")
    if (run.releasedAt !== null) return run
    const next = yield* checked(EventValidationSchema.RunRecord, { ...run, retainedBytes: 0, releasedAt: Date.now(), revision: run.revision + 1,
      preparationRelease: { version: 1, preparationID: disposition.preparationID, kind: disposition.kind,
        workspaceIdentity: disposition.workspaceIdentity, observedAt: disposition.observedAt } })
    yield* writeRun(tx, next, run)
    return next
  }), { behavior: "immediate" })
}, preserve)
export const due = Effect.fn("EventValidation.due")(function* (db: Reader, instanceID: string) {
  return yield* db.all<{ rule_id: string; due_at: number }>(sql`SELECT rule_id,due_at FROM event_validation_rule
    WHERE instance_id=${instanceID} AND state='enabled' AND due_at IS NOT NULL ORDER BY due_at,rule_id LIMIT 256`)
}, preserve)
export const canSchedule = Effect.fn("EventValidation.canSchedule")(function* (db: Reader, projectKey: string) {
  const row = yield* db.get<{ active_run_id: string | null }>(sql`SELECT active_run_id FROM event_validation_project WHERE project_key=${projectKey}`)
  return !row || row.active_run_id === null
}, preserve)
export const observationUnavailable = Effect.fn("EventValidation.observationUnavailable")(function* (db: Db,
  expected: Pick<Rule, "ruleID" | "revision" | "configHash" | "contentRevision" | "contentHash">,
  code: EventValidationSchema.Error["code"] = "VALIDATION_UNAVAILABLE") {
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const rule = yield* getRule(tx, expected.ruleID)
    if (!rule || rule.state !== "enabled" || rule.revision !== expected.revision || rule.configHash !== expected.configHash ||
      rule.contentRevision !== expected.contentRevision || rule.contentHash !== expected.contentHash || code === "VALIDATION_CONFLICT" || code === "VALIDATION_NOT_FOUND") return
    const blocked = yield* tx.get<{ state: string }>(sql`SELECT r.state FROM event_validation_project p
      JOIN event_validation_run r ON r.run_id=p.active_run_id WHERE p.project_key=${rule.projectKey}`)
    const lastReason = blocked?.state === "unknown" || code === "VALIDATION_RECOVERY_REQUIRED" ? "unknown" :
      rule.configuration.expiresAt <= Date.now() ? "expired" : code === "VALIDATION_CAPACITY" ? "budget_exhausted" :
      code === "VALIDATION_AUTH_REQUIRED" || code === "VALIDATION_SCOPE_CHANGED" ? "authority_changed" : "native_unavailable"
    // Capacity is backpressure, not an invalid observation. Keep its original due
    // revision eligible for a later real completion/hint; never spin a new timer here.
    const keepDue = lastReason === "budget_exhausted" || lastReason === "unknown"
    const next: Rule = { ...rule, currentRunID: keepDue ? rule.currentRunID : null,
      pendingFirstAt: keepDue ? rule.pendingFirstAt : null, pendingLastAt: keepDue ? rule.pendingLastAt : null,
      dueAt: keepDue ? rule.dueAt : null, lastReason, updatedAt: Date.now() }
    yield* writeRule(tx, next, rule)
  }), { behavior: "immediate" })
}, preserve)
export const rules = Effect.fn("EventValidation.rules")(function* (db: Reader, instanceID: string) {
  const rows = yield* db.all<{ rule_id: string }>(sql`SELECT rule_id FROM event_validation_rule WHERE instance_id=${instanceID} ORDER BY rule_id LIMIT 257`)
  if (rows.length > EventValidationSchema.MAX_RULES) return yield* failure("VALIDATION_CAPACITY")
  return yield* Effect.forEach(rows, (row) => getRule(db, row.rule_id))
}, preserve)
export const history = Effect.fn("EventValidation.history")(function* (db: Reader, ruleID: string) {
  const rows = yield* db.all<{ run_id: string }>(sql`SELECT run_id FROM event_validation_run WHERE rule_id=${ruleID} ORDER BY created_at DESC,run_id DESC LIMIT 50`)
  return yield* Effect.forEach(rows, (row) => getRun(db, row.run_id))
}, preserve)

function owned(tx: Tx, runID: string, ownerToken: string) {
  return Effect.gen(function* () {
    const run = yield* getRun(tx, runID)
    if (!run || run.ownerToken !== ownerToken) return yield* failure("VALIDATION_CONFLICT")
    const slot = yield* tx.get<{ active_run_id: string | null; owner_token: string | null }>(sql`SELECT active_run_id,owner_token
      FROM event_validation_project WHERE project_key=${run.projectKey}`)
    if (slot?.active_run_id !== runID || slot.owner_token !== ownerToken) return yield* failure("VALIDATION_CONFLICT")
    return run
  })
}
function requireRunCurrent(tx: Tx, run: Run) {
  return Effect.gen(function* () {
    const rule = yield* getRule(tx, run.ruleID)
    if (!rule || run.cancelRequested || run.deadline <= Date.now() || rule.revision !== run.ruleRevision ||
      rule.contentRevision !== run.contentRevision || rule.contentHash !== run.contentHash)
      return yield* failure("VALIDATION_CONFLICT")
    yield* requireEnabled(tx, rule, true)
    return rule
  })
}
function release(tx: Tx, run: Run) {
  return Effect.gen(function* () {
    const changed = yield* tx.all(sql`UPDATE event_validation_project SET active_run_id=NULL,owner_token=NULL,revision=revision+1,updated_at=${Date.now()}
      WHERE project_key=${run.projectKey} AND active_run_id=${run.runID} AND owner_token=${run.ownerToken} RETURNING project_key`)
    if (changed.length !== 1) return yield* failure("VALIDATION_CONFLICT")
  })
}

export function requireScope(tx: Tx, scope: EventValidationSchema.Scope, instanceID: string) {
  return Effect.gen(function* () {
    if (scope.instanceID !== instanceID) return yield* failure("VALIDATION_SCOPE_CHANGED")
    const row = yield* tx.get<{ found: number }>(sql`SELECT 1 found FROM context_location_identity l
      JOIN context_security_namespace n ON n.id=l.security_namespace_id
      JOIN context_project_scope_identity p ON p.security_namespace_id=l.security_namespace_id AND p.project_scope_key=l.project_scope_key
      WHERE l.security_namespace_id=${scope.securityNamespaceID} AND l.location_key=${scope.locationKey}
        AND l.project_scope_key=${scope.projectScopeKey} AND l.canonical_root=${scope.canonicalRoot}
        AND l.observed_project_id=${scope.projectID} AND p.observed_project_id=${scope.projectID}
        AND l.workspace_binding IS ${scope.workspaceID === null ? null : scope.namespaceBindingHash} AND n.binding_hash=${scope.namespaceBindingHash}
        AND l.retired_at IS NULL AND n.retired_at IS NULL AND p.retired_at IS NULL`)
    if (!row) return yield* failure("VALIDATION_SCOPE_CHANGED")
  })
}
function requireEnabled(tx: Tx, rule: Rule, admitted = false) {
  return Effect.gen(function* () {
    const actor = yield* LocalOperator.requireCurrent(tx).pipe(Effect.mapError(() => failure("VALIDATION_AUTH_REQUIRED")))
    yield* requireScope(tx, rule.configuration.scope, actor.instance_id)
    yield* requirePolicy(actor, rule.configuration)
    if (actor.operator_id !== rule.operatorID || actor.revision !== rule.operatorRevision || rule.state !== "enabled" ||
      rule.approval?.ruleRevision !== rule.revision || rule.approval.configHash !== rule.configHash ||
      rule.approval.operatorRevision !== actor.revision || rule.configuration.expiresAt <= Date.now())
      return yield* failure("VALIDATION_AUTH_REQUIRED")
    if (admitted ? rule.runCount > rule.configuration.maxRuns : rule.runCount >= rule.configuration.maxRuns)
      return yield* failure("VALIDATION_CAPACITY")
  })
}
function targetScope(actor: Effect.Success<ReturnType<typeof LocalOperator.requireCurrent>>, entry: LocalOperatorSchema.RegisteredTarget): EventValidationSchema.Scope | undefined {
  if (!("version" in entry.target) || entry.target.projectScope.rootIdentity.kind !== "posix" ||
    entry.target.scope.actorID !== actor.operator_id || entry.target.location.workspaceID !== undefined) return undefined
  return { instanceID: actor.instance_id, workspaceID: null, securityNamespaceID: entry.target.scope.securityNamespaceID,
    namespaceBindingHash: entry.namespaceBindingHash, locationKey: entry.locationKey, projectScopeKey: entry.target.scope.projectScopeKey,
    projectID: entry.target.projectScope.projectID, canonicalRoot: entry.target.location.directory,
    rootIdentity: entry.target.projectScope.rootIdentity }
}
function requirePolicy(actor: Effect.Success<ReturnType<typeof LocalOperator.requireCurrent>>, configuration: EventValidationSchema.Configuration) {
  const allowed = actor.policy.targets.some((entry) => {
    const scope = targetScope(actor, entry)
    if (!("version" in entry.target) || !scope || hash(scope) !== hash(configuration.scope) ||
      entry.target.projectScope.helperHash !== configuration.helperHash ||
      !entry.target.toolPolicy.capabilities.some((tool) => tool.toolID === "managed_command" && tool.operations.includes("run")) ||
      !entry.target.toolPolicy.commandRecipes?.some((recipe) => hash(recipe) === hash(configuration.recipe))) return false
    const files = entry.target.toolPolicy.fileScope
    return configuration.watch.every((relative) => {
      const matches = (rule: typeof files.read[number]) => relative === rule.path || (rule.kind === "tree" && relative.startsWith(`${rule.path}/`))
      return files.read.some(matches) && !files.deny.some(matches)
    })
  })
  return allowed ? Effect.void : failure("VALIDATION_SCOPE_CHANGED")
}
function capacity(tx: Tx, table: "event_validation_rule" | "event_validation_run" | "event_validation_command", instanceID: string, limit: number) {
  return Effect.gen(function* () {
    const total = yield* tx.get<{ count: number }>(sql`SELECT count(*) count FROM ${sql.raw(table)} WHERE instance_id=${instanceID}`)
    if (!total || !Number.isSafeInteger(total.count) || total.count >= limit) return yield* failure("VALIDATION_CAPACITY")
  })
}
function command(tx: Reader, instanceID: string, requestID: string, requestHash: string) {
  return Effect.gen(function* () {
    const size = yield* tx.get<{ bytes: number }>(sql`SELECT length(CAST(receipt AS BLOB)) bytes FROM event_validation_command
      WHERE instance_id=${instanceID} AND request_id=${requestID}`)
    if (!size) return undefined
    if (size.bytes > EventValidationSchema.MAX_COMMAND_BYTES || size.bytes < 1) return yield* failure("VALIDATION_INVALID")
    const row = yield* tx.get<{ request_hash: string; receipt: string }>(sql`SELECT request_hash,receipt FROM event_validation_command
      WHERE instance_id=${instanceID} AND request_id=${requestID} AND length(CAST(receipt AS BLOB))<=${EventValidationSchema.MAX_COMMAND_BYTES}`)
    if (!row || row.request_hash !== requestHash) return yield* failure("VALIDATION_CONFLICT")
    return yield* checked(Schema.fromJsonString(EventValidationSchema.CommandReceipt), row.receipt)
  })
}
function retry(tx: Tx, requestID: string, requestHash: string) {
  return Effect.gen(function* () {
    const actor = yield* LocalOperator.requireMutation(tx).pipe(Effect.mapError(() => failure("VALIDATION_AUTH_REQUIRED")))
    const receipt = yield* command(tx, actor.instance_id, requestID, requestHash)
    if (receipt) {
      const rule = yield* getRule(tx, receipt.ruleID)
      if (!rule || rule.operatorID !== actor.operator_id) return yield* failure("VALIDATION_AUTH_REQUIRED")
      yield* requireScope(tx, rule.configuration.scope, actor.instance_id)
    }
    return receipt
  })
}
function saveCommand(tx: Tx, rule: Rule, requestID: string, requestHash: string,
  action: typeof EventValidationSchema.Action.Type, runID: string | null) {
  return Effect.gen(function* () {
    // A filled admission ledger must not disable shrinking controls.
    if (action === "create" || action === "update" || action === "enable" || action === "verify")
      yield* capacity(tx, "event_validation_command", rule.instanceID, EventValidationSchema.MAX_COMMANDS - 768)
    yield* capacity(tx, "event_validation_command", rule.instanceID, EventValidationSchema.MAX_COMMANDS)
    const receipt = yield* checked(EventValidationSchema.CommandReceipt, { version: 1, instanceID: rule.instanceID, requestID,
      ruleID: rule.ruleID, action, ruleRevision: rule.revision, runID, createdAt: Date.now() })
    yield* insert(tx, "event_validation_command", { instance_id: rule.instanceID, request_id: requestID, rule_id: rule.ruleID,
      action, request_hash: requestHash, receipt: CanonicalJson.stringify(receipt), created_at: receipt.createdAt })
    return receipt
  })
}
function ruleColumns(rule: Rule) {
  return { rule_id: rule.ruleID, instance_id: rule.instanceID, project_key: rule.projectKey, revision: rule.revision,
    state: rule.state, operator_id: rule.operatorID, operator_revision: rule.operatorRevision, config_hash: rule.configHash,
    content_revision: rule.contentRevision, content_hash: rule.contentHash, run_count: rule.runCount,
    pending_first_at: rule.pendingFirstAt, pending_last_at: rule.pendingLastAt, due_at: rule.dueAt,
    current_run_id: rule.currentRunID, last_reason: rule.lastReason, record: CanonicalJson.stringify(rule), record_hash: hash(rule),
    investigation_epoch: rule.investigationAuthority?.epoch ?? 0,
    created_at: rule.createdAt, updated_at: rule.updatedAt }
}
function runColumns(run: Run) {
  return { run_id: run.runID, rule_id: run.ruleID, instance_id: run.instanceID, project_key: run.projectKey,
    rule_revision: run.ruleRevision, content_revision: run.contentRevision, content_hash: run.contentHash,
    recipe_hash: run.recipeHash, state: run.state, outcome: run.outcome, owner_token: run.ownerToken, revision: run.revision,
    cancel_requested: run.cancelRequested ? 1 : 0, record: CanonicalJson.stringify(run), record_hash: hash(run),
    retained_bytes: run.retainedBytes, released_at: run.releasedAt,
    created_at: run.createdAt, started_at: run.startedAt, terminal_at: run.terminalAt, deadline: run.deadline }
}
function insert(tx: Tx, table: string, values: Record<string, string | number | null>) {
  return tx.run(sql`INSERT INTO ${sql.raw(table)} (${sql.join(Object.keys(values).map((name) => sql.raw(name)), sql`,`)})
    VALUES (${sql.join(Object.values(values).map((value) => sql`${value}`), sql`,`)})`)
}
function writeRule(tx: Tx, next: Rule, previous?: Rule) {
  return Effect.gen(function* () {
    yield* checked(EventValidationSchema.RuleRecord, next)
    if (!previous) { yield* insert(tx, "event_validation_rule", ruleColumns(next)); return }
    if (previous.investigationAuthority && (next.revision !== previous.revision || next.contentRevision !== previous.contentRevision ||
      next.contentHash !== previous.contentHash || next.configHash !== previous.configHash || next.state !== previous.state ||
      next.operatorRevision !== previous.operatorRevision)) {
      const { EventInvestigation } = yield* Effect.promise(() => import("./event-investigation"))
      yield* EventInvestigation.invalidateRuleInTransaction(tx, previous.ruleID, previous.investigationAuthority.epoch).pipe(
        Effect.mapError(() => failure("VALIDATION_CONFLICT")))
    }
    const values = ruleColumns(next)
    const changed = yield* tx.all(sql`UPDATE event_validation_rule SET ${sql.join(Object.entries(values).map(([name, value]) => sql`${sql.raw(name)}=${value}`), sql`,`)}
      WHERE rule_id=${previous.ruleID} AND record_hash=${hash(previous)} RETURNING rule_id`)
    if (changed.length !== 1) return yield* failure("VALIDATION_CONFLICT")
  })
}
function withInvestigation(next: Rule, previous?: Rule): Rule {
  const authority = previous?.investigationAuthority
  if (!authority) return next
  if (next.configHash === previous.configHash && next.operatorRevision === previous.operatorRevision &&
    (next.state === previous.state || next.state === "enabled")) return { ...next, investigationAuthority: authority }
  return { ...next, investigationAuthority: { version: 1, epoch: authority.epoch + 1,
    state: "disabled", grant: null, updatedAt: next.updatedAt } }
}
function cancelRuleRuns(tx: Tx, ruleID: string) {
  return Effect.gen(function* () {
    const rows = yield* tx.all<{ run_id: string }>(sql`SELECT run_id FROM event_validation_run WHERE rule_id=${ruleID}
      AND state IN ('queued','preparing','dispatching') AND cancel_requested=0 LIMIT 2`)
    if (rows.length > 1) return yield* failure("VALIDATION_INVALID")
    for (const row of rows) {
      const run = yield* getRun(tx, row.run_id)
      if (!run) return yield* failure("VALIDATION_INVALID")
      const next = { ...run, cancelRequested: true, revision: run.revision + 1 }
      yield* writeRun(tx, next, run)
    }
  })
}
function writeRun(tx: Tx, next: Run, previous: Run) {
  return Effect.gen(function* () {
    yield* checked(EventValidationSchema.RunRecord, next)
    const changed = yield* tx.all(sql`UPDATE event_validation_run SET ${sql.join(Object.entries(runColumns(next)).map(([name, value]) => sql`${sql.raw(name)}=${value}`), sql`,`)}
      WHERE run_id=${previous.runID} AND record_hash=${hash(previous)} RETURNING run_id`)
    if (changed.length !== 1) return yield* failure("VALIDATION_CONFLICT")
  })
}

function fitResult(run: Run): Run {
  if (!run.result || Buffer.byteLength(CanonicalJson.stringify(run)) <= EventValidationSchema.MAX_RUN_BYTES) return run
  const stream = Buffer.byteLength(run.result.stdout.excerpt) >= Buffer.byteLength(run.result.stderr.excerpt) ? "stdout" : "stderr"
  const original = run.result[stream]
  const bytes = Buffer.from(original.excerpt)
  const end = { value: Math.floor(bytes.length / 2) }
  while (end.value > 0 && (bytes[end.value]! & 0xc0) === 0x80) end.value--
  if (bytes.length === 0) throw failure("VALIDATION_CAPACITY")
  return fitResult({ ...run, result: { ...run.result, [stream]: { ...original,
    excerpt: bytes.subarray(0, end.value).toString("utf8"), excerptTruncated: true } } })
}
