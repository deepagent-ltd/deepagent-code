export * as WorkErrorDiagnostic from "./work-error-diagnostic"

import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import { Cause, Effect, Option } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"

/** Never render the driver's query, parameters or raw message. Those can contain
 * credentials and model input; only fixed error classes and our constraint names
 * belong in a boundary diagnostic. */
export function report(boundary: "command" | "write", error: unknown) {
  const cause = error instanceof EffectDrizzleQueryError && Cause.isCause(error.cause)
    ? Option.getOrUndefined(Cause.findErrorOption(error.cause)) : error
  const sql = cause instanceof SqlError ? cause.reason : undefined
  const native = sql?.cause
  const code = typeof native === "object" && native !== null && "code" in native ? native.code
    : typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined
  const constraint = typeof native === "object" && native !== null && "message" in native && typeof native.message === "string"
    ? native.message.match(/\bwork_(?:command|write_stage)_[a-z0-9_]{1,96}\b/)?.[0] : undefined
  return Effect.logWarning(`Work ${boundary} boundary refused kind=${sql ? "SQL" : Effect.isEffect(cause) ? "EFFECT_VALUE" : "OTHER"} code=${
    typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "UNCLASSIFIED"
  } reason=${sql?._tag ?? "NONE"} constraint=${constraint ?? "NONE"}`)
}
