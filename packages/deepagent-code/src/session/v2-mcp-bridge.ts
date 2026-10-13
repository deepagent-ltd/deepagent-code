export * as V2McpBridge from "./v2-mcp-bridge"

import { asSchema, type FlexibleSchema, type ToolExecutionOptions } from "ai"
import { Effect, Exit, Layer, Option, Scope, Semaphore } from "effect"
import { CallToolResultSchema } from "@modelcontextprotocol/core"
import type { CallToolResult } from "@modelcontextprotocol/client"
import { ToolFailure } from "@deepagent-code/llm"
import { Location } from "@deepagent-code/core/location"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { SessionStore } from "@deepagent-code/core/session/store"
import { Hash } from "@deepagent-code/core/util/hash"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { Tool } from "@deepagent-code/core/tool/tool"
import { McpAppInvocation } from "@deepagent-code/core/session/mcp-app-invocation"
import { MCP } from "@/mcp"
import { InstanceRegistry } from "@/effect/instance-registry"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ToolProvenance } from "@/tool/provenance"

const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")

/**
 * RI-26 W3: bridge the instance's connected MCP server tools into the Core V2 `ApplicationTools`
 * seam so V2 session tool materialization includes them. MCP tool sets are INSTANCE-scoped
 * (per-directory config and clients), so registration rides the instance registry: the
 * initializer runs when an instance boots, and a per-instance state disposer detaches exactly
 * that batch when the instance disposes — ApplicationTools tracks registrations by token, so
 * overlapping server names across instances overlay instead of colliding. The V1 MCP service
 * stays the SINGLE client authority (transports, auth, secret resolution); the bridge only
 * adapts each AI-SDK dynamic tool into a Core `Tool.makeDynamic` under the
 * `mcp__{server}__{tool}` name (the V1 `server:tool` key cannot pass Core name validation).
 *
 * Execution semantics are V2-native:
 * - abort: the settle fiber's own cancellation signal (Effect.callback) is passed into the AI
 *   SDK `abortSignal`, and the MCP client transport forwards it into the tool call — cancelling
 *   the parent turn cancels the remote call and the fiber discards the result.
 * - messages: the Core dynamic `Tool.Context` carries no conversation history, and the MCP
 *   adapter's execute never consumed chat messages — an explicit empty array, not a silent one.
 * - failures: a rejecting tool call settles as a typed `ToolFailure`, never a die.
 *
 * Registration is best-effort: a failed bridge never fails instance boot. MCP lifecycle and
 * tools/list changes publish ToolsChanged after the client authority updates; the bridge swaps
 * its instance-owned batch before that event completes, so the next provider turn sees the new
 * list without reloading the instance.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const applications = yield* ApplicationTools.Service
    const registry = yield* InstanceRegistry.Service
    const events = yield* EventV2Bridge.Service

    registry.registerInitializer((context) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const semaphore = yield* Semaphore.make(1)
          let scope: Scope.Scope | undefined
          let disposed = false
          let generation: { active: boolean } | undefined
          const appScope = yield* Scope.make()
          if (mcp.appResourceCapture) yield* McpAppInvocation.registerHost({ directory: AbsolutePath.make(context.directory) }, {
            capture: (input) => mcp.appResourceCapture!(input).pipe(Effect.provideService(InstanceRef, context)),
          }).pipe(Effect.provideService(Scope.Scope, appScope))
          const refresh = semaphore.withPermit(
            Effect.gen(function* () {
              if (disposed) return
              if (generation) generation.active = false
              const tools = yield* mcp.tools().pipe(Effect.provideService(InstanceRef, context))
              const current = { active: true }
              generation = current
              const registered: Record<string, Tool.AnyTool> = {}
              for (const [key, item] of Object.entries(tools)) {
                const provenance = ToolProvenance.get(item)
                if (provenance?.source !== "mcp" || !provenance.mcpServer || !provenance.mcpToolName) continue
                const execute = (
                  item as {
                    execute?: (input: unknown, options: ToolExecutionOptions) => Promise<unknown>
                  }
                ).execute
                if (!execute) continue
                // MCP's model key joins sanitized names with one underscore, which is ambiguous
                // when either component contains underscores. Use the original config server and
                // tool names carried by the client authority instead of parsing that key.
                const name = `mcp__${sanitize(provenance.mcpServer)}__${sanitize(provenance.mcpToolName)}`
                if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) continue
                if (registered[name])
                  return yield* new Tool.RegistrationError({
                    name,
                    message: "MCP tool names collide after sanitization",
                  })
                const schema = asSchema((item as { readonly inputSchema?: FlexibleSchema }).inputSchema) as {
                  readonly jsonSchema?: unknown
                }
                const document = schema.jsonSchema instanceof Promise ? undefined : (schema.jsonSchema as unknown)
                registered[name] = Tool.withPermission(
                  Tool.makeDynamic({
                    description: (item.description ?? `${key} MCP tool`).slice(0, 1024),
                    inputJsonSchema:
                      document && typeof document === "object"
                        ? (document as Record<string, unknown>)
                        : { type: "object", properties: {} },
                    execute: (input, callContext) =>
                      Effect.gen(function* () {
                        // Application registrations are process-wide; their captured transport
                        // must never be borrowed by another Location or a stale approved call.
                        const location = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
                        const permission = Option.getOrUndefined(yield* Effect.serviceOption(PermissionV2.Service))
                        const sessions = Option.getOrUndefined(yield* Effect.serviceOption(SessionStore.Service))
                        if (!location || !permission || !sessions)
                          return yield* new ToolFailure({
                            message: "MCP execution requires V2 Location, Session and permission authority",
                          })
                        const session = yield* sessions.get(callContext.sessionID)
                        if (
                          !session ||
                          location.directory !== context.directory ||
                          location.workspaceID !== undefined ||
                          session.location.directory !== location.directory ||
                          session.location.workspaceID !== undefined
                        )
                          return yield* new ToolFailure({
                            message: "MCP tool belongs to a different or unsupported Session Location",
                          })
                        if (disposed || !current.active)
                          return yield* new ToolFailure({ message: "MCP tool registration is no longer active" })
                        yield* permission
                          .assert({
                            action: "mcp",
                            resources: [`${provenance.mcpServer}:${provenance.mcpToolName}`],
                            metadata: { server: provenance.mcpServer, tool: provenance.mcpToolName },
                            source: {
                              type: "tool",
                              messageID: callContext.assistantMessageID,
                              callID: callContext.toolCallID,
                            },
                            sessionID: callContext.sessionID,
                            agent: callContext.agent,
                          })
                          .pipe(
                            Effect.mapError(
                              (error) =>
                                PermissionV2.permissionToolFailure(error) ??
                                new ToolFailure({ message: `MCP permission check failed: ${error.message}` }),
                            ),
                          )
                        const latest = yield* sessions.get(callContext.sessionID)
                        if (
                          !latest ||
                          latest.location.directory !== session.location.directory ||
                          latest.location.workspaceID !== session.location.workspaceID
                        )
                          return yield* new ToolFailure({
                            message: "MCP Session Location changed while awaiting permission",
                          })
                        if (disposed || !current.active)
                          return yield* new ToolFailure({
                            message:
                              "MCP tool registration changed while awaiting permission; observe the new tool list",
                          })
                        const output = yield* Effect.callback<unknown, ToolFailure>((resume, signal) => {
                          // The fiber signal IS the tool call's abortSignal: cancelling the settle
                          // fiber (parent turn cancellation) aborts the in-flight MCP request, and
                          // the callback suspends interruptibly so the settle result is discarded.
                          execute(input, {
                            toolCallId: callContext.toolCallID,
                            messages: [],
                            abortSignal: signal,
                          })
                            .then((value) => resume(Effect.succeed(value)))
                            .catch((cause) =>
                              resume(
                                Effect.fail(
                                  new ToolFailure({
                                    message: `MCP tool ${key} failed: ${String(cause)}`,
                                    ...(cause instanceof MCP.ToolBindingChangedError ||
                                    cause instanceof MCP.ToolNotDispatchedError
                                      ? {}
                                      : { metadata: { effectOutcome: "unknown" } }),
                                  }),
                                ),
                              ),
                            )
                        })
                        return yield* validateResult(output, key)
                      }),
                    toStructuredOutput: ({ output }) => retainedResult(output as CallToolResult),
                    toModelOutput: ({ output }) => modelContent(output as CallToolResult),
                  }),
                  "mcp",
                )
              }
              const next = yield* Scope.make()
              const previous = scope
              yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  yield* applications.register(registered, { directory: AbsolutePath.make(context.directory) }).pipe(
                    Effect.provideService(Scope.Scope, next),
                    Effect.tap(() =>
                      Effect.addFinalizer(() =>
                        Effect.sync(() => {
                          current.active = false
                        }),
                      ).pipe(Effect.provideService(Scope.Scope, next)),
                    ),
                    Effect.onExit((exit) =>
                      Exit.isFailure(exit)
                        ? Effect.gen(function* () {
                            yield* Scope.close(next, exit)
                            if (previous) yield* Scope.close(previous, exit)
                            scope = undefined
                          })
                        : Effect.void,
                    ),
                  )
                  scope = next
                  if (previous) yield* Scope.close(previous, Exit.void)
                }),
              )
            }),
          )
          const unsubscribe = yield* events.listen((event) =>
            event.type === MCP.ToolsChanged.type && event.location?.directory === context.directory
              ? refresh.pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("V2 MCP bridge refresh failed", { directory: context.directory, cause }),
                  ),
                )
              : Effect.void,
          )
          const stopWatching = mcp.watchConfig
            ? yield* mcp.watchConfig().pipe(Effect.provideService(InstanceRef, context))
            : () => {}
          InstanceRegistry.registerInstanceStateDisposer(context, () =>
            Effect.runPromise(
              semaphore.withPermit(
                Effect.gen(function* () {
                  disposed = true
                  yield* Scope.close(appScope, Exit.void)
                  if (generation) generation.active = false
                  stopWatching()
                  yield* unsubscribe
                  if (scope) yield* Scope.close(scope, Exit.void)
                }),
              ),
            ),
          )
          yield* refresh
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("V2 MCP bridge registration failed").pipe(
              Effect.annotateLogs({ directory: context.directory, cause }),
            ),
          ),
        ),
      ),
    )
  }),
)

const maxImageBytes = 5 * 1024 * 1024
const imageMimes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])

function validateResult(output: unknown, name: string) {
  const parsed = CallToolResultSchema.safeParse(output)
  if (!parsed.success)
    return Effect.fail(
      new ToolFailure({
        message: `MCP tool ${name} returned an invalid protocol result`,
        metadata: { effectOutcome: "unknown" },
      }),
    )
  if (parsed.data.isError)
    return Effect.fail(
      new ToolFailure({
        message: `MCP tool ${name} failed: ${
          parsed.data.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n")
            .slice(0, 4096) || "server returned isError"
        }`,
      }),
    )
  const images = parsed.data.content.flatMap((part) => {
    if (part.type === "image") return [{ data: part.data, mimeType: part.mimeType }]
    if (part.type === "resource" && "blob" in part.resource && imageMimes.has(part.resource.mimeType ?? ""))
      return [{ data: part.resource.blob, mimeType: part.resource.mimeType! }]
    return []
  })
  // Bound producer capture before decoding. Registry still owns model-output retention.
  if (
    images.length > 8 ||
    images.reduce((size, part) => size + part.data.length, 0) > Math.ceil(maxImageBytes / 3) * 4 ||
    images.some(
      (part) =>
        !imageMimes.has(part.mimeType) ||
        !part.data ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.data) ||
        Buffer.from(part.data, "base64").toString("base64") !== part.data ||
        !imageMatchesMime(part.data, part.mimeType),
    ) ||
    images.reduce((size, part) => size + Buffer.byteLength(part.data, "base64"), 0) > maxImageBytes
  )
    return Effect.fail(
      new ToolFailure({
        message: `MCP tool ${name} returned unsupported, invalid or oversized image content (5 MiB total, 8 images)`,
        metadata: { effectOutcome: "unknown" },
      }),
    )
  if (Buffer.byteLength(JSON.stringify(parsed.data.structuredContent ?? {})) > 256 * 1024)
    return Effect.fail(
      new ToolFailure({
        message: `MCP tool ${name} returned oversized structured content (256 KiB)`,
        metadata: { effectOutcome: "unknown" },
      }),
    )
  return Effect.succeed(parsed.data)
}

function modelContent(output: CallToolResult): ReadonlyArray<Tool.Content> {
  const content = output.content.map((part): Tool.Content => {
    if (part.type === "text") return { type: "text", text: part.text }
    if (part.type === "image") return { type: "file", data: part.data, mime: part.mimeType }
    if (part.type === "resource" && "text" in part.resource) return { type: "text", text: part.resource.text }
    if (part.type === "resource" && "blob" in part.resource && imageMimes.has(part.resource.mimeType ?? ""))
      return { type: "file", data: part.resource.blob, mime: part.resource.mimeType! }
    if (part.type === "resource_link") return { type: "text", text: JSON.stringify(part) }
    return { type: "text", text: `[MCP ${part.type} content is not supported by this bridge]` }
  })
  if (output.structuredContent !== undefined) {
    const text = JSON.stringify(output.structuredContent)
    if (content.some((part) => part.type === "text" && part.text.trim() === text)) return content
    return [...content, { type: "text", text }]
  }
  return content.length > 0 ? content : [{ type: "text", text: "{}" }]
}

function retainedResult(output: CallToolResult) {
  return {
    ...(output.structuredContent === undefined ? {} : { structuredContent: output.structuredContent }),
    content: output.content.map((part) => {
      if (part.type === "image")
        return {
          type: part.type,
          mimeType: part.mimeType,
          size: Buffer.byteLength(part.data, "base64"),
          sha256: Hash.sha256(Buffer.from(part.data, "base64")),
        }
      if (part.type === "resource" && "blob" in part.resource)
        return {
          type: part.type,
          uri: part.resource.uri,
          mimeType: part.resource.mimeType,
          size: Buffer.byteLength(part.resource.blob, "base64"),
          sha256: Hash.sha256(Buffer.from(part.resource.blob, "base64")),
        }
      if (part.type === "audio") return { type: part.type, mimeType: part.mimeType, unsupported: true }
      return part
    }),
  }
}

function imageMatchesMime(data: string, mime: string) {
  const bytes = Buffer.from(data, "base64")
  if (mime === "image/png")
    return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (mime === "image/jpeg") return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (mime === "image/gif") return bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))
  return (
    mime === "image/webp" &&
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
}
