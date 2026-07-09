import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"

// V3 Document System (docs/28): the bedrock. All persistent state is a typed-document
// graph — small files, content-addressed, append-only with a supersede chain, bidirectional
// links, two-layer scope (run / durable). The in-memory index is rebuildable from files
// (the files are the truth). No external deps: documents are JSON; human-facing markdown
// views (RUN_CONTEXT, worklog) are rendered separately.
//
// Invariants (enforced; docs/28 INV-1..7):
//  INV-1 stable id; INV-2 content hash; INV-3 bidirectional links; INV-4 append-only +
//  superseded_by; INV-5 run docs never re-scoped to durable here (only via promotion);
//  INV-7 provenance required; sealed scope never listed.

export type DocType =
  | "knowledge"
  | "strategy"
  | "methodology"
  | "skill"
  | "memory"
  | "design"
  | "requirements"
  | "bugfix"
  | "tasks"
  | "worklog"
  | "candidate"
  | "eval"
  | "diagnosis"
  | "decision"
  | "context_snapshot"
  | "instruction_resolution"
  | "conflict"
  | "failure_dossier"
  | "run_context"
  | "run_state"
  // U1 PlanController (S1 §P0): the structural plan (goal/steps/active_step) for a session. Its
  // version chain IS the plan change history surfaced by U2 — not a knowledge type, so no confidence
  // is required. Persisted under scope "run:<sessionId>".
  | "plan"
  // --- V3.8 Phase 0 (roadmap C1): three NON-knowledge, derived-data node types added once so later
  // phases (GraphQuery / IM code bucket / Context-management refactor) never re-touch this union.
  // NONE of these are knowledge: they are excluded from KNOWLEDGE_TYPES (below) and from
  // KNOWLEDGE_DOC_TYPES (durable-knowledge-store.ts) so they never require confidence
  // (assertKnowledgeConfidence) and never pass the retrieve() whitelist. See the comments at each set.
  //
  // code_symbol (v3.8.1 §B): a code entity node (file / module / top-level symbol). Identity is
  // slug-derived via allocateId (path/symbol name), NOT content-addressed; the content hash is only
  // for integrity (INV-2). body carries path/language/symbol/signature; an optional content sha in
  // extensions is for change-detection only, never identity/dedup. The lightweight indexer that
  // registers these nodes is Phase 3's concern — this union entry is the only Phase-0 change.
  //   ⚠ Phase 3 TODO (v3.8.1 §B.3 version-bloat tradeoff): upsert()/update() bump version+1 and write
  //   a supersede link on every fingerprint change (INV-4, append-only). A frequently-edited code
  //   base makes code_symbol version files grow linearly. Phase 3's indexer must decide the mitigation
  //   (mtime-batched rate-limited rebuild, or relax append-only to in-place overwrite for code_symbol
  //   since code nodes are derived data with no audit value). NOT relaxed here — left as a marker.
  | "code_symbol"
  // ledger (v3.8.0 App-A §C2 Session Ledger): the session's structured, incrementally-maintained
  // authoritative fact ledger (entries {kind: goal|constraint|decision|done|open|next|artifact,
  // refs, status}). Added as a NEW member rather than reusing context_snapshot/worklog/decision:
  // context_snapshot is a point-in-time capture, worklog is a human-facing narrative, and decision is
  // a single decision — none model a living, entry-superseding structured state container. Run-scoped.
  | "ledger"
  // bridge (v3.8.0 App-A §C3 Project Bridge): a cross-session, project-level handoff document
  // (goals/decisions/open/next distilled from session Ledgers, loaded at new-session open). Added as a
  // NEW member: no existing type models a durable cross-session handoff (context_snapshot is
  // within-session). Persisted project-scoped ("durable:project:<id>") reusing existing storage.
  | "bridge"
  // environment_fact (v3.8.1 §G): a verifiable, non-directive operational fact about a shared runtime
  // environment — a test/staging server, a container, an endpoint (host/port/container/purpose). NOT
  // knowledge-class: excluded from KNOWLEDGE_TYPES + KNOWLEDGE_DOC_TYPES so it never requires
  // confidence and never passes the retrieve() whitelist (it must NOT be silently injected — it is
  // adopted per-project through the use-gate). Credentials are NEVER stored in the body; only a
  // secret_ref pointer. This is the ONLY doc type on the "write-cheap, ask-at-use" fast path (§G.2):
  // it auto-admits to user-global `provisional` without gate-7 human review, then each project decides
  // at first use whether to adopt it. strategy/methodology/anti_pattern deliberately do NOT get this
  // path (they steer the agent; cross-project auto-share would mislead — §G.2).
  | "environment_fact"

