import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import type { EvidenceStrength } from "./document-store"

// docs/34 §3.1/§4 — DomainPackRegistry: discover manifests on disk, score them against a
// ProblemProfile, resolve dependencies/conflicts, and lock a versioned snapshot so every run can
// reproduce the exact pack set that was active. core does NOT import concrete packs; they register
// themselves as data files (pack.json) under a configurable pack directory (DAP-1).

export type PackScope = "system" | "organization" | "project" | "session"
export type RiskLevel = "low" | "medium" | "high" | "regulated"

export type PackManifest = {
  readonly schema_version: "domain_pack.v1"
  readonly id: string // e.g. "code.frontend.react"
  readonly name: string
  readonly description?: string // one-line human summary shown in the packs UI
  readonly version: string
  readonly scope: PackScope
  readonly risk: RiskLevel
  readonly domains: readonly string[]
  readonly provides: readonly string[]
  readonly depends_on?: readonly string[]
  readonly conflicts_with?: readonly string[]
  readonly detector?: {
    // Inline JS detector expression OR a path to an adapter .ts file (for complex detectors).
    // Inline format: an expression returning a [0,1] score given { domain, backend, languages,
    // frameworks, signals, task_kind, business_domains, risk_markers }.
    readonly inline?: string
    readonly threshold?: number
  }
  readonly knowledge_store?: "document_store"
  readonly allowed_tools?: readonly string[]
  readonly denied_tools?: readonly string[]
}

export type DomainPackIndexEntry = {
  readonly ref_id: string
  readonly type: "knowledge" | "strategy" | "methodology" | "skill" | "memory" | "failure_dossier"
  readonly title: string
  readonly summary: string
  readonly domains: readonly string[]
  readonly triggers: readonly string[]
  readonly scope: PackScope
  readonly evidence_strength: EvidenceStrength
  readonly risk: RiskLevel
  readonly sensitivity: "public" | "source_code" | "pii" | "secret_adjacent" | "secret"
  readonly allowed_strengths: readonly ("high" | "xhigh" | "max" | "ultra")[]
  readonly pack_id: string
}

export type PackConflict = {
  readonly kind: "policy" | "knowledge" | "skill" | "tool" | "data"
  readonly refs: readonly string[]
  readonly severity: "block" | "warn"
  readonly resolution: "stricter_policy_wins" | "human_required" | "deny"
  readonly packs: readonly string[]
}

export type PackResolution = {
  readonly activePackIds: readonly string[]
  readonly transitiveDeps: readonly string[] // all packs including resolved dependencies
  readonly conflicts: readonly PackConflict[]
  readonly denied: readonly { readonly packId: string; readonly reason: string }[]
}

export type PackSnapshot = {
  readonly id: string // deterministic hash of sorted activePackIds+versions
  readonly packs: readonly { readonly id: string; readonly version: string }[]
  readonly created_at: string
}

export type PackScore = {
  readonly packId: string
  readonly score: number // [0,1] from the pack's detector
  readonly evidence: readonly string[]
}

// The extended ProblemProfile used by the registry for multi-dimensional pack scoring.
// docs/34 §4.1. The simpler profile in domain-pack.ts is retained for backward compat.
export type ExtendedProblemProfile = {
  readonly scenario_mode: "direct" | "wish"
  readonly agent_strength: "general" | "high" | "xhigh" | "max" | "ultra"
  readonly task_kind: "implement" | "debug" | "review" | "test" | "migrate" | "optimize" | "explain" | "operate"
  readonly code_domains: readonly string[]
  readonly business_domains: readonly string[]
  readonly platforms: readonly string[]
  readonly languages: readonly string[]
  readonly frameworks: readonly string[]
  readonly data_classes: readonly string[]
  readonly risk_markers: readonly string[]
  readonly repo_signals: readonly string[]
  readonly round_signals: readonly string[]
  readonly user_overrides: readonly string[]
}

// Evaluate a pack's inline detector expression safely (sandboxed via Function constructor).
// Returns 0 on any error so a broken detector is a miss, never a crash.
const evalInlineDetector = (expr: string, profile: ExtendedProblemProfile): number => {
  try {
    // The expression receives `profile` in scope and must return a number in [0,1].
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function("profile", `"use strict"; return (${expr})`)
    const result = fn(profile)
    if (typeof result !== "number" || !isFinite(result)) return 0
    return Math.max(0, Math.min(1, result))
  } catch {
    return 0
  }
}

