/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { createOpencodeClient } from "@deepagent-code/sdk"
import { IMActivationSchema } from "@deepagent-code/core/im/activation.schema"
import { Schema } from "effect"
import { createIMClient } from "../../../src/component/im-client"
import { DialogIMModel } from "../../../src/component/dialog-im-model"
import { IMSecretInput } from "../../../src/component/im-secret-input"
import { createIMActivation } from "../../../src/component/im-activation"
import { DialogIMActivation } from "../../../src/component/dialog-im-activation"
import { useSDK } from "../../../src/context/sdk"
import { mountIM } from "../../fixture/im-environment"
import { tmpdir } from "../../fixture/fixture"

function activationFixture(directory: string) {
  const state = {
    posts: [] as IMActivationSchema.Submit[],
    calls: [] as { method: string; path: string; auth: string | null; directory: string | null }[],
    transaction: null as IMActivationSchema.Transaction | null,
    pending: null as IMActivationSchema.Transaction | null,
    loseResponse: false, wrongReceipt: false, expiredQuote: false, pendingConflict: false,
    beforeResponse: undefined as (() => void) | undefined,
  }
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url)
    state.calls.push({ method: request.method, path: url.pathname, auth: request.headers.get("authorization"),
      directory: url.searchParams.get("directory") })
    if (url.pathname === "/api/v1/im/activation" && request.method === "GET")
      return Response.json({ transaction: state.pending })
    if (url.pathname === "/api/v1/im/activation/quote") return Response.json({ quoteID: "fixture-quote", priceCredits: 1,
      quotaCost: 500_000, expiresAt: Date.now() + (state.expiredQuote ? -1_000 : 60_000), entitlementExpiresAt: null })
    if (url.pathname === "/api/v1/im/activation" && request.method === "POST") {
      const body = Schema.decodeUnknownSync(IMActivationSchema.Submit)(await request.json())
      state.posts.push(body)
      if (state.pendingConflict) {
        state.transaction = { transactionID: "retained-other-transaction", name: "originalpayer", method: "api_key",
          quoteID: "original-quote", state: "unknown", chargedCredits: null, credentialStored: false }
        state.pending = state.transaction
        return Response.json({ name: "IM_FACADE_CONFLICT", data: { code: "im_activation_pending",
          message: "An existing transaction is retained" } }, { status: 409 })
      }
      state.transaction = { transactionID: state.wrongReceipt ? "foreign-transaction-original" : body.transactionID,
        name: body.name, method: body.method, quoteID: body.quoteID, state: "succeeded",
        chargedCredits: body.method === "api_key" ? 1 : 0, credentialStored: true }
      state.pending = { ...state.transaction, state: "unknown", chargedCredits: null, credentialStored: false }
      state.beforeResponse?.()
      if (state.loseResponse) return Response.json({ code: "response_lost" }, { status: 503 })
      return Response.json(state.transaction)
    }
    if (url.pathname.startsWith("/api/v1/im/activation/")) return Response.json(state.transaction)
    return Response.json({ code: "unexpected_path" }, { status: 404 })
  } })
  const sdk = { url: server.url.origin, directory,
    client: createOpencodeClient({ baseUrl: server.url.origin, headers: { Authorization: "Basic fixture-only" } }) }
  return { state, server, client: createIMClient(sdk), [Symbol.dispose]() { server.stop(true) } }
}

test("credential input keeps raw key out of the renderer buffer and supports explicit clear", async () => {
  await using tmp = await tmpdir()
  const state = { value: "" }
  function View() {
    const [value, setValue] = createSignal("")
    return <IMSecretInput label="Manual credential" value={value()} active locked={false}
      setValue={(next) => { state.value = next; setValue(next) }} />
  }
  using ui = await mountIM(tmp.path, "http://127.0.0.1:1", View)
  await ui.frame("Manual credential")
  await ui.type("fixture-payment-key")
  const rendered = await ui.frame("*******************")
  expect(state.value).toBe("fixture-payment-key")
  expect(rendered).not.toContain("fixture-payment-key")
  expect(ui.app.renderer.currentFocusedEditor?.plainText).toBe("*******************")
  ui.app.mockInput.pressKey("u", { ctrl: true })
  await Bun.sleep(20)
  await ui.app.renderOnce()
  expect(state.value).toBe("")
})

