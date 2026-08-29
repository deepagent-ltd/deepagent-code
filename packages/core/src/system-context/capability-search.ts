export * as CapabilitySearch from "./capability-search"

import { Effect, Schema } from "effect"
import { Tool } from "../tool/tool"
import {
  CapabilityAvailability,
  CapabilityBodyHash,
  CapabilityBodyRef,
  CapabilityId,
  CapabilityVersionString,
  type CapabilityManifest,
} from "./capability-manifest"
import { capabilityCatalog } from "./capability-catalog"

// C4-03 — capability_search (design §7.3, L1 search card). The tool returns at
// most 5 authorized candidates, ranked by intent, and NEVER returns a procedure
// body. Authorized means every required permission is granted AND every required
// runtime feature is enabled AND the capability is not disabled/maintenance/
// unavailable. Denied/disabled capabilities are therefore excluded entirely, and
// a card carries only summary + entry tools + body_ref — never body content.
// Ordering is deterministic (score desc, then id asc) so the same input always
// yields the same cards. Query and intended_action are treated as identifiers /
// prose only: the search never reads a path, URL or file.

/** L1 search input (design §7.3 `capability_search({query, intended_action})`). */
export const CapabilitySearchInput = Schema.Struct({
  query: Schema.String,
  intended_action: Schema.String.pipe(Schema.optional),
})
export type CapabilitySearchInput = typeof CapabilitySearchInput.Type
export const decodeCapabilitySearchInput = Schema.decodeUnknownSync(CapabilitySearchInput, { onExcessProperty: "error" })

/** L1 search card: a summary + entry points + body ref, never a body. */
export const CapabilitySearchCard = Schema.Struct({
  id: CapabilityId,
  version: CapabilityVersionString,
  summary: Schema.String,
  use_when: Schema.Array(Schema.String),
  availability: CapabilityAvailability,
  entry_tools: Schema.Array(Schema.String),
  body_ref: CapabilityBodyRef,
  body_hash: CapabilityBodyHash.pipe(Schema.optional),
  runtime_compatible: Schema.Boolean,
  authorized: Schema.Boolean,
})
export type CapabilitySearchCard = typeof CapabilitySearchCard.Type

/** Plain renderable view of a search card (brands erased). */
export interface CardView {
  readonly id: string
  readonly version: string
  readonly summary: string
  readonly entry_tools: ReadonlyArray<string>
}

