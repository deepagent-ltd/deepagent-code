import { Effect, Schema } from "effect"
import type {
  Confidence,
  Doc,
  DocLink,
  DocType,
  DocumentStore,
  LinkRel,
} from "@deepagent-code/core/deepagent/document-store"

/**
 * V3.9 §B — Repo & Wiki（人向监督层）: the WikiService.
 *
 * This is a PURE PROJECTION + governance封装 over the four graphs (document-store + code_symbol),
 * NOT a fifth store (§B.1). The same underlying data an Agent reads as structured graph nodes, a
 * human reads here as rendered Markdown / code views. There is NO independent wiki storage: a page's
 * version IS the document supersede chain, and an edit is `DocumentStore.updateWithProvenance`
 * (append-only new version + provenance `source:"human"`), reusing the existing governance pipeline.
 *
 * §B.2 治理不对等 (STRICTLY enforced here):
 *   - Knowledge / Memory / strategy / methodology → editable (governed via evidence-gate + human
 *     provenance). These are the KNOWLEDGE_TYPES that carry confidence and pollute later runs if
 *     wrong, so a human MUST be able to promote / reject / edit them.
 *   - Document (worklog/diagnosis/decision/plan/...) and Code (code_symbol) → READ-ONLY monitoring.
 *     Attempting to edit one is a `WikiReadOnlyError`.
 *   - sealed scope → NEVER projected (INV-7): renderPage on a sealed doc is a `WikiNotFoundError`,
 *     and the search index (search-index.ts) never indexes it. sealed is treated as if it does not
 *     exist to the human layer.
 *
 * The service is constructed over an injected ordered set of DocumentStores (the same union
 * knowledge-source.storesForWorkspace / graph-query walk: user-global first, then the project store,
 * and optionally the session's run-scoped context store). This keeps the service a testable pure
 * projection — tests wire in-memory stores; production wires the real union via `openWikiGraph`.
 */

// The 4 editable types (§B.2 / §B.3): exactly KNOWLEDGE_TYPES. Kept as a local const (not imported
// from core) so the editable boundary is auditable in one place next to the enforcement.
export const WIKI_EDITABLE_TYPES: ReadonlySet<DocType> = new Set<DocType>([
  "knowledge",
  "memory",
  "strategy",
  "methodology",
])

// Code-graph relations the cross-link projection walks (§B.5, all from §A): references (code→doc),
// implements (code→requirements), contains (file→symbol), imports (file→file), calls (symbol→symbol).
const CODE_RELS: readonly LinkRel[] = ["references", "implements", "contains", "imports", "calls"]

/** A human identity for a governance edit (§B.3). No pre-existing type — introduced here. */
export type HumanRef = { readonly id: string; readonly name?: string }

/**
 * A reference from a doc to a code entity (§B.5). `path`/`line` come from the target code_symbol
 * node's extensions (host_path + range.start, 0-based → 1-based line). `stale:true` means the link's
 * code_symbol target no longer resolves to a live node — rendered greyed-out with a hint, NEVER
 * silently dropped (§B.5 link integrity).
 */
export type CodeRef = {
  readonly docId: string
  readonly rel: LinkRel
  readonly path: string | null
  readonly line: number | null
  readonly symbolPath: string | null
  readonly stale: boolean
}

/** A reference from a code node to a doc (or doc↔doc), for the Repo side-panel (§B.5). */
export type DocRefLite = {
  readonly docId: string
  readonly rel: LinkRel
  readonly type: DocType | null
  readonly title: string
  readonly stale: boolean
}

export type WikiCrossLinks = { readonly toCode: readonly CodeRef[]; readonly toDocs: readonly DocRefLite[] }

export type WikiPage = {
  readonly docId: string
  readonly type: DocType
  readonly title: string
  readonly markdown: string
  readonly editable: boolean
  readonly version: number
  readonly confidence?: Confidence
  readonly crossLinks: WikiCrossLinks
}

