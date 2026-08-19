import { ConfigPermissionV1 } from "@deepagent-code/core/v1/config/permission"
import { DeepAgentActivityAuthority } from "@deepagent-code/core/deepagent/index"
import { Database } from "@deepagent-code/core/database/database"
import { PermissionTable } from "@deepagent-code/core/permission/sql"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Log from "@deepagent-code/core/util/log"
import { Wildcard } from "@deepagent-code/core/util/wildcard"
import { Deferred, Duration, Effect, Exit, Layer, Context, Option, Ref, Schedule, Semaphore } from "effect"
import { eq } from "drizzle-orm"
import os from "os"
import { PermissionV1 } from "@deepagent-code/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@deepagent-code/core/event"
import { EventRouteRef, type EventRoute } from "@/effect/instance-ref"
import { FSUtil } from "@deepagent-code/core/fs-util"
import type { InstanceContext } from "@/project/instance-context"
import { SessionActivityOwner } from "@/session/activity-owner"
import { SessionPromptIntent } from "@/session/prompt-intent"

const log = Log.create({ service: "permission" })
const permissionOwnerLeaseMs = 30_000
const permissionOwnerHeartbeatMs = 10_000
const permissionDecisionPollMs = 50

type LayerOptions = {
  readonly ownerLeaseMs?: number
  readonly ownerHeartbeatMs?: number
}

export const Event = {
  Asked: EventV2.define({ type: "permission.asked", schema: PermissionV1.Request.fields }),
  Replied: EventV2.define({
    type: "permission.replied",
    schema: {
      sessionID: PermissionV1.Request.fields.sessionID,
      requestID: PermissionV1.ID,
      reply: PermissionV1.Reply,
    },
  }),
}

export type AskInput = PermissionV1.AskInput & {
  timeoutMs?: number
  effectToolName?: string
}

export type EffectGrant = DeepAgentActivityAuthority.PermissionEffectDispatch

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly askEffect?: (input: AskInput) => Effect.Effect<EffectGrant | undefined, PermissionV1.Error>
  readonly effectsForToolCall?: (input: {
    readonly sessionID: string
    readonly toolMessageID: string
    readonly toolCallID: string
    readonly toolName: string
  }) => Effect.Effect<readonly EffectGrant[]>
  readonly settleEffect?: (input: {
    readonly grant: EffectGrant
    readonly outcome: "success" | "failure"
    readonly result: unknown
  }) => Effect.Effect<EffectGrant>
  readonly rotateOwner?: () => Effect.Effect<DeepAgentActivityAuthority.PermissionOwnerRotation>
  readonly rotateOwnerIfCurrent?: (
    expectedOwnerID: string,
  ) => Effect.Effect<DeepAgentActivityAuthority.PermissionOwnerRotation | undefined>
  readonly recoverActivity?: (input: {
    readonly activityID: string
    readonly expectedVersion: number
    readonly terminalReason: string
  }) => Effect.Effect<boolean>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
}

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
  owner: State
  origin: InstanceContext
  route: EventRoute
  settling: boolean
  pendingSettlement?: {
    reply: PermissionV1.Reply | "interrupted" | "expired"
    message?: string
  }
  durable?: {
    requestKind: "tool" | "no_progress"
  }
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
}

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

