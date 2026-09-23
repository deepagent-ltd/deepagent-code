import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { contentDigest } from "../../src/contract/digest"

export const ManifestVersion = {
  schema: "manifest-digest.v1",
  inputGroup: 1,
  fileEntry: 1,
} as const

export type ManifestSchemaVersion = typeof ManifestVersion.schema

/** input-group id -> (repo-relative input path -> SHA-256 hex of its content). */
export type ManifestInputGroups = Record<string, Record<string, string>>

/**
 * The single deterministic manifest produced by the C0-05 generator.
 * Byte-stable (run twice → identical bytes), volatile-stripped and free of
 * absolute paths; any input content/set drift changes the digests and makes the
 * gate fail.
 */
export interface DeterministicManifest {
  readonly schemaVersion: ManifestSchemaVersion
  readonly inputs: ManifestInputGroups
  /** Content digest over the entire input set tree (group -> path -> digest). */
  readonly setTreeDigest: string
  /** Content digest over the whole manifest (schema + inputs + setTreeDigest). */
  readonly overallDigest: string
}

const HEX64 = /^[0-9a-f]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fail(path: string, message: string): never {
  throw new Error(`manifest${path ? `.${path}` : ""}: ${message}`)
}

function sortDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(sortDeep)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) out[key] = sortDeep((value as Record<string, unknown>)[key])
  return out
}

/**
 * Serialize a manifest to deterministic JSON bytes.
 * Object keys are sorted recursively so the same logical manifest always
 * serializes to identical bytes regardless of insertion order.
 */
export function serializeManifest(manifest: DeterministicManifest): string {
  return JSON.stringify(sortDeep(manifest), null, 2)
}

/**
 * Build a manifest from already-digested inputs (`group -> path -> digest`).
 * The gate core: it derives `setTreeDigest` (digest of the whole input set tree)
 * and `overallDigest` (digest of schema + inputs + setTreeDigest) using the same
 * contentDigest semantics as the contract modules (sorted keys, volatile
 * stripped, SHA-256). Reordering group/file insertion order is absorbed by the
 * canonical digest; changing the *set* or any value changes `overallDigest`.
 */
export function buildManifest(groups: ManifestInputGroups): DeterministicManifest {
  const inputs: ManifestInputGroups = {}
  for (const group of Object.keys(groups).sort()) {
    const files: Record<string, string> = {}
    for (const relPath of Object.keys(groups[group] ?? {}).sort()) {
      files[relPath] = groups[group]![relPath]!
    }
    inputs[group] = files
  }
  const setTreeDigest = contentDigest(inputs)
  const overallDigest = contentDigest({ schemaVersion: ManifestVersion.schema, inputs, setTreeDigest })
  return { schemaVersion: ManifestVersion.schema, inputs, setTreeDigest, overallDigest }
}

/**
 * Validate the shape of an unknown manifest value, returning a typed manifest.
 * Throws with an exact error path for a missing/invalid/extra field (missing
 * `schemaVersion`, wrong top-level property, non-object input group, non-digest
 * file value, wrong `setTreeDigest`/`overallDigest`, unknown top-level key).
 */
export function assertManifestShape(value: unknown): DeterministicManifest {
  if (!isRecord(value)) fail("", "expected an object")

  const allowed = new Set(["schemaVersion", "inputs", "setTreeDigest", "overallDigest"])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(key, "unexpected property")
  }

  if (value.schemaVersion !== ManifestVersion.schema) {
    fail("schemaVersion", `expected ${ManifestVersion.schema}`)
  }
  if (!isRecord(value.inputs)) fail("inputs", "expected an object of input groups")

  const inputs: ManifestInputGroups = {}
  for (const group of Object.keys(value.inputs).sort()) {
    const groupValue = value.inputs[group]
    if (!isRecord(groupValue)) fail(`inputs.${group}`, "expected an object mapping path to digest")
    const files: Record<string, string> = {}
    for (const relPath of Object.keys(groupValue).sort()) {
      const digest = groupValue[relPath]
      if (typeof digest !== "string") fail(`inputs.${group}.${relPath}`, "expected a string digest")
      if (!HEX64.test(digest)) fail(`inputs.${group}.${relPath}`, "expected a 64-character sha-256 hex digest")
      files[relPath] = digest
    }
    inputs[group] = files
  }

  if (typeof value.setTreeDigest !== "string") fail("setTreeDigest", "expected a string digest")
  if (!HEX64.test(value.setTreeDigest)) fail("setTreeDigest", "expected a 64-character sha-256 hex digest")
  if (typeof value.overallDigest !== "string") fail("overallDigest", "expected a string digest")
  if (!HEX64.test(value.overallDigest)) fail("overallDigest", "expected a 64-character sha-256 hex digest")

  return {
    schemaVersion: ManifestVersion.schema,
    inputs,
    setTreeDigest: value.setTreeDigest,
    overallDigest: value.overallDigest,
  }
}

