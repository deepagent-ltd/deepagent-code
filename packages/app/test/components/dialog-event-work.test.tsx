import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import { createServer } from "node:http"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { DialogEventWork } from "@/components/dialog-event-work"
import { dict } from "@/i18n/en"

const wiring = vi.hoisted(() => ({ sdk: {} as object, close: vi.fn() }))
vi.mock("@/context/sdk", () => ({ useSDK: () => wiring.sdk }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({ close: wiring.close }) }))
vi.mock("@deepagent-code/ui/dialog", () => ({
  Dialog: (props: { title: string; children: JSX.Element }) => (
    <section aria-label={props.title}>{props.children}</section>
  ),
}))
afterEach(cleanup)

const budget = {
  maxTotalTokens: 2_105_344,
  maxInputTokens: 1_048_576,
  maxCompletionTokens: 4096,
  maxProviderDispatches: 2,
  maxToolCalls: 4,
  maxChildren: 2,
  maxDurationMs: 600_000,
  hourTokensMax: 2_105_344,
  hourWindowMinutes: 60,
}
const plan = {
  version: 1,
  id: "approved-two-node-plan",
  maxConcurrent: 2,
  nodes: [
    {
      id: "read",
      agentID: "approved-reader",
      instruction: "Read approved data",
      dependencies: [],
      toolIDs: ["read"],
      budget: { ...budget, maxChildren: 0 },
      requiresWriteIsolation: false,
    },
    {
      id: "summarize",
      agentID: "approved-reviewer",
      instruction: "Review the verified predecessor",
      dependencies: ["read"],
      toolIDs: ["read"],
      budget: { ...budget, maxChildren: 0 },
      requiresWriteIsolation: false,
    },
  ],
}
const candidate = {
  originID: "approved-origin",
  targetID: "approved-target",
  sourceSessionID: "ordinary-source",
  mode: "dag",
  profile: { id: "event_deepseek_dag_v1", version: 1, hash: "a".repeat(64) },
  providerID: "deepseek",
  modelID: "deepseek-flash",
  available: true,
  budget,
  plan,
  planHash: "b".repeat(64),
  serverNow: Date.now(),
  maxExpiresAt: Date.now() + 3_600_000,
}
const rule = {
  ruleID: "event-rule",
  revision: 1,
  epoch: 1,
  originID: candidate.originID,
  targetID: candidate.targetID,
  mode: "dag",
  state: "enabled",
  instruction: "Review terminal facts",
  expiresAt: candidate.maxExpiresAt,
  enabledAfterOrdinal: 3,
  planID: plan.id,
  planHash: candidate.planHash,
  allowedActions: ["pause", "revoke"],
}
const root = {
  rootID: "original-root",
  receiptID: "original-receipt",
  ruleID: rule.ruleID,
  revision: 1,
  mode: "dag",
  state: "unknown",
  controlState: "active",
  expiresAt: candidate.maxExpiresAt,
  planID: plan.id,
  planHash: candidate.planHash,
  budget,
  reservedTokens: 1_052_672,
  providerConcurrency: 1,
  schedulingConcurrency: 2,
  nodes: [
    {
      nodeID: "read",
      agentID: "approved-reader",
      dependencies: [],
      state: "unknown",
      workID: "original-work",
      sessionID: "historical-session",
      inputID: "original-input",
      controlRevision: 1,
      reservedTokens: 1_052_672,
      reason: "effect_unconfirmed",
      sessionAvailable: false,
    },
    {
      nodeID: "summarize",
      agentID: "approved-reviewer",
      dependencies: ["read"],
      state: "awaiting_dependencies",
      reservedTokens: 0,
      sessionAvailable: false,
    },
  ],
  allowedActions: ["cancel"],
  reason: "effect_unconfirmed",
}

