import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createServer } from "node:http"
import { GroupChatPanel } from "@/components/im/group-chat-panel"
import { createIMClient, type IMClient } from "@/utils/im-client"
import { dict } from "@/i18n/en"

const runtime = vi.hoisted(() => ({ client: undefined as IMClient | undefined }))
vi.mock("@/utils/im-client", async (original) => ({
  ...(await original<typeof import("@/utils/im-client")>()),
  useIMClient: () => runtime.client!,
}))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    Socket.instances.push(this)
  }
  send() {}
  close() {
    this.readyState = 3
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  invalidate() {
    this.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "reader_invalidated",
          data: { groupID: "protected", displayEpoch: "original-epoch", code: "reader_unavailable" },
        }),
      }),
    )
  }
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Socket.instances = []
})
async function serve(mode: "explicit_task" | "ordinary", available = true) {
  const state = { calls: [] as string[], rejectHistory: false }
  const message = {
    id: "current-incoming",
    groupID: "protected",
    senderID: "peer",
    senderType: "user",
    type: "text",
    content: "Original incoming request",
    mentions: null,
    metadata: null,
    replyToID: null,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  }
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Authorization,x-deepagent-code-directory,Content-Type")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    const url = new URL(request.url ?? "/", "http://localhost")
    state.calls.push(url.pathname)
    const send = (body: unknown, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" })
      response.end(JSON.stringify(body))
    }
    if (url.pathname.endsWith("/capability"))
      return send({
        enrollment: "active",
        proposal: available ? "available" : "unavailable",
        execution: "explicit_accept",
        code: "LOCAL_TASK_EXPLICIT_APPROVAL_REQUIRED",
      })
    if (url.pathname.endsWith("/conversations/protected"))
      return send({
        groupID: "protected",
        revision: 1,
        mode,
        target: mode === "explicit_task" ? { targetID: "original-target" } : null,
      })
    if (url.pathname.endsWith("/agents")) return send([])
    if (state.rejectHistory) return send({ code: "reader_unavailable" }, 503)
    return send({
      messages: [message],
      nextCursor: null,
      hasMore: false,
      reader: {
        state: "ready",
        displayEpoch: "original-epoch",
        projectionRevision: "1",
        validatedServerNow: 1000,
        nextExpiryAt: 601000,
      },
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Listener missing")
  runtime.client = createIMClient(() => ({
    url: `http://127.0.0.1:${address.port}`,
    directory: "/private/project",
    password: "fixture-only",
  }))
  vi.stubGlobal("WebSocket", Socket)
  return {
    state,
    message,
    async close() {
      cleanup()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
it("the protected parent offers only a personal draft reference and withdraws it when reader access expires", async () => {
  const fixture = await serve("explicit_task")
  const propose = vi.fn()
  try {
    render(() => (
      <GroupChatPanel
        groupID="protected"
        protected
        reader={{ mode: "protected", state: "ready", liveUnread: "1" }}
        onUseDac={propose}
      />
    ))
    await waitFor(() => expect(Socket.instances).toHaveLength(1))
    expect(screen.queryByRole("button", { name: dict["im.dac.action"] })).toBeNull()
    Socket.instances[0].open()
    fireEvent.click(await screen.findByRole("button", { name: dict["im.dac.action"] }))
    expect(propose).toHaveBeenCalledOnce()
    expect(propose.mock.calls[0][0]).toMatchObject(fixture.message)
    expect(fixture.state.calls.some((path) => path.endsWith("/capability"))).toBe(false)
    expect(fixture.state.calls.some((path) => path.endsWith("/conversations/protected"))).toBe(false)
    fixture.state.rejectHistory = true
    Socket.instances[0].invalidate()
    await waitFor(() => expect(screen.queryByRole("button", { name: dict["im.dac.action"] })).toBeNull())
    expect(propose).toHaveBeenCalledOnce()
  } finally {
    await fixture.close()
  }
})
it.each([
  { mode: "ordinary" as const, available: true },
  { mode: "explicit_task" as const, available: false },
])(
  "personal drafts are independent of the retired $mode / capability=$available policy",
  async ({ mode, available }) => {
    const fixture = await serve(mode, available)
    const draft = vi.fn()
    try {
      render(() => (
        <GroupChatPanel
          groupID="protected"
          protected
          reader={{ mode: "protected", state: "ready", liveUnread: "1" }}
          onUseDac={draft}
        />
      ))
      await waitFor(() => expect(Socket.instances).toHaveLength(1))
      Socket.instances[0].open()
      await screen.findByText(fixture.message.content)
      fireEvent.click(await screen.findByRole("button", { name: dict["im.dac.action"] }))
      expect(draft).toHaveBeenCalledOnce()
      expect(
        fixture.state.calls.some((path) => path.endsWith("/capability") || path.endsWith("/conversations/protected")),
      ).toBe(false)
    } finally {
      await fixture.close()
    }
  },
)
