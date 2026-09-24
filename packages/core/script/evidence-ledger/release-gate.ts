#!/usr/bin/env bun
/**
 * RI-51 release gate — the release command's ledger consumption.
 *
 *   bun run script/evidence-ledger/release-gate.ts \
 *     [--gates <gate-results.json>] [--package-dir <dir>]... [--out <ledger.json>]
 *
 * Builds an HONEST evidence manifest from the current tree (real content digests for schema,
 * migration registry, OpenAPI/SDK, capability catalog, event registry, provider profiles, runtime
 * flags), merges gate statuses from `--gates` (a `{ G0: "passed", ... }`-shaped JSON; gates without
 * an entry stay `pending`), then delegates to the single authoritative ledger generator. The exit
 * code is the ledger's: NO-GO exits non-zero and the release pipeline must stop.
 *
 * With no `--gates` every gate is pending and the release is correctly refused — fail-closed by
 * construction, so wiring this into the publish workflow can never accidentally allow a release
 * whose gate evidence does not exist.
 */
import { readdirSync, statSync } from "node:fs"
import { copyFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { makeAuthoritativeManifest } from "../../src/contract/evidence-manifest"
import { capabilityCatalogDigestValue } from "../../src/system-context/capability-catalog"
import { Hash } from "../../src/util/hash"

const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const list = (name: string) => args.flatMap((value, index) => (args[index - 1] === name ? [value] : []))

const repository = path.resolve(import.meta.dir, "../../../..")
const out = option("--out") ?? path.join(repository, "authoritative-ledger.json")

const git = (spec: string[]) => {
  const result = Bun.spawnSync(["git", "-C", repository, ...spec], { stdout: "pipe", stderr: "ignore" })
  return result.exitCode === 0 ? result.stdout.toString().trim() : null
}
const commit = git(["rev-parse", "HEAD"]) ?? "unknown"
const tree = git(["rev-parse", "HEAD^{tree}"]) ?? "unknown"
const dirty = (git(["status", "--porcelain", "--untracked-files=all"]) ?? "").length > 0

const sha256File = async (file: string) => Hash.sha256(Buffer.from(await Bun.file(file).arrayBuffer()))
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : entry.isFile() ? [full] : []
  })

const migrationDir = path.join(repository, "packages/core/migration")
const migrationNames = readdirSync(migrationDir)
  .filter((name) => statSync(path.join(migrationDir, name)).isDirectory())
  .sort()
const migrationRegistryDigest = Hash.sha256(Buffer.from(migrationNames.join("\n")))
const schemaDigest = await (async () => {
  const chunks: Buffer[] = []
  for (const name of migrationNames) {
    for (const file of walk(path.join(migrationDir, name)).sort())
      chunks.push(Buffer.from(await Bun.file(file).arrayBuffer()))
  }
  return Hash.sha256(Buffer.concat(chunks))
})()

const gateResults = (() => {
  const file = option("--gates")
  if (!file) return {}
  return JSON.parse(require("node:fs").readFileSync(file, "utf8")) as Record<string, unknown>
})()

const gates = (["G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"] as const).map((gate) => {
  const entry = gateResults[gate]
  // Flat status string, or { status, refs[] } — the contract refuses a passed gate without
  // evidence refs, so the richer shape is how a passing chain cites its artifacts.
  if (typeof entry === "string")
    return ["pending", "passed", "failed", "stale", "blocked"].includes(entry)
      ? { gate, status: entry as "pending" | "passed" | "failed" | "stale" | "blocked", refs: [] }
      : { gate, status: "pending" as const, refs: [] }
  if (entry && typeof entry === "object" && "status" in entry && "refs" in entry) {
    const status = (entry as { status: string }).status
    const refs = (entry as { refs: unknown }).refs
    if (["pending", "passed", "failed", "stale", "blocked"].includes(status) && Array.isArray(refs))
      return {
        gate,
        status: status as "pending" | "passed" | "failed" | "stale" | "blocked",
        refs: refs.filter((ref): ref is string => typeof ref === "string"),
      }
  }
  return { gate, status: "pending" as const, refs: [] }
})