async function serve(
  handler: (request: {
    path: string
    method: string
    body?: Record<string, unknown>
    query: URLSearchParams
    headers: Record<string, string | string[] | undefined>
  }) => Promise<{ status?: number; data: unknown }> | { status?: number; data: unknown },
) {
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "http://localhost:3000")
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type,Authorization,x-opencode-directory,x-opencode-workspace,x-deepagent-code-directory,x-deepagent-code-workspace",
    )
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const data = await handler({
      path: new URL(request.url ?? "/", "http://fixture").pathname,
      method: request.method ?? "GET",
      query: new URL(request.url ?? "/", "http://fixture").searchParams,
      headers: request.headers,
      body: chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : undefined,
    })
    response.writeHead(data.status ?? 200, { "Content-Type": "application/json" })
    response.end(JSON.stringify(data.data))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No private HTTP fixture address")
  return {
    client: createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}`, fetch: globalThis.fetch }),
    createClient: (options: NonNullable<Parameters<typeof createDeepAgentCodeClient>[0]>) => createDeepAgentCodeClient({ ...options, baseUrl: `http://127.0.0.1:${address.port}`, fetch: globalThis.fetch }),
    close: async () => {
      cleanup()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}

// Actual renderer + generated SDK protocol evidence; these fixtures do not mint grants or execute Work.
it("shows DAG unknown custody, preserves the original cancel through a reopen and confirms only the exact command", async () => {
  const commands: Record<string, unknown>[] = []
  let currentRoot = root
  const server = await serve(({ path, method, body }) => {
    if (path.endsWith("/control")) {
      commands.push(body ?? {})
      if (commands.length === 1)
        return { status: 503, data: { code: "EVENT_WORK_UNAVAILABLE", status: 503, message: "Unavailable" } }
      currentRoot = {
        ...root,
        revision: 2,
        controlState: "cancelled",
        state: "unknown",
        reservedTokens: root.reservedTokens,
      }
      return {
        data: {
          requestID: body?.requestID,
          expectedRevision: body?.expectedRevision,
          action: "cancel",
          replayed: true,
          root: currentRoot,
        },
      }
    }
    if (path.endsWith("/candidates")) return { data: [candidate] }
    if (path.endsWith("/rules")) return { data: { items: [rule], nextCursor: null } }
    if (path.endsWith("/roots")) return { data: { items: [currentRoot], nextCursor: null } }
    return { status: 404, data: {} }
  })
  try {
    wiring.sdk = { client: server.client, scope: "current-server", directory: "/private/current-project" }
    const first = render(() => <DialogEventWork sessionID="ordinary-source" onOpenSession={vi.fn()} />)
    await screen.findByRole("button", { name: dict["eventWork.cancel"] })
    expect(screen.queryByRole("button", { name: dict["eventWork.open"] })).toBeNull()
    expect(screen.getAllByText(dict["eventWork.reserveHint"]).length).toBeGreaterThan(0)
    expect(screen.getByText(dict["eventWork.serialProvider"], { exact: false })).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: dict["eventWork.cancel"] }))
    await screen.findByRole("button", { name: dict["eventWork.confirm"] })
    fireEvent.click(screen.getByRole("button", { name: dict["eventWork.confirm"] }))
    await screen.findByRole("button", { name: dict["eventWork.retry"] })
    await waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0].sourceSessionID).toBe("ordinary-source")
    first.unmount()
    render(() => <DialogEventWork sessionID="ordinary-source" />)
    await screen.findByRole("button", { name: dict["eventWork.retry"] })
    expect(commands).toHaveLength(1)
    await waitFor(() => expect((screen.getByRole("button", { name: dict["eventWork.retry"] }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: dict["eventWork.retry"] }))
    await screen.findByText(dict["eventWork.accepted"])
    expect(commands).toHaveLength(2)
    expect(commands[1]).toEqual(commands[0])
    expect(screen.getAllByText("effect_unconfirmed", { exact: false }).length).toBeGreaterThan(0)
  } finally {
    await server.close()
  }
})

