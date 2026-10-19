import { afterEach, expect, it, vi } from "vitest"
import { cleanup, render } from "@solidjs/testing-library"
import { createServer } from "node:http"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import type { Message, Part } from "@deepagent-code/sdk"
import type { CommandOption } from "@/context/command"
import { useSessionCommands } from "@/pages/session/use-session-commands"

const wiring = vi.hoisted(
  (): {
    client?: ReturnType<typeof createDeepAgentCodeClient>
    info: { id: string; title: string; time: { created: number; updated: number }; share?: { url: string } }
    messages: Message[]
    parts: Record<string, Part[]>
    commands: () => CommandOption[]
    navigation: string[]
    promoted: string[]
    toasts: unknown[]
  } => ({
    info: { id: "ses_outputs", title: "Owned transcript", time: { created: 1, updated: 2 } },
    messages: [],
    parts: {},
    commands: () => [],
    navigation: [],
    promoted: [],
    toasts: [],
  }),
)
vi.mock("@/context/command", () => ({
  useCommand: () => ({ register: (_key: string, commands: () => CommandOption[]) => (wiring.commands = commands) }),
}))
vi.mock("@/context/platform", () => ({ usePlatform: () => ({ platform: "web" }) }))
vi.mock("@/context/sdk", () => ({ useSDK: () => ({ client: wiring.client, directory: "/owned-outputs" }) }))
vi.mock("@/context/server-sync", () => ({ useServerSync: () => ({ data: { session_goal: {} } }) }))
vi.mock("@/context/sync", () => ({
  useSync: () => ({
    session: { get: () => wiring.info },
    data: {
      get message() {
        return { ses_outputs: wiring.messages }
      },
      get part() {
        return wiring.parts
      },
      session_working: () => false,
    },
  }),
}))
vi.mock("@/pages/session/session-layout", () => ({
  useSessionLayout: () => ({
    params: { id: "ses_outputs" },
    tabs: () => ({ all: () => [], active: () => undefined }),
    view: () => ({
      panel: { location: () => "bottom", sideAvailable: () => true, bottom: { opened: () => false } },
      rightPanel: { mode: () => "review", opened: () => false },
    }),
  }),
}))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/permission", () => ({ usePermission: () => ({ isAutoAccepting: () => false }) }))
vi.mock("@/context/prompt", () => ({ usePrompt: () => ({ set: () => {}, reset: () => {} }) }))
vi.mock("@/context/settings", () => ({ useSettings: () => ({ general: { showReasoningSummaries: () => true } }) }))
vi.mock("@/context/file", () => ({ useFile: () => ({ pathFromTab: () => undefined }) }))
vi.mock("@/context/local", () => ({
  useLocal: () => ({
    slug: () => "owned",
    session: { promote: (_directory: string, id: string) => wiring.promoted.push(id) },
  }),
}))
vi.mock("@/context/layout", () => ({ useLayout: () => ({ handoff: { setTabs: () => {} } }) }))
vi.mock("@/context/server", () => ({ useServer: () => ({}) }))
vi.mock("@/context/terminal", () => ({ useTerminalHosts: () => ({}) }))
vi.mock("@solidjs/router", () => ({ useNavigate: () => (href: string) => wiring.navigation.push(href) }))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({}) }))
vi.mock("@/components/dialog-event-work", () => ({ createEventWorkOwner: () => () => true }))
vi.mock("@/components/dialog-event-validation", () => ({ createEventValidationOwner: () => () => true }))
vi.mock("@/pages/session/prompt-stash", () => ({ createPromptStash: () => ({}) }))
vi.mock("@/utils/toast", () => ({ showToast: (value: unknown) => wiring.toasts.push(value) }))
afterEach(cleanup)