export type ExecutionArchiveEntry = {
  readonly docId: string
  readonly type: DocType
  readonly title: string
  readonly body: string
  readonly version: number
}

export type ExecutionArchive = {
  readonly sessionId: string
  readonly title: string
  readonly markdown: string
  readonly entries: readonly ExecutionArchiveEntry[]
}

// --- errors (Schema.TaggedErrorClass, matching skill/index.ts + worktree/index.ts convention) ---

export class WikiNotFoundError extends Schema.TaggedErrorClass<WikiNotFoundError>()("WikiNotFoundError", {
  docId: Schema.String,
  reason: Schema.optional(Schema.String),
}) {
  override get message() {
    return `Wiki page not found: ${this.docId}${this.reason ? ` (${this.reason})` : ""}`
  }
}

export class WikiReadOnlyError extends Schema.TaggedErrorClass<WikiReadOnlyError>()("WikiReadOnlyError", {
  docId: Schema.String,
  type: Schema.String,
}) {
  override get message() {
    return `Wiki page ${this.docId} of type "${this.type}" is read-only (§B.2: only knowledge/memory/strategy/methodology are governable)`
  }
}

export class GateRejectedError extends Schema.TaggedErrorClass<GateRejectedError>()("WikiGateRejectedError", {
  docId: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Governance gate rejected the edit to ${this.docId}: ${this.reason}`
  }
}

/**
 * The edit-governance seam (§B.2 "改动走 evidence-gate 审计"). A human edit to a knowledge page is
 * validated before it lands; a rejection surfaces as `GateRejectedError`, not a silent write. The
 * default gate encodes the one universal rule (a knowledge page must not be blanked out); a
 * deployment / test can inject a stricter gate (e.g. wire the real promotion evidence-gate).
 */
export type WikiEditGate = (input: {
  readonly current: Doc
  readonly body: string
  readonly editor: HumanRef
}) => { readonly pass: boolean; readonly reason?: string }

export const DEFAULT_WIKI_EDIT_GATE: WikiEditGate = ({ body }) =>
  body.trim().length === 0
    ? { pass: false, reason: "empty body: a governed knowledge page cannot be blanked out" }
    : { pass: true }

/**
 * A read/write port over the ordered union of DocumentStores. `get`/`getRefsIn`/`neighbors` union
 * across all stores (first-store-wins on id collision, matching the retriever's user-global-wins
 * rule); `ownerOf` finds the specific store that holds a doc so an edit writes back to the right
 * place. sealed docs are filtered out of `get` so nothing sealed can ever be projected (INV-7) —
 * this is the single choke point the whole service relies on.
 */
export class WikiGraph {
  constructor(private readonly stores: readonly DocumentStore[]) {}

  // Resolve the latest live version of a doc, EXCLUDING sealed (INV-7 — sealed never projected).
  get(id: string): Doc | null {
    for (const store of this.stores) {
      const doc = store.get(id)
      if (doc && doc.scope !== "sealed") return doc
    }
    return null
  }

  // Does the id resolve to a live, non-sealed doc anywhere in the union?
  resolves(id: string): boolean {
    return this.get(id) !== null
  }

  // The store that owns a doc id (for write-back). Skips sealed so an edit can never target a sealed
  // doc even if a caller somehow obtained its id.
  ownerOf(id: string): DocumentStore | null {
    for (const store of this.stores) {
      const doc = store.get(id)
      if (doc && doc.scope !== "sealed") return store
    }
    return null
  }

  // Union of outgoing links on the doc's latest version (deduped by rel+to).
  outgoing(id: string): readonly DocLink[] {
    const doc = this.get(id)
    if (!doc) return []
    const seen = new Set<string>()
    const out: DocLink[] = []
    for (const l of doc.links) {
      const key = `${l.rel}::${l.to}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(l)
    }
    return out
  }

  // Union of inbound links across every store (deduped by rel+from id).
  incoming(id: string): readonly { rel: LinkRel; from: Doc }[] {
    const seen = new Set<string>()
    const out: { rel: LinkRel; from: Doc }[] = []
    for (const store of this.stores) {
      for (const ref of store.getRefsIn(id)) {
        const key = `${ref.rel}::${ref.from.id}`
        if (seen.has(key)) continue
        const from = this.get(ref.from.id)
        if (!from) continue // sealed or gone — never surface
        seen.add(key)
        out.push({ rel: ref.rel, from })
      }
    }
    return out
  }

  // All live, non-sealed docs of the given scope across the union (for the execution archive). Uses
  // list() (which already drops sealed) then re-resolves each id through get() (dedupe + latest).
  byScope(scope: string): readonly Doc[] {
    const seen = new Set<string>()
    const out: Doc[] = []
    for (const store of this.stores) {
      for (const ref of store.list({ scope })) {
        if (seen.has(ref.id)) continue
        seen.add(ref.id)
        const doc = this.get(ref.id)
        if (doc) out.push(doc)
      }
    }
    return out
  }

  // All live, non-sealed docs across the union (for the search-index full rebuild). Deduped by id
  // (first-store-wins), always excluding sealed (list() already drops sealed; get() re-confirms).
  allDocs(): readonly Doc[] {
    const seen = new Set<string>()
    const out: Doc[] = []
    for (const store of this.stores) {
      for (const ref of store.list()) {
        if (seen.has(ref.id)) continue
        seen.add(ref.id)
        const doc = this.get(ref.id)
        if (doc) out.push(doc)
      }
    }
    return out
  }

  get storeList(): readonly DocumentStore[] {
    return this.stores
  }
}

