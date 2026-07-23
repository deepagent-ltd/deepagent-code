import { describe, expect, test } from "bun:test"
import { ServerConnection } from "./server"
import { startupTab, tabKey, type Tab } from "./tabs"

const primary = ServerConnection.Key.make("http://primary")
const secondary = ServerConnection.Key.make("http://secondary")

const servers = [
  { type: "http" as const, http: { url: "http://primary" } },
  { type: "http" as const, http: { url: "http://secondary" } },
]

const first: Tab = {
  type: "session",
  server: primary,
  dirBase64: "L3ByaW1hcnk=",
  sessionId: "first",
}
const lastActive: Tab = {
  type: "session",
  server: secondary,
  dirBase64: "L3NlY29uZGFyeQ==",
  sessionId: "last-active",
}

describe("startup tab recovery", () => {
  test("restores the persisted active tab rather than the first tab", () => {
    expect(startupTab([first, lastActive], tabKey(lastActive), servers)).toBe(lastActive)
  })

  test("falls back to the first stored tab when the active key is stale", () => {
    expect(startupTab([first, lastActive], "stale", servers)).toBe(first)
  })

  test("does not restore a target whose server is unavailable", () => {
    expect(startupTab([first, lastActive], tabKey(lastActive), [servers[0]])).toBeUndefined()
  })
})
