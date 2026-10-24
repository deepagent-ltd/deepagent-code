import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { createSignal, type JSX } from "solid-js"
import { DialogProvider } from "@deepagent-code/ui/context/dialog"
import { SidePanelIM } from "@/pages/session/side-panel-im"
import type { IMClient } from "@/utils/im-client"
import { PersonalCommandFlow } from "@/components/im/personal-command-flow"
import type { PersonalCommandClient } from "@/components/im/personal-command-editor"
import { createDacDraft, type DacCommand } from "@/components/im/personal-command"
import { dict } from "@/i18n/en"

const runtime = vi.hoisted(() => ({
  client: {},
  scope: {},
  serverScope: {},
  local: true,
  actualDialogs: false,
  location: { pathname: "/original/chat", search: "", hash: "" },
  show: vi.fn(),
  close: vi.fn(),
  navigate: vi.fn(),
  panel: vi.fn(),
  view: vi.fn(),
  im: undefined as IMClient | undefined,
}))
vi.mock("@/utils/im-client", async (original) => ({
  ...(await original<typeof import("@/utils/im-client")>()),
  useIMClient: () => runtime.im!,
  createIMClient: () => runtime.im!,
}))
vi.mock("@/context/command", () => ({ useCommand: () => ({ register() {} }) }))
vi.mock("@/components/im/capabilities", () => ({ fetchIMCapabilities: async () => ({}) }))
vi.mock("@/hooks/use-im-websocket", () => ({
  useIMWebSocket: () => ({
    connected: () => true,
    messages: () => [],
    agentStatuses: () => new Map(),
    agentProgress: () => new Map(),
    typingMembers: () => new Set(),
    send() {},
    reconnect() {},
  }),
}))
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({ client: runtime.client, scope: runtime.scope, directory: "/owned/project" }),
}))
vi.mock("@/context/server", () => ({
  ServerConnection: { local: () => runtime.local, key: () => "sidecar" },
  useServer: () => ({
    scope: () => runtime.serverScope,
    current: { type: "sidecar", http: { url: "http://127.0.0.1:4096" } },
    key: "sidecar",
    list: [{ type: "sidecar", http: { url: "http://127.0.0.1:4096" } }],
    projects: { forServer: () => ({ list: () => [{ worktree: "/owned/project" }] }) },
  }),
}))
vi.mock("@/context/layout", () => ({ useLayout: () => ({ view: runtime.view }) }))
vi.mock("@solidjs/router", () => ({ useLocation: () => runtime.location, useNavigate: () => runtime.navigate }))
vi.mock("@deepagent-code/ui/context/dialog", async (original) => {
  const actual = await original<typeof import("@deepagent-code/ui/context/dialog")>()
  return {
    ...actual,
    useDialog: () => (runtime.actualDialogs ? actual.useDialog() : { show: runtime.show, close: runtime.close }),
  }
})
vi.mock("@deepagent-code/ui/dialog", () => ({
  Dialog: (props: { children: JSX.Element }) => <div data-testid="private-editor">{props.children}</div>,
}))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict, values?: Record<string, string | number>) =>
      dict[key].replace(/\{\{(\w+)\}\}/g, (all, name) => (values?.[name] === undefined ? all : String(values[name]))),
  }),
}))
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  runtime.local = true
  runtime.actualDialogs = false
  runtime.location.pathname = "/original/chat"
  runtime.navigate.mockImplementation((path: string) => {
    runtime.location.pathname = path
  })
  runtime.view.mockReturnValue({ rightPanel: { open: runtime.panel } })
})

const binding = {
  version: 1 as const,
  groupID: "conversation",
  projectID: "project",
  directory: "/owned/project",
  workspaceID: null,
  bindingID: null,
  sessionID: null,
}
const command: DacCommand = {
  ...binding,
  commandID: "command",
  bindingID: "binding",
  sessionID: "real-session",
  inputID: "real-input",
  delivery: "queue",
  state: "admitted",
  activityID: null,
  finalMessageID: null,
  replyStatus: "delivered",
}
function client() {
  const scope = {}
  return {
    scope: () => scope,
    dacBinding: vi.fn<PersonalCommandClient["dacBinding"]>(async () => binding),
    dacSubmit: vi.fn<PersonalCommandClient["dacSubmit"]>(async (_group, input) => ({
      ...command,
      commandID: input.commandID,
    })),
    dacReplyRetry: vi.fn<PersonalCommandClient["dacCommand"]>(async (_group, commandID) => ({ ...command, commandID })),
    dacCommand: vi.fn<PersonalCommandClient["dacCommand"]>(async (_group, commandID) => ({ ...command, commandID })),
  }
}

