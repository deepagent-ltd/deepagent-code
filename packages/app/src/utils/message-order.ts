import { Binary } from "@deepagent-code/core/util/binary"

// BUG-407-012 root cause B: opaque IDs encode a 36-bit millisecond timestamp that wraps every
// 2^36 ms (~795 days; the 26th wrap happened on 2026-08-14). After a wrap, newly generated
// `msg_00...` IDs sort lexicographically BEFORE older `msg_ff...` IDs, so ID order is no longer
// chronological order. IDs must be treated as pure identity; every timeline sort / binary
// location / "latest" decision uses the compound (time, id) order defined here instead.
//
// - messages order by `time.created` (missing -> 0)
// - parts order by `time.start` (missing -> 0)
// - the tie-break key remains the existing lexicographic ID comparison

export type MessageOrderItem = { id: string; time?: { created?: number } }
// Part `time` shapes differ across variants (`{start}` on text/reasoning, `{created}` on retry,
// absent on tools), so the order item accepts any time shape and reads `start` defensively.
export type PartOrderItem = { id: string; time?: Record<string, unknown> }

// Millisecond epochs fit in 13 digits today; 16 keeps the fixed-width prefix sortable for eons.
const TIME_FIELD_WIDTH = 16

export const compareIDs = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const normalizeTime = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0

export const messageTime = (message: MessageOrderItem) => normalizeTime(message.time?.created)

export const partTime = (part: PartOrderItem) => normalizeTime(part.time?.start as number | undefined)

const timePrefix = (time: number) => String(time).padStart(TIME_FIELD_WIDTH, "0")

// Lexicographic comparison of these keys is exactly the compound (time, id) order, so they can be
// used with key-based Binary.search and with plain string `<`/`>` boundary checks (e.g. revert).
export const messageOrderKey = (message: MessageOrderItem) => timePrefix(messageTime(message)) + message.id

export const partOrderKey = (part: PartOrderItem) => timePrefix(partTime(part)) + part.id

export const compareMessages = (a: MessageOrderItem, b: MessageOrderItem) => {
  const delta = messageTime(a) - messageTime(b)
  if (delta !== 0) return delta < 0 ? -1 : 1
  return compareIDs(a.id, b.id)
}

export const compareParts = (a: PartOrderItem, b: PartOrderItem) => {
  const delta = partTime(a) - partTime(b)
  if (delta !== 0) return delta < 0 ? -1 : 1
  return compareIDs(a.id, b.id)
}

export const searchMessages = <T extends MessageOrderItem>(messages: readonly T[], message: MessageOrderItem) =>
  Binary.search(messages as unknown as MessageOrderItem[], messageOrderKey(message), (item) => messageOrderKey(item))

export const searchParts = <T extends PartOrderItem>(parts: readonly T[], part: PartOrderItem) =>
  Binary.search(parts as unknown as PartOrderItem[], partOrderKey(part), (item) => partOrderKey(item))

// A bare ID carries no time, so it cannot be binary-searched in a (time, id)-ordered array.
// Linear scans are bounded: one session's loaded messages / one message's parts.
export const findMessageIndex = <T extends { id: string }>(messages: readonly T[], id: string) =>
  messages.findIndex((item) => item.id === id)

export const findPartIndex = <T extends { id: string }>(parts: readonly T[], id: string) =>
  parts.findIndex((item) => item.id === id)

// Locate an item by identity without ever duplicating it: prefer the compound-order binary search
// (fast path; also yields the correct insertion index when absent), then fall back to an ID scan
// for the rare case where the stored copy carries a different time field than the incoming one.
export function locateMessage<T extends MessageOrderItem>(
  messages: readonly T[],
  message: MessageOrderItem,
): { found: boolean; index: number } {
  const result = searchMessages(messages, message)
  if (result.found) return result
  const index = findMessageIndex(messages, message.id)
  if (index !== -1) return { found: true, index }
  return result
}

export function locatePart<T extends PartOrderItem>(parts: readonly T[], part: PartOrderItem): {
  found: boolean
  index: number
} {
  const result = searchParts(parts, part)
  if (result.found) return result
  const index = findPartIndex(parts, part.id)
  if (index !== -1) return { found: true, index }
  return result
}
