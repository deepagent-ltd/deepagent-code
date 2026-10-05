import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { useIMWebSocket } from "@/hooks/use-im-websocket"
import { createIMClient } from "@/utils/im-client"

class TestSocket {
  static OPEN = 1
  static connections: TestSocket[] = []
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  constructor(readonly url: string) {
    TestSocket.connections.push(this)
  }
  send = vi.fn()
  close = vi.fn(() => {
    this.readyState = 3
    this.onclose?.(new CloseEvent("close", { wasClean: true }))
  })
  open() {
    this.readyState = 1
    this.onopen?.(new Event("open"))
  }
  fail() {
    this.readyState = 3
    this.onclose?.(new CloseEvent("close", { wasClean: false }))
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  TestSocket.connections = []
  vi.stubGlobal("WebSocket", TestSocket)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it("owns every reconnect socket and cancels its timers on unmount", async () => {
  const client = createIMClient(() => ({ url: "http://localhost:4595", directory: "/isolated" }))
  const view = render(() => {
    const socket = useIMWebSocket(client, () => "group-1")
    return <div>{socket.connected() ? "connected" : "disconnected"}</div>
  })
  TestSocket.connections[0].open()
  expect(screen.getByText("connected")).toBeTruthy()
  TestSocket.connections[0].fail()
  await vi.advanceTimersByTimeAsync(1000)
  expect(TestSocket.connections).toHaveLength(2)
  TestSocket.connections[1].open()
  view.unmount()
  expect(TestSocket.connections[1].close).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(TestSocket.connections).toHaveLength(2)
  expect(vi.getTimerCount()).toBe(0)
})

it("ignores old group callbacks and deduplicates echoed message IDs", async () => {
  const group = createSignal("old-group")
  const client = createIMClient(() => ({ url: "http://localhost:4595", directory: "/isolated" }))
  render(() => {
    const socket = useIMWebSocket(client, group[0])
    return (
      <div>
        {socket.connected() ? "connected" : "disconnected"} {socket.messages().length}
      </div>
    )
  })
  const old = TestSocket.connections[0]
  old.open()
  const stale = old.onmessage
  old.fail()
  group[1]("new-group")
  expect(TestSocket.connections).toHaveLength(2)
  const current = TestSocket.connections[1]
  current.open()
  const incoming = (groupID: string) =>
    new MessageEvent("message", {
      data: JSON.stringify({
        type: "message_created",
        data: { id: "same-id", groupID, senderID: "bob", senderType: "user", content: "hello", createdAt: 1 },
      }),
    })
  stale?.(incoming("old-group"))
  current.onmessage?.(incoming("new-group"))
  current.onmessage?.(incoming("new-group"))
  expect(screen.getByText("connected 1")).toBeTruthy()
  await vi.advanceTimersByTimeAsync(1000)
  expect(TestSocket.connections).toHaveLength(2)
})