it("opens the admitted ordinary Session with its original scope then returns to the same chat", async () => {
  const api = client()
  const draft = createDacDraft()
  draft.setState("text", "Read and test")
  const bookmark = vi.fn()
  const close = vi.fn()
  render(() => (
    <PersonalCommandFlow
      client={api}
      groupID="conversation"
      draft={draft}
      autoSubmit
      active={() => true}
      bookmark={bookmark}
      onClose={close}
    />
  ))
  render(runtime.show.mock.calls[0][0])
  await waitFor(() => expect(runtime.navigate).toHaveBeenCalledOnce())
  expect(runtime.navigate.mock.calls[0][0]).toMatch(/\/session\/real-session$/)
  expect(bookmark).toHaveBeenCalledWith(runtime.navigate.mock.calls[0][0])
  expect(runtime.panel).toHaveBeenCalledWith("im")
  expect(close).not.toHaveBeenCalled()
  runtime.location.pathname = runtime.navigate.mock.calls[0][0]
  fireEvent.click(screen.getByRole("button", { name: dict["im.dac.returnToChat"] }))
  expect(runtime.navigate).toHaveBeenLastCalledWith("/original/chat")
  expect(close).toHaveBeenCalledOnce()
  expect(api.dacSubmit).toHaveBeenCalledOnce()
})

it("a changed placement or a remote owner never navigates or submits a replacement", async () => {
  const api = client()
  const draft = createDacDraft()
  draft.setState("text", "Read and test")
  api.dacSubmit.mockImplementationOnce(async (_group, input) => ({
    ...command,
    commandID: input.commandID,
    directory: "/different/project",
  }))
  const view = render(() => (
    <PersonalCommandFlow
      client={api}
      groupID="conversation"
      draft={draft}
      autoSubmit
      active={() => true}
      bookmark={vi.fn()}
      onClose={vi.fn()}
    />
  ))
  render(runtime.show.mock.calls[0][0])
  await screen.findByRole("alert")
  expect(runtime.navigate).not.toHaveBeenCalled()
  expect(draft.state.pending).toBeDefined()
  view.unmount()
  cleanup()
  runtime.local = false
  render(() => (
    <PersonalCommandFlow
      client={api}
      groupID="conversation"
      draft={draft}
      autoSubmit
      active={() => true}
      bookmark={vi.fn()}
      onClose={vi.fn()}
    />
  ))
  render(runtime.show.mock.calls.at(-1)![0])
  await Promise.resolve()
  expect(api.dacSubmit).toHaveBeenCalledOnce()
  expect(runtime.navigate).not.toHaveBeenCalled()
})

function panel(scopeOverride?: IMClient["scope"]) {
  const api = client()
  const scope = { directory: "/owned/project", url: "http://127.0.0.1:4096" }
  const group = {
    id: "conversation",
    name: "Peer",
    type: "direct",
    createdBy: "viewer",
    workspaceID: "workspace",
    projectID: null,
    kernelConvID: null,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  }
  runtime.im = {
    ...api,
    scope: scopeOverride ?? (() => scope),
    facadeStatus: async () => ({
      facade: "active",
      identity: { uuid: "viewer", name: "Viewer", orgID: 1, orgAllGroupID: "all" },
      blocked: null,
      kernel: "connected",
      keyOrigin: "stored",
      reader: { state: "ready", displayEpoch: "current", legacyMirrorUnavailable: false },
      ...(scopeOverride
        ? { service: { url: scopeOverride().serviceURL ?? null, source: "config", reconnectRequired: false } }
        : {}),
    }),
    listGroupPage: async (lane: "ordinary" | "protected") => ({
      version: 1,
      lane,
      groups: lane === "ordinary" ? [group] : [],
      hasMore: false,
      nextCursor: null,
    }),
    getGroup: async () => ({ version: 1, group }),
    listMessages: async () => ({ messages: [], hasMore: false, nextCursor: null }),
    listAgents: async () => [],
  } as unknown as IMClient
  runtime.actualDialogs = true
  render(() => (
    <DialogProvider>
      <SidePanelIM onClose={() => {}} />
    </DialogProvider>
  ))
  return api
}

