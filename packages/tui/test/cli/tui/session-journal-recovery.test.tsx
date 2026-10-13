/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createOpencodeClient } from "@deepagent-code/sdk"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProviderV2, useSyncV2 } from "../../../src/context/sync-v2"
import { openSessionJournal, type JournalEventRow } from "../../../src/context/v2-session-journal"
import { eventSource } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { tmpdir } from "../../fixture/fixture"
import { until } from "../../fixture/im-environment"

const event = (seq: number): JournalEventRow => ({
  id: `event-${seq}`,
  seq,
  type: "session.next.context.updated.1",
  data: { sessionID: "session-1", messageID: `message-${seq}`, timestamp: seq, text: `text-${seq}` },
})

test("durable journal retries real HTTP failures from the last applied cursor and stops on close", async () => {
  const requests: string[] = []
  const received: number[] = []
  const failures: unknown[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      const after = url.searchParams.get("after") ?? ""
      requests.push(after)
      if (requests.length === 2)
        return Response.json({ name: "ApiUnavailable", data: { code: "unavailable" } }, { status: 503 })
      return Response.json({
        events: requests.length === 1 ? [event(11)] : requests.length === 3 ? [event(11), event(12)] : [],
        floor: 0,
      })
    },
  })
  const journal = await openSessionJournal(createOpencodeClient({ baseUrl: server.url.toString() }), "session-1", {
    after: "10",
    pollMs: 5,
    onEvent: (row) => received.push(row.seq),
    onResync: () => {
      throw new Error("Transport failure must keep its cursor")
    },
    onStreamEnd() {},
    onError: (error) => failures.push(error),
  })
  try {
    await until(() => received.length === 2)
    expect(received).toEqual([11, 12])
    expect(requests.slice(0, 3)).toEqual(["10", "11", "11"])
    expect(failures).toHaveLength(1)
    journal.close()
    const count = requests.length
    await Bun.sleep(30)
    expect(requests).toHaveLength(count)
  } finally {
    journal.close()
    server.stop(true)
  }
})

test("a failed initial cursor cannot silently anchor at zero", async () => {
  const cursors: number[] = []
  const tails: string[] = []
  const received: number[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("eventsCursor")) {
        cursors.push(cursors.length + 1)
        if (cursors.length === 1)
          return Response.json({ name: "ApiUnavailable", data: { code: "unavailable" } }, { status: 503 })
        return Response.json({ watermark: 10, cursor: 10, floor: 0 })
      }
      tails.push(url.searchParams.get("after") ?? "")
      return Response.json({ events: [event(11)], floor: 0 })
    },
  })
  const journal = await openSessionJournal(createOpencodeClient({ baseUrl: server.url.toString() }), "session-1", {
    pollMs: 5,
    onEvent: (row) => received.push(row.seq),
    onResync() {},
    onStreamEnd() {},
  })
  try {
    await until(() => received.length === 1)
    expect(cursors).toEqual([1, 2])
    expect(tails[0]).toBe("10")
  } finally {
    journal.close()
    server.stop(true)
  }
})

test("mounted SyncV2 recovers failed snapshots and gap owners, then renders versioned tail after outages", async () => {
  await using tmp = await tmpdir()
  const state = { cursor: 0, snapshots: 0, gap: true, outage: true, requests: [] as number[], cursorReads: [] as number[] }
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      expect(request.headers.get("Authorization")).toBe("Bearer fixture-token")
      const url = new URL(request.url)
      if (url.pathname.endsWith("eventsCursor")) {
        state.cursorReads.push(state.cursor)
        return Response.json({ watermark: state.cursor, cursor: state.cursor, floor: 0 })
      }
      if (url.pathname === "/api/session/session-1/message") {
        state.snapshots += 1
        if (state.snapshots === 1)
          return Response.json({ name: "ApiUnavailable", data: { code: "unavailable" } }, { status: 503 })
        return Response.json({
          data:
            state.snapshots === 2
              ? []
              : [
                  {
                    id: "assistant-1",
                    type: "assistant",
                    agent: "build",
                    model: { id: "model", providerID: "provider" },
                    time: { created: 1 },
                    content: [{ type: "text", id: "text-1", text: "snapshot" }],
                  },
                ],
        })
      }
      if (url.pathname === "/context/events") {
        const after = Number(url.searchParams.get("after"))
        state.requests.push(after)
        if (state.gap) {
          state.gap = false
          state.cursor = 3
          return Response.json({ name: "ApiGone", data: { code: "cursor_gap_exceeded" } }, { status: 410 })
        }
        if (after === 3)
          return Response.json({
            events: [
              {
                id: "delta-4",
                seq: 4,
                type: "session.next.text.delta.1",
                data: { sessionID: "session-1", assistantMessageID: "assistant-1", textID: "text-1", delta: " + tail" },
              },
              {
                id: "delta-4",
                seq: 4,
                type: "session.next.text.delta.1",
                data: { sessionID: "session-1", assistantMessageID: "assistant-1", textID: "text-1", delta: " + tail" },
              },
            ],
            floor: 0,
          })
        if (after === 4 && state.outage) {
          state.outage = false
          return Response.json({ name: "ApiUnavailable", data: { code: "unavailable" } }, { status: 503 })
        }
        return Response.json({
          events:
            after === 4
              ? [
                  {
                    id: "end-5",
                    seq: 5,
                    type: "session.next.text.ended.2",
                    data: { sessionID: "session-1", assistantMessageID: "assistant-1", textID: "text-1", text: "recovered final" },
                  },
                ]
              : [],
          floor: 0,
        })
      }
      throw new Error(`Unexpected journal request ${url.pathname}`)
    },
  })
  let sync: ReturnType<typeof useSyncV2> | undefined
  const mounted = Promise.withResolvers<void>()
  function Probe() {
    sync = useSyncV2()
    onMount(() => mounted.resolve())
    return <box />
  }
  const app = await testRender(() => (
    <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
      <SDKProvider url={server.url.toString()} directory={tmp.path} events={eventSource()} headers={{ Authorization: "Bearer fixture-token" }}>
        <SyncProviderV2>
          <Probe />
        </SyncProviderV2>
      </SDKProvider>
    </TestTuiContexts>
  ))
  const text = () => {
    const assistant = sync?.session.message.fromSession("session-1")[0]
    return assistant?.type === "assistant" && assistant.content[0]?.type === "text" ? assistant.content[0].text : undefined
  }
  try {
    await mounted.promise
    await sync?.session.message.sync("session-1")
    await until(() => text() === "snapshot + tail", "snapshot plus versioned tail", 6000)
    await until(() => text() === "recovered final", "network recovery at the retained cursor", 4000)
    expect(state.snapshots).toBe(3)
    expect(state.cursorReads).toEqual([0, 0, 3])
    expect(state.requests.slice(0, 4)).toEqual([0, 3, 4, 4])
    app.renderer.destroy()
    const count = state.requests.length
    await Bun.sleep(1100)
    expect(state.requests).toHaveLength(count)
  } finally {
    app.renderer.destroy()
    server.stop(true)
  }
})