// A code_symbol node's file:line, pulled from its extensions (written by code-indexer §A.3). A file
// node has no host_path/symbol_path, so its path is the node description (= the file path, §A.3); a
// symbol child node carries host_path + symbol_path + range in extensions.
const codeLocation = (doc: Doc): { path: string | null; line: number | null; symbolPath: string | null } => {
  const ext = doc.extensions ?? {}
  const path = typeof ext.host_path === "string" ? ext.host_path : doc.description
  const symbolPath = typeof ext.symbol_path === "string" ? ext.symbol_path : null
  const range = ext.range as { start?: number } | undefined
  const line = range && typeof range.start === "number" ? range.start + 1 : null // 0-based → 1-based
  return { path, line, symbolPath }
}

const titleFor = (doc: Doc): string => doc.description || doc.id

// Render a doc as a human Markdown page. Deliberately simple + deterministic (no LLM): heading +
// metadata block + body. Knowledge pages show confidence; all pages show type/version/scope.
const renderMarkdown = (doc: Doc, editable: boolean): string => {
  const lines: string[] = []
  lines.push(`# ${titleFor(doc)}`)
  lines.push("")
  lines.push(`- **type**: ${doc.type}${editable ? " (editable)" : " (read-only)"}`)
  lines.push(`- **version**: ${doc.version}`)
  lines.push(`- **scope**: ${doc.scope}`)
  lines.push(`- **status**: ${doc.status}`)
  if (doc.confidence)
    lines.push(
      `- **confidence**: ${doc.confidence.evidence_strength} (support ${doc.confidence.support_count})`,
    )
  if (doc.tags.length > 0) lines.push(`- **tags**: ${doc.tags.join(", ")}`)
  lines.push(`- **provenance**: ${doc.provenance.source}`)
  lines.push("")
  lines.push(doc.body)
  return lines.join("\n")
}

export class WikiService {
  private readonly gate: WikiEditGate

  constructor(
    private readonly graph: WikiGraph,
    gate: WikiEditGate = DEFAULT_WIKI_EDIT_GATE,
  ) {
    this.gate = gate
  }

  private editableFor(type: DocType): boolean {
    return WIKI_EDITABLE_TYPES.has(type)
  }

