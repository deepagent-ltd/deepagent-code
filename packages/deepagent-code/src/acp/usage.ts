import type { AgentSideConnection, Usage } from "@agentclientprotocol/sdk"
import * as Log from "@deepagent-code/core/util/log"
import type { AssistantMessage as DeepAgentCodeAssistantMessage, Message } from "@deepagent-code/sdk"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { Provider } from "@/provider/provider"
import { Context, Effect, Layer, SynchronizedRef } from "effect"

const log = Log.create({ service: "acp-usage" })

export type AssistantTokenCost = Pick<DeepAgentCodeAssistantMessage, "cost" | "tokens">

export type AssistantMessage = AssistantTokenCost &
  Pick<DeepAgentCodeAssistantMessage, "role"> &
  Partial<
    Pick<DeepAgentCodeAssistantMessage, "id" | "parentID" | "providerID" | "modelID" | "summary" | "finish" | "error">
  >

type UserMessage = {
  readonly role: "user"
  readonly id?: string
  readonly model?: { readonly providerID: string; readonly modelID: string }
}

export type SessionMessage = {
  readonly info: { readonly role: Message["role"] } | AssistantMessage | UserMessage
  readonly parts?: readonly { readonly type: string; readonly context_tokens?: number }[]
}

export type MessagesInput = {
  readonly sessionID: string
  readonly directory: string
}

export type SDK = {
  readonly session: {
    readonly messages: (
      parameters: { readonly sessionID: string; readonly directory: string },
      options: { readonly throwOnError: true },
    ) => Promise<{ readonly data?: readonly SessionMessage[] | null }>
  }
}

export interface MessageLoaderInterface {
  readonly messages: (input: MessagesInput) => Effect.Effect<readonly SessionMessage[], unknown>
}

export interface ContextLimitLoaderInterface {
  readonly providers: (directory: string) => Effect.Effect<Record<ProviderV2.ID, Provider.Info>, unknown>
}

export type UsageConnection = Pick<AgentSideConnection, "sessionUpdate">

export interface Interface {
  readonly buildUsage: (message: AssistantTokenCost) => Usage
  readonly latestAssistantMessage: (messages: readonly SessionMessage[]) => AssistantMessage | undefined
  readonly totalSessionCost: (messages: readonly SessionMessage[]) => number
  readonly contextLimit: (input: {
    readonly directory: string
    readonly providerID: ProviderV2.ID
    readonly modelID: ModelV2.ID
  }) => Effect.Effect<number | undefined>
  readonly sendUpdate: (input: {
    readonly connection: UsageConnection
    readonly sessionID: string
    readonly directory: string
  }) => Effect.Effect<void>
}

export class MessageLoader extends Context.Service<MessageLoader, MessageLoaderInterface>()(
  "@deepagent-code/ACPUsageMessageLoader",
) {}

export class ContextLimitLoader extends Context.Service<ContextLimitLoader, ContextLimitLoaderInterface>()(
  "@deepagent-code/ACPUsageContextLimitLoader",
) {}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/ACPUsage") {}

export function messageLoaderFromSDK(sdk: SDK): MessageLoaderInterface {
  return MessageLoader.of({
    messages: (input) =>
      Effect.promise(() =>
        sdk.session
          .messages({ sessionID: input.sessionID, directory: input.directory }, { throwOnError: true })
          .then((response) => response.data ?? []),
      ),
  })
}

export const messageLoaderLayer = (sdk: SDK) => Layer.succeed(MessageLoader, messageLoaderFromSDK(sdk))

export function buildUsage(message: AssistantTokenCost): Usage {
  const cachedReadTokens = message.tokens.cache.read
  const cachedWriteTokens = message.tokens.cache.write
  const thoughtTokens = message.tokens.reasoning

  return {
    inputTokens: message.tokens.input,
    outputTokens: message.tokens.output,
    totalTokens: message.tokens.input + message.tokens.output + thoughtTokens + cachedReadTokens + cachedWriteTokens,
    ...(thoughtTokens > 0 ? { thoughtTokens } : {}),
    ...(cachedReadTokens > 0 ? { cachedReadTokens } : {}),
    ...(cachedWriteTokens > 0 ? { cachedWriteTokens } : {}),
  }
}

export function latestAssistantMessage(messages: readonly SessionMessage[]): AssistantMessage | undefined {
  return messages
    .filter((message): message is { readonly info: AssistantMessage } => message.info.role === "assistant")
    .at(-1)?.info
}

