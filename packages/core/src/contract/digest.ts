export * as ContractDigest from "./digest"

import { createHash } from "crypto"
import { CanonicalJson } from "../util/canonical-json"

// Content-digest support for C0-02 frozen contracts.
//
// A contract's `digest()` is a byte-stable canonical SHA-256 over the *stable*
// identity of a value. It is:
//   - canonical over key order (nested object keys are sorted), so two
//     JSON-equivalent shapes (even with different key insertion order) hash to
//     the same digest;
//   - independent of machine-local state: wall-clock timestamps and absolute
//     paths are stripped recursively before hashing, so the digest changes only
//     when the *content* of an envelope changes, never when it is re-recorded,
//     re-dispatched, or replayed on another host.
//
// This mirrors the existing `src/util/canonical-json.ts` canonicalization used
// by the durable-learning and released-snapshot modules, and keeps the digest of
// a frozen contract aligned with the deterministic-manifest gate (C0-05).

const VOLATILE_KEYS = new Set([
  "time",
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
  "observedAt",
  "recordedAt",
  "validUntil",
  "expiresAt",
  "leaseUntil",
  "leaseExpiresAt",
  "absolutePath",
  "workspacePath",
])

function stripVolatile(input: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(input)) return input.map((item) => stripVolatile(item, seen))
  if (input !== null && typeof input === "object" && !(input instanceof Date)) {
    if (seen.has(input)) throw new TypeError("Contract digest cannot encode cyclic values")
    seen.add(input)
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(input)) {
      if (VOLATILE_KEYS.has(key)) continue
      out[key] = stripVolatile((input as Record<string, unknown>)[key], seen)
    }
    seen.delete(input)
    return out
  }
  return input
}

/**
 * Produce a byte-stable canonical content digest for a contract value.
 *
 * The input is first stripped of volatile fields (wall-clock timestamps and
 * absolute paths), then canonicalized with sorted object keys and hashed with
 * SHA-256. Two JSON-equivalent values that differ only in key order therefore
 * produce the same digest, and re-hashing the same value is deterministic.
 */
export function contentDigest(input: unknown): string {
  return createHash("sha256").update(CanonicalJson.stringify(stripVolatile(input, new WeakSet()))).digest("hex")
}
