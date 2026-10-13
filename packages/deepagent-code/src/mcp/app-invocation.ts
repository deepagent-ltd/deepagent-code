export * as McpAppInvocationHost from "./app-invocation"

import { CallToolResultSchema } from "@modelcontextprotocol/core"
import { Effect, Option } from "effect"
import { eq } from "drizzle-orm"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { Location } from "@deepagent-code/core/location"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { WorkSessionGuard } from "@deepagent-code/core/session/work-session-guard"
import { GoalChild } from "@deepagent-code/core/deepagent/goal-child"
import { McpAppInvocation } from "@deepagent-code/core/session/mcp-app-invocation"
import { McpAppInvocationSchema } from "@deepagent-code/core/session/mcp-app-invocation.schema"
import { Tool } from "@deepagent-code/core/tool/tool"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { McpAppResource } from "./app-resource"
import { MCP } from "./index"

type Captured = Effect.Success<ReturnType<ReturnType<typeof McpAppResource.make>["capture"]>>
export const native = Effect.fn("McpAppInvocationHost.native")(function* (captured: Captured) {
  // Transport callbacks run in a new Promise fiber. Preserve the original Instance/config
  // scope explicitly; default Reference values are never a source replacement.
  const environment = yield* Effect.context<never>()
  const definitionHash = McpAppInvocation.hash(captured.tool)
  const configurationHash = McpAppInvocation.hash(captured.snapshot.source)
  const current = () => captured.current() && McpAppInvocation.hash(captured.tool) === definitionHash
  return Object.freeze({ sessionID: captured.sessionID, viewID: captured.viewID, generation: captured.snapshot.generation,
    server: captured.snapshot.server, tool: captured.tool.name,
    registryID: `mcp__${captured.snapshot.server.replace(/[^a-zA-Z0-9_-]/g, "_")}__${captured.tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
    definitionHash, configurationHash, expiresAt: captured.expiresAt, current,
    prepare: () => captured.prepare().pipe(Effect.provide(environment), Effect.mapError(() => McpAppInvocation.failure("changed"))),
    execute: (args: Record<string, unknown>, context: Tool.AppContext) => Effect.gen(function* () {
      if (!current() || !Tool.appContextCurrent(context) || context.sessionID !== captured.sessionID || context.source.viewID !== captured.viewID ||
        context.source.generation !== captured.snapshot.generation || context.source.server !== captured.snapshot.server || context.source.tool !== captured.tool.name ||
        context.source.definitionHash !== definitionHash || context.source.configurationHash !== configurationHash)
        return yield* new Tool.Failure({ message: "MCP App source changed", metadata: { effectOutcome: "not_dispatched" } })
      const prepare = captured.prepare().pipe(Effect.provide(environment), Effect.mapError(() => new Tool.Failure({ message: "MCP App view changed", metadata: { effectOutcome: "not_dispatched" } })),
        Effect.andThen(Tool.checkAppContext(context)))
      const output = yield* Effect.callback<unknown, Tool.Failure>((resume, signal) => {
        MCP.callAppTool(captured.snapshot.client, captured.tool, args, {
          current: () => current() && Tool.appContextCurrent(context), beforeSend: () => Effect.runPromise(prepare, { signal }), signal,
        }).then((value) => resume(Effect.succeed(value))).catch((cause) => resume(Effect.fail(new Tool.Failure({
          message: "MCP App tool call failed", metadata: { effectOutcome: cause instanceof MCP.ToolBindingChangedError || cause instanceof MCP.ToolNotDispatchedError ? "not_dispatched" : "unknown" },
        }))))
      })
      if (!McpAppInvocationSchema.bounded(output, McpAppInvocationSchema.LIMITS.resultBytes))
        return yield* new Tool.Failure({ message: "MCP App response exceeds retention bounds", metadata: { effectOutcome: "unknown" } })
      const parsed = CallToolResultSchema.safeParse(output)
      if (!parsed.success) return yield* new Tool.Failure({ message: "MCP App response is invalid", metadata: { effectOutcome: "unknown" } })
      const textBytes = parsed.data.content?.reduce((total, part) => total + (part.type === "text" ? Buffer.byteLength(part.text) : 0), 0) ?? 0
      const images = parsed.data.content?.filter((part) => part.type === "image") ?? []
      if (textBytes > McpAppInvocationSchema.LIMITS.textBytes || images.length > 8 || images.some((part) => Buffer.byteLength(part.data, "base64") > 5 * 1024 * 1024) ||
        parsed.data.structuredContent !== undefined && !McpAppInvocationSchema.bounded(parsed.data.structuredContent, McpAppInvocationSchema.LIMITS.textBytes) ||
        parsed.data._meta !== undefined && !McpAppInvocationSchema.bounded(parsed.data._meta, McpAppInvocationSchema.LIMITS.metadataBytes))
        return yield* new Tool.Failure({ message: "MCP App response content exceeds bounds", metadata: { effectOutcome: "unknown" } })
      return parsed.data
    }),
  }) satisfies McpAppInvocation.Native
})
type Environment = Database.Service | EventV2.Service | SessionExecution.Service | Location.Service | AgentV2.Service
const inLocation = <A, E>(body: Effect.Effect<A, E, Environment>) => Effect.gen(function* () {
  const context = yield* InstanceRef
  const workspace = yield* WorkspaceRef
  if (!context || workspace) return yield* McpAppInvocation.failure("restricted")
  // Use the calling production root's existing services and map. Never open another DB/runtime.
  const locations = Option.getOrUndefined(yield* Effect.serviceOption(LocationServiceMap))
  const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
  const events = Option.getOrUndefined(yield* Effect.serviceOption(EventV2.Service))
  const execution = Option.getOrUndefined(yield* Effect.serviceOption(SessionExecution.Service))
  if (!locations || !database || !events || !execution) return yield* McpAppInvocation.failure("unavailable")
  return yield* body.pipe(Effect.provide(LocationServiceMap.get({ directory: AbsolutePath.make(context.directory) })),
    Effect.provideService(LocationServiceMap, locations), Effect.provideService(Database.Service, database),
    Effect.provideService(EventV2.Service, events), Effect.provideService(SessionExecution.Service, execution))
})
export const validateSession = (sessionID: SessionSchema.ID) => inLocation(Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const location = yield* Location.Service
  const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.mapError(() => McpAppInvocation.failure("unavailable")))
  if (!row || !row.v2_authority || row.time_archived !== null || row.directory !== location.directory || row.workspace_id !== null || row.project_id !== location.project.id)
    return yield* McpAppInvocation.failure("changed")
  yield* WorkSessionGuard.requireOrdinary(db, sessionID).pipe(Effect.mapError(() => McpAppInvocation.failure("restricted")))
  if (yield* GoalChild.owner(db, sessionID).pipe(Effect.mapError(() => McpAppInvocation.failure("unavailable")))) return yield* McpAppInvocation.failure("restricted")
}))
export const invoke = (input: McpAppInvocationSchema.InvokeInput) => inLocation(Effect.gen(function* () {
  const service = yield* McpAppInvocation.make()
  const status = yield* service.invoke(input)
  // HTTP only admits. The same process-global Session coordinator owns execution.
  const execution = yield* SessionExecution.Service
  if (status.state === "queued" || status.state === "awaiting_permission") yield* execution.wake(input.sessionID, status.admittedSeq).pipe(Effect.ignore)
  return status
}))
export const status = (input: typeof McpAppInvocationSchema.StatusInput.Type) => inLocation(Effect.flatMap(McpAppInvocation.make(), (service) => service.status(input)))
export const result = (input: typeof McpAppInvocationSchema.ResultInput.Type) => inLocation(Effect.flatMap(McpAppInvocation.make(), (service) => service.result(input)))
export const list = (input: typeof McpAppInvocationSchema.ListInput.Type) => inLocation(Effect.flatMap(McpAppInvocation.make(), (service) => service.list(input)))
