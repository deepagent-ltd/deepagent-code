export * as PathAcl from "./path-acl"

import { isAbsolute, relative, resolve as pathResolve, sep } from "path"

// V4.0 §E3 — the FILE-PATH ACL. A PURE, deterministic containment check: given a set of allowed
// workspace roots and a candidate path, decide whether the candidate resolves to somewhere INSIDE one
// of those roots. This is the "文件路径权限" leg of §E3 that ContentSafety.scrub deliberately punts to the
// caller (content-safety.ts line ~13) — it lives here so both the scrubber and the agent-push path
// (packages/deepagent-code/src/session/agent-push.ts ~line 82) can share ONE fail-closed policy.
//
// LAYERING: lives in `core` and imports only node `path` — no FS IO, no config store. Containment is
// decided LEXICALLY after `path.resolve` collapses `.`/`..` segments, so traversal (`../../etc/passwd`),
// absolute escapes (`/etc/passwd`), and home-dir escapes (`~` expanded by the caller, or an absolute
// `/Users/...` outside a root) are all rejected without touching the filesystem. True symlink
// resolution (realpath) is an IO concern the caller layers on when it matters; this stays pure/testable.

// Collapse `.`/`..` and compare: is `child` the same as, or nested under, `parent`? Mirrors
// FSUtil.contains but is inlined here to keep this module's dependency surface to node `path` only
// (FSUtil pulls in the platform FS layer, which a pure ACL check must not drag in).
const contains = (parent: string, child: string): boolean => {
  const rel = relative(parent, child)
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
}

/**
 * §E3 — is `candidate` allowed, i.e. does it resolve to WITHIN one of `allowedRoots`?
 *
 * Fail-closed: an EMPTY `allowedRoots` allows nothing. An ABSOLUTE candidate is resolved on its own and
 * must land inside some root. A RELATIVE candidate is resolved against EACH root in turn (so
 * workspace-relative paths like `src/app.ts` are allowed, while `../../etc/passwd` collapses to outside
 * every root and is rejected). Roots are `path.resolve`d first so relative roots are handled too.
 */
export const isPathAllowed = (candidate: string, allowedRoots: ReadonlyArray<string>): boolean => {
  if (allowedRoots.length === 0) return false
  if (candidate.length === 0) return false
  const abs = isAbsolute(candidate)
  for (const root of allowedRoots) {
    const normRoot = pathResolve(root)
    // absolute candidate: resolve standalone. relative candidate: resolve UNDER this root (so `..`
    // that climbs above the root collapses to a path `contains` then rejects).
    const resolved = abs ? pathResolve(candidate) : pathResolve(normRoot, candidate)
    if (contains(normRoot, resolved)) return true
  }
  return false
}
