import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  IMBroadcasterLive,
  IMBroadcasterService,
  MAX_CONNECTIONS,
  MAX_CONNECTIONS_PER_GROUP,
} from "@deepagent-code/core/im/broadcaster"
import type { IMWebSocketConnection } from "@deepagent-code/core/im/websocket"

const service = () => Effect.runSync(IMBroadcasterService.pipe(Effect.provide(IMBroadcasterLive)))
const connection = (groupID: string, userID: string): IMWebSocketConnection => ({
  groupID,
  userID,
  workspaceID: "wrk_test",
  send: () => {},
  close: () => {},
})

describe("IMBroadcaster", () => {
  test("bounds each group and reuses unregistered capacity", () => {
    const broadcaster = service()
    const connections = Array.from({ length: MAX_CONNECTIONS_PER_GROUP }, (_, index) =>
      connection("group", `user-${index}`),
    )
    expect(connections.every((item) => broadcaster.register(item))).toBe(true)
    expect(broadcaster.register(connections[0]!)).toBe(true)
    expect(broadcaster.register(connection("group", "overflow"))).toBe(false)

    broadcaster.unregister(connections[0]!)
    expect(broadcaster.register(connection("group", "replacement"))).toBe(true)
  })

  test("bounds aggregate connections across groups", () => {
    const broadcaster = service()
    expect(
      Array.from({ length: MAX_CONNECTIONS }, (_, index) => connection(`group-${index}`, `user-${index}`)).every(
        (item) => broadcaster.register(item),
      ),
    ).toBe(true)
    expect(broadcaster.register(connection("overflow", "overflow"))).toBe(false)
  })

  test("atomically bounds one user's connections in a group", () => {
    const broadcaster = service()
    const first = connection("group", "user")
    const second = connection("group", "user")

    expect(broadcaster.register(first, 1)).toBe(true)
    expect(broadcaster.register(second, 1)).toBe(false)
    broadcaster.unregister(first)
    expect(broadcaster.register(second, 1)).toBe(true)
  })
})
