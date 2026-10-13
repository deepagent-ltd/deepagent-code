import { compareMessages, type MessageOrderItem } from "./message-order"

export function displayMessages<T extends MessageOrderItem & { canonicalSeq?: number }>(messages: readonly T[]) {
  const ordered = messages.toSorted(compareMessages)
  const known = ordered
    .filter((message) => Number.isSafeInteger(message.canonicalSeq) && message.canonicalSeq! > 0)
    .toSorted((left, right) => left.canonicalSeq! - right.canonicalSeq!)
  // Legacy messages retain their existing positions; a sequence is never interpreted as an epoch.
  const cursor = { index: 0 }
  return ordered.map((message) =>
    Number.isSafeInteger(message.canonicalSeq) && message.canonicalSeq! > 0 ? known[cursor.index++] : message,
  )
}

export function messageBoundary<T extends MessageOrderItem & { canonicalSeq?: number }>(
  messages: readonly T[],
  id: string,
) {
  const ordered = displayMessages(messages)
  const index = ordered.findIndex((message) => message.id === id)
  if (index < 0) return undefined
  return {
    message: ordered[index],
    visible: ordered.slice(0, index),
    rolled: ordered.slice(index),
    previous: ordered[index - 1],
    next: ordered[index + 1],
  }
}
