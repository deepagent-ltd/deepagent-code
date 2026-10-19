import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { MemoryRouter, Route } from "@solidjs/router"
import { SidePanelIM } from "@/pages/session/side-panel-im"
import { createIMClient, IMFacadeRequestError } from "@/utils/im-client"
import { dict } from "@/i18n/en"

const client = vi.hoisted(() => ({
  scope: vi.fn(),
  facadeStatus: vi.fn(),
  listGroups: vi.fn(),
  listGroupPage: vi.fn(),
  getGroup: vi.fn(),
  dacBinding: vi.fn(),
  facadeOpenDirect: vi.fn(),
  facadeInvite: vi.fn(),
  createGroup: vi.fn(),
}))

vi.mock("@/utils/im-client", async (original) => ({
  ...(await original<typeof import("@/utils/im-client")>()),
  useIMClient: () => client,
}))
vi.mock("@/context/command", async (original) => ({
  ...(await original<typeof import("@/context/command")>()),
  useCommand: () => ({ register: vi.fn() }),
}))
vi.mock("@/context/sdk", () => ({ useSDK: () => ({ client: {} }) }))
vi.mock("@/context/server", async (original) => ({
  ...(await original<typeof import("@/context/server")>()),
  useServer: () => ({ key: "panel-fixture", all: [], projects: () => ({ list: [] }) }),
}))
vi.mock("@/components/im/capabilities", () => ({ fetchIMCapabilities: async () => ({}) }))
vi.mock("@/components/im/group-chat-panel", () => ({
  GroupChatPanel: (props: {
    groupID: string
    refreshRequest?: number
    drafts: (id: string) => { state: { content: string }; setState: (key: "content", value: string) => void }
  }) => (
    <div role="log" data-refresh={props.refreshRequest}>
      Conversation
      <input
        aria-label="Conversation draft"
        value={props.drafts(props.groupID).state.content}
        onInput={(event) => props.drafts(props.groupID).setState("content", event.currentTarget.value)}
      />
    </div>
  ),
}))
vi.mock("@/components/im/user-settings-page", () => ({
  IMUserSettingsPage: (props: { onManageIM: () => void }) => (
    <button onClick={props.onManageIM}>Manage IM bridge</button>
  ),
}))
vi.mock("@/components/im/message-search", () => ({
  MessageSearch: (props: { query?: string; submitRequest?: number; active?: boolean; groupID?: string }) => (
    <div
      data-testid="search-contract"
      data-query={props.query}
      data-request={props.submitRequest}
      data-active={props.active}
      data-group={props.groupID}
    >
      Search
    </div>
  ),
}))
vi.mock("@/utils/toast", () => ({ showToast: vi.fn() }))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({ show: vi.fn() }) }))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict, values?: Record<string, string>) =>
      Object.entries(values ?? {}).reduce((text, [key, value]) => text.replace(`{{${key}}}`, value), dict[key]),
  }),
}))

const active = {
  facade: "active",
  identity: { uuid: "alice-uuid", name: "alice", orgID: 2, orgAllGroupID: "org2" },
  blocked: null,
  kernel: "connected",
  keyOrigin: "stored",
}

beforeEach(() => {
  Object.values(client).forEach((fn) => fn.mockReset())
  const actual = createIMClient(() => ({
    url: "http://fixture.test",
    directory: "/private/fixture",
    password: "fixture",
  }))
  client.scope.mockImplementation(actual.scope)
  client.listGroups.mockResolvedValue([])
  client.dacBinding.mockImplementation(async (groupID) => ({
    version: 1,
    groupID,
    bindingID: null,
    sessionID: null,
    directory: "/private/fixture",
    projectID: "project",
    workspaceID: null,
    recentCommands: [],
  }))
  client.listGroupPage.mockImplementation(async (lane: "ordinary" | "protected") => ({
    version: 1,
    lane,
    groups: (await client.listGroups()).filter((group: { kernelConvID?: string; reader?: unknown }) =>
      lane === "protected" ? !!group.kernelConvID || !!group.reader : !group.kernelConvID && !group.reader,
    ),
    hasMore: false,
    nextCursor: null,
  }))
})
afterEach(cleanup)

async function openActions() {
  fireEvent.keyDown(screen.getByRole("button", { name: dict["im.sidebar.actions"] }), { key: "ArrowDown" })
  await screen.findByRole("menu")
}

