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
import { DocumentConflictError, DocumentStore, type Provenance } from "./document-store"
import {
  PlanConflictError,
  PlanValidationError,
  type PlanDoc,
  type PlanExpected,
  type PlanStepStatus,
  type PlanWriteOrigin,
  planProgressFingerprint,
} from "./plan-controller"

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

const planStatuses = new Set<PlanStepStatus>(["pending", "active", "done", "cancelled", "blocked"])

export const decodePlanDoc = (body: string): PlanDoc | null => {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const plan = value as Record<string, unknown>
  if (typeof plan.plan_id !== "string" || plan.plan_id.trim() === "") return null
  if (typeof plan.session_id !== "string" || plan.session_id.trim() === "") return null
  if (typeof plan.goal !== "string" || plan.goal.trim() === "") return null
  if (!Array.isArray(plan.assumptions) || !plan.assumptions.every((item) => typeof item === "string")) return null
  if (typeof plan.created_at !== "string" || plan.created_at.trim() === "") return null
  if (
    plan.replan_reason !== undefined &&
    plan.replan_reason !== null &&
    (typeof plan.replan_reason !== "string" ||
      plan.replan_reason.trim() === "" ||
      [...plan.replan_reason.trim()].length > 512)
  ) {
    return null
  }
  if (
    plan.last_write_activity_id !== undefined &&
    plan.last_write_activity_id !== null &&
    (typeof plan.last_write_activity_id !== "string" || plan.last_write_activity_id.trim() === "")
  ) {
    return null
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) return null

  const stepIDs = new Set<string>()
  const validSteps = plan.steps.every((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const step = value as Record<string, unknown>
    if (typeof step.step_id !== "string" || step.step_id.trim() === "" || stepIDs.has(step.step_id)) return false
    stepIDs.add(step.step_id)
    if (typeof step.title !== "string" || step.title.trim() === "") return false
    if (typeof step.status !== "string" || !planStatuses.has(step.status as PlanStepStatus)) return false
    if (step.acceptance !== undefined && step.acceptance !== null && typeof step.acceptance !== "string") return false
    if (step.assigned_agent !== undefined && step.assigned_agent !== null && typeof step.assigned_agent !== "string")
      return false
    if (step.note !== undefined && step.note !== null && typeof step.note !== "string") return false
    if (
      step.evidence !== undefined &&
      (!Array.isArray(step.evidence) || !step.evidence.every((item) => typeof item === "string"))
    ) {
      return false
    }
    if (step.status === "blocked" && (typeof step.note !== "string" || step.note.trim() === "")) return false
    return true
  })
  if (!validSteps) return null

  const active = plan.steps.filter((value) => (value as Record<string, unknown>).status === "active") as Record<
    string,
    unknown
  >[]
  if (active.length > 1) return null
  if (plan.active_step_id !== null && typeof plan.active_step_id !== "string") return null
  if (typeof plan.active_step_id === "string" && !stepIDs.has(plan.active_step_id)) return null
  if (plan.active_step_id === null && active.length > 0) return null
  if (typeof plan.active_step_id === "string" && active[0]?.step_id !== plan.active_step_id) return null
  return plan as PlanDoc
}

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
  return decodePlanDoc(doc.body)
}

// The doc id + current version for a session's plan (for the SessionRunState latch pointer), or null.
export const planDocRef = (sessionId: string): { id: string; version: number } | null => {
  const ref = resolveRef(sessionId)
  if (!ref) return null
  const doc = store(sessionId).get(ref.id)
  return doc ? { id: doc.id, version: doc.version } : null
}

export type PlanCompareAndCommitInput = {
  readonly sessionId: string
  readonly expected: PlanExpected | null
  readonly candidate: PlanDoc
  readonly origin: PlanWriteOrigin
}

export type PlanCompareAndCommitResult = {
  readonly plan: PlanDoc
  readonly doc_id: string
  readonly version: number
  readonly changed: boolean
}

const provenanceFor = (origin: PlanWriteOrigin, sessionId: string): Provenance => ({
  source: origin === "human_goal_edit" ? "human" : origin === "model_tool" ? "model" : "runner",
  run_ref: planScope(sessionId),
})