it("starts a new private invocation after service settings change and rejects the retired scope's late result", async () => {
  const [service, setService] = createSignal<string>()
  const actual = await vi.importActual<typeof import("@/utils/im-client")>("@/utils/im-client")
  const scoped = actual.createIMClient(() => ({
    url: "http://127.0.0.1:4096",
    directory: "/owned/project",
    serviceURL: service(),
  }))
  const api = panel(scoped.scope)
  await screen.findByRole("button", { name: /Peer/ })
  setService("https://first-realm.invalid/im")
  fireEvent.click(await screen.findByRole("button", { name: /Peer/ }))
  const first = await screen.findByRole("textbox", { name: dict["im.composer.placeholder"] })
  const stale = Promise.withResolvers<DacCommand>()
  api.dacSubmit.mockReturnValueOnce(stale.promise)
  fireEvent.input(first, { target: { value: "/dac First realm request" } })
  fireEvent.keyDown(first, { key: "Enter" })
  await waitFor(() => expect(api.dacSubmit).toHaveBeenCalledTimes(1))
  expect(runtime.navigate).not.toHaveBeenCalled()
  fireEvent.keyDown(window, { key: "Escape" })
  await waitFor(() => expect(screen.queryByTestId("private-editor")).toBeNull())
  setService("https://second-realm.invalid/im")
  fireEvent.click(await screen.findByRole("button", { name: /Peer/ }))
  const second = await screen.findByRole("textbox", { name: dict["im.composer.placeholder"] })
  fireEvent.input(second, { target: { value: "/dac Second realm request" } })
  fireEvent.keyDown(second, { key: "Enter" })
  await waitFor(() => expect(api.dacSubmit).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(runtime.navigate).toHaveBeenCalledTimes(1))
  stale.resolve({ ...command, commandID: api.dacSubmit.mock.calls[0][1].commandID, sessionID: "retired-session" })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(runtime.navigate).toHaveBeenCalledTimes(1)
  expect(runtime.navigate.mock.calls[0][0]).toContain("real-session")
  expect(api.dacSubmit).toHaveBeenCalledTimes(2)
  expect(api.dacSubmit.mock.calls[1][1].text).toBe(" Second realm request")
})

it("reopens the actual panel editor for a new invocation in the same conversation after its first navigation", async () => {
  const api = panel()
  fireEvent.click(await screen.findByRole("button", { name: /Peer/ }))
  const input = await screen.findByRole("textbox", { name: dict["im.composer.placeholder"] })
  fireEvent.input(input, { target: { value: "/dac First command" } })
  fireEvent.keyDown(input, { key: "Enter" })
  await waitFor(() => expect(api.dacSubmit).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(runtime.navigate).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(screen.queryByTestId("private-editor")).toBeNull())
  fireEvent.input(input, { target: { value: "/dac Second command" } })
  fireEvent.change(
    screen
      .getAllByRole("combobox", { name: dict["im.dac.delivery"] })
      .find((element) => !element.closest('[data-testid="private-editor"]'))!,
    { target: { value: "steer" } },
  )
  fireEvent.keyDown(input, { key: "Enter" })
  await waitFor(() => expect(api.dacSubmit).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(runtime.navigate).toHaveBeenCalledTimes(2))
  expect(api.dacSubmit.mock.calls.map((call) => [call[1].text, call[1].delivery])).toEqual([
    [" First command", "queue"],
    [" Second command", "steer"],
  ])
  expect(api.dacSubmit.mock.calls[1][1].commandID).not.toBe(api.dacSubmit.mock.calls[0][1].commandID)
  expect(runtime.navigate.mock.calls[1][0]).toBe(runtime.navigate.mock.calls[0][0])
})

