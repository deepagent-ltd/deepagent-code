import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { IMActivationPanel } from "@/components/im/activation-panel"
import {
  createIMActivation,
  type IMActivationClient,
  type IMActivationInput,
} from "@/components/im/activation-controller"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { dict } from "@/i18n/en"

vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict, values?: { credits: number }) =>
      dict[key]?.replace("{{credits}}", `${values?.credits}`),
  }),
}))
afterEach(cleanup)

function client() {
  const scope = {}
  return {
    scope: () => scope,
    activationPending: vi.fn<IMActivationClient["activationPending"]>(async () => null),
    activationQuote: vi.fn<IMActivationClient["activationQuote"]>(async () => ({
      quoteID: "quote",
      priceCredits: 1,
      quotaCost: 500000,
      expiresAt: Date.now() + 60_000,
      entitlementExpiresAt: null,
    })),
    activate: vi.fn<IMActivationClient["activate"]>(async (input) => ({
      ...input,
      state: "succeeded",
      chargedCredits: input.method === "api_key" ? 1 : 0,
      credentialStored: true,
    })),
    activationStatus: vi.fn<IMActivationClient["activationStatus"]>(),
  } satisfies IMActivationClient
}

async function fields() {
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: dict["im.activation.refresh"] }).disabled).toBe(false),
  )
  fireEvent.input(screen.getByRole("textbox", { name: dict["im.activation.name"] }), { target: { value: "Alice" } })
  fireEvent.input(screen.getByLabelText(dict["im.activation.code"]), { target: { value: "owned-code" } })
}

it("keeps a pending transaction ID collapsed while its recovery and fee state stay visible", async () => {
  const api = client()
  api.activationPending.mockResolvedValue({
    transactionID: "original-disclosure-only",
    name: "Alice",
    method: "api_key",
    quoteID: "quote",
    state: "pending",
    chargedCredits: 1,
    credentialStored: false,
  })
  render(() => <IMActivationPanel client={api} current={() => true} activated={vi.fn()} />)
  const transaction = await screen.findByText("original-disclosure-only")
  expect(transaction.closest("details")?.open).toBe(false)
  expect(screen.getByRole("button", { name: dict["im.activation.check"] }).closest("details")).toBeNull()
  expect(screen.getByText("Actual charge for this transaction: 1 credit").closest("details")).toBeNull()
  fireEvent.click(transaction.closest("details")!.querySelector("summary")!)
  expect(transaction.closest("details")?.open).toBe(true)
  expect(api.activate).not.toHaveBeenCalled()
})

it("code redemption is one explicit action, does not require a paid key and reports zero charged credits", async () => {
  const api = client()
  const activated = vi.fn()
  render(() => <IMActivationPanel client={api} current={() => true} activated={activated} />)
  await fields()
  expect(screen.getByRole("textbox", { name: "IM username" })).toBeTruthy()
  expect(screen.getByText(dict["im.facade.name.rule"]).textContent).toContain("exact username")
  expect(api.activate).not.toHaveBeenCalled()
  expect(screen.queryByRole("checkbox")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: dict["im.activation.redeem"] }))
  await waitFor(() => expect(activated).toHaveBeenCalledTimes(1))
  expect(api.activate).toHaveBeenCalledTimes(1)
  expect(api.activate.mock.calls[0]?.[0]).toMatchObject({
    name: "alice",
    method: "activation_code",
    credential: "owned-code",
    quoteID: "quote",
  })
  expect(screen.getByText("Actual charge for this transaction: 0 credit")).toBeTruthy()
  expect(screen.queryByLabelText(dict["im.activation.code"])).toBeNull()
})

it("a paid key cannot be charged until the user explicitly agrees to the displayed one credit price", async () => {
  const api = client()
  render(() => <IMActivationPanel client={api} current={() => true} activated={vi.fn()} />)
  await fields()
  const select = screen.getByRole("button", { name: dict["im.activation.method.code"] })
  select.focus()
  fireEvent.keyDown(select, { key: "ArrowDown" })
  fireEvent.click(await screen.findByRole("option", { name: dict["im.activation.method.key"] }))
  const key = screen.getByLabelText<HTMLInputElement>(dict["im.activation.key"])
  expect(key.value).toBe("")
  expect(key.type).toBe("password")
  fireEvent.input(key, { target: { value: "paid-key-only-entered-here" } })
  const charge = screen.getByRole<HTMLButtonElement>("button", { name: dict["im.activation.charge"] })
  expect(charge.disabled).toBe(true)
  fireEvent.click(charge)
  expect(api.activate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("checkbox"))
  fireEvent.click(charge)
  await waitFor(() => expect(api.activate).toHaveBeenCalledTimes(1))
  expect(api.activate.mock.calls[0]?.[0].method).toBe("api_key")
  expect(screen.getByText("Actual charge for this transaction: 1 credit")).toBeTruthy()
})