export function retainedContext(messages: readonly SessionMessage[]) {
  const reversed = messages.toReversed()
  for (const item of reversed) {
    if (item.info.role !== "assistant") continue
    const message = item.info as AssistantMessage
    if (message.summary && message.finish && !message.error && message.parentID) {
      const parent = messages.find((candidate) => "id" in candidate.info && candidate.info.id === message.parentID)
      const marker = parent?.parts?.find((part) => part.type === "compaction" && part.context_tokens !== undefined)
      if (marker?.context_tokens !== undefined) {
        const parentInfo = parent?.info.role === "user" ? (parent.info as UserMessage) : undefined
        return {
          message,
          used: marker.context_tokens,
          providerID: parentInfo?.model?.providerID ?? message.providerID,
          modelID: parentInfo?.model?.modelID ?? message.modelID,
        }
      }
    }
    const used = message.tokens.input + message.tokens.cache.read + message.tokens.cache.write
    if (used <= 0) continue
    return { message, used, providerID: message.providerID, modelID: message.modelID }
  }
}

export function totalSessionCost(messages: readonly SessionMessage[]): number {
  return messages
    .filter((message): message is { readonly info: AssistantMessage } => message.info.role === "assistant")
    .reduce((sum, message) => sum + message.info.cost, 0)
}

export function findContextLimit(
  providers: Record<ProviderV2.ID, Provider.Info>,
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
): number | undefined {
  return providers[providerID]?.models[modelID]?.limit.context
}

export const contextLimitLoaderLayer = Layer.effect(
  ContextLimitLoader,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const provider = yield* Provider.Service

    return ContextLimitLoader.of({
      providers: Effect.fn("ACPUsageContextLimitLoader.providers")(function* (directory) {
        const ctx = yield* store.load({ directory })
        return yield* Effect.gen(function* () {
          return yield* provider.list()
        }).pipe(Effect.provideService(InstanceRef, ctx))
      }),
    })
  }),
)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const messageLoader = yield* MessageLoader
    const contextLimitLoader = yield* ContextLimitLoader
    const limits = yield* SynchronizedRef.make(new Map<string, Effect.Effect<number | undefined>>())

    const cachedLimit = Effect.fnUntraced(function* (input: {
      readonly directory: string
      readonly providerID: ProviderV2.ID
      readonly modelID: ModelV2.ID
    }) {
      return yield* SynchronizedRef.modifyEffect(
        limits,
        Effect.fnUntraced(function* (items) {
          const key = `${input.directory}\u0000${input.providerID}\u0000${input.modelID}`
          const current = items.get(key)
          if (current) return [current, items] as const
          const next = yield* Effect.cached(
            contextLimitLoader.providers(input.directory).pipe(
              Effect.map((providers) => findContextLimit(providers, input.providerID, input.modelID)),
              Effect.catch((error) =>
                Effect.sync(() => {
                  log.error("failed to get providers for usage context limit", { error })
                  return undefined
                }),
              ),
            ),
          )
          return [next, new Map(items).set(key, next)] as const
        }),
      )
    })

    const contextLimit = Effect.fn("ACPUsage.contextLimit")(function* (input: {
      readonly directory: string
      readonly providerID: ProviderV2.ID
      readonly modelID: ModelV2.ID
    }) {
      return yield* yield* cachedLimit(input)
    })

    const sendUpdate = Effect.fn("ACPUsage.sendUpdate")(function* (input: {
      readonly connection: UsageConnection
      readonly sessionID: string
      readonly directory: string
    }) {
      const messages = yield* messageLoader.messages({ sessionID: input.sessionID, directory: input.directory }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            log.error("failed to fetch messages for usage update", { error })
            return undefined
          }),
        ),
      )
      if (!messages) return

      const context = retainedContext(messages)
      if (!context?.providerID || !context.modelID) return

      const size = yield* contextLimit({
        directory: input.directory,
        providerID: ProviderV2.ID.make(context.providerID),
        modelID: ModelV2.ID.make(context.modelID),
      })
      if (!size) return

      yield* Effect.promise(() =>
        input.connection
          .sessionUpdate({
            sessionId: input.sessionID,
            update: {
              sessionUpdate: "usage_update",
              used: context.used,
              size,
              cost: { amount: totalSessionCost(messages), currency: "USD" },
            },
          })
          .catch((error) => {
            log.error("failed to send usage update", { error })
          }),
      )
    })

    return Service.of({
      buildUsage,
      latestAssistantMessage,
      totalSessionCost,
      contextLimit,
      sendUpdate,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(contextLimitLoaderLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(InstanceStore.defaultLayer),
)

export * as UsageService from "./usage"
