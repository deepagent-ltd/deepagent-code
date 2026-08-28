export * as DomainPackLoad from "./domain-pack-load"

import { contentDigest } from "../contract/digest"
import type { CapabilityLoadDeniedReason } from "../contract/capability-load"
import {
  loadCapabilityBody,
  type CapabilityLoadGrounds,
  type CapabilityLoadResult,
} from "../system-context/capability-loader"

// C4-06 — `domain_pack_load`: a domain-pack body load that reuses the durable
// capability loader kernel (C4-04). The kernel provides the byte-stable identity,
// the fail-closed body-hash binding (pack body hash MUST equal the declared
// digest), supersession, permission-denied short-circuit, missing-body handling
// and the exact-retry receipt. On top of the kernel this module adds the
// session-scoped active-pack-snapshot-ref cap: at most a bounded number of pack
// snapshot refs may be active per session identity.
//
// The pack/body content source is the domain-pack registry + durable-knowledge
// store (K1 shipped the registry; pack knowledge bodies are seeded into the
// DocumentStore). This module reuses the kernel, never writing a migration body.

/** The five identity grounds of a domain-pack load (mirrors the capability kernel). */
export interface DomainPackLoaderIdentityInput {
  readonly packId: string
  readonly version: string
  readonly bodyHash: string
  readonly runtimeHash: string
  readonly permissionHash: string
}

/**
 * Byte-stable sha256 identity of a domain-pack load: `domain_pack_load:<sha256>`.
 * Canonical over key order and independent of timestamps / absolute paths /
 * randomness, so an identical pack load re-derives the same identity (= exact
 * retry through the kernel). Namespaced apart from capability loads so the two
 * never collide in the shared receipt store.
 */
export const domainPackLoaderIdentity = (
  packId: string,
  version: string,
  bodyHash: string,
  runtimeHash: string,
  permissionHash: string,
): string => `domain_pack_load:${contentDigest({ packId, version, bodyHash, runtimeHash, permissionHash })}`

/** The identity grounds re-derived from a resolved pack entry. */
export const domainPackLoaderIdentityFrom = (input: DomainPackLoaderIdentityInput): string =>
  domainPackLoaderIdentity(input.packId, input.version, input.bodyHash, input.runtimeHash, input.permissionHash)

/** Typed violation: a session would exceed the active pack-snapshot-ref cap. */
export class ActivePackRefsExceededError extends Error {
  readonly _tag = "active_pack_refs_exceeded"
  override readonly name = "ActivePackRefsExceededError"
  readonly sessionIdentity: string
  readonly activeRefs: number
  readonly limit: number
  readonly packSnapshotRef: string

  constructor(input: { readonly sessionIdentity: string; readonly activeRefs: number; readonly limit: number; readonly packSnapshotRef: string }) {
    super(
      `Active pack snapshot refs exceeded for session ${input.sessionIdentity}: ${input.activeRefs + 1}/${input.limit} (ref ${input.packSnapshotRef})`,
    )
    this.sessionIdentity = input.sessionIdentity
    this.activeRefs = input.activeRefs
    this.limit = input.limit
    this.packSnapshotRef = input.packSnapshotRef
  }
}

/** Default cap: at most this many distinct active pack snapshot refs per session. */
export const DEFAULT_MAX_ACTIVE_PACK_REFS = 3

// --- session-scoped active pack snapshot refs (C4-06) ---------------------------
const activePackRefs = new Map<string, Set<string>>()

/** Clear the active pack refs (test isolation / fresh environment). */
export function resetDomainPackLoader(): void {
  activePackRefs.clear()
}

/** Snapshot of the active pack refs for a session (test/observability only). */
export function activePackRefsFor(sessionIdentity: string): ReadonlyArray<string> {
  return [...(activePackRefs.get(sessionIdentity) ?? new Set<string>())]
}

/**
 * Record a pack snapshot ref as active for a session (idempotent). The same ref
 * being re-recorded is a no-op; a NEW ref that would push the session over the
 * active-ref cap throws a typed `active_pack_refs_exceeded`.
 */
export function recordActivePackRef(sessionIdentity: string, packSnapshotRef: string): void {
  let refs = activePackRefs.get(sessionIdentity)
  if (!refs) {
    refs = new Set<string>()
    activePackRefs.set(sessionIdentity, refs)
  }
  if (refs.has(packSnapshotRef)) return
  if (refs.size >= DEFAULT_MAX_ACTIVE_PACK_REFS) {
    throw new ActivePackRefsExceededError({
      sessionIdentity,
      activeRefs: refs.size,
      limit: DEFAULT_MAX_ACTIVE_PACK_REFS,
      packSnapshotRef,
    })
  }
  refs.add(packSnapshotRef)
}

/** Input to a `domain_pack_load`. */
export interface DomainPackLoadInput {
  readonly packId: string
  readonly version: string
  readonly bodyHash: string
  readonly runtimeHash: string
  readonly permissionHash: string
  readonly bodyRef: string
  readonly sessionIdentity: string
  readonly packSnapshotRef: string
  readonly body: string | undefined
  readonly declaredDigest: string | undefined
  readonly supersedingRef?: string
  readonly deniedReason?: CapabilityLoadDeniedReason
}

/**
 * Assert a new pack snapshot ref is admissible under the session cap (idempotent:
 * an already-active ref is always admissible). Throws a typed
 * `active_pack_refs_exceeded` when a NEW ref would exceed the cap. Called before
 * the kernel so a rejected ref never leaves a stray body receipt behind.
 */
export function assertActivePackRefAdmissible(sessionIdentity: string, packSnapshotRef: string): void {
  const refs = activePackRefs.get(sessionIdentity) ?? new Set<string>()
  if (refs.has(packSnapshotRef)) return
  if (refs.size >= DEFAULT_MAX_ACTIVE_PACK_REFS) {
    throw new ActivePackRefsExceededError({
      sessionIdentity,
      activeRefs: refs.size,
      limit: DEFAULT_MAX_ACTIVE_PACK_REFS,
      packSnapshotRef,
    })
  }
}

/**
 * Load a domain-pack body through the kernel (design §7.4-7.5). The abstract
 * capability-loader kernel carries the pack/body hash binding (fail-closed),
 * supersession (pack version bump), permission-denied short-circuit (an entry is
 * never loaded when denied), missing-body handling and the exact-retry receipt.
 * On a successful body load the pack's snapshot ref is recorded as active under
 * the session, subject to the per-session cap (checked before the kernel runs).
 */
export function loadDomainPack(input: DomainPackLoadInput): CapabilityLoadResult {
  const identity = domainPackLoaderIdentity(
    input.packId,
    input.version,
    input.bodyHash,
    input.runtimeHash,
    input.permissionHash,
  )

  assertActivePackRefAdmissible(input.sessionIdentity, input.packSnapshotRef)

  const grounds: CapabilityLoadGrounds = {
    bodyRef: input.bodyRef,
    capabilityId: input.packId,
    version: input.version,
    runtimeHash: input.runtimeHash,
    permissionHash: input.permissionHash,
    supersedingRef: input.supersedingRef,
    deniedReason: input.deniedReason,
  }

  const result = loadCapabilityBody(identity, { body: input.body, declaredDigest: input.declaredDigest }, grounds)

  if (result.state === "available") {
    recordActivePackRef(input.sessionIdentity, input.packSnapshotRef)
  }

  return result
}
