import { Effect, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import type { BrowserHost } from "@deepagent-code/core/browser/host"
import { BrowserControl } from "@deepagent-code/core/browser/control"
import type { BrowserSchema } from "@deepagent-code/core/browser/schema"
import type { SharedBrowserTuiSchema } from "@deepagent-code/core/browser/shared-tui-schema"

/** Stable handler dependencies are captured once by the original browser API layer.
 * Public JSON contains no native identity, source kind or authoritative stream ID. */
export function browserTui<R>(
  native: (reducing?: boolean) => Effect.Effect<BrowserHost.Interface, BrowserSchema.Error, R>,
  scopeFor: (sessionID: string) => Effect.Effect<BrowserSchema.Scope, BrowserSchema.Error>,
) {
  const local = (reducing = false) =>
    Effect.gen(function* () {
      const host = yield* native(reducing)
      if (!host.shared?.tui) return yield* BrowserControl.failure("BROWSER_DRIVER_UNAVAILABLE")
      const request = yield* HttpServerRequest.HttpServerRequest
      const socket = "socket" in request.source ? request.source.socket : undefined
      if (
        !socket ||
        typeof socket !== "object" ||
        !("localPort" in socket) ||
        !Number.isInteger(socket.localPort) ||
        Number(socket.localPort) < 1 ||
        Number(socket.localPort) > 65535
      )
        return yield* BrowserControl.failure("BROWSER_SCOPE_DENIED")
      // native() has already verified both actual socket addresses as loopback. Never use
      // Host, forwarded headers, request URL or a client-supplied ready-server descriptor.
      return { tui: host.shared.tui, serverURL: `http://127.0.0.1:${socket.localPort}` }
    })
  return {
    pair: (input: SharedBrowserTuiSchema.Pair) =>
      Effect.gen(function* () {
        const host = yield* local()
        const scope = yield* scopeFor(input.rootSessionID)
        if (scope.directory !== input.directory) return yield* BrowserControl.failure("BROWSER_SCOPE_DENIED")
        return yield* host.tui.pair(input, host.serverURL)
      }),
    owner: (input: SharedBrowserTuiSchema.Connect) =>
      Effect.gen(function* () {
        const host = yield* local()
        return HttpServerResponse.stream(
          host.tui.owner(input, host.serverURL).pipe(
            Stream.map(
              (view): Sse.Event => ({ _tag: "Event", event: "state", id: undefined, data: JSON.stringify(view) }),
            ),
            Stream.pipeThroughChannel(Sse.encode()),
            Stream.encodeText,
          ),
          {
            contentType: "text/event-stream",
            headers: {
              "cache-control": "no-cache, no-store, no-transform",
              "x-accel-buffering": "no",
              "x-content-type-options": "nosniff",
            },
          },
        )
      }),
    reserve: (input: SharedBrowserTuiSchema.Reserve) =>
      Effect.gen(function* () {
        const host = yield* local()
        const stamp = yield* host.tui.reserve(input)
        return stamp === undefined ? {} : { stamp }
      }),
    seal: (input: SharedBrowserTuiSchema.Seal) =>
      Effect.gen(function* () {
        const host = yield* local()
        return { stamp: yield* host.tui.seal(input) }
      }),
    detach: (input: SharedBrowserTuiSchema.Detach) =>
      Effect.gen(function* () {
        const host = yield* local(true)
        return yield* host.tui.detach(input)
      }),
  }
}
