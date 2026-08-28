/**
 * Inventory builder: extract -> classify -> totals -> machine-readable report.
 *
 * The same base tree always produces a byte-identical report (stable ordering,
 * no timestamps), so re-running the gate detects denominator drift as a diff.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { rootRepoPath } from "./ast"
import { OPEN_OWNER_REASON, rulesForEntry, type VerdictRule } from "./declarations"
import { verifyRequirements } from "./graph"
import { EXTERNAL_RECEIVERS, PORTS } from "./authority"
import { extractAllEntries } from "./extractors"
import {
  DIMENSIONS,
  SURFACE_IDS,
  VERDICTS,
  type ClassifiedEntry,
  type Dimension,
  type EntryWithHandlers,
  type Evidence,
  type Inventory,
  type RoleClassification,
  type SurfaceId,
  type Verdict,
} from "./types"

function repoRelative(hit: { readonly file: string; readonly line: number; readonly marker: string }): Evidence {
  const root = rootRepoPath()
  return { repoFile: hit.file.slice(root.length + 1).replaceAll("\\", "/"), line: hit.line, marker: hit.marker, distance: 0 }
}

/** Pending delegation edges recorded per entry/dimension during pass-1 classification. */
type PendingDelegation = { readonly targetId: string; readonly edge: Evidence }
const pendingDelegations = new Map<string, Partial<Record<Dimension, PendingDelegation>>>()

function classifyOne(item: EntryWithHandlers): ClassifiedEntry {
  const rules = rulesForEntry(item.entry.id)
  const roles: RoleClassification[] = []
  const openOwners: Partial<Record<Dimension, string>> = {}
  const entryFile = join(rootRepoPath(), item.entry.repoFile)
  // Structurally linked handler modules join the entry's verification roots; the
  // registered `.handle` sites define this entry's own handler-body scope.
  const extraRoots = [...new Set(item.handlers.map((handler) => join(rootRepoPath(), handler.repoFile)))]
  for (const dimension of DIMENSIONS) {
    const rule: VerdictRule | undefined = rules[dimension]
    if (!rule) {
      roles.push({ dimension, verdict: "unclassified", evidence: [] })
      openOwners[dimension] = OPEN_OWNER_REASON
      continue
    }
    const verified = verifyRequirements(entryFile, rule.requirements, {
      ...(extraRoots.length > 0 ? { extraRoots } : {}),
      ...(item.handlers.length > 0 ? { bodies: item.handlers } : {}),
    })
    const delegationReq = rule.requirements.find((requirement): requirement is { kind: "delegatesTo"; targetId: string } => requirement.kind === "delegatesTo")
    const portReq = rule.requirements.find((requirement): requirement is { kind: "portBoundTo"; portModule: string } => requirement.kind === "portBoundTo")
    const portTargetId = portReq ? PORTS[portReq.portModule]?.providerEntryId : undefined
    if (verified.satisfied) {
      if (delegationReq || portReq) {
        // Record a pending delegation/port edge; buildInventory resolves the inherited verdict in pass 2.
        const targetId = delegationReq ? delegationReq.targetId : portTargetId!
        const marker = delegationReq ? ("delegates:" + targetId) : ("portBound:" + targetId)
        const edge = verified.evidence
          .map(repoRelative)
          .find((proof) => proof.marker === marker) ?? verified.evidence.map(repoRelative)[0]
        const per = pendingDelegations.get(item.entry.id) ?? {}
        per[dimension] = { targetId, edge }
        pendingDelegations.set(item.entry.id, per)
        roles.push({ dimension, verdict: "unclassified", evidence: [] })
        openOwners[dimension] = "port-bound/delegates to " + targetId + " (resolved in pass 2)"
        continue
      }
      roles.push({ dimension, verdict: rule.verdict, evidence: verified.evidence.map(repoRelative) })
      continue
    }
    const unmet = verified.results
      .filter((result) => !result.hit)
      .map((result) => result.requirement.kind)
      .sort()
    openOwners[dimension] = `${OPEN_OWNER_REASON}; unmet static requirements: ${unmet.join(", ")}`
    roles.push({ dimension, verdict: "unclassified", evidence: [] })
  }
  const unclassifiedCount = roles.filter((role) => role.verdict === "unclassified").length
  const externalReceiver = EXTERNAL_RECEIVERS[item.entry.id]
  return {
    entry: item.entry,
    handlers: item.handlers,
    roles,
    unclassifiedCount,
    ...(externalReceiver ? { externalReceiver } : {}),
    ...(unclassifiedCount > 0 ? { openOwners } : {}),
  }
}

