export * as V2PluginToolsBridge from "./v2-plugin-tools-bridge"

import { Effect, Exit, Layer, Scope } from "effect"
import { ToolFailure } from "@deepagent-code/llm"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { Tool } from "@deepagent-code/core/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { InstanceRegistry } from "@/effect/instance-registry"
import { InstanceRef } from "@/effect/instance-ref"
import type * as V1Tool from "@/tool/tool"
import type { SessionV1 } from "@deepagent-code/core/v1/session"
import { SessionID, MessageID } from "@/session/schema"

/**
 * RI-26 W4: bridge the V1 registry's CUSTOM tool surface — npm/filesystem plugin tools and
 * config-glob JS custom tools — into the Core V2 `ApplicationTools` seam. Custom tools are
 * INSTANCE-scoped (the V1 registry state is per-instance), so registration rides the same
 * instance-lifecycle pattern as the MCP bridge: register on instance boot, detach the batch on
 * instance dispose. The V1 wrappers (plugin hook admission, plugin context plumbing) stay the
 * execution authority and are invoked with a bridge context.
 *
 * Honest boundary: ctx.ask inside a custom tool has no live V1 permission surface under a V2
 * settle — it fails closed (a typed die) telling the caller to allow the tool through its V2
 * permission rule instead. ctx.metadata is a no-op (the V2 turn receipts remain the durable
 * evidence). Names pass through except charset sanitization; an id that cannot satisfy Core
 * name validation is skipped. Tool installs/refreshes after an instance booted re-register on
 * the next instance load.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const applications = yield* ApplicationTools.Service
    const instanceRegistry = yield* InstanceRegistry.Service

    instanceRegistry.registerInitializer((context) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const custom = yield* registry
            .custom()
            .pipe(Effect.provideService(InstanceRef, context))
          const registered: Record<string, Tool.AnyTool> = {}
          for (const def of custom) {
            const name = def.id.replace(/[^A-Za-z0-9_-]/g, "_")
            if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) continue
            registered[name] = Tool.withPermission(
              Tool.makeDynamic({
                description: (def.description ?? def.id).slice(0, 1024),
                inputJsonSchema: (def.jsonSchema as Record<string, unknown> | undefined) ?? {
                  type: "object",
                  properties: {},
                },
                execute: (input, callContext) =>
                  (
                    def.execute as (
                      args: unknown,
                      ctx: V1Tool.Context,
                    ) => Effect.Effect<V1Tool.ExecuteResult>
                  )(input, bridgeContext(callContext)).pipe(
                    Effect.mapError(
                      (error) =>
                        new ToolFailure({
                          message: `Plugin tool ${def.id} failed: ${String(
                            (error as { message?: string }).message ?? error,
                          )}`,
                        }),
                    ),
                    Effect.map((result) => result.output),
                  ),
                toModelOutput: ({ output }) => [{ type: "text", text: String(output) }],
              }),
              def.id,
            )
          }
          const scope = yield* Scope.make()
          yield* applications.register(registered).pipe(Effect.provideService(Scope.Scope, scope))
          InstanceRegistry.registerInstanceStateDisposer(context, () =>
            Effect.runPromise(Scope.close(scope, Exit.void)),
          )
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("V2 plugin-tools bridge registration failed").pipe(
              Effect.annotateLogs({ directory: context.directory, cause }),
            ),
          ),
        ),
      ),
    )
  }),
)

const bridgeContext = (context: Tool.Context): V1Tool.Context => ({
  sessionID: SessionID.make(context.sessionID),
  messageID: MessageID.make(context.assistantMessageID),
  agent: String(context.agent),
  abort: new AbortController().signal,
  callID: context.toolCallID,
  messages: [] as SessionV1.WithParts[],
  metadata: () => Effect.void,
  // Fail-closed: a custom tool that asks cannot proceed under a V2 settle — allow it via its V2
  // permission rule instead. The V1 Context.ask contract cannot fail, so this dies.
  ask: () =>
    Effect.die(
      new Error(
        "This custom tool requested an interactive permission ask through the V2 bridge; allow it via its V2 permission rule instead.",
      ),
    ),
})
