export * as PackSearchTool from "./pack-search-tool"

import { Effect, Layer, Schema } from "effect"
import { ToolFailure } from "@deepagent-code/llm"
import type { Doc } from "../deepagent/document-store"
import { Tool } from "../tool/tool"
import { Tools } from "../tool/tools"
import {
  listActivePackDocs,
  packDocName,
  productionStoreResolver,
  type StoreResolver,
} from "./domain-pack-docs"

// P2-a (WS3 chain repair, docs/V2.0.1-001-llm-agent-system-manual.md §4.5): the L1 search surface
// for the domain-pack manual. This is a SIBLING of `capability_search`, not an extension of it:
// capability-search.ts is frozen (K1) and its card schema is capability-only (branded
// `deepagent.*` ids, `capability://` body refs, entry tools, runtime features), so pack documents
// would have to be faked into synthetic manifests — corrupting the catalog digest/snapshot id and
// the inventory<->registry build gates. `pack_search` instead queries the seeded durable store
// directly and returns up to 5 document cards (pack, name, type, one-line summary, opaque ref),
// each pointing the model at `domain_pack_load` for the body. Cards never include a body, and the
// rendered result is hard-bounded to ~200 tokens (design §4.6).

export const name = "pack_search"

/** Result bounds (design §4.6): at most 5 cards, rendered text <= ~200 tokens. */
export const PackSearchBudget = {
  maxEntries: 5,
  // Token.estimate uses 4 chars/token, so 800 chars renders at ~200 tokens.
  renderMaxChars: 800,
} as const

/** L1 pack search input: free-text terms, optionally narrowed to one pack. */
export const PackSearchInput = Schema.Struct({
  query: Schema.String,
  pack: Schema.String.pipe(Schema.optional),
})
export type PackSearchInput = typeof PackSearchInput.Type

/** One L1 pack card: identity + summary + the opaque ref for `domain_pack_load` — never a body. */
export const PackSearchEntry = Schema.Struct({
  ref: Schema.String,
  pack: Schema.String,
  name: Schema.String,
  type: Schema.String,
  summary: Schema.String,
})
export type PackSearchEntry = typeof PackSearchEntry.Type

export const PackSearchOutput = Schema.Struct({
  entries: Schema.Array(PackSearchEntry),
  query: Schema.String,
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type PackSearchOutput = typeof PackSearchOutput.Type

export interface PackSearchToolOptions {
  /** Store seam; the default resolves the gateway-configured user-global durable store. */
  readonly store?: StoreResolver
}

/** Rank one pack document against the query terms; higher is a better match, 0 is no match. */
function relevance(entry: { doc: Doc; pack: string }, terms: ReadonlyArray<string>): number {
  const haystack = [entry.pack, entry.doc.domain ?? "", packDocName(entry.doc), entry.doc.description, ...entry.doc.tags]
    .join(" ")
    .toLowerCase()
  let score = 0
  for (const term of terms) if (haystack.includes(term)) score += 1
  return score
}

/** A ready-to-register L1 `pack_search` tool (permission `capability.read`, like the load family). */
export function makePackSearchTool(options: PackSearchToolOptions = {}): Tool.AnyTool {
  const resolveStore = options.store ?? productionStoreResolver
  return Tool.withPermission(
    Tool.make({
      description:
        "Search the built-in domain pack manual (curated strategy, methodology, knowledge and skill documents). Returns up to 5 cards (pack, name, one-line summary, ref) for a query. Load a card's body with domain_pack_load. Never used to load a path/URL.",
      input: PackSearchInput,
      output: PackSearchOutput,
      execute: (call) =>
        Effect.gen(function* () {
          const store = yield* Effect.try({
            try: () => resolveStore(),
            catch: (error) =>
              new ToolFailure({
                message: `Domain pack store is unavailable: ${error instanceof Error ? error.message : String(error)}`,
              }),
          })
          if (!store) return { entries: [], query: call.query, count: 0 }
          const docs = yield* Effect.try({
            try: () => listActivePackDocs(store),
            catch: (error) =>
              new ToolFailure({
                message: `Domain pack search failed: ${error instanceof Error ? error.message : String(error)}`,
              }),
          })
          const terms = call.query.toLowerCase().split(/\s+/).filter((term) => term.length > 0)
          const entries = docs
            .filter((entry) => call.pack === undefined || entry.pack === call.pack)
            .map((entry) => ({ entry, score: relevance(entry, terms) }))
            .filter(({ score }) => score > 0)
            .toSorted((a, b) => b.score - a.score || a.entry.doc.id.localeCompare(b.entry.doc.id))
            .slice(0, PackSearchBudget.maxEntries)
            .map(({ entry }) => ({
              ref: entry.doc.id,
              pack: entry.pack,
              name: packDocName(entry.doc),
              type: entry.doc.type,
              summary: entry.doc.description,
            }))
          return { entries, query: call.query, count: entries.length }
        }),
      toModelOutput: ({ output }) => [{ type: "text", text: renderPackSearchCards(output) }],
    }),
    "capability.read",
  )
}

/** Render the L1 card set for the model; every card names `domain_pack_load` as the body path. */
export function renderPackSearchCards(output: PackSearchOutput): string {
  if (output.entries.length === 0) return "No matching domain pack documents for this request."
  const text = [
    `Domain pack documents matching "${output.query}":`,
    ...output.entries.map(
      (entry) =>
        `- [${entry.pack}] ${entry.name} (${entry.type}) — ${entry.summary} Load: domain_pack_load({ ref: "${entry.ref}" }).`,
    ),
  ].join("\n")
  if (text.length <= PackSearchBudget.renderMaxChars) return text
  return `${text.slice(0, PackSearchBudget.renderMaxChars)}\n... (truncated, ${text.length} chars total)`
}

/** Production registration (design §4.5): register `pack_search` into the Location tool registry. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    yield* tools.register({ [name]: makePackSearchTool() }).pipe(Effect.orDie)
  }),
)
