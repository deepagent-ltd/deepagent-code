import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { createServer } from "node:http"
import { createOpencodeClient, type AttentionItem } from "@deepagent-code/sdk"
import { AttentionInbox } from "@/components/dialog-attention"
import { dict } from "@/i18n/en"

const boundary = vi.hoisted(() => ({ sdk: () => ({}), server: () => ({}) }))
vi.mock("@/context/server-sdk", () => ({ useServerSDK: () => boundary.sdk() }))
vi.mock("@/context/server", () => ({ useServer: () => boundary.server() }))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    intl: () => "en",
    t: (key: keyof typeof dict, values?: Record<string, string | number>) =>
      Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.replace(`{{${name}}}`, String(value)),
        dict[key],
      ),
  }),
}))
afterEach(cleanup)

async function fixture() {
  const item: AttentionItem = {
    id: "no-progress:original-activity",
    revision: "original-revision",
    kind: "no_progress",
    state: "needs_human",
    reasonCode: "no_progress",
    occurredAt: 1,
    observedAt: 2,
    seen: false,
    seenAt: null,
    session: {
      id: "original-session",
      title: "Original paused activity",
      projectID: "original-project",
      directory: "/projects/original",
      workspaceID: null,
    },
    source: {
      activityID: "original-activity",
      permissionRequestID: "original-permission",
      expiresAt: Date.now() + 60000,
    },
    allowedActions: ["continue_once", "terminate"],
  }
  const state = {
    item,
    reads: 0,
    fresh: undefined as AttentionItem | undefined,
    getDelay: undefined as Promise<void> | undefined,
    postDelay: undefined as Promise<void> | undefined,
    listDelay: undefined as Promise<void> | undefined,
    getStatus: 200,
    postStatus: 204,
    calls: [] as { method: string; path: string; body: unknown; auth?: string }[],
  }
  const listener = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization")
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname)
    state.calls.push({ method: request.method ?? "GET", path, body, auth: request.headers.authorization })
    const send = (data: unknown, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" })
      response.end(JSON.stringify(data))
    }
    if (path === "/api/attention/capability")
      return send({ enabled: true, actor: "server", scope: "implicit-local", reason: "enabled" })
    if (path === "/api/attention") {
      await state.listDelay
      return send({ data: [state.item], unseenCount: Number(!state.item.seen), asOf: 2, scope: "implicit-local" })
    }
    if (path === `/api/attention/${item.id}`) {
      state.reads++
      if (state.reads > 1) await state.getDelay
      return send({ data: state.reads > 1 ? (state.fresh ?? state.item) : state.item }, state.getStatus)
    }
    if (path.endsWith("/seen")) {
      state.item = { ...state.item, seen: true, seenAt: 3 }
      return send({ data: state.item })
    }
    if (path === "/api/session/original-session/permission/original-permission/reply") {
      await state.postDelay
      if (state.postStatus !== 204) return send({ message: "private failure" }, state.postStatus)
      state.item = { ...state.item, allowedActions: [] }
      response.writeHead(204).end()
      return
    }
    send({}, 404)
  })
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("Owned HTTP listener missing")
  const url = `http://127.0.0.1:${address.port}`
  const client = createOpencodeClient({ baseUrl: url, headers: { Authorization: "Basic fixture-only" } })
  const [owner, setOwner] = createStore({
    key: "server-a",
    scope: "scope-a",
    connection: { http: { url, username: "server", password: "fixture-only" } },
  })
  boundary.sdk = () => ({
    client,
    get url() {
      return owner.connection.http.url
    },
    get scope() {
      return owner.scope
    },
  })
  boundary.server = () => ({
    get key() {
      return owner.key
    },
    get current() {
      return owner.connection
    },
  })
  return {
    state,
    setOwner,
    replies: () => state.calls.filter((call) => call.method === "POST"),
    async close() {
      listener.closeAllConnections()
      await new Promise<void>((resolve) => listener.close(() => resolve()))
    },
  }
}
async function open() {
  render(() => <AttentionInbox onOpenSession={() => {}} />)
  fireEvent.click(await screen.findByRole("button", { name: dict["attention.details"] }))
  await screen.findByRole("button", { name: dict["attention.continueOnce"] })
}

it("uses the real SDK fresh item GET then exactly one once reply; reading and seen do not approve", async () => {
  const api = await fixture()
  try {
    await open()
    fireEvent.click(screen.getByRole("button", { name: dict["attention.markSeen"] }))
    await screen.findByText(dict["attention.seen"])
    expect(api.replies()).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: dict["attention.continueOnce"] }))
    await screen.findByText(dict["attention.actionSubmitted"])
    expect(api.replies()).toEqual([
      {
        method: "POST",
        path: "/api/session/original-session/permission/original-permission/reply",
        body: { reply: "once" },
        auth: "Basic fixture-only",
      },
    ])
    expect(api.state.reads).toBe(2)
    expect(screen.queryByRole("button", { name: dict["attention.continueOnce"] })).toBeNull()
  } finally {
    cleanup()
    await api.close()
  }
})

