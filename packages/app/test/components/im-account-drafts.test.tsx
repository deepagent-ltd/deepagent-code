import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createSignal, Show } from "solid-js"
import { MemoryRouter, Route } from "@solidjs/router"
import { SidePanelIM } from "@/pages/session/side-panel-im"
import { createIMClient, type IMClient } from "@/utils/im-client"
import { createComposerDrafts } from "@/components/im/composer-draft"
import { imSummaryOwner } from "@/components/im/summary-owner"
import { dict } from "@/i18n/en"
import { clickIMAction } from "./fixture/im-actions"

const runtime = vi.hoisted(() => ({ client: undefined as IMClient | undefined, namespace: "" }))
vi.mock("@/utils/im-client", async (original) => ({
  ...(await original<typeof import("@/utils/im-client")>()),
  useIMClient: () => runtime.client!,
}))
vi.mock("@/context/command", () => ({ useCommand: () => ({ register() {} }) }))
vi.mock("@/context/sdk", () => ({ useSDK: () => ({ client: {}, directory: "/owned" }) }))
vi.mock("@/context/server", async (original) => ({
  ...(await original<typeof import("@/context/server")>()),
  useServer: () => ({
    key: "account-drafts",
    scope: () => runtime.namespace,
    get current() {
      return { type: "sidecar", http: { ...runtime.client!.scope() } }
    },
    list: [],
    projects: { forServer: () => ({ list: () => [] }) },
  }),
}))
vi.mock("@/components/im/capabilities", () => ({ fetchIMCapabilities: async () => ({}) }))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({ show: vi.fn() }) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
vi.mock("@/context/settings", () => ({
  useSettings: () => ({ notifications: { agent: () => true }, sounds: { agentEnabled: () => true } }),
}))
vi.mock("@/context/server-sync", () => ({ useServerSync: () => ({ data: { config: {} } }) }))
vi.mock("@/context/models", () => ({ useModels: () => ({ list: () => [], visible: () => false }) }))
vi.mock("@/components/im/group-chat-panel", () => ({
  GroupChatPanel: (props: { groupID: string; drafts: ReturnType<typeof createComposerDrafts> }) => (
    <textarea
      aria-label="Private conversation draft"
      value={props.drafts(props.groupID).state.content}
      onInput={(event) => props.drafts(props.groupID).setState("content", event.currentTarget.value)}
    />
  ),
}))
afterEach(() => {
  cleanup()
  imSummaryOwner.stop()
})

it.each(["credentials", "identity", "service"])(
  "isolates drafts when the same mounted IM panel switches accounts with the same conversation ID (%s)",
  async (mode) => {
    runtime.namespace = `account-drafts-${mode}`
    const [account, setAccount] = createSignal("alice")
    const original = createIMClient(() => ({
      url: "http://account-drafts.invalid",
      directory: "/owned",
      password: mode === "credentials" ? account() : "same-server-credential",
      serviceURL: mode === "service" ? `https://${account()}.invalid/im` : undefined,
    }))
    const group = {
      id: "same-conversation",
      name: "Same conversation",
      type: "direct",
      workspaceID: "fixture",
      projectID: null,
      createdBy: "fixture",
      kernelConvID: null,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    }
    runtime.client = {
      ...original,
      facadeStatus: async () => ({
        facade: "active",
        identity: {
          uuid: mode === "service" ? "same-uuid" : account(),
          name: account(),
          orgID: 2,
          orgAllGroupID: "org2",
        },
        ...(mode === "service"
          ? { service: { url: `https://${account()}.invalid/im`, source: "config" as const, reconnectRequired: false } }
          : {}),
        blocked: null,
        kernel: "connected",
        keyOrigin: "stored",
      }),
      listGroupPage: async (lane) => ({
        version: 1,
        lane,
        groups: lane === "ordinary" ? [group] : [],
        hasMore: false,
        nextCursor: null,
      }),
      getGroup: async () => ({ version: 1, group }),
      dacBinding: async () => ({
        version: 1,
        groupID: group.id,
        bindingID: null,
        sessionID: null,
        directory: "/owned",
        projectID: "project",
        workspaceID: null,
        recentCommands: [],
      }),
    }
    render(() => (
      <MemoryRouter>
        <Route path="/" component={() => <SidePanelIM onClose={() => {}} />} />
      </MemoryRouter>
    ))
    fireEvent.click(await screen.findByRole("button", { name: /Same conversation/ }))
    const alice = await screen.findByRole("textbox", { name: "Private conversation draft" })
    fireEvent.input(alice, { target: { value: "Alice private text" } })
    fireEvent.click(screen.getByRole("button", { name: dict["common.goBack"] }))
    setAccount("bob")
    if (mode === "identity") await clickIMAction(dict["im.transport.refresh"])
    fireEvent.click(screen.getByRole("button", { name: dict["im.workspace.settings"] }))
    await screen.findByText("bob")
    fireEvent.click(screen.getByRole("button", { name: dict["im.workspace.messages"] }))
    fireEvent.click(await screen.findByRole("button", { name: /Same conversation/ }))
    const bob = await screen.findByRole("textbox", { name: "Private conversation draft" })
    expect((bob as HTMLTextAreaElement).value).toBe("")
    fireEvent.input(bob, { target: { value: "Bob private text" } })
    fireEvent.click(screen.getByRole("button", { name: dict["common.goBack"] }))
    setAccount("alice")
    if (mode === "identity") await clickIMAction(dict["im.transport.refresh"])
    fireEvent.click(screen.getByRole("button", { name: dict["im.workspace.settings"] }))
    await screen.findByText("alice")
    fireEvent.click(screen.getByRole("button", { name: dict["im.workspace.messages"] }))
    fireEvent.click(await screen.findByRole("button", { name: /Same conversation/ }))
    expect(
      ((await screen.findByRole("textbox", { name: "Private conversation draft" })) as HTMLTextAreaElement).value,
    ).toBe("Alice private text")
  },
)