it("a typed unavailable read does not assert an empty list or expose mutation controls", async () => {
  const methods: string[] = []
  const server = await serve(({ method }) => {
    methods.push(method)
    return { status: 403, data: { code: "EVENT_WORK_AUTH_REQUIRED", status: 403, message: "Unavailable" } }
  })
  try {
    wiring.sdk = { client: server.client, scope: "new-server", directory: "/private/new-project" }
    render(() => <DialogEventWork sessionID="ordinary-source" />)
    await screen.findByRole("alert")
    expect(screen.queryByText(dict["eventWork.empty"])).toBeNull()
    expect((screen.getByRole("button", { name: dict["eventWork.new"] }) as HTMLButtonElement).disabled).toBe(true)
    expect(methods).toEqual(["POST", "POST"])
  } finally {
    await server.close()
  }
})


it("an unavailable approved DAG remains inspectable but cannot silently submit a new rule", async () => {
  const controls: string[] = []
  const server = await serve(({ path }) => {
    if (path.endsWith("/control")) controls.push(path)
    if (path.endsWith("/candidates")) return { data: [{ ...candidate, available: false, reason: "isolation_unavailable" }] }
    return { data: { items: [], nextCursor: null } }
  })
  try {
    wiring.sdk = { client: server.client, scope: "isolated-placement-missing", directory: "/private/current-project" }
    render(() => <DialogEventWork sessionID="ordinary-source" />)
    await screen.findByText(dict["eventWork.empty"])
    fireEvent.click(screen.getByRole("button", { name: dict["eventWork.new"] }))
    await screen.findByText(dict["eventWork.isolationUnavailable"])
    expect(screen.getByText(plan.id, { exact: false })).toBeDefined()
    fireEvent.input(screen.getByLabelText(dict["eventWork.instruction"]), { target: { value: "Review original terminal data" } })
    expect((screen.getByRole("button", { name: dict["eventWork.preview"] }) as HTMLButtonElement).disabled).toBe(true)
    expect(controls).toEqual([])
  } finally { await server.close() }
})

it("opening a node session uses only the qualified pointer and preserves implicit null placement through both reads", async () => {
  const calls: string[] = []
  const pointer = { version: 1, rootID: root.rootID, nodeID: "read", workID: "original-work", sessionID: "historical-session",
    inputID: "original-input", rootRevision: 1, controlRevision: 1, bindingHash: "b".repeat(64),
    placement: { directory: "/private/current-project", workspaceID: null, projectID: "project", securityNamespaceID: "namespace", namespaceBindingHash: "c".repeat(64) }, expiresAt: Date.now() + 600_000 }
  const opens: string[] = []
  const server = await serve(({ path, body }) => {
    calls.push(path)
    if (path.endsWith("/candidates")) return { data: [candidate] }
    if (path.endsWith("/rules")) return { data: { items: [rule], nextCursor: null } }
    if (path.endsWith("/roots")) return { data: { items: [{ ...root, nodes: [{ ...root.nodes[0], sessionAvailable: true }] }], nextCursor: null } }
    if (path === "/api/v1/event-work/session") {
      expect(body).toMatchObject({ sourceSessionID: "ordinary-source", rootID: root.rootID, nodeID: "read" })
      return { data: pointer }
    }
    if (path === "/session/historical-session") return { data: { id: pointer.sessionID, directory: pointer.placement.directory,
      workspaceID: null, projectID: pointer.placement.projectID } }
    return { status: 404, data: {} }
  })
  try {
    wiring.sdk = { client: server.client, createClient: server.createClient, scope: "original-session-pointer", directory: "/private/current-project" }
    render(() => <DialogEventWork sessionID="ordinary-source" onOpenSession={(id) => opens.push(id)} />)
    fireEvent.click(await screen.findByRole("button", { name: dict["eventWork.open"] }))
    await waitFor(() => expect(opens).toEqual([pointer.sessionID]))
    expect(calls.slice(-3)).toEqual(["/api/v1/event-work/session", "/session/historical-session", "/api/v1/event-work/session"])
    expect(calls.some((path) => path.endsWith("/control"))).toBe(false)
  } finally { await server.close() }
})

