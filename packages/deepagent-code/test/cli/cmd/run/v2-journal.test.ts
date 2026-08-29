import { describe, expect, test } from "bun:test"
import type { ContextSessionEvent } from "@deepagent-code/sdk"
import { openRunJournal, type RunJournalClient } from "../../../../src/session-v2-journal"

// §16.5 API-APP-PACKAGE P4 — the run-loop journal drive on the durable cursor surface. It owns the
// resync contract against the generated `context.events` API: a typed 410 (`cursor_gap_exceeded`)
// re-reads the cursor and re-drains from the floor (bounded to one resync), a caught-up page fires
// `onStreamEnd` once, and close() stops delivery and resolves `done`.

const event = (id: string, seq: number): ContextSessionEvent => ({
  id,
  type: "session.next.text.ended",
  seq,
  data: { sessionID: "ses-1", textID: "part-1", text: "hello" },
})

type Page = { readonly events: readonly ContextSessionEvent[]; readonly nextCursor?: number; readonly floor: number }

const callEvents =
  (pages: Array<Page | (() => Promise<Page>)>, onAfter?: (after: string | undefined) => void) =>
  async (_sessionId: string, input?: { after?: string; limit?: string }): Promise<Page> => {
    onAfter?.(input?.after)
    const next = pages.shift()
    if (!next) return { events: [], floor: 5 }
    return typeof next === "function" ? next() : next
  }

const waitFor = async (check: () => boolean | Promise<boolean>, message: string, timeoutMs = 2000) => {
  const started = Date.now()
  while (true) {
    if (await check()) return
    if (Date.now() - started > timeoutMs) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe("run journal drive (durable cursor)", () => {
  test("opens with the initial cursor and forwards ordered boundary events", async () => {
    const pages = [
      { events: [event("ev-1", 11), event("ev-2", 12)], nextCursor: 12, floor: 5 },
      { events: [], floor: 5 },
    ]
    const callsAfter: (string | undefined)[] = []
    const client: RunJournalClient = {
      eventsCursor: async () => ({ watermark: 10, cursor: 10, floor: 5 }),
      events: callEvents(pages, (after) => callsAfter.push(after)),
    }
    const received: ContextSessionEvent[] = []
    let resync = 0
    let ended = 0
    const journal = await openRunJournal(client, "ses-1", {
      onEvent: (item) => received.push(item),
      onResync: () => (resync += 1),
      onStreamEnd: () => (ended += 1),
    })
    // The initial drain must start at the durable cursor (hydrate at watermark, then drain after).
    await waitFor(() => callsAfter.length >= 2, "initial drain did not start")
    expect(callsAfter[0]).toBe("10")
    await waitFor(() => ended === 1, "caught-up stream end did not fire")
    expect(received).toEqual([event("ev-1", 11), event("ev-2", 12)])
    expect(resync).toBe(0)
    journal.close()
    await journal.done
  })

  test("a 410 cursor_gap resync re-reads the cursor and re-drains from the floor", async () => {
    const client: RunJournalClient = {
      eventsCursor: async () => ({ watermark: 20, cursor: 20, floor: 5 }),
      events: callEvents([
        () => Promise.reject(gapError()),
        { events: [event("ev-1", 6)], nextCursor: 6, floor: 5 },
        { events: [], floor: 5 },
      ]),
    }
    const received: ContextSessionEvent[] = []
    let resync = 0
    let errored = 0
    const journal = await openRunJournal(client, "ses-1", {
      onEvent: (item) => received.push(item),
      onResync: () => (resync += 1),
      onStreamEnd: () => {},
      onError: () => (errored += 1),
    })
    await waitFor(() => received.length === 1, "resync did not re-drain events")
    expect(resync).toBe(1)
    expect(received).toEqual([event("ev-1", 6)])
    expect(errored).toBe(0)
    journal.close()
    await journal.done
  })

  test("close() stops delivery and resolves done", async () => {
    let seq = 1000
    const client: RunJournalClient = {
      eventsCursor: async () => ({ watermark: 999, cursor: 999, floor: 5 }),
      events: async () => ({ events: [event("ev-loop", seq++)], nextCursor: seq, floor: 5 }),
    }
    const received: ContextSessionEvent[] = []
    const journal = await openRunJournal(client, "ses-1", {
      onEvent: (item) => received.push(item),
      onResync: () => {},
      onStreamEnd: () => {},
    })
    await waitFor(() => received.length > 0, "first event did not arrive")
    journal.close()
    await journal.done
    const before = received.length
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(received.length).toBe(before)
  })
})

function gapError(): unknown {
  const body = {
    name: "ApiGone",
    data: {
      schemaVersion: "stable-error.v1",
      code: "cursor_gap_exceeded",
      category: "cursor",
      httpStatus: 410,
      resource: "ses-1",
      correlationId: "corr",
      message: "cursor below retained floor",
    },
  }
  return new Error("cursor below retained floor", { cause: { body } })
}
