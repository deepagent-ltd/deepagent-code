import { describe, expect, test } from "bun:test"
import type { SessionEventPayload } from "@deepagent-code/sdk/v2/client"
import { openSessionJournal, type SessionJournalClient } from "../../src/context/v2-session-journal"

// §16.5 API-APP-PACKAGE P4 — the snapshot-at-watermark journal drive. The caller reads the
// high-water cursor first and passes it as after; the drive opens the durable stream from
// that cursor, forwards journaled boundary events in order, resyncs on a seq gap (never
// silently accepts it), and stops delivery on close().

const event = (id: string, seq: number): SessionEventPayload => ({
  id,
  type: "session.next.text.ended",
  seq,
  data: { sessionID: "ses-1", textID: "part-1", text: "hello" },
})

const fakeClient = (options: {
  stream: AsyncGenerator<SessionEventPayload>
  opened?: (input: { readonly after?: string }) => void
}): SessionJournalClient & { closeCalls: () => number } => {
  let closes = 0
  return {
    closeCalls: () => closes,
    sessionEventStream: async (sessionId, input) => {
      options.opened?.({ after: input.after })
      return {
        stream: options.stream,
        close: () => {
          closes += 1
        },
      }
    },
  }
}

describe("session journal drive", () => {
  test("opens from the watermark cursor and forwards journal events in order", async () => {
    const events = [event("ev-1", 11), event("ev-2", 12)]
    let openedWith: string | undefined
    const client = fakeClient({
      stream: (async function* () {
        for (const item of events) yield item
      })(),
      opened: (input) => (openedWith = input.after),
    })
    const received: SessionEventPayload[] = []
    let resync = 0
    const open = await openSessionJournal(client, "ses-1", {
      after: "10",
      onEvent: (e) => received.push(e),
      onResync: () => (resync += 1),
      onStreamEnd: () => {},
    })
    await Bun.sleep(5)
    expect(openedWith).toBe("10")
    expect(received).toEqual(events)
    expect(resync).toBe(0)
    open.close()
    expect(client.closeCalls()).toBe(1)
  })

  test("fires onResync once on a seq gap and stops forwarding", async () => {
    const client = fakeClient({
      stream: (async function* () {
        yield event("ev-1", 11)
        yield event("ev-2", 13)
        yield event("ev-3", 14)
      })(),
    })
    const received: SessionEventPayload[] = []
    let resync = 0
    const open = await openSessionJournal(client, "ses-1", {
      after: "10",
      onEvent: (e) => received.push(e),
      onResync: () => (resync += 1),
      onStreamEnd: () => {},
    })
    await Bun.sleep(5)
    expect(resync).toBe(1)
    expect(received).toEqual([event("ev-1", 11)])
    open.close()
  })

  test("opens from the journal head when no watermark is available", async () => {
    let openedWith: string | undefined
    const client = fakeClient({
      stream: (async function* () {})(),
      opened: (input) => (openedWith = input.after),
    })
    const open = await openSessionJournal(client, "ses-1", {
      onEvent: () => {},
      onResync: () => {},
      onStreamEnd: () => {},
    })
    expect(openedWith).toBeUndefined()
    expect(() => open.close()).not.toThrow()
  })

  test("reports stream end so the caller can re-run the snapshot-at-watermark cycle", async () => {
    const client = fakeClient({
      stream: (async function* () {
        yield event("ev-1", 11)
      })(),
    })
    const received: SessionEventPayload[] = []
    let ended = 0
    const open = await openSessionJournal(client, "ses-1", {
      after: "10",
      onEvent: (e) => received.push(e),
      onResync: () => {},
      onStreamEnd: () => (ended += 1),
    })
    await Bun.sleep(5)
    expect(ended).toBe(1)
    expect(received).toHaveLength(1)
    open.close()
  })
})

// §16.5 API-APP-PACKAGE P4 consumer contract — the drive is the exact tail of the durable
// journal and forwards every streamed event as-is; absorbing transport-level duplicates is
// the consumer's applied-id set (the TUI sync-v2 duplicate() set and the ACP track()
// applied set implement the same policy). These harnesses drive the REAL journal drive with
// fake streams and apply that policy, asserting single application per boundary id.

