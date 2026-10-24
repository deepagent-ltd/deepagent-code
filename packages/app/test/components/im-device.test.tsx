import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { createServer } from "node:http"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { IMDevicePanel } from "@/components/im/device-panel"
import { IMDeviceClient } from "@deepagent-code/core/im/device-client"
import { dict } from "@/i18n/en"
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
afterEach(cleanup)
const metadata = {
  profile: "dac-im-device-v1",
  storeAvailable: true,
  deviceJkt: "a".repeat(43),
  publicJwk: { kty: "EC", crv: "P-256", x: "b".repeat(43), y: "c".repeat(43) },
}
const original = "migration_original_123"
function fixture(
  options: {
    pending?: boolean
    storeUnavailable?: boolean
    unknown?: boolean
    migrationState?: "pending" | "unknown"
  } = {},
) {
  const available = vi.fn()
  const [owner, setOwner] = createStore({ current: true })
  const request = vi.fn(
    async (input: {
      method: string
      url: string
      body?: { migrationID: string; voucher: string; retryOriginal?: boolean }
    }) => {
      if (options.storeUnavailable)
        return { error: { data: { code: "im_device_store_unavailable" } }, response: { status: 503 } }
      if (input.url === "/api/v1/im/device/info") return { data: metadata }
      if (input.url === "/api/v1/im/device/migrations")
        return {
          data: {
            migration: options.pending
              ? {
                  migrationID: original,
                  state: options.migrationState ?? "pending",
                  chargedCredits: 0,
                  credentialStored: false,
                }
              : null,
          },
        }
      if (options.unknown && input.method === "POST") throw new Error("network acknowledgement lost")
      return {
        data: {
          migrationID: input.body?.migrationID ?? input.url.split("/").at(-1),
          state: "succeeded",
          chargedCredits: 0,
          credentialStored: true,
        },
      }
    },
  )
  const client = { client: { request } } as unknown as IMDeviceClient.Transport
  render(() => <IMDevicePanel client={client} current={() => owner.current} available={available} />)
  return { request, available, setOwner }
}
const writes = (request: ReturnType<typeof vi.fn>) =>
  request.mock.calls.map(([input]) => input).filter((input) => input.method === "POST")

it("keeps technical device identities collapsed without hiding pending recovery or submitting a migration", async () => {
  const test = fixture({ pending: true })
  await screen.findByText(original)
  const fingerprint = screen.getByText(metadata.deviceJkt).closest("details")!
  const migration = screen.getByText(original).closest("details")!
  expect(fingerprint.open).toBe(false)
  expect(migration.open).toBe(false)
  expect(screen.getByRole("button", { name: dict["im.device.recover"] }).closest("details")).toBeNull()
  fireEvent.click(fingerprint.querySelector("summary")!)
  expect(fingerprint.open).toBe(true)
  expect(screen.getByRole("button", { name: dict["im.device.copy"] })).toBeTruthy()
  expect(writes(test.request)).toHaveLength(0)
})

it("first binding is explicit, costs zero, and never submits on mount or field entry", async () => {
  const f = fixture()
  await screen.findByText(metadata.deviceJkt)
  await waitFor(() => expect(f.available).toHaveBeenLastCalledWith(true))
  const button = screen.getByRole("button", { name: dict["im.device.migrate"] })
  fireEvent.input(screen.getByLabelText(dict["im.device.voucher"]), { target: { value: "private-test-voucher" } })
  expect(button.hasAttribute("disabled")).toBe(true)
  expect(writes(f.request)).toHaveLength(0)
  fireEvent.click(screen.getByRole("checkbox"))
  fireEvent.click(button)
  await screen.findByText(dict["im.device.complete"])
  expect(writes(f.request)).toHaveLength(1)
  expect(writes(f.request)[0].body).toMatchObject({ voucher: "private-test-voucher" })
  expect(Object.keys(writes(f.request)[0].body)).toEqual(["migrationID", "voucher"])
})

it("cold unknown migration requires the original voucher and explicit confirmation before resending the same ID", async () => {
  const f = fixture({ pending: true, migrationState: "unknown" })
  await screen.findByText(original)
  const button = screen.getByRole<HTMLButtonElement>("button", { name: dict["im.device.retryOriginal"] })
  expect(button.disabled).toBe(true)
  expect(writes(f.request)).toHaveLength(0)
  fireEvent.input(screen.getByLabelText(dict["im.device.voucher"]), { target: { value: "private-original-voucher" } })
  expect(button.disabled).toBe(true)
  fireEvent.click(screen.getByRole("checkbox"))
  fireEvent.click(button)
  await screen.findByText(dict["im.device.complete"])
  expect(writes(f.request)).toHaveLength(1)
  expect(writes(f.request)[0].body).toEqual({
    migrationID: original,
    voucher: "private-original-voucher",
    retryOriginal: true,
  })
  expect(screen.getByLabelText<HTMLInputElement>(dict["im.device.voucher"]).value).toBe("")
})

