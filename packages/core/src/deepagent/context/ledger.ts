import type { DocumentStore, Doc } from "../document-store"

// V3.8 Appendix-A C2 — the Session Ledger: the session's structured, incrementally-maintained
// authoritative fact ledger. It REPLACES the "opaque prose summary rewritten every compaction"
// (App-A "旧世界") with structured, per-entry, traceable state that can be recalled by relevance.
//
// Storage model (matches how PlanController stores its `plan` doc — decision in document-store.ts):
// ONE `ledger` DocType doc per session, scope "run:<sessionId>", whose body is the serialized entry
// array. Every incremental update upserts that doc; the DocumentStore supersede chain (INV-4) IS the
// ledger change history. `ledger` is a NON-knowledge type (KNOWLEDGE_TYPES / KNOWLEDGE_DOC_TYPES
// exclude it, Phase 0) so it carries no confidence and never enters knowledge retrieval — the Curator
// reaches it through GraphQuery's documentStore path, not retrieve().

export type LedgerEntryKind = "goal" | "constraint" | "decision" | "done" | "open" | "next" | "artifact"
export type LedgerEntryStatus = "active" | "done" | "superseded"

export type LedgerEntry = {
  readonly id: string
  readonly kind: LedgerEntryKind
  readonly text: string
  readonly rationale?: string
  // Message ids this entry was derived from (traceability back to the raw conversation — C2).
  readonly refs: readonly string[]
  readonly status: LedgerEntryStatus
  readonly createdAt: number
  readonly updatedAt: number
  // Optional artifact pointer (e.g. a file-memory doc id from C1.5 ingest) for kind === "artifact".
  readonly artifactRef?: string
}

export type Ledger = {
  readonly sessionId: string
  readonly entries: readonly LedgerEntry[]
  readonly updatedAt: number
}

export const emptyLedger = (sessionId: string, now = Date.now()): Ledger => ({
  sessionId,
  entries: [],
  updatedAt: now,
})

// One incremental turn's worth of ledger mutations. This is a STRUCTURED DIFF (C2: "不是把 head 重新
// 总结一遍"), not a prose re-summary: append new entries, mark specific entries done/superseded, and
// replace the single active `next`. All ids/refs are explicit so the change is stable & traceable.
// A new entry to append: caller supplies the semantic fields; id/status/timestamps are assigned by
// applyUpdate. An explicit id may be supplied for deterministic tests / idempotent re-application.
export type AppendEntry = {
  readonly kind: LedgerEntryKind
  readonly text: string
  readonly rationale?: string
  readonly refs?: readonly string[]
  readonly artifactRef?: string
  readonly id?: string
}

export type LedgerUpdate = {
  // New entries to append (each gets a generated id if not supplied).
  readonly append?: readonly AppendEntry[]
  // Ids to mark done (a completed goal/open item).
  readonly markDone?: readonly string[]
  // Ids to mark superseded (a decision that was overturned).
  readonly markSuperseded?: readonly string[]
  // Replace the current step: supersede prior active `next` entries and append this one. Convenience
  // for the common "update next" case (C2).
  readonly next?: { readonly text: string; readonly refs?: readonly string[]; readonly rationale?: string }
}

let counter = 0
const genId = (kind: string, now: number): string => `led_${kind}_${now.toString(36)}_${(counter++).toString(36)}`

