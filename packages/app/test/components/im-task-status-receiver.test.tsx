import { afterEach, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal, Show } from "solid-js"
import { createMemoryHistory, MemoryRouter, Route, useLocation } from "@solidjs/router"
import { DialogProvider } from "@deepagent-code/ui/context/dialog"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import type { ImTasksRemoteStatusResponse } from "@deepagent-code/sdk"
import { SidePanelIM } from "@/pages/session/side-panel-im"
import { MessageList } from "@/components/im/message-list"
import { createIMClient, type IMClient } from "@/utils/im-client"
import { base64Encode } from "@deepagent-code/core/util/encode"
import { dict } from "@/i18n/en"

const wiring = vi.hoisted(() => ({ client: undefined as IMClient | undefined, sdk: {} as object, server: {} as object,
  panels: [] as string[] }))
vi.mock("@/utils/im-client", async (original) => ({ ...(await original<typeof import("@/utils/im-client")>()), useIMClient: () => wiring.client! }))
vi.mock("@/context/sdk", () => ({ useSDK: () => wiring.sdk }))
vi.mock("@/context/server", async (original) => ({ ...(await original<typeof import("@/context/server")>()), useServer: () => wiring.server }))
vi.mock("@/context/layout", () => ({ useLayout: () => ({ view: (key: () => string) => ({ rightPanel: { open: () => wiring.panels.push(key()) } }) }) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict, values?: Record<string, string | number>) =>
  Object.entries(values ?? {}).reduce((text, [key, value]) => text.replace(`{{${key}}}`, String(value)), dict[key]) }) }))
// This renderer verifies fresh HTTP presentation after the separately proven original
// SDK/Entry ingestion. It does not claim a browser WS or installed whole-App run.
vi.mock("@/hooks/use-im-websocket", () => ({ useIMWebSocket: () => ({ connected: () => true, messages: () => [],
  agentStatuses: () => new Map(), agentProgress: () => new Map(), typingMembers: () => new Set(), send: vi.fn(), reconnect: vi.fn() }) }))
afterEach(cleanup)

const actual = process.env.DAC_RECEIVER_TASK_LIVE ? it : it.skip

function logGeometry() {
  const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("role") === "log" ? 1000 : 0
  })
  const viewport = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("role") === "log" ? 240 : 0
  })
  return () => { height.mockRestore(); viewport.mockRestore() }
}

it("the receiver renderer gives remounted message logs the same scrollable geometry", async () => {
  const restore = logGeometry()
  try {
    const [owner, setOwner] = createSignal("A")
    render(() => <Show when={owner()} keyed>{(selected) => <div data-owner={selected}>
      <MessageList messages={[]} agentStatuses={new Map()} agentProgress={new Map()} /></div>}</Show>)
    const original = screen.getByRole("log")
    expect(original.scrollHeight - original.clientHeight).toBe(760)
    original.scrollTop = 73
    setOwner("B")
    await waitFor(() => expect(screen.getByRole("log")).not.toBe(original))
    const other = screen.getByRole("log")
    setOwner("A")
    await waitFor(() => expect(screen.getByRole("log")).not.toBe(other))
    const returned = screen.getByRole("log")
    expect(returned).not.toBe(original)
    expect(returned.scrollHeight - returned.clientHeight).toBe(760)
    returned.scrollTop = 73
    expect(returned.scrollTop).toBe(73)
  } finally { cleanup(); restore() }
})

