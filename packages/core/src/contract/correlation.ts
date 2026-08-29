export * as CorrelationContract from "./correlation"

import { Schema } from "effect"
import { contentDigest } from "./digest"

// C0-03 - Correlation chain contract (freeze).
// Design authority: docs/core-v2.0-beta/design.md §14 (unified correlation chain:
// input/event -> session admission -> activity -> selection -> provider attempt
// -> tool effect -> terminal/recovery -> event/outbox -> client cursor).
// Pure-new contract module: not imported by any production module this wave.

/** Version matrix for the correlation contract. */
export const CorrelationVersion = {
  schema: "correlation-chain.v1",
  linkKind: 1,
} as const

/** Bounded link kinds along the single chain (design §14, exact order). */
export const CorrelationLinkKind = Schema.Literals([
  "input",
  "event",
  "session_admission",
  "activity",
  "selection",
  "provider_attempt",
  "tool_effect",
  "terminal_recovery",
  "event_outbox",
  "client_cursor",
])
export type CorrelationLinkKind = typeof CorrelationLinkKind.Type

/** One hop of the chain: every hop carries its id and its causal parent ref. */
export const CorrelationLink = Schema.Struct({
  kind: CorrelationLinkKind,
  /** Stable id of the hop (inputId / eventId / sessionId / activityId / ... ). */
  id: Schema.String,
  /** Optional upstream hop id that caused this hop (causal edge). */
  causedBy: Schema.String.pipe(Schema.optional),
  /** Monotonic hop order within the chain (0-based per chain root). */
  hop: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type CorrelationLink = typeof CorrelationLink.Type

/**
 * The frozen correlation chain for one unit of work. The chain is bounded
 * (at most one link per kind — a kind cannot repeat), ordered by hop, and
 * ends at a client cursor or a terminal recovery. Ids are opaque strings; the
 * chain must never carry payloads (no messages, no raw bodies) — correlation
 * is identity, not content.
 */
export const CorrelationChain = Schema.Struct({
  schemaVersion: Schema.Literal(CorrelationVersion.schema),
  correlationId: Schema.String,
  root: CorrelationLinkKind,
  links: Schema.Array(CorrelationLink),
  cursor: Schema.String.pipe(Schema.optional),
})
export type CorrelationChain = typeof CorrelationChain.Type

/** Typed decode failure for a malformed chain. */
export class CorrelationDecodeError extends Schema.TaggedErrorClass<CorrelationDecodeError>()(
  "error",
  { path: Schema.String, summary: Schema.String },
) {}

export function decodeCorrelationChain(input: unknown): CorrelationChain {
  try {
    const chain = Schema.decodeUnknownSync(CorrelationChain)(input, { onExcessProperty: "error" })
    const seen = new Set<string>()
    for (const link of chain.links) {
      if (seen.has(link.kind)) {
        throw new Error('duplicate link kind at ["links"]')
      }
      seen.add(link.kind)
      if (link.hop !== chain.links.indexOf(link)) {
        throw new Error('non-monotonic hop at ["links"]')
      }
    }
    return chain
  } catch (error) {
    const e = error as { path?: unknown; message?: string }
    const path = Array.isArray(e.path) ? JSON.stringify(e.path) : typeof e.path === "string" ? e.path : ""
    throw new CorrelationDecodeError({ path, summary: typeof e.message === "string" ? e.message : "decode failed" })
  }
}

export function encodeCorrelationChain(chain: CorrelationChain): string {
  return JSON.stringify(Schema.decodeUnknownSync(CorrelationChain)(chain))
}

/** Byte-stable digest (identity only; volatile keys stripped). */
export function correlationChainDigest(chain: CorrelationChain): string {
  return contentDigest(chain)
}

export function correlationLinkDigest(link: CorrelationLink): string {
  return contentDigest(link)
}