it("reopens an unknown panel invocation through GET reconciliation without replacing or reposting its command", async () => {
  runtime.location.pathname = "/unknown/chat"
  const api = panel()
  api.dacSubmit.mockRejectedValueOnce(new Error("closed after dispatch"))
  api.dacCommand.mockImplementation(async (_group, commandID) => ({ ...command, commandID, state: "pending" }))
  fireEvent.click(await screen.findByRole("button", { name: /Peer/ }))
  const input = await screen.findByRole("textbox", { name: dict["im.composer.placeholder"] })
  fireEvent.input(input, { target: { value: "/dac Original unknown command" } })
  fireEvent.keyDown(input, { key: "Enter" })
  await screen.findByText(dict["im.dac.unknown"])
  const original = api.dacSubmit.mock.calls[0][1]
  fireEvent.click(within(screen.getByTestId("private-editor")).getByRole("button", { name: dict["common.close"] }))
  fireEvent.input(input, { target: { value: "/dac Replacement must not dispatch" } })
  fireEvent.keyDown(input, { key: "Enter" })
  await waitFor(() =>
    expect(api.dacCommand).toHaveBeenCalledWith("conversation", original.commandID, expect.any(AbortSignal)),
  )
  expect(api.dacSubmit).toHaveBeenCalledTimes(1)
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: dict["im.dac.command"] }).value).toBe(original.text)
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: dict["im.dac.command"] }).disabled).toBe(true)
  expect(runtime.navigate).not.toHaveBeenCalled()
})

async function finalReply(api: ReturnType<typeof client>, active: () => boolean = () => true) {
  const draft = createDacDraft()
  draft.setState("command", {
    ...command,
    activityID: "real-activity",
    finalMessageID: "real-final",
    replyStatus: "dead",
  })
  api.dacBinding.mockResolvedValue({ ...binding, sessionID: command.sessionID, bindingID: command.bindingID })
  api.dacCommand.mockImplementation(async () => draft.state.command!)
  runtime.actualDialogs = true
  render(() => (
    <DialogProvider>
      <PersonalCommandFlow
        client={api}
        groupID="conversation"
        draft={draft}
        autoSubmit={false}
        active={active}
        bookmark={vi.fn()}
        onClose={vi.fn()}
      />
    </DialogProvider>
  ))
  fireEvent.click((await screen.findAllByRole("button", { name: dict["im.dac.open"] })).at(-1)!)
  await waitFor(() => expect(screen.queryByTestId("private-editor")).toBeNull())
  return draft
}

it("retries only the known dead original final reply and observes delivery without submitting another command", async () => {
  const api = client()
  const draft = await finalReply(api)
  api.dacReplyRetry.mockImplementationOnce(async () => ({ ...draft.state.command!, replyStatus: "pending" }))
  api.dacCommand.mockImplementationOnce(async () => ({ ...draft.state.command!, replyStatus: "delivered" }))
  fireEvent.click(screen.getByRole("button", { name: dict["im.dac.reply.retry"] }))
  await screen.findByText(dict["im.dac.reply.delivered"])
  expect(api.dacReplyRetry).toHaveBeenCalledExactlyOnceWith("conversation", command.commandID, expect.any(AbortSignal))
  expect(api.dacSubmit).not.toHaveBeenCalled()
  expect(draft.state.command).toMatchObject({
    commandID: command.commandID,
    inputID: command.inputID,
    activityID: "real-activity",
    finalMessageID: "real-final",
    replyStatus: "delivered",
  })
  expect(screen.queryByRole("button", { name: dict["im.dac.reply.retry"] })).toBeNull()
})

it("an unknown final reply retry permits only explicit observation of the same command", async () => {
  const api = client()
  const draft = await finalReply(api)
  api.dacReplyRetry.mockRejectedValueOnce(new Error("response closed"))
  fireEvent.click(screen.getByRole("button", { name: dict["im.dac.reply.retry"] }))
  await screen.findByText(dict["im.dac.reply.unknown"])
  expect(screen.queryByRole("button", { name: dict["im.dac.reply.retry"] })).toBeNull()
  expect(api.dacCommand).toHaveBeenCalledTimes(1)
  api.dacCommand.mockImplementationOnce(async () => ({ ...draft.state.command!, replyStatus: "delivered" }))
  fireEvent.click(screen.getByRole("button", { name: dict["im.dac.check"] }))
  await screen.findByText(dict["im.dac.reply.delivered"])
  expect(api.dacReplyRetry).toHaveBeenCalledTimes(1)
  expect(api.dacCommand).toHaveBeenLastCalledWith("conversation", command.commandID, expect.any(AbortSignal))
  expect(api.dacSubmit).not.toHaveBeenCalled()
})

