import type { Message } from "@deepagent-code/sdk"

/** The sync store stays ID-indexed. Only this view follows durable Session promotion order;
 * stable hashed IM input IDs and their earlier admission times are not chronology. */
export function sessionMessageView<T extends { id: string; time: { created: number }; canonicalSeq?: number }>(
  messages: readonly T[],
) {
  const canonical = messages.some((message) => message.canonicalSeq !== undefined)
  return messages.toSorted(
    (a, b) =>
      (canonical ? (a.canonicalSeq ?? Infinity) - (b.canonicalSeq ?? Infinity) : 0) ||
      a.time.created - b.time.created ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

export function pendingAssistantIndex(messages: readonly Message[]) {
  const completed = messages.findLastIndex((message) => message.role === "assistant" && !!message.time.completed)
  const pending = messages.findLastIndex(
    (message, index) => message.role === "assistant" && !message.time.completed && index > completed,
  )
  return pending < 0 ? undefined : pending
}

/** A revert boundary is an identity lookup, never a lexical comparison. An unloaded or
 * foreign boundary selects nothing so partial history cannot undo/hide unrelated turns. */
export function sessionMessageBoundary(messages: readonly { id: string }[], boundaryID?: string) {
  const positions = new Map(messages.map((message, index) => [message.id, index]))
  const boundary = boundaryID === undefined ? undefined : positions.get(boundaryID)
  return {
    before: (id: string) =>
      boundaryID === undefined || (boundary !== undefined && (positions.get(id) ?? Infinity) < boundary),
    after: (id: string) => boundary !== undefined && (positions.get(id) ?? -1) > boundary,
    atOrAfter: (id: string) => boundary !== undefined && (positions.get(id) ?? -1) >= boundary,
  }
}
