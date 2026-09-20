import { describe, expect, test } from "bun:test"
import { compatibilityEvent } from "@/event-v2-bridge"
import { EventV2 } from "@deepagent-code/core/event"

// Wire-form data exactly as rehydrated from the durable EventTable (epoch millis, not Dates).
const wireCreated = {
  sessionID: "ses_f4035b166fffSaQ9ogW72tLsbR",
  info: {
    id: "ses_f4035b166fffSaQ9ogW72tLsbR",
    projectID: "23236812fd744754301a87c588b742a7160c1900",
    permissions: [],
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1789924101805, updated: 1789924101805 },
    title: "New session - 2026-09-20T17:08:21.805Z",
    location: { directory: "/Users/xiuranli/code/hygon/milvus" },
  },
  slug: "clever-pixel",
  version: "0.0.0-test",
}

describe("outbox egress compatibility (wire-form rehydration)", () => {
  test("decoding via the sync registry restores the legacy info shape with top-level directory", () => {
    const sync = EventV2.syncRegistry.get(EventV2.versionedType("session.created", 2))
    expect(sync).toBeDefined()
    const decoded = sync!.decode(wireCreated)
    const event = compatibilityEvent({
      id: "evt_0bfca4ead000h9f8pjjn815Xpv",
      type: "session.created",
      version: 2,
      seq: 1,
      data: decoded,
    } as Parameters<typeof compatibilityEvent>[0])
    const info = (event.data as { info: { directory?: string } }).info
    expect(info.directory).toBe("/Users/xiuranli/code/hygon/milvus")
  })

  test("undecoded wire form must not silently pass the compatibility guard", () => {
    // Documents the failure mode this suite pins: Schema.is guards validate decoded payloads,
    // so raw wire data falls through compatibilityEvent untouched.
    const event = compatibilityEvent({
      id: "evt_0bfca4ead000h9f8pjjn815Xpv",
      type: "session.created",
      version: 2,
      seq: 1,
      data: wireCreated,
    } as Parameters<typeof compatibilityEvent>[0])
    const info = (event.data as { info: { directory?: string } }).info
    expect(info.directory).toBeUndefined()
  })
})