/** L1 search result envelope. */
export const CapabilitySearchOutput = Schema.Struct({
  cards: Schema.Array(CapabilitySearchCard),
  query: Schema.String,
  catalog_snapshot_id: Schema.String,
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type CapabilitySearchOutput = typeof CapabilitySearchOutput.Type

/** Authorization the search filters against (design §7.3 permission/runtime filters). */
export interface SearchAuthorization {
  readonly grantedPermissions: ReadonlySet<string>
  readonly enabledRuntimeFeatures: ReadonlySet<string>
}

/** All permission + feature grants (nothing denied, everything compatible). */
export const fullAuthorization: SearchAuthorization = {
  grantedPermissions: new Set(["read", "glob", "grep", "edit", "bash", "websearch", "webfetch", "skill", "context.read"]),
  enabledRuntimeFeatures: new Set(["context_federation_v2", "context_query_tools_v2"]),
}

/** A capability is an authorized candidate only when permission + runtime + availability all pass. */
export function isAuthorized(
  manifest: CapabilityManifest,
  authorization: SearchAuthorization,
): { readonly authorized: boolean; readonly runtimeCompatible: boolean } {
  for (const permission of manifest.required_permissions) {
    if (!authorization.grantedPermissions.has(permission)) return { authorized: false, runtimeCompatible: false }
  }
  const runtimeCompatible = manifest.required_runtime_features.every((feature) =>
    authorization.enabledRuntimeFeatures.has(feature),
  )
  if (!runtimeCompatible) return { authorized: false, runtimeCompatible: false }
  // Never advertise an unusable capability (design §7.6).
  if (manifest.availability !== "stable") return { authorized: false, runtimeCompatible }
  return { authorized: true, runtimeCompatible }
}

/** An authorization that denies a named permission (so a denied capability is excluded). */
export function denyPermission(authorization: SearchAuthorization, ...permissions: string[]): SearchAuthorization {
  const granted = new Set(authorization.grantedPermissions)
  for (const permission of permissions) granted.delete(permission)
  return { ...authorization, grantedPermissions: granted }
}

/** Rank a manifest against a query + intended action; higher is a better match. */
function relevance(manifest: CapabilityManifest, input: CapabilitySearchInput): number {
  const { query, intended_action } = input
  const haystack = [
    manifest.id,
    manifest.summary,
    ...manifest.use_when,
    ...manifest.entry_tools,
    ...manifest.required_permissions,
    ...manifest.required_runtime_features,
  ].join(" ").toLowerCase()
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0)
  let score = 0
  for (const term of terms) if (haystack.includes(term)) score += 1
  if (intended_action && manifest.entry_tools.includes(intended_action)) score += 3
  if (intended_action && manifest.id === `deepagent.${intended_action.toLowerCase().replace(/_/g, "-")}`) score += 4
  return score
}

/**
 * Search the catalog (design §7.3). Filters to authorized + runtime-compatible
 * candidates, ranks by intent, and returns at most 5 cards in deterministic
 * order (score desc, then id asc). Cards never include a body — a denied or
 * disabled capability is excluded before any result is built, so no body and no
 * unchecked path/URL can leak.
 */
export function capabilitySearch(
  catalog: ReadonlyArray<CapabilityManifest>,
  input: CapabilitySearchInput,
  authorization: SearchAuthorization,
): ReadonlyArray<CapabilitySearchCard> {
  const candidates = catalog
    .map((manifest) => ({ manifest, relevance: relevance(manifest, input) }))
    .filter(({ manifest }) => isAuthorized(manifest, authorization).authorized)
    .toSorted((a, b) => b.relevance - a.relevance || a.manifest.id.localeCompare(b.manifest.id))
    .slice(0, 5)
    .map(({ manifest }) => toCard(manifest, authorization))
  return candidates
}

function toCard(manifest: CapabilityManifest, authorization: SearchAuthorization): CapabilitySearchCard {
  const { runtimeCompatible } = isAuthorized(manifest, authorization)
  return {
    id: manifest.id,
    version: manifest.version,
    summary: manifest.summary,
    use_when: [...manifest.use_when],
    availability: manifest.availability,
    entry_tools: [...manifest.entry_tools],
    body_ref: manifest.body_ref,
    ...(manifest.body_hash ? { body_hash: manifest.body_hash } : {}),
    runtime_compatible: runtimeCompatible,
    authorized: true,
  }
}

/**
 * Render the L1 card set for the model. Only summary + entry tools are shown —
 * the procedure body is never present in a search result (design §7.3). The
 * parameter is the plain renderable shape, so both the decoded (branded) card
 * and the wire-encoded card are accepted.
 */
export function renderSearchCards(cards: ReadonlyArray<CardView>): string {
  if (cards.length === 0) return "No matching DeepAgentCode capabilities for this request."
  return [
    "Matching DeepAgentCode capabilities:",
    ...cards.map(
      (card) =>
        `- ${card.id} (${card.version}) — ${card.summary}. Entry: ${card.entry_tools.join(", ")}.`,
    ),
  ].join("\n")
}

/** Build the search result envelope. */
export function searchOutput(
  catalog: ReadonlyArray<CapabilityManifest>,
  input: CapabilitySearchInput,
  authorization: SearchAuthorization,
  catalogSnapshotId: string,
): CapabilitySearchOutput {
  const cards = capabilitySearch(catalog, input, authorization)
  return {
    cards,
    query: input.query,
    catalog_snapshot_id: catalogSnapshotId,
    count: cards.length,
  }
}

/** A ready-to-register L1 `capability_search` tool definition (wiring is the C4-07 lane). */
export function makeCapabilitySearchTool(input: {
  readonly catalog?: ReadonlyArray<CapabilityManifest>
  readonly catalogSnapshotId?: string
  readonly authorization?: SearchAuthorization
}): Tool.AnyTool {
  const catalog = input.catalog ?? capabilityCatalog
  const snapshotId = input.catalogSnapshotId ?? "capability_catalog:local"
  const authorization = input.authorization ?? fullAuthorization
  return Tool.make({
    description:
      "Search the DeepAgentCode capability catalog. Returns up to 5 authorized capability cards (summary + entry tools) for a query and intended action. Use to discover which DeepAgentCode features you can operate and when. Never used to load a path/URL.",
    input: CapabilitySearchInput,
    output: CapabilitySearchOutput,
    execute: (call) => Effect.succeed(searchOutput(catalog, call, authorization, snapshotId)),
    toModelOutput: ({ output }) => [{ type: "text", text: renderSearchCards(output.cards) }],
  })
}