// provisional (v3.8.1 §G.3): a user-global environment_fact that was auto-admitted WITHOUT human
// review. It is never returned by retrieve() (whose status whitelist is "active" only), so it is never
// silently injected; it becomes usable to a project only after that project adopts it at the use-gate.
export type DocStatus = "draft" | "candidate" | "active" | "superseded" | "rejected" | "quarantined" | "provisional"
export type LinkRel =
  | "supports"
  | "blocks"
  | "conflicts_with"
  | "requires"
  | "requires_skill"
  | "validated_by"
  | "derived_from"
  | "produces_evidence"
  | "supersedes"
  | "refines"
  | "depends_on"
  | "triggered_by"
  // --- V3.8 Phase 0 (roadmap C2): code-graph edge relations (v3.8.1 §B.2). code↔doc cross-type links.
  | "references" // code_symbol -> doc (design/knowledge): the code references/uses that document
  | "implements" // code_symbol -> requirements: the code implements that requirement
  // Optional code_symbol -> code_symbol internal-dependency edges. The plan (roadmap Phase 0) says
  // these can be deferred — added here trivially so the Phase 3 indexer needn't re-touch this union,
  // but nothing produces or consumes them yet.
  | "imports" // code_symbol -> code_symbol: module/file import edge (optional, deferred use)
  | "calls" // code_symbol -> code_symbol: call edge (optional, deferred use)
// NOTE (App-A ledger/bridge edges): no new relations added for Session Ledger / Project Bridge edges.
// Ledger entries link to their sources with the existing `derived_from`; a bridge distilled/refined
// from a session's ledger reuses `refines`; a superseding handoff reuses `supersedes`. Revisit only if
// App-A implementation surfaces a genuinely distinct edge semantic.
export type EvidenceStrength = "strong" | "medium" | "weak" | "none"

// Knowledge-class types that MUST carry confidence (enforced by assertKnowledgeConfidence). The V3.8
// Phase 0 additions code_symbol/ledger/bridge are deliberately NOT here (roadmap C3, decision #4):
// they are non-knowledge derived data (code entities, session state, cross-session handoff), so they
// never require confidence and never pass the retrieve() whitelist (KNOWLEDGE_DOC_TYPES). Do not add.
export const KNOWLEDGE_TYPES: ReadonlySet<DocType> = new Set<DocType>([
  "knowledge",
  "strategy",
  "methodology",
  "memory",
])

export type DocLink = { readonly rel: LinkRel; readonly to: string; readonly note?: string }
export type Provenance = {
  readonly source: "model" | "runner" | "tool" | "external_trace" | "human"
  readonly run_ref?: string | null
  readonly evidence_refs?: readonly string[]
}
export type Confidence = {
  readonly evidence_strength: EvidenceStrength
  readonly support_count: number
  readonly last_validated_round?: number | null
}

export type Doc = {
  readonly id: string
  readonly type: DocType
  readonly scope: string // "run:<id>" | "durable" | "sealed"
  readonly status: DocStatus
  readonly version: number
  readonly superseded_by: string | null
  readonly hash: string
  readonly created_round: number | null
  readonly domain: string | null
  readonly tags: readonly string[]
  readonly description: string
  readonly provenance: Provenance
  readonly links: readonly DocLink[]
  readonly confidence?: Confidence
  readonly extensions?: Readonly<Record<string, unknown>>
  readonly body: string
}

export type DocRef = Pick<Doc, "id" | "version" | "type" | "scope" | "status" | "domain" | "tags" | "description"> & {
  readonly evidenceStrength?: EvidenceStrength
}

export type CreateDocInput = {
  readonly type: DocType
  readonly scope: string
  readonly body: string
  readonly description: string
  readonly domain?: string | null
  readonly tags?: readonly string[]
  readonly links?: readonly DocLink[]
  readonly provenance: Provenance
  readonly confidence?: Confidence
  readonly createdRound?: number | null
  readonly idSlug?: string
  readonly extensions?: Readonly<Record<string, unknown>>
}

export type DocFilter = {
  readonly type?: DocType | readonly DocType[]
  readonly scope?: string
  readonly status?: DocStatus | readonly DocStatus[]
  readonly domain?: string | null
  readonly tag?: string
}

export type IntegrityViolation = { readonly invariant: string; readonly docId: string; readonly detail: string }
export type IntegrityReport = { readonly ok: boolean; readonly violations: readonly IntegrityViolation[] }

