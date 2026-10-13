export * as PermissionV2 from "./permission"

import { ToolFailure } from "@deepagent-code/llm"
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect as EffectRuntime,
  Layer,
  Ref,
  Schedule,
  Schema,
  Semaphore,
  type Scope,
} from "effect"
import { and, eq, isNull, sql } from "drizzle-orm"
import { Database } from "./database/database"
import { GoalChildSchema } from "./deepagent/goal-child.schema"
import { GoalChildUnitTable } from "./deepagent/goal-child.sql"
import { GoalControl } from "./deepagent/goal-control"
import { DeepAgentPlanStore } from "./deepagent/plan-store"
import { DocumentStore } from "./deepagent/document-store"
import { GoalChildExecution } from "./deepagent/goal-child-execution"
import { WorkToolPolicy } from "./session/work-tool-policy"
import { WorkAuthority } from "./session/work-authority"
import { GoalChild } from "./deepagent/goal-child"
import { GoalChildPolicy } from "./deepagent/goal-child-policy"
import { DeepAgentActivityAuthority } from "./deepagent/activity-authority"
import { SessionActivityPermissionRequestTable } from "./deepagent/activity-authority.sql"
import { makeLocationNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { Location } from "./location"
import { AgentV2 } from "./agent"
import { SessionNotFound } from "./session/error"
import { SessionSchema } from "./session/schema"
import { SessionStore } from "./session/store"
import { SessionTable } from "./session/sql"
import { withStatics } from "./schema"
import { Identifier } from "./util/identifier"
import { Wildcard } from "./util/wildcard"
import { PermissionSchema } from "./permission/schema"
import { PermissionSaved } from "./permission/saved"
import { PermissionSavedEpochTable } from "./permission/sql"
import { CanonicalJson } from "./util/canonical-json"
import { McpAppInvocationSchema } from "./session/mcp-app-invocation.schema"
import { Hash } from "./util/hash"

export { Effect, Rule, Ruleset } from "./permission/schema"
type Effect = PermissionSchema.Effect
type Rule = PermissionSchema.Rule
type Ruleset = PermissionSchema.Ruleset
const missingAgentPermissions: Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

export const ID = Schema.String.check(Schema.isStartsWith("per")).pipe(
  Schema.brand("PermissionV2.ID"),
  withStatics((schema) => ({ create: (id?: string) => schema.make(id ?? "per_" + Identifier.ascending()) })),
)
export type ID = typeof ID.Type

export const Source = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("tool"),
    messageID: Schema.String,
    callID: Schema.String,
  }),
  McpAppInvocationSchema.PermissionSource,
]).annotate({ identifier: "PermissionV2.Source" })
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: SessionSchema.ID,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  save: Schema.Array(Schema.String).pipe(Schema.optional),
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
  source: Source.pipe(Schema.optional),
}

export const Request = Schema.Struct({
  id: ID,
  ...RequestFields,
}).annotate({ identifier: "PermissionV2.Request" })
export type Request = typeof Request.Type

export const Reply = Schema.Literals(["once", "always", "reject"]).annotate({ identifier: "PermissionV2.Reply" })
export type Reply = typeof Reply.Type