const currentPlanFromStore = (
  documentStore: DocumentStore,
  sessionId: string,
): { plan: PlanDoc; ref: { id: string; version: number } } | null => {
  const refs = documentStore.list({ type: "plan", scope: planScope(sessionId) })
  const ref = refs.length > 0 ? refs[0] : null
  if (!ref) return null
  const doc = documentStore.get(ref.id)
  if (!doc) return null
  const plan = decodePlanDoc(doc.body)
  if (!plan) return null
  return { plan, ref: { id: doc.id, version: doc.version } }
}

const actualExpected = (current: { plan: PlanDoc; ref: { id: string; version: number } } | null) =>
  current ? { plan_id: current.plan.plan_id, doc_id: current.ref.id, version: current.ref.version } : null

export const compareAndCommitPlanDocument = (
  documentStore: DocumentStore,
  input: PlanCompareAndCommitInput,
): PlanCompareAndCommitResult => {
  if (input.candidate.session_id !== input.sessionId || !decodePlanDoc(JSON.stringify(input.candidate))) {
    throw new PlanValidationError("invalid_precondition")
  }
  const current = currentPlanFromStore(documentStore, input.sessionId)
  const refs = documentStore.list({ type: "plan", scope: planScope(input.sessionId) })
  if (refs.length > 0 && current == null) {
    throw new PlanValidationError("invalid_precondition")
  }
  const actual = actualExpected(current)
  if (input.expected == null) {
    if (actual != null) throw new PlanConflictError(null, actual)
  } else if (
    actual == null ||
    actual.plan_id !== input.expected.plan_id ||
    actual.doc_id !== input.expected.doc_id ||
    actual.version !== input.expected.version
  ) {
    throw new PlanConflictError(input.expected, actual)
  }

  if (current && planProgressFingerprint(current.plan) === planProgressFingerprint(input.candidate)) {
    return { plan: current.plan, doc_id: current.ref.id, version: current.ref.version, changed: false }
  }

  try {
    // Existing plan documents may have been created by the pre-I33-1 goal path with a different
    // human-readable description. Preserve that document's logical identity while appending the
    // next version; otherwise DocumentStore.upsert() would allocate a second plan doc instead of
    // advancing the CAS-protected authority.
    const currentDoc = current ? documentStore.get(current.ref.id) : null
    const doc = documentStore.upsert({
      type: "plan",
      scope: planScope(input.sessionId),
      description: currentDoc?.description ?? planDescription(input.sessionId),
      idSlug: planSlug(input.sessionId),
      body: JSON.stringify(input.candidate),
      provenance: provenanceFor(input.origin, input.sessionId),
    })
    return { plan: input.candidate, doc_id: doc.id, version: doc.version, changed: true }
  } catch (error) {
    if (!(error instanceof DocumentConflictError)) throw error
    documentStore.rebuildIndex()
    const raced = currentPlanFromStore(documentStore, input.sessionId)
    throw new PlanConflictError(input.expected, actualExpected(raced))
  }
}

export const compareAndCommitPlan = (input: PlanCompareAndCommitInput): PlanCompareAndCommitResult =>
  compareAndCommitPlanDocument(store(input.sessionId), input)

// Write (create or new-version) the structural plan for legacy callers. It retains the historical API
// shape, but still goes through strict structural decode, session binding, and a synchronous CAS. The
// semantic admission layer remains the responsibility of production writers before they call this
// compatibility seam; malformed or cross-session candidates are rejected at this final boundary.
export const setPlanDoc = (sessionId: string, plan: PlanDoc): { id: string; version: number } => {
  if (plan.session_id !== sessionId || !decodePlanDoc(JSON.stringify(plan))) {
    throw new PlanValidationError("invalid_precondition")
  }
  const current = getPlanDoc(sessionId)
  const currentRef = planDocRef(sessionId)
  const committed = compareAndCommitPlanDocument(store(sessionId), {
    sessionId,
    expected:
      current && currentRef ? { plan_id: current.plan_id, doc_id: currentRef.id, version: currentRef.version } : null,
    candidate: plan,
    origin: "legacy_migration",
  })
  return { id: committed.doc_id, version: committed.version }
}