it("cold pending recovery only queries the original transaction and never restores or submits a payment secret", async () => {
  const api = client()
  const pending = {
    transactionID: "original",
    name: "Alice",
    method: "api_key" as const,
    quoteID: "quote",
    state: "unknown" as const,
    chargedCredits: null,
    credentialStored: false,
  }
  api.activationPending.mockResolvedValue(pending)
  api.activationStatus.mockResolvedValue({ ...pending, state: "succeeded", chargedCredits: 1, credentialStored: true })
  render(() => <IMActivationPanel client={api} current={() => true} activated={vi.fn()} allowPaidActivation={false} />)
  await screen.findByText("original", { exact: true })
  expect(screen.queryByRole("button", { name: dict["im.activation.redeem"] })).toBeNull()
  expect(screen.queryByText(/Actual charge for this transaction:/)).toBeNull()
  expect(screen.getByLabelText<HTMLInputElement>(dict["im.activation.key"]).value).toBe("")
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: dict["im.activation.check"] }).disabled).toBe(false),
  )
  fireEvent.click(screen.getByRole("button", { name: dict["im.activation.check"] }))
  await screen.findByText(dict["im.activation.state.activated"])
  expect(api.activationStatus.mock.calls[0]?.[0]).toBe("original")
  expect(api.activate).not.toHaveBeenCalled()
})

it("shows a disabled code form before explicit device readiness and offers no new legacy paid purchase", async () => {
  const api = client()
  const [state, setState] = createStore({ ready: false })
  render(() => (
    <IMActivationPanel
      client={api}
      current={() => true}
      activated={vi.fn()}
      ready={() => state.ready}
      allowPaidActivation={false}
    />
  ))
  expect(screen.getByLabelText(dict["im.activation.code"])).toHaveProperty("disabled", true)
  expect(api.activationPending).not.toHaveBeenCalled()
  expect(api.activationQuote).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: dict["im.activation.redeem"] }))
  expect(api.activate).not.toHaveBeenCalled()
  setState("ready", true)
  await waitFor(() => expect(api.activationQuote).toHaveBeenCalledTimes(1))
  expect(screen.getByLabelText(dict["im.activation.code"])).toHaveProperty("disabled", false)
  expect(screen.queryByRole("button", { name: dict["im.activation.method.code"] })).toBeNull()
  expect(screen.queryByRole("option", { name: dict["im.activation.method.key"] })).toBeNull()
  expect(screen.queryByRole("button", { name: dict["im.activation.charge"] })).toBeNull()
  const details = screen.getByText(dict["settings.im.entitlement.legacyPurchaseUnavailable"]).closest("details")!
  expect(details.open).toBe(false)
  fireEvent.click(details.querySelector("summary")!)
  expect(details.open).toBe(true)
  expect(screen.getByText(dict["im.activation.rootAccounts"]).closest("details")).toBe(details)
  expect(screen.getByText(dict["im.activation.separateCredentials"]).closest("details")).toBe(details)
  expect(api.activate).not.toHaveBeenCalled()
})

it("keeps legacy paid recovery available on an already active device without exposing a new purchase", async () => {
  const api = client()
  const pending = {
    transactionID: "original-active-device-pending",
    name: "Alice",
    method: "api_key" as const,
    quoteID: "quote",
    state: "unknown" as const,
    chargedCredits: null,
    credentialStored: false,
  }
  api.activationPending.mockResolvedValue(pending)
  api.activationStatus.mockResolvedValue({ ...pending, state: "succeeded", chargedCredits: 1, credentialStored: true })
  render(() => (
    <IMActivationPanel
      client={api}
      current={() => true}
      activated={vi.fn()}
      allowPaidActivation={false}
      hasAccess={() => true}
    />
  ))
  await screen.findByText(pending.transactionID)
  expect(screen.queryByRole("button", { name: dict["im.activation.charge"] })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: dict["im.activation.check"] }))
  await waitFor(() => expect(api.activationStatus).toHaveBeenCalledTimes(1))
  expect(api.activationStatus.mock.calls[0]?.[0]).toBe(pending.transactionID)
  expect(api.activate).not.toHaveBeenCalled()
  await waitFor(() => expect(screen.queryByText(pending.transactionID)).toBeNull())
  expect(screen.getByText("Actual charge for this transaction: 1 credit")).toBeTruthy()
})

it("an ambiguous POST retains one ID, clears the secret, and a mismatched status cannot retire it", async () => {
  const api = client()
  api.activate.mockRejectedValue(new Error("transport closed after dispatch"))
  render(() => <IMActivationPanel client={api} current={() => true} activated={vi.fn()} />)
  await fields()
  fireEvent.click(screen.getByRole("button", { name: dict["im.activation.redeem"] }))
  await screen.findByText(dict["im.activation.error.unavailable"])
  const original = api.activate.mock.calls[0]?.[0]
  expect(original).toBeDefined()
  expect(screen.getByLabelText<HTMLInputElement>(dict["im.activation.code"]).value).toBe("")
  api.activationStatus.mockResolvedValue({
    ...original!,
    transactionID: "wrong",
    state: "succeeded",
    chargedCredits: 0,
    credentialStored: true,
  })
  fireEvent.click(screen.getByRole("button", { name: dict["im.activation.check"] }))
  await waitFor(() => expect(api.activationStatus).toHaveBeenCalledTimes(1))
  expect(screen.getByText(original!.transactionID, { exact: false })).toBeTruthy()
  expect(api.activate).toHaveBeenCalledTimes(1)
  expect(screen.queryByText(dict["im.activation.state.activated"])).toBeNull()
})

