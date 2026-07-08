import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  type DurableKnowledgeStore,
  openProjectStore,
  openUserGlobalStore,
} from "@deepagent-code/core/deepagent/durable-knowledge-store"
import * as KnowledgeSource from "@deepagent-code/core/deepagent/knowledge-source"
import { classifyReview, DEFAULT_CONFIG } from "@deepagent-code/core/deepagent/auto-reviewer"
import { looksSensitive } from "@deepagent-code/core/deepagent/memory-governance"
import type { Doc } from "@deepagent-code/core/deepagent/document-store"
import type { MemoryItem } from "../ir"
import type { MemoryImportResult } from "../types"
import { looksLikeSecret } from "../util/secrets"

/**
 * Stage imported memories as knowledge *candidates*, then run the auto-review
 * pass that approves everything safe and leaves only the genuinely risky /
 * conflicting ones pending (so the Review icon's blue dot is meaningful).
 *
 * Staging: each memory → a `type:"memory"` doc with status `"candidate"` in the
 * DurableKnowledgeStore. `idSlug` makes it idempotent (re-imports reinforce
 * confidence instead of duplicating).
 *
 * Auto-review ("能批就批"): reuses the system's own review rules —
 * `classifyReview` (blocks strategy/methodology/pii/secret/high-risk) +
 * `looksSensitive` + secret scanning. Safe memories are promoted to `active`
 * immediately; sensitive / secret / empty / blocked ones stay `candidate` and
 * surface as the Review queue (blue dot).
 */

export function stageAndReviewMemories(memories: MemoryItem[], baseDir: string): MemoryImportResult {
  const stores: DurableKnowledgeStore[] = []
  const seenStoreKey = new Set<string>()
  let staged = 0

  for (const item of memories) {
    const store = item.cwd ? openProjectStore(baseDir, item.cwd) : openUserGlobalStore(baseDir)
    // Dedup store instances so the review pass walks each store once even when
    // many memories share the same root (cwd or user-global).
    const storeKey = item.cwd ?? "__global__"
    if (!seenStoreKey.has(storeKey)) {
      seenStoreKey.add(storeKey)
      stores.push(store)
    }
    store.stageCandidate({
      type: "memory",
      description: item.description || item.title,
      body: item.body,
      domain: null,
      scope: item.cwd ? "project-shared" : "user-global",
      sensitivity: "public",
      risk: "low",
      confidence: { evidence_strength: "weak", support_count: 1 },
      provenance: { source: "human", run_ref: `import:${item.source}:${item.slug}` },
      tags: ["imported", `source:${item.source}`],
      idSlug: `${item.source}-${item.slug}`.slice(0, 64),
    })
    staged += 1
  }

  const { approved, pending } = autoReviewMemories(stores)
  invalidateKnowledgeCache()
  return { staged, writtenToInstructions: false, approved, pending }
}

/**
 * Review the just-stored candidate memories and promote the safe ones to
 * `active`. Returns counts; `pending` is what remains in the Review queue.
 */
export function autoReviewMemories(stores: readonly DurableKnowledgeStore[]): { approved: number; pending: number } {
  let approved = 0
  let pending = 0
  const seen = new Set<string>()
  for (const store of stores) {
    for (const ref of store.listByStatus("candidate")) {
      if (ref.type !== "memory") continue
      if (seen.has(ref.id)) continue
      seen.add(ref.id)
      const doc = store.documentStore.get(ref.id)
      if (!doc) continue
      if (shouldAutoApprove(doc)) {
        store.approve(ref.id)
        approved += 1
      } else {
        pending += 1
      }
    }
  }
  return { approved, pending }
}

/**
 * Decision: approve unless there's a concrete reason to leave it for human
 * review. Mirrors the spirit of `classifyReview` but is permissive for imported
 * (user-sourced) memories — global scope does NOT block auto-approve the way it
 * does for live learning, because the user explicitly imported these.
 */
function shouldAutoApprove(doc: Doc): boolean {
  const ext = (doc.extensions ?? {}) as {
    sensitivity?: string
    risk?: string
    knowledge_scope?: string
  }
  const verdict = classifyReview(
    {
      scope: (ext.knowledge_scope as "project-shared" | "user-global" | "session-private") ?? "user-global",
      type: doc.type,
      sensitivity: ext.sensitivity ?? "public",
      approval_risk: ext.risk ?? "low",
      body: doc.body,
      evidence_strength: doc.confidence?.evidence_strength ?? "weak",
    },
    DEFAULT_CONFIG,
  )
  if (verdict.path === "human_review") return false
  if (looksSensitive(doc.body)) return false
  if (looksLikeSecret(doc.body)) return false
  if (!doc.body || doc.body.trim().length < 10) return false
  return true
}

function invalidateKnowledgeCache(): void {
  try {
    KnowledgeSource.invalidateCache()
  } catch {
    /* knowledge-source not configured in this process (e.g. CLI) — safe to skip */
  }
}

/**
 * Fallback / always-on path: append imported memories to an AGENTS.md the
 * instruction-context loader auto-reads, so they are immediately visible as
 * ambient context even before governance promotes the candidates.
 */
export function writeMemoriesToInstructions(memories: MemoryItem[], dataRoot: string): number {
  const target = join(dataRoot, "AGENTS.md")
  const section = memories
    .map((m) => `### ${m.title}\n\n_source: ${m.source} · slug: \`${m.slug}\`\n\n${m.body.trim()}`)
    .join("\n\n")
  const block = `\n\n## Imported memory\n\n${section}\n`
  mkdirSync(dataRoot, { recursive: true })
  const existing = existsSync(target) ? readFileSync(target, "utf8") : ""
  if (existing.includes("## Imported memory")) {
    const replaced = existing.replace(/## Imported memory[\s\S]*$/, block.trimEnd())
    writeFileSync(target, replaced, "utf8")
  } else {
    writeFileSync(target, existing + block, "utf8")
  }
  return memories.length
}
