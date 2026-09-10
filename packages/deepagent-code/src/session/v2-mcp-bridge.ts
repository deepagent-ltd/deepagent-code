export * as V2McpBridge from "./v2-mcp-bridge"

import { asSchema, type Tool as AITool } from "ai"
import { Effect, Exit, Layer, Scope } from "effect"
import { ToolFailure } from "@deepagent-code/llm"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { Tool } from "@deepagent-code/core/tool/tool"
import { MCP } from "@/mcp"
import { InstanceRegistry } from "@/effect/instance-registry"
import { InstanceRef } from "@/effect/instance-ref"

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
 * Registration is best-effort: a failed bridge never fails instance boot. Servers added or
 * removed after an instance booted re-register on the next instance load; live-change
 * subscription is a follow-up on the ApplicationTools seam.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const applications = yield* ApplicationTools.Service
    const registry = yield* InstanceRegistry.Service

    registry.registerInitializer((context) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const tools = yield* mcp.tools().pipe(Effect.provideService(InstanceRef, context))
          const registered: Record<string, Tool.AnyTool> = {}
          for (const [key, item] of Object.entries(tools)) {
            const execute = (item as AITool<any, any>).execute
            if (!execute) continue
            // "server:tool" → mcp__server__tool, charset-safe for Core name validation.
            const name = `mcp__${sanitize(key)}`
            if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) continue
            const schema = asSchema((item as AITool<any, any>).inputSchema ?? {}) as {
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
                  Effect.tryPromise({
                    try: () =>
                      execute(input, {
                        toolCallId: callContext.toolCallID,
                        messages: [],
                        abortSignal: undefined,
                      } as never) as Promise<unknown>,
                    catch: (cause) => new ToolFailure({ message: `MCP tool ${key} failed: ${String(cause)}` }),
                  }),
                toModelOutput: ({ output }) => {
                  const content = (
                    output as { content?: ReadonlyArray<{ type: string; text?: string }> } | undefined
                  )?.content
                  const text = content
                    ?.filter((part) => part.type === "text")
                    .map((part) => part.text ?? "")
                    .join("\n")
                  return [{ type: "text", text: text?.trim() ? text! : JSON.stringify(output) }]
                },
              }),
              "mcp",
            )
          }
          // A manually-held scope: the batch detaches exactly when this instance disposes.
          const scope = yield* Scope.make()
          yield* applications.register(registered).pipe(Effect.provideService(Scope.Scope, scope))
          InstanceRegistry.registerInstanceStateDisposer(context, () =>
            Effect.runPromise(Scope.close(scope, Exit.void)),
          )
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