it("payment success without credential custody stays locked and a later receipt cannot erase its observed credit", async () => {
  const api = client()
  const controller = createRoot(() => createIMActivation({ client: api, current: () => true, activated: vi.fn() }))
  await controller.load()
  api.activate.mockImplementation(async (input) => ({
    ...input,
    state: "succeeded",
    chargedCredits: 1,
    credentialStored: false,
  }))
  controller.update({ method: "api_key" })
  controller.update({ name: "Alice", credential: "paid-key" })
  controller.update({ consent: true })
  await controller.submit()
  const id = controller.state.transactionID
  expect(id).toBeTruthy()
  api.activationStatus.mockResolvedValue({
    ...api.activate.mock.calls[0]![0],
    state: "unknown",
    chargedCredits: 0,
    credentialStored: false,
  })
  await controller.check()
  expect(controller.state.transactionID).toBe(id)
  expect(controller.state.error).toBe("unavailable")
  await controller.submit()
  expect(api.activate).toHaveBeenCalledTimes(1)
  controller.dispose()
})

it("schema-invalid input cannot dispatch and a changed owner ignores late success", async () => {
  const api = client()
  const owner = { current: true }
  const activated = vi.fn()
  const controller = createRoot(() => createIMActivation({ client: api, current: () => owner.current, activated }))
  await controller.load()
  controller.update({ name: "Alice", credential: "x".repeat(4097) })
  await controller.submit()
  expect(api.activate).not.toHaveBeenCalled()
  expect(controller.state.transactionID).toBeUndefined()
  expect(controller.state.error).toBe("invalid_input")
  controller.update({ credential: "code" })
  const reply = Promise.withResolvers<Awaited<ReturnType<IMActivationClient["activate"]>>>()
  api.activate.mockReturnValue(reply.promise)
  const submitted = controller.submit()
  const original: IMActivationInput = api.activate.mock.calls[0]![0]
  owner.current = false
  reply.resolve({ ...original, state: "succeeded", chargedCredits: 0, credentialStored: true })
  await submitted
  expect(activated).not.toHaveBeenCalled()
  expect(controller.state.transactionID).toBe(original.transactionID)
  controller.dispose()
  expect(controller.state.credential).toBe("")
})

it("editing the payer resets consent and an altered receipt remains unknown instead of claiming success", async () => {
  const api = client()
  const activated = vi.fn()
  const controller = createRoot(() => createIMActivation({ client: api, current: () => true, activated }))
  await controller.load()
  controller.update({ method: "api_key" })
  controller.update({ name: "Alice", credential: "original-key" })
  controller.update({ consent: true })
  controller.update({ credential: "changed-key" })
  expect(controller.state.consent).toBe(false)
  await controller.submit()
  expect(api.activate).not.toHaveBeenCalled()
  controller.update({ consent: true })
  api.activate.mockImplementation(async (input) => ({
    ...input,
    name: "Different payer",
    state: "succeeded",
    chargedCredits: 1,
    credentialStored: true,
  }))
  await controller.submit()
  expect(controller.state.transactionID).toBe(api.activate.mock.calls[0]?.[0].transactionID)
  expect(controller.state.error).toBe("unavailable")
  expect(activated).not.toHaveBeenCalled()
  controller.dispose()
})

it("known rejection gives a classified explanation and unlocks only when no charge is proven", async () => {
  const api = client()
  api.activate.mockImplementation(async (input) => ({
    ...input,
    state: "rejected",
    chargedCredits: 0,
    credentialStored: false,
    code: "code_invalid",
  }))
  render(() => <IMActivationPanel client={api} current={() => true} activated={vi.fn()} />)
  await fields()
  fireEvent.click(screen.getByRole("button", { name: dict["im.activation.redeem"] }))
  await screen.findByText(dict["im.activation.error.code_invalid"])
  expect(screen.getByRole("button", { name: dict["im.activation.redeem"] })).toBeTruthy()
  expect(screen.queryByRole("button", { name: dict["im.activation.check"] })).toBeNull()
  expect(screen.getByLabelText<HTMLInputElement>(dict["im.activation.code"]).value).toBe("")
})

it("an already activated payer can recover a zero-charge entitlement without reporting a second charge", async () => {
  const api = client()
  const activated = vi.fn()
  const controller = createRoot(() => createIMActivation({ client: api, current: () => true, activated }))
  await controller.load()
  controller.update({ method: "api_key" })
  controller.update({ name: "Alice", credential: "paid-key" })
  controller.update({ consent: true })
  api.activate.mockImplementation(async (input) => ({
    ...input,
    state: "succeeded",
    chargedCredits: 0,
    credentialStored: true,
  }))
  await controller.submit()
  expect(activated).toHaveBeenCalledTimes(1)
  expect(controller.state.result?.chargedCredits).toBe(0)
  controller.dispose()
})
