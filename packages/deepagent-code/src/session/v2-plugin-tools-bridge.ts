export * as V2PluginToolsBridge from "./v2-plugin-tools-bridge"

import { DateTime, Effect, Exit, Layer, Option, Scope } from "effect"
import { ToolFailure } from "@deepagent-code/llm"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { Tool } from "@deepagent-code/core/tool/tool"
import { EventV2 } from "@deepagent-code/core/event"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { ToolRegistry } from "@/tool/registry"
import { InstanceRegistry } from "@/effect/instance-registry"
import { InstanceRef } from "@/effect/instance-ref"
import type * as V1Tool from "@/tool/tool"
import type { SessionV1 } from "@deepagent-code/core/v1/session"
import { SessionID, MessageID } from "@/session/schema"

/**
 * Bridge the V1 registry's CUSTOM tool surface — npm/filesystem plugin tools and config-glob JS
 * custom tools — into the Core V2 `ApplicationTools` seam. The V1 registry stays the DEFINITION
 * source (plugin JS lives there); EXECUTION semantics are V2-native:
 *
 * - ask routes through the V2 permission flow. The settle fiber's ambient context carries the
 *   Location runner's `PermissionV2`, read at execution time; a denial/rejection degrades to a
 *   typed `ToolFailure` result the model sees — never a die inside settle.
 * - metadata persists through the Core durable channels: the settled structured output carries
 *   the plugin's `title`/`metadata`/`attachments` onto the `Tool.Success` event, and live
 *   `ctx.metadata` updates publish `Tool.Progress` events through the ambient `EventV2` service.
 * - abort derives from the live execution fiber: cancelling the parent turn interrupts the
 *   settle fiber, the `Effect.callback` signal fires `ctx.abort` immediately, and the inner run
 *   is discarded (`runCallback` interruption).
 * - messages stays empty by design: Core's dynamic `Tool.Context` carries no history, and the
 *   plugin-facing `@deepagent-code/plugin` `ToolContext` type does not expose `messages` at all
 *   (the V1 wrapper only spreads the field through). Rebuilding a V1 history projection here
 *   would be new legacy adaptation.
 *
 * Registration is INSTANCE-scoped like the MCP bridge: register on instance boot, detach the
 * batch on instance dispose; installs/refreshes after boot re-register on the next instance
 * load. An id that cannot satisfy Core name validation is skipped (charset sanitization first).
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const applications = yield* ApplicationTools.Service
    const instanceRegistry = yield* InstanceRegistry.Service

    instanceRegistry.registerInitializer((context) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const custom = yield* registry.custom().pipe(Effect.provideService(InstanceRef, context))
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
                  Effect.gen(function* () {
                    // The settle fiber's ambient context IS the V2 execution context (the
                    // Location runner carries PermissionV2/EventV2). Captured so the V1 def's
                    // Effect — run through its own runCallback below — still resolves those
                    // services when ask/metadata execute inside plugin code.
                    const ambient = yield* Effect.context<never>()
                    const controller = new AbortController()
                    return yield* Effect.callback<unknown, ToolFailure>((resume, signal) => {
                      // Interruption of the settle fiber must reach plugin JS immediately: the
                      // fiber signal aborts the controller that backs ctx.abort, while the inner
                      // runCallback discards the V1 wrapper's eventual result.
                      const abort = () => controller.abort(signal.reason)
                      if (signal.aborted) abort()
                      else signal.addEventListener("abort", abort, { once: true })
                      const detach = () => signal.removeEventListener("abort", abort)
                      const stop = Effect.runCallback(
                        (
                          def.execute as (
                            args: unknown,
                            ctx: V1Tool.Context,
                          ) => Effect.Effect<V1Tool.ExecuteResult, unknown>
                        )(input, bridgeContext(callContext, controller.signal)).pipe(
                          Effect.mapError(
                            (error) =>
                              new ToolFailure({
                                message: `Plugin tool ${def.id} failed: ${
                                  (error as { message?: string }).message ?? String(error)
                                }`,
                              }),
                          ),
                          Effect.map(structuredResult),
                          Effect.provide(ambient),
                        ),
                        {
                          signal,
                          onExit: (exit) => {
                            detach()
                            resume(exit._tag === "Success" ? Effect.succeed(exit.value) : Effect.failCause(exit.cause))
                          },
                        },
                      )
                      return Effect.sync(() => {
                        detach()
                        stop()
                      })
                    })
                  }),
                toModelOutput: modelOutput,
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

const bridgeContext = (context: Tool.Context, abort: AbortSignal): V1Tool.Context => ({
  sessionID: SessionID.make(context.sessionID),
  messageID: MessageID.make(context.assistantMessageID),
  agent: String(context.agent),
  abort,
  callID: context.toolCallID,
  // Inert by design: the plugin-facing ToolContext type has no `messages`, and Core's dynamic
  // tool seam has no history channel — see the module doc.
  messages: [] as SessionV1.WithParts[],
  metadata: (value) =>
    Effect.gen(function* () {
      const events = Option.getOrUndefined(yield* Effect.serviceOption(EventV2.Service))
      if (!events) {
        // Dropped loudly, never silently: outside a V2 execution context there is no EventV2
        // authority to persist a running-tool update through.
        return yield* Effect.logWarning(
          "plugin tool metadata update dropped: no EventV2 authority in this execution context",
          { tool: context.toolCallID },
        )
      }
      yield* events
        .publish(SessionEvent.Tool.Progress, {
          sessionID: context.sessionID,
          timestamp: DateTime.makeUnsafe(Date.now()),
          assistantMessageID: context.assistantMessageID,
          callID: context.toolCallID,
          structured: isRecord(value.metadata) ? value.metadata : {},
          content: value.title === undefined ? [] : [{ type: "text" as const, text: value.title }],
        })
        .pipe(
          // A failed live update must not fail the tool run: the settled structured output
          // remains the durable metadata authority.
          Effect.catchCause((cause) =>
            Effect.logWarning("plugin tool metadata update failed", {
              tool: context.toolCallID,
              cause,
            }),
          ),
        )
    }),
  // The V1 Context.ask contract declares no failure channel, but a denial MUST surface as a
  // typed failure (caught by the bridge's mapError into a ToolFailure) rather than a die — the
  // runtime error channel is real; only the declared return type is widened to fit the V1 shape.
  ask: (request) => askThroughV2(request, context) as Effect.Effect<void>,
})

/** V1-parity denial vocabulary on a typed failure channel: the plugin's ask fails, the
 * wrapper's execute fails, and settle records a ToolFailure result — never a die. */
