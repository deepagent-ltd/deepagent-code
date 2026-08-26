import { Effect, Schema } from "effect"
import type { RuntimeFlags } from "@/effect/runtime-flags"

// LEGACY-EXECUTION-ZERO: the single typed refusal contract that closes legacy execution/writer/owner
// reachability under the internal V2-only profile. Every legacy SessionPrompt execution entry must
// call guardLegacyExecution BEFORE any durable write; layer-build legacy owner registration and
// startup recovery are skipped under the same profile. The refusal is a typed, catchable domain
// error (never a defect), so production compositions map it to a typed HTTP/CLI failure instead of
// a 500 crater, and callers can prove zero legacy reachability by row invariance + exit shape.
export const LegacyZeroReason = Schema.Union([
  Schema.Literal("v2_only_profile"),
  Schema.Literal("v2_stack_unavailable"),
  Schema.Literal("v2_owner_unavailable"),
])
export type LegacyZeroReason = Schema.Schema.Type<typeof LegacyZeroReason>

export class LegacyExecutionUnavailable extends Schema.TaggedErrorClass<LegacyExecutionUnavailable>()(
  "LegacyExecutionUnavailable",
  {
    reason: LegacyZeroReason,
    detail: Schema.String,
    sessionID: Schema.optional(Schema.String),
  },
) {}

export const refuseLegacyExecution = (input: {
  reason: LegacyZeroReason
  detail: string
  sessionID?: string
}) =>
  Effect.fail(
    new LegacyExecutionUnavailable({
      reason: input.reason,
      detail: input.detail,
      ...(input.sessionID ? { sessionID: input.sessionID } : {}),
    }),
  )

// Fail-closed admission firewall: under the V2-only profile NO legacy execution entry may reach
// its admission/orchestration body (which would write session_intent / session_steer /
// session_tool_request_receipt rows or call the provider). Outside the profile this is a no-op,
// so every non-V2-only composition stays byte-identical.
export const guardLegacyExecution = (flags: RuntimeFlags.Info, input: { sessionID?: string }) =>
  flags.coreV2Only
    ? refuseLegacyExecution({
        sessionID: input.sessionID,
        reason: "v2_only_profile",
        detail: "V2-only profile: legacy execution is closed until the V2 execution owner is wired",
      })
    : Effect.void