it("exports loaded transcript bytes, reconciles an exact fork retry and exposes only existing-link unshare", async () => {
  wiring.messages = [
    {
      id: "msg_output_user",
      sessionID: "ses_outputs",
      role: "user",
      time: { created: 1 },
      agent: "auto",
      model: { providerID: "owned", modelID: "offline" },
    },
    {
      id: "msg_output_answer",
      sessionID: "ses_outputs",
      role: "assistant",
      parentID: "msg_output_user",
      time: { created: 2, completed: 3 },
      providerID: "owned",
      modelID: "offline",
      mode: "auto",
      agent: "auto",
      path: { cwd: "/owned-outputs", root: "/owned-outputs" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  ]
  wiring.parts = Object.fromEntries(
    wiring.messages.map((message, index) => [
      message.id,
      [
        {
          id: `part_${index}`,
          sessionID: message.sessionID,
          messageID: message.id,
          type: "text" as const,
          text: index ? "Owned answer marker" : "Owned question marker",
        },
      ],
    ]),
  )
  const requests: { method?: string; path?: string; body: { intentID?: string } }[] = []
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Methods", "POST, DELETE, OPTIONS")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,x-deepagent-code-directory")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString()
    requests.push({ method: request.method, path: request.url, body: body ? JSON.parse(body) : {} })
    response.writeHead(requests.length === 1 ? 503 : 200, { "Content-Type": "application/json" })
    response.end(
      JSON.stringify(
        requests.length === 1 ? { message: "Owned fork unavailable" } : { ...wiring.info, id: "ses_forked_owned" },
      ),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Owned HTTP peer unavailable")
  wiring.client = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}`, throwOnError: true })
  const blobs: Blob[] = []
  const downloads: { name: string; href: string }[] = []
  const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL")
  const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL")
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      blobs.push(blob)
      return "blob:owned-transcript"
    },
  })
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() })
  const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, href: this.href })
  })
  try {
    render(() => {
      useSessionCommands({ navigateMessageByOffset: () => {}, setActiveMessage: () => {}, focusInput: () => {} })
      return null
    })
    const invoke = async (id: string) => {
      const command = wiring.commands().find((item) => item.id === id)
      expect(command?.disabled).toBe(false)
      await command?.onSelect?.("palette")
    }
    expect(wiring.commands().some((item) => item.id === "session.share")).toBe(false)
    expect(wiring.commands().find((item) => item.id === "session.unshare")?.disabled).toBe(true)
    await invoke("session.export")
    expect(downloads).toHaveLength(1)
    expect(downloads[0]?.name.endsWith(".md")).toBe(true)
    expect(downloads[0]?.href).toBe("blob:owned-transcript")
    expect(await blobs[0]!.text()).toContain("Owned question marker")
    expect(await blobs[0]!.text()).toContain("Owned answer marker")
    expect(requests).toHaveLength(0)
    await invoke("session.fork")
    expect(wiring.navigation).toEqual([])
    expect(wiring.toasts).toHaveLength(1)
    await invoke("session.fork")
    expect(requests.map((item) => item.path)).toEqual(["/session/ses_outputs/fork", "/session/ses_outputs/fork"])
    expect(requests[0]?.body.intentID).toBeTruthy()
    expect(requests[1]?.body.intentID).toBe(requests[0]?.body.intentID)
    expect(wiring.promoted).toEqual(["ses_forked_owned"])
    expect(wiring.navigation).toEqual(["/owned/session/ses_forked_owned"])
    wiring.info.share = { url: "https://example.invalid/owned-existing" }
    await invoke("session.unshare")
    expect(requests[2]?.method).toBe("DELETE")
    expect(requests[2]?.path).toBe("/session/ses_outputs/share")
    expect(requests).toHaveLength(3)
  } finally {
    cleanup()
    clicked.mockRestore()
    if (originalCreate) Object.defineProperty(URL, "createObjectURL", originalCreate)
    else Reflect.deleteProperty(URL, "createObjectURL")
    if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke)
    else Reflect.deleteProperty(URL, "revokeObjectURL")
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