it("a cold transport-unknown final exposes only a check of the original command", async () => {
  const api = client()
  const original: DacCommand = {
    ...command,
    activityID: "real-activity",
    finalMessageID: "real-final",
    replyStatus: "unknown",
  }
  api.dacBinding.mockResolvedValue({
    ...binding,
    sessionID: command.sessionID,
    bindingID: command.bindingID,
    recentCommands: [original],
  })
  api.dacCommand.mockResolvedValue(original)
  const draft = createDacDraft()
  draft.setState({ text: "Unsubmitted private text", reference: { id: "reference", content: "Private quote" } })
  runtime.actualDialogs = true
  render(() => (
    <DialogProvider>
      <PersonalCommandFlow
        client={api}
        groupID="conversation"
        draft={draft}
        autoSubmit={false}
        active={() => true}
        bookmark={vi.fn()}
        onClose={vi.fn()}
      />
    </DialogProvider>
  ))
  await screen.findByText(dict["im.dac.reply.unknown"])
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: dict["im.dac.recent"] }).value).toBe(
    original.commandID,
  )
  expect(screen.queryByRole("button", { name: dict["im.dac.reply.retry"] })).toBeNull()
  fireEvent.click(screen.getAllByRole("button", { name: dict["im.dac.open"] }).at(-1)!)
  await waitFor(() => expect(screen.queryByTestId("private-editor")).toBeNull())
  await screen.findByText(dict["im.dac.reply.unknown"])
  expect(api.dacCommand).toHaveBeenCalledExactlyOnceWith("conversation", original.commandID, expect.any(AbortSignal))
  expect(screen.queryByRole("button", { name: dict["im.dac.reply.retry"] })).toBeNull()
  api.dacCommand.mockResolvedValueOnce({ ...original, replyStatus: "delivered" })
  fireEvent.click(screen.getByRole("button", { name: dict["im.dac.check"] }))
  await screen.findByText(dict["im.dac.reply.delivered"])
  expect(api.dacCommand).toHaveBeenCalledTimes(2)
  expect(api.dacCommand).toHaveBeenLastCalledWith("conversation", original.commandID, expect.any(AbortSignal))
  expect(api.dacReplyRetry).not.toHaveBeenCalled()
  expect(api.dacSubmit).not.toHaveBeenCalled()
  expect(draft.state.text).toBe("Unsubmitted private text")
  expect(draft.state.reference?.content).toBe("Private quote")
  expect(draft.state.command).toMatchObject({
    commandID: original.commandID,
    activityID: original.activityID,
    finalMessageID: original.finalMessageID,
    replyStatus: "delivered",
  })
})

it("a late final reply response cannot update a retired owner or replace its final custody", async () => {
  const api = client()
  const [active, setActive] = createSignal(true)
  const draft = await finalReply(api, active)
  const response = Promise.withResolvers<DacCommand>()
  api.dacReplyRetry.mockReturnValueOnce(response.promise)
  fireEvent.click(screen.getByRole("button", { name: dict["im.dac.reply.retry"] }))
  const signal = api.dacReplyRetry.mock.calls[0][2]
  setActive(false)
  await waitFor(() => expect(signal.aborted).toBe(true))
  response.resolve({ ...draft.state.command!, finalMessageID: "different-final", replyStatus: "delivered" })
  await response.promise
  expect(draft.state.command?.finalMessageID).toBe("real-final")
  expect(draft.state.command?.replyStatus).toBe("dead")
  expect(api.dacSubmit).not.toHaveBeenCalled()
})