export function buildInventory(): Inventory {
  const { entries, missingAnchors } = extractAllEntries()
  if (missingAnchors.length > 0) {
    throw new Error(`frozen composition anchors missing from the working tree: ${missingAnchors.join(", ")}`)
  }
  if (!entries.some((item) => item.entry.surface === "http") || entries.length === 0) {
    throw new Error("production universe extraction produced an empty or HTTP-less universe")
  }

  pendingDelegations.clear()
  const classified = entries
    .map(classifyOne)
    .sort((a, b) => (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0))

  // Pass 2 (delegation model): an entry with a verified delegatesTo edge inherits the TARGET entry's
  // verdict on that dimension (rollup evidence = delegation edge + target's own proof chain). The gate
  // refuses a delegation to an unknown or unclassified target (a finding, never a guess).
  const byId = new Map(classified.map((entry) => [entry.entry.id, entry]))
  // Fixed-point: delegation chains (app-main -> spawn-local-server -> dacode-cli-entry) require
  // resolving receivers before their dependents. Repeat until no entry changes in a full pass.
  let progress = true
  while (progress) {
    progress = false
  for (const entry of classified) {
    const per = pendingDelegations.get(entry.entry.id)
    if (!per) continue
    let un = entry.unclassifiedCount
    let entryChanged = false
    const ownOpen = entry.openOwners as Record<string, string> | undefined
    for (const [dimension, pending] of Object.entries(per)) {
      const dim = dimension as Dimension
      const target = byId.get(pending.targetId)
      const targetRole = target?.roles.find((role) => role.dimension === dim)
      if (!target || !targetRole || targetRole.verdict === "unclassified") {
        if (ownOpen) ownOpen[dim] = "delegation target " + pending.targetId + " is unclassified/unknown on " + dim
        continue
      }
      const role = entry.roles.find((candidate) => candidate.dimension === dim)
      if (role && role.verdict === "unclassified") {
        const mutable = role as { verdict: string; evidence: typeof role.evidence }
        mutable.verdict = targetRole.verdict
        mutable.evidence = [pending.edge, ...targetRole.evidence]
        if (ownOpen) delete ownOpen[dim]
        un -= 1
        entryChanged = true
      }
    }
    if (entryChanged) {
      ;(entry as { unclassifiedCount: number }).unclassifiedCount = un
      if (un === 0 && entry.openOwners) (entry as { openOwners?: undefined }).openOwners = undefined
      progress = true
    }
  }
  }

  const byVerdict = Object.fromEntries(VERDICTS.map((verdict) => [verdict, 0])) as Record<Verdict, number>
  const bySurface = Object.fromEntries(SURFACE_IDS.map((surface) => [surface, 0])) as Record<SurfaceId, number>
  let unclassifiedRoles = 0
  let unclassifiedEntries = 0
  for (const item of classified) {
    bySurface[item.entry.surface] = (bySurface[item.entry.surface] ?? 0) + 1
    for (const role of item.roles) {
      byVerdict[role.verdict] += 1
      if (role.verdict === "unclassified") unclassifiedRoles += 1
    }
    if (item.unclassifiedCount > 0) unclassifiedEntries += 1
  }

  return {
    baseCommit: gitHead(),
    entries: classified,
    totals: {
      entries: classified.length,
      unclassifiedEntries,
      unclassifiedRoles,
      byVerdict,
      bySurface,
    },
  }
}

let cachedHead: string | undefined

function gitHead(): string {
  if (cachedHead) return cachedHead
  cachedHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  return cachedHead
}

/** Stable JSON: deep-clone with object keys sorted at every level before serializing. */
export function sortedStableStringify(value: unknown, indent?: number | string): string {
  const ordered = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(ordered)
      : input && typeof input === "object"
        ? Object.fromEntries(
            Object.entries(input as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, nested]) => [key, ordered(nested)]),
          )
        : input
  return JSON.stringify(ordered(value), null, indent)
}

/** High-level rollup that highlights unclassified owners without dumping all evidence. */
export function summarize(inventory: Inventory) {
  const unclassifiedList = inventory.entries
    .filter((item) => item.unclassifiedCount > 0)
    .map((item) => ({
      id: item.entry.id,
      surface: item.entry.surface,
      location: `${item.entry.repoFile}:${item.entry.line}`,
      open_owners: Object.fromEntries(
        DIMENSIONS.filter((dimension) => item.openOwners?.[dimension] !== undefined).map((dimension) => [
          dimension,
          item.openOwners![dimension],
        ]),
      ),
    }))
  return {
    base_commit: inventory.baseCommit,
    totals: inventory.totals,
    surfaces_missing_from_universe: SURFACE_IDS.filter(
      (surface) => !inventory.entries.some((item) => item.entry.surface === surface),
    ),
    double_write_entries: inventory.entries
      .filter((item) => item.roles.some((role) => role.verdict === "double_write"))
      .map((item) => item.entry.id),
    legacy_owner_entries: inventory.entries
      .filter((item) => item.roles.some((role) => role.verdict === "legacy"))
      .map((item) => item.entry.id),
    v2_owner_entries: inventory.entries
      .filter((item) => item.roles.some((role) => role.verdict === "v2"))
      .map((item) => item.entry.id),
    unclassified_count: unclassifiedList.length,
    unclassified: unclassifiedList,
  }
}

export function writeReport(outDir: string): { jsonPath: string; summaryPath: string; inventory: Inventory } {
  const inventory = buildInventory()
  mkdirSync(outDir, { recursive: true })
  const jsonPath = join(outDir, "report.json")
  const summaryPath = join(outDir, "summary.json")
  writeFileSync(jsonPath, `${sortedStableStringify({ ...inventory }, 2)}\n`)
  writeFileSync(summaryPath, `${sortedStableStringify(summarize(inventory), 2)}\n`)
  return { jsonPath, summaryPath, inventory }
}