// Apply an incremental update to a ledger, returning a NEW ledger (pure). Ordering: mark existing
// entries first (done/superseded), then append new, then handle `next` (which supersedes prior active
// `next` entries so there is always at most one active step).
export const applyUpdate = (ledger: Ledger, update: LedgerUpdate, now = Date.now()): Ledger => {
  const done = new Set(update.markDone ?? [])
  const superseded = new Set(update.markSuperseded ?? [])

  let entries: LedgerEntry[] = ledger.entries.map((e) => {
    if (done.has(e.id) && e.status !== "done") return { ...e, status: "done" as const, updatedAt: now }
    if (superseded.has(e.id) && e.status !== "superseded")
      return { ...e, status: "superseded" as const, updatedAt: now }
    return e
  })

  for (const add of update.append ?? []) {
    entries.push({
      id: add.id ?? genId(add.kind, now),
      kind: add.kind,
      text: add.text,
      ...(add.rationale ? { rationale: add.rationale } : {}),
      refs: add.refs ?? [],
      status: "active",
      createdAt: now,
      updatedAt: now,
      ...(add.artifactRef ? { artifactRef: add.artifactRef } : {}),
    })
  }

  if (update.next) {
    // Supersede any prior active `next` so only the latest step is live.
    entries = entries.map((e) =>
      e.kind === "next" && e.status === "active" ? { ...e, status: "superseded" as const, updatedAt: now } : e,
    )
    entries.push({
      id: genId("next", now),
      kind: "next",
      text: update.next.text,
      ...(update.next.rationale ? { rationale: update.next.rationale } : {}),
      refs: update.next.refs ?? [],
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
  }

  return { sessionId: ledger.sessionId, entries, updatedAt: now }
}

// The task anchor (C1 §1, "永不丢"): active goals + active constraints. Tiny, always-present set the
// Curator injects first and never drops.
export const taskAnchor = (ledger: Ledger): readonly LedgerEntry[] =>
  ledger.entries.filter((e) => (e.kind === "goal" || e.kind === "constraint") && e.status === "active")

// The current live step (latest active `next`), or undefined.
export const currentNext = (ledger: Ledger): LedgerEntry | undefined =>
  ledger.entries.filter((e) => e.kind === "next" && e.status === "active").at(-1)

// Entries eligible for relevance recall: everything not the anchor and not superseded (superseded is
// archived — C2 "superseded/done 条目可折叠归档"). done items stay recall-eligible (a finished
// decision can still be relevant), but superseded ones are dropped.
export const recallCandidates = (ledger: Ledger): readonly LedgerEntry[] =>
  ledger.entries.filter((e) => e.status !== "superseded" && !(e.kind === "goal" || e.kind === "constraint"))

// --- persistence (ledger DocType, run-scoped) ---
//
// Each entry is persisted as its OWN `ledger` doc (idSlug = entry.id). This is deliberate: it is what
// lets the Curator's relevance recall run through the shared GraphQuery service over individual
// entries (a per-entry node with its own text surface) instead of one opaque blob — matching C2
// ("每条带 id、时间、来源消息、状态 ... 可按相关性检索、可追溯"). The full entry is round-tripped in
// `extensions.entry`; description/body/tags carry the keyword surface GraphQuery scores against. An
// unchanged entry upsert is a fingerprint no-op (INV-4), so re-persisting a stable ledger is cheap.

const ledgerScope = (sessionId: string): string => `run:${sessionId}`

const entryDescription = (e: LedgerEntry): string => `${e.kind}: ${e.text.slice(0, 120)}`
const entryBody = (e: LedgerEntry): string => (e.rationale ? `${e.text}\n\n${e.rationale}` : e.text)

const entryToDoc = (store: DocumentStore, sessionId: string, e: LedgerEntry): void => {
  store.upsert({
    type: "ledger",
    scope: ledgerScope(sessionId),
    idSlug: e.id,
    description: entryDescription(e),
    body: entryBody(e),
    tags: [`kind:${e.kind}`, `status:${e.status}`],
    provenance: { source: "runner", run_ref: ledgerScope(sessionId), evidence_refs: e.refs },
    extensions: { entry: e },
  })
}

const docToEntry = (doc: Doc): LedgerEntry | null => {
  const raw = doc.extensions?.entry
  if (!raw || typeof raw !== "object") return null
  const e = raw as LedgerEntry
  if (!e.id || !e.kind) return null
  return e
}

// Load the current ledger for a session from a run-scoped store, or an empty ledger if none exists.
// Reconstructs each entry from its doc's `extensions.entry`, ordered by createdAt (stable). Sync
// (DocumentStore is sync); Effect callers wrap with Effect.sync + cause recovery.
export const loadLedger = (store: DocumentStore, sessionId: string): Ledger => {
  const scope = ledgerScope(sessionId)
  const entries: LedgerEntry[] = []
  for (const ref of store.list({ type: "ledger", scope })) {
    const doc = store.get(ref.id)
    if (!doc) continue
    const entry = docToEntry(doc)
    if (entry) entries.push(entry)
  }
  entries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  return { sessionId, entries, updatedAt: Date.now() }
}

// Persist a ledger by upserting one doc per entry (version chain per entry = that entry's history).
// Idempotent for unchanged entries. Returns the count persisted.
export const persistLedger = (store: DocumentStore, ledger: Ledger): number => {
  for (const e of ledger.entries) entryToDoc(store, ledger.sessionId, e)
  return ledger.entries.length
}