it("a cold binding exposes only recent command metadata and retries the explicitly selected original final", async () => {
  const api = client()
  const recent = [
    {
      ...command,
      commandID: "third-command",
      activityID: "third-activity",
      finalMessageID: "third-final",
      replyStatus: "dead" as const,
    },
    {
      ...command,
      commandID: "second-command",
      sessionID: "historical-real-session",
      delivery: "steer" as const,
      activityID: "second-activity",
      finalMessageID: "second-final",
      replyStatus: "dead" as const,
    },
  ]
  api.dacBinding.mockResolvedValue({
    ...binding,
    sessionID: command.sessionID,
    bindingID: command.bindingID,
    recentCommands: recent,
  })
  api.dacCommand.mockImplementation(async (_group, id) => recent.find((item) => item.commandID === id)!)
  api.dacReplyRetry.mockImplementation(async (_group, id) => ({
    ...recent.find((item) => item.commandID === id)!,
    replyStatus: "delivered",
  }))
  const draft = createDacDraft()
  draft.setState({ text: "Unsubmitted private text", reference: { id: "reference", content: "Private quoted text" } })
  runtime.actualDialogs = true
  render(() => (
    <DialogProvider>
      <PersonalCommandFlow
        client={api}
        groupID="conversation"
        draft={draft}
        autoSubmit={false}
        active={() => true}
        bookmark={vi.fn()}
        onClose={vi.fn()}
      />
    </DialogProvider>
  ))
  const choices = await screen.findByRole<HTMLSelectElement>("combobox", { name: dict["im.dac.recent"] })
  await waitFor(() => expect(choices.disabled).toBe(false))
  expect(choices.value).toBe("third-command")
  fireEvent.change(choices, { target: { value: "second-command" } })
  await waitFor(() =>
    expect(api.dacCommand).toHaveBeenLastCalledWith("conversation", "second-command", expect.any(AbortSignal)),
  )
  await waitFor(() => expect(choices.disabled).toBe(false))
  fireEvent.click(screen.getAllByRole("button", { name: dict["im.dac.open"] }).at(-1)!)
  await waitFor(() => expect(screen.queryByTestId("private-editor")).toBeNull())
  fireEvent.click(screen.getByRole("button", { name: dict["im.dac.reply.retry"] }))
  await screen.findByText(dict["im.dac.reply.delivered"])
  expect(runtime.navigate).toHaveBeenCalledWith(expect.stringMatching(/\/session\/historical-real-session$/))
  expect(api.dacReplyRetry).toHaveBeenCalledExactlyOnceWith("conversation", "second-command", expect.any(AbortSignal))
  expect(draft.state.text).toBe("Unsubmitted private text")
  expect(draft.state.reference?.content).toBe("Private quoted text")
  expect(api.dacSubmit).not.toHaveBeenCalled()
})

it("cold recent commands cannot replace an unknown admission or dispatch its saved private input", async () => {
  const api = client()
  const draft = createDacDraft()
  const input = Object.freeze({
    commandID: "unknown-original",
    text: " Original private bytes",
    delivery: "queue" as const,
  })
  draft.setState({ text: input.text, pending: input, reference: { id: "reference", content: "Private quote" } })
  api.dacBinding.mockResolvedValue({
    ...binding,
    bindingID: command.bindingID,
    sessionID: command.sessionID,
    recentCommands: [{ ...command, commandID: "new-recent" }],
  })
  api.dacCommand.mockImplementation(async () => ({ ...command, commandID: input.commandID, state: "pending" }))
  runtime.actualDialogs = true
  render(() => (
    <DialogProvider>
      <PersonalCommandFlow
        client={api}
        groupID="conversation"
        draft={draft}
        autoSubmit={false}
        active={() => true}
        bookmark={vi.fn()}
        onClose={vi.fn()}
      />
    </DialogProvider>
  ))
  const choices = await screen.findByRole<HTMLSelectElement>("combobox", { name: dict["im.dac.recent"] })
  expect(choices.disabled).toBe(true)
  expect(api.dacCommand).toHaveBeenCalledExactlyOnceWith("conversation", input.commandID, expect.any(AbortSignal))
  expect(draft.state.pending?.commandID).toBe(input.commandID)
  expect(draft.state.text).toBe(input.text)
  expect(draft.state.reference?.content).toBe("Private quote")
  expect(api.dacSubmit).not.toHaveBeenCalled()
  expect(api.dacReplyRetry).not.toHaveBeenCalled()
})

