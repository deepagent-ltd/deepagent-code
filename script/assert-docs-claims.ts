#!/usr/bin/env bun
/**
 * K-05/B-11 machine check for the claims recorded in release evidence products.
 *
 *   bun script/assert-docs-claims.ts [evidence-file-or-dir...]
 *
 * Always-on assertion (no evidence files needed):
 *   - the deterministic source manifest regenerates from the live tree and matches
 *     the recorded HEAD pin (`packages/core/script/manifest-digest/head-pin.ts`).
 *
 * Per evidence file (explicit args, or discovered under `release-evidence/` plus
 * `release-evidence-manifest.json` / `authoritative-ledger.json` at the repo root;
 * directories are walked for *.json):
 *   - `manifest-digest.v1`: internal digest consistency (set tree / overall digest
 *     recompute from the recorded inputs), and every tree-bound input file exists
 *     with a matching content hash — a recorded claim about a file that no longer
 *     matches fails here.
 *   - `evidence-manifest.v1`: schema decode + authoritative shape (G0–G8 complete
 *     and ordered, passed gates carry evidence refs). When the manifest names the
 *     current HEAD commit, every file-backed digest (event schema, provider
 *     profiles, runtime flags, OpenAPI/SDK, capability catalog) is recomputed from
 *     the live tree and must match.
 *   - `authoritative-evidence-ledger.v1`: full cross-check (manifest digest, ledger
 *     digest, evidence ref uniqueness/ordering) plus the nested manifest checks.
 *   - other schemaVersions (e.g. runtime-integrity evidence artifacts that share
 *     the evidence dir) are reported and skipped — this gate checks manifest-level
 *     claims, not per-run artifacts.
 *
 * Exits 1 listing every violated claim.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { HeadPin } from "../packages/core/script/manifest-digest/head-pin"
import {
  assertManifestShape,
  buildManifest,
  digestFileContent,
  generateManifest,
  ManifestInputRoots,
} from "../packages/core/script/manifest-digest/manifest"
import { contentDigest } from "../packages/core/src/contract/digest"
import { assertAuthoritativeLedger } from "../packages/core/src/contract/evidence-ledger"
import {
  assertAuthoritativeManifest,
  decodeEvidenceManifest,
  type EvidenceManifest,
} from "../packages/core/src/contract/evidence-manifest"
import { Hash } from "../packages/core/src/util/hash"

const repoRoot = path.resolve(import.meta.dir, "..")
const failures: string[] = []
const notes: string[] = []
let checked = 0

const git = (spec: string[]): string | null => {
  const result = Bun.spawnSync(["git", "-C", repoRoot, ...spec], { stdout: "pipe", stderr: "ignore" })
  return result.exitCode === 0 ? result.stdout.toString().trim() : null
}

// ---- always-on: the HEAD pin claim reproduces from the live tree ----
const live = generateManifest({ repoRoot })
if (live.setTreeDigest !== HeadPin.setTreeDigest || live.overallDigest !== HeadPin.overallDigest)
  failures.push(
    `HEAD pin: regenerated manifest ${live.overallDigest} (tree ${live.setTreeDigest}) does not match head-pin.ts ${HeadPin.overallDigest} (tree ${HeadPin.setTreeDigest})`,
  )
else console.log(`ok: HEAD pin reproduces from the live tree (overallDigest=${live.overallDigest})`)

// ---- per-file checks ----
const ABSENT_MARKER = contentDigest({ present: false })

function sha256File(relPath: string): string {
  const abs = path.join(repoRoot, relPath)
  if (!fs.existsSync(abs)) throw new Error(`referenced file does not exist: ${relPath}`)
  return Hash.sha256(Buffer.from(fs.readFileSync(abs)))
}

function checkSourceManifest(file: string, value: unknown): void {
  const manifest = assertManifestShape(value)
  const recomputed = buildManifest(manifest.inputs)
  if (recomputed.setTreeDigest !== manifest.setTreeDigest)
    failures.push(`${file}: setTreeDigest inconsistent (recomputed ${recomputed.setTreeDigest})`)
  if (recomputed.overallDigest !== manifest.overallDigest)
    failures.push(`${file}: overallDigest inconsistent (recomputed ${recomputed.overallDigest})`)

  const treeDirs = [
    ManifestInputRoots.contractDir,
    ManifestInputRoots.migrationBodiesDir,
    ManifestInputRoots.runtimeFlagDir,
    ManifestInputRoots.runtimeConfigDir,
  ]
  for (const [group, inputs] of Object.entries(manifest.inputs)) {
    for (const [relPath, recorded] of Object.entries(inputs)) {
      const abs = path.join(repoRoot, relPath)
      const exists = fs.existsSync(abs)
      if (recorded === ABSENT_MARKER) {
        if (exists) failures.push(`${file}: ${relPath} recorded absent but exists in the tree`)
        continue
      }
      if (group === "package-versions") {
        if (!exists) {
          failures.push(`${file}: ${relPath} referenced but missing`)
          continue
        }
        const parsed: unknown = JSON.parse(fs.readFileSync(abs, "utf8"))
        const pkg = typeof parsed === "object" && parsed !== null ? parsed : {}
        const identity = {
          name: "name" in pkg ? pkg.name : undefined,
          version: "version" in pkg ? pkg.version : undefined,
        }
        if (contentDigest(identity) !== recorded)
          failures.push(`${file}: ${relPath} name/version digest does not match the recorded claim`)
        continue
      }
      const treeBound =
        treeDirs.some((dir) => relPath.startsWith(dir + "/")) || relPath === ManifestInputRoots.migrationRegistryFile
      if (!treeBound) {
        notes.push(
          `${file}: ${relPath} is externally bound evidence (not a committed input) — content not locally verifiable`,
        )
        continue
      }
      if (!exists) {
        failures.push(`${file}: ${relPath} referenced but missing`)
        continue
      }
      if (digestFileContent(fs.readFileSync(abs, "utf8")) !== recorded)
        failures.push(`${file}: ${relPath} content digest does not match the recorded claim`)
    }
  }
}

async function checkEvidenceManifest(file: string, value: unknown): Promise<void> {
  const manifest = decodeEvidenceManifest(value)
  assertAuthoritativeManifest(manifest)
  const head = git(["rev-parse", "HEAD"])
  if (manifest.commit !== head) {
    notes.push(
      `${file}: manifest commit ${manifest.commit} != HEAD ${head} — identity digests not re-verified against this tree`,
    )
    return
  }
  const tree = git(["rev-parse", "HEAD^{tree}"])
  if (manifest.tree !== tree) failures.push(`${file}: recorded tree ${manifest.tree} != HEAD tree ${tree}`)
  const fileDigests: Record<string, keyof EvidenceManifest> = {
    "packages/core/src/event.ts": "eventSchemaDigest",
    "packages/llm/src/route/protocol.ts": "providerProfilesDigest",
    "packages/core/src/flag/flag.ts": "runtimeFlagsDigest",
    "packages/sdk/js/src/gen/types.gen.ts": "openapiDigest",
    "packages/sdk/js/src/gen/sdk.gen.ts": "sdkDigest",
  }
  for (const [relPath, field] of Object.entries(fileDigests)) {
    try {
      if (sha256File(relPath) !== manifest[field]) failures.push(`${file}: ${field} does not match ${relPath} content`)
    } catch (error) {
      failures.push(`${file}: ${field} unverifiable — ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const { capabilityCatalogDigestValue } = await import("../packages/core/src/system-context/capability-catalog")
  if (capabilityCatalogDigestValue.replace("sha256:", "") !== manifest.capabilityManifestDigest)
    failures.push(`${file}: capabilityManifestDigest does not match the live capability catalog`)
}

function checkEvidenceFile(file: string): Promise<void> | void {
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown
  const schemaVersion =
    typeof value === "object" && value !== null && "schemaVersion" in value ? String(value.schemaVersion) : undefined
  checked += 1
  if (schemaVersion === "manifest-digest.v1") return checkSourceManifest(file, value)
  if (schemaVersion === "evidence-manifest.v1") return checkEvidenceManifest(file, value)
  if (schemaVersion === "authoritative-evidence-ledger.v1") {
    const ledger = assertAuthoritativeLedger(value)
    return checkEvidenceManifest(file, ledger.manifest)
  }
  notes.push(`${file}: unrecognized schemaVersion ${schemaVersion ?? "<none>"} — skipped`)
}

const walkJson = (target: string): string[] =>
  fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(target, entry.name)
    if (entry.isDirectory()) return walkJson(full)
    return entry.isFile() && entry.name.endsWith(".json") ? [full] : []
  })

const args = process.argv.slice(2)
const candidates = (
  args.length > 0
    ? args.map((arg) => path.resolve(arg))
    : ["release-evidence", "release-evidence-manifest.json", "authoritative-ledger.json"]
        .map((entry) => path.join(repoRoot, entry))
        .filter((entry) => fs.existsSync(entry))
).flatMap((entry) => (fs.statSync(entry).isDirectory() ? walkJson(entry) : [entry]))

for (const file of candidates.toSorted()) {
  const before = failures.length
  try {
    await checkEvidenceFile(file)
    if (failures.length === before) console.log(`ok: ${path.relative(repoRoot, file)}`)
  } catch (error) {
    failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
if (args.length === 0 && candidates.length === 0)
  notes.push(
    "no release evidence products found (release-evidence/, release-evidence-manifest.json, authoritative-ledger.json) — pin claim only",
  )

for (const note of notes) console.log(`note: ${note}`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`assert-docs-claims: ${failure}`)
  process.exit(1)
}
console.log(`assert-docs-claims: ${checked} evidence file(s) checked, all recorded claims verified`)
