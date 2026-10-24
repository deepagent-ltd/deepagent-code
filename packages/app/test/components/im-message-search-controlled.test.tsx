import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { MessageSearch } from "@/components/im/message-search"
import { dict } from "@/i18n/en"

const client = vi.hoisted(() => ({ scope: vi.fn(), searchMessages: vi.fn() }))
vi.mock("@/utils/im-client", () => ({ useIMClient: () => client }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
const message = (content: string) => ({
  id: content,
  groupID: "a",
  senderID: "bob",
  senderType: "user",
  type: "text",
  content,
  mentions: null,
  metadata: null,
  replyToID: null,
  createdAt: 1000,
  updatedAt: 1000,
  deletedAt: null,
})
const page = (content: string, cursor: string | null = null) => ({
  messages: [message(content)],
  nextCursor: cursor,
  hasMore: !!cursor,
})
beforeEach(() => {
  client.scope.mockReset().mockReturnValue({ directory: "/owned", url: "http://fixture.invalid" })
  client.searchMessages.mockReset()
})
afterEach(cleanup)

it("reuses an external query without another input or an automatic request on view restoration, and preserves pagination", async () => {
  const [state, setState] = createStore({ query: "", request: 0, active: true })
  client.searchMessages.mockResolvedValueOnce(page("first result", "next")).mockResolvedValueOnce(page("older result"))
  render(() => (
    <MessageSearch
      hideInput
      query={state.query}
      submitRequest={state.request}
      active={state.active}
      localGroupIDs={["a"]}
    />
  ))
  expect(screen.queryByRole("textbox")).toBeNull()
  setState("query", "needle")
  expect(client.searchMessages).not.toHaveBeenCalled()
  setState("request", 1)
  await screen.findByText("first result")
  expect(client.searchMessages).toHaveBeenCalledTimes(1)
  setState("active", false)
  setState("active", true)
  await Promise.resolve()
  expect(client.searchMessages).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole("button", { name: dict["common.loadMore"] }))
  await screen.findByText("older result")
  expect(screen.getByText("first result")).toBeTruthy()
  expect(client.searchMessages.mock.calls[1][0]).toMatchObject({ q: "needle", cursor: "next" })
  setState("query", "")
  expect(screen.queryByText("first result")).toBeNull()
  expect(client.searchMessages).toHaveBeenCalledTimes(2)
})

it("rejects an older query and retires even local-result bodies when the server scope changes", async () => {
  const [state, setState] = createStore({ query: "old", request: 0, epoch: "one" })
  const old = Promise.withResolvers<ReturnType<typeof page>>()
  client.searchMessages.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page("current body"))
  render(() => (
    <MessageSearch
      hideInput
      query={state.query}
      submitRequest={state.request}
      groupID="a"
      displayEpoch={state.epoch}
      localGroupIDs={["a"]}
    />
  ))
  setState("request", 1)
  await waitFor(() => expect(client.searchMessages).toHaveBeenCalledTimes(1))
  setState({ query: "current", request: 2 })
  await screen.findByText("current body")
  expect(client.searchMessages.mock.calls[1][0]).toMatchObject({ q: "current", groupId: "a" })
  old.resolve(page("stale body"))
  await Promise.resolve()
  await Promise.resolve()
  expect(screen.queryByText("stale body")).toBeNull()
  client.scope.mockReturnValue({ directory: "/different", url: "http://different.invalid" })
  setState("epoch", "two")
  expect(screen.queryByText("current body")).toBeNull()
  expect(client.searchMessages).toHaveBeenCalledTimes(2)
})

it("retires loading after a failed request and accepts an explicit retry without restoring an older request", async () => {
  const [state, setState] = createStore({ request: 0 })
  client.searchMessages.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(page("recovered body"))
  render(() => <MessageSearch hideInput query="needle" submitRequest={state.request} localGroupIDs={["a"]} />)
  setState("request", 1)
  await screen.findByRole("alert")
  expect(screen.queryByText(dict["common.loading"])).toBeNull()
  setState("request", 2)
  await screen.findByText("recovered body")
  expect(screen.queryByRole("alert")).toBeNull()
  expect(screen.queryByText(dict["common.loading"])).toBeNull()
  expect(client.searchMessages).toHaveBeenCalledTimes(2)
})
