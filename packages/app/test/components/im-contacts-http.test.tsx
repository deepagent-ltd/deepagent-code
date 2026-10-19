import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { createServer, type RequestListener } from "node:http"
import { IMContactsPage } from "@/components/im/contacts-page"
import { createIMClient, type IMClient } from "@/utils/im-client"
import { dict } from "@/i18n/en"

const runtime = vi.hoisted(() => ({ client: undefined as IMClient | undefined }))
vi.mock("@/utils/im-client", async (original) => ({
  ...(await original<typeof import("@/utils/im-client")>()),
  useIMClient: () => runtime.client!,
}))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
afterEach(cleanup)

function contactServer(handler: RequestListener) {
  return createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", request.headers.origin ?? "http://localhost:3000")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-deepagent-code-directory")
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    handler(request, response)
  })
}

it("looks up an exact contact without creating a conversation, then opens a direct only on Message", async () => {
  const calls: { method: string; path: string; name: string | null }[] = []
  const server = contactServer((request, response) => {
    const url = new URL(request.url!, "http://localhost")
    calls.push({ method: request.method!, path: url.pathname, name: url.searchParams.get("name") })
    response.setHeader("Content-Type", "application/json")
    response.end(
      JSON.stringify(
        url.pathname.endsWith("/resolve")
          ? { uuid: "bob-id", name: "bob" }
          : { id: "direct-bob", name: "bob", type: "direct" },
      ),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing loopback port")
  runtime.client = createIMClient(() => ({ url: `http://127.0.0.1:${address.port}`, directory: "/contacts-owned" }))
  const opened: string[] = []
  try {
    render(() => (
      <IMContactsPage
        active
        available
        account="owned-alice"
        groups={[]}
        openGroup={() => {
          throw new Error("Unexpected recent contact")
        }}
        openDirect={async (name) => {
          const group = await runtime.client!.facadeOpenDirect(name)
          opened.push(group.id)
          return true
        }}
      />
    ))
    expect(calls).toHaveLength(0)
    fireEvent.input(screen.getByLabelText(dict["im.contacts.find"]), { target: { value: "BOB" } })
    fireEvent.click(screen.getByRole("button", { name: dict["im.contacts.find"] }))
    await screen.findByText("bob")
    expect(calls).toEqual([{ method: "GET", path: "/api/v1/im/facade/resolve", name: "bob" }])
    expect(opened).toEqual([])
    fireEvent.click(screen.getByRole("button", { name: dict["im.contacts.message"] }))
    await waitFor(() => expect(opened).toEqual(["direct-bob"]))
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"])
    expect(calls[1].path).toBe("/api/v1/im/facade/direct")
  } finally {
    cleanup()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it("retires an in-flight lookup when the active account changes and never shows its late contact", async () => {
  let release: (() => void) | undefined
  const received = Promise.withResolvers<void>()
  const server = contactServer((_request, response) => {
    release = () => {
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({ uuid: "old-peer", name: "old-contact" }))
    }
    received.resolve()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing loopback port")
  const [account, setAccount] = createSignal("alice")
  runtime.client = createIMClient(() => ({
    url: `http://127.0.0.1:${address.port}`,
    directory: "/contacts-owned",
    password: account(),
  }))
  try {
    render(() => (
      <IMContactsPage
        active
        available
        account={account()}
        groups={[]}
        openGroup={() => {}}
        openDirect={async () => {
          throw new Error("No direct expected")
        }}
      />
    ))
    fireEvent.input(screen.getByLabelText(dict["im.contacts.find"]), { target: { value: "bob" } })
    fireEvent.click(screen.getByRole("button", { name: dict["im.contacts.find"] }))
    await received.promise
    setAccount("charlie")
    release!()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: dict["im.contacts.find"] }).hasAttribute("disabled")).toBe(false),
    )
    expect(screen.queryByText("old-contact")).toBeNull()
    expect(screen.queryByRole("button", { name: dict["im.contacts.message"] })).toBeNull()
  } finally {
    cleanup()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it("shows a lookup failure without exposing an actionable contact, and permits an explicit retry", async () => {
  let calls = 0
  const server = contactServer((_request, response) => {
    calls++
    response.setHeader("Content-Type", "application/json")
    response.statusCode = calls === 1 ? 404 : 200
    response.end(
      JSON.stringify(
        calls === 1
          ? { data: { code: "im_not_found", message: "not found" } }
          : calls === 2
            ? { uuid: "bob-id", name: { invalid: true } }
            : { uuid: "bob-id", name: "bob" },
      ),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing loopback port")
  runtime.client = createIMClient(() => ({ url: `http://127.0.0.1:${address.port}`, directory: "/contacts-owned" }))
  try {
    render(() => (
      <IMContactsPage
        active
        available
        account="alice"
        groups={[]}
        openGroup={() => {}}
        openDirect={async () => false}
      />
    ))
    fireEvent.input(screen.getByLabelText(dict["im.contacts.find"]), { target: { value: "bob" } })
    fireEvent.click(screen.getByRole("button", { name: dict["im.contacts.find"] }))
    await screen.findByRole("alert")
    expect(screen.queryByRole("button", { name: dict["im.contacts.message"] })).toBeNull()
    expect(calls).toBe(1)
    fireEvent.click(screen.getByRole("button", { name: dict["im.contacts.find"] }))
    await screen.findByText(dict["im.facade.error.invalid_response"])
    expect(screen.queryByRole("button", { name: dict["im.contacts.message"] })).toBeNull()
    expect(calls).toBe(2)
    fireEvent.click(screen.getByRole("button", { name: dict["im.contacts.find"] }))
    await screen.findByRole("button", { name: dict["im.contacts.message"] })
    expect(screen.queryByRole("alert")).toBeNull()
    expect(calls).toBe(3)
  } finally {
    cleanup()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
