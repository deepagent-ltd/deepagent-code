export * as ReplyParts from "./reply-parts"

import type { SessionMessage } from "../session/message"

export const LIMIT = 60_000
export const text = (message: SessionMessage.Message) => {
  if (message.type !== "assistant") return undefined
  const value = message.content
    .filter((part): part is SessionMessage.AssistantText => part.type === "text")
    .map((part) => part.text)
    .filter((part) => part.trim().length > 0)
    .join("\n\n")
  return value.length ? value : undefined
}

// Collection and receipt verification share the exact escaped UTF-8 boundary.
// A verifier counts ranges only; transport authority always comes from stored custody.
export function* ranges(text: string) {
  let start = 0
  let offset = 0
  let bytes = 0
  for (const character of text) {
    const size = Buffer.byteLength(JSON.stringify(character)) - 2
    if (bytes + size > LIMIT) {
      yield { start, end: offset }
      start = offset
      bytes = 0
    }
    bytes += size
    offset += character.length
  }
  if (offset > start) yield { start, end: offset }
}