/**
 * The drift gate. Asserts `actual` matches `expected` after validating the
 * internal digest consistency of `actual`. Any content/set drift → throws with
 * the exact offending path and the diverging digests; a self-consistent,
 * matching manifest → returns without throwing.
 */
export function assertManifestMatches(actual: unknown, expected: unknown): void {
  const a = assertManifestShape(actual)
  const e = assertManifestShape(expected)

  const recomputed = buildManifest(a.inputs)
  if (recomputed.setTreeDigest !== a.setTreeDigest) {
    fail("setTreeDigest", `inconsistent manifest, recomputed ${recomputed.setTreeDigest}`)
  }
  if (recomputed.overallDigest !== a.overallDigest) {
    fail("overallDigest", `inconsistent manifest, recomputed ${recomputed.overallDigest}`)
  }
  if (a.overallDigest !== e.overallDigest) {
    fail("overallDigest", `drift detected: actual ${a.overallDigest} != expected ${e.overallDigest}`)
  }
}

// ---- deterministic input source collection ----

/**
 * The closed digest input set, itemized as repo-relative paths: four `.ts` source
 * directories (walked recursively), the migration registry file, and the four
 * distribution package manifests (name + version only). Every entry is a
 * committed, git-tracked path — anything outside this list, including the
 * git-ignored `.artifacts/` tree, is invisible to the digest by
 * construction (K-05/B-11: same commit ⇒ same digest on any machine). The
 * reproducibility gate asserts that no untracked file exists under these roots.
 */
export const ManifestInputRoots = {
  contractDir: "packages/core/src/contract",
  migrationRegistryFile: "packages/core/src/database/migration.gen.ts",
  migrationBodiesDir: "packages/core/src/database/migration",
  runtimeFlagDir: "packages/core/src/flag",
  runtimeConfigDir: "packages/core/src/config",
  packageManifests: [
    "packages/core/package.json",
    "packages/deepagent-code/package.json",
    "packages/app/package.json",
    "packages/desktop/package.json",
  ],
} as const

/** Options for the runnable/live generator. */
export interface GenerateManifestOptions {
  /** Override the repository root (defaults to the git checkout containing this module). */
  readonly repoRoot?: string
  /**
   * Extra/replacement inputs, `group -> repo-path -> content`, hashed and merged
   * over the discovered tree so a caller can inject or substitute an input
   * without touching the working tree. This is the ONLY way external evidence
   * enters the manifest: the caller passes the exact bytes it wants bound
   * (content-addressed under a documented repo-relative key), so the default
   * manifest stays a pure function of the committed tree. Used by the
   * drift/sensitivity tests and by the candidate-ledger generator.
   */
  readonly extraInputs?: Record<string, Record<string, string>>
}

/** SHA-256 of a file's raw bytes. */
export function digestFileContent(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

function resolveRepoRoot(): string {
  return path.resolve(import.meta.dir, "../../../..")
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTsFiles(full))
    else if (entry.name.endsWith(".ts")) out.push(full)
  }
  return out.sort()
}

/** Digest every `.ts` file under `absDir`, keyed by repo-relative path. */
function collectTsDir(absDir: string, repoRoot: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!fs.existsSync(absDir)) return out
  for (const file of walkTsFiles(absDir)) {
    const relPath = path.relative(repoRoot, file)
    out[relPath] = digestFileContent(fs.readFileSync(file, "utf8"))
  }
  return out
}

function absentDigest(): string {
  return contentDigest({ present: false })
}

/** Contract sources under `ManifestInputRoots.contractDir` (all files). */
function collectContract(repoRoot: string): Record<string, string> {
  return collectTsDir(path.join(repoRoot, ManifestInputRoots.contractDir), repoRoot)
}