// Resolve the built-in pack directory bundled with the application.
// Source/dist server code resolves via the first candidate; Electron's desktop bundle executes from
// packages/desktop/out/main/chunks, which needs the second candidate to reach packages/domain-packs.
export const resolveBuiltinPackDirForMetaUrl = (metaUrl: string): string | null => {
  try {
    return (
      [
        path.resolve(fileURLToPath(metaUrl), "../..", "domain-packs"),
        path.resolve(fileURLToPath(metaUrl), "../../../..", "domain-packs"),
        path.resolve(fileURLToPath(metaUrl), "../../../../../", "domain-packs"),
      ].find((dir) => existsSync(dir)) ?? null
    )
  } catch {
    return null
  }
}

const builtinPackDir = (): string | null => resolveBuiltinPackDirForMetaUrl(import.meta.url)

// Multi-source registry: a list of directories, searched in order. Built-in packs (bundled with
// the app) are always appended automatically so the 9 seed packs in packages/domain-packs/ are
// discoverable without requiring the caller to set DEEPAGENT_PACK_DIR. Later entries with the same
// pack id are silently skipped (first-write wins, so user dirs can override built-ins).
const registryDirs: string[] = []

export const configureRegistry = (userDir?: string): void => {
  registryDirs.length = 0 // reset on each configure() call
  if (userDir) registryDirs.push(userDir)
  const builtin = builtinPackDir()
  if (builtin && builtin !== userDir) registryDirs.push(builtin)
}

export const isRegistryConfigured = (): boolean => registryDirs.length > 0

const dirsToScan = (): readonly string[] =>
  registryDirs.length > 0 ? registryDirs : ([builtinPackDir()].filter(Boolean) as string[])

// TEMP DEBUG: expose the resolved scan dirs + builtin dir so the server can log why discover() is
// empty in the desktop/dist runtime. Remove once the packs-empty issue is diagnosed.
export const dirsToScanDebug = (): { dirs: readonly string[]; builtin: string | null; metaUrl: string } => ({
  dirs: dirsToScan(),
  builtin: builtinPackDir(),
  metaUrl: import.meta.url,
})

const PACK_SCHEMA = "domain_pack.v1"
export const discover = (): readonly PackManifest[] => {
  const seen = new Set<string>() // first-seen wins (user dirs override built-ins by pack id)
  const results: PackManifest[] = []
  const scan = (d: string): void => {
    if (!existsSync(d)) return
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const sub = path.join(d, entry.name)
      const packFile = path.join(sub, "pack.json")
      if (existsSync(packFile)) {
        try {
          const m = JSON.parse(readFileSync(packFile, "utf8")) as PackManifest
          if (m.schema_version === PACK_SCHEMA && m.id && m.version && !seen.has(m.id)) {
            seen.add(m.id)
            results.push(m)
          }
        } catch {
          /* malformed — skip */
        }
      } else {
        scan(sub) // recurse one level (category/pack-id/)
      }
    }
  }
  for (const dir of dirsToScan()) scan(dir)
  return results
}

export const score = (profile: ExtendedProblemProfile, manifests?: readonly PackManifest[]): readonly PackScore[] => {
  const packs = manifests ?? discover()
  return packs.map((m) => {
    let s = 0
    if (m.detector?.inline) {
      s = evalInlineDetector(m.detector.inline, profile)
    } else {
      // Default scoring: match on domains / languages / risk_markers
      const domains = new Set([...m.domains, ...(m.provides ?? [])])
      const inLanguages = m.domains.some((d) => profile.languages.includes(d))
      const inCode = m.domains.some((d) => profile.code_domains.includes(d))
      const inBusiness = m.domains.some((d) => profile.business_domains.includes(d))
      const inRisk = m.domains.some((d) => profile.risk_markers.includes(d))
      if (inLanguages || inCode) s = Math.max(s, 0.7)
      if (inBusiness) s = Math.max(s, 0.8)
      if (inRisk) s = Math.max(s, 0.9)
    }
    return { packId: m.id, score: s, evidence: [] }
  })
}

