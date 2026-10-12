import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { webcrypto } from "node:crypto"
import { DialogProvider, useDialog } from "@deepagent-code/ui/context/dialog"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { DialogBrowserControl } from "@/components/dialog-browser-control"
import { dict } from "@/i18n/en"

const wiring: { sdk?: { client: ReturnType<typeof createDeepAgentCodeClient>; directory: string; scope: string } } =
  vi.hoisted(() => ({}))
vi.mock("@/context/sdk", () => ({ useSDK: () => wiring.sdk }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function enter(name: string) {
  screen.getByRole("button", { name }).focus()
  await userEvent.setup().keyboard("{Enter}")
}
async function select(label: string, option: string) {
  const trigger = within(screen.getByRole("group", { name: label })).getByRole("button")
  trigger.focus()
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  const target = await screen.findByRole("option", { name: option })
  target.focus()
  fireEvent.keyDown(target, { key: "Enter" })
  await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"))
  const content = target.closest('[data-slot="select-v2-content"]')
  if (content) fireEvent.animationEnd(content, { animationName: getComputedStyle(content).animationName })
  await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0))
}

it.each([
  { mode: "publicReadonly", profile: "managed-public-readonly-v1" },
  { mode: "publicInteraction", profile: "managed-public-interaction-v1" },
  { mode: "apiPost", profile: "managed-public-api-v1" },
] as const)("$profile sends explicit AliDNS once and accurately displays an unavailable cold view", async (profile) => {
  vi.stubGlobal("crypto", webcrypto)
  const calls: { method: string; body?: Record<string, unknown> }[] = []
  const state = { body: undefined as Record<string, unknown> | undefined }
  // Real generated SDK serialization; the transport returns bytes in memory, with no socket or DNS.
  wiring.sdk = { directory: "/alidns-project", scope: "alidns-scope", client: createDeepAgentCodeClient({
    baseUrl: "https://fixture.invalid", fetch: Object.assign(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input)
      const body = request.method === "POST" ? await request.json() as Record<string, unknown> : undefined
      calls.push({ method: request.method, body })
      if (body) state.body = body
      return Response.json({ control: { ...state.body, controlID: "alidns-control", revision: 1, state: "active",
        scope: { sessionID: "alidns-session", directory: "/alidns-project" } },
        availability: "unavailable", nativeVerification: "unverified", stopConfirmed: false })
    }, { preconnect: () => { throw new Error("In-memory transport cannot preconnect") } }),
  }) }
  const uses: string[] = []
  function Caller() {
    const dialog = useDialog()
    return <button onClick={() => void dialog.show(() => <DialogBrowserControl sessionID="alidns-session"
      onUse={(id) => uses.push(id)} />)}>Open AliDNS browser</button>
  }
  render(() => <DialogProvider><Caller /></DialogProvider>)
  await enter("Open AliDNS browser")
  await select(dict["browser.control.mode"], dict[`browser.control.${profile.mode}`])
  expect(within(screen.getByRole("group", { name: dict["browser.control.resolver"] })).getByRole("button").textContent)
    .toContain(dict["browser.control.resolverSystem"])
  await select(dict["browser.control.resolver"], dict["browser.control.resolverAliDNS"])
  expect(calls).toHaveLength(0)
  if (profile.mode === "apiPost") fireEvent.input(screen.getByLabelText(dict["browser.control.apiTargets"]),
    { target: { value: JSON.stringify([{ url: "https://example.com/api", contentTypes: ["application/json"], maxBodyBytes: 1024 }]) } })
  await enter(dict["browser.control.connect"])
  await screen.findByText(dict["browser.control.unavailable"])
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ method: "POST", body: { profile: profile.profile, resolverPolicy: "alidns_doh_v1" } })
  expect(calls[0].body).not.toHaveProperty("resolverEndpoint")
  expect(calls[0].body).not.toHaveProperty("fallbackResolver")
  expect(screen.getByText(dict["browser.control.resolverAliDNS"])).toBeDefined()
  expect(screen.getByRole("button", { name: dict["browser.control.use"] }).hasAttribute("disabled")).toBe(true)
  expect(uses).toEqual([])
  await enter(dict["browser.control.refresh"])
  await waitFor(() => expect(calls).toHaveLength(2))
  expect(calls[1].method).toBe("GET")
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1)
  expect(screen.getByText(dict["browser.control.resolverAliDNS"])).toBeDefined()
  const zh = await import("@/i18n/zh")
  const zht = await import("@/i18n/zht")
  expect(zh.dict["browser.control.resolverAliDNS"]).toBe("阿里 DNS over HTTPS")
  expect(zht.dict["browser.control.resolverAliDNS"]).toBe("阿里 DNS over HTTPS")
})

it.each([5, 15, 30] as const)("browser approval %i minutes is explicit and unknown exact retry keeps the original expiry", async (minutes) => {
  vi.stubGlobal("crypto", webcrypto)
  const calls: Record<string, unknown>[] = []
  wiring.sdk = { directory: "/duration-project", scope: `duration-${minutes}`, client: createDeepAgentCodeClient({
    baseUrl: "https://fixture.invalid", fetch: Object.assign(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input)
      calls.push(await request.json() as Record<string, unknown>)
      return Response.json({ code: "BROWSER_UNKNOWN", message: "Unknown original dispatch" }, { status: 503 })
    }, { preconnect: () => { throw new Error("In-memory transport cannot preconnect") } }),
  }) }
  function Caller() {
    const dialog = useDialog()
    return <button onClick={() => void dialog.show(() => <DialogBrowserControl sessionID={`duration-session-${minutes}`}
      onUse={() => { throw new Error("Unknown must not hand off") }} />)}>Open duration browser</button>
  }
  render(() => <DialogProvider><Caller /></DialogProvider>)
  await enter("Open duration browser")
  expect(within(screen.getByRole("group", { name: dict["browser.control.duration"] })).getByRole("button").textContent)
    .toContain(dict["browser.control.duration5"])
  if (minutes !== 5) await select(dict["browser.control.duration"], dict[`browser.control.duration${minutes}`])
  const before = Date.now()
  await enter(dict["browser.control.connect"])
  await screen.findByText(dict["browser.control.unknown"])
  expect(calls).toHaveLength(1)
  expect(calls[0].expiresAt).toBeGreaterThanOrEqual(before + minutes * 60_000)
  expect(calls[0].expiresAt).toBeLessThanOrEqual(Date.now() + minutes * 60_000)
  expect(within(screen.getByRole("group", { name: dict["browser.control.duration"] })).getByRole("button").getAttribute("aria-disabled")).toBe("true")
  await enter(dict["browser.control.retry"])
  await waitFor(() => expect(calls).toHaveLength(2))
  expect(calls[1]).toEqual(calls[0])
})
