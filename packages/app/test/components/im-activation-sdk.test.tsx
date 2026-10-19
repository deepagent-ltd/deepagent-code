import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createServer } from "node:http"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { createIMActivationClient } from "@/utils/im-activation-client"
import { IMFacadeRequestError } from "@/utils/im-client"
import { createIMActivation } from "@/components/im/activation-controller"
import { createRoot } from "solid-js"
import { IMActivationSchema } from "@deepagent-code/core/im/activation.schema"
import { IMActivationPanel } from "@/components/im/activation-panel"
import { dict } from "@/i18n/en"

vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict, values?: { credits: number }) =>
      dict[key]?.replace("{{credits}}", `${values?.credits}`),
  }),
}))
afterEach(cleanup)

async function fixture() {
  const calls: { method: string; path: string; body: unknown }[] = []
  const state = {
    invalid: false,
    error: false,
    conflict: false,
    retained: false,
    original: undefined as IMActivationSchema.Transaction | undefined,
  }
  const transaction = {
    transactionID: "original-transaction-id",
    name: "alice",
    method: "activation_code",
    quoteID: "quote",
    state: "succeeded",
    chargedCredits: 0,
    credentialStored: true,
  }
  const listener = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString()
    const url = new URL(request.url ?? "/", "http://localhost")
    calls.push({ method: request.method ?? "GET", path: url.pathname, body: text ? JSON.parse(text) : undefined })
    const conflict = request.method === "POST" && state.conflict
    response.writeHead(state.error || conflict ? 409 : 200, { "Content-Type": "application/json" })
    if (conflict) {
      state.retained = true
      response.end(
        JSON.stringify({
          name: "IM_FACADE_CONFLICT",
          data: { code: "im_activation_pending", message: "An existing transaction is retained" },
        }),
      )
      return
    }
    if (state.error) {
      response.end(
        JSON.stringify({
          name: "IMFacadeConflictError",
          data: { code: "code_invalid", message: "FAKE_SECRET_SHOULD_NOT_RENDER" },
        }),
      )
      return
    }
    if (state.invalid) {
      response.end(JSON.stringify({ secret: "FAKE_SECRET_SHOULD_NOT_RENDER" }))
      return
    }
    if (request.method === "POST" && state.original) {
      state.original = {
        ...state.original,
        state: "succeeded",
        chargedCredits: state.original.method === "api_key" ? 1 : 0,
        credentialStored: true,
      }
    }
    const value = url.pathname.endsWith("/quote")
      ? {
          quoteID: "quote",
          priceCredits: 1,
          quotaCost: 500000,
          expiresAt: Date.now() + 60_000,
          entitlementExpiresAt: null,
        }
      : request.method === "GET" && url.pathname === "/api/v1/im/activation"
        ? {
            transaction:
              state.original ??
              (state.retained
                ? {
                    ...transaction,
                    name: "originalpayer",
                    method: "api_key",
                    state: "unknown",
                    chargedCredits: null,
                    credentialStored: false,
                  }
                : null),
          }
        : (state.original ?? transaction)
    response.end(JSON.stringify(value))
  })
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("Missing listener")
  const owner = { scope: "original", current: true }
  const client = createIMActivationClient({
    client: createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}` }),
    scope: () => owner.scope,
    current: () => owner.current,
  })
  return {
    client,
    calls,
    state,
    owner,
    async close() {
      listener.closeAllConnections()
      await new Promise<void>((resolve) => listener.close(() => resolve()))
    },
  }
}

it("uses all four official activation routes and sends the entered secret only in the one explicit POST", async () => {
  const test = await fixture()
  try {
    const signal = AbortSignal.timeout(5000)
    expect(await test.client.activationPending(signal)).toBeNull()
    expect((await test.client.activationQuote(signal)).priceCredits).toBe(1)
    const request = {
      transactionID: "original-transaction-id",
      name: "alice",
      method: "activation_code" as const,
      credential: "FAKE_CODE_NOT_A_KEY",
      quoteID: "quote",
    }
    expect((await test.client.activate(request, signal)).credentialStored).toBe(true)
    expect((await test.client.activationStatus("original-transaction-id", signal)).chargedCredits).toBe(0)
    expect(test.calls.map((call) => [call.method, call.path])).toEqual([
      ["GET", "/api/v1/im/activation"],
      ["GET", "/api/v1/im/activation/quote"],
      ["POST", "/api/v1/im/activation"],
      ["GET", "/api/v1/im/activation/original-transaction-id"],
    ])
    expect(test.calls[2]?.body).toEqual(request)
    expect(test.calls.filter((call) => call.method === "GET").every((call) => call.body === undefined)).toBe(true)
  } finally {
    await test.close()
  }
})

it("GUI cold unknown recovery requires original-secret confirmation and sends exactly the original request through the SDK", async () => {
  const test = await fixture()
  try {
    const original: IMActivationSchema.Transaction = {
      transactionID: "original-transaction-id",
      name: "alice",
      method: "api_key",
      quoteID: "original-expired-quote",
      state: "unknown",
      chargedCredits: null,
      credentialStored: false,
    }
    test.state.original = original
    render(() => (
      <IMActivationPanel client={test.client} current={() => true} activated={() => {}} allowPaidActivation={false} />
    ))
    const button = await screen.findByRole<HTMLButtonElement>("button", { name: dict["im.activation.retryOriginal"] })
    expect(button.disabled).toBe(true)
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: dict["im.activation.name"] }).disabled).toBe(true)
    expect(test.calls.filter((call) => call.method === "POST")).toHaveLength(0)
    const check = screen.getByRole<HTMLButtonElement>("button", { name: dict["im.activation.check"] })
    await waitFor(() => expect(check.disabled).toBe(false))
    fireEvent.click(check)
    await waitFor(() => expect(test.calls.some((call) => call.path.endsWith(original.transactionID))).toBe(true))
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>(dict["im.activation.key"]).disabled).toBe(false))
    fireEvent.input(screen.getByLabelText(dict["im.activation.key"]), { target: { value: "FAKE_ORIGINAL_KEY" } })
    expect(button.disabled).toBe(true)
    fireEvent.click(screen.getByRole("checkbox"))
    test.state.error = true
    fireEvent.click(button)
    await screen.findByText(dict["im.activation.error.code_invalid"])
    expect(screen.getByLabelText<HTMLInputElement>(dict["im.activation.key"]).value).toBe("")
    expect(screen.getByText(original.transactionID, { exact: false })).toBeTruthy()
    expect(screen.queryByText(dict["im.activation.state.activated"])).toBeNull()
    test.state.error = false
    fireEvent.input(screen.getByLabelText(dict["im.activation.key"]), { target: { value: "FAKE_ORIGINAL_KEY" } })
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(button)
    await screen.findByText(dict["im.activation.state.activated"])
    const posts = test.calls.filter((call) => call.method === "POST")
    expect(posts).toHaveLength(2)
    for (const post of posts)
      expect(post.body).toEqual({
        transactionID: original.transactionID,
        name: original.name,
        method: original.method,
        quoteID: original.quoteID,
        credential: "FAKE_ORIGINAL_KEY",
        retryOriginal: true,
      })
    expect(screen.queryByLabelText(dict["im.activation.key"])).toBeNull()
  } finally {
    await test.close()
  }
})

it("GUI paid pending facts remain visible, block a retry and refuse a later receipt that loses the observed credit", async () => {
  const test = await fixture()
  const flow = createRoot(() => createIMActivation({ client: test.client, current: () => true, activated: () => {} }))
  try {
    const original: IMActivationSchema.Transaction = {
      transactionID: "original-transaction-id",
      name: "alice",
      method: "api_key",
      quoteID: "quote",
      state: "pending",
      chargedCredits: 1,
      credentialStored: false,
    }
    test.state.original = original
    await flow.load()
    expect(flow.state.result).toEqual(original)
    expect(flow.canRetryOriginal()).toBe(false)
    flow.update({ name: "another", credential: "FAKE_OTHER_KEY", consent: true })
    expect(flow.state.name).toBe("alice")
    expect(flow.state.credential).toBe("")
    await flow.retryOriginal()
    test.state.original = { ...original, state: "unknown", chargedCredits: 0 }
    await flow.check()
    expect(flow.state.result?.chargedCredits).toBe(1)
    expect(flow.state.transactionID).toBe(original.transactionID)
    expect(flow.state.error).toBe("unavailable")
    expect(test.calls.filter((call) => call.method === "POST")).toHaveLength(0)
  } finally {
    flow.dispose()
    await test.close()
  }
})

it("a pre-admission pending conflict restores the Host's original transaction by GET instead of buying again", async () => {
  const test = await fixture()
  const flow = createRoot(() => createIMActivation({ client: test.client, current: () => true, activated: () => {} }))
  try {
    test.state.conflict = true
    await flow.load()
    flow.update({ name: "Alice", credential: "FAKE_NEW_CODE" })
    await flow.submit()
    expect(flow.state.transactionID).toBe("original-transaction-id")
    expect(flow.state.result).toMatchObject({
      name: "originalpayer",
      method: "api_key",
      state: "unknown",
      chargedCredits: null,
    })
    expect(flow.state.credential).toBe("")
    expect(test.calls.map((call) => [call.method, call.path])).toEqual([
      ["GET", "/api/v1/im/activation"],
      ["GET", "/api/v1/im/activation/quote"],
      ["POST", "/api/v1/im/activation"],
      ["GET", "/api/v1/im/activation"],
    ])
    await flow.submit()
    expect(test.calls.filter((call) => call.method === "POST")).toHaveLength(1)
  } finally {
    flow.dispose()
    await test.close()
  }
})

it("invalid responses and classified errors do not expose an upstream body, and a retired scope dispatches nothing", async () => {
  const test = await fixture()
  try {
    const signal = AbortSignal.timeout(5000)
    test.state.invalid = true
    await expect(test.client.activationPending(signal)).rejects.toThrow("Invalid activation observation")
    test.state.invalid = false
    test.state.error = true
    const error = await test.client.activationStatus("original-transaction-id", signal).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(IMFacadeRequestError)
    expect(error).toMatchObject({ code: "code_invalid", status: 409 })
    expect(String(error)).not.toContain("FAKE_SECRET_SHOULD_NOT_RENDER")
    test.owner.scope = "new-server"
    await expect(test.client.activationPending(signal)).rejects.toThrow("Activation scope changed")
    expect(test.calls).toHaveLength(2)
  } finally {
    await test.close()
  }
})