it("event management pagination follows only explicit server cursors and retains source scope", async () => {
  const pages: { path: string; body?: Record<string, unknown> }[] = []
  const server = await serve(({ path, body }) => {
    pages.push({ path, body })
    if (path.endsWith("/candidates")) return { data: [candidate] }
    if (path.endsWith("/rules")) return { data: { items: [body?.after === "rule-page-two" ? { ...rule, ruleID: "second-rule" } : rule], nextCursor: body?.after ? null : "rule-page-two" } }
    if (path.endsWith("/roots")) return { data: { items: [{ ...root, ruleID: body?.ruleID }], nextCursor: null } }
    return { status: 404, data: {} }
  })
  try {
    wiring.sdk = { client: server.client, scope: "paginated-scope", directory: "/private/current-project" }
    render(() => <DialogEventWork sessionID="ordinary-source" />)
    const next = await screen.findByRole("button", { name: dict["eventWork.moreRules"] })
    expect(pages.some((page) => page.body?.after)).toBe(false)
    fireEvent.click(next)
    await screen.findByRole("button", { name: /second-rule/ })
    const page = pages.find((page) => page.path.endsWith("/rules") && page.body?.after)
    expect(page?.body).toEqual({ sourceSessionID: "ordinary-source", limit: 32, after: "rule-page-two" })
    expect(pages.some((page) => page.path.endsWith("/control"))).toBe(false)
    expect(screen.queryByRole("button", { name: dict["eventWork.moreRules"] })).toBeNull()
  } finally { await server.close() }
})

it.each([false, true])("qualified derived-child pointer uses the actual child scope and denies late pointer changes=%s", async (changed) => {
  const child = "/private/current-project/derived-worktree"
  const pointer = { version: 1, rootID: root.rootID, nodeID: "read", workID: "original-work", sessionID: "child-session",
    inputID: "original-input", rootRevision: 1, controlRevision: 1, bindingHash: "b".repeat(64),
    placement: { directory: child, workspaceID: null, projectID: "child-project", securityNamespaceID: "namespace", namespaceBindingHash: "c".repeat(64) }, expiresAt: Date.now() + 600_000 }
  const reads: { path: string; directory: string | null; body?: Record<string, unknown> }[] = []
  const opens: { id: string; directory: string }[] = []
  let pointers = 0
  const server = await serve(({ path, query, body }) => {
    reads.push({ path, directory: query.get("directory"), body })
    if (path.endsWith("/candidates")) return { data: [candidate] }
    if (path.endsWith("/rules")) return { data: { items: [rule], nextCursor: null } }
    if (path.endsWith("/roots")) return { data: { items: [{ ...root, nodes: [{ ...root.nodes[0], sessionID: pointer.sessionID, sessionAvailable: true }] }], nextCursor: null } }
    if (path === "/api/v1/event-work/session") {
      pointers++
      expect(query.get("directory")).toBe("/private/current-project")
      expect(body).toEqual({ sourceSessionID: "ordinary-source", rootID: root.rootID, nodeID: "read" })
      return { data: changed && pointers === 2 ? { ...pointer, placement: { ...pointer.placement, namespaceBindingHash: "d".repeat(64) } } : pointer }
    }
    if (path === "/session/child-session") {
      expect(query.get("directory")).toBe(child)
      expect(query.has("workspace")).toBe(false)
      return { data: { id: pointer.sessionID, directory: child, workspaceID: null, projectID: "child-project" } }
    }
    return { status: 404, data: {} }
  })
  try {
    wiring.sdk = { client: server.client, createClient: server.createClient, scope: "qualified-derived-child", directory: "/private/current-project" }
    render(() => <DialogEventWork sessionID="ordinary-source" onOpenSession={(id, directory) => opens.push({ id, directory })} />)
    fireEvent.click(await screen.findByRole("button", { name: dict["eventWork.open"] }))
    if (changed) {
      await screen.findByText(dict["eventWork.sessionUnavailable"])
      expect(opens).toEqual([])
    } else await waitFor(() => expect(opens).toEqual([{ id: pointer.sessionID, directory: child }]))
    expect(pointers).toBe(2)
    expect(reads.slice(-3).map((entry) => entry.path)).toEqual(["/api/v1/event-work/session", "/session/child-session", "/api/v1/event-work/session"])
    expect(reads.some((entry) => entry.path.endsWith("/control"))).toBe(false)
  } finally { await server.close() }
})