export function evaluateDurable(
  permission: string,
  pattern: string,
  ruleset: PermissionV1.Ruleset,
  approved: PermissionV1.Ruleset,
  saved: PermissionV1.Ruleset,
): PermissionV1.Rule {
  const policy = evaluate(permission, pattern, ruleset)
  if (policy.action === "deny") return policy
  return evaluate(permission, pattern, ruleset, approved, saved)
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/Permission") {}

export const layerWith = (options: LayerOptions = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const database = yield* Database.Service
      const flags = yield* RuntimeFlags.Service
      const permissionOwner = yield* Ref.make(
        `${SessionActivityOwner.processOwnerToken}:permission:${crypto.randomUUID()}`,
      )
      const withPermissionOwner = Semaphore.makeUnsafe(1).withPermit
      const permissionOwnerID = () => Ref.get(permissionOwner)
      const ownerLeaseMs = options.ownerLeaseMs ?? permissionOwnerLeaseMs
      const ownerHeartbeatMs = options.ownerHeartbeatMs ?? permissionOwnerHeartbeatMs
      const rotatePermissionOwner = Effect.fn("Permission.rotatePermissionOwner")(function* (previousOwnerID: string) {
        const ownerID = `${SessionActivityOwner.processOwnerToken}:permission:${crypto.randomUUID()}`
        const rotated = yield* DeepAgentActivityAuthority.rotatePermissionOwner({
          previousOwnerID,
          ownerID,
          leaseMs: ownerLeaseMs,
        }).pipe(Effect.provideService(Database.Service, database), Effect.orDie)
        yield* Ref.set(permissionOwner, ownerID)
        return rotated
      })
      const rotateOwner = Effect.fn("Permission.rotateOwner")(function* () {
        if (flags.activityAuthority !== "durable")
          return yield* Effect.die(new Error("durable permission authority is unavailable"))
        return yield* withPermissionOwner(permissionOwnerID().pipe(Effect.flatMap(rotatePermissionOwner)))
      })
      const rotateOwnerIfCurrent = Effect.fn("Permission.rotateOwnerIfCurrent")(function* (expectedOwnerID: string) {
        if (flags.activityAuthority !== "durable")
          return yield* Effect.die(new Error("durable permission authority is unavailable"))
        return yield* withPermissionOwner(
          permissionOwnerID().pipe(
            Effect.flatMap((ownerID) =>
              ownerID === expectedOwnerID ? rotatePermissionOwner(ownerID) : Effect.succeed(undefined),
            ),
          ),
        )
      })
      if (flags.activityAuthority === "durable") {
        yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({
          ownerID: yield* permissionOwnerID(),
          leaseMs: ownerLeaseMs,
        }).pipe(Effect.provideService(Database.Service, database), Effect.orDie)
        yield* Effect.addFinalizer(() =>
          permissionOwnerID().pipe(
            Effect.flatMap((ownerID) => DeepAgentActivityAuthority.releasePermissionOwner(ownerID)),
            withPermissionOwner,
            Effect.provideService(Database.Service, database),
            Effect.orDie,
          ),
        )
      }
      const allPending = new Map<PermissionV1.ID, PendingEntry>()
      const claimPending = (id: PermissionV1.ID, entry: PendingEntry) => {
        if (allPending.get(id) !== entry || entry.settling) return false
        entry.settling = true
        return true
      }
      const finishPending = (id: PermissionV1.ID, entry: PendingEntry) => {
        if (allPending.get(id) !== entry) return
        entry.pendingSettlement = undefined
        allPending.delete(id)
        entry.owner.pending.delete(id)
      }
      const visibleFrom = (entry: PendingEntry, directory: string, workspaceID: string | undefined) =>
        entry.route.workspaceID === workspaceID &&
        (FSUtil.resolve(entry.origin.directory) === FSUtil.resolve(directory) ||
          FSUtil.resolve(entry.route.directory) === FSUtil.resolve(directory))
      const publishReply = (entry: PendingEntry, reply: PermissionV1.Reply) =>
        events
          .publish(Event.Replied, {
            sessionID: entry.info.sessionID,
            requestID: entry.info.id,
            reply,
          })
          .pipe(Effect.provideService(EventRouteRef, entry.route))
      const state = yield* InstanceState.make<State>(
        Effect.fn("Permission.state")(function* () {
          const state = {
            pending: new Map<PermissionV1.ID, PendingEntry>(),
            approved: [],
          }

          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              for (const [id, item] of state.pending) {
                if (!claimPending(id, item)) continue
                if (item.pendingSettlement) {
                  yield* settleClaimed(item, item.pendingSettlement.reply, item.pendingSettlement.message)
                  continue
                }
                yield* settleClaimed(item, "interrupted")
              }
              state.pending.clear()
            }),
          )

          return state
        }),
      )

      if (flags.activityAuthority === "durable") {
        const heartbeat = withPermissionOwner(
          Effect.gen(function* () {
            const ownerID = yield* permissionOwnerID()
            yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({
              ownerID,
              leaseMs: ownerLeaseMs,
            }).pipe(
              Effect.provideService(Database.Service, database),
              Effect.catchTag("ActivityAuthority.ConflictError", () =>
                rotatePermissionOwner(ownerID).pipe(Effect.asVoid),
              ),
            )
            const recoveryOwnerID = yield* permissionOwnerID()
            yield* DeepAgentActivityAuthority.recoverPendingPermissions(recoveryOwnerID).pipe(
              Effect.provideService(Database.Service, database),
            )
            yield* DeepAgentActivityAuthority.recoverPermissionEffects(recoveryOwnerID).pipe(
              Effect.provideService(Database.Service, database),
            )
          }),
        )
        yield* heartbeat.pipe(Effect.orDie)
        yield* heartbeat.pipe(
          Effect.catchCause((cause) => Effect.logError("permission owner heartbeat failed", { cause })),
          Effect.repeat(Schedule.fixed(Duration.millis(ownerHeartbeatMs))),
          Effect.forkScoped,
        )
      }

      const durableRules = Effect.fn("Permission.durableRules")(function* (
        sessionID: PermissionV1.Request["sessionID"],
      ) {
        if (flags.activityAuthority !== "durable") return [] as PermissionV1.Rule[]
        const owner = yield* database.db
          .select({ projectID: SessionTable.project_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!owner) return [] as PermissionV1.Rule[]
        return yield* database.db
          .select({ permission: PermissionTable.action, pattern: PermissionTable.resource })
          .from(PermissionTable)
          .where(eq(PermissionTable.project_id, owner.projectID))
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows.map((row) => ({ ...row, action: "allow" as const }))),
          )
      })

      const decideDurable = (
        entry: PendingEntry,
        reply: PermissionV1.Reply | "interrupted" | "expired",
        message?: string,
      ) => {
        const decision =
          reply === "once"
            ? ("approved_once" as const)
            : reply === "always"
              ? ("approved_always" as const)
              : reply === "expired"
                ? ("expired" as const)
                : reply === "interrupted"
                  ? ("interrupted" as const)
                  : entry.durable?.requestKind === "no_progress"
                    ? ("interrupted" as const)
                    : ("denied" as const)
        if (!entry.durable) return Effect.succeed({ decision, ...(message ? { feedback: message } : {}) })
        return Effect.gen(function* () {
          const fanout = reply === "always" ? ("always" as const) : reply === "reject" ? ("reject" as const) : undefined
          const actorType = reply === "interrupted" || reply === "expired" ? ("system" as const) : ("user" as const)
          const actorID = reply === "interrupted" || reply === "expired" ? yield* permissionOwnerID() : "permission-ui"
          const attempted = yield* (
            fanout
              ? DeepAgentActivityAuthority.decidePermissionWithFanout({
                  requestID: entry.info.id,
                  idempotencyKey: `permission-decision:${entry.info.id}:${decision}:fanout:${fanout}`,
                  decision,
                  sessionFanout: fanout,
                  actorType,
                  actorID,
                  ...(message ? { feedback: message } : {}),
                })
              : DeepAgentActivityAuthority.decidePermission({
                  requestID: entry.info.id,
                  idempotencyKey: `permission-decision:${entry.info.id}:${decision}`,
                  decision,
                  actorType,
                  actorID,
                  ...(message ? { feedback: message } : {}),
                })
          ).pipe(Effect.provideService(Database.Service, database), Effect.exit)
          const stored = Exit.isSuccess(attempted)
            ? attempted.value
            : yield* DeepAgentActivityAuthority.permissionDecisionForRequest(entry.info.id).pipe(
                Effect.provideService(Database.Service, database),
              )
          if (!stored) {
            if (Exit.isFailure(attempted)) return yield* Effect.failCause(attempted.cause)
            return yield* Effect.die(new Error("durable permission decision disappeared: " + entry.info.id))
          }
          const adopted = yield* adoptDurableDecision(entry, stored.decision)
          return { decision: adopted, ...(stored.feedback ? { feedback: stored.feedback } : {}) }
        })
      }

      const adoptDurableDecision = (
        entry: PendingEntry,
        decision: "approved_once" | "approved_always" | "denied" | "expired" | "interrupted",
      ) => {
        if (decision !== "approved_once" || entry.durable?.requestKind === "tool") return Effect.succeed(decision)
        return DeepAgentActivityAuthority.consumeOnce({
          requestID: entry.info.id,
          consumerID: permissionConsumerID(entry.info),
          idempotencyKey: `permission-consumption:${entry.info.id}`,
        }).pipe(Effect.provideService(Database.Service, database), Effect.as(decision))
      }

      const completeClaimed = Effect.fn("Permission.completeClaimed")(function* (
        entry: PendingEntry,
        decision: "approved_once" | "approved_always" | "denied" | "expired" | "interrupted" | undefined,
        message?: string,
      ) {
        finishPending(entry.info.id, entry)
        const reply = decision ? permissionReplyForDecision(decision) : "reject"
        if (reply === "once" || reply === "always") {
          if (reply === "always")
            entry.owner.approved.push(
              ...entry.info.always.map((pattern) => ({
                permission: entry.info.permission,
                pattern,
                action: "allow" as const,
              })),
            )
          yield* Deferred.succeed(entry.deferred, undefined).pipe(Effect.ignore)
          yield* publishReply(entry, reply).pipe(Effect.exit)
          return reply
        }
        yield* Deferred.fail(
          entry.deferred,
          message && decision === "denied"
            ? new PermissionV1.CorrectedError({ feedback: message })
            : new PermissionV1.RejectedError(),
        ).pipe(Effect.ignore)
        yield* publishReply(entry, "reject").pipe(Effect.exit)
        return reply
      })

      const settleClaimed = Effect.fn("Permission.settleClaimed")(function* (
        entry: PendingEntry,
        reply: PermissionV1.Reply | "interrupted" | "expired",
        message?: string,
      ) {
        const outcome = yield* decideDurable(entry, reply, message).pipe(Effect.exit)
        if (Exit.isFailure(outcome)) {
          entry.pendingSettlement = { reply, ...(message ? { message } : {}) }
          entry.settling = false
          yield* Effect.logError("durable permission settlement failed", { cause: outcome.cause })
          return undefined
        }
        yield* completeClaimed(entry, outcome.value.decision, outcome.value.feedback)
        return outcome.value.decision
      })

      if (flags.activityAuthority === "durable") {
        const reconcileLocalDecisions = Effect.suspend(() =>
          Effect.forEach(
            Array.from(allPending.values()),
            (entry) =>
              Effect.gen(function* () {
                if (entry.settling) return
                const decision = yield* DeepAgentActivityAuthority.permissionDecisionForRequest(entry.info.id).pipe(
                  Effect.provideService(Database.Service, database),
                )
                if (!decision && entry.pendingSettlement && claimPending(entry.info.id, entry)) {
                  yield* settleClaimed(entry, entry.pendingSettlement.reply, entry.pendingSettlement.message)
                  return
                }
                if (!decision || !claimPending(entry.info.id, entry)) return
                const adopted = yield* adoptDurableDecision(entry, decision.decision).pipe(Effect.exit)
                if (Exit.isFailure(adopted)) {
                  entry.settling = false
                  return yield* Effect.failCause(adopted.cause)
                }
                yield* completeClaimed(entry, adopted.value, decision.feedback)
              }),
            { discard: true },
          ),
        )
        yield* reconcileLocalDecisions.pipe(
          Effect.catchCause((cause) => Effect.logError("permission decision reconciliation failed", { cause })),
          Effect.repeat(Schedule.fixed(Duration.millis(permissionDecisionPollMs))),
          Effect.forkScoped,
        )
      }

      const askEffect = Effect.fn("Permission.askEffect")(function* (input: AskInput) {
        const owner = yield* InstanceState.get(state)
        const origin = yield* InstanceState.context
        const workspaceID = yield* InstanceState.workspaceID
        const selectedRoute = (yield* EventRouteRef) ?? {
          ...origin,
          ...(workspaceID ? { workspaceID } : {}),
        }
        const routeWorkspaceID = selectedRoute.workspaceID ?? workspaceID
        const route = {
          ...selectedRoute,
          ...(routeWorkspaceID ? { workspaceID: routeWorkspaceID } : {}),
        }
        const { ruleset, timeoutMs, effectToolName, ...request } = input
        const savedRules = yield* durableRules(request.sessionID)
        const requestKind = request.permission === "doom_loop" && request.tool === undefined ? "no_progress" : "tool"
        let needsAsk = false

        for (const pattern of request.patterns) {
          const rule =
            flags.activityAuthority === "durable"
              ? evaluateDurable(request.permission, pattern, ruleset, owner.approved, savedRules)
              : evaluate(request.permission, pattern, ruleset, owner.approved)
          log.info("evaluated", { permission: request.permission, pattern, action: rule })
          if (rule.action === "deny") {
            return yield* new PermissionV1.DeniedError({
              ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
            })
          }
          if (rule.action === "allow") continue
          needsAsk = true
        }

        if (!needsAsk && flags.activityAuthority !== "durable") return

        const activity =
          flags.activityAuthority === "durable"
            ? yield* SessionPromptIntent.activeActivityForSession(request.sessionID).pipe(
                Effect.provideService(Database.Service, database),
              )
            : undefined
        if (flags.activityAuthority === "durable" && !activity) {
          // The durable authority records requests/decisions against an ADMITTED legacy activity.
          // A turn driven without one (direct legacy loop entry, recovery edge windows) must not be
          // hard-denied: fall back to policy-only semantics — allowed requests proceed unrecorded,
          // interactive requests settle through the in-memory pending path exactly like legacy mode.
          if (!needsAsk) return
        }
        if (flags.activityAuthority === "durable" && activity && requestKind === "tool" && !request.tool)
          return yield* new PermissionV1.DeniedError({
            ruleset: [{ permission: "activity_tool_identity", pattern: request.permission, action: "deny" }],
          })
        const id =
          request.id ??
          (activity
            ? PermissionV1.ID.make(
                `per_${Hash.sha256(
                  CanonicalJson.stringify({
                    activityID: activity.activityID,
                    requestKind,
                    permission: request.permission,
                    patterns: request.patterns,
                    tool: request.tool ?? null,
                    metadata: request.metadata,
                  }),
                ).slice(0, 48)}`,
              )
            : PermissionV1.ID.ascending())
        const info: PermissionV1.Request = {
          id,
          sessionID: request.sessionID,
          permission: request.permission,
          patterns: request.patterns,
          metadata: request.metadata,
          always: request.always,
          tool: request.tool,
        }
        const requestDurable = (alwaysPatterns: readonly string[]) =>
          activity
            ? permissionOwnerID().pipe(
                Effect.flatMap((ownerID) =>
                  DeepAgentActivityAuthority.requestPermission({
                    activityKind: "legacy",
                    activityID: activity.activityID,
                    requestID: id,
                    requestKind,
                    idempotencyKey: `permission-request:${id}`,
                    permission: info.permission,
                    patterns: info.patterns,
                    alwaysPatterns,
                    metadata: info.metadata,
                    ...(info.tool ? { tool: info.tool } : {}),
                    ownerID,
                    ...(routeWorkspaceID ? { workspaceID: routeWorkspaceID } : {}),
                    ...(timeoutMs === undefined ? {} : { expiresAt: Date.now() + Math.max(1, timeoutMs) }),
                  }),
                ),
                withPermissionOwner,
                Effect.provideService(Database.Service, database),
                Effect.orDie,
              )
            : Effect.void
        const beginEffect = () =>
          activity && info.tool && effectToolName
            ? permissionOwnerID().pipe(
                Effect.flatMap((ownerID) =>
                  DeepAgentActivityAuthority.beginPermissionEffect({
                    requestID: id,
                    toolName: effectToolName,
                    consumerID: permissionConsumerID(info),
                    idempotencyKey: `permission-effect:${id}`,
                    ownerID,
                  }),
                ),
                withPermissionOwner,
                Effect.provideService(Database.Service, database),
                Effect.orDie,
              )
            : Effect.succeed(undefined)
        if (!needsAsk) {
          yield* requestDurable(info.always)
          const existing = yield* DeepAgentActivityAuthority.permissionDecisionForRequest(id).pipe(
            Effect.provideService(Database.Service, database),
          )
          const decision =
            existing ??
            (yield* DeepAgentActivityAuthority.decidePermission({
              requestID: id,
              idempotencyKey: `permission-policy:${id}:approved_once`,
              decision: "approved_once",
              actorType: "system",
              actorID: "permission-policy",
            }).pipe(Effect.provideService(Database.Service, database), Effect.orDie))
          if (decision.decision !== "approved_once" && decision.decision !== "approved_always")
            return yield* new PermissionV1.DeniedError({
              ruleset: [{ permission: info.permission, pattern: info.patterns.join(","), action: "deny" }],
            })
          if (requestKind === "no_progress" && decision.decision === "approved_once")
            yield* DeepAgentActivityAuthority.consumeOnce({
              requestID: id,
              consumerID: permissionConsumerID(info),
              idempotencyKey: `permission-consumption:${id}`,
            }).pipe(Effect.provideService(Database.Service, database), Effect.orDie)
          return yield* beginEffect()
        }
        log.info("asking", { id, permission: info.permission, patterns: info.patterns })

        const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
        const entry: PendingEntry = {
          info,
          deferred,
          owner,
          origin,
          route,
          settling: false,
          ...(activity ? { durable: { requestKind } } : {}),
        }
        yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* requestDurable(info.always)
            owner.pending.set(id, entry)
            allPending.set(id, entry)
            return yield* Effect.ensuring(
              Effect.gen(function* () {
                yield* events.publish(Event.Asked, info)
                return yield* restore(
                  Effect.gen(function* () {
                    if (timeoutMs === undefined) return yield* Deferred.await(deferred)
                    const result = yield* Deferred.await(deferred).pipe(
                      Effect.as(true),
                      Effect.timeoutOption(Duration.millis(Math.max(1, timeoutMs))),
                    )
                    if (Option.isSome(result)) return
                    if (!claimPending(id, entry)) return yield* Deferred.await(deferred)
                    log.warn("permission request timed out", {
                      id,
                      sessionID: info.sessionID,
                      permission: info.permission,
                      timeoutMs,
                    })
                    yield* settleClaimed(entry, "expired")
                    return yield* Deferred.await(deferred)
                  }),
                )
              }),
              Effect.gen(function* () {
                if (!claimPending(id, entry)) return
                yield* settleClaimed(entry, "interrupted")
              }),
            )
          }),
        )
        return yield* beginEffect()
      })

      const reply = Effect.fn("Permission.reply")((input: PermissionV1.ReplyInput) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const current = yield* InstanceState.context
            const workspaceID = yield* InstanceState.workspaceID
            const existing = allPending.get(input.requestID)
            if (!existing && flags.activityAuthority === "durable") {
              const request = yield* DeepAgentActivityAuthority.permissionRequestForRequest(input.requestID).pipe(
                Effect.provideService(Database.Service, database),
              )
              const session = request
                ? yield* database.db
                    .select({ directory: SessionTable.directory })
                    .from(SessionTable)
                    .where(eq(SessionTable.id, request.sessionID))
                    .get()
                    .pipe(Effect.orDie)
                : undefined
              if (
                !request ||
                !session ||
                FSUtil.resolve(session.directory) !== FSUtil.resolve(current.directory) ||
                request.workspaceID !== workspaceID
              )
                return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })
              const decision = permissionDecisionForReply(request.requestKind, input.reply)
              const fanout =
                input.reply === "always"
                  ? ("always" as const)
                  : input.reply === "reject"
                    ? ("reject" as const)
                    : undefined
              const result = yield* (
                fanout
                  ? DeepAgentActivityAuthority.decidePermissionWithFanout({
                      requestID: input.requestID,
                      idempotencyKey: `permission-decision:${input.requestID}:${decision}:fanout:${fanout}`,
                      decision,
                      sessionFanout: fanout,
                      actorType: "user",
                      actorID: "permission-ui",
                      ...(input.message ? { feedback: input.message } : {}),
                    })
                  : DeepAgentActivityAuthority.decidePermission({
                      requestID: input.requestID,
                      idempotencyKey: `permission-decision:${input.requestID}:${decision}`,
                      decision,
                      actorType: "user",
                      actorID: "permission-ui",
                      ...(input.message ? { feedback: input.message } : {}),
                    })
              ).pipe(Effect.provideService(Database.Service, database), Effect.exit)
              if (Exit.isFailure(result)) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })
              return
            }
            if (
              !existing ||
              !visibleFrom(existing, current.directory, workspaceID) ||
              !claimPending(input.requestID, existing)
            )
              return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

            const durable = yield* settleClaimed(existing, input.reply, input.message)
            if (!durable) {
              return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })
            }

            const winnerReply = permissionReplyForDecision(durable)
            if (flags.activityAuthority === "durable") {
              // Durable-backed siblings fan out through the DB (decidePermissionWithFanout + the
              // reconciliation poller); memory-only entries of the same session (turns without an
              // admitted activity) still need the legacy in-memory fan-out or they never settle.
              if (winnerReply === "reject") {
                if (input.reply !== "reject") return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })
                for (const [id, item] of allPending) {
                  if (item.durable || item.info.sessionID !== existing.info.sessionID || !claimPending(id, item)) continue
                  yield* settleClaimed(item, "reject")
                }
                return
              }
              if (winnerReply === "once") return
              for (const [id, item] of allPending) {
                if (item.durable || item.info.sessionID !== existing.info.sessionID) continue
                const ok = item.info.patterns.every(
                  (pattern) => evaluate(item.info.permission, pattern, item.owner.approved).action === "allow",
                )
                if (!ok || !claimPending(id, item)) continue
                yield* settleClaimed(item, "always")
              }
              return
            }
            if (winnerReply === "reject") {
              if (input.reply === "reject") {
                for (const [id, item] of allPending) {
                  if (item.info.sessionID !== existing.info.sessionID || !claimPending(id, item)) continue
                  yield* settleClaimed(item, "reject")
                }
              }
              if (input.reply !== "reject") return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })
              return
            }
            if (winnerReply === "once") return

            for (const [id, item] of allPending) {
              if (item.info.sessionID !== existing.info.sessionID) continue
              const ok = item.info.patterns.every(
                (pattern) => evaluate(item.info.permission, pattern, item.owner.approved).action === "allow",
              )
              if (!ok || !claimPending(id, item)) continue
              yield* settleClaimed(item, "always")
            }
          }),
        ),
      )

      const list = Effect.fn("Permission.list")(function* () {
        const current = yield* InstanceState.context
        const workspaceID = yield* InstanceState.workspaceID
        return Array.from(allPending.values())
          .filter((item) => !item.settling && visibleFrom(item, current.directory, workspaceID))
          .map((item) => item.info)
      })

      const effectsForToolCall = Effect.fn("Permission.effectsForToolCall")(function* (input: {
        readonly sessionID: string
        readonly toolMessageID: string
        readonly toolCallID: string
        readonly toolName: string
      }) {
        if (flags.activityAuthority !== "durable") return []
        return yield* DeepAgentActivityAuthority.permissionEffectsForToolCall(input).pipe(
          Effect.provideService(Database.Service, database),
        )
      })

      const settleEffect = Effect.fn("Permission.settleEffect")(function* (input: {
        readonly grant: EffectGrant
        readonly outcome: "success" | "failure"
        readonly result: unknown
      }) {
        return yield* permissionOwnerID().pipe(
          Effect.flatMap((ownerID) =>
            DeepAgentActivityAuthority.settlePermissionEffect({
              receiptID: input.grant.receiptID,
              expectedVersion: input.grant.version,
              ownerID,
              outcome: input.outcome,
              result: input.result,
            }),
          ),
          withPermissionOwner,
          Effect.provideService(Database.Service, database),
          Effect.orDie,
        )
      })

      const recoverActivity = Effect.fn("Permission.recoverActivity")(function* (input: {
        readonly activityID: string
        readonly expectedVersion: number
        readonly terminalReason: string
      }) {
        if (flags.activityAuthority !== "durable") return false
        return yield* permissionOwnerID().pipe(
          Effect.flatMap((recoveryOwnerID) =>
            DeepAgentActivityAuthority.recoverActivity({
              activityKind: "legacy",
              activityID: input.activityID,
              expectedVersion: input.expectedVersion,
              terminalReason: input.terminalReason,
              recoveryOwnerID,
            }),
          ),
          withPermissionOwner,
          Effect.provideService(Database.Service, database),
          Effect.orDie,
        )
      })

      const ask = Effect.fn("Permission.ask")((input: AskInput) => askEffect(input).pipe(Effect.asVoid))

      return Service.of({
        ask,
        askEffect,
        effectsForToolCall,
        settleEffect,
        ...(flags.activityAuthority === "durable" ? { rotateOwner, rotateOwnerIfCurrent, recoverActivity } : {}),
        reply,
        list,
      })
    }),
  )

export const layer = layerWith()

function permissionConsumerID(request: PermissionV1.Request) {
  if (request.tool) return `tool:${request.tool.messageID}:${request.tool.callID}`
  return `no-progress:${request.id}`
}

function permissionReplyForDecision(
  decision: "approved_once" | "approved_always" | "denied" | "expired" | "interrupted",
): PermissionV1.Reply {
  if (decision === "approved_once") return "once"
  if (decision === "approved_always") return "always"
  return "reject"
}

function permissionDecisionForReply(requestKind: "tool" | "no_progress", reply: PermissionV1.Reply) {
  if (reply === "once") return "approved_once" as const
  if (reply === "always") return "approved_always" as const
  return requestKind === "no_progress" ? ("interrupted" as const) : ("denied" as const)
}

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export * as Permission from "."