/**
 * Migration registry. Authoritative source = the generated registry listing every
 * applied migration (`ManifestInputRoots.migrationRegistryFile`, written by the
 * migration generator, owned by the main Agent per worklist §2; do not edit).
 * The group also captures every migration body under `ManifestInputRoots.migrationBodiesDir`
 * so a body-only edit (which leaves the registry import id unchanged) is still drift.
 */
function collectMigrationRegistry(repoRoot: string): Record<string, string> {
  // The registry (apply order) plus every migration body. Collapsing the
  // migration.gen.ts import list into a single digest would miss a body-only edit
  // (the import id is unchanged), so the executable sources are captured too.
  const registryRel = ManifestInputRoots.migrationRegistryFile
  const registryAbs = path.join(repoRoot, registryRel)
  const out: Record<string, string> = {
    [registryRel]: fs.existsSync(registryAbs) ? digestFileContent(fs.readFileSync(registryAbs, "utf8")) : absentDigest(),
  }
  Object.assign(out, collectTsDir(path.join(repoRoot, ManifestInputRoots.migrationBodiesDir), repoRoot))
  return out
}

/**
 * Package identities (name + version) for the distribution stack
 * (core / deepagent-code / app / desktop). Each is hashed with contentDigest so a
 * version bump (or package rename) changes the manifest, while churn in scripts
 * or dev deps does not pollute the deterministic protocol fingerprint.
 */
function collectPackageVersions(repoRoot: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const relPath of ManifestInputRoots.packageManifests) {
    const abs = path.join(repoRoot, relPath)
    if (!fs.existsSync(abs)) {
      out[relPath] = absentDigest()
      continue
    }
    const pkg = JSON.parse(fs.readFileSync(abs, "utf8")) as { name?: unknown; version?: unknown }
    out[relPath] = contentDigest({ name: pkg.name, version: pkg.version })
  }
  return out
}

/**
 * Runtime flag/config sources: the feature flags and the runtime configuration
 * modules under `ManifestInputRoots.runtimeFlagDir` and `ManifestInputRoots.runtimeConfigDir`.
 */
function collectRuntimeFlagConfig(repoRoot: string): Record<string, string> {
  const out: Record<string, string> = {
    ...collectTsDir(path.join(repoRoot, ManifestInputRoots.runtimeFlagDir), repoRoot),
    ...collectTsDir(path.join(repoRoot, ManifestInputRoots.runtimeConfigDir), repoRoot),
  }
  return out
}

/**
 * Produce the single deterministic manifest from the live tree, covering the
 * contract sources, the migration registry, the package identity versions and the
 * runtime flag/config sources. Every input is a committed, git-tracked file, so
 * the same commit yields the same manifest bytes on any machine.
 *
 * External evidence under `packages/core/.artifacts/` (the C0-01 caller-inventory
 * report, the C0-06 perf-baseline manifests) is deliberately NOT read here:
 * `.artifacts/` is git-ignored, so whatever a machine happens to have generated
 * locally would perturb the digest and make it unreproducible from the committed
 * tree (O-TEST-3 / O-W12-3). A caller that must bind produced evidence passes its
 * exact bytes via `GenerateManifestOptions.extraInputs` — content-addressed under
 * the documented repo-relative key — as the candidate-ledger generator does for
 * the freshly produced inventory report.
 */
export function generateManifest(options: GenerateManifestOptions = {}): DeterministicManifest {
  const repoRoot = options.repoRoot ?? resolveRepoRoot()

  const inputs: ManifestInputGroups = {
    contract: collectContract(repoRoot),
    "migration-registry": collectMigrationRegistry(repoRoot),
    "package-versions": collectPackageVersions(repoRoot),
    "runtime-flag-config": collectRuntimeFlagConfig(repoRoot),
  }

  if (options.extraInputs) {
    for (const group of Object.keys(options.extraInputs)) {
      const target: Record<string, string> = inputs[group] ?? {}
      for (const [relPath, inputContent] of Object.entries(options.extraInputs[group] ?? {})) {
        target[relPath] = digestFileContent(inputContent)
      }
      inputs[group] = target
    }
  }

  return buildManifest(inputs)
}

export { ManifestVersion as default }
