import { BrowserHost } from "@deepagent-code/core/browser/host"
import { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import { SharedBrowserUserInput } from "@deepagent-code/core/browser/shared-user-input"
import { LocationRuntimeHost } from "@deepagent-code/core/location-layer"
import { Effect, Option, Schema } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { InvalidRequestError, ServiceUnavailableError } from "./errors"

/** A normal prompt remains normal. This optional envelope only carries an exact
 * Main-issued input identity; the HTTP caller cannot declare itself a human. */
export const withBrowserUserInput = (sessionID: string, inputID: string | undefined) =>
  <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const encoded = request.headers["x-dac-user-input"]
    if (!encoded) return yield* body
    const invalid = () => new InvalidRequestError({ message: "Invalid local owner input receipt",
      kind: "invalid_browser_user_input", field: "x-dac-user-input" })
    if (encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return yield* invalid()
    const bytes = Buffer.from(encoded, "base64url")
    if (bytes.length > 4096 || bytes.toString("base64url") !== encoded) return yield* invalid()
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(SharedBrowserSchema.InputStamp),
      { onExcessProperty: "error" })(bytes.toString("utf8"))
    if (Option.isNone(decoded) || decoded.value.rootSessionID !== sessionID || decoded.value.inputID !== inputID)
      return yield* invalid()
    const native = yield* BrowserHost.Current
    const runtime = yield* Effect.serviceOption(LocationRuntimeHost)
    const host = native?.shared ?? (Option.isSome(runtime) ? runtime.value.browser?.shared : undefined)
    if (!host) return yield* new ServiceUnavailableError({ message: "The local browser owner bridge is unavailable",
      service: "shared_browser_owner_input" })
    return yield* SharedBrowserUserInput.withOrigin(decoded.value, host, body).pipe(
      Effect.catchTag("Browser.Error", () => Effect.fail(invalid())))
  })
