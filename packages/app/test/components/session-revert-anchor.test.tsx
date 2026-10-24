import { afterEach, expect, it, vi } from "vitest"
import { cleanup, render } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { createServer } from "node:http"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import type { Part, UserMessage } from "@deepagent-code/sdk"
import type { CommandOption } from "@/context/command"
import { useSessionCommands } from "@/pages/session/use-session-commands"

type Projection = {
  info: { revert?: { messageID: string } }
  message: Record<string, UserMessage[]>
  part: Record<string, Part[]>
}

const wiring = vi.hoisted(
  (): {
    client?: ReturnType<typeof createDeepAgentCodeClient>
    projection?: Projection
    commands: () => CommandOption[]
  } => ({ commands: () => [] }),
)

vi.mock("@/context/command", () => ({
  useCommand: () => ({ register: (_key: string, commands: () => CommandOption[]) => (wiring.commands = commands) }),
}))
vi.mock("@/context/platform", () => ({ usePlatform: () => ({ platform: "web" }) }))
vi.mock("@/context/sdk", () => ({ useSDK: () => ({ client: wiring.client, directory: "/anchor-project" }) }))
vi.mock("@/context/server-sync", () => ({ useServerSync: () => ({ data: { session_goal: {} } }) }))
vi.mock("@/context/sync", () => ({
  useSync: () => ({
    session: { get: () => wiring.projection?.info },
    data: {
      get message() {
        return wiring.projection?.message
      },
      get part() {
        return wiring.projection?.part
      },
      session_working: () => false,
    },
  }),
}))
vi.mock("@/pages/session/session-layout", () => ({
  useSessionLayout: () => ({
    params: { id: "anchor-session" },
    tabs: () => ({ all: () => [], active: () => undefined }),
    view: () => ({
      panel: { location: () => "bottom", sideAvailable: () => true, bottom: { opened: () => false } },
      rightPanel: { mode: () => "review" },
    }),
  }),
}))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/permission", () => ({ usePermission: () => ({ isAutoAccepting: () => false }) }))
vi.mock("@/context/prompt", () => ({ usePrompt: () => ({ set: () => {}, reset: () => {} }) }))
vi.mock("@/context/settings", () => ({ useSettings: () => ({ general: { showReasoningSummaries: () => true } }) }))
vi.mock("@/context/file", () => ({ useFile: () => ({ pathFromTab: () => undefined }) }))
vi.mock("@/context/local", () => ({ useLocal: () => ({}) }))
vi.mock("@/context/layout", () => ({ useLayout: () => ({}) }))
vi.mock("@/context/server", () => ({ useServer: () => ({}) }))
vi.mock("@/context/terminal", () => ({ useTerminalHosts: () => ({}) }))
vi.mock("@solidjs/router", () => ({ useNavigate: () => () => {} }))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({}) }))
vi.mock("@/components/dialog-event-work", () => ({ createEventWorkOwner: () => () => true }))
vi.mock("@/components/dialog-event-validation", () => ({ createEventValidationOwner: () => () => true }))
vi.mock("@/pages/session/prompt-stash", () => ({ createPromptStash: () => ({}) }))

afterEach(cleanup)

it("canonical undo and redo preserve opaque IDs, skip notices, and refuse an unloaded boundary", async () => {
  const ids = {
    a: "msg_z-first",
    b: "msg_n-notice",
    c: "msg_m-steered",
    d: "msg_y-notice",
    e: "msg_a-queued",
    f: "msg_c-notice",
  }
  const users = (["a", "b", "c", "d", "e", "f"] as const).map(
    (id, index): UserMessage => ({
      id: ids[id],
      sessionID: "anchor-session",
      role: "user",
      time: { created: { a: 10, b: 50, c: 40, d: 60, e: 20, f: 70 }[id] },
      canonicalSeq: [3, 50, 101, 150, 201, 250][index],
      agent: "auto",
      model: { providerID: "deepseek", modelID: "deepseek-flash" },
    }),
  )
  const [projection, setProjection] = createStore<Projection>({
    info: { revert: { messageID: ids.a } },
    message: { "anchor-session": users.toSorted((left, right) => left.time.created - right.time.created) },
    part: {
      [ids.a]: [{ id: "a-text", sessionID: "anchor-session", messageID: ids.a, type: "text", text: "original prompt" }],
      ...Object.fromEntries(
        (["b", "d", "f"] as const).map((messageID) => [
          ids[messageID],
          [
            {
              id: `${messageID}-notice`,
              sessionID: "anchor-session",
              messageID: ids[messageID],
              type: "text",
              text: "synthetic revert notice",
              synthetic: true,
            },
          ],
        ]),
      ),
      [ids.c]: [],
      [ids.e]: [
        {
          id: "e-file",
          sessionID: "anchor-session",
          messageID: ids.e,
          type: "file",
          mime: "text/plain",
          url: "file:///anchor-project/input.txt",
        },
      ],
    },
  })
  wiring.projection = projection
  const requests: { url: string; messageID?: string }[] = []
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,x-deepagent-code-directory")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString()
    const messageID: unknown = body ? JSON.parse(body).messageID : undefined
    requests.push({ url: request.url ?? "", messageID: typeof messageID === "string" ? messageID : undefined })
    setProjection("info", "revert", typeof messageID === "string" ? { messageID } : undefined)
    response.writeHead(200, { "Content-Type": "application/json" }).end("{}")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Original HTTP peer was not bound")
  wiring.client = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}` })
  const active = vi.fn()
  try {
    render(() => {
      useSessionCommands({ navigateMessageByOffset: () => {}, setActiveMessage: active, focusInput: () => {} })
      return null
    })
    const invoke = async (id: string) => {
      const command = wiring.commands().find((command) => command.id === id)
      expect(command?.disabled).toBe(false)
      await command?.onSelect?.("palette")
    }
    await invoke("session.redo")
    expect(requests.at(-1)).toEqual({ url: "/session/anchor-session/revert", messageID: ids.c })
    await invoke("session.redo")
    expect(requests.at(-1)).toEqual({ url: "/session/anchor-session/revert", messageID: ids.e })
    await invoke("session.redo")
    expect(requests.at(-1)).toEqual({ url: "/session/anchor-session/unrevert", messageID: undefined })
    expect(projection.info.revert).toBeUndefined()
    expect(active.mock.lastCall?.[0].id).toBe(ids.e)
    await invoke("session.undo")
    await invoke("session.undo")
    await invoke("session.undo")
    expect(requests.slice(3).map((request) => request.messageID)).toEqual([ids.e, ids.c, ids.a])
    expect(wiring.commands().find((command) => command.id === "session.undo")?.disabled).toBe(true)
    expect(requests).toHaveLength(6)
    setProjection("info", "revert", { messageID: "unloaded-target" })
    expect(wiring.commands().find((command) => command.id === "session.redo")?.disabled).toBe(true)
    await wiring
      .commands()
      .find((command) => command.id === "session.redo")
      ?.onSelect?.("palette")
    await wiring
      .commands()
      .find((command) => command.id === "session.undo")
      ?.onSelect?.("palette")
    expect(requests).toHaveLength(6)
  } finally {
    cleanup()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
