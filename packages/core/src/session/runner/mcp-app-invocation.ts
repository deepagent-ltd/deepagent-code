export * as McpAppRunner from "./mcp-app-invocation"

import { Cause, Duration, Effect, Exit, Option } from "effect"
import { AgentV2 } from "../../agent"
import { PermissionV2 } from "../../permission"
import { Tool } from "../../tool/tool"
import type { Database } from "../../database/database"
import type { EventV2 } from "../../event"
import type { Location } from "../../location"
import { McpAppInvocation } from "../mcp-app-invocation"
import { McpAppInvocationSchema } from "../mcp-app-invocation.schema"
import { SessionSchema } from "../schema"

/** Invoked exclusively by the original Session drain, between complete provider/tool turns. */
export const drain = Effect.fn("McpAppRunner.drain")(function* (input: {
  readonly db: Database.Interface["db"]
  readonly events: EventV2.Interface
  readonly location: Location.Interface
  readonly permissions?: PermissionV2.Interface
  readonly sessionID: SessionSchema.ID
}) {
  const rows = (yield* McpAppInvocation.pending(input.db, input.sessionID)).slice(0, McpAppInvocationSchema.LIMITS.boundaryBatch)
  if (!rows.length) return 0
  yield* McpAppInvocation.requireSafe(input.db, input.sessionID)
  for (const original of rows) {
    const id = original.invocation.invocation_id
    const binding = McpAppInvocation.native(id)
    const permissions = input.permissions
    if (!binding || !permissions?.authorizeAction || !permissions.captureAppAction || !permissions.checkAction) {
      yield* McpAppInvocation.cancel(input.db, input.events, original, "changed")
      continue
    }
    if (original.invocation.expires_at <= Date.now()) {
      yield* McpAppInvocation.cancel(input.db, input.events, original, "expired")
      continue
    }
    const action: PermissionV2.AssertInput = { sessionID: input.sessionID, agent: AgentV2.ID.make(original.invocation.source.agentID), action: "mcp",
      resources: [`${binding.server}:${binding.tool}`], metadata: { server: binding.server, tool: binding.tool, invocationID: id, viewID: binding.viewID },
      source: { type: "mcp_app", invocationID: id, viewID: binding.viewID, server: binding.server, tool: binding.tool, generation: binding.generation } }
    const dispatched: { row?: McpAppInvocation.Stored } = {}
    const execute = Effect.gen(function* () {
      yield* binding.prepare()
      yield* McpAppInvocation.requireSource(input.db, original.invocation.source, input.location, id)
      yield* McpAppInvocation.awaiting(input.db, id)
      const permit = yield* permissions.authorizeAction!(action).pipe(Effect.mapError(() => McpAppInvocation.failure("permission_denied")))
      yield* binding.prepare()
      yield* permissions.checkAction!(permit, action).pipe(Effect.mapError(() => McpAppInvocation.failure("permission_denied")))
      const token = yield* permissions.captureAppAction!(permit, action).pipe(Effect.mapError(() => McpAppInvocation.failure("permission_denied")))
      const consume = PermissionV2.consumeAppAction(token).pipe(Effect.mapError(() => McpAppInvocation.failure("permission_denied")))
      const claimed = yield* McpAppInvocation.claim(input.db, input.location, original, consume, () => PermissionV2.appActionReceipt(token))
      dispatched.row = claimed
      const check = McpAppInvocation.dispatchCurrent(input.db, input.location, claimed, consume).pipe(Effect.mapError(() =>
        new Tool.Failure({ message: "App invocation authorization changed before dispatch" })))
      const context = yield* Tool.appContext({ sessionID: input.sessionID, agent: AgentV2.ID.make(original.invocation.source.agentID), invocationID: id, source: original.invocation.source },
        check, () => McpAppInvocation.current(id) && PermissionV2.appActionCurrent(token))
      yield* Tool.checkAppContext(context)
      const args = McpAppInvocation.argumentsOf(original)
      if (!args) return yield* McpAppInvocation.failure("invalid")
      const output = yield* binding.execute(args, context)
      // The native adapter validates CallToolResult. This guard bounds retention independently.
      if (!output || typeof output !== "object" || Array.isArray(output) || !McpAppInvocationSchema.bounded(output, McpAppInvocationSchema.LIMITS.resultBytes))
        return yield* McpAppInvocation.failure("unknown")
      const result = output as Record<string, unknown>
      return yield* Effect.uninterruptible(McpAppInvocation.settle(input.db, input.events, claimed, { state: result.isError === true ? "failed" : "settled", result }))
    }).pipe(Effect.scoped, Effect.timeout(Duration.millis(Math.max(1, original.invocation.expires_at - Date.now()))))
    const outcome = yield* execute.pipe(Effect.exit)
    if (Exit.isSuccess(outcome)) continue
    const error = Option.getOrUndefined(Cause.findErrorOption(outcome.cause))
    const knownNotSent = error instanceof Tool.Failure && error.metadata?.effectOutcome === "not_dispatched"
    if (dispatched.row) {
      // Cancellation/lost ACK after durable dispatch never authorizes another physical call.
      yield* Effect.uninterruptible(McpAppInvocation.settle(input.db, input.events, dispatched.row, {
        state: knownNotSent ? "failed" : "unknown", errorCode: knownNotSent ? "not_dispatched" : "unknown",
      }))
      if (!knownNotSent) return yield* McpAppInvocation.failure("unknown")
      continue
    }
    yield* McpAppInvocation.cancel(input.db, input.events, original, error instanceof McpAppInvocationSchema.Error ? error.code : "interrupted")
  }
  return rows.length
})
