import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createServer } from "node:http"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
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