test("IM model menu writes only the independent field and fresh reopening observes it", async () => {
  await using tmp = await tmpdir()
  const configFile = `${tmp.path}/config.json`
  await Bun.write(configFile, JSON.stringify({ model: "ordinary/original", im: { model: "deepseek/old" },
    provider: { ordinary: { options: { retained: true } } } }))
  const calls: { path: string; method: string; auth: string | null; directory: string | null }[] = []
  const patches: unknown[] = []
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url)
    calls.push({ path: url.pathname, method: request.method, auth: request.headers.get("authorization"),
      directory: url.searchParams.get("directory") })
    if (url.pathname === "/config") return Response.json(await Bun.file(configFile).json())
    if (url.pathname === "/provider") return Response.json({ all: [
      { id: "deepseek", name: "DeepSeek", models: {
        "deepseek-flash": { id: "deepseek-flash", name: "Available Flash", status: "active" },
        "retired": { id: "retired", name: "Retired model", status: "deprecated" },
      } },
      { id: "not-connected", name: "Not connected", models: {
        hidden: { id: "hidden", name: "Unconnected model", status: "active" },
      } },
    ], connected: ["deepseek"], default: {} })
    if (url.pathname === "/global/config" && request.method === "PATCH") {
      const body = await request.json() as { im: { model: string } }
      patches.push(body)
      const original = await Bun.file(configFile).json()
      const config = { ...original, im: { ...original.im, model: body.im.model } }
      await Bun.write(configFile, JSON.stringify(config))
      return Response.json(config)
    }
    return Response.json({ code: "unexpected_path" }, { status: 404 })
  } })
  using cleanup = { [Symbol.dispose]() { server.stop(true) } }
  function View() {
    const client = createIMClient(useSDK())
    return <DialogIMModel client={client} back={() => {}} />
  }
  {
    using ui = await mountIM(tmp.path, server.url.origin, View)
    const frame = await ui.frame("Available Flash")
    expect(frame).not.toContain("Retired model")
    expect(frame).not.toContain("Unconnected model")
    await ui.select("Available Flash")
    await ui.frame("Current IM model: deepseek/deepseek-flash")
  }
  {
    using ui = await mountIM(tmp.path, server.url.origin, View)
    await ui.frame("Current IM model: deepseek/deepseek-flash")
  }
  expect(patches).toEqual([{ im: { model: "deepseek/deepseek-flash" } }])
  expect(await Bun.file(configFile).json()).toMatchObject({ model: "ordinary/original",
    im: { model: "deepseek/deepseek-flash" }, provider: { ordinary: { options: { retained: true } } } })
  expect(calls.every((call) => call.auth === "Bearer fixture-token" && call.directory === tmp.path)).toBe(true)
  expect(calls.filter((call) => call.path.startsWith("/auth") || call.path.includes("activation"))).toHaveLength(0)
})

test("actual activation form requires the explicit 1 credit confirmation and never reads a provider key", async () => {
  await using tmp = await tmpdir()
  using peer = activationFixture(tmp.path)
  function View() {
    const flow = createIMActivation({ client: createIMClient(useSDK()), current: () => true })
    return <DialogIMActivation flow={flow} back={() => {}} />
  }
  using ui = await mountIM(tmp.path, peer.server.url.origin, View)
  await ui.frame("Activation price: 1 credit")
  expect(peer.state.posts).toHaveLength(0)
  await ui.type("OwnFixture")
  ui.app.mockInput.pressTab()
  await ui.type("fixture-payment-key")
  ui.app.mockInput.pressEnter()
  await ui.frame("Enter a valid IM name")
  expect(peer.state.posts).toHaveLength(0)
  ui.app.mockInput.pressKey("c", { meta: true })
  await ui.frame("[x]")
  ui.app.mockInput.pressEnter()
  await ui.frame("Activation completed")
  expect(peer.state.posts).toHaveLength(1)
  expect(peer.state.posts[0]).toMatchObject({ name: "ownfixture", method: "api_key",
    credential: "fixture-payment-key", quoteID: "fixture-quote" })
  expect(ui.app.captureCharFrame()).not.toContain("fixture-payment-key")
  ui.app.mockInput.pressKey("r", { ctrl: true })
  await ui.frame("Activation completed")
  expect(peer.state.posts).toHaveLength(1)
  expect(peer.state.calls.at(-1)?.path).toBe(`/api/v1/im/activation/${peer.state.posts[0].transactionID}`)
  expect(ui.app.captureCharFrame()).not.toContain("IM name")
  expect(peer.state.calls.every((call) => call.directory === tmp.path && call.auth === "Bearer fixture-token")).toBe(true)
  expect(peer.state.calls.filter((call) => call.path.startsWith("/provider") || call.path.startsWith("/auth"))).toHaveLength(0)
})