it("restores selected conversation on each same-account panel reopen without losing its draft", async () => {
  runtime.namespace = "selected-conversation-reopen"
  const original = createIMClient(() => ({
    url: "http://selected-reopen.invalid",
    directory: "/owned",
    password: "same-owner",
  }))
  const group = {
    id: "selected-beta",
    name: "Selected beta",
    type: "direct" as const,
    workspaceID: "fixture",
    projectID: null,
    createdBy: "fixture",
    kernelConvID: null,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  }
  runtime.client = {
    ...original,
    facadeStatus: async () => ({
      facade: "active",
      identity: { uuid: "same-account", name: "Same account", orgID: 2, orgAllGroupID: "org2" },
      service: { url: "https://same-realm.invalid/im", source: "config", reconnectRequired: false },
      blocked: null,
      kernel: "connected",
      keyOrigin: "stored",
    }),
    listGroupPage: async (lane) => ({
      version: 1,
      lane,
      groups: lane === "ordinary" ? [group] : [],
      hasMore: false,
      nextCursor: null,
    }),
    getGroup: async () => ({ version: 1, group }),
    dacBinding: async () => ({
      version: 1,
      groupID: group.id,
      bindingID: null,
      sessionID: null,
      directory: "/owned",
      projectID: "project",
      workspaceID: null,
      recentCommands: [],
    }),
  }
  const [open, setOpen] = createSignal(true)
  render(() => (
    <MemoryRouter>
      <Route
        path="/"
        component={() => (
          <Show when={open()}>
            <SidePanelIM onClose={() => setOpen(false)} />
          </Show>
        )}
      />
    </MemoryRouter>
  ))
  fireEvent.click(await screen.findByRole("button", { name: /Selected beta/ }))
  fireEvent.input(await screen.findByRole("textbox", { name: "Private conversation draft" }), {
    target: { value: "Preserved exact draft" },
  })
  const originalComposer = screen.getByRole("textbox", { name: "Private conversation draft" })
  fireEvent.click(screen.getByRole("button", { name: dict["common.goBack"] }))
  fireEvent.click(screen.getByRole("button", { name: dict["im.workspace.contacts"] }))
  expect(originalComposer.isConnected).toBe(false)
  expect(screen.queryByRole("textbox", { name: "Private conversation draft" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: dict["im.workspace.messages"] }))
  fireEvent.click(screen.getByRole("button", { name: /Selected beta/ }))
  const returnedComposer = await screen.findByRole("textbox", { name: "Private conversation draft" })
  expect(returnedComposer).not.toBe(originalComposer)
  expect((returnedComposer as HTMLTextAreaElement).value).toBe("Preserved exact draft")
  for (const pass of [1, 2]) {
    setOpen(false)
    expect(screen.queryByRole("textbox", { name: "Private conversation draft" })).toBeNull()
    setOpen(true)
    expect(
      ((await screen.findByRole("textbox", { name: "Private conversation draft" })) as HTMLTextAreaElement).value,
      `reopen ${pass}`,
    ).toBe("Preserved exact draft")
  }
  fireEvent.click(screen.getByRole("button", { name: dict["common.goBack"] }))
  setOpen(false)
  setOpen(true)
  await screen.findByRole("button", { name: /Selected beta/ })
  expect(screen.queryByRole("textbox", { name: "Private conversation draft" })).toBeNull()
})
