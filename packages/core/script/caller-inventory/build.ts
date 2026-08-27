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
    // C0-01 honesty (F5): read_only may never be absence-only. Prepend a POSITIVE read-side
    // requirement: the entry's own reader/query/schema module (its repoFile) must be reachable,
    // so a read_only verdict always carries a positive read fact in addition to the absence
    // proofs of the writer families declared by the rule. This keeps delegators/spawners honest
    // too — a spawner whose own module merely launches a process is not a reader and must instead
    // be classified by delegation or left unclassified.
    const requirementsFor =
      rule.verdict === "read_only"
        ? [{ kind: "reach" as const, pathSuffix: item.entry.repoFile }, ...rule.requirements]
        : rule.requirements
    const verified = verifyRequirements(entryFile, requirementsFor, {
      ...(extraRoots.length > 0 ? { extraRoots } : {}),
      ...(item.handlers.length > 0 ? { bodies: item.handlers } : {}),
    })
    if (verified.satisfied) {
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
  return {
    entry: item.entry,
    handlers: item.handlers,
    roles,
    unclassifiedCount,
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

  const classified = entries
    .map(classifyOne)
    .sort((a, b) => (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0))

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
