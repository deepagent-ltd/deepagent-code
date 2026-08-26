// V3.8.1 §G environment-fact fast path. The principle (§G.2): for a fact that is VERIFIABLE,
// NON-DIRECTIVE and DESENSITIZED, move the human checkpoint from the WRITE gate to the USE gate —
// write it cheaply to user-global `provisional` without gate-7 review, then let each project decide
// at first use whether to adopt it. This module is the pure decision + transform layer; the durable
// write/read wiring lives in durable-knowledge-store.ts and the use-gate in the retriever/handlers.
//
// Hard boundary (§G.8): credentials NEVER enter any memory. `desensitize` strips them and, if any
// residual sensitivity remains after stripping, the fact FAILS CLOSED back to human review — the
// fast path is only ever taken for a provably credential-free fact.
//
// Scope: environment_fact is the ONLY type on this path. strategy/methodology/anti_pattern still go
// through the existing gate 5/6/7 human review (they steer the agent; cross-project auto-share would
// mislead), so this module deliberately has no entry point for them.

// Reuse the SAME sensitivity detectors as memory-governance gate 1 (single source of truth): keyword
// signals plus literal credential-VALUE patterns. Kept here as local copies intentionally decoupled
// would drift — instead we import the canonical ones.
import { looksSensitive } from "./memory-governance"

// Credential VALUE patterns we can mechanically STRIP (a superset-safe subset of the gate-1 value
// patterns — only the ones that identify a concrete secret token to excise, plus the userinfo of a
// connection URL). After stripping we re-run looksSensitive; anything it still flags fails closed.
const STRIP_PATTERNS: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack token
  /\bsk-[A-Za-z0-9]{20,}\b/g, // OpenAI-style key
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, // PEM block
]

// scheme://user:pass@host -> scheme://host, capturing the userinfo so we can mint a secret_ref.
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s:@]+@/gi

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "cred"

export type DesensitizeResult =
  | {
      // Cleanly desensitized: safe to take the fast path.
      readonly ok: true
      readonly sanitized: string
      readonly secretRefs: readonly string[] // vault pointers minted for stripped credentials
    }
  | {
      // Residual sensitivity after stripping — FAIL CLOSED, route to human review (§G.4 step 2).
      readonly ok: false
      readonly reason: "residual_sensitive"
    }

// Strip every mechanically-excisable credential from `raw`, minting a `secret:<slug>` pointer for
// each. Then re-scan the result: if ANY sensitivity signal remains (a keyword like "password" with a
// value we couldn't structurally strip, an unrecognized token shape), fail closed. A clean result
// carries the sanitized text and the set of secret refs to persist in place of the values.
export const desensitize = (raw: string, label = "env"): DesensitizeResult => {
  const secretRefs: string[] = []
  let out = raw

  out = out.replace(URL_USERINFO, (_m, scheme: string) => {
    const ref = `secret:${slug(label)}-url-cred`
    if (!secretRefs.includes(ref)) secretRefs.push(ref)
    return scheme
  })

  for (const pattern of STRIP_PATTERNS) {
    out = out.replace(pattern, () => {
      const ref = `secret:${slug(label)}-${secretRefs.length + 1}`
      secretRefs.push(ref)
      return ref
    })
  }

  // Fail closed on any residual signal (keyword patterns like "password: hunter2" that carry a value
  // we can't structurally identify, or a stripped-but-still-flagged remnant).
  if (looksSensitive(out)) return { ok: false, reason: "residual_sensitive" }

  return { ok: true, sanitized: out, secretRefs }
}

// Structured body of an environment_fact. Credentials are represented ONLY by secret_ref pointers;
// the concrete values live in a vault out of band and are never persisted here (§G.8).
export type EnvironmentFactBody = {
  readonly host?: string
  readonly port?: number
  readonly container?: string
  readonly purpose?: string
  readonly secret_refs?: readonly string[]
  readonly last_confirmed_at: string // ISO — shown at the use-gate so a human can judge staleness (§G.6)
  readonly notes?: string
}

// A candidate environment fact as declared explicitly (§G.7 decision 1: explicit-only in V3.8.1; no
// learning-extractor auto-classification yet).
export type EnvironmentFactCandidate = {
  readonly description: string // one-line summary shown at the use-gate
  readonly body: EnvironmentFactBody
  readonly domain?: string | null
}

