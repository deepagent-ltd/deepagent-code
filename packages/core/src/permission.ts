export * as PermissionV2 from "./permission"

import { ToolFailure } from "@deepagent-code/llm"
import { Context, Deferred, Duration, Effect as EffectRuntime, Layer, Schedule, Schema } from "effect"
import { and, eq, isNull } from "drizzle-orm"
import { Database } from "./database/database"
import { DeepAgentActivityAuthority } from "./deepagent/activity-authority"
import { SessionActivityPermissionRequestTable } from "./deepagent/activity-authority.sql"
import { makeLocationNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { Location } from "./location"
import { AgentV2 } from "./agent"
import { SessionNotFound } from "./session/error"
import { SessionSchema } from "./session/schema"
import { SessionStore } from "./session/store"
import { withStatics } from "./schema"
import { Identifier } from "./util/identifier"
import { Wildcard } from "./util/wildcard"
import { PermissionSchema } from "./permission/schema"
import { PermissionSaved } from "./permission/saved"

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
export const noProgressOwnerID = `v2-no-progress:${Identifier.ascending()}`

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

export interface Interface {
  readonly ask: (input: AssertInput) => EffectRuntime.Effect<AskResult, SessionNotFound.Error | CapacityError>
  readonly assert: (input: AssertInput) => EffectRuntime.Effect<void, Error | SessionNotFound.Error>
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
    const pending = new Map<ID, Pending>()
    const recoverPermissions = EffectRuntime.gen(function* () {
      yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({ ownerID: noProgressOwnerID, leaseMs: 30_000 })
      // An abandoned external effect must be quarantined before its permission is settled;
      // recovery otherwise crosses the activity terminal fence and can leave the ask stranded.
      yield* DeepAgentActivityAuthority.recoverPermissionEffects(noProgressOwnerID)
      yield* DeepAgentActivityAuthority.recoverPendingPermissions(noProgressOwnerID)
    }).pipe(EffectRuntime.provideService(Database.Service, database))
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
      return [agent?.permissions ?? missingAgentPermissions, session.permissions] as const
    })

    function configuredEffect(action: string, resource: string, rulesets: readonly Ruleset[]): Effect {
      const rules = rulesets
        .map((rules) => rules.findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)))
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

    const assert = EffectRuntime.fn("PermissionV2.assert")((input: AssertInput) =>
      EffectRuntime.uninterruptibleMask((restore) =>
        EffectRuntime.gen(function* () {
          const result = yield* evaluateInput(input)
          if (result.effect === "deny") {
            return yield* new DeniedError({
              rules: result.rules,
            })
          }
          if (result.effect === "allow") return
          const item = yield* create(request(input), input.agent)
          return yield* restore(Deferred.await(item.deferred)).pipe(
            EffectRuntime.ensuring(
              EffectRuntime.sync(() => {
                pending.delete(item.request.id)
              }),
            ),
          )
        }),
      ),
    )

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
                EffectRuntime.catchTag("ActivityAuthority.ConflictError", () => new NotFoundError({ requestID: input.requestID })),
              )
            if (durable.state === "pending")
              yield* events.publish(Event.Replied, {
                sessionID: durable.sessionID,
                requestID: input.requestID,
                reply: input.reply,
              })
            return
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
            const rulesets = yield* configured(item.request.sessionID, item.agent).pipe(
              EffectRuntime.catchTag("Session.NotFoundError", () => EffectRuntime.succeed(undefined)),
            )
            if (!rulesets) continue
            if (denied(input, rulesets)) continue
            const effective = [...rulesets.flat(), ...rememberedRules]
            if (
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
        .where(and(
          eq(SessionActivityPermissionRequestTable.activity_kind, "v2"),
          eq(SessionActivityPermissionRequestTable.request_kind, "no_progress"),
          eq(SessionActivityPermissionRequestTable.state, "pending"),
          eq(SessionActivityPermissionRequestTable.project_id, location.project.id),
          location.workspaceID
            ? eq(SessionActivityPermissionRequestTable.workspace_id, location.workspaceID)
            : isNull(SessionActivityPermissionRequestTable.workspace_id),
        ))
        .all()
        .pipe(EffectRuntime.orDie)
      return [...Array.from(pending.values(), (item) => item.request), ...durable.map((row): Request => ({
        id: ID.make(row.request_id),
        sessionID: row.session_id,
        action: row.permission,
        resources: [...row.patterns],
        save: [...row.always_patterns],
        metadata: { activity_id: row.activity_id, authority_epoch: row.authority_epoch, kind: "no_progress" },
      }))]
    })

    const get = EffectRuntime.fn("PermissionV2.get")(function* (id: ID) {
      const local = pending.get(id)?.request
      if (local) return local
      const row = yield* database.db
        .select()
        .from(SessionActivityPermissionRequestTable)
        .where(and(
          eq(SessionActivityPermissionRequestTable.request_id, id),
          eq(SessionActivityPermissionRequestTable.activity_kind, "v2"),
          eq(SessionActivityPermissionRequestTable.request_kind, "no_progress"),
          eq(SessionActivityPermissionRequestTable.project_id, location.project.id),
          location.workspaceID
            ? eq(SessionActivityPermissionRequestTable.workspace_id, location.workspaceID)
            : isNull(SessionActivityPermissionRequestTable.workspace_id),
        ))
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

    return Service.of({ ask, assert, reply, get, forSession, list })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [EventV2.node, Location.node, AgentV2.node, SessionStore.node, PermissionSaved.node, Database.node],
})

export const locationLayer = layer.pipe(Layer.provideMerge(AgentV2.locationLayer))
