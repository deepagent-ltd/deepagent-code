export * as V2McpBridge from "./v2-mcp-bridge"

import { asSchema, type FlexibleSchema, type ToolExecutionOptions } from "ai"
import { Effect, Exit, Layer, Scope, Semaphore } from "effect"
import { ToolFailure } from "@deepagent-code/llm"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { Tool } from "@deepagent-code/core/tool/tool"
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
          const refresh = semaphore.withPermit(
            Effect.gen(function* () {
              if (disposed) return
              const tools = yield* mcp.tools().pipe(Effect.provideService(InstanceRef, context))
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
                      Effect.callback<unknown, ToolFailure>((resume, signal) => {
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
                              Effect.fail(new ToolFailure({ message: `MCP tool ${key} failed: ${String(cause)}` })),
                            ),
                          )
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
              const next = yield* Scope.make()
              const previous = scope
              yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  yield* applications.register(registered).pipe(
                    Effect.provideService(Scope.Scope, next),
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
          InstanceRegistry.registerInstanceStateDisposer(context, () =>
            Effect.runPromise(
              semaphore.withPermit(
                Effect.gen(function* () {
                  disposed = true
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
