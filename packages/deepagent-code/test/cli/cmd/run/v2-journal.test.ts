import { describe, expect, test } from "bun:test"
import type { SessionEventPayload } from "@deepagent-code/sdk/v2/client"
import { openRunJournal, type RunJournalClient } from "../../../../src/session-v2-journal"

// §16.5 API-APP-PACKAGE P4 — the run-loop journal drive. It owns the seq-gap contract: a
// non-consecutive seq closes the frame and asks for a head resync (never silently accepts),
// a completed frame reports stream end, and close() stops delivery immediately.

const event = (id: string, seq: number): SessionEventPayload => ({
  id,
  type: "session.next.text.ended",
  seq,
  data: { sessionID: "ses-1", textID: "part-1", text: "hello" },
})

const fakeClient = (options: {
  stream: AsyncGenerator<SessionEventPayload>
  opened?: (input: { readonly after?: string }) => void
}): RunJournalClient & { closeCalls: () => number } => {
  let closes = 0
  return {
    closeCalls: () => closes,
    sessionEventWatermark: async () => 10,
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

describe("run journal drive", () => {
  test("opens with the run-start watermark and forwards ordered boundary events", async () => {
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
    let ended = 0
    const journal = await openRunJournal(client, "ses-1", {
      after: "10",
      onEvent: (item) => received.push(item),
      onResync: () => (resync += 1),
      onStreamEnd: () => (ended += 1),
    })
    await journal.done
    expect(openedWith).toBe("10")
    expect(received).toEqual(events)
    expect(resync).toBe(0)
    expect(ended).toBe(1)
    journal.close()
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
    let ended = 0
    const journal = await openRunJournal(client, "ses-1", {
      onEvent: (item) => received.push(item),
      onResync: () => (resync += 1),
      onStreamEnd: () => (ended += 1),
    })
    await journal.done
    expect(resync).toBe(1)
    expect(ended).toBe(0)
    expect(received).toEqual([event("ev-1", 11)])
    journal.close()
  })

  test("close() stops delivery and resolves done", async () => {
    const client = fakeClient({
      stream: (async function* () {
        let seq = 1000
        while (true) {
          yield event("ev-loop", seq++)
          await Bun.sleep(1)
        }
      })(),
    })
    const received: SessionEventPayload[] = []
    const journal = await openRunJournal(client, "ses-1", {
      onEvent: (item) => received.push(item),
      onResync: () => {},
      onStreamEnd: () => {},
    })
    await Bun.sleep(10)
    journal.close()
    await journal.done
    const before = received.length
    await Bun.sleep(10)
    expect(received.length).toBe(before)
    expect(client.closeCalls()).toBe(1)
  })
})