export * as SessionRecoverySafeBoundary from "./recovery-safe-boundary"

// C1B-07 — safe-boundary finder for the `fork_only` descriptor.
//
// A safe boundary is the last session-history message whose effects are CERTAIN
// — a user prompt (durably admitted) or a confirmed assistant checkpoint (the
// provider turn reached a terminal state and every tool it offered reached a
// terminal `completed`/`error` state). An unknown-result assistant/tool turn is
// NEVER a safe boundary and never gets copied into the fork: before the first
// indeterminate turn the effects of the session are provable, at/after it they
// are not, so a fork can only reconstruct history through that boundary and the
// original session is fenced read-only (design §9.1 `fork_only`, §9.3).
//
// The finder operates on a normalized, decoupled view of the session history
// (`SafeBoundaryMessage`) so it stays pure and deterministic and does not depend
// on the heavy DB message schema. The production caller maps a real
// `Session.Message.Message[]` into this view:
//   user          -> certain=true, checkpoint=true   (durable admitted prompt)
//   assistant     -> certain = (time.completed set AND all content tool states
//                    are terminal AND no `error`) — a confirmed assistant
//                    checkpoint (checkpoint = certain)
//   tool          -> certain = (result known / tool state terminal), checkpoint=false
//   shell         -> certain = (shell command completed), checkpoint=false
//   system        -> certain=true, checkpoint=false  (recorded, certain)
//   synthetic     -> certain=true, checkpoint=false
//   compaction    -> certain=true, checkpoint=false
// An indeterminate turn is `certain=false` (e.g. an assistant message still
// in-flight, or a tool/shell turn whose result is unknown after a crash).

import { contentDigest } from "../../contract/digest"

const SCHEMA_VERSION = "recovery-safe-boundary.v1"

/** A session-history message as the safe-boundary finder needs to see it. */
export type SafeBoundaryMessage = {
  readonly id: string
  readonly seq: number
  readonly kind: "user" | "assistant" | "tool" | "system" | "synthetic" | "shell" | "compaction"
  /**
   * Whether this turn's effects are CERTAIN. `false` marks an unknown-result
   * assistant/tool turn (the turn was in-flight / its tool result is unknown),
   * which can never be a boundary and truncates the fork window.
   */
  readonly certain: boolean
  /**
   * Whether this message is a valid fork boundary: a user prompt (durably
   * admitted) or a confirmed assistant checkpoint. Internal system / synthetic /
   * compaction / tool / shell messages are certain but are not checkpoints;
   * they are copied when they precede the boundary but never become the boundary.
   */
  readonly checkpoint: boolean
}

/** A safe-boundary finder result: found, or provably absent (safe_boundary_none). */
export type SafeBoundary =
  | {
      readonly status: "found"
      readonly schemaVersion: typeof SCHEMA_VERSION
      readonly boundaryMessageId: string
      readonly boundaryIndex: number
      readonly confirmedThrough: SafeBoundaryMessage
      /** The messages copied through the boundary (index 0..boundaryIndex, inclusive). */
      readonly copiedMessages: readonly SafeBoundaryMessage[]
      /** Deterministic content digest over the copied window (id/seq/kind only). */
      readonly hashedWindow: string
      readonly firstIndeterminateIndex: number | undefined
      /** The indeterminate turns excluded from the fork (ids + reason). */
      readonly excludedTurns: readonly { readonly id: string; readonly kind: SafeBoundaryMessage["kind"]; readonly reason: string }[]
    }
  | { readonly status: "none"; readonly schemaVersion: typeof SCHEMA_VERSION; readonly reason: "safe_boundary_none" }

/** Why an indeterminate turn is excluded from the fork. */
function excludedReason(kind: SafeBoundaryMessage["kind"]): string {
  if (kind === "assistant") return "indeterminate_assistant_turn"
  if (kind === "tool") return "indeterminate_tool_result"
  if (kind === "shell") return "indeterminate_shell_result"
  return "indeterminate_turn"
}

/**
 * Find the safe boundary in a session history.
 *
 * Rules (design §9.1, C1B-07):
 *   1. An unknown-result assistant/tool turn (`certain === false`) is NEVER a safe
 *      boundary and its effects are never copied — it marks the FIRST indeterminate
 *      turn and truncates the fork window.
 *   2. The boundary must be BEFORE the first indeterminate turn. The boundary is the
 *      LAST checkpoint (user / confirmed assistant) that precedes it.
 *   3. When no indeterminate turn exists, the boundary is the LAST checkpoint.
 *   4. When no checkpoint precedes the first indeterminate turn (or the history is
 *      empty), there is provably no safe boundary -> `status: "none"`.
 *
 * Pure and deterministic: the same history always yields the same boundary.
 */
export function findSafeBoundary(history: readonly SafeBoundaryMessage[]): SafeBoundary {
  let boundary: { index: number; message: SafeBoundaryMessage } | undefined
  let firstIndeterminateIndex: number | undefined
  const excludedTurns: { id: string; kind: SafeBoundaryMessage["kind"]; reason: string }[] = []
  for (let i = 0; i < history.length; i++) {
    const message = history[i]!
    if (!message.certain) {
      // An unknown-result assistant/tool turn: it is a fork limit and is always excluded.
      if (firstIndeterminateIndex === undefined) firstIndeterminateIndex = i
      excludedTurns.push({ id: message.id, kind: message.kind, reason: excludedReason(message.kind) })
      // Once the first indeterminate turn is hit, later checkpoints are NOT provable (the turn
      // chain is broken), so the boundary stops advancing — but we keep scanning to record every
      // excluded indeterminate turn.
      continue
    }
    if (firstIndeterminateIndex === undefined && message.checkpoint) boundary = { index: i, message }
  }
  if (boundary === undefined) {
    return { status: "none", schemaVersion: SCHEMA_VERSION, reason: "safe_boundary_none" }
  }
  const copiedMessages = history.slice(0, boundary.index + 1)
  const hashedWindow = contentDigest(copiedMessages.map((message) => ({ id: message.id, seq: message.seq, kind: message.kind })))
  return {
    status: "found",
    schemaVersion: SCHEMA_VERSION,
    boundaryMessageId: boundary.message.id,
    boundaryIndex: boundary.index,
    confirmedThrough: boundary.message,
    copiedMessages,
    hashedWindow,
    firstIndeterminateIndex,
    excludedTurns,
  }
}