const toRef = (d: Doc): DocRef => ({
  id: d.id,
  version: d.version,
  type: d.type,
  scope: d.scope,
  status: d.status,
  domain: d.domain,
  tags: d.tags,
  description: d.description,
  evidenceStrength: d.confidence?.evidence_strength,
})

const canonical = (value: unknown): string => {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sort((v as Record<string, unknown>)[k])
      return out
    }
    return v
  }
  return JSON.stringify(sort(value))
}

const computeHash = (doc: Doc): string => {
  const { hash: _h, ...rest } = doc
  return "sha256:" + createHash("sha256").update(canonical(rest)).digest("hex")
}

// fingerprint of semantic content (excludes version/hash/status/superseded_by) for the no-op rule
const fingerprint = (d: Doc): string =>
  canonical({
    type: d.type,
    scope: d.scope,
    domain: d.domain,
    tags: d.tags,
    description: d.description,
    links: d.links,
    confidence: d.confidence ?? null,
    provenance: d.provenance,
    extensions: d.extensions ?? null,
    body: d.body,
  })

const slugify = (text: string, max = 48): string =>
  (
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, "")
      .trim()
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "doc"
  )
    .slice(0, max)
    .replace(/-$/g, "")

// Token-set similarity for near-duplicate knowledge detection (no embedding model needed). Splits
// on non-alphanumeric (covers latin words and CJK runs), lowercases, drops 1-char noise, and scores
// with the overlap coefficient |A∩B| / min(|A|,|B|) — chosen over Jaccard so a short summary that is
// fully contained in a longer one still scores high (the common "same point, more words" case).
// Exported for unit testing. Returns 0 when either side has no usable tokens.
export const tokenizeForSimilarity = (text: string): Set<string> => {
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2)
  return new Set(tokens)
}

export const knowledgeSimilarity = (a: string, b: string): number => {
  const ta = tokenizeForSimilarity(a)
  const tb = tokenizeForSimilarity(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta]
  for (const t of small) if (large.has(t)) inter++
  return inter / small.size
}

export const KNOWLEDGE_SIMILARITY_THRESHOLD = 0.8

const STRENGTH_RANK: Record<EvidenceStrength, number> = { none: 0, weak: 1, medium: 2, strong: 3 }
const strongerEvidence = (a: EvidenceStrength, b: EvidenceStrength): EvidenceStrength =>
  STRENGTH_RANK[a] >= STRENGTH_RANK[b] ? a : b

const idToFile = (id: string): string => id.replace(/:/g, "__")

export class DocumentStore {
  // id -> version -> Doc
  private docs = new Map<string, Map<number, Doc>>()
  constructor(private readonly root: string) {
    mkdirSync(path.join(root, "docs"), { recursive: true })
    this.rebuildIndex()
  }

  // ---- write ----
  create(input: CreateDocInput): Doc {
    const id = this.allocateId(input.type, input.domain ?? null, input.idSlug, input.description)
    let doc: Doc = this.docFromInput(id, 1, input)
    this.assertKnowledgeConfidence(doc)
    this.assertLinkTargets(doc.links)
    doc = { ...doc, hash: computeHash(doc) }
    this.persist(doc)
    return doc
  }

  upsert(input: CreateDocInput): Doc {
    const cur = this.findLogical(input)
    if (!cur) return this.create(input)
    let next: Doc = this.docFromInput(cur.id, cur.version + 1, input)
    if (fingerprint(next) === fingerprint(cur)) return cur
    this.assertKnowledgeConfidence(next)
    this.assertLinkTargets(next.links)
    next = { ...next, hash: computeHash(next) }
    this.persist(next)
    this.replace({ ...cur, status: "superseded", superseded_by: `${cur.id}@v${next.version}` })
    return next
  }

  update(id: string, body: string, links?: readonly DocLink[]): Doc {
    const cur = this.get(id)
    if (!cur) throw new Error(`update: unknown doc ${id}`)
    // Preserve the current status: an update (e.g. adding a link via link()) must not silently
    // demote an `active` doc back to `draft`.
    let next: Doc = {
      ...cur,
      body,
      links: links ?? cur.links,
      version: cur.version + 1,
      status: cur.status,
      superseded_by: null,
      hash: "",
    }
    if (fingerprint(next) === fingerprint(cur)) return cur // INV-4 no-op
    this.assertLinkTargets(next.links)
    next = { ...next, hash: computeHash(next) }
    this.persist(next)
    this.replace({ ...cur, status: "superseded", superseded_by: `${id}@v${next.version}` })
    return next
  }

