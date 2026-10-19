import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk"
import type { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import type { SharedBrowserTuiSchema } from "@deepagent-code/core/browser/shared-tui-schema"
import { createBrowserOwnerBridge } from "../../../src/cli/tui/browser-owner-bridge"
import { createBrowserOwnerSubmit } from "../../../../tui/src/prompt/browser-owner"

// This finite loopback server tests the production SDK/stream transport and retained
// prompt bytes only. It does not qualify Main approval, provider work or browser control.
test("attached terminal keeps original pairing and sealed prompt through unknown ACK without reconnecting its owner stream", async () => {
  const pairs: SharedBrowserTuiSchema.Pair[] = []
  const prompts: Array<{ body: string; stamp: string | null }> = []
  const seals: SharedBrowserTuiSchema.Seal[] = []
  const streamReady = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
  const state: {
    view?: SharedBrowserTuiSchema.View
    stamp?: SharedBrowserSchema.InputStamp
    owners: number
    reserves: number
  } = { owners: 0, reserves: 0 }
  const emit = (view: SharedBrowserTuiSchema.View) =>
    streamReady.promise.then((controller) =>
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(view)}\n\n`)),
    )
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path.endsWith("/pair")) {
        const pair = (await request.json()) as SharedBrowserTuiSchema.Pair
        pairs.push(pair)
        if (pairs.length === 1) return new Response("unknown", { status: 503 })
        state.view = {
          ...pair,
          attachID: "attached",
          generation: "stream-generation",
          pendingUntil: Date.now() + 60_000,
          state: "pending",
          streamLive: false,
          barrierOrder: 4,
        }
        return Response.json(state.view)
      }
      if (path.endsWith("/owner")) {
        state.owners++
        const connect = (await request.json()) as SharedBrowserTuiSchema.Connect
        expect(createHash("sha256").update(Buffer.from(connect.secret, "hex")).digest("hex")).toBe(
          pairs[0].challengeHash,
        )
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamReady.resolve(controller)
          },
        })
        void emit({ ...state.view!, state: "active", streamLive: true })
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } })
      }
      if (path.endsWith("/reserve")) {
        state.reserves++
        const reserve = (await request.json()) as SharedBrowserTuiSchema.Reserve
        state.stamp = {
          inputID: reserve.inputID,
          originalSubmissionID: reserve.originalSubmissionID,
          rootSessionID: pairs[0].rootSessionID,
          rawInputHash: createHash("sha256").update(reserve.rawInput).digest("hex"),
          sourceKind: "tui_owner",
          sourceBindingHash: "b".repeat(64),
          mainIncarnation: "main",
          submissionOrder: 5,
        }
        return Response.json({ stamp: state.stamp })
      }
      if (path.endsWith("/seal")) {
        const seal = (await request.json()) as SharedBrowserTuiSchema.Seal
        seals.push(seal)
        if (seals.length === 1) return new Response("seal ACK unknown", { status: 503 })
        return Response.json({ stamp: { ...seal.stamp, promptHash: "c".repeat(64) } })
      }
      if (path.endsWith("/prompt")) {
        prompts.push({ body: await request.text(), stamp: request.headers.get("x-dac-user-input") })
        if (prompts.length === 1) return new Response("prompt ACK unknown", { status: 503 })
        return Response.json({ data: { delivery: "steer" } })
      }
      if (path.endsWith("/detach")) return Response.json({ ...state.view!, state: "retired", streamLive: false })
      return new Response("missing", { status: 404 })
    },
  })
  const bridge = createBrowserOwnerBridge({ url: server.url.origin })!
  const owner = createBrowserOwnerSubmit(createDeepAgentCodeClient({ baseUrl: server.url.origin }), bridge.transport)
  const active = Promise.withResolvers<void>()
  const off = bridge.transport.onState((view) => {
    if (view?.state === "active" && view.streamLive) active.resolve()
  })
  try {
    await expect(bridge.transport.pair({ rootSessionID: "session", directory: "/project" })).rejects.toThrow(
      "no confirmed owner response",
    )
    await bridge.transport.pair({ rootSessionID: "session", directory: "/project" })
    await active.promise
    expect(pairs).toHaveLength(2)
    expect(pairs[1]).toEqual(pairs[0])
    expect("secret" in pairs[0]).toBe(false)
    const source = owner.source("session", "/project")!
    expect(source.barrierOrder).toBe(4)
    const ticket = owner.capture(source, "continue the original task")!
    await expect(
      owner.submit({ sessionID: "session", prompt: { text: "prepared original text" }, delivery: "queue" }, ticket),
    ).rejects.toThrow()
    expect(owner.pending("session")).toBe(true)
    expect(prompts).toHaveLength(0)
    // The already-sealed readback uses the original input/order/prompt after source loss.
    await bridge.transport.detach()
    await expect(owner.retry("session")).rejects.toThrow()
    expect(seals).toHaveLength(2)
    expect(seals[1]).toEqual(seals[0])
    await owner.retry("session")
    expect(state.reserves).toBe(1)
    expect(state.owners).toBe(1)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toEqual(prompts[0])
    const stamp = JSON.parse(Buffer.from(prompts[0].stamp!, "base64url").toString()) as SharedBrowserSchema.InputStamp
    expect(stamp.sourceKind).toBe("tui_owner")
    expect(stamp.inputID).toBe(ticket.inputID)
    expect(JSON.parse(prompts[0].body).id).toBe(ticket.inputID)
    expect(owner.pending("session")).toBe(false)
    expect(owner.source("session", "/project")).toBeUndefined()
  } finally {
    off()
    bridge.close()
    server.stop(true)
  }
}, 10_000)

test("explicit cancellation releases only an original input that never called canonical prompt", async () => {
  const source: SharedBrowserTuiSchema.View = {
    requestID: "pair",
    challengeHash: "a".repeat(64),
    rootSessionID: "session",
    directory: "/project",
    attachID: "attached",
    generation: "stream-generation",
    pendingUntil: Date.now() + 60_000,
    state: "active",
    streamLive: true,
    barrierOrder: 1,
  }
  const state = { prompts: 0 }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/prompt")) state.prompts++
      return new Response("definite test refusal", { status: 403 })
    },
  })
  const client = createDeepAgentCodeClient({ baseUrl: server.url.origin })
  // Only the cancellation phase is exercised here. This local port provides no Main authority.
  const owner = createBrowserOwnerSubmit(client, {
    current: () => source,
    pair: async () => source,
    reserve: async (input) => ({
      inputID: input.inputID,
      originalSubmissionID: input.originalSubmissionID,
      rootSessionID: source.rootSessionID,
      rawInputHash: "a".repeat(64),
      sourceKind: "tui_owner",
      sourceBindingHash: "b".repeat(64),
      mainIncarnation: "test-no-main",
      submissionOrder: 2,
    }),
    seal: async (input) => {
      const reply = await client.browser.tuiSeal({ ...input, secret: "c".repeat(64) }, { throwOnError: true })
      return reply.data.stamp
    },
    detach: async () => {},
    onState: () => () => {},
  })
  try {
    const ticket = owner.capture(owner.source("session", "/project"), "continue")!
    const attempt = owner.submit({ sessionID: "session", prompt: { text: "continue" } }, ticket)
    expect(owner.canCancelBeforeDispatch("session")).toBe(false)
    await expect(attempt).rejects.toThrow()
    expect(state.prompts).toBe(0)
    expect(owner.pending("session")).toBe(true)
    expect(owner.cancelBeforeDispatch("other-session")).toBe(false)
    expect(owner.canCancelBeforeDispatch("session")).toBe(true)
    expect(owner.cancelBeforeDispatch("session")).toBe(true)
    expect(owner.pending("session")).toBe(false)
    expect(state.prompts).toBe(0)
  } finally {
    server.stop(true)
  }
})