test("unknown charge locks the original intent and cold pending restores status-only recovery", async () => {
  await using tmp = await tmpdir()
  using peer = activationFixture(tmp.path)
  peer.state.loseResponse = true
  const flow = createIMActivation({ client: peer.client, current: () => true })
  try {
    await flow.load()
    flow.update({ name: "OwnFixture", credential: "fixture-payment-key" })
    flow.update({ confirmed: true })
    await expect(flow.submit()).rejects.toThrow()
    const original = peer.state.posts[0]
    expect(flow.state.transactionID).toBe(original.transactionID)
    expect(flow.state.uncertain).toBe(true)
    expect(flow.update({ credential: "different-key" })).toBe(false)
    await flow.submit()
    expect(peer.state.posts).toHaveLength(1)
    flow.dispose()
    const cold = createIMActivation({ client: peer.client, current: () => true })
    try {
      await cold.load()
      expect(cold.state.transactionID).toBe(original.transactionID)
      expect(cold.state.transaction?.chargedCredits).toBeNull()
      expect(cold.state.credential).toBe("")
      expect(cold.update({ name: "AnotherName" })).toBe(false)
      await cold.submit()
      expect(peer.state.posts).toHaveLength(1)
      await cold.refresh()
      expect(cold.state.transaction).toMatchObject({ state: "succeeded", chargedCredits: 1, credentialStored: true })
      expect(cold.state.uncertain).toBe(false)
      expect(cold.state.credential).toBe("")
      expect(peer.state.posts).toHaveLength(1)
    } finally { cold.dispose() }
  } finally { flow.dispose() }
})

test("dedicated IM code redemption is explicit and quote expiry prevents any activation dispatch", async () => {
  await using tmp = await tmpdir()
  using peer = activationFixture(tmp.path)
  const flow = createIMActivation({ client: peer.client, current: () => true })
  try {
    await flow.load()
    flow.update({ name: "OwnFixture", method: "activation_code", credential: "fixture-im-code" })
    expect(peer.state.posts).toHaveLength(0)
    expect((await flow.submit())?.chargedCredits).toBe(0)
    expect(peer.state.posts[0].method).toBe("activation_code")
    expect(flow.state.credential).toBe("")
  } finally { flow.dispose() }
  peer.state.pending = null
  peer.state.expiredQuote = true
  const expired = createIMActivation({ client: peer.client, current: () => true })
  try {
    await expired.load()
    expired.update({ name: "OwnFixture", method: "activation_code", credential: "fixture-im-code" })
    await expect(expired.submit()).rejects.toThrow("expired")
    expect(peer.state.posts).toHaveLength(1)
  } finally { expired.dispose() }
})

test("foreign transaction and late scope observations cannot report successful activation", async () => {
  await using tmp = await tmpdir()
  using peer = activationFixture(tmp.path)
  peer.state.wrongReceipt = true
  const owner = { current: true }
  const flow = createIMActivation({ client: peer.client, current: () => owner.current })
  try {
    await flow.load()
    flow.update({ name: "OwnFixture", credential: "fixture-payment-key" })
    flow.update({ confirmed: true })
    await expect(flow.submit()).rejects.toThrow("changed")
    expect(flow.state.transaction).toBeUndefined()
    expect(flow.state.transactionID).toBe(peer.state.posts[0].transactionID)
    expect(flow.state.uncertain).toBe(true)
  } finally { flow.dispose() }
  peer.state.pending = null
  peer.state.wrongReceipt = false
  peer.state.beforeResponse = () => { owner.current = false }
  owner.current = true
  const late = createIMActivation({ client: peer.client, current: () => owner.current })
  try {
    await late.load()
    late.update({ name: "OwnFixture", credential: "fixture-payment-key" })
    late.update({ confirmed: true })
    await expect(late.submit()).rejects.toThrow("scope changed")
    expect(late.state.transaction).toBeUndefined()
    expect(peer.state.posts).toHaveLength(2)
  } finally { late.dispose() }
})

test("pending conflict recovers the retained transaction by GET without another purchase", async () => {
  await using tmp = await tmpdir()
  using peer = activationFixture(tmp.path)
  peer.state.pendingConflict = true
  const flow = createIMActivation({ client: peer.client, current: () => true })
  try {
    await flow.load()
    flow.update({ name: "OwnFixture", method: "activation_code", credential: "fixture-new-code" })
    await flow.submit()
    expect(flow.state.transactionID).toBe("retained-other-transaction")
    expect(flow.state.transaction).toMatchObject({ name: "originalpayer", method: "api_key",
      quoteID: "original-quote", state: "unknown", chargedCredits: null })
    expect(flow.state.uncertain).toBe(true)
    expect(flow.state.credential).toBe("")
    expect(peer.state.calls.map((call) => [call.method, call.path])).toEqual([
      ["GET", "/api/v1/im/activation"], ["GET", "/api/v1/im/activation/quote"],
      ["POST", "/api/v1/im/activation"], ["GET", "/api/v1/im/activation"],
    ])
    await flow.submit()
    await flow.refresh()
    expect(peer.state.posts).toHaveLength(1)
    expect(peer.state.calls.at(-1)?.path).toBe("/api/v1/im/activation/retained-other-transaction")
  } finally { flow.dispose() }
})
