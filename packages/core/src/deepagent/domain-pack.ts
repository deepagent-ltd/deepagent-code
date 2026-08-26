// docs/34 / docs/35 V3.2.1 decision-B migration: all runtime code (gpuPack, REGISTRY,
// activate, domainKnowledge, registeredDomains) deleted. Knowledge lives in
// packages/domain-packs/*/documents/ and is seeded into DocumentStore (knowledge-seed.ts).
// Pack discovery/scoring/activation → domain-pack-registry.ts.
// Only the two types still referenced by RetrievalInput are kept here.

export type ProblemProfile = {
  readonly language?: string
  readonly framework?: string
  readonly domain?: string | null
  readonly backend?: string
  readonly signals?: readonly string[]
}

export type ActivateOptions = {
  // FEAT-001: `override` is the legacy single-pack pin; `overrides` carries multi-pin (GUI pinned
  // packs). Both are honored — single-value callers keep working unchanged.
  readonly override?: string
  readonly overrides?: readonly string[]
  readonly threshold?: number
}

// Merge single + multi pin forms into one deduplicated list (FEAT-001 override type evolution).
export const overridePackIds = (options?: ActivateOptions): readonly string[] => [
  ...new Set([...(options?.override ? [options.override] : []), ...(options?.overrides ?? [])]),
]