it("supports a terminate-only current item and requires the second explicit confirmation", async () => {
  const api = await fixture()
  api.state.item.allowedActions = ["terminate"]
  try {
    render(() => <AttentionInbox onOpenSession={() => {}} />)
    fireEvent.click(await screen.findByRole("button", { name: dict["attention.details"] }))
    fireEvent.click(await screen.findByRole("button", { name: dict["attention.terminate"] }))
    expect(api.replies()).toHaveLength(0)
    expect(screen.queryByRole("button", { name: dict["attention.continueOnce"] })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: dict["attention.confirmTerminate"] }))
    await screen.findByText(dict["attention.actionSubmitted"])
    expect(api.replies()[0]?.body).toEqual({ reply: "reject" })
  } finally {
    cleanup()
    await api.close()
  }
})

it.each(["expiry", "source", "actions"])("rejects fresh %s changes without a permission reply", async (change) => {
  const api = await fixture()
  try {
    await open()
    api.state.fresh = {
      ...api.state.item,
      source:
        change === "source"
          ? { ...api.state.item.source, permissionRequestID: "replacement" }
          : change === "expiry"
            ? { ...api.state.item.source, expiresAt: Date.now() - 1 }
            : api.state.item.source,
      allowedActions: change === "actions" ? ["terminate"] : api.state.item.allowedActions,
    }
    fireEvent.click(screen.getByRole("button", { name: dict["attention.continueOnce"] }))
    await screen.findByText(dict["attention.approvalChanged"])
    expect(api.replies()).toHaveLength(0)
    expect(screen.getByText("Original paused activity")).toBeTruthy()
  } finally {
    cleanup()
    await api.close()
  }
})

it.each(["server", "credentials"])(
  "invalidates pending approval on %s change and discards a late item",
  async (change) => {
    const api = await fixture()
    const delay = Promise.withResolvers<void>()
    try {
      await open()
      api.state.getDelay = delay.promise
      fireEvent.click(screen.getByRole("button", { name: dict["attention.continueOnce"] }))
      await waitFor(() => expect(api.state.reads).toBe(2))
      if (change === "server") api.setOwner("key", "server-b")
      if (change === "credentials") api.setOwner("connection", "http", "password", "other-credential")
      delay.resolve()
      await screen.findByText(dict["attention.serverChanged"])
      expect(api.replies()).toHaveLength(0)
      expect(screen.queryByText("Original paused activity")).toBeNull()
    } finally {
      delay.resolve()
      cleanup()
      await api.close()
    }
  },
)

it("coalesces double clicks and leaves an unknown reply failure for an explicit fresh retry", async () => {
  const api = await fixture()
  const delay = Promise.withResolvers<void>()
  try {
    await open()
    api.state.postDelay = delay.promise
    api.state.postStatus = 503
    const button = screen.getByRole("button", { name: dict["attention.continueOnce"] })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(api.replies()).toHaveLength(1))
    delay.resolve()
    await screen.findByText(dict["attention.actionError"])
    expect(api.replies()).toHaveLength(1)
    expect(screen.getByText("Original paused activity")).toBeTruthy()
    expect(screen.queryByText("private failure")).toBeNull()
  } finally {
    delay.resolve()
    cleanup()
    await api.close()
  }
})

it("closing during fresh validation prevents a late POST", async () => {
  const api = await fixture()
  const delay = Promise.withResolvers<void>()
  try {
    await open()
    api.state.getDelay = delay.promise
    fireEvent.click(screen.getByRole("button", { name: dict["attention.continueOnce"] }))
    await waitFor(() => expect(api.state.reads).toBe(2))
    cleanup()
    delay.resolve()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(api.replies()).toHaveLength(0)
  } finally {
    delay.resolve()
    cleanup()
    await api.close()
  }
})

it("an earlier poll cannot retarget an approval that the user already selected", async () => {
  const api = await fixture()
  const list = Promise.withResolvers<void>()
  const detail = Promise.withResolvers<void>()
  try {
    await open()
    api.state.listDelay = list.promise
    fireEvent.click(screen.getByRole("button", { name: dict["attention.refresh"] }))
    await waitFor(() => expect(api.state.calls.filter((call) => call.path === "/api/attention")).toHaveLength(2))
    api.state.getDelay = detail.promise
    fireEvent.click(screen.getByRole("button", { name: dict["attention.continueOnce"] }))
    await waitFor(() => expect(api.state.reads).toBe(2))
    api.state.item = {
      ...api.state.item,
      revision: "replacement-revision",
      source: {
        ...api.state.item.source,
        activityID: "replacement-activity",
        permissionRequestID: "replacement-permission",
      },
    }
    list.resolve()
    await screen.findByText("replacement-activity")
    detail.resolve()
    await waitFor(() => expect(screen.queryByRole("button", { name: dict["attention.acting"] })).toBeNull())
    expect(api.replies()).toHaveLength(0)
  } finally {
    list.resolve()
    detail.resolve()
    cleanup()
    await api.close()
  }
})