export type FastPathDecision =
  | { readonly kind: "fast_path"; readonly sanitizedBody: EnvironmentFactBody; readonly secretRefs: readonly string[] }
  | { readonly kind: "review"; readonly reason: "residual_sensitive" }

// The write-side routing (§G.4): desensitize the free-text-bearing fields; on a clean result the fact
// takes the fast path (auto-admit to user-global provisional); on residual sensitivity it fails
// closed to human review. Pure — the caller performs the actual durable write.
export const decideFastPath = (candidate: EnvironmentFactCandidate): FastPathDecision => {
  // Only free-text-bearing fields can carry a leaked credential; host/port/container are structured.
  const scanTarget = [candidate.description, candidate.body.notes ?? "", candidate.body.purpose ?? ""].join("\n")
  const label = candidate.body.container ?? candidate.body.host ?? "env"
  const result = desensitize(scanTarget, label)
  if (!result.ok) return { kind: "review", reason: result.reason }

  // Merge any minted refs with explicitly-declared ones (dedup).
  const secretRefs = [...new Set([...(candidate.body.secret_refs ?? []), ...result.secretRefs])]
  const sanitizedBody: EnvironmentFactBody = {
    ...candidate.body,
    ...(secretRefs.length > 0 ? { secret_refs: secretRefs } : {}),
  }
  return { kind: "fast_path", sanitizedBody, secretRefs }
}

// --- Use-gate adoption model (§G.5) ------------------------------------------------------------
// The decision is per (project × fact). A project's stance toward a provisional global fact is one of:
//   unseen   -> the use-gate must ASK (first encounter)
//   adopted  -> silently usable in this project (never ask again)
//   rejected -> never ask again in this project (does NOT affect other projects)
export type AdoptionStance = "unseen" | "adopted" | "rejected"

export type AdoptionRecord = {
  readonly fact_id: string // the global provisional doc id
  readonly stance: Exclude<AdoptionStance, "unseen">
  readonly decided_at: string
  readonly adopted_version?: number // the fact version the project pinned (adoption only)
  readonly override_doc_id?: string // set when the user chose project-local override on modify (§G.5)
}

// Given a project's adoption records, decide what the use-gate should do for a provisional fact.
// Pure: the caller supplies the records; this returns the action. Unknown fact -> ask.
export const useGateAction = (
  factId: string,
  records: readonly AdoptionRecord[],
): { readonly action: "use" | "ask" | "skip"; readonly overrideDocId?: string } => {
  const rec = records.find((r) => r.fact_id === factId)
  if (!rec) return { action: "ask" }
  if (rec.stance === "rejected") return { action: "skip" }
  return rec.override_doc_id ? { action: "use", overrideDocId: rec.override_doc_id } : { action: "use" }
}

// --- Connection-failure -> stale matcher (§G.6) ------------------------------------------------
// When an adopted environment fact is used and the connection fails, mark it stale so the next
// project's use-gate shows a "last connect failed" warning. This is the PURE matcher: given a
// failure signal (an error string / attempted endpoint) and the set of facts a project has adopted
// (with their host/port), return the fact ids whose endpoint appears in the failure. The runtime
// hook that observes tool/connection errors calls this, then persists via markEnvironmentFactStale.
export type AdoptedEndpoint = { readonly fact_id: string; readonly host?: string; readonly port?: number }

// A connection-shaped failure: heuristics kept deliberately conservative (we only ever DEGRADE a
// fact, never delete it, and a project can re-adopt), so a false positive is low-cost.
const CONNECTION_ERROR_SIGNAL =
  /\b(ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|ENETUNREACH|connection refused|connection timed out|could not connect|failed to connect|no route to host)\b/i

export const matchStaleFacts = (failureText: string, adopted: readonly AdoptedEndpoint[]): readonly string[] => {
  if (!CONNECTION_ERROR_SIGNAL.test(failureText)) return []
  const hay = failureText.toLowerCase()
  const out: string[] = []
  for (const ep of adopted) {
    if (!ep.host) continue
    const host = ep.host.toLowerCase()
    // Require the host to appear; if a port is known, require it too (host:port or host …:port).
    if (!hay.includes(host)) continue
    if (ep.port !== undefined && !hay.includes(String(ep.port))) continue
    out.push(ep.fact_id)
  }
  return [...new Set(out)]
}
