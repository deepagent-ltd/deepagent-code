import { describe, expect, test } from "bun:test"
import { detectSeqGap } from "../src/v2/client"
import { createDeepAgentCodeClient } from "../src/v2/client"

// §16.5 API-APP-PACKAGE P2+P4 — SDK durable session event cursor primitive. The URL
// builder and gap detector are the client half of the durable cursor contract; the P4
// additions (watermark + fetch-backed journal stream) are what freeze snapshot-at-watermark
// for non-browser consumers.

const baseUrl = "http://localhost:9999"

describe("session event cursor primitive", () => {
  test("builds the session events SSE URL with and without a cursor", () => {
    const client = createDeepAgentCodeClient({ fetch: (() => Promise.resolve(new Response())) as typeof fetch })
    expect(client.session.sessionEventsUrl("ses-1")).toBe("/api/session/ses-1/events")
    expect(client.session.sessionEventsUrl("ses-1", { after: "cur_42" })).toBe(
      "/api/session/ses-1/events?after=cur_42",
    )
  })

  test("detects seq gaps, resets, and duplicates but accepts consecutive events", () => {
    expect(detectSeqGap(undefined, 0)).toBe(false)
    expect(detectSeqGap(0, 1)).toBe(false)
    expect(detectSeqGap(3, 5)).toBe(true)
    expect(detectSeqGap(3, 3)).toBe(true)
    expect(detectSeqGap(3, 2)).toBe(true)
    expect(detectSeqGap(3, undefined)).toBe(false)
  })


  test("subscribes the session cursor EventSource against the client baseUrl (not the page origin)", async () => {
    const captured: Array<{ url: string; closed: boolean; withCredentials: boolean }> = []
    const FakeSource = class {
      url: string
      onmessage: ((message: { data: string }) => void) | undefined
      onerror: ((error: unknown) => void) | undefined
      constructor(url: string | URL, options?: EventSourceInit) {
        this.url = url.toString()
        this.onmessage = undefined
        this.onerror = undefined
        captured.push({ url: this.url, closed: false, withCredentials: options?.withCredentials === true })
      }
      close() {
        captured[0].closed = true
      }
    }
    const previous = globalThis.EventSource
    globalThis.EventSource = FakeSource as unknown as typeof EventSource
    try {
      const client = createDeepAgentCodeClient({
        fetch: (() => Promise.resolve(new Response())) as typeof fetch,
        baseUrl,
      })
      const cursor = client.session.sessionEventCursor("ses-1", { onEvent: () => undefined })
      // The desktop renderer runs on the oc://renderer file protocol; a relative SSE URL would
      // resolve against that page origin and 404. The cursor must resolve against the server.
      expect(cursor.url).toBe("/api/session/ses-1/events")
      expect(captured[0].url).toBe(baseUrl + "/api/session/ses-1/events")
      expect(captured[0].withCredentials).toBe(true)
      cursor.close()
      expect(captured[0].closed).toBe(true)
    } finally {
      globalThis.EventSource = previous
    }
  })

  test("authenticates the session cursor with the client's Basic credentials", () => {
    const captured: string[] = []
    const FakeSource = class {
      onmessage: ((message: { data: string }) => void) | undefined
      onerror: ((error: unknown) => void) | undefined
      constructor(url: string | URL) {
        captured.push(url.toString())
      }
      close() {}
    }
    const previous = globalThis.EventSource
    globalThis.EventSource = FakeSource as unknown as typeof EventSource
    try {
      const token = btoa("deepagent-code:secret")
      const client = createDeepAgentCodeClient({
        fetch: (() => Promise.resolve(new Response())) as typeof fetch,
        baseUrl,
        headers: { Authorization: `Basic ${token}` },
      })
      const cursor = client.session.sessionEventCursor("ses-1", { onEvent: () => undefined })
      expect(cursor.url).toBe("/api/session/ses-1/events")
      expect(new URL(captured[0]).searchParams.get("auth_token")).toBe(token)
    } finally {
      globalThis.EventSource = previous
    }
  })
  test("reads the session journal watermark through the cursor endpoint", async () => {
    const fetchFn = (() =>
      Promise.resolve(new Response(JSON.stringify({ cursor: 42 }), { status: 200, headers: { "content-type": "application/json" } }))) as typeof fetch
    const client = createDeepAgentCodeClient({ fetch: fetchFn, baseUrl })
    expect(await client.session.sessionEventWatermark("ses-1")).toBe(42)
  })

  test("returns undefined when the journal has no watermark", async () => {
    const fetchFn = (() =>
      Promise.resolve(new Response(JSON.stringify({ cursor: null }), { status: 200, headers: { "content-type": "application/json" } }))) as typeof fetch
    const client = createDeepAgentCodeClient({ fetch: fetchFn, baseUrl })
    expect(await client.session.sessionEventWatermark("ses-1")).toBeUndefined()
  })

  test("streams durable journal events from the cursor endpoint", async () => {
    const payloads = [
      { id: "ev-1", type: "session.next.step.started", seq: 3, data: { sessionID: "ses-1", agent: "primary" } },
      { id: "ev-2", type: "session.execution.succeeded", seq: 4, data: { sessionID: "ses-1" } },
    ]
    const sep = "\n\n"
    const text = payloads.map((item) => "data: " + JSON.stringify(item) + sep).join("")
    const fetchFn = (() =>
      Promise.resolve(
        new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text))
            controller.close()
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } }),
      )) as typeof fetch
    const client = createDeepAgentCodeClient({ fetch: fetchFn, baseUrl })
    const cursor = await client.session.sessionEventStream("ses-1", { after: "2" })
    const collected = []
    for await (const event of cursor.stream) collected.push(event)
    expect(collected).toEqual(payloads)
  })

  test("exposes close() on the stream handle", async () => {
    const fetchFn = (() =>
      Promise.resolve(
        new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: {}" + sep))
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } }),
      )) as typeof fetch
    const client = createDeepAgentCodeClient({ fetch: fetchFn, baseUrl })
    const cursor = await client.session.sessionEventStream("ses-1")
    cursor.close()
    expect(cursor.close).toBeTypeOf("function")
  })
})
