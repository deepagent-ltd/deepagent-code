import { describe, expect, test } from "bun:test"
import {
  openSessionJournal,
  type JournalEventRow,
  type SessionJournalClient,
} from "../../src/context/v2-session-journal"

// §16.5 API-APP-PACKAGE P4 — the snapshot-at-watermark journal drive on the C6-07 durable
// REST drain. The caller reads the high-water cursor first and passes it as after; the drive
// drains context.events from that cursor, forwards journaled boundary events in order,
// resyncs once on a typed 410 cursor_gap (never silently accepting the gap), reports a
// caught-up page as onStreamEnd, and stops delivery on close().

const event = (id: string, seq: number): JournalEventRow => ({
  id,
  type: "session.next.text.ended",
  seq,
  data: { sessionID: "ses-1", textID: "part-1", text: "hello" },
})

const gapError = () => ({ name: "ApiGone", data: { code: "cursor_gap_exceeded", httpStatus: 410 } })

const fakeDrain = (options: {
  cursor?: () => { watermark: number; cursor: number; floor: number } | Promise<{ watermark: number; cursor: number; floor: number }>
  pages?: Array<{ events: JournalEventRow[] } | { error: unknown }>
  opened?: (input: { after: string }) => void
}) => {
  const queue = [...(options.pages ?? [])]
  let cursorCalls = 0
  return {
    cursorCalls: () => cursorCalls,
    client: {
      context: {
        eventsCursor: async ({ session_id }: { session_id: string }) => {
          cursorCalls += 1
          const cursor = await options.cursor?.()
          return { data: cursor ?? { watermark: 0, cursor: 0, floor: 0 }, error: undefined }
        },
        events: async ({ session_id, after }: { session_id: string; after: string }) => {
          options.opened?.({ after })
          const next = queue.shift()
          if (!next) return { data: { events: [], nextCursor: undefined, floor: 0 }, error: undefined }
          if ("error" in next) return { data: undefined, error: next.error, response: undefined }
          return { data: { events: next.events, nextCursor: next.events.at(-1)?.seq, floor: 0 }, error: undefined }
        },
      },
    } as unknown as SessionJournalClient,
  }
}

describe("session journal drive (durable drain)", () => {
  test("opens from the watermark cursor and forwards journal events in order", async () => {
    const events = [event("ev-1", 11), event("ev-2", 12)]
    let openedWith: string | undefined
    const fake = fakeDrain({
      cursor: () => ({ watermark: 10, cursor: 10, floor: 0 }),
      pages: [{ events }],
      opened: (input) => (openedWith = input.after),
    })
    const received: JournalEventRow[] = []
    let resync = 0
    const open = await openSessionJournal(fake.client, "ses-1", {
      after: "10",
      onEvent: (e) => received.push(e),
      onResync: () => (resync += 1),
      onStreamEnd: () => {},
    })
    await Bun.sleep(10)
    expect(openedWith).toBe("10")
    expect(received).toEqual(events)
    expect(resync).toBe(0)
    open.close()
  })

  test("fires onResync once on a typed 410 gap and stops forwarding", async () => {
    const fake = fakeDrain({
      cursor: () => ({ watermark: 10, cursor: 10, floor: 0 }),
      pages: [{ error: gapError() }, { events: [event("ev-2", 13)] }],
    })
    const received: JournalEventRow[] = []
    let resync = 0
    const open = await openSessionJournal(fake.client, "ses-1", {
      after: "10",
      onEvent: (e) => received.push(e),
      onResync: () => (resync += 1),
      onStreamEnd: () => {},
    })
    await Bun.sleep(10)
    expect(resync).toBe(1)
    expect(received).toEqual([])
    open.close()
  })

  test("opens from the journal head when no watermark is available", async () => {
    let openedWith: string | undefined
    const fake = fakeDrain({
      cursor: () => ({ watermark: 0, cursor: 0, floor: 0 }),
      pages: [{ events: [] }],
      opened: (input) => (openedWith = input.after),
    })
    const open = await openSessionJournal(fake.client, "ses-1", {
      onEvent: () => {},
      onResync: () => {},
      onStreamEnd: () => {},
    })
    await Bun.sleep(10)
    expect(openedWith).toBe("0")
    expect(() => open.close()).not.toThrow()
  })

  test("reports a caught-up page via onStreamEnd once", async () => {
    const fake = fakeDrain({
      cursor: () => ({ watermark: 10, cursor: 10, floor: 0 }),
      pages: [{ events: [event("ev-1", 11)] }],
    })
    const received: JournalEventRow[] = []
    let ended = 0
    const open = await openSessionJournal(fake.client, "ses-1", {
      after: "10",
      onEvent: (e) => received.push(e),
      onResync: () => {},
      onStreamEnd: () => (ended += 1),
      pollMs: 5,
    })
    await Bun.sleep(20)
    expect(ended).toBe(1)
    expect(received).toHaveLength(1)
    open.close()
  })

  test("close() stops delivery; duplicate seqs are absorbed", async () => {
    const fake = fakeDrain({
      cursor: () => ({ watermark: 10, cursor: 10, floor: 0 }),
      pages: [
        { events: [event("ev-1", 11), event("ev-1", 11)] },
        { events: [event("ev-2", 12)] },
      ],
    })
    const received: JournalEventRow[] = []
    const open = await openSessionJournal(fake.client, "ses-1", {
      after: "10",
      onEvent: (e) => received.push(e),
      onResync: () => {},
      onStreamEnd: () => {},
    })
    await Bun.sleep(10)
    expect(received).toEqual([event("ev-1", 11)]) // duplicate seq absorbed once
    open.close()
    await Bun.sleep(30) // no further delivery / unhandled rejection
    expect(received).toHaveLength(1)
  })
})