// Queued-stream client: each openSessionJournal call pulls the next stream, so the consumer
// loop can be re-driven across resync reopens (the drain+tail overlap window).
const queuedClient = (streams: AsyncGenerator<SessionEventPayload>[]): SessionJournalClient => {
  const queue = [...streams]
  return {
    sessionEventStream: async (sessionId, input) => {
      const next = queue.shift()
      if (!next) throw new Error("sessionEventStream opened beyond the queued streams")
      return { stream: next, close: () => {} }
    },
  }
}

const consumerHarness = (client: SessionJournalClient, options?: { readonly resyncCap?: number }) => {
  const applied = new Set<string>()
  const applications: SessionEventPayload[] = []
  let resyncs = 0
  let opens = 0
  let settle: () => void = () => {}
  const done = new Promise<void>((resolve) => (settle = resolve))
  let journal: { close: () => void } | undefined

  // The consumer loop mirrors sync-v2 resync()/ACP track(): on a gap the drive calls
  // onResync once and stops; the consumer reopens. Applied ids absorb re-delivered
  // boundaries. A bounded resync budget (sync-v2 caps at 5) gives up instead of reopening
  // forever — the journal entry is dropped and the volatile surface continues.
  const openOnce = async () => {
    opens += 1
    journal = await openSessionJournal(client, "ses-1", {
      after: "10",
      onEvent: (event) => {
        if (!event.id || applied.has(event.id)) return
        applied.add(event.id)
        applications.push(event)
      },
      onResync: () => {
        if (resyncs >= (options?.resyncCap ?? Number.POSITIVE_INFINITY)) {
          journal = undefined
          settle()
          return
        }
        resyncs += 1
        void reopen()
      },
      onStreamEnd: () => {
        journal = undefined
        settle()
      },
    })
  }
  const reopen = async () => {
    journal?.close()
    journal = undefined
    await openOnce()
  }
  void openOnce()
  return { applications, done, close: () => journal?.close(), opens: () => opens, resyncs: () => resyncs }
}

describe("session journal consumer idempotency", () => {
  test("absorbs a same-id duplicate boundary delivered back-to-back in the drain+tail window", async () => {
    const duplicate = event("ev-dup", 11)
    const client = queuedClient([
      (async function* () {
        yield duplicate
        yield { ...duplicate, seq: 12 } // transport re-delivers the same boundary with a fresh seq
      })(),
    ])
    const consumer = consumerHarness(client)
    await consumer.done
    expect(consumer.applications.map((item) => item.id)).toEqual(["ev-dup"])
    expect(consumer.resyncs()).toBe(0)
    consumer.close()
  })

  test("resyncs once per open on a same-seq duplicate and absorbs the re-delivered boundary", async () => {
    const duplicate = event("ev-seq", 11)
    const client = queuedClient([
      (async function* () {
        yield duplicate
        yield duplicate // drain+tail overlap re-delivers the same seq: a gap, never a silent double-apply
      })(),
      (async function* () {
        yield duplicate // reopened stream re-delivers the boundary; the applied set absorbs it
      })(),
    ])
    const consumer = consumerHarness(client)
    await consumer.done
    expect(consumer.resyncs()).toBe(1)
    expect(consumer.applications.map((item) => item.id)).toEqual(["ev-seq"])
    consumer.close()
  })

  test("a bounded resync budget (5) converges on the sixth gap without resyncing", async () => {
    const gapStream = () =>
      (async function* () {
        yield event("ev-1", 11)
        yield event("ev-2", 13) // non-consecutive seq: the drive resyncs once and stops
      })()
    const client = queuedClient(Array.from({ length: 6 }, gapStream))
    const consumer = consumerHarness(client, { resyncCap: 5 })
    await consumer.done
    // Gaps 1-5 resynced (reopened); the 6th gap hit the consumer's cap: the journal entry is
    // dropped and the loop settles — no 7th open, and closing the dead handle is a no-op.
    expect(consumer.resyncs()).toBe(5)
    expect(consumer.opens()).toBe(6)
    expect(() => consumer.close()).not.toThrow()
  })
})