function askThroughV2(
  request: Parameters<V1Tool.Context["ask"]>[0],
  context: Tool.Context,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const permission = Option.getOrUndefined(yield* Effect.serviceOption(PermissionV2.Service))
    if (!permission)
      return yield* Effect.fail(
        new Error(`Custom tool ask for "${request.permission}" ran outside a V2 permission authority context`),
      )
    yield* permission
      .assert({
        action: request.permission,
        resources: request.patterns,
        ...(request.always.length > 0 ? { save: request.always } : {}),
        metadata: isRecord(request.metadata) ? request.metadata : {},
        source: {
          type: "tool",
          messageID: context.assistantMessageID,
          callID: context.toolCallID,
        },
        sessionID: context.sessionID,
        agent: context.agent,
      })
      .pipe(Effect.catch((error) => Effect.fail(new Error(deniedMessage(error)))))
  })
}

/** The durable Tool.Success structured payload: the plugin's own result fields ride intact. */
const structuredResult = (result: V1Tool.ExecuteResult): Record<string, unknown> => ({
  output: result.output,
  ...(result.title ? { title: result.title } : {}),
  ...(isRecord(result.metadata) && Object.keys(result.metadata).length > 0 ? { metadata: result.metadata } : {}),
  ...(result.attachments?.length ? { attachments: result.attachments } : {}),
})

const modelOutput = ({ output }: { readonly output: unknown }): ReadonlyArray<Tool.Content> => {
  const result = output as V1Tool.ExecuteResult
  return [
    { type: "text" as const, text: String(result.output) },
    ...(result.attachments ?? []).flatMap((attachment) => {
      const match = /^data:([^;,]+);base64,(.+)$/.exec(attachment.url)
      return [
        {
          type: "file" as const,
          source: match
            ? { type: "data" as const, data: match[2] }
            : attachment.url.startsWith("file:")
              ? { type: "file" as const, uri: attachment.url }
              : { type: "url" as const, url: attachment.url },
          mime: attachment.mime,
          ...(attachment.filename ? { name: attachment.filename } : {}),
        },
      ]
    }),
  ]
}

function deniedMessage(error: unknown) {
  if (error instanceof PermissionV2.RejectedError) return "The user rejected permission to use this specific tool call."
  if (error instanceof PermissionV2.CorrectedError)
    return `The user rejected permission to use this specific tool call with the following feedback: ${error.feedback}`
  if (error instanceof PermissionV2.DeniedError)
    return `The user has specified a rule which prevents you from using this specific tool call. ${JSON.stringify(error.rules)}`
  return `Permission ask failed: ${error instanceof Error ? error.message : String(error)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
