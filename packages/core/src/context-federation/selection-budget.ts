export * as SelectionBudget from "./selection-budget"

import { Hash } from "../util/hash"
import { CanonicalJson } from "../util/canonical-json"
import { Token } from "../util/token"
import { type GraphKind } from "../contract/selection"
import { GraphOrder, type QueryResultV2 } from "./resolver-v2"
import { type QueryEnvelope } from "./resolver-v2"
import { canonicalContextRef } from "./reference"
import { type ContextCandidate } from "./federation"

/**
 * C3-04 — deterministic ordering + token / ref / artifact hard budgets + truncation evidence.
 *
 * The resolver (F1) already produces the four explicit graph statuses and a candidate list sorted by
 * canonical ContextRef. This stage turns that into a *ranked, budgeted* candidate batch that C3-05
 * consumes to build the frozen `SelectionEnvelope`.
 *
 * Ordering rule (documented, deterministic, byte-stable):
 *   1. PRIMARY  — value tier (lower = higher value). A few high-value refs therefore always sort before
 *      a large run of low-value refs, so a big result can never starve a small high-value set.
 *   2. SECONDARY — canonical key: graph order (GraphOrder) → ref revision → ref id byte-order →
 *      canonical ContextRef (stable binding/locator tiebreak).
 *
 * Budgets (all hard): `limit`/`refBudget` cap the ref count, `tokenBudget` caps the encoded token
 * estimate, and `artifactMaxItemBytes` / `artifactMaxTotalBytes` cap the per-item and total artifact
 * byte size. Every cap drops from the END of the ranked list (lowest value first), so the surviving
 * set is always the highest-value prefix.
 */

/** Bounded budget the ordering stage enforces. Undefined => no cap on that dimension. */
export type SelectionBudget = {
  readonly limit?: number
  readonly refBudget?: number
  readonly tokenBudget?: number
  readonly artifactMaxItemBytes?: number
  readonly artifactMaxTotalBytes?: number
}

/** A candidate after deterministic ranking, with its budget evidence. */
export type RankedCandidate = {
  readonly candidate: ContextCandidate
  /** 0 = highest value, ascending. Derived deterministically from candidate features/trust. */
  readonly valueTier: number
  /** Canonical, byte-ordered sort key (graph index → revision → entity id → canonical ref). */
  readonly orderingKey: string
  /** Deterministic composite score in [0,1] used for value-tier derivation and evidence. */
  readonly score: number
  /** Deterministic encoded-token estimate (`Token.estimate` over the canonical ref). */
  readonly encodedTokens: number
  /** Deterministic UTF-8 byte size of the canonical ref (artifact item size estimate). */
  readonly artifactItemBytes: number
}

/** The output of the deterministic ordering + budget stage. Immutable, byte-stable. */
export type SelectionCandidateBatch = {
  /** All ranked candidates, best-first, pre-truncation. */
  readonly ordered: readonly RankedCandidate[]
  /** The survivors after every hard budget was enforced. Best-first. */
  readonly selected: readonly RankedCandidate[]
  readonly totalCandidates: number
  readonly truncated: boolean
  readonly truncatedCount: number
  readonly tokenCount: number
  readonly refCount: number
  readonly artifactBytes: number
  readonly budget: SelectionBudget
  /** The documented ordering/tiering rule identifier (stable across runs). */
  readonly ordering: { readonly primary: "value_tier"; readonly secondary: "graph_revision_refid_byte_order" }
}

/** The ordering rule version; bump on an intentional ordering change (drift detectable). */
export const OrderingVersion = "selection-budget.v1"

/**
 * Apply the deterministic ordering + budget stage to a resolver result. Pure: no clock, no random, no
 * absolute path, so identical inputs produce an identical serialized `SelectionCandidateBatch`.
 *
 * `extraBudget` carries the artifact byte caps (per-item + total) which the QueryEnvelope does not
 * expose; it also overrides the envelope-derived count/token budgets when provided.
 */
export function budgetSelection(
  result: QueryResultV2,
  envelope: QueryEnvelope,
  extraBudget: Partial<SelectionBudget> = {},
): SelectionCandidateBatch {
  const budget: SelectionBudget = {
    ...(envelope.limit !== undefined ? { limit: normalize(envelope.limit) } : {}),
    ...(envelope.refBudget !== undefined ? { refBudget: normalize(envelope.refBudget) } : {}),
    ...(envelope.tokenBudget !== undefined ? { tokenBudget: normalize(envelope.tokenBudget) } : {}),
    ...(extraBudget.artifactMaxItemBytes !== undefined ? { artifactMaxItemBytes: normalize(extraBudget.artifactMaxItemBytes) } : {}),
    ...(extraBudget.artifactMaxTotalBytes !== undefined ? { artifactMaxTotalBytes: normalize(extraBudget.artifactMaxTotalBytes) } : {}),
  }
  const ordered = result.candidates.map(rank)
  ordered.sort(compareRanked)
  let working: readonly RankedCandidate[] = ordered
  if (budget.artifactMaxItemBytes !== undefined) {
    working = working.filter((item) => item.artifactItemBytes <= budget.artifactMaxItemBytes!)
  }
  const refsCap = capOf([budget.limit, budget.refBudget])
  if (refsCap !== undefined) working = capCount(working, refsCap)
  if (budget.tokenBudget !== undefined) working = capTokens(working, budget.tokenBudget)
  if (budget.artifactMaxTotalBytes !== undefined) working = capBytes(working, budget.artifactMaxTotalBytes)
  const selected = working
  return {
    ordered,
    selected,
    totalCandidates: ordered.length,
    truncated: selected.length < ordered.length,
    truncatedCount: ordered.length - selected.length,
    tokenCount: sum(selected, (item) => item.encodedTokens),
    refCount: selected.length,
    artifactBytes: sum(selected, (item) => item.artifactItemBytes),
    budget,
    ordering: { primary: "value_tier", secondary: "graph_revision_refid_byte_order" },
  }
}