describe("IM side panel recovery", () => {
  it.each([new TypeError("network offline"), new IMFacadeRequestError("http_error", "Unauthorized", 401)])(
    "keeps creation disabled when status cannot be verified (%s)",
    async (error) => {
      client.facadeStatus.mockRejectedValue(error)
      render(() => (
        <MemoryRouter>
          <Route path="/" component={() => <SidePanelIM onClose={vi.fn()} />} />
        </MemoryRouter>
      ))
      await screen.findByText(dict["im.facade.status.failed"])
      await openActions()
      expect(screen.getByRole("menuitem", { name: dict["im.direct.create"] }).hasAttribute("data-disabled")).toBe(true)
      expect(screen.getByRole("menuitem", { name: dict["im.group.create"] }).hasAttribute("data-disabled")).toBe(true)
      client.facadeStatus.mockResolvedValue(active)
      fireEvent.click(screen.getByRole("button", { name: dict["im.facade.retry"] }))
      await waitFor(() => expect(screen.queryByText(dict["im.facade.status.failed"])).toBeNull())
      expect(screen.getByRole("menuitem", { name: dict["im.direct.create"] }).hasAttribute("data-disabled")).toBe(false)
    },
  )

  it("allows legacy conversations only for an absent facade endpoint", async () => {
    client.facadeStatus.mockRejectedValue(new IMFacadeRequestError("http_error", "Not found", 404))
    render(() => (
      <MemoryRouter>
        <Route path="/" component={() => <SidePanelIM onClose={vi.fn()} />} />
      </MemoryRouter>
    ))
    await openActions()
    const create = screen.getByRole("menuitem", { name: dict["im.direct.create"] })
    await waitFor(() => expect(create.hasAttribute("data-disabled")).toBe(false))
    expect(screen.queryByText(dict["im.facade.status.failed"])).toBeNull()
  })

  it("shows a failed conversation fetch as an error and retries to the real list", async () => {
    client.facadeStatus.mockResolvedValue(active)
    client.listGroups.mockRejectedValue(new Error("offline"))
    render(() => (
      <MemoryRouter>
        <Route path="/" component={() => <SidePanelIM onClose={vi.fn()} />} />
      </MemoryRouter>
    ))
    await screen.findByText(dict["im.group.load.failed"])
    expect(document.querySelector('.im-sidebar-page[aria-hidden="false"]')?.textContent).not.toContain(
      dict["im.group.empty"],
    )
    client.listGroups.mockResolvedValue([{ id: "team", name: "Design team", type: "group", kernelConvID: "k:2:team" }])
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: dict["im.facade.retry"] }))
    await screen.findByRole("button", { name: /Design team/ })
    expect(screen.queryByText(dict["im.group.load.failed"])).toBeNull()
  })

  it("keeps a direct-message draft on blur and ignores IME confirmation", async () => {
    client.facadeStatus.mockResolvedValue(active)
    client.facadeOpenDirect.mockResolvedValue({ id: "bob", name: "bob", type: "direct" })
    client.getGroup.mockResolvedValue({ version: 1, group: { id: "bob", name: "bob", type: "direct" } })
    render(() => (
      <MemoryRouter>
        <Route path="/" component={() => <SidePanelIM onClose={vi.fn()} />} />
      </MemoryRouter>
    ))
    await openActions()
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: dict["im.direct.create"] }).hasAttribute("data-disabled")).toBe(
        false,
      ),
    )
    fireEvent.keyDown(screen.getByRole("menuitem", { name: dict["im.direct.create"] }), { key: "Enter" })
    const input = screen.getByPlaceholderText(dict["im.facade.direct.placeholder"])
    fireEvent.input(input, { target: { value: "BOB" } })
    fireEvent.keyDown(input, { key: "Enter", isComposing: true })
    expect(client.facadeOpenDirect).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect((input as HTMLInputElement).value).toBe("BOB")
    fireEvent.keyDown(input, { key: "Enter" })
    await screen.findByText("Conversation")
    expect(client.facadeOpenDirect).toHaveBeenCalledTimes(1)
    expect(client.facadeOpenDirect).toHaveBeenCalledWith("bob")
  })
})

it("keeps the three root destinations reachable with a single header menu and an explicit settings bridge", async () => {
  client.facadeStatus.mockResolvedValue({
    ...active,
    facade: "blocked",
    identity: null,
    blocked: { code: "im_activation_required", message: "" },
  })
  const manage = vi.fn()
  render(() => (
    <MemoryRouter>
      <Route path="/" component={() => <SidePanelIM onClose={vi.fn()} onManageIM={manage} chromeOwned />} />
    </MemoryRouter>
  ))
  const nav = screen.getByRole("navigation", { name: dict["im.workspace.navigation"] })
  expect(within(nav).getAllByRole("button")).toHaveLength(3)
  expect(screen.getAllByRole("button", { name: dict["im.sidebar.actions"] })).toHaveLength(1)
  expect(screen.queryByText("Manage IM bridge")).toBeNull()
  expect(document.querySelector('[data-slot="im-contacts-page"]')).toBeNull()
  await screen.findByRole("button", { name: dict["im.activation.openSettings"] })
  fireEvent.click(screen.getByRole("button", { name: dict["im.activation.openSettings"] }))
  expect(manage).toHaveBeenCalledOnce()
  fireEvent.click(within(nav).getByRole("button", { name: dict["im.workspace.contacts"] }))
  expect(within(nav).getByRole("button", { name: dict["im.workspace.contacts"] }).getAttribute("aria-current")).toBe(
    "page",
  )
  fireEvent.click(within(nav).getByRole("button", { name: dict["im.workspace.settings"] }))
  fireEvent.click(screen.getByRole("button", { name: "Manage IM bridge" }))
  expect(manage).toHaveBeenCalledTimes(2)
  fireEvent.click(within(nav).getByRole("button", { name: dict["im.workspace.messages"] }))
  expect(screen.getByText("Manage IM bridge")).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Manage IM bridge" })).toBeNull()
  expect(document.querySelector('[data-slot="im-contacts-page"]')).toBeTruthy()
  expect(client.facadeOpenDirect).not.toHaveBeenCalled()
})

