import { describe, expect, test } from "bun:test"
import { createNotificationJournalSubscription } from "./notification-journal"

// C6-07 — the notification feed replacement on the durable drain: the per-session
// journals of the active directory drive idle/error notifications with a stable
// directory mapping; anchors set at the session watermark (first subscribe) or the
// last seen seq (rebuild) so nothing re-replays history; a typed 410 resync forces a
// rebuild past the set-equality guard; dispose stops every poll loop.

type EventRow = { id: string; seq: number; type: string; data?: Record<string, unknown> }
const gapError = { name: "ApiGone", data: { code: "cursor_gap_exceeded", httpStatus: 410 } }

const fakeDrain = () => {
  const watermarks = new Map<string, number>()
  const rows = new Map<string, EventRow[]>()
  const drains: { session_id: string; after: number }[] = []
  const closed: string[] = []
  let gapNext = false
  const client = {
    context: {
      eventsCursor: async ({ session_id }: { session_id: string }) => ({
        data: { watermark: watermarks.get(session_id) ?? 0, cursor: 0, floor: 0 },
        error: undefined,
        response: undefined,
      }),
      events: async ({ session_id, after }: { session_id: string; after: string }) => {
        drains.push({ session_id, after: Number(after) })
        if (gapNext) {
          gapNext = false
          return { data: undefined, error: gapError, response: undefined }
        }
        const events = (rows.get(session_id) ?? []).filter((row) => row.seq > Number(after))
        return {
          data: { events, nextCursor: events.at(-1)?.seq ?? Number(after), floor: 0 },
          error: undefined,
          response: undefined,
        }
      },
    },
  }
  return {
    client,
    watermarks,
    rows,
    drains,
    closed,
    emitGap: () => (gapNext = true),
  }
}

describe("notification journal subscription (durable drain)", async () => {
  test("subscribes the active directory sessions anchored at the watermark and routes idle/error", async () => {
    const fake = fakeDrain()
    fake.watermarks.set("ses-1", 7)
    fake.watermarks.set("ses-2", 9)
    fake.rows.set("ses-1", [{ id: "e1", seq: 8, type: "session.execution.succeeded", data: { sessionID: "ses-1" } }])
    fake.rows.set("ses-2", [
      { id: "e2", seq: 10, type: "session.execution.failed", data: { sessionID: "ses-2", error: { type: "unknown", message: "boom" } } },
    ])
    const idle: string[] = []
    const errors: string[] = []
    const journal = createNotificationJournalSubscription({
      client: fake.client,
      currentDirectory: () => "/workspace",
      sessionsOf: (directory) => (directory === "/workspace" ? ["ses-1", "ses-2"] : []),
      handlers: {
        onIdle: (directory, sessionID, time) => idle.push(`${directory}:${sessionID}:${time}`),
        onError: (directory, sessionID, error, time) =>
          errors.push(`${directory}:${sessionID}:${(error as { message: string }).message}`),
      },
    })

    journal.refresh()
    await Bun.sleep(30)
    const first = fake.drains.filter((d) => d.session_id === "ses-1")
    expect(first[0]?.after).toBe(7) // anchored at the watermark
    expect(fake.drains.filter((d) => d.session_id === "ses-2")[0]?.after).toBe(9)
    expect(idle).toHaveLength(1)
    expect(idle[0]?.startsWith("/workspace:ses-1")).toBe(true)
    expect(errors).toEqual(["/workspace:ses-2:boom"])
    journal.dispose()
  })

  test("rebuild anchors at the last seen seq instead of re-replaying history", async () => {
    const fake = fakeDrain()
    fake.watermarks.set("ses-1", 7)
    fake.watermarks.set("ses-2", 0)
    fake.rows.set("ses-1", [{ id: "e1", seq: 8, type: "session.execution.started", data: { sessionID: "ses-1" } }])
    let sessions: string[] = ["ses-1"]
    const journal = createNotificationJournalSubscription({
      client: fake.client,
      currentDirectory: () => "/workspace",
      sessionsOf: () => sessions,
      handlers: { onIdle: () => {}, onError: () => {} },
    }, 5)

    journal.refresh()
    await Bun.sleep(30)
    expect(fake.drains.filter((d) => d.session_id === "ses-1")[0]?.after).toBe(7)
    const drainsBefore = fake.drains.length

    sessions = ["ses-1", "ses-2"]
    journal.refresh()
    await Bun.sleep(30)
    const ses1Drains = fake.drains.filter((d) => d.session_id === "ses-1").slice(drainsBefore)
    expect(ses1Drains[0]?.after).toBe(8) // rebuild uses last seen seq (8), not the watermark (7)
    expect(fake.drains.filter((d) => d.session_id === "ses-2")[0]?.after).toBe(0)
    journal.dispose()
  })

  test("a typed 410 gap forces a rebuild past the set-equality guard", async () => {
    const fake = fakeDrain()
    fake.watermarks.set("ses-1", 7)
    fake.rows.set("ses-1", [{ id: "e1", seq: 9, type: "session.execution.started", data: { sessionID: "ses-1" } }])
    const journal = createNotificationJournalSubscription({
      client: fake.client,
      currentDirectory: () => "/workspace",
      sessionsOf: () => ["ses-1"],
      handlers: { onIdle: () => {}, onError: () => {} },
    }, 5)

    journal.refresh()
    await Bun.sleep(30)
    const before = fake.drains.filter((d) => d.session_id === "ses-1").length
    expect(before).toBeGreaterThan(0)

    fake.emitGap() // the next drain answers 410 cursor_gap_exceeded
    await Bun.sleep(30)
    const afterGap = fake.drains.filter((d) => d.session_id === "ses-1")
    expect(afterGap.length).toBeGreaterThan(before) // a rebuild happened (re-anchored at last seq 9)
    expect(afterGap.at(-1)?.after).toBe(9)
    journal.dispose()
  })

  test("drops the subscription when the directory becomes unknown", async () => {
    const fake = fakeDrain()
    let directory: string | undefined = "/workspace"
    const journal = createNotificationJournalSubscription({
      client: fake.client,
      currentDirectory: () => directory,
      sessionsOf: () => ["ses-1"],
      handlers: { onIdle: () => {}, onError: () => {} },
    }, 5)

    journal.refresh()
    await Bun.sleep(30)
    const before = fake.drains.length
    expect(before).toBeGreaterThan(0)

    directory = undefined
    journal.refresh()
    await Bun.sleep(30)
    expect(fake.drains.length).toBe(before) // no further drains — stopped
    journal.dispose()
  })
})
