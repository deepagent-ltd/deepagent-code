import { Identifier } from "@deepagent-code/core/util/identifier"
import type { Message, Part } from "@deepagent-code/sdk/v2"

const pendingForkIntents = new Map<string, string>()
const pendingForkRequests = new Map<string, Promise<ForkSessionResult>>()

type ForkSessionResult = { sessionID: string } | { error: unknown }

export function isDefaultTitle(title: string) {
  return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)
}

export function acquireForkIntent(key: string) {
  const current = pendingForkIntents.get(key)
  if (current) return current
  const intentID = `fork_${Identifier.ascending()}`
  pendingForkIntents.set(key, intentID)
  return intentID
}

export function completeForkIntent(key: string, intentID: string) {
  if (pendingForkIntents.get(key) !== intentID) return
  pendingForkIntents.delete(key)
}

export function requestSessionFork(input: {
  key: string
  request: (intentID: string) => Promise<{ data?: { id?: string }; error?: unknown }>
}) {
  const current = pendingForkRequests.get(input.key)
  if (current) return current

  const intentID = acquireForkIntent(input.key)
  const pending = Promise.resolve()
    .then(() => input.request(intentID))
    .then(
      (result): ForkSessionResult => {
        if (!result.data?.id) return { error: result.error ?? "server returned no fork session" }
        completeForkIntent(input.key, intentID)
        return { sessionID: result.data.id }
      },
      (error): ForkSessionResult => ({ error }),
    )
    .finally(() => pendingForkRequests.delete(input.key))
  pendingForkRequests.set(input.key, pending)
  return pending
}

export function contextUsage(messages: readonly Message[], parts: (messageID: string) => readonly Part[]) {
  const message = messages.findLast((item) => {
    if (item.role !== "assistant") return false
    if (item.summary && item.finish && !item.error) {
      const marker = parts(item.parentID).find((part) => part.type === "compaction")
      if (marker?.type === "compaction" && marker.context_tokens !== undefined) return true
    }
    return item.tokens.input + item.tokens.cache.read + item.tokens.cache.write > 0
  })
  if (!message || message.role !== "assistant") return

  if (message.summary && message.finish && !message.error) {
    const marker = parts(message.parentID).find((part) => part.type === "compaction")
    if (marker?.type === "compaction" && marker.context_tokens !== undefined) {
      const parent = messages.find(
        (item): item is Extract<Message, { role: "user" }> => item.id === message.parentID && item.role === "user",
      )
      return {
        tokens: marker.context_tokens,
        providerID: parent?.model.providerID ?? message.providerID,
        modelID: parent?.model.modelID ?? message.modelID,
        source: "compaction" as const,
      }
    }
  }

  return {
    tokens: message.tokens.input + message.tokens.cache.read + message.tokens.cache.write,
    providerID: message.providerID,
    modelID: message.modelID,
    source: "provider" as const,
  }
}