actual("current A's real protected notice opens the original B task and returns with the draft and position", async () => {
  const restore = logGeometry()
  const filename = process.env.DAC_RECEIVER_TASK_LIVE!
  const live: { a: { url: string; directory: string }; b: { url: string; directory: string }; messageID: string; groupID: string;
    status: ImTasksRemoteStatusResponse; viewerOrigin?: string } = JSON.parse(await fs.readFile(filename, "utf8"))
  const surface = window as unknown as { happyDOM: { setURL(value: string): void } }
  if (live.viewerOrigin) surface.happyDOM.setURL(live.viewerOrigin)
  if (live.status.state !== "available" || !live.status.task.work) throw new Error("Original B task is unavailable")
  const sessionID = live.status.task.work.sessionID
  const a = createIMClient(() => ({ ...live.a, username: "qa", password: process.env.DAC_RECEIVER_TASK_A_PASSWORD })),
    b = createIMClient(() => ({ ...live.b, username: "qa", password: process.env.DAC_RECEIVER_TASK_B_PASSWORD }))
  const connections = [{ type: "http" as const, http: { ...a.scope() }, displayName: "Authenticated A" },
    { type: "http" as const, http: { ...b.scope() }, displayName: "Authenticated B" }]
  const [key, setKey] = createSignal(live.a.url)
  const install = (selected: string) => {
    wiring.client = selected === live.a.url ? a : b
    wiring.sdk = Object.freeze({ client: createDeepAgentCodeClient({ baseUrl: selected }), scope: selected,
      directory: selected === live.a.url ? live.a.directory : live.b.directory, url: selected })
  }
  install(live.a.url)
  wiring.server = { get key() { return key() }, get current() { return connections.find((item) => item.http.url === key()) },
    get list() { return connections }, scope: (selected = key()) => selected,
    setActive: (selected: string) => { install(selected); setKey(selected) },
    projects: { forServer: (selected: string) => ({ list: () => [{ worktree: selected === live.a.url ? live.a.directory : live.b.directory, expanded: true }] }) } }
  const source = `/${base64Encode(live.a.directory)}/session/receiving-origin?review=notice#original-chat`
  function Contents() {
    const location = useLocation()
    return <><p data-testid="receiver-route">{location.pathname}{location.search}{location.hash}</p>
      <Show when={key()} keyed>{(selected) => <div data-server-owner={selected}><SidePanelIM onClose={() => {}} /></div>}</Show></>
  }
  const history = createMemoryHistory()
  history.set({ value: source, replace: true, scroll: false })
  render(() => <MemoryRouter history={history} root={(props) => <DialogProvider>{props.children}</DialogProvider>}>
    <Route path="/:dir/session/:id" component={Contents} /></MemoryRouter>)
  try {
    fireEvent.click(await screen.findByRole("button", { name: /Original B notice/ }, { timeout: 10_000 }))
    await waitFor(() => expect(screen.getByRole("log").textContent).toContain("取消请求已接受"), { timeout: 10_000 })
    const draft = screen.getByRole("textbox", { name: dict["im.composer.placeholder"] })
    fireEvent.input(draft, { target: { value: "unsent receiving A draft" } })
    const previous = screen.getByRole("log")
    // HappyDOM has no layout. Supply real scrollable geometry to the existing
    // bookmark consumer rather than changing production restoration semantics.
    previous.scrollTop = 73; fireEvent.scroll(previous)
    fireEvent.click(screen.getByRole("button", { name: dict["im.taskResult.view"] }))
    fireEvent.click(await screen.findByRole("button", { name: dict["im.taskStatus.view"] }))
    await waitFor(() => expect(screen.getByRole("button", { name: dict["im.taskStatus.remoteFind"] }).hasAttribute("disabled")).toBe(false), { timeout: 10_000 })
    fireEvent.click(screen.getByRole("button", { name: dict["im.taskStatus.remoteFind"] }))
    fireEvent.click(await screen.findByRole("button", { name: `Authenticated B · ${live.b.directory}` }))
    await screen.findByText(`${dict["im.taskManagement.outcome"]}: succeeded`, {}, { timeout: 10_000 })
    expect(screen.getByText(`${dict["im.taskManagement.control"]}: cancelled`)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: dict["im.taskStatus.open"] }))
    await waitFor(() => expect(key()).toBe(live.b.url), { timeout: 10_000 })
    expect(screen.getByTestId("receiver-route").textContent).toBe(`/${base64Encode(live.b.directory)}/session/${sessionID}`)
    fireEvent.click(await screen.findByRole("button", { name: dict["im.taskResult.return"] }))
    await waitFor(() => expect(key()).toBe(live.a.url), { timeout: 10_000 })
    await waitFor(() => expect(screen.getByRole("log").textContent).toContain("取消请求已接受"), { timeout: 10_000 })
    expect(screen.getByTestId("receiver-route").textContent).toBe(source)
    expect((screen.getByRole("textbox", { name: dict["im.composer.placeholder"] }) as HTMLTextAreaElement).value).toBe("unsent receiving A draft")
    await waitFor(() => expect(screen.getByRole("log").scrollTop).toBe(73))
    await fs.writeFile(filename + ".gui.json", JSON.stringify({ completed: true, originalMessageID: live.messageID,
      groupID: live.groupID, sessionID, draftPreserved: true, scroll: 73, returnedToA: true,
      boundary: "actual SidePanel/official SDK/actual A+B Root HTTP; controlled saved-connection/router renderer" }), { mode: 0o600 })
  } finally { cleanup(); restore() }
}, 40_000)
