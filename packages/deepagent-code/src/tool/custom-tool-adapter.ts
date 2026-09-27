import { DateTime, Effect, Option } from "effect"
import { ToolFailure } from "@deepagent-code/llm"
import { Tool } from "@deepagent-code/core/tool/tool"
import { EventV2 } from "@deepagent-code/core/event"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { SessionEvent } from "@deepagent-code/core/session/event"
import type { SessionV1 } from "@deepagent-code/core/v1/session"
import { SessionID, MessageID } from "@/session/schema"
import type { Def, ExecuteResult } from "@/tool/tool"

// Core names are a stable, bounded wire vocabulary. Sanitization preserves the existing plugin
// bridge behavior; a name still failing validation is rejected before registration.
export function customToolName(id: string) {
  const name = id.replace(/[^A-Za-z0-9_-]/g, "_")
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) ? name : undefined
}

export function adaptCustomTool(def: Def): Tool.AnyTool | undefined {
  if (!customToolName(def.id)) return undefined
  return Tool.withPermission(
    Tool.makeDynamic({
      description: (def.description ?? def.id).slice(0, 1024),
      inputJsonSchema: (def.jsonSchema as Record<string, unknown> | undefined) ?? {
        type: "object",
        properties: {},
      },
      execute: (input, callContext) =>
        Effect.gen(function* () {
          // The settle fiber carries the Location runner's PermissionV2 and EventV2 services.
          // The plugin body runs through its V1 wrapper but retains those ambient authorities.
          const ambient = yield* Effect.context<never>()
          const controller = new AbortController()
          return yield* Effect.callback<unknown, ToolFailure>((resume, signal) => {
            const abort = () => controller.abort(signal.reason)
            if (signal.aborted) abort()
            else signal.addEventListener("abort", abort, { once: true })
            const detach = () => signal.removeEventListener("abort", abort)
            const stop = Effect.runCallback(
              (def.execute as (
                args: unknown,
                ctx: import("@/tool/tool").Context,
              ) => Effect.Effect<ExecuteResult, unknown>)(input, bridgeContext(callContext, controller.signal)).pipe(
                Effect.mapError(
                  (error) =>
                    new ToolFailure({
                      message: `Plugin tool ${def.id} failed: ${(error as { message?: string }).message ?? String(error)}`,
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

const bridgeContext = (context: Tool.Context, abort: AbortSignal): import("@/tool/tool").Context => ({
  sessionID: SessionID.make(context.sessionID),
  messageID: MessageID.make(context.assistantMessageID),
  agent: String(context.agent),
  abort,
  callID: context.toolCallID,
  // Core's dynamic context has no V1 history; the public plugin context has no messages field.
  messages: [] as SessionV1.WithParts[],
  metadata: (value) =>
    Effect.gen(function* () {
      const events = Option.getOrUndefined(yield* Effect.serviceOption(EventV2.Service))
      if (!events)
        return yield* Effect.logWarning(
          "plugin tool metadata update dropped: no EventV2 authority in this execution context",
          { tool: context.toolCallID },
        )
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
          Effect.catchCause((cause) =>
            Effect.logWarning("plugin tool metadata update failed", { tool: context.toolCallID, cause }),
          ),
        )
    }),
  // V1 declares no failure channel, but V2 permission denial must be a typed tool failure.
  ask: (request) => askThroughV2(request, context) as Effect.Effect<void>,
})

function askThroughV2(
  request: Parameters<import("@/tool/tool").Context["ask"]>[0],
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

const structuredResult = (result: ExecuteResult): Record<string, unknown> => ({
  output: result.output,
  ...(result.title ? { title: result.title } : {}),
  ...(isRecord(result.metadata) && Object.keys(result.metadata).length > 0 ? { metadata: result.metadata } : {}),
  ...(result.attachments?.length ? { attachments: result.attachments } : {}),
})

const modelOutput = ({ output }: { readonly output: unknown }): ReadonlyArray<Tool.Content> => {
  const result = output as ExecuteResult
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
  if (error instanceof PermissionV2.RejectedError)
    return "The user rejected permission to use this specific tool call."
  if (error instanceof PermissionV2.CorrectedError)
    return `The user rejected permission to use this specific tool call with the following feedback: ${error.feedback}`
  if (error instanceof PermissionV2.DeniedError)
    return `The user has specified a rule which prevents you from using this specific tool call. ${JSON.stringify(error.rules)}`
  return `Permission ask failed: ${error instanceof Error ? error.message : String(error)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
