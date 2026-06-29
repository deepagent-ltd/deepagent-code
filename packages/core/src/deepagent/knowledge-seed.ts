import { existsSync, readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { DurableKnowledgeStore, openUserGlobalStore, type KnowledgeDocInput } from "./durable-knowledge-store"
import type { EvidenceStrength } from "./document-store"

// docs/34 S1 / docs/35: scan the built-in pack directories for documents/ seed files and import
// them into the user-global durable DocumentStore as scope=user-global active docs. This replaces
// the old in-code CORE_STRATEGIES / METHODOLOGY_REGISTRY / gpuPack constants — the data now lives
// in packages/domain-packs/*/documents/**/*.json, not in TypeScript source.
//
// Idempotent (seedActive upserts by deterministic ref_id slug), safe to run on every boot.

// Seed document JSON schema (docs/35 §appendix). One file per document, placed under
// packages/domain-packs/<category>/<pack>/documents/<type>/<slug>.json
export type SeedDoc = {
  readonly ref_id: string
  readonly type: "strategy" | "methodology" | "knowledge" | "skill" | "memory"
  readonly description: string // index-facing summary (retrieved as KnowledgeRef)
  readonly body: string // full text, loaded on demand
  readonly domain: string | null
  readonly scope_hint: string // human label, not enforced; kept for authoring context
  readonly evidence_strength: EvidenceStrength
  readonly provenance_tag: string
  readonly pack_id: string
}

export type SeedReport = {
  readonly total: number
  readonly byPack: Readonly<Record<string, number>>
}

// Resolve the built-in pack directory (same candidates as domain-pack-registry.ts).
const builtinPackDir = (): string | null => {
  try {
    return (
      [
        path.resolve(fileURLToPath(import.meta.url), "../..", "domain-packs"),
        path.resolve(fileURLToPath(import.meta.url), "../../../..", "domain-packs"),
        path.resolve(fileURLToPath(import.meta.url), "../../../../../", "domain-packs"),
      ].find((dir) => existsSync(dir)) ?? null
    )
  } catch {
    return null
  }
}

// Recursively find all *.json files under <packDir>/documents/
const findDocuments = (packDir: string): string[] => {
  const docsDir = path.join(packDir, "documents")
  if (!existsSync(docsDir)) return []
  const files: string[] = []
  const scan = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) scan(full)
      else if (entry.name.endsWith(".json")) files.push(full)
    }
  }
  scan(docsDir)
  return files
}

// Scan all pack directories under a base dir for documents/ seed files.
const collectSeedDocs = (baseDir: string): SeedDoc[] => {
  const docs: SeedDoc[] = []
  const scan = (d: string): void => {
    if (!existsSync(d)) return
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const sub = path.join(d, entry.name)
      if (existsSync(path.join(sub, "pack.json"))) {
        // This is a pack root — collect its documents
        for (const file of findDocuments(sub)) {
          try {
            docs.push(JSON.parse(readFileSync(file, "utf8")) as SeedDoc)
          } catch {
            /* skip malformed */
          }
        }
      } else {
        scan(sub) // recurse into category dirs
      }
    }
  }
  scan(baseDir)
  return docs
}

const slugFromRef = (refId: string): string => refId.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")

const docToInput = (doc: SeedDoc): KnowledgeDocInput => ({
  type: doc.type,
  description: doc.description,
  body: doc.body,
  domain: doc.domain,
  tags: [`scope:${doc.scope_hint}`, `provenance:${doc.provenance_tag}`, `pack:${doc.pack_id}`],
  packId: doc.pack_id,
  scope: "user-global",
  sensitivity: "public",
  risk: "low",
  confidence: {
    evidence_strength: doc.evidence_strength,
    support_count: doc.evidence_strength === "strong" ? 3 : 1,
  },
  provenance: { source: "human", run_ref: null, evidence_refs: [] },
  idSlug: slugFromRef(doc.ref_id),
})

// Seed all built-in pack documents into the given store. Returns a count report.
export const seedCoreKnowledge = (store: DurableKnowledgeStore): SeedReport => {
  const packDir = builtinPackDir()
  if (!packDir) return { total: 0, byPack: {} }
  const docs = collectSeedDocs(packDir)
  const byPack: Record<string, number> = {}
  for (const doc of docs) {
    store.seedActive(docToInput(doc))
    byPack[doc.pack_id] = (byPack[doc.pack_id] ?? 0) + 1
  }
  return { total: docs.length, byPack }
}

// Convenience: open the user-global store under baseDir and seed into it.
export const seedCoreKnowledgeAt = (baseDir: string): SeedReport => seedCoreKnowledge(openUserGlobalStore(baseDir))
