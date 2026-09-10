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
import path from "node:path"
import { makeAuthoritativeManifest } from "../../src/contract/evidence-manifest"
import { capabilityCatalogDigestValue } from "../../src/system-context/capability-catalog"
import { Hash } from "../../src/util/hash"

const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const list = (name: string) =>
  args.flatMap((value, index) => (args[index - 1] === name ? [value] : []))

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
const migrationNames = readdirSync(migrationDir).filter((name) => statSync(path.join(migrationDir, name)).isDirectory()).sort()
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
  const status = gateResults[gate]
  return typeof status === "string" && ["pending", "passed", "failed", "stale", "blocked"].includes(status)
    ? { gate, status: status as "pending" | "passed" | "failed" | "stale" | "blocked", refs: [] }
    : { gate, status: "pending" as const, refs: [] }
})

const manifest = makeAuthoritativeManifest({
  candidateId: `release-${commit.slice(0, 12)}-${new Date().toISOString().slice(0, 10)}`,
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

const evidenceDir = path.join(path.dirname(out), "release-evidence")
await Bun.$`mkdir -p ${evidenceDir}`

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
    ...list("--package-dir").length > 0
      ? ["--packaged-dir", list("--package-dir")[0]!, "--runs", "[]"]
      : [],
  ],
  { cwd: repository, stdout: "inherit", stderr: "inherit", env: { ...process.env } },
)
process.exit(child.exitCode)
