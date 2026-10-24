import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createServer } from "node:http"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { createStore } from "solid-js/store"
import type { SharedBrowserView } from "@/context/platform"
import type { BrowserGetResponse } from "@deepagent-code/sdk"
import { BrowserFileExchange } from "@/components/browser-file-exchange"
import { dict } from "@/i18n/en"

const wiring = vi.hoisted(() => ({ sdk: {} as object }))
vi.mock("@/context/sdk", () => ({ useSDK: () => wiring.sdk }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
afterEach(cleanup)

it("actual GUI/SDK retains approval identity across a lost HTTP response; reopen queries instead of approving or transferring", async () => {
  const calls: { path: string; method: string; body?: Record<string, unknown>; cursor: string | null }[] = []
  const grants = [{ grantID: "grant-one", direction: "upload", name: "report.txt", bytes: 3,
    expiresAt: Date.now() + 60_000, state: "approved" }]
  let approved = false
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,x-deepagent-code-directory")
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return }
    const url = new URL(request.url ?? "/", "http://localhost")
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : undefined
    calls.push({ path: url.pathname, method: request.method ?? "GET", body, cursor: url.searchParams.get("cursor") })
    response.setHeader("Content-Type", "application/json")
    const send = (value: unknown) => response.end(JSON.stringify(value))
    if (url.pathname.endsWith("/preview")) return send({ controlID: "file-control", previewID: "preview-one", controlRevision: 1,
      preview: { direction: "upload", name: "report.txt", relative: "report.txt", bytes: 3,
        sha256: "a".repeat(64), targetPath: "/upload", observedAt: 1 } })
    if (url.pathname.endsWith("/approve")) {
      approved = true
      response.writeHead(503)
      return send({ code: "BROWSER_FILE_UNKNOWN", message: "Response lost" })
    }
    if (url.pathname.includes("/requests/")) return send({ requestID: url.pathname.split("/").at(-1),
      state: approved ? "approved" : "missing", grant: approved ? grants[0] : null })
    return send({ grants: approved ? grants : [], files: [], nextCursor: approved && !url.searchParams.get("cursor") ? "grant-one" : null })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("HTTP peer unavailable")
  const client = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}` })
  wiring.sdk = { client, directory: "/project", scope: "files" }
  const view: BrowserGetResponse = { nativeVerification: "verified", stopConfirmed: false, availability: "available",
    control: { version: 1, controlID: "file-control", requestID: "control-create", requestDigest: "b".repeat(64),
      scope: { principal: "user", securityNamespaceID: "namespace", locationKey: "location", projectScopeKey: "project-scope",
        namespaceBindingHash: "c".repeat(64), sessionID: "session", projectID: "project", directory: "/project", workspaceID: null },
      hostID: "host", hostIncarnation: "incarnation", resourceID: "resource", credentialBinding: "d".repeat(64),
      origin: "http://127.0.0.1:3000", revision: 1, epoch: 1, policyRevision: 1, state: "active",
      expiresAt: Date.now() + 300_000, createdAt: 1, updatedAt: 1, cancel: null, stopConfirmedAt: null,
      profile: "managed-loopback-exchange-v1", postPaths: ["/upload"], filePolicy: { upload: true, download: true } } }
  try {
    render(() => <BrowserFileExchange view={view} active={() => true} />)
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].method).toBe("GET")
    fireEvent.input(screen.getByLabelText(dict["browser.files.relative"]), { target: { value: "report.txt" } })
    fireEvent.input(screen.getByLabelText(dict["browser.files.postPath"]), { target: { value: "/upload" } })
    fireEvent.click(screen.getByRole("button", { name: dict["browser.files.preview"] }))
    await screen.findByText("a".repeat(64))
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: dict["browser.files.approve"] }))
    await screen.findByRole("alert")
    const command = calls.find((call) => call.path.endsWith("/approve"))?.body
    expect(command).toMatchObject({ previewID: "preview-one", expectedControlRevision: 1 })
    expect(command?.requestID).toBeTypeOf("string")
    cleanup()
    render(() => <BrowserFileExchange view={view} active={() => true} />)
    await screen.findByText(/report\.txt · Approved/)
    expect(calls.filter((call) => call.path.endsWith("/approve"))).toHaveLength(1)
    expect(calls.find((call) => call.path.includes("/requests/"))?.path).toContain(String(command?.requestID))
    await waitFor(() => expect(screen.getByRole("button", { name: dict["browser.files.next"] }).hasAttribute("disabled")).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: dict["browser.files.next"] }))
    await waitFor(() => expect(calls.some((call) => call.cursor === "grant-one")).toBe(true))
    await waitFor(() => expect(screen.getByRole("button", { name: dict["browser.files.first"] }).hasAttribute("disabled")).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: dict["browser.files.first"] }))
    await waitFor(() => expect(calls.at(-1)?.cursor).toBe(null))
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2)
    expect(calls.every((call) => !/file\.upload|file\.download|\/actions/.test(call.path))).toBe(true)
  } finally {
    cleanup()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

it("shared GUI/SDK discards stale lease previews and reads or retries the frozen request after manual takeover", async () => {
  const calls: { path: string; body?: Record<string, unknown> }[] = []
  const first = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let previews = 0
  let approvals = 0
  const grant = {
    grantID: "shared-grant",
    direction: "upload",
    name: "report.txt",
    bytes: 3,
    expiresAt: Date.now() + 60_000,
    state: "approved",
  }
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,x-deepagent-code-directory")
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    const url = new URL(request.url ?? "/", "http://localhost")
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : undefined
    calls.push({ path: url.pathname, body })
    response.setHeader("Content-Type", "application/json")
    const send = (value: unknown) => response.end(JSON.stringify(value))
    if (url.pathname.endsWith("/preview")) {
      previews++
      const attempt = previews
      if (attempt === 1) {
        first.resolve()
        await release.promise
      }
      return send({
        resourceID: "shared-resource",
        previewID: `shared-preview-${attempt}`,
        resourceRevision: attempt === 1 ? 1 : 3,
        leaseID: attempt === 1 ? "lease-a" : "lease-b",
        leaseEpoch: attempt,
        manualEpoch: attempt === 1 ? 0 : 1,
        preview: {
          direction: "upload",
          name: "report.txt",
          relative: "report.txt",
          bytes: 3,
          sha256: (attempt === 1 ? "a" : "b").repeat(64),
          targetURL: "https://example.com/upload",
          observedAt: 1,
        },
      })
    }
    if (url.pathname.endsWith("/approve")) {
      approvals++
      if (approvals === 1) {
        response.writeHead(503)
        return send({ code: "BROWSER_FILE_UNKNOWN" })
      }
      return send({ resourceID: "shared-resource", requestID: body?.requestID, grant })
    }
    if (url.pathname.includes("/requests/"))
      return send({
        requestID: url.pathname.split("/").at(-1),
        state: approvals > 1 ? "approved" : "missing",
        grant: approvals > 1 ? grant : null,
      })
    return send({ grants: approvals > 1 ? [grant] : [], files: [], nextCursor: null })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("HTTP peer unavailable")
  wiring.sdk = {
    client: createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}` }),
    directory: "/project",
    scope: "shared-files",
  }
  const [state, setState] = createStore<{ view: SharedBrowserView; active: boolean }>({
    active: true,
    view: {
      resource: {
        version: 2,
        profile: "managed-shared-browser-v1",
        inputAssurance: "shared-document-v1",
        resourceID: "shared-resource",
        requestID: "create",
        requestDigest: "c".repeat(64),
        rootSessionID: "session",
        scope: {
          principal: "user",
          securityNamespaceID: "namespace",
          locationKey: "location",
          projectScopeKey: "project-scope",
          namespaceBindingHash: "d".repeat(64),
          sessionID: "session",
          projectID: "project",
          directory: "/project",
          workspaceID: null,
        },
        mainIncarnation: "main",
        policy: {
          origin: "https://example.com",
          approvedOrigins: ["https://example.com"],
          manualApprovedOrigins: ["https://example.com"],
          resolverPolicy: "system",
          postGrants: [],
          filePolicy: { upload: true, download: true },
        },
        policyHash: "e".repeat(64),
        state: "agent_owned",
        revision: 1,
        manualEpoch: 0,
        barrierOrder: 0,
        coreCutoff: -1,
        liveLeaseID: "lease-a",
        agentAccessFenced: false,
        resourceAlive: true,
        manualEnabled: false,
        createdAt: 1,
        updatedAt: 1,
        expiresAt: Date.now() + 300_000,
      },
    },
  })
  const mount = () => render(() => <BrowserFileExchange shared={state.view} active={() => state.active} />)
  try {
    mount()
    await waitFor(() => expect(calls).toHaveLength(1))
    fireEvent.input(screen.getByLabelText(dict["browser.files.relative"]), { target: { value: "report.txt" } })
    fireEvent.input(screen.getByLabelText(dict["browser.files.uploadURL"]), {
      target: { value: "https://example.com/upload" },
    })
    fireEvent.click(screen.getByRole("button", { name: dict["browser.files.preview"] }))
    await first.promise
    setState("view", "resource", {
      revision: 2,
      manualEpoch: 1,
      state: "human_owned",
      liveLeaseID: null,
      agentAccessFenced: true,
      manualEnabled: true,
    })
    setState("active", false)
    release.resolve()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: dict["browser.files.preview"] }).hasAttribute("disabled")).toBe(true),
    )
    expect(screen.queryByText("a".repeat(64))).toBeNull()
    expect(calls.filter((call) => call.path.endsWith("/approve"))).toHaveLength(0)
    setState("view", "resource", {
      revision: 3,
      state: "agent_owned",
      liveLeaseID: "lease-b",
      agentAccessFenced: false,
      manualEnabled: false,
    })
    setState("active", true)
    fireEvent.click(screen.getByRole("button", { name: dict["browser.files.preview"] }))
    await screen.findByText("b".repeat(64))
    fireEvent.click(screen.getByRole("button", { name: dict["browser.files.approve"] }))
    await screen.findByRole("alert")
    const command = calls.find((call) => call.path.endsWith("/approve"))?.body
    expect(command).toMatchObject({
      previewID: "shared-preview-2",
      expectedResourceRevision: 3,
      expectedLeaseID: "lease-b",
      expectedLeaseEpoch: 2,
      expectedManualEpoch: 1,
    })
    cleanup()
    setState("view", "resource", {
      revision: 4,
      manualEpoch: 2,
      state: "human_owned",
      liveLeaseID: null,
      agentAccessFenced: true,
      manualEnabled: true,
    })
    setState("active", false)
    mount()
    await screen.findByText(dict["browser.files.unknown"])
    const retry = screen.getByRole("button", { name: dict["browser.files.retryExact"] })
    await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(false))
    fireEvent.click(retry)
    await screen.findByText(/report\.txt · Approved/)
    expect(calls.filter((call) => call.path.endsWith("/approve")).map((call) => call.body)).toEqual([command, command])
    expect(calls.every((call) => call.path.startsWith("/api/v1/browser/shared/resources/shared-resource/files"))).toBe(
      true,
    )
    expect(calls.every((call) => !/\/actions|\/execute/.test(call.path))).toBe(true)
    expect(previews).toBe(2)
  } finally {
    release.resolve()
    cleanup()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

it("shared confirmed cancellation preserves the original terminal intent and only an explicit new approval gets a new ID", async () => {
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = []
  const peer = { previews: 0, approvals: 0, mode: "missing" as "missing" | "error" | "wrong" | "cancelled" }
  const resourceID = "shared-cancel-resource"
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,x-deepagent-code-directory")
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    const url = new URL(request.url ?? "/", "http://localhost")
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : undefined
    calls.push({ path: url.pathname, method: request.method ?? "GET", body })
    response.setHeader("Content-Type", "application/json")
    const send = (value: unknown) => response.end(JSON.stringify(value))
    if (url.pathname.endsWith("/preview")) {
      peer.previews++
      return send({
        resourceID,
        previewID: `cancel-preview-${peer.previews}`,
        resourceRevision: peer.previews === 1 ? 1 : 3,
        leaseID: peer.previews === 1 ? "lease-a" : "lease-b",
        leaseEpoch: peer.previews,
        manualEpoch: peer.previews - 1,
        preview: {
          direction: "upload",
          name: "report.txt",
          relative: "report.txt",
          bytes: 3,
          sha256: "a".repeat(64),
          targetURL: "https://example.com/upload",
          observedAt: 1,
        },
      })
    }
    if (url.pathname.endsWith("/approve")) {
      peer.approvals++
      if (peer.approvals === 1) {
        response.writeHead(503)
        return send({ code: "BROWSER_FILE_UNKNOWN", message: "Original cancellation response lost" })
      }
      return send({ resourceID, requestID: body?.requestID, state: "cancelled", grant: null, replayed: false })
    }
    if (url.pathname.includes("/requests/")) {
      if (peer.mode === "error") {
        response.writeHead(403)
        return send({ code: "BROWSER_FILE_UNAVAILABLE", message: "Not a cancellation decision" })
      }
      return send({
        requestID: peer.mode === "wrong" ? "foreign-request" : url.pathname.split("/").at(-1),
        state: peer.mode === "missing" ? "missing" : "cancelled",
        grant: null,
      })
    }
    return send({ grants: [], files: [], nextCursor: null })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing owned cancellation listener")
  const client = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}` })
  wiring.sdk = { client, directory: "/project", scope: "shared-cancel-files" }
  const [state, setState] = createStore<{ view: SharedBrowserView; active: boolean }>({
    active: true,
    view: {
      resource: {
        version: 2,
        profile: "managed-shared-browser-v1",
        inputAssurance: "shared-document-v1",
        resourceID,
        requestID: "create",
        requestDigest: "c".repeat(64),
        rootSessionID: "session",
        scope: {
          principal: "user",
          securityNamespaceID: "namespace",
          locationKey: "location",
          projectScopeKey: "project-scope",
          namespaceBindingHash: "d".repeat(64),
          sessionID: "session",
          projectID: "project",
          directory: "/project",
          workspaceID: null,
        },
        mainIncarnation: "main",
        policy: {
          origin: "https://example.com",
          approvedOrigins: ["https://example.com"],
          manualApprovedOrigins: ["https://example.com"],
          resolverPolicy: "system",
          postGrants: [],
          filePolicy: { upload: true, download: true },
        },
        policyHash: "e".repeat(64),
        state: "agent_owned",
        revision: 1,
        manualEpoch: 0,
        barrierOrder: 0,
        coreCutoff: -1,
        liveLeaseID: "lease-a",
        agentAccessFenced: false,
        resourceAlive: true,
        manualEnabled: false,
        createdAt: 1,
        updatedAt: 1,
        expiresAt: Date.now() + 300_000,
      },
    },
  })
  const mount = () => render(() => <BrowserFileExchange shared={state.view} active={() => state.active} />)
  const retry = () => screen.getByRole("button", { name: dict["browser.files.retryExact"] }) as HTMLButtonElement
  const another = () => screen.getByRole("button", { name: dict["browser.files.new"] }) as HTMLButtonElement
  const refresh = async () => {
    const count = calls.filter((call) => call.path.includes("/requests/")).length
    fireEvent.click(screen.getByRole("button", { name: dict["browser.files.refresh"] }))
    await waitFor(() => expect(calls.filter((call) => call.path.includes("/requests/"))).toHaveLength(count + 1))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: dict["browser.files.refresh"] }).hasAttribute("disabled")).toBe(false),
    )
  }
  try {
    mount()
    await waitFor(() => expect(calls).toHaveLength(1))
    fireEvent.input(screen.getByLabelText(dict["browser.files.relative"]), { target: { value: "report.txt" } })
    fireEvent.input(screen.getByLabelText(dict["browser.files.uploadURL"]), {
      target: { value: "https://example.com/upload" },
    })
    fireEvent.click(screen.getByRole("button", { name: dict["browser.files.preview"] }))
    await screen.findByText("a".repeat(64))
    fireEvent.click(screen.getByRole("button", { name: dict["browser.files.approve"] }))
    await screen.findByRole("alert")
    const original = calls.find((call) => call.path.endsWith("/approve"))?.body
    expect(original?.requestID).toBeTypeOf("string")
    expect(another().disabled).toBe(true)
    await refresh() // A missing request never proves that the native user cancelled.
    expect(screen.getByText(dict["browser.files.unknown"])).toBeDefined()
    expect(another().disabled).toBe(true)
    peer.mode = "error"
    await refresh()
    expect(screen.getByText(dict["browser.files.unknown"])).toBeDefined()
    expect(another().disabled).toBe(true)
    peer.mode = "wrong"
    await refresh()
    expect(screen.getByText(dict["browser.files.unknown"])).toBeDefined()
    expect(another().disabled).toBe(true)
    peer.mode = "cancelled"
    await refresh()
    expect(screen.getByText(dict["browser.files.cancelled"])).toBeDefined()
    expect(screen.queryByText(dict["browser.files.unknown"])).toBeNull()
    expect(retry().disabled).toBe(true)
    expect(another().disabled).toBe(false)
    setState("view", "resource", {
      revision: 2,
      manualEpoch: 1,
      state: "human_owned",
      liveLeaseID: null,
      agentAccessFenced: true,
      manualEnabled: true,
    })
    setState("active", false)
    expect(retry().disabled).toBe(true)
    expect(screen.getByText(dict["browser.files.cancelled"])).toBeDefined()
    const beforeReopen = calls.filter((call) => call.path.includes("/requests/")).length
    cleanup()
    peer.mode = "missing" // A known exact negative terminal is not downgraded after a view reopen.
    mount()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: dict["browser.files.refresh"] }).hasAttribute("disabled")).toBe(false),
    )
    expect(calls.filter((call) => call.path.includes("/requests/"))).toHaveLength(beforeReopen)
    expect(screen.getByText(dict["browser.files.cancelled"])).toBeDefined()
    expect(retry().disabled).toBe(true)
    expect(peer.approvals).toBe(1)
    fireEvent.click(another())
    expect(screen.queryByText(dict["browser.files.cancelled"])).toBeNull()
    expect(peer.approvals).toBe(1)
    setState("view", "resource", {
      revision: 3,
      state: "agent_owned",
      liveLeaseID: "lease-b",
      agentAccessFenced: false,
      manualEnabled: false,
    })
    setState("active", true)
    fireEvent.click(screen.getByRole("button", { name: dict["browser.files.preview"] }))
    await screen.findByText("a".repeat(64))
    fireEvent.click(screen.getByRole("button", { name: dict["browser.files.approve"] }))
    await screen.findByText(dict["browser.files.cancelled"])
    expect(retry().disabled).toBe(true)
    expect(another().disabled).toBe(false)
    const approvals = calls.filter((call) => call.path.endsWith("/approve"))
    expect(approvals).toHaveLength(2)
    expect(approvals[1].body?.requestID).not.toBe(original?.requestID)
    expect(approvals[1].body?.previewID).toBe("cancel-preview-2")
    expect(calls.filter((call) => call.path.includes("/requests/"))).toHaveLength(beforeReopen)
    expect(calls.every((call) => !/\/actions|\/execute|\/upload|\/download/.test(call.path))).toBe(true)
  } finally {
    cleanup()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
