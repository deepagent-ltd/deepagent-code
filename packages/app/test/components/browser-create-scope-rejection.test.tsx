import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import { createServer } from "node:http"
import { webcrypto } from "node:crypto"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { DialogBrowserControl } from "@/components/dialog-browser-control"
import { dict } from "@/i18n/en"

const wiring = vi.hoisted(() => ({ sdk: {} as object }))
vi.mock("@/context/sdk", () => ({ useSDK: () => wiring.sdk }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({ close: () => {} }) }))
vi.mock("@deepagent-code/ui/dialog", () => ({ Dialog: (props: { title: string; children: JSX.Element }) =>
  <section aria-label={props.title}>{props.children}</section> }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each([false, true])("known pre-create scope rejection preserves any previous unknown=%s custody", async (unknown) => {
  vi.stubGlobal("crypto", webcrypto)
  const calls: Record<string, unknown>[] = []
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,x-deepagent-code-directory")
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return }
    const chunks: Uint8Array[] = []
    for await (const chunk of request) chunks.push(new Uint8Array(chunk))
    calls.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
    response.setHeader("Content-Type", "application/json")
    response.writeHead(unknown && calls.length === 1 ? 503 : 403)
    response.end(JSON.stringify(unknown && calls.length === 1 ? { code: "BROWSER_UNKNOWN" }
      : { code: "BROWSER_SCOPE_DENIED", message: "BROWSER_CREATE_SCOPE_DENIED:location_current" }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Original HTTP peer was not bound")
  const client = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}` })
  wiring.sdk = { client, directory: "/scope-project", scope: "scope" }
  const uses = vi.fn()
  try {
    render(() => <DialogBrowserControl sessionID="scope-session" onUse={uses} />)
    fireEvent.click(screen.getByRole("button", { name: dict["browser.control.connect"] }))
    if (unknown) {
      await screen.findByText(dict["browser.control.unknown"])
      expect(calls).toHaveLength(1)
      cleanup()
      render(() => <DialogBrowserControl sessionID="scope-session" onUse={uses} />)
      fireEvent.click(screen.getByRole("button", { name: dict["browser.control.retry"] }))
    }
    const failure = await screen.findByText((content) => content.startsWith(dict["browser.control.scopeDenied"]))
    expect(failure.textContent?.includes(dict["browser.control.unknown"])).toBe(unknown)
    expect(screen.getByRole("button", { name: dict["browser.control.use"] }).hasAttribute("disabled")).toBe(true)
    expect(uses).not.toHaveBeenCalled()
    expect(screen.getByLabelText(dict["browser.control.origin"]).hasAttribute("disabled")).toBe(unknown)
    if (unknown) {
      expect(calls).toHaveLength(2)
      expect(calls[1]).toEqual(calls[0])
      expect(screen.getByRole("button", { name: dict["browser.control.retry"] })).toBeDefined()
      return
    }
    expect(calls).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: dict["browser.control.connect"] }))
    await screen.findByText(dict["browser.control.scopeDenied"])
    expect(calls).toHaveLength(2)
    expect(calls[1].requestID).not.toBe(calls[0].requestID)
  } finally {
    cleanup()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