// Resolve a selected set of pack IDs: expand transitive deps, detect conflicts.
// More restrictive policy always wins (docs/34 §4.3).
export const resolve = (selected: readonly string[], manifests?: readonly PackManifest[]): PackResolution => {
  const packs = manifests ?? discover()
  const byId = new Map(packs.map((p) => [p.id, p]))
  const active = new Set(selected)
  const conflicts: PackConflict[] = []
  const denied: { packId: string; reason: string }[] = []

  // Expand deps transitively (BFS)
  const queue = [...selected]
  while (queue.length > 0) {
    const id = queue.shift()!
    const m = byId.get(id)
    if (!m) {
      denied.push({ packId: id, reason: "manifest not found" })
      continue
    }
    for (const dep of m.depends_on ?? []) {
      if (!active.has(dep)) {
        active.add(dep)
        queue.push(dep)
      }
    }
  }

  // Detect conflicts
  for (const id of active) {
    const m = byId.get(id)
    if (!m) continue
    for (const conflictId of m.conflicts_with ?? []) {
      if (active.has(conflictId)) {
        // Risk level determines severity: high/regulated conflict is a block
        const severity: "block" | "warn" = m.risk === "high" || m.risk === "regulated" ? "block" : "warn"
        conflicts.push({
          kind: "policy",
          refs: [],
          severity,
          resolution: severity === "block" ? "stricter_policy_wins" : "human_required",
          packs: [id, conflictId],
        })
        if (severity === "block") active.delete(conflictId)
      }
    }
  }

  return {
    activePackIds: [...active].sort(),
    transitiveDeps: [...active].sort(),
    conflicts,
    denied,
  }
}

// Lock a versioned snapshot from a resolved pack set. The snapshot id is a deterministic SHA-256
// hash of sorted `<id>@<version>` strings, so the same pack set always yields the same snapshot id.
export const lockSnapshot = (packIds: readonly string[], manifests?: readonly PackManifest[]): PackSnapshot => {
  const packs = manifests ?? discover()
  const byId = new Map(packs.map((p) => [p.id, p]))
  const entries = [...packIds].sort().map((id) => ({
    id,
    version: byId.get(id)?.version ?? "unknown",
  }))
  const hashInput = entries.map((e) => `${e.id}@${e.version}`).join("|")
  const id = `pack_snapshot:${createHash("sha256").update(hashInput).digest("hex").slice(0, 16)}`
  return { id, packs: entries, created_at: new Date().toISOString() }
}

// Load the index entries for all active packs in a snapshot (lazy loading — only the index, not
// body/skill content). Reads `index.json` files from each pack's directory (docs/34 §3.2).
export const loadIndexRefs = (snapshot: PackSnapshot): readonly DomainPackIndexEntry[] => {
  const refs: DomainPackIndexEntry[] = []
  for (const { id } of snapshot.packs) {
    const packDir = findPackDir(id)
    if (!packDir) continue
    const indexFile = path.join(packDir, "index.json")
    if (!existsSync(indexFile)) continue
    try {
      const entries = JSON.parse(readFileSync(indexFile, "utf8")) as DomainPackIndexEntry[]
      refs.push(...entries.filter((e) => e.pack_id === id))
    } catch {
      /* malformed — skip */
    }
  }
  return refs
}

// Find the directory containing a pack.json with the given id, scanning all registered source dirs.
const findPackDir = (packId: string): string | null => {
  for (const base of dirsToScan()) {
    const found = findPackDirUnder(base, packId)
    if (found) return found
  }
  return null
}

const findPackDirUnder = (dir: string, packId: string): string | null => {
  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const sub = path.join(dir, entry.name)
    const packFile = path.join(sub, "pack.json")
    if (existsSync(packFile)) {
      try {
        const m = JSON.parse(readFileSync(packFile, "utf8")) as { id?: string }
        if (m.id === packId) return sub
      } catch {
        /* skip */
      }
    }
    // recurse one level
    for (const sub2 of readdirSync(sub, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const subDir = path.join(sub, sub2.name)
      const f = path.join(subDir, "pack.json")
      if (existsSync(f)) {
        try {
          const m = JSON.parse(readFileSync(f, "utf8")) as { id?: string }
          if (m.id === packId) return subDir
        } catch {
          /* skip */
        }
      }
    }
  }
  return null
}

// Convenience: activate packs for a profile, returning the snapshot + index refs. This is the
// single call the retriever/gateway makes at run start (docs/34 §4.2 activation flow step 1-6).
export const activateForProfile = (
  profile: ExtendedProblemProfile,
  threshold = 0.5,
  manifests?: readonly PackManifest[],
): { snapshot: PackSnapshot; indexRefs: readonly DomainPackIndexEntry[]; resolution: PackResolution } => {
  const packs = manifests ?? discover()
  const scores = score(profile, packs)
  const selected = scores.filter((s) => s.score >= threshold).map((s) => s.packId)
  // Honor user overrides (pinned packs always included)
  for (const override of profile.user_overrides) {
    if (!selected.includes(override)) selected.push(override)
  }
  const resolution = resolve(selected, packs)
  const snapshot = lockSnapshot(resolution.activePackIds, packs)
  const indexRefs = loadIndexRefs(snapshot)
  return { snapshot, indexRefs, resolution }
}