it("hides the embedded flow return while retaining its status and original-command check", async () => {
  const api = client()
  const draft = createDacDraft()
  const original: DacCommand = {
    ...command,
    activityID: "real-activity",
    finalMessageID: "real-final",
    replyStatus: "unknown",
  }
  draft.setState("command", original)
  api.dacBinding.mockResolvedValue({
    ...binding,
    sessionID: command.sessionID,
    bindingID: command.bindingID,
  })
  api.dacCommand.mockResolvedValue(original)
  runtime.actualDialogs = true
  render(() => (
    <DialogProvider>
      <PersonalCommandFlow
        client={api}
        groupID="conversation"
        draft={draft}
        autoSubmit={false}
        showReturn={false}
        active={() => true}
        bookmark={vi.fn()}
        onClose={vi.fn()}
      />
    </DialogProvider>
  ))
  fireEvent.click((await screen.findAllByRole("button", { name: dict["im.dac.open"] })).at(-1)!)
  await waitFor(() => expect(screen.queryByTestId("private-editor")).toBeNull())
  await screen.findByText(dict["im.dac.reply.unknown"])
  expect(screen.queryByRole("button", { name: dict["im.dac.returnToChat"] })).toBeNull()
  const checks = api.dacCommand.mock.calls.length
  fireEvent.click(screen.getByRole("button", { name: dict["im.dac.check"] }))
  await waitFor(() => expect(api.dacCommand).toHaveBeenCalledTimes(checks + 1))
  expect(api.dacCommand).toHaveBeenCalledWith("conversation", original.commandID, expect.any(AbortSignal))
  expect(screen.getByText(dict["im.dac.reply.unknown"])).toBeTruthy()
  expect(api.dacSubmit).not.toHaveBeenCalled()
  expect(api.dacReplyRetry).not.toHaveBeenCalled()
})

it("explicit receipt reconciliation presents partial parts and never resends or accepts a late scope", async () => {
  const original = client()
  const pending: {
    resolve?: (
      value: import("@deepagent-code/core/im/dac-session.schema").IMDacSessionSchema.ReplyReconcileResponse,
    ) => void
  } = {}
  const api = {
    ...original,
    dacReplyReconcile: vi.fn(
      async (_group: string, _command: string, _cursor: string | undefined, _signal: AbortSignal) => {
        return await new Promise<
          import("@deepagent-code/core/im/dac-session.schema").IMDacSessionSchema.ReplyReconcileResponse
        >((resolve) => {
          pending.resolve = resolve
        })
      },
    ),
  }
  const draft = await finalReply(api)
  draft.setState("command", { ...draft.state.command!, replyStatus: "unknown" })
  expect(api.dacReplyReconcile).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: dict["im.dac.reply.reconcile"] }))
  expect(api.dacReplyReconcile).toHaveBeenCalledExactlyOnceWith(
    "conversation",
    command.commandID,
    undefined,
    expect.any(AbortSignal),
  )
  const partial = {
    version: 1 as const,
    command: { ...draft.state.command! },
    state: "partial" as const,
    totalParts: 3,
    confirmedParts: 1,
    unconfirmedParts: 2,
    activeParts: 0,
    parts: [],
    hasMore: true,
    nextCursor: "original-cursor",
  }
  pending.resolve!(partial)
  await screen.findByText("Original parts confirmed by server: 1 / 3")
  expect(draft.state.command?.replyStatus).toBe("unknown")
  fireEvent.click(screen.getByRole("button", { name: dict["im.dac.reply.reconcileMore"] }))
  expect(api.dacReplyReconcile).toHaveBeenLastCalledWith(
    "conversation",
    command.commandID,
    "original-cursor",
    expect.any(AbortSignal),
  )
  runtime.serverScope = {}
  pending.resolve!({
    ...partial,
    state: "confirmed_acceptance",
    confirmedParts: 3,
    unconfirmedParts: 0,
    hasMore: false,
    nextCursor: null,
    command: { ...partial.command, replyStatus: "delivered" },
  })
  await Promise.resolve()
  expect(draft.state.command?.replyStatus).toBe("unknown")
  expect(api.dacReplyRetry).not.toHaveBeenCalled()
  expect(api.dacSubmit).not.toHaveBeenCalled()
})
