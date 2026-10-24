import { createHash, randomBytes, randomUUID } from "node:crypto"
import { Option, Schema } from "effect"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk"
import { SharedBrowserTuiSchema } from "@deepagent-code/core/browser/shared-tui-schema"
import { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import type { BrowserOwnerTransport } from "@deepagent-code/tui"

/** This transport owns only a RAM secret. The actual utility/Main connection and real
 * Desktop approval are required for every stamp; Basic auth or a loopback URL is not proof. */
export function createBrowserOwnerBridge(input: {
  url: string
  headers?: RequestInit["headers"]
  fetch?: typeof fetch
}) {
  const url = new URL(input.url)
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return undefined
  const client = createDeepAgentCodeClient({ baseUrl: url.origin, headers: input.headers, fetch: input.fetch })
  type Entry = {
    pair: SharedBrowserTuiSchema.Pair
    secret: string
    view?: SharedBrowserTuiSchema.View
    stream?: AbortController
    streamStarted: boolean
  }
  const state: { entry?: Entry; closed: boolean; waiting: number } = { closed: false, waiting: 0 }
  const retained = new Map<string, Entry>()
  const ranks = { pending: 0, active: 1, retired: 2 }
  const listeners = new Set<(view: SharedBrowserTuiSchema.View | undefined) => void>()
  const failure = () => new Error("Local terminal connection has no confirmed owner response")
  const decode = <A>(schema: Schema.Codec<A, unknown>, value: unknown): A => {
    const parsed = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(value)
    if (Option.isNone(parsed)) throw failure()
    return parsed.value
  }
  const publish = (entry: Entry, view: SharedBrowserTuiSchema.View) => {
    if (
      state.entry !== entry ||
      view.requestID !== entry.pair.requestID ||
      view.challengeHash !== entry.pair.challengeHash ||
      view.rootSessionID !== entry.pair.rootSessionID ||
      view.directory !== entry.pair.directory ||
      (entry.view && (entry.view.attachID !== view.attachID || entry.view.generation !== view.generation))
    )
      throw failure()
    if (entry.view && (ranks[view.state] < ranks[entry.view.state] || view.barrierOrder < entry.view.barrierOrder))
      return
    entry.view = view
    retained.set(view.attachID, entry)
    for (const listener of listeners) listener(view)
  }
  const call = async <Value>(entry: Entry, operation: () => Promise<Value>) => {
    if (state.closed || state.waiting >= SharedBrowserTuiSchema.MAX_PER_SOURCE) throw failure()
    state.waiting++
    try {
      return await operation()
    } catch {
      // SDK errors can retain their request. Never let the body containing the secret escape.
      throw failure()
    } finally {
      state.waiting--
    }
  }
  const ownerStream = async (entry: Entry) => {
    const view = entry.view
    if (!view || entry.streamStarted || state.entry !== entry) return
    entry.streamStarted = true
    const controller = new AbortController()
    entry.stream = controller
    try {
      const result = await client.browser.tuiOwner(
        {
          attachID: view.attachID,
          generation: view.generation,
          secret: entry.secret,
        },
        { signal: controller.signal, sseMaxRetryAttempts: 0 },
      )
      for await (const value of result.stream) {
        if (state.entry !== entry || controller.signal.aborted) break
        const next = decode(SharedBrowserTuiSchema.View, value)
        publish(entry, next)
        if (next.state === "retired") break
      }
    } catch {
      // A stream is never automatically reconnected or reapproved.
    } finally {
      controller.abort()
      if (state.entry === entry && entry.view) {
        entry.view = { ...entry.view, streamLive: false }
        for (const listener of listeners) listener(entry.view)
      }
    }
  }
  const bound = (request: { attachID: string; generation: string }, fresh = true) => {
    const entry = fresh ? state.entry : retained.get(request.attachID)
    if (
      !entry?.view ||
      state.closed ||
      entry.view.attachID !== request.attachID ||
      entry.view.generation !== request.generation ||
      (fresh && (!entry.view.streamLive || entry.view.state !== "active" || entry.stream?.signal.aborted))
    )
      throw failure()
    return entry
  }
  const transport: BrowserOwnerTransport = {
    current: () => state.entry?.view,
    async pair(request) {
      if (state.closed) throw failure()
      if (state.entry?.view?.state === "retired") state.entry = undefined
      const entry =
        state.entry ??
        (() => {
          if (retained.size >= SharedBrowserTuiSchema.MAX_ACTIVE) throw failure()
          const secret = randomBytes(32).toString("hex")
          const value: Entry = {
            secret,
            pair: {
              ...request,
              requestID: randomUUID(),
              challengeHash: createHash("sha256").update(Buffer.from(secret, "hex")).digest("hex"),
            },
            streamStarted: false,
          }
          state.entry = value
          return value
        })()
      if (
        entry.pair.rootSessionID !== request.rootSessionID ||
        entry.pair.directory !== request.directory ||
        entry.stream?.signal.aborted
      )
        throw failure()
      const view = decode(
        SharedBrowserTuiSchema.View,
        await call(entry, () =>
          client.browser
            .tuiPair(entry.pair, { throwOnError: true, signal: AbortSignal.timeout(10_000) })
            .then((reply) => reply.data),
        ),
      )
      publish(entry, view)
      void ownerStream(entry)
      return view
    },
    async reserve(request) {
      const entry = bound(request)
      if (entry.view!.barrierOrder !== request.expectedBarrierOrder) return undefined
      const value = decode(
        Schema.Struct({ stamp: Schema.optional(SharedBrowserSchema.InputStamp) }),
        await call(entry, () =>
          client.browser
            .tuiReserve(
              { ...request, secret: entry.secret },
              { throwOnError: true, signal: AbortSignal.timeout(10_000) },
            )
            .then((reply) => reply.data),
        ),
      )
      if (
        value.stamp &&
        (value.stamp.sourceKind !== "tui_owner" ||
          value.stamp.inputID !== request.inputID ||
          value.stamp.originalSubmissionID !== request.originalSubmissionID ||
          value.stamp.rootSessionID !== entry.pair.rootSessionID)
      )
        throw failure()
      return value.stamp
    },
    async seal(request) {
      const entry = bound(request, false)
      const value = decode(
        Schema.Struct({ stamp: SharedBrowserSchema.InputStamp }),
        await call(entry, () =>
          client.browser
            .tuiSeal({ ...request, secret: entry.secret }, { throwOnError: true, signal: AbortSignal.timeout(10_000) })
            .then((reply) => reply.data),
        ),
      )
      if (
        value.stamp.sourceKind !== "tui_owner" ||
        value.stamp.inputID !== request.stamp.inputID ||
        value.stamp.originalSubmissionID !== request.stamp.originalSubmissionID ||
        value.stamp.rootSessionID !== entry.pair.rootSessionID ||
        value.stamp.submissionOrder !== request.stamp.submissionOrder ||
        !value.stamp.promptHash
      )
        throw failure()
      return value.stamp
    },
    async detach() {
      const entry = state.entry
      if (!entry?.view) throw failure()
      const view = decode(
        SharedBrowserTuiSchema.View,
        await call(entry, () =>
          client.browser
            .tuiDetach(
              {
                attachID: entry.view!.attachID,
                generation: entry.view!.generation,
                secret: entry.secret,
              },
              { throwOnError: true, signal: AbortSignal.timeout(10_000) },
            )
            .then((reply) => reply.data),
        ),
      )
      publish(entry, view)
      if (view.state !== "retired") throw failure()
      entry.stream?.abort()
      // Keep this bounded old entry for immutable, already-sealed exact request recovery.
    },
    onState(listener) {
      if (listeners.size >= 32) throw failure()
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return {
    transport,
    close() {
      state.closed = true
      state.entry?.stream?.abort()
      for (const entry of retained.values()) {
        entry.stream?.abort()
        entry.secret = ""
      }
      if (state.entry) state.entry.secret = ""
      retained.clear()
      state.entry = undefined
      listeners.clear()
    },
  }
}
