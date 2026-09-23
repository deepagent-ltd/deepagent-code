export * as DomainPackDocs from "./domain-pack-docs"

import { DurableKnowledgeStore } from "../deepagent/durable-knowledge-store"
import type { Doc } from "../deepagent/document-store"
import { isConfigured, userGlobalStoreFor } from "../deepagent/knowledge-source"

// P2-a (WS3 chain repair, docs/V2.0.1-001-llm-agent-system-manual.md §4.5): the read side shared by
// the `pack_search` / `domain_pack_load` tools. The 136 built-in domain packs under
// packages/domain-packs/ are seeded `active` into the USER-GLOBAL durable store at boot
// (knowledge-seed.ts -> seedActive), so this module resolves that store through the single
// configured read adapter (knowledge-source.ts — the gateway configures it with the injected
// storage base; tests inject a real tmp-root store through the resolver seam). A doc belongs to a
// domain pack when it carries a pack id (extensions.pack_id or a "pack:" tag), mirroring
// isSeededPackDoc in knowledge-source.ts.

/** Lazily resolves the durable store the tools read; null means the knowledge base is unavailable. */
export type StoreResolver = () => DurableKnowledgeStore | null

/** Production resolver: the gateway-configured user-global store (guarded like the retriever callers). */
export const productionStoreResolver: StoreResolver = () => (isConfigured() ? userGlobalStoreFor() : null)

/** The pack a doc belongs to, or null when it is not a domain-pack document. */
export const packIdOf = (doc: Doc): string | null => {
  if (typeof doc.extensions?.pack_id === "string" && doc.extensions.pack_id.length > 0)
    return doc.extensions.pack_id
  return doc.tags.find((tag) => tag.startsWith("pack:"))?.slice("pack:".length) ?? null
}

/** Active domain-pack documents in the store, each paired with its pack id. */
export const listActivePackDocs = (store: DurableKnowledgeStore): ReadonlyArray<{ doc: Doc; pack: string }> =>
  store.listByStatus("active").flatMap((ref) => {
    const doc = store.documentStore.get(ref.id, ref.version)
    if (!doc) return []
    const pack = packIdOf(doc)
    return pack === null ? [] : [{ doc, pack }]
  })

/** Look up one domain-pack document by its durable doc ref (any status); null when the ref is not a pack doc. */
export const findPackDoc = (store: DurableKnowledgeStore, ref: string): { doc: Doc; pack: string } | null => {
  const doc = store.documentStore.get(ref)
  if (!doc) return null
  const pack = packIdOf(doc)
  return pack === null ? null : { doc, pack }
}

/** The document name the model cites: the slug segment of the durable doc id. */
export const packDocName = (doc: Doc): string => doc.id.slice(doc.id.lastIndexOf(":") + 1)
