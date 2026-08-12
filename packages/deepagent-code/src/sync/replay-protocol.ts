import { EventV2 } from "@deepagent-code/core/event"

export const SyncReplayLimits = {
  events: EventV2.AGGREGATE_READ_BATCH_EVENTS,
  eventDataBytes: EventV2.AGGREGATE_READ_BATCH_BYTES,
  eventsBytes: EventV2.AGGREGATE_READ_BATCH_BYTES + 1024 * 1024,
  requestBytes: EventV2.AGGREGATE_READ_BATCH_BYTES + 1024 * 1024 + 64 * 1024,
  directoryCharacters: 4_096,
  eventIDCharacters: 200,
  aggregateIDCharacters: 4_096,
  typeCharacters: 256,
} as const

type ReplayEvent = Pick<EventV2.SerializedEvent, "id" | "aggregateID" | "seq" | "type" | "data">

export function encodeReplayRequestPrefix(directory: string, events: readonly ReplayEvent[]) {
  const prefix = `{"directory":${JSON.stringify(directory)},"events":[`
  const suffix = "]}"
  const prefixBytes = Buffer.byteLength(prefix)
  const suffixBytes = Buffer.byteLength(suffix)
  const selected = events.reduce<{
    events: ReplayEvent[]
    encoded: string[]
    dataBytes: number
    contentBytes: number
    closed: boolean
  }>(
    (result, event) => {
      if (result.closed) return result
      const encoded = JSON.stringify(event)
      const dataBytes = result.dataBytes + Buffer.byteLength(JSON.stringify(event.data))
      const contentBytes = result.contentBytes + Buffer.byteLength(encoded) + (result.encoded.length ? 1 : 0)
      const eventsBytes = contentBytes + 2
      const requestBytes = prefixBytes + contentBytes + suffixBytes
      if (
        dataBytes > SyncReplayLimits.eventDataBytes ||
        eventsBytes > SyncReplayLimits.eventsBytes ||
        requestBytes > SyncReplayLimits.requestBytes
      )
        return { ...result, closed: true }
      return {
        events: [...result.events, event],
        encoded: [...result.encoded, encoded],
        dataBytes,
        contentBytes,
        closed: false,
      }
    },
    { events: [], encoded: [], dataBytes: 0, contentBytes: 0, closed: false },
  )
  const eventsBytes = selected.contentBytes + 2
  const requestBytes = prefixBytes + selected.contentBytes + suffixBytes
  return {
    events: selected.events,
    json: prefix + selected.encoded.join(",") + suffix,
    dataBytes: selected.dataBytes,
    eventsBytes,
    requestBytes,
    complete: selected.events.length === events.length,
  }
}
