export * as BrowserToolInput from "./browser-input"

import { Effect, Schema } from "effect"
import { BrowserSchema } from "../browser/schema"
import { SharedBrowserSchema } from "../browser/shared-schema"
import { Tool } from "./tool"

export const Input = Schema.Union([BrowserSchema.Invoke, SharedBrowserSchema.Invoke])

export const description = 'Shared browser inputs are distinct JSON forms: status={"operation":"status","resourceID":"..."}; acquire={"operation":"acquire","resourceID":"...","requestID":"...","expectedManualEpoch":1}; execute={"operation":"execute","resourceID":"...","command":{"type":"tabs.list"}} with optional timeoutMs. Acquire requires a unique requestID and a positive integer expectedManualEpoch, never a quoted number; acquire has no controlID or command. After the user approves additional manual sites in trusted DAC chrome, acquire may include approvedOrigins containing the complete existing Agent origins plus the explicitly requested manual-approved origins; this requires fresh Permission approval and the same new-user-input witness, and never approves manual sites itself. Legacy inputs are {"controlID":"...","command":{"type":"tabs.list"}} with optional timeoutMs and have no operation or resourceID. Do not mix the shared and legacy forms or add undeclared fields.'

/** Presence of either shared field selects that protocol before decoding. A malformed
 * shared call must never become a legacy call by silently dropping its fields. */
export function decode(input: unknown) {
  const shared = typeof input === "object" && input !== null && ("operation" in input || "resourceID" in input)
  const operation = shared && "operation" in input ? input.operation : undefined
  const contract = !shared ? "legacy browser input: controlID and command, optional timeoutMs; no operation/resourceID"
    : operation === "acquire" ? "shared browser acquire input: operation=acquire, resourceID, requestID, expectedManualEpoch (positive integer), optional approvedOrigins for a separate permission-approved expansion within manually approved sites; no controlID/command"
    : operation === "status" ? "shared browser status input: operation=status and resourceID only; no controlID/command"
    : operation === "execute" ? "shared browser execute input: operation=execute, resourceID and command, optional timeoutMs; no controlID"
    : "shared browser input: operation must be status, acquire or execute; use resourceID, never controlID"
  const options = { onExcessProperty: "error", errors: "all" } as const
  return Effect.gen(function* () {
    if (shared) return yield* Schema.decodeUnknownEffect(SharedBrowserSchema.Invoke, options)(input)
    return yield* Schema.decodeUnknownEffect(BrowserSchema.Invoke, options)(input)
  }).pipe(Effect.mapError((error) => new Tool.Failure({ message: `Invalid ${contract}. ${error.message}` })))
}