// Candidate identity: when packaged evidence is present, the candidate IS the packaged build —
// the minted owner-authorization's buildID-derived candidateID (`candidate:<buildID>`) so the
// ledger's evidence cross-check binds (every run's evidence artifact carries the same identity).
// Without packaging, the tree-commit identity stands.
const packagedCandidate = await (async () => {
  const evidenceFile = option("--evidence") ? list("--evidence")[0]! : undefined
  if (!evidenceFile) return undefined
  const parsed = (await Bun.file(path.resolve(evidenceFile)).json()) as { identity?: { candidateID?: string } }
  return parsed.identity?.candidateID
})()
const manifest = makeAuthoritativeManifest({
  candidateId: packagedCandidate ?? `release-${commit.slice(0, 12)}-${new Date().toISOString().slice(0, 10)}`,
  commit,
  tree,
  packageDigests: Object.fromEntries(
    await Promise.all(
      list("--package-dir").map(async (dir) => {
        const files = walk(dir).sort()
        const digest = Hash.sha256(
          Buffer.concat(await Promise.all(files.map((file) => Bun.file(file).arrayBuffer().then(Buffer.from)))),
        )
        return [path.basename(dir), digest]
      }),
    ),
  ),
  schemaDigest,
  migrationRegistryDigest,
  openapiDigest: await sha256File(path.join(repository, "packages/sdk/js/src/gen/types.gen.ts")),
  sdkDigest: await sha256File(path.join(repository, "packages/sdk/js/src/gen/sdk.gen.ts")),
  capabilityManifestDigest: capabilityCatalogDigestValue.replace("sha256:", ""),
  eventSchemaDigest: await sha256File(path.join(repository, "packages/core/src/event.ts")),
  providerProfilesDigest: await sha256File(path.join(repository, "packages/llm/src/route/protocol.ts")),
  runtimeFlagsDigest: await sha256File(path.join(repository, "packages/core/src/flag/flag.ts")),
  testEnvironmentDigest: Hash.sha256(
    Buffer.from(JSON.stringify({ bun: Bun.version, platform: process.platform, arch: process.arch, dirty })),
  ),
  machine: "release-pipeline",
  evidenceLevel: "D2",
  gates,
  openFindings: dirty ? ["release-tree-dirty"] : [],
  acceptedResiduals: [],
  issuedAt: new Date().toISOString(),
})

const manifestPath = path.join(path.dirname(out), "release-evidence-manifest.json")
await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

const artifactDir = path.join(path.dirname(out), "release-evidence-products")
await mkdir(artifactDir, { recursive: true })
if (option("--gates")) await copyFile(path.resolve(option("--gates")!), path.join(artifactDir, "gates.json"))

const evidenceDir = path.join(path.dirname(out), "release-evidence")
await Bun.$`mkdir -p ${evidenceDir}`
// Packaged-run evidence artifacts (RI-24 runtime-integrity evidence JSON) land in the evidence
// dir so the authoritative ledger cross-checks every run digest against a present artifact.
for (const evidenceFile of list("--evidence")) await Bun.$`cp ${path.resolve(evidenceFile)} ${evidenceDir}/`

const child = Bun.spawnSync(
  [
    process.execPath,
    path.join(import.meta.dir, "generate-candidate-ledger.ts"),
    "--manifest",
    manifestPath,
    "--evidence-dir",
    evidenceDir,
    "--out",
    out,
    "--artifact-dir",
    artifactDir,
    // The candidate ledger spawns with cwd=repository; resolve relative inputs here so the
    // packaged-dir/runs paths keep meaning regardless of where the gate was invoked from.
    ...(list("--package-dir").length > 0
      ? ["--packaged-dir", path.resolve(list("--package-dir")[0]!), "--runs", path.resolve(option("--runs") ?? "[]")]
      : []),
  ],
  { cwd: repository, stdout: "inherit", stderr: "inherit", env: { ...process.env } },
)
process.exit(child.exitCode)
