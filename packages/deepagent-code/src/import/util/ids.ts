import { Hash } from "@deepagent-code/core/util/hash"

/**
 * Deterministic id derivation for imported entities.
 *
 * All ids are stable functions of the source data so that re-running an
 * import converges on the same deepagent-code ids. This is what makes the
 * writer's "delete aggregate, then replay" strategy safe to re-run: the same
 * source always maps to the same target session/message ids.
 */

const hex = (input: string): string => Hash.sha256(input)

/** deepagent-code SessionID: must start with `ses`. */
export function sessionID(namespace: string, sourceId: string): string {
  return `ses_${hex(`${namespace}:${sourceId}`)}`
}

/** deepagent-code SessionMessage id: must start with `msg_`. */
export function messageID(sourceId: string, turnIndex: number, role: "user" | "assistant"): string {
  return `msg_${hex(`${sourceId}:${turnIndex}:${role}`)}`
}

/** Per-block stable ids (text/reasoning/tool) so events reference them consistently. */
export function blockID(sourceId: string, turnIndex: number, blockIndex: number): string {
  return `blk_${hex(`${sourceId}:${turnIndex}:${blockIndex}`)}`
}

/** Stable event id: `evt_<sha256[:24]>`. replayAll dedupes by event id. */
export function eventID(sourceId: string, seq: number, type: string): string {
  return `evt_${hex(`${sourceId}:${seq}:${type}`).slice(0, 24)}`
}

/** A short slug suitable for session.slug / title fallback. */
export function slugify(input: string, maxLen = 40): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
  return cleaned || "imported"
}