  // §B.3 renderPage: project a graph node as a Markdown page. sealed → WikiNotFoundError (INV-7).
  renderPage(input: { docId: string; scope: string }): Effect.Effect<WikiPage, WikiNotFoundError> {
    return Effect.suspend(() => {
      const doc = this.graph.get(input.docId)
      if (!doc) return Effect.fail(new WikiNotFoundError({ docId: input.docId, reason: "not found or sealed" }))
      // scope is an advisory filter: if the caller pins a scope, a doc from another scope is treated
      // as not-found so a run-scoped request never leaks a durable page and vice-versa.
      if (input.scope && doc.scope !== input.scope)
        return Effect.fail(new WikiNotFoundError({ docId: input.docId, reason: `scope mismatch (${doc.scope})` }))
      return this.crossLinks(input.docId).pipe(Effect.map((crossLinks) => this.pageOf(doc, crossLinks)))
    })
  }

  private pageOf(doc: Doc, crossLinks: WikiCrossLinks): WikiPage {
    const editable = this.editableFor(doc.type)
    return {
      docId: doc.id,
      type: doc.type,
      title: titleFor(doc),
      markdown: renderMarkdown(doc, editable),
      editable,
      version: doc.version,
      ...(doc.confidence ? { confidence: doc.confidence } : {}),
      crossLinks,
    }
  }

  // §B.3 editKnowledge: governed edit of a KNOWLEDGE_TYPE page. Non-editable type → WikiReadOnlyError;
  // gate rejection → GateRejectedError; success → append-only new version with human provenance.
  editKnowledge(input: {
    docId: string
    body: string
    editor: HumanRef
  }): Effect.Effect<WikiPage, WikiReadOnlyError | GateRejectedError | WikiNotFoundError> {
    return Effect.suspend((): Effect.Effect<WikiPage, WikiReadOnlyError | GateRejectedError | WikiNotFoundError> => {
      const doc = this.graph.get(input.docId)
      if (!doc) return Effect.fail(new WikiNotFoundError({ docId: input.docId, reason: "not found or sealed" }))
      if (!this.editableFor(doc.type))
        return Effect.fail(new WikiReadOnlyError({ docId: doc.id, type: doc.type }))
      const verdict = this.gate({ current: doc, body: input.body, editor: input.editor })
      if (!verdict.pass)
        return Effect.fail(new GateRejectedError({ docId: doc.id, reason: verdict.reason ?? "rejected" }))
      const store = this.graph.ownerOf(input.docId)
      if (!store) return Effect.fail(new WikiNotFoundError({ docId: input.docId, reason: "no owning store" }))
      // Append-only human-provenance edit (§B.2/B.3). evidence_refs pin the human editor for audit.
      const updated = store.updateWithProvenance(doc.id, input.body, {
        source: "human",
        evidence_refs: [`human:${input.editor.id}${input.editor.name ? `:${input.editor.name}` : ""}`],
      })
      return this.crossLinks(updated.id).pipe(Effect.map((crossLinks) => this.pageOf(updated, crossLinks)))
    })
  }