export const AssertInput = Schema.Struct({
  id: ID.pipe(Schema.optional),
  ...RequestFields,
  agent: AgentV2.ID.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.AssertInput" })
export type AssertInput = typeof AssertInput.Type

export const ReplyInput = Schema.Struct({
  requestID: ID,
  reply: Reply,
  message: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.ReplyInput" })
export type ReplyInput = typeof ReplyInput.Type

export const AskResult = Schema.Struct({
  id: ID,
  effect: PermissionSchema.Effect,
}).annotate({ identifier: "PermissionV2.AskResult" })
export type AskResult = typeof AskResult.Type

export const Event = {
  Asked: EventV2.define({ type: "permission.v2.asked", schema: Request.fields }),
  Replied: EventV2.define({
    type: "permission.v2.replied",
    schema: {
      sessionID: SessionSchema.ID,
      requestID: ID,
      reply: Reply,
    },
  }),
}

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionV2.RejectedError", {}) {
  override get message() {
    return "The user rejected permission to use this specific tool call."
  }
}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionV2.CorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionV2.DeniedError", {
  rules: PermissionSchema.Ruleset,
}) {
  override get message() {
    return `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(this.rules)}`
  }
}

/** Model-visible wording for a permission refusal, or null when the error is not one. */
export function permissionFailureMessage(error: unknown): string | null {
  return classifyRefusal(error)?.message ?? null
}

/** Machine-readable refusal classification, aligned with the V1 `failureCode` vocabulary. */
export type FailureCode = "user_rejected_permission" | "user_corrected_permission" | "permission_denied_rule"

/** Structured code for a permission refusal, or null when the error is not one. */
export function permissionFailureCode(error: unknown): FailureCode | null {
  return classifyRefusal(error)?.code ?? null
}

/** ToolFailure for a permission refusal, carrying the refusal wording plus a structured failureCode. */
export function permissionToolFailure(error: unknown): ToolFailure | null {
  const refusal = classifyRefusal(error)
  if (refusal === null) return null
  return new ToolFailure({ message: refusal.message, error, metadata: { failureCode: refusal.code } })
}

function classifyRefusal(error: unknown): { readonly code: FailureCode; readonly message: string } | null {
  if (error instanceof RejectedError) return { code: "user_rejected_permission", message: error.message }
  if (error instanceof CorrectedError) return { code: "user_corrected_permission", message: error.message }
  if (error instanceof DeniedError) return { code: "permission_denied_rule", message: error.message }
  return null
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("PermissionV2.NotFoundError", {
  requestID: ID,
}) {}

export const MAX_PENDING_REQUESTS = 512
export class CapacityError extends Schema.TaggedErrorClass<CapacityError>()("PermissionV2.CapacityError", {
  limit: Schema.Number,
}) {}

export type Error = DeniedError | RejectedError | CorrectedError | CapacityError

export function evaluate(action: string, resource: string, ...rulesets: Ruleset[]): Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

export function merge(...rulesets: Ruleset[]): Ruleset {
  return rulesets.flat()
}

export function isActionWhollyDenied(action: string, ...rulesets: Ruleset[]): boolean {
  return rulesets.some((rules) => {
    const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
    return rule?.resource === "*" && rule.effect === "deny"
  })
}

declare const ActionPermitType: unique symbol
export type ActionPermit = { readonly [ActionPermitType]: true }

declare const FileActionsType: unique symbol
export type FileActions = { readonly [FileActionsType]: true }
type ActionPair = { readonly permit: ActionPermit; readonly input: AssertInput }
type FileActionsView = { readonly sessionID: SessionSchema.ID; readonly projectID: string;
  readonly directory: Location.Interface["directory"]; readonly workspaceID: Location.Interface["workspaceID"];
  readonly permissionRaw: string | null; readonly savedEpoch: number }
const fileActions = new WeakMap<FileActions, { view: FileActionsView; current: () => boolean }>()
declare const AppActionType: unique symbol
export type AppAction = { readonly [AppActionType]: true }
const appActions = new WeakMap<AppAction, { readonly check: EffectRuntime.Effect<void, Error | SessionNotFound.Error>; readonly current: () => boolean;
  readonly receipt: typeof McpAppInvocationSchema.PermissionReceipt.Type }>()
export function appActionCurrent(token: AppAction) { return appActions.get(token)?.current() === true }
export function appActionReceipt(token: AppAction) { const saved = appActions.get(token); return saved?.current() ? saved.receipt : undefined }
/** The caller's short transaction consumes only original permits, SQL and current objects. */
export const consumeAppAction = (token: AppAction) => EffectRuntime.suspend(() => {
  const saved = appActions.get(token)
  return saved?.current() ? saved.check : EffectRuntime.fail(new DeniedError({ rules: [] }))
})
/** A view exists only while both original permits, their service and the captured Agent are live. */
export function fileActionsView(token: FileActions): FileActionsView | undefined {
  const saved = fileActions.get(token)
  return saved?.current() ? saved.view : undefined
}

export interface Interface {
  /** Tool-only service fixtures may omit this; the V2 no-progress runner then fails closed. */
  readonly currentNoProgressOwnerID?: () => EffectRuntime.Effect<string>
  readonly ask: (input: AssertInput) => EffectRuntime.Effect<AskResult, SessionNotFound.Error | CapacityError>
  readonly assert: (input: AssertInput) => EffectRuntime.Effect<void, Error | SessionNotFound.Error>
  /** Internal multi-step leaf capability. Once approval stays scoped to the exact source,
   * action and resources; every physical boundary must check it again without asking anew. */
  readonly authorizeAction?: (input: AssertInput) => EffectRuntime.Effect<ActionPermit, Error | SessionNotFound.Error, Scope.Scope>
  readonly checkAction?: (permit: ActionPermit, input: AssertInput) => EffectRuntime.Effect<void, Error | SessionNotFound.Error>
  readonly captureAppAction?: (permit: ActionPermit, input: AssertInput) => EffectRuntime.Effect<AppAction, Error | SessionNotFound.Error, Scope.Scope>
  /** Internal ordinary-file optimization. Call in the same short DB transaction as the
   * canonical frame/control capture. Missing support retains the complete current check. */
  readonly captureFileActions?: (browser: ActionPair, file: ActionPair) =>
    EffectRuntime.Effect<FileActions | undefined, Error | SessionNotFound.Error>
  /** Internal native preparation only. It cannot be addressed by HTTP/tool payloads. */
  readonly prepareGoalScratch?: (input: {
    unitID: string
    policy: GoalChildPolicy.Snapshot
  }) => EffectRuntime.Effect<
    NonNullable<GoalChildSchema.InputReceipt["scratch"]>,
    Error | SessionNotFound.Error | GoalChildSchema.Error
  >
  readonly reply: (input: ReplyInput) => EffectRuntime.Effect<void, NotFoundError>
  readonly get: (id: ID) => EffectRuntime.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionSchema.ID) => EffectRuntime.Effect<ReadonlyArray<Request>>
  readonly list: () => EffectRuntime.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/Permission") {}

interface Pending {
  readonly request: Request
  readonly agent?: AgentV2.ID
  readonly deferred: Deferred.Deferred<void, RejectedError | CorrectedError>
}

export const layer = Layer.effect(
  Service,
  EffectRuntime.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const agents = yield* AgentV2.Service
    const sessions = yield* SessionStore.Service
    const saved = yield* PermissionSaved.Service
    const database = yield* Database.Service
    const noProgressOwner = yield* Ref.make(`v2-no-progress:${Identifier.ascending()}`)
    const withNoProgressOwner = Semaphore.makeUnsafe(1).withPermit
    const pending = new Map<ID, Pending>()
    const actionPermits = new WeakMap<ActionPermit, { input: string; rules: string; savedEpoch: number }>()
    const actionLifetime = { active: true }
    yield* EffectRuntime.addFinalizer(() => EffectRuntime.sync(() => { actionLifetime.active = false }))
    const recoverPermissions = withNoProgressOwner(
      EffectRuntime.gen(function* () {
        const ownerID = yield* Ref.get(noProgressOwner)
        yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({ ownerID, leaseMs: 30_000 }).pipe(
          EffectRuntime.catchTag("ActivityAuthority.ConflictError", () =>
            EffectRuntime.gen(function* () {
              // An expired owner cannot regain its fence. Rotate to a fresh identity, which
              // atomically quarantines its started effects and settles its pending requests.
              const nextOwnerID = `v2-no-progress:${Identifier.ascending()}`
              yield* DeepAgentActivityAuthority.rotatePermissionOwner({
                previousOwnerID: ownerID,
                ownerID: nextOwnerID,
                leaseMs: 30_000,
              })
              yield* Ref.set(noProgressOwner, nextOwnerID)
            }),
          ),
        )
        const recoveryOwnerID = yield* Ref.get(noProgressOwner)
        // An abandoned external effect must be quarantined before its permission is settled;
        // recovery otherwise crosses the activity terminal fence and can leave the ask stranded.
        yield* DeepAgentActivityAuthority.recoverPermissionEffects(recoveryOwnerID)
        yield* DeepAgentActivityAuthority.recoverPendingPermissions(recoveryOwnerID)
      }),
    ).pipe(EffectRuntime.provideService(Database.Service, database))
    yield* recoverPermissions.pipe(EffectRuntime.orDie)
    yield* recoverPermissions.pipe(
      EffectRuntime.catchCause((cause) => EffectRuntime.logError("V2 no-progress owner heartbeat failed", { cause })),
      EffectRuntime.repeat(Schedule.fixed(Duration.seconds(10))),
      EffectRuntime.forkScoped,
    )

    yield* EffectRuntime.addFinalizer(() =>
      EffectRuntime.forEach(pending.values(), (item) => Deferred.fail(item.deferred, new RejectedError()), {
        discard: true,
      }).pipe(
        EffectRuntime.ensuring(
          EffectRuntime.sync(() => {
            pending.clear()
          }),
        ),
      ),
    )

    const savedRules = EffectRuntime.fnUntraced(function* () {
      return (yield* saved.list({ projectID: location.project.id })).map(
        (item): Rule => ({ action: item.action, resource: item.resource, effect: "allow" }),
      )
    })

    const configured = EffectRuntime.fn("PermissionV2.configured")(function* (
      sessionID: SessionSchema.ID,
      agentID?: AgentV2.ID,
    ) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionNotFound.Error({ sessionID })
      const agent = yield* agents.resolve(agentID ?? session.agent)
      const managed = yield* GoalChild.owner(database.db, sessionID).pipe(EffectRuntime.orDie)
      if (managed?.binding.version === 2 || managed?.binding.version === 3) {
        const policy = yield* GoalChildPolicy.requireCurrent(database.db, managed.binding).pipe(EffectRuntime.orDie)
        if (!policy || agent?.id !== managed.binding.agent) return [missingAgentPermissions] as const
        // Each complete ordered ruleset stays independent. A capability never overrides parent deny.
        const finalizer = managed.binding.version === 3 && managed.inputs.at(-1)?.stage.startsWith("finalizer.")
        const role: Ruleset = finalizer
          ? [{ action: "*", resource: "*", effect: "deny" }]
          : [
              { action: "plan", resource: "*", effect: "deny" },
              ...(policy.role.planWriteOwnGoal
                ? [{ action: "plan", resource: policy.planResource, effect: "allow" } as const]
                : []),
            ]
        return [
          agent.permissions,
          session.permissions,
          policy.parentAgentPermissions,
          policy.parentSessionPermissions,
          role,
        ] as const
      }
      return [agent?.permissions ?? missingAgentPermissions, session.permissions] as const
    })

    function configuredEffect(action: string, resource: string, rulesets: readonly Ruleset[]): Effect {
      const rules = rulesets
        .map((rules) =>
          rules.findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)),
        )
        .filter((rule): rule is Rule => rule !== undefined)
      if (rules.some((rule) => rule.effect === "deny")) return "deny"
      if (rules.some((rule) => rule.effect === "ask")) return "ask"
      return rules.length > 0 ? "allow" : "ask"
    }

    function denied(input: AssertInput, rulesets: readonly Ruleset[]) {
      return input.resources.some((resource) => configuredEffect(input.action, resource, rulesets) === "deny")
    }

    function relevant(input: AssertInput, rulesets: readonly Ruleset[]) {
      return rulesets.flat().filter((rule) => Wildcard.match(input.action, rule.action))
    }

    const evaluateInput = EffectRuntime.fnUntraced(function* (input: AssertInput) {
      const rulesets = yield* configured(input.sessionID, input.agent)
      if (denied(input, rulesets)) return { effect: "deny" as const, rules: relevant(input, rulesets) }
      const saved = yield* savedRules()
      const effects = input.resources.map((resource) => {
        const effect = configuredEffect(input.action, resource, rulesets)
        return effect === "ask" ? evaluate(input.action, resource, saved).effect : effect
      })
      const effect: Effect = effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow"
      return { effect, rules: [...rulesets.flat(), ...saved] }
    })

    function request(input: AssertInput): Request {
      return {
        id: input.id ?? ID.create(),
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        save: input.save,
        metadata: input.metadata,
        source: input.source,
      }
    }

    const create = (request: Request, agent?: AgentV2.ID) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const deferred = yield* Deferred.make<void, RejectedError | CorrectedError>()
          if (pending.size >= MAX_PENDING_REQUESTS) return yield* new CapacityError({ limit: MAX_PENDING_REQUESTS })
          const item = { request, agent, deferred }
          if (pending.has(request.id)) return yield* EffectRuntime.die(`Duplicate pending permission ID: ${request.id}`)
          pending.set(request.id, item)
          yield* events
            .publish(Event.Asked, request)
            .pipe(EffectRuntime.onError(() => EffectRuntime.sync(() => pending.delete(request.id))))
          return item
        }),
      )

    const ask = EffectRuntime.fn("PermissionV2.ask")(function* (input: AssertInput) {
      const result = yield* evaluateInput(input)
      const value = request(input)
      if (result.effect === "ask") yield* create(value, input.agent)
      return { id: value.id, effect: result.effect }
    })

    const assertCurrent = <E>(input: AssertInput, currentGuard: EffectRuntime.Effect<void, E>) =>
      EffectRuntime.uninterruptibleMask((restore) =>
        EffectRuntime.gen(function* () {
          yield* currentGuard
          const result = yield* evaluateInput(input)
          if (result.effect === "deny") {
            return yield* new DeniedError({
              rules: result.rules,
            })
          }
          if (result.effect === "allow") return
          const item = yield* create(request(input), input.agent)
          yield* restore(Deferred.await(item.deferred)).pipe(
            EffectRuntime.onInterrupt(() => EffectRuntime.gen(function* () {
              if (pending.get(item.request.id) !== item) return
              pending.delete(item.request.id)
              // This is the original wait being cancelled, not a user approval or effect grant.
              yield* events.publish(Event.Replied, {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "reject",
              }).pipe(EffectRuntime.catchCause((cause) => EffectRuntime.logError(
                "Permission cancellation projection failed", { cause },
              )))
            })),
            EffectRuntime.ensuring(
              EffectRuntime.sync(() => {
                if (pending.get(item.request.id) === item) pending.delete(item.request.id)
              }),
            ),
          )
          yield* currentGuard
          // Approval applies to this request, not a later hard-denied policy.
          const current = yield* evaluateInput(input)
          if (current.effect === "deny") return yield* new DeniedError({ rules: current.rules })
        }),
      )

    const assert = EffectRuntime.fn("PermissionV2.assert")((input: AssertInput) =>
      assertCurrent(
        input,
        GoalChildExecution.requireExecution(database.db, input.sessionID).pipe(
          EffectRuntime.andThen(() => WorkToolPolicy.requireCurrent(database.db, input.sessionID, { action: input.action, resources: input.resources })),
          EffectRuntime.orDie,
          EffectRuntime.asVoid,
        ),
      ),
    )
    const authorizeAction = EffectRuntime.fn("PermissionV2.authorizeAction")(function* (input: AssertInput) {
      if (!actionLifetime.active) return yield* new DeniedError({ rules: [] })
      const frozen = structuredClone(input)
      yield* assert(frozen)
      const current = yield* evaluateInput(frozen)
      if (current.effect === "deny") return yield* new DeniedError({ rules: current.rules })
      const savedEpoch = (yield* saved.epoch(location.project.id)).epoch
      return yield* EffectRuntime.acquireRelease(
        EffectRuntime.sync(() => {
          const permit = Object.freeze({}) as ActionPermit
          actionPermits.set(permit, { input: CanonicalJson.stringify(frozen), rules: CanonicalJson.stringify(current.rules), savedEpoch })
          return permit
        }),
        (permit) => EffectRuntime.sync(() => { actionPermits.delete(permit) }),
      )
    })
    const checkAction = EffectRuntime.fn("PermissionV2.checkAction")(function* (permit: ActionPermit, input: AssertInput) {
      const prior = actionPermits.get(permit)
      if (!actionLifetime.active || !prior || prior.input !== CanonicalJson.stringify(input)) return yield* new DeniedError({ rules: [] })
      yield* GoalChildExecution.requireExecution(database.db, input.sessionID).pipe(EffectRuntime.orDie)
      yield* WorkToolPolicy.requireCurrent(database.db, input.sessionID, { action: input.action, resources: input.resources }).pipe(EffectRuntime.orDie)
      const current = yield* evaluateInput(input)
      if (current.effect === "deny" || prior.rules !== CanonicalJson.stringify(current.rules) ||
        prior.savedEpoch !== (yield* saved.epoch(location.project.id)).epoch)
        return yield* new DeniedError({ rules: current.rules })
    })
    const captureAppAction = EffectRuntime.fn("PermissionV2.captureAppAction")(function* (permit: ActionPermit, input: AssertInput) {
      if (input.source?.type !== "mcp_app" || input.action !== "mcp" || input.resources.length !== 1 ||
        input.resources[0] !== `${input.source.server}:${input.source.tool}` || !agents.snapshot)
        return yield* new DeniedError({ rules: [] })
      const frozen = structuredClone(input)
      const snapshot = yield* agents.snapshot(input.agent).pipe(EffectRuntime.mapError(() => new DeniedError({ rules: [] })))
      yield* checkAction(permit, frozen)
      if ((yield* WorkAuthority.lookupSession(database.db, input.sessionID).pipe(EffectRuntime.orDie)).kind !== "ordinary" ||
        (yield* GoalChild.owner(database.db, input.sessionID).pipe(EffectRuntime.orDie))) return yield* new DeniedError({ rules: [] })
      const prior = actionPermits.get(permit)
      const raw = yield* database.db.select({ permission: sql<string | null>`${SessionTable.permission}`, epoch: SessionTable.mutation_epoch,
        agent: SessionTable.agent, savedEpoch: PermissionSavedEpochTable.epoch }).from(SessionTable)
        .innerJoin(PermissionSavedEpochTable, eq(PermissionSavedEpochTable.project_id, SessionTable.project_id))
        .where(eq(SessionTable.id, input.sessionID)).get().pipe(EffectRuntime.orDie)
      if (!raw || !prior || raw.savedEpoch !== prior.savedEpoch || !AgentV2.snapshotView(snapshot)) return yield* new DeniedError({ rules: [] })
      const current = () => actionLifetime.active && actionPermits.get(permit) === prior && prior.input === CanonicalJson.stringify(frozen) && AgentV2.snapshotView(snapshot) !== undefined
      const check = EffectRuntime.gen(function* () {
        if (!current()) return yield* new DeniedError({ rules: [] })
        yield* GoalChildExecution.requireExecution(database.db, frozen.sessionID).pipe(EffectRuntime.orDie)
        yield* WorkToolPolicy.requireCurrent(database.db, frozen.sessionID, { action: frozen.action, resources: frozen.resources }).pipe(EffectRuntime.orDie)
        const found = yield* database.db.select({ id: SessionTable.id }).from(SessionTable)
          .innerJoin(PermissionSavedEpochTable, eq(PermissionSavedEpochTable.project_id, SessionTable.project_id))
          .where(and(eq(SessionTable.id, frozen.sessionID), eq(SessionTable.project_id, location.project.id), eq(SessionTable.directory, location.directory),
            isNull(SessionTable.workspace_id), eq(SessionTable.v2_authority, true), isNull(SessionTable.time_archived),
            eq(SessionTable.mutation_epoch, raw.epoch), sql`${SessionTable.agent} IS ${raw.agent}`, sql`${SessionTable.permission} IS ${raw.permission}`,
            eq(PermissionSavedEpochTable.epoch, raw.savedEpoch))).get().pipe(EffectRuntime.orDie)
        if (!found || !current()) return yield* new DeniedError({ rules: [] })
      })
      return yield* EffectRuntime.acquireRelease(EffectRuntime.sync(() => {
        const token = Object.freeze({}) as AppAction
        const view = AgentV2.snapshotView(snapshot)!
        appActions.set(token, { current, check, receipt: Object.freeze({ version: 1, source: structuredClone(input.source) as typeof McpAppInvocationSchema.PermissionSource.Type,
          sessionPermissionHash: Hash.sha256(raw.permission ?? "null"), savedEpoch: raw.savedEpoch,
          agentInstanceID: view.instanceID, agentGeneration: view.generation,
          agentPermissionsHash: Hash.sha256(CanonicalJson.stringify(view.info.permissions)) }) })
        return token
      }), (token) => EffectRuntime.sync(() => { appActions.delete(token) }))
    })
    const captureFileActions = EffectRuntime.fn("PermissionV2.captureFileActions")(function* (browser: ActionPair, file: ActionPair) {
      if (browser.input.action !== "browser" || file.input.action !== "browser-file" ||
        CanonicalJson.stringify({ ...file.input, action: "browser" }) !== CanonicalJson.stringify(browser.input))
        return yield* new DeniedError({ rules: [] })
      const snapshot = agents.snapshot
        ? yield* agents.snapshot(browser.input.agent).pipe(EffectRuntime.catchTag("AgentV2.NotFoundError", () => EffectRuntime.succeed(undefined)))
        : undefined
      yield* checkAction(browser.permit, browser.input)
      yield* checkAction(file.permit, file.input)
      // Managed/ancestor classification remains current at every leaf. Its owned witnesses
      // and parent policy are deliberately not reduced to this ordinary-file snapshot.
      if (!snapshot || (yield* GoalChild.owner(database.db, browser.input.sessionID).pipe(EffectRuntime.orDie)) ||
        (yield* WorkAuthority.lookupSession(database.db, browser.input.sessionID).pipe(EffectRuntime.orDie)).kind !== "ordinary") return undefined
      const browserPrior = actionPermits.get(browser.permit)
      const filePrior = actionPermits.get(file.permit)
      const raw = yield* database.db.select({ permissionRaw: sql<string | null>`${SessionTable.permission}`,
        savedEpoch: PermissionSavedEpochTable.epoch }).from(SessionTable)
        .innerJoin(PermissionSavedEpochTable, eq(PermissionSavedEpochTable.project_id, SessionTable.project_id))
        .where(eq(SessionTable.id, browser.input.sessionID)).get().pipe(EffectRuntime.orDie)
      if (!raw || !browserPrior || !filePrior || browserPrior.savedEpoch !== raw.savedEpoch || filePrior.savedEpoch !== raw.savedEpoch ||
        !AgentV2.snapshotView(snapshot)) return yield* new DeniedError({ rules: [] })
      const token = Object.freeze({}) as FileActions
      fileActions.set(token, { view: Object.freeze({ sessionID: browser.input.sessionID, projectID: location.project.id,
        directory: location.directory, workspaceID: location.workspaceID,
        permissionRaw: raw.permissionRaw, savedEpoch: raw.savedEpoch }), current: () =>
          actionLifetime.active && actionPermits.get(browser.permit) === browserPrior && actionPermits.get(file.permit) === filePrior &&
          browserPrior.input === CanonicalJson.stringify(browser.input) && filePrior.input === CanonicalJson.stringify(file.input) &&
          AgentV2.snapshotView(snapshot) !== undefined })
      return token
    })
    const prepareGoalScratch = EffectRuntime.fn("PermissionV2.prepareGoalScratch")(function* (input: {
      unitID: string
      policy: GoalChildPolicy.Snapshot
    }) {
      const current = GoalChildPolicy.requirePreparation(database.db, input.unitID, input.policy)
      const before = yield* current
      const request = {
        sessionID: SessionSchema.ID.make(before.row.child_session_id),
        agent: AgentV2.ID.make(before.row.binding.agent),
        action: "plan",
        resources: [before.scratch.documentID],
        save: [before.scratch.documentID],
      }
      yield* assertCurrent(request, current.pipe(EffectRuntime.asVoid))
      return yield* database.db
        .transaction(
          (tx) =>
            EffectRuntime.gen(function* () {
              const source = yield* GoalChildPolicy.requirePreparation(tx, input.unitID, input.policy)
              const observed = yield* EffectRuntime.try({
                try: () =>
                  DocumentStore.openExactForCreate(DeepAgentPlanStore.planStoreRoot(source.row.child_session_id), [
                    source.scratch.documentID,
                  ]).projectExact(source.payload, null),
                catch: () =>
                  new GoalChildSchema.Error({
                    code: "GOAL_CHILD_CONFLICT",
                    message: "Scratch file has different or unconfirmed complete bytes",
                  }),
              })
              const receipt = {
                payloadHash: source.scratch.payloadHash,
                version: observed.version,
                hash: observed.hash.slice(7),
              }
              if (source.input.scratch) {
                if (GoalControl.fingerprint(source.input.scratch) !== GoalControl.fingerprint(receipt))
                  return yield* new GoalChildSchema.Error({
                    code: "GOAL_CHILD_CONFLICT",
                    message: "Scratch confirmation changed",
                  })
                return receipt
              }
              const changed = yield* tx
                .update(GoalChildUnitTable)
                .set({
                  inputs: source.row.inputs.map((item) =>
                    item.inputID === source.input.inputID ? { ...item, scratch: receipt } : item,
                  ),
                  updated_at: Date.now(),
                })
                .where(eq(GoalChildUnitTable.unit_id, input.unitID))
                .returning({ id: GoalChildUnitTable.unit_id })
                .all()
                .pipe(EffectRuntime.orDie)
              if (changed.length !== 1)
                return yield* new GoalChildSchema.Error({
                  code: "GOAL_CHILD_CONFLICT",
                  message: "Scratch confirmation lost its exact child",
                })
              return receipt
            }),
          { behavior: "immediate" },
        )
        .pipe(
          EffectRuntime.mapError((error) =>
            error instanceof GoalChildSchema.Error
              ? error
              : new GoalChildSchema.Error({
                  code: "GOAL_CHILD_UNAVAILABLE",
                  message: "Scratch confirmation could not be committed",
                }),
          ),
        )
    })

    const reply = EffectRuntime.fn("PermissionV2.reply")((input: ReplyInput) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) {
            const durable = yield* DeepAgentActivityAuthority.permissionRequestForRequest(input.requestID).pipe(
              EffectRuntime.provideService(Database.Service, database),
            )
            if (
              !durable ||
              durable.activityKind !== "v2" ||
              durable.requestKind !== "no_progress" ||
              durable.projectID !== location.project.id ||
              durable.workspaceID !== location.workspaceID
            )
              return yield* new NotFoundError({ requestID: input.requestID })
            const decision =
              input.reply === "once" ? "approved_once" : input.reply === "always" ? "approved_always" : "interrupted"
            yield* DeepAgentActivityAuthority.decidePermission({
              requestID: input.requestID,
              idempotencyKey: `v2-no-progress-decision:${input.requestID}:${decision}`,
              decision,
              actorType: "user",
              actorID: "permission-ui",
              ...(input.message ? { feedback: input.message } : {}),
            }).pipe(
              EffectRuntime.provideService(Database.Service, database),
              EffectRuntime.catchTags({
                "ActivityAuthority.ConflictError": () => new NotFoundError({ requestID: input.requestID }),
                "ActivityAuthority.InvalidInputError": () => new NotFoundError({ requestID: input.requestID }),
              }),
            )
            if (decision === "approved_once")
              yield* DeepAgentActivityAuthority.consumeOnce({
                requestID: input.requestID,
                consumerID: `v2-no-progress:${durable.activityID}`,
                idempotencyKey: `v2-no-progress-consumption:${input.requestID}`,
              }).pipe(
                EffectRuntime.provideService(Database.Service, database),
                EffectRuntime.catchTag(
                  "ActivityAuthority.ConflictError",
                  () => new NotFoundError({ requestID: input.requestID }),
                ),
              )
            const eventID = EventV2.ID.make(`evt_v2_permission_replied_${input.requestID}`)
            yield* events.publish(
              Event.Replied,
              {
                sessionID: durable.sessionID,
                requestID: input.requestID,
                reply: input.reply,
              },
              { id: eventID },
            )
            return
          }
          if (input.reply !== "reject") {
            const managed = yield* GoalChild.owner(database.db, existing.request.sessionID).pipe(EffectRuntime.orDie)
            if (managed?.binding.version === 2 || managed?.binding.version === 3) {
              const current = yield* configured(existing.request.sessionID, existing.agent).pipe(EffectRuntime.exit)
              if (current._tag === "Failure" && Cause.hasInterrupts(current.cause))
                return yield* EffectRuntime.failCause(current.cause).pipe(EffectRuntime.orDie)
              if (current._tag === "Failure" || denied(existing.request, current.value)) {
                yield* Deferred.fail(existing.deferred, new RejectedError())
                pending.delete(input.requestID)
                return yield* new NotFoundError({ requestID: input.requestID })
              }
            }
          }
          yield* events.publish(Event.Replied, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
            reply: input.reply,
          })

          if (input.reply === "reject") {
            yield* Deferred.fail(
              existing.deferred,
              input.message ? new CorrectedError({ feedback: input.message }) : new RejectedError(),
            )
            pending.delete(input.requestID)
            for (const [id, item] of pending) {
              if (item.request.sessionID !== existing.request.sessionID) continue
              yield* events.publish(Event.Replied, {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "reject",
              })
              yield* Deferred.fail(item.deferred, new RejectedError())
              pending.delete(id)
            }
            return
          }

          if (input.reply === "always" && existing.request.save?.length) {
            yield* saved.add({
              projectID: location.project.id,
              action: existing.request.action,
              resources: existing.request.save,
            })
          }
          yield* Deferred.succeed(existing.deferred, undefined)
          pending.delete(input.requestID)
          if (input.reply !== "always" || !existing.request.save?.length) return

          const rememberedRules = yield* savedRules()
          for (const [id, item] of pending) {
            const input = { ...item.request }
            const managed = yield* GoalChild.owner(database.db, item.request.sessionID).pipe(EffectRuntime.orDie)
            const rulesets = yield* configured(item.request.sessionID, item.agent).pipe(
              managed?.binding.version === 2 || managed?.binding.version === 3
                ? EffectRuntime.catchCause((cause) =>
                    Cause.hasInterrupts(cause)
                      ? EffectRuntime.failCause(cause).pipe(EffectRuntime.orDie)
                      : EffectRuntime.succeed(undefined),
                  )
                : EffectRuntime.catchTag("Session.NotFoundError", () => EffectRuntime.succeed(undefined)),
            )
            if (!rulesets || denied(input, rulesets)) continue
            if (managed?.binding.version === 2 || managed?.binding.version === 3) {
              if (
                !item.request.resources.every((resource) => {
                  const current = configuredEffect(item.request.action, resource, rulesets)
                  return (
                    current === "allow" ||
                    (current === "ask" && evaluate(item.request.action, resource, rememberedRules).effect === "allow")
                  )
                })
              )
                continue
            }
            const effective = [...rulesets.flat(), ...rememberedRules]
            if (
              managed?.binding.version !== 2 &&
              managed?.binding.version !== 3 &&
              !item.request.resources.every(
                (resource) => evaluate(item.request.action, resource, effective).effect === "allow",
              )
            )
              continue
            yield* events.publish(Event.Replied, {
              sessionID: item.request.sessionID,
              requestID: item.request.id,
              reply: "always",
            })
            yield* Deferred.succeed(item.deferred, undefined)
            pending.delete(id)
          }
        }),
      ),
    )

    const list = EffectRuntime.fn("PermissionV2.list")(function* () {
      const durable = yield* database.db
        .select()
        .from(SessionActivityPermissionRequestTable)
        .where(
          and(
            eq(SessionActivityPermissionRequestTable.activity_kind, "v2"),
            eq(SessionActivityPermissionRequestTable.request_kind, "no_progress"),
            eq(SessionActivityPermissionRequestTable.state, "pending"),
            eq(SessionActivityPermissionRequestTable.project_id, location.project.id),
            location.workspaceID
              ? eq(SessionActivityPermissionRequestTable.workspace_id, location.workspaceID)
              : isNull(SessionActivityPermissionRequestTable.workspace_id),
          ),
        )
        .all()
        .pipe(EffectRuntime.orDie)
      return [
        ...Array.from(pending.values(), (item) => item.request),
        ...durable.map(
          (row): Request => ({
            id: ID.make(row.request_id),
            sessionID: row.session_id,
            action: row.permission,
            resources: [...row.patterns],
            save: [...row.always_patterns],
            metadata: { activity_id: row.activity_id, authority_epoch: row.authority_epoch, kind: "no_progress" },
          }),
        ),
      ]
    })

    const get = EffectRuntime.fn("PermissionV2.get")(function* (id: ID) {
      const local = pending.get(id)?.request
      if (local) return local
      const row = yield* database.db
        .select()
        .from(SessionActivityPermissionRequestTable)
        .where(
          and(
            eq(SessionActivityPermissionRequestTable.request_id, id),
            eq(SessionActivityPermissionRequestTable.activity_kind, "v2"),
            eq(SessionActivityPermissionRequestTable.request_kind, "no_progress"),
            eq(SessionActivityPermissionRequestTable.project_id, location.project.id),
            location.workspaceID
              ? eq(SessionActivityPermissionRequestTable.workspace_id, location.workspaceID)
              : isNull(SessionActivityPermissionRequestTable.workspace_id),
          ),
        )
        .get()
        .pipe(EffectRuntime.orDie)
      if (!row) return undefined
      return {
        id,
        sessionID: row.session_id,
        action: row.permission,
        resources: [...row.patterns],
        save: [...row.always_patterns],
        metadata: { activity_id: row.activity_id, authority_epoch: row.authority_epoch, kind: "no_progress" },
      } satisfies Request
    })

    const forSession = EffectRuntime.fn("PermissionV2.forSession")(function* (sessionID: SessionSchema.ID) {
      return (yield* list()).filter((request) => request.sessionID === sessionID)
    })

    return Service.of({
      currentNoProgressOwnerID: () => withNoProgressOwner(Ref.get(noProgressOwner)),
      ask,
      assert,
      authorizeAction,
      checkAction,
      captureAppAction,
      captureFileActions,
      prepareGoalScratch,
      reply,
      get,
      forSession,
      list,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [EventV2.node, Location.node, AgentV2.node, SessionStore.node, PermissionSaved.node, Database.node],
})

export const locationLayer = layer.pipe(Layer.provideMerge(AgentV2.locationLayer))