  // Find an existing non-rejected knowledge doc that near-duplicates `input` (same type + scope +
  // domain, description token-similarity >= threshold). Used by the self-learning write path to
  // merge "same point, different wording" candidates instead of creating duplicate rows.
  findSimilarKnowledge(
    input: { type: DocType; scope: string; domain: string | null; description: string },
    threshold = KNOWLEDGE_SIMILARITY_THRESHOLD,
  ): Doc | null {
    let best: { doc: Doc; score: number } | null = null
    for (const ref of this.list({ type: input.type, scope: input.scope })) {
      const doc = this.get(ref.id)
      if (!doc || doc.status === "rejected" || doc.status === "superseded") continue
      if ((doc.domain ?? null) !== (input.domain ?? null)) continue
      const score = knowledgeSimilarity(doc.description, input.description)
      if (score >= threshold && (!best || score > best.score)) best = { doc, score }
    }
    return best?.doc ?? null
  }

  // Reinforce an existing knowledge doc when a duplicate/near-duplicate is observed again: bump
  // support_count and raise evidence_strength to the stronger of the two. Returns the updated doc.
  // This is the "merge" half of dedup — one knowledge row accrues support instead of many rows.
  reinforceConfidence(id: string, incoming?: Confidence | null): Doc {
    const cur = this.get(id)
    if (!cur) throw new Error(`reinforceConfidence: unknown doc ${id}`)
    const base = cur.confidence ?? { evidence_strength: "weak" as EvidenceStrength, support_count: 0 }
    const nextConfidence: Confidence = {
      evidence_strength: strongerEvidence(base.evidence_strength, incoming?.evidence_strength ?? "none"),
      support_count: base.support_count + 1,
      ...(base.last_validated_round != null ? { last_validated_round: base.last_validated_round } : {}),
    }
    const next: Doc = { ...cur, confidence: nextConfidence, version: cur.version + 1, superseded_by: null, hash: "" }
    const hashed = { ...next, hash: computeHash(next) }
    this.persist(hashed)
    this.replace({ ...cur, status: "superseded", superseded_by: `${id}@v${hashed.version}` })
    return hashed
  }

  link(from: string, rel: LinkRel, to: string, note?: string): void {
    const cur = this.get(from)
    if (!cur) throw new Error(`link: unknown from ${from}`)
    if (cur.links.some((l) => l.rel === rel && l.to === to)) return
    this.update(from, cur.body, [...cur.links, { rel, to, ...(note ? { note } : {}) }])
  }

  setStatus(id: string, status: DocStatus): void {
    const cur = this.get(id)
    if (!cur) throw new Error(`setStatus: unknown doc ${id}`)
    this.replace({ ...cur, status })
  }

  // ---- read ----
  get(id: string, version?: number): Doc | null {
    const versions = this.docs.get(id)
    if (!versions) return null
    const v = version ?? Math.max(...versions.keys())
    return versions.get(v) ?? null
  }

  getRefsIn(id: string): { rel: LinkRel; from: DocRef }[] {
    const out: { rel: LinkRel; from: DocRef }[] = []
    for (const [, versions] of this.docs) {
      const latest = versions.get(Math.max(...versions.keys()))!
      for (const l of latest.links) if (l.to === id) out.push({ rel: l.rel, from: toRef(latest) })
    }
    return out
  }

  list(filter: DocFilter = {}): DocRef[] {
    const types = filter.type ? new Set(([] as DocType[]).concat(filter.type as DocType[])) : null
    const statuses = filter.status ? new Set(([] as DocStatus[]).concat(filter.status as DocStatus[])) : null
    const out: DocRef[] = []
    for (const [, versions] of this.docs) {
      const d = versions.get(Math.max(...versions.keys()))!
      if (d.scope === "sealed") continue // INV-7: sealed never listed
      if (types && !types.has(d.type)) continue
      if (statuses && !statuses.has(d.status)) continue
      if (filter.scope && d.scope !== filter.scope) continue
      if (filter.domain !== undefined && d.domain !== filter.domain) continue
      if (filter.tag && !d.tags.includes(filter.tag)) continue
      out.push(toRef(d))
    }
    return out
  }

  neighbors(id: string, rels: readonly LinkRel[], depth: number): DocRef[] {
    const seen = new Set<string>([id])
    let frontier = [id]
    const result: DocRef[] = []
    for (let d = 0; d < depth; d++) {
      const next: string[] = []
      for (const cur of frontier) {
        const doc = this.get(cur)
        if (!doc) continue
        for (const l of doc.links) {
          if (!rels.includes(l.rel) || seen.has(l.to)) continue
          seen.add(l.to)
          const td = this.get(l.to)
          if (td) {
            result.push(toRef(td))
            next.push(l.to)
          }
        }
      }
      frontier = next
      if (frontier.length === 0) break
    }
    return result
  }

