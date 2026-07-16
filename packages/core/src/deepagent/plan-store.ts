// I33-1 (deepagentcore-v4.0.3 storage prereq): the SINGLE structural authority for a session's plan.
//
// Before I33-1 the structural PlanDoc lived on the in-memory SessionRunState (flushed to sessions.json)
// while the goal path ALSO mirrored a `type:"plan"` DocumentStore doc — two disconnected stores that
// could diverge (a durable-continuation reload would trust one, a run-close mirror the other). I33-1
// makes the DocumentStore `type:"plan"` doc the ONE structural authority (content-addressed, versioned,
// CAS-protected by F30-1); SessionRunState keeps only the runtime latch (plan_id/version/fresh-stale)
// as a hot value object, never the body.
//
// The plan doc is co-located with the session's goal/run graph so the goal path and the `plan` tool
// write the SAME doc: `planStoreRoot(sid)` is byte-identical to goal-manager's `goalStoreRoot(sid)`
// (`<baseDir>/state/goal/<sid>/graph`). Both go through `DocumentStore.shared(root)` (F30-1 Part 2),
// so every handle for a session shares ONE in-memory index — a write via the tool is immediately
// visible to the goal driver and vice versa, with no second cache to drift. The shared index IS the
// hot cache: getPlanDoc is an in-memory Map lookup + a JSON.parse, not a disk read.
import path from "node:path"
import { DocumentStore } from "./document-store"
import type { PlanDoc } from "./plan-controller"

// The stable identity of a session's plan doc: type "plan", scope "run:<sid>", slug "plan-<sid>",
// description planDescription(sid). ALL FOUR must match between the `plan` tool path (setPlanDoc) and
// the goal path (goal-driver.materializePlanDoc) or upsert()'s findLogical dedup (which keys on
// description + domain) splits them into two docs (plan-<sid> vs plan-<sid>-2) and reintroduces the
// two-store divergence I33-1 removes. goal-driver imports planDescription/planScope from here so the
// identity can never drift across the package boundary.
const planSlug = (sessionId: string): string => `plan-${sessionId}`
export const planScope = (sessionId: string): string => `run:${sessionId}`
export const planDescription = (sessionId: string): string => `session plan ${sessionId}`

// The state dir session-state was configured with. plan-store roots UNDER it at the same location the
// goal store uses, so the two paths converge on one doc. Set by configureRoot (called from the same
// gateway configure that sets session-state's dir), so core never has to import the deepagent-code
// goal-manager resolver.
let stateDir: string | null = null

export const configureRoot = (dir: string): void => {
  stateDir = dir
}

// planStoreRoot(sid) === goalStoreRoot(sid) === <stateDir>/goal/<sid>/graph. Kept private-by-convention
// (exported for the goal path + tests to assert convergence). Throws if used before configureRoot — a
// plan write with no configured root is a wiring bug, not something to silently drop.
export const planStoreRoot = (sessionId: string): string => {
  if (!stateDir) throw new Error("plan-store: configureRoot() not called (no state dir)")
  return path.join(stateDir, "goal", sessionId, "graph")
}

// The shared authority handle for a session's plan doc. Shared registry keyed by resolved root, so the
// tool path, the goal driver, and the UI/archive readers all see one coherent in-memory index.
const store = (sessionId: string): DocumentStore => DocumentStore.shared(planStoreRoot(sessionId))

// Resolve a session's plan doc ref. The doc id is NOT reconstructable from the slug — allocateId runs
// idSlug through slugify() (lowercase, `_`→`-`, truncate 48), so a raw `doc:plan:plan-<sid>` guess
// misses for realistic session ids. Instead resolve by (type "plan", scope "run:<sid>"): the plan-store
// root is per-session (<state>/goal/<sid>/graph), and there is exactly one plan doc per session, so this
// filter yields at most one ref. list() returns the LATEST version per id (F30-1 shared index lookup).
const resolveRef = (sessionId: string) => {
  const refs = store(sessionId).list({ type: "plan", scope: planScope(sessionId) })
  return refs.length > 0 ? refs[0] : null
}

// Read the current structural plan for a session (latest version), or null if none exists yet. Pure
// in-memory lookup over the shared index (+ JSON.parse) — safe on the hot path (every tool call).
export const getPlanDoc = (sessionId: string): PlanDoc | null => {
  const ref = resolveRef(sessionId)
  if (!ref) return null
  const doc = store(sessionId).get(ref.id)
  if (!doc) return null
  try {
    return JSON.parse(doc.body) as PlanDoc
  } catch {
    return null
  }
}

// The doc id + current version for a session's plan (for the SessionRunState latch pointer), or null.
export const planDocRef = (sessionId: string): { id: string; version: number } | null => {
  const ref = resolveRef(sessionId)
  if (!ref) return null
  const doc = store(sessionId).get(ref.id)
  return doc ? { id: doc.id, version: doc.version } : null
}

// Write (create or new-version) the structural plan. Idempotent per session via upsert keyed on the
// stable slug: an unchanged body is an INV-4 no-op (no version bump), a changed body appends a new
// version (CAS-protected). Returns the resulting doc id + version so the caller can update the latch
// pointer. This is the ONE write seam — the `plan` tool AND the goal path both call it.
export const setPlanDoc = (sessionId: string, plan: PlanDoc): { id: string; version: number } => {
  const doc = store(sessionId).upsert({
    type: "plan",
    scope: planScope(sessionId),
    description: planDescription(sessionId),
    idSlug: planSlug(sessionId),
    body: JSON.stringify(plan),
    provenance: { source: "model", run_ref: planScope(sessionId) },
  })
  return { id: doc.id, version: doc.version }
}