it("pending migration hides new purchase inputs and recovers only the retained ID", async () => {
  const f = fixture({ pending: true })
  await screen.findByText(original)
  expect(screen.queryByLabelText(dict["im.device.voucher"])).toBeNull()
  expect(f.available).toHaveBeenLastCalledWith(false)
  await waitFor(() =>
    expect(screen.getByRole("button", { name: dict["im.device.recover"] }).hasAttribute("disabled")).toBe(false),
  )
  fireEvent.click(screen.getByRole("button", { name: dict["im.device.recover"] }))
  await screen.findByText(dict["im.device.complete"])
  expect(writes(f.request)).toHaveLength(0)
  expect(f.request.mock.calls.at(-1)![0]).toMatchObject({
    method: "GET",
    url: `/api/v1/im/device/migrations/${original}`,
  })
})

it("OS store failure disables IM binding and leaves a clear local coding explanation", async () => {
  const f = fixture({ storeUnavailable: true })
  await screen.findByText(dict["im.device.storeUnavailable"])
  expect(screen.getByRole("button", { name: dict["im.device.migrate"] }).hasAttribute("disabled")).toBe(true)
  expect(writes(f.request)).toHaveLength(0)
  expect(f.available).toHaveBeenLastCalledWith(false)
})

it("lost acknowledgement clears the voucher and retries only an observation of the original ID", async () => {
  const f = fixture({ unknown: true })
  await waitFor(() => expect(f.available).toHaveBeenLastCalledWith(true))
  fireEvent.input(screen.getByLabelText(dict["im.device.voucher"]), { target: { value: "private-test-voucher" } })
  fireEvent.click(screen.getByRole("checkbox"))
  fireEvent.click(screen.getByRole("button", { name: dict["im.device.migrate"] }))
  await screen.findByText(dict["im.device.pending"])
  const id = writes(f.request)[0].body.migrationID
  expect(screen.queryByLabelText(dict["im.device.voucher"])).toBeNull()
  expect(document.body.textContent).not.toContain("private-test-voucher")
  await waitFor(() =>
    expect(screen.getByRole("button", { name: dict["im.device.recover"] }).hasAttribute("disabled")).toBe(false),
  )
  fireEvent.click(screen.getByRole("button", { name: dict["im.device.recover"] }))
  await screen.findByText(dict["im.device.complete"])
  expect(writes(f.request)).toHaveLength(1)
  expect(f.request.mock.calls.at(-1)![0]).toMatchObject({ method: "GET", url: `/api/v1/im/device/migrations/${id}` })
})

it("a retired settings scope cannot bind the old device", async () => {
  const f = fixture()
  await waitFor(() => expect(f.available).toHaveBeenLastCalledWith(true))
  fireEvent.input(screen.getByLabelText(dict["im.device.voucher"]), { target: { value: "private-test-voucher" } })
  fireEvent.click(screen.getByRole("checkbox"))
  f.setOwner("current", false)
  fireEvent.click(screen.getByRole("button", { name: dict["im.device.migrate"] }))
  expect(writes(f.request)).toHaveLength(0)
})

for (const code of ["im_activation_unavailable", "im_device_unavailable"])
  it(`fresh device reads use the production paths and preserve read-only refusal: ${code}`, async () => {
    const calls: { method: string; path: string }[] = []
    const listener = createServer((request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*")
      response.setHeader("Access-Control-Allow-Headers", "Content-Type")
      if (request.method === "OPTIONS") {
        response.writeHead(204)
        response.end()
        return
      }
      const url = new URL(request.url ?? "/", "http://localhost")
      calls.push({ method: request.method ?? "GET", path: url.pathname })
      const info = url.pathname === "/api/v1/im/device/info"
      const pending = url.pathname === "/api/v1/im/device/migrations"
      response.writeHead(info ? 200 : pending ? 502 : 404, { "Content-Type": "application/json" })
      response.end(
        JSON.stringify(
          info ? metadata : pending ? { name: "IM_FACADE_UNAVAILABLE", data: { code } } : { error: "Not Found" },
        ),
      )
    })
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
    const address = listener.address()
    if (!address || typeof address === "string") throw new Error("No test listener")
    const available = vi.fn()
    try {
      const sdk = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}` })
      render(() => (
        <IMDevicePanel client={sdk as unknown as IMDeviceClient.Transport} current={() => true} available={available} />
      ))
      const message =
        dict[code === "im_activation_unavailable" ? "im.device.serviceUnavailable" : "im.device.observationUnavailable"]
      await screen.findByText(message)
      expect(screen.queryByText(dict["im.device.unavailable"])).toBeNull()
      expect(screen.queryByText(dict["im.device.pending"])).toBeNull()
      expect(screen.getByText(metadata.deviceJkt)).toBeTruthy()
      expect(screen.getByLabelText<HTMLInputElement>(dict["im.device.voucher"]).disabled).toBe(true)
      expect(screen.getByRole<HTMLButtonElement>("button", { name: dict["im.device.migrate"] }).disabled).toBe(true)
      expect(available).toHaveBeenLastCalledWith(false)
      fireEvent.click(screen.getByRole("button", { name: dict["im.device.refresh"] }))
      await waitFor(() => expect(calls).toHaveLength(4))
      expect(calls).toEqual([
        { method: "GET", path: "/api/v1/im/device/info" },
        { method: "GET", path: "/api/v1/im/device/migrations" },
        { method: "GET", path: "/api/v1/im/device/info" },
        { method: "GET", path: "/api/v1/im/device/migrations" },
      ])
    } finally {
      cleanup()
      await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())))
    }
  })
