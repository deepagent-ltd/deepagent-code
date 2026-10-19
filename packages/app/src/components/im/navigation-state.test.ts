import { expect, test } from "bun:test"
import { imCommunicationState, imNavigationState, publishIMNavigation, retireIMNavigation } from "./navigation-state"

test("message selection and drafts are account-owned rather than Session-owned", () => {
  const first = imCommunicationState("navigation-test", { url: "http://localhost:1" }, "one")
  first.selected = "conversation"
  first.drafts("conversation").setState("content", "retained draft")
  const second = imCommunicationState("navigation-test", { url: "http://localhost:1" }, "one")
  expect(second).toBe(first)
  expect(second.selected).toBe("conversation")
  expect(second.drafts("conversation").state.content).toBe("retained draft")
  const changed = imCommunicationState("navigation-test", { url: "http://localhost:1" }, "two")
  expect(changed.selected).toBeNull()
  expect(changed.drafts("conversation").state.content).toBe("")
})

test("different credentials and server scopes cannot restore another communication state", () => {
  const state = imCommunicationState("one-server", { url: "http://localhost:1", bearer: "one-test" }, "owner")
  expect(imCommunicationState("one-server", { url: "http://localhost:1", bearer: "two-test" }, "owner")).not.toBe(state)
  expect(imCommunicationState("other-server", { url: "http://localhost:1", bearer: "one-test" }, "owner")).not.toBe(
    state,
  )
})

test("retiring an old panel cannot retire a successor owner, and leaving the current view marks stale", () => {
  const previous = {}
  const current = {}
  publishIMNavigation({
    scope: "test",
    connection: { url: "http://localhost:1" },
    accountID: "owner",
    owner: current,
    connected: true,
    unread: true,
    current: true,
  })
  retireIMNavigation(previous)
  expect(imNavigationState()?.current).toBe(true)
  retireIMNavigation(current)
  expect(imNavigationState()?.current).toBe(false)
  expect(imNavigationState()?.unread).toBe(true)
})