/**
 * Build the byte-stable canonical ordering key for one candidate. Embedded into
 * `RankedCandidate.orderingKey` and used by the drift oracle: a ref-order or budget change changes the
 * selected key bytes.
 */
export function orderingKeyOf(candidate: RankedCandidate): string {
  return CanonicalJson.stringify({
    ordering: OrderingVersion,
    tier: candidate.valueTier,
    graph: candidate.candidate.ref.graph,
    revision: candidate.candidate.ref.revision,
    entityId: candidate.candidate.ref.entityId,
    ref: canonicalContextRef(candidate.candidate.ref),
  })
}

// ---------------------------------------------------------------------------
// ranking
// ---------------------------------------------------------------------------

function rank(candidate: ContextCandidate): RankedCandidate {
  const score = compositeScore(candidate)
  const valueTier = tierOf(candidate, score)
  const refString = canonicalContextRef(candidate.ref)
  const orderingKey = CanonicalJson.stringify({
    graphOrderIndex: graphIndex(candidate.ref.graph),
    revision: candidate.ref.revision,
    entityId: candidate.ref.entityId,
    ref: refString,
  })
  return {
    candidate,
    valueTier,
    orderingKey,
    score,
    encodedTokens: Token.estimate(refString),
    artifactItemBytes: Buffer.byteLength(refString, "utf8"),
  }
}

/**
 * Deterministic composite score in [0,1]. Uses only stable candidate fields (features, trust,
 * visibility) and never a wall-clock/absolute-path/random source. Does not attempt to replicate the
 * production ranker; it is a stable, documented tiering score for the budget stage.
 */
function compositeScore(candidate: ContextCandidate): number {
  const f = candidate.features
  const weighted = f.exact * 0.45 + f.authority * 0.25 + f.evidence * 0.2 + f.freshness * 0.1
  const governed = candidate.trust === "governed_guidance" ? 0.1 : 0
  return clamp01(weighted + governed)
}

/**
 * Value tier, ascending (0 = highest value). A candidate that is an exact reference, or is
 * governed/authoritative/well-evidenced, lands in a higher tier than a plain lexical match, so a
 * handful of high-value refs always rank above a large run of low-value ones.
 */
function tierOf(candidate: ContextCandidate, score: number): number {
  const f = candidate.features
  if (f.exact >= 0.75 || candidate.trust === "governed_guidance") return 0
  if (f.authority >= 0.6 || f.evidence >= 0.6 || score >= 0.5) return 1
  return 2
}

// ---------------------------------------------------------------------------
// deterministic ordering (value tier primary, canonical key secondary)
// ---------------------------------------------------------------------------

function compareRanked(a: RankedCandidate, b: RankedCandidate): number {
  if (a.valueTier !== b.valueTier) return a.valueTier - b.valueTier
  const g = graphIndex(a.candidate.ref.graph) - graphIndex(b.candidate.ref.graph)
  if (g !== 0) return g
  const rev = compareBytes(a.candidate.ref.revision, b.candidate.ref.revision)
  if (rev !== 0) return rev
  const id = compareBytes(a.candidate.ref.entityId, b.candidate.ref.entityId)
  if (id !== 0) return id
  return compareBytes(canonicalContextRef(a.candidate.ref), canonicalContextRef(b.candidate.ref))
}

function compareBytes(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function graphIndex(graph: GraphKind): number {
  const index = GraphOrder.indexOf(graph)
  return index === -1 ? GraphOrder.length : index
}

// ---------------------------------------------------------------------------
// budget enforcement (drop from the end, lowest value first)
// ---------------------------------------------------------------------------

function capCount(list: readonly RankedCandidate[], cap: number): readonly RankedCandidate[] {
  return list.slice(0, Math.max(0, cap))
}

function capTokens(list: readonly RankedCandidate[], budget: number): readonly RankedCandidate[] {
  let running = 0
  let cutoff = list.length
  for (let i = 0; i < list.length; i++) {
    running += list[i]!.encodedTokens
    if (running > budget) {
      cutoff = i
      break
    }
  }
  return list.slice(0, cutoff)
}

function capBytes(list: readonly RankedCandidate[], cap: number): readonly RankedCandidate[] {
  let running = 0
  let cutoff = list.length
  for (let i = 0; i < list.length; i++) {
    running += list[i]!.artifactItemBytes
    if (running > cap) {
      cutoff = i
      break
    }
  }
  return list.slice(0, cutoff)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function capOf(values: readonly (number | undefined)[]): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined && Number.isFinite(value))
  return defined.length === 0 ? undefined : Math.min(...defined)
}

function normalize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`invalid budget bound ${value}`)
  return value
}

function sum(list: readonly RankedCandidate[], pick: (item: RankedCandidate) => number): number {
  return list.reduce((total, item) => total + pick(item), 0)
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** Byte-stable canonical digest of a batch (used by the drift oracle). */
export function batchDigest(batch: SelectionCandidateBatch): string {
  return Hash.sha256(
    CanonicalJson.stringify({
      ordering: OrderingVersion,
      selected: batch.selected.map((item) => orderingKeyOf(item)),
      refCount: batch.refCount,
      tokenCount: batch.tokenCount,
      artifactBytes: batch.artifactBytes,
      truncated: batch.truncated,
      truncatedCount: batch.truncatedCount,
    }),
  )
}
