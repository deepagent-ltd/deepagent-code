import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { SidePanelIM } from "@/pages/session/side-panel-im"
import { IMFacadeRequestError } from "@/utils/im-client"
import { dict } from "@/i18n/en"

const client = vi.hoisted(() => ({
  facadeStatus: vi.fn(),
  listGroups: vi.fn(),
  facadeOpenDirect: vi.fn(),
  facadeInvite: vi.fn(),
  createGroup: vi.fn(),
}))

vi.mock("@/utils/im-client", async (original) => ({
  ...(await original<typeof import("@/utils/im-client")>()),
  useIMClient: () => client,
}))
vi.mock("@/context/sdk", () => ({ useSDK: () => ({ client: {} }) }))
vi.mock("@/components/im/capabilities", () => ({ fetchIMCapabilities: async () => ({}) }))
vi.mock("@/components/im/group-chat-panel", () => ({ GroupChatPanel: () => <div>Conversation</div> }))
vi.mock("@/components/im/message-search", () => ({ MessageSearch: () => <div>Search</div> }))
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
  client.listGroups.mockResolvedValue([])
})
afterEach(cleanup)

describe("IM side panel recovery", () => {
  it.each([new TypeError("network offline"), new IMFacadeRequestError("http_error", "Unauthorized", 401)])(
    "keeps creation disabled when status cannot be verified (%s)",
    async (error) => {
      client.facadeStatus.mockRejectedValue(error)
      render(() => <SidePanelIM onClose={vi.fn()} />)
      await screen.findByText(dict["im.facade.status.failed"])
      expect(screen.getByRole("button", { name: dict["im.direct.create"] }).hasAttribute("disabled")).toBe(true)
      expect(screen.getByRole("button", { name: dict["im.group.create"] }).hasAttribute("disabled")).toBe(true)
      client.facadeStatus.mockResolvedValue(active)
      fireEvent.click(screen.getByRole("button", { name: dict["im.facade.retry"] }))
      await waitFor(() => expect(screen.queryByText(dict["im.facade.status.failed"])).toBeNull())
      expect(screen.getByRole("button", { name: dict["im.direct.create"] }).hasAttribute("disabled")).toBe(false)
    },
  )

  it("allows legacy conversations only for an absent facade endpoint", async () => {
    client.facadeStatus.mockRejectedValue(new IMFacadeRequestError("http_error", "Not found", 404))
    render(() => <SidePanelIM onClose={vi.fn()} />)
    const create = screen.getByRole("button", { name: dict["im.direct.create"] })
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false))
    expect(screen.queryByText(dict["im.facade.status.failed"])).toBeNull()
  })

  it("shows a failed conversation fetch as an error and retries to the real list", async () => {
    client.facadeStatus.mockResolvedValue(active)
    client.listGroups.mockRejectedValue(new Error("offline"))
    render(() => <SidePanelIM onClose={vi.fn()} />)
    await screen.findByText(dict["im.group.load.failed"])
    expect(screen.queryByText(dict["im.group.empty"])).toBeNull()
    client.listGroups.mockResolvedValue([{ id: "team", name: "Design team", type: "group", kernelConvID: "k:2:team" }])
    fireEvent.click(screen.getByRole("button", { name: dict["im.facade.retry"] }))
    await screen.findByRole("button", { name: /Design team/ })
    expect(screen.queryByText(dict["im.group.load.failed"])).toBeNull()
  })

  it("keeps a direct-message draft on blur and ignores IME confirmation", async () => {
    client.facadeStatus.mockResolvedValue(active)
    client.facadeOpenDirect.mockResolvedValue({ id: "bob", name: "bob", type: "direct" })
    render(() => <SidePanelIM onClose={vi.fn()} />)
    await waitFor(() =>
      expect(screen.getByRole("button", { name: dict["im.direct.create"] }).hasAttribute("disabled")).toBe(false),
    )
    fireEvent.click(screen.getByRole("button", { name: dict["im.direct.create"] }))
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