it("hides root navigation inside a conversation and restores its draft and reading position after list navigation", async () => {
  client.facadeStatus.mockResolvedValue(active)
  const group = { id: "chat", name: "Design team", type: "direct", kernelConvID: null }
  client.listGroups.mockResolvedValue([group])
  client.getGroup.mockResolvedValue({ version: 1, group })
  render(() => (
    <MemoryRouter>
      <Route path="/" component={() => <SidePanelIM onClose={vi.fn()} />} />
    </MemoryRouter>
  ))
  fireEvent.click(await screen.findByRole("button", { name: /Design team/ }))
  const log = await screen.findByRole("log")
  fireEvent.input(screen.getByRole("textbox", { name: "Conversation draft" }), {
    target: { value: "Keep this unsent" },
  })
  log.scrollTop = 137
  expect(screen.queryByRole("navigation", { name: dict["im.workspace.navigation"] })).toBeNull()
  await openActions()
  fireEvent.keyDown(screen.getByRole("menuitem", { name: dict["im.transport.refresh"] }), { key: "Enter" })
  expect(screen.getByRole("log").getAttribute("data-refresh")).toBe("1")
  fireEvent.click(screen.getByRole("button", { name: dict["common.goBack"] }))
  expect(screen.getByRole("navigation", { name: dict["im.workspace.navigation"] })).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: /Design team/ }))
  await screen.findByRole("log")
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Conversation draft" }).value).toBe("Keep this unsent")
  await waitFor(() => expect(screen.getByRole("log").scrollTop).toBe(137))
  await openActions()
  fireEvent.keyDown(screen.getByRole("menuitem", { name: dict["im.search.messages"] }), { key: "Enter" })
  fireEvent.input(screen.getByRole("textbox", { name: dict["im.workspace.filter"] }), {
    target: { value: "needle" },
  })
  fireEvent.keyDown(screen.getByRole("textbox", { name: dict["im.workspace.filter"] }), { key: "Enter" })
  expect(screen.getByTestId("search-contract").getAttribute("data-group")).toBe("chat")
  fireEvent.click(screen.getByRole("button", { name: dict["common.goBack"] }))
  fireEvent.click(screen.getByRole("button", { name: dict["common.goBack"] }))
  fireEvent.keyDown(screen.getByRole("textbox", { name: dict["im.workspace.filter"] }), { key: "Enter" })
  expect(screen.getByTestId("search-contract").getAttribute("data-group")).toBeNull()
  expect(screen.getByTestId("search-contract").getAttribute("data-request")).toBe("2")
})

it("uses the only visible root input for local filtering and submits message history only on an explicit non-IME action", async () => {
  client.facadeStatus.mockResolvedValue(active)
  client.listGroups.mockResolvedValue([
    { id: "design", name: "Design team", type: "group" },
    { id: "qa", name: "QA team", type: "group" },
  ])
  render(() => (
    <MemoryRouter>
      <Route path="/" component={() => <SidePanelIM onClose={vi.fn()} />} />
    </MemoryRouter>
  ))
  await screen.findByRole("button", { name: /Design team/ })
  expect(screen.getAllByRole("textbox")).toHaveLength(1)
  const input = screen.getByRole("textbox", { name: dict["im.workspace.filter"] })
  fireEvent.input(input, { target: { value: "Design" } })
  expect(screen.queryByRole("button", { name: /QA team/ })).toBeNull()
  const search = screen.getByTestId("search-contract")
  expect(search.getAttribute("data-request")).toBe("0")
  fireEvent.keyDown(input, { key: "Enter", isComposing: true })
  expect(search.getAttribute("data-request")).toBe("0")
  fireEvent.keyDown(input, { key: "Enter" })
  expect(search.getAttribute("data-request")).toBe("1")
  expect(search.getAttribute("data-active")).toBe("true")
  const nav = screen.getByRole("navigation", { name: dict["im.workspace.navigation"] })
  fireEvent.click(within(nav).getByRole("button", { name: dict["im.workspace.settings"] }))
  fireEvent.click(within(nav).getByRole("button", { name: dict["im.workspace.messages"] }))
  expect(search.getAttribute("data-request")).toBe("1")
  fireEvent.click(screen.getByRole("button", { name: dict["im.sidebar.clearSearch"] }))
  expect(search.getAttribute("data-query")).toBe("")
  expect(screen.getByRole("button", { name: /QA team/ })).toBeTruthy()
})