  // §B.5 crossLinks: docs↔code from graph edges. A code_symbol edge whose target no longer resolves
  // is marked stale (NOT dropped). Never fails.
  crossLinks(docId: string): Effect.Effect<WikiCrossLinks, never> {
    return Effect.sync(() => {
      const toCode: CodeRef[] = []
      const toDocs: DocRefLite[] = []
      // Outgoing edges of this doc.
      for (const link of this.graph.outgoing(docId)) {
        if (!CODE_RELS.includes(link.rel)) continue
        const target = this.graph.get(link.to)
        if (target && target.type === "code_symbol") {
          const loc = codeLocation(target)
          toCode.push({ docId: target.id, rel: link.rel, path: loc.path, line: loc.line, symbolPath: loc.symbolPath, stale: false })
        } else if (!target) {
          // link points at a code_symbol id that no longer resolves — stale, keep it visible.
          toCode.push({ docId: link.to, rel: link.rel, path: null, line: null, symbolPath: null, stale: true })
        } else {
          toDocs.push({ docId: target.id, rel: link.rel, type: target.type, title: titleFor(target), stale: false })
        }
      }
      // Inbound edges (code/doc → this doc): the Repo side-panel "what references me".
      for (const { rel, from } of this.graph.incoming(docId)) {
        if (!CODE_RELS.includes(rel)) continue
        if (from.type === "code_symbol") {
          const loc = codeLocation(from)
          toCode.push({ docId: from.id, rel, path: loc.path, line: loc.line, symbolPath: loc.symbolPath, stale: false })
        } else {
          toDocs.push({ docId: from.id, rel, type: from.type, title: titleFor(from), stale: false })
        }
      }
      return { toCode: dedupeCode(toCode), toDocs: dedupeDocs(toDocs) }
    })
  }

  // §B.6 renderExecutionArchive: aggregate a session's Document Graph trajectory (plan + worklog +
  // diagnosis + decision + validation/eval, scope run:<sessionId>) into a readable archive. Never
  // fails: an empty session yields an archive with no entries.
  renderExecutionArchive(input: { sessionId: string }): Effect.Effect<ExecutionArchive, never> {
    return Effect.sync(() => buildExecutionArchive(this.graph, input.sessionId))
  }
}

const dedupeCode = (refs: readonly CodeRef[]): CodeRef[] => {
  const seen = new Set<string>()
  const out: CodeRef[] = []
  for (const r of refs) {
    const key = `${r.rel}::${r.docId}::${r.stale}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out.sort((a, b) => a.docId.localeCompare(b.docId) || a.rel.localeCompare(b.rel))
}

const dedupeDocs = (refs: readonly DocRefLite[]): DocRefLite[] => {
  const seen = new Set<string>()
  const out: DocRefLite[] = []
  for (const r of refs) {
    const key = `${r.rel}::${r.docId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out.sort((a, b) => a.docId.localeCompare(b.docId) || a.rel.localeCompare(b.rel))
}

// The Document-Graph node types that make up an execution archive (§B.6 / §D.7): the plan (goal +
// steps), the worklog narrative, diagnoses, decisions, and validation/eval evidence.
export const EXECUTION_ARCHIVE_TYPES: readonly DocType[] = [
  "plan",
  "worklog",
  "diagnosis",
  "decision",
  "eval",
]
const ARCHIVE_ORDER: Record<string, number> = { plan: 0, worklog: 1, diagnosis: 2, decision: 3, eval: 4 }

// Pure builder (shared with the archiver). Reads run:<sessionId>-scoped docs from the graph union.
export const buildExecutionArchive = (graph: WikiGraph, sessionId: string): ExecutionArchive => {
  const scope = `run:${sessionId}`
  const wanted = new Set<DocType>(EXECUTION_ARCHIVE_TYPES)
  const docs = graph
    .byScope(scope)
    .filter((d) => wanted.has(d.type))
    .sort(
      (a, b) => (ARCHIVE_ORDER[a.type] ?? 99) - (ARCHIVE_ORDER[b.type] ?? 99) || a.id.localeCompare(b.id),
    )
  const entries: ExecutionArchiveEntry[] = docs.map((d) => ({
    docId: d.id,
    type: d.type,
    title: titleFor(d),
    body: d.body,
    version: d.version,
  }))
  const md: string[] = [`# Execution Archive — session ${sessionId}`, ""]
  if (entries.length === 0) md.push("_No trajectory documents recorded for this session._")
  for (const e of entries) {
    md.push(`## [${e.type}] ${e.title}`)
    md.push("")
    md.push(e.body)
    md.push("")
  }
  return { sessionId, title: `Execution Archive — session ${sessionId}`, markdown: md.join("\n").trimEnd(), entries }
}