  index(): DocRef[] {
    return this.list({ status: ["draft", "candidate", "active", "quarantined", "rejected"] })
  }

  // ---- integrity ----
  verify(): IntegrityReport {
    const violations: IntegrityViolation[] = []
    for (const [id, versions] of this.docs) {
      const max = Math.max(...versions.keys())
      for (const [v, doc] of versions) {
        if (computeHash({ ...doc, hash: "" }) !== doc.hash)
          violations.push({ invariant: "INV-2", docId: `${id}@v${v}`, detail: "hash mismatch" })
        if (!doc.provenance?.source)
          violations.push({ invariant: "INV-7", docId: `${id}@v${v}`, detail: "missing provenance.source" })
        for (const l of doc.links)
          if (!this.docs.has(l.to))
            violations.push({ invariant: "INV-3", docId: id, detail: `dangling link -> ${l.to}` })
        if (v < max && (doc.status !== "superseded" || !doc.superseded_by))
          violations.push({ invariant: "INV-4", docId: `${id}@v${v}`, detail: "old version not superseded" })
      }
    }
    return { ok: violations.length === 0, violations }
  }

  rebuildIndex(): void {
    this.docs.clear()
    const docsDir = path.join(this.root, "docs")
    if (!existsSync(docsDir)) return
    // Skip non-directory entries (e.g. a stray .DS_Store under docs/) so readdir on a file can't
    // throw ENOTDIR and brick store construction.
    for (const entry of readdirSync(docsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const typeDir = path.join(docsDir, entry.name)
      for (const file of readdirSync(typeDir)) {
        if (!file.endsWith(".json")) continue
        const doc = JSON.parse(readFileSync(path.join(typeDir, file), "utf8")) as Doc
        this.indexDoc(doc)
      }
    }
  }

  // ---- internals ----
  private persist(doc: Doc): void {
    const dir = path.join(this.root, "docs", doc.type)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${idToFile(doc.id)}@v${doc.version}.json`), JSON.stringify(doc, null, 2))
    this.indexDoc(doc)
  }
  private replace(doc: Doc): void {
    // rewrites the same version with new status/superseded_by; rehash so INV-2 holds
    this.persist({ ...doc, hash: computeHash({ ...doc, hash: "" }) })
  }
  private indexDoc(doc: Doc): void {
    const versions = this.docs.get(doc.id) ?? new Map<number, Doc>()
    versions.set(doc.version, doc)
    this.docs.set(doc.id, versions)
  }
  private docFromInput(id: string, version: number, input: CreateDocInput): Doc {
    return {
      id,
      type: input.type,
      scope: input.scope,
      status: "draft",
      version,
      superseded_by: null,
      hash: "",
      created_round: input.createdRound ?? null,
      domain: input.domain ?? null,
      tags: input.tags ?? [],
      description: input.description,
      provenance: input.provenance,
      links: input.links ?? [],
      ...(input.confidence ? { confidence: input.confidence } : {}),
      ...(input.extensions ? { extensions: input.extensions } : {}),
      body: input.body,
    }
  }
  private findLogical(input: CreateDocInput): Doc | null {
    const domain = input.domain ?? null
    for (const ref of this.list({ type: input.type, scope: input.scope })) {
      const doc = this.get(ref.id)
      if (!doc) continue
      if (doc.domain === domain && doc.description === input.description) return doc
    }
    return null
  }
  private allocateId(type: DocType, domain: string | null, idSlug: string | undefined, description: string): string {
    const slug = slugify(idSlug ?? description)
    const base = domain ? `doc:${type}:${domain}:${slug}` : `doc:${type}:${slug}`
    if (!this.docs.has(base)) return base
    for (let i = 2; ; i++) {
      const c = `${base}-${i}`
      if (!this.docs.has(c)) return c
    }
  }
  private assertKnowledgeConfidence(doc: Doc): void {
    if (KNOWLEDGE_TYPES.has(doc.type) && !doc.confidence)
      throw new Error(`knowledge-class doc ${doc.id} requires confidence (docs/30 §3)`)
  }
  private assertLinkTargets(links: readonly DocLink[]): void {
    for (const l of links) if (!this.docs.has(l.to)) throw new Error(`link target does not exist: ${l.to} (INV-3)`)
  }
}
