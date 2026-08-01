import { ConfigPermissionV1 } from "@deepagent-code/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import * as Log from "@deepagent-code/core/util/log"
import { Wildcard } from "@deepagent-code/core/util/wildcard"
import { Deferred, Duration, Effect, Layer, Context, Option } from "effect"
import os from "os"
import { PermissionV1 } from "@deepagent-code/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@deepagent-code/core/event"
import { EventRouteRef, type EventRoute } from "@/effect/instance-ref"
import { FSUtil } from "@deepagent-code/core/fs-util"
import type { InstanceContext } from "@/project/instance-context"

const log = Log.create({ service: "permission" })

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
}

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
}

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
  owner: State
  origin: InstanceContext
  route: EventRoute
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

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/Permission") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const allPending = new Map<PermissionV1.ID, PendingEntry>()
    const removePending = (id: PermissionV1.ID, entry: PendingEntry) => {
      if (allPending.get(id) !== entry) return false
      allPending.delete(id)
      entry.owner.pending.delete(id)
      return true
    }
    const visibleFrom = (entry: PendingEntry, directory: string, workspaceID: string | undefined) =>
      (entry.route.workspaceID === undefined || entry.route.workspaceID === workspaceID) &&
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
              if (!removePending(id, item)) continue
              yield* publishReply(item, "reject")
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Permission.ask")(function* (input: AskInput) {
      const owner = yield* InstanceState.get(state)
      const origin = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      const route = (yield* EventRouteRef) ?? {
        ...origin,
        ...(workspaceID ? { workspaceID } : {}),
      }
      const { ruleset, timeoutMs, ...request } = input
      let needsAsk = false

      for (const pattern of request.patterns) {
        const rule = evaluate(request.permission, pattern, ruleset, owner.approved)
        log.info("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") continue
        needsAsk = true
      }

      if (!needsAsk) return

      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        always: request.always,
        tool: request.tool,
      }
      log.info("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      const entry: PendingEntry = { info, deferred, owner, origin, route }
      owner.pending.set(id, entry)
      allPending.set(id, entry)
      yield* events.publish(Event.Asked, info)
      return yield* Effect.ensuring(
        Effect.gen(function* () {
          if (timeoutMs === undefined) return yield* Deferred.await(deferred)
          const result = yield* Deferred.await(deferred).pipe(
            Effect.as(true),
            Effect.timeoutOption(Duration.millis(Math.max(1, timeoutMs))),
          )
          if (Option.isSome(result)) return

          // A concurrent human reply removes the entry before completing the deferred. In that narrow
          // race, the human decision owns settlement; only the fiber that deletes the pending entry may
          // publish the synthetic rejection.
          if (!removePending(id, entry)) return yield* Deferred.await(deferred)
          log.warn("permission request timed out", {
            id,
            sessionID: info.sessionID,
            permission: info.permission,
            timeoutMs,
          })
          yield* publishReply(entry, "reject")
          return yield* new PermissionV1.RejectedError()
        }),
        Effect.gen(function* () {
          if (!removePending(id, entry)) return
          yield* publishReply(entry, "reject")
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const current = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      const existing = allPending.get(input.requestID)
      if (!existing || !visibleFrom(existing, current.directory, workspaceID))
        return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      removePending(input.requestID, existing)
      yield* publishReply(existing, input.reply)

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )

        for (const [id, item] of allPending) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          removePending(id, item)
          yield* publishReply(item, "reject")
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return

      for (const pattern of existing.info.always) {
        existing.owner.approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      for (const [id, item] of allPending) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, item.owner.approved).action === "allow",
        )
        if (!ok) continue
        removePending(id, item)
        yield* publishReply(item, "always")
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const current = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      return Array.from(allPending.values())
        .filter((item) => visibleFrom(item, current.directory, workspaceID))
        .map((item) => item.info)
    })

    return Service.of({ ask, reply, list })
  }),
)

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

export const defaultLayer = layer.pipe(Layer.provide(EventV2Bridge.defaultLayer))

export * as Permission from "."
