export * as RemoteTaskAuthority from "./remote-task-authority"

import { timingSafeEqual } from "node:crypto"
import { IncomingMessage } from "node:http"
import { isIP } from "node:net"
import { TLSSocket } from "node:tls"
import { Effect } from "effect"
import type { HttpServerRequest } from "effect/unstable/http"
import type { Database } from "@deepagent-code/core/database/database"
import { LocalOperatorSchema } from "@deepagent-code/core/im/local-operator.schema"
import { ServerAuth } from "@/server/auth"
import type { CorsOptions } from "@/server/cors"
import { LocalTaskAuthority } from "./local-task-authority"

const denied = () => new LocalOperatorSchema.Error({
  code: "LOCAL_OPERATOR_AUTH_REQUIRED",
  message: "Remote task changes require an enrolled operator over the current HTTPS listener",
})

/** The listener supplies its fixed origin. Caller headers, JSON and gateway forwarding
 * cannot turn the existing HTTP/local transport into an authenticated remote boundary. */
export const authenticate = Effect.fn("RemoteTaskAuthority.authenticate")(function* (
  db: Database.Interface["db"],
  config: ServerAuth.Info,
  request: HttpServerRequest.HttpServerRequest,
  listener: { origin: string; cors?: CorsOptions; verifyTLSRequest?: (source: unknown) => boolean },
) {
  if (!(request.source instanceof IncomingMessage) || !listener.verifyTLSRequest?.(request.source))
    return yield* denied()
  const socket = request.source.socket
  // Bun's genuine node:https requests expose Socket rather than TLSSocket. Their
  // transport proof comes only from this live HTTPS listener's original request set.
  if ((socket instanceof TLSSocket && (!socket.encrypted || !["TLSv1.2", "TLSv1.3"].includes(socket.getProtocol() ?? ""))) ||
    socket.destroyed ||
    !socket.localAddress || !socket.remoteAddress || !isIP(socket.localAddress) || !isIP(socket.remoteAddress) ||
    !URL.canParse(listener.origin)) return yield* denied()
  const endpoint = new URL(listener.origin)
  if (endpoint.protocol !== "https:" || endpoint.origin !== listener.origin || endpoint.username || endpoint.password ||
    Number(endpoint.port || "443") !== socket.localPort || !URL.canParse(request.originalUrl, listener.origin) ||
    new URL(request.originalUrl, listener.origin).searchParams.has("auth_token")) return yield* denied()
  if (request.headers.origin !== undefined && request.headers.origin !== listener.origin &&
    !["oc://renderer", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"].includes(request.headers.origin) &&
    !(listener.cors?.cors ?? []).some((origin) => origin === request.headers.origin && URL.canParse(origin) &&
      new URL(origin).protocol === "https:" && new URL(origin).origin === origin)) return yield* denied()
  const configured = yield* LocalTaskAuthority.configured(config)
  const authorization = request.headers.authorization
  if (!authorization?.startsWith("Basic ") || authorization.length > 8192) return yield* denied()
  const decoded = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(authorization.slice(6), "base64")),
    catch: denied,
  })
  const separator = decoded.indexOf(":")
  if (separator < 1 || !equal(decoded.slice(0, separator), config.username) ||
    !equal(decoded.slice(separator + 1), configured.password)) return yield* denied()
  const witness = yield* LocalTaskAuthority.authenticatePassword(db, configured.runtime,
    decoded.slice(0, separator), decoded.slice(separator + 1))
  return { runtime: configured.runtime, witness }
})

function equal(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
