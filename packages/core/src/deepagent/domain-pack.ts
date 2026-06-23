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
  readonly override?: string
  readonly threshold?: number
}
