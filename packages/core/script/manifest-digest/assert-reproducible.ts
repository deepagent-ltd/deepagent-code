#!/usr/bin/env bun
/**
 * K-05/B-11 manifest digest reproducibility gate.
 *
 *   bun run script/manifest-digest/assert-reproducible.ts
 *
 * Machine-checks the C7-10 claim "the deterministic manifest reproduces from the
 * committed tree on any machine":
 *
 *   1. Two consecutive generations over the live tree are byte-identical.
 *   2. The live generation matches the recorded HEAD pin (`head-pin.ts`).
 *   3. No untracked or git-ignored `.ts` file exists under the digest input roots
 *      (such a file would be read locally but never committed — the historical
 *      `.artifacts/` leak in untracked-file form).
 *   4. Input-set closure: copying exactly the manifest's listed input files into a
 *      scratch tree regenerates byte-identical manifest bytes (the collectors read
 *      nothing beyond the listed inputs).
 *   5. A planted `.artifacts/` decoy tree (plus stray `.ts` files outside every
 *      input root) cannot perturb the digest.
 *
 * Exits 1 with every violation listed; wired into CI (test.yml manifest-digest-gate).
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { HeadPin } from "./head-pin"
import { generateManifest, ManifestInputRoots, serializeManifest } from "./manifest"

const repoRoot = path.resolve(import.meta.dir, "../../../..")
const failures: string[] = []

// 1 + 2: live-tree byte stability and the HEAD pin.
const first = serializeManifest(generateManifest({ repoRoot }))
const second = serializeManifest(generateManifest({ repoRoot }))
if (first !== second) failures.push("two consecutive generations over the live tree differ")

const manifest = generateManifest({ repoRoot })
if (manifest.setTreeDigest !== HeadPin.setTreeDigest)
  failures.push(
    `setTreeDigest ${manifest.setTreeDigest} does not match HEAD pin ${HeadPin.setTreeDigest} (re-pin head-pin.ts)`,
  )
if (manifest.overallDigest !== HeadPin.overallDigest)
  failures.push(
    `overallDigest ${manifest.overallDigest} does not match HEAD pin ${HeadPin.overallDigest} (re-pin head-pin.ts)`,
  )

// 3: every digestible input is git-tracked — no untracked/ignored .ts under the input roots.
const inputRoots = [
  ManifestInputRoots.contractDir,
  ManifestInputRoots.migrationBodiesDir,
  ManifestInputRoots.runtimeFlagDir,
  ManifestInputRoots.runtimeConfigDir,
]
const gitOthers = (ignored: boolean): string[] => {
  const args = [
    "-C",
    repoRoot,
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    ...(ignored ? ["--ignored"] : []),
    "--",
    ...inputRoots,
  ]
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ls-files failed: ${result.stderr.toString()}`)
  return result.stdout.toString().split("\0").filter(Boolean)
}
const untrackedInputs = [...gitOthers(false), ...gitOthers(true)].filter((file) => file.endsWith(".ts")).toSorted()
if (untrackedInputs.length > 0)
  failures.push(
    `untracked/ignored .ts files under digest input roots (would perturb the digest locally but vanish in a clean checkout):\n  ${untrackedInputs.join("\n  ")}`,
  )

// 4 + 5: input-set closure and the .artifacts decoy, in a scratch tree.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-digest-gate-"))
try {
  for (const group of Object.values(manifest.inputs)) {
    for (const relPath of Object.keys(group)) {
      const source = path.join(repoRoot, relPath)
      if (!fs.existsSync(source)) continue
      const target = path.join(scratch, relPath)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(source, target)
    }
  }
  const closure = serializeManifest(generateManifest({ repoRoot: scratch }))
  if (closure !== first)
    failures.push(
      "regenerating from exactly the listed input files differs from the live-tree manifest (input set is not closed)",
    )

  const decoy = (relPath: string, content: string) => {
    const target = path.join(scratch, relPath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  decoy("packages/core/.artifacts/caller-inventory/report.json", '{"callers":["decoy"]}\n')
  decoy("packages/core/.artifacts/perf-baseline/run-1/manifest.json", '{"runs":[1]}\n')
  decoy("packages/core/.artifacts/junk.ts", "export const decoy = true\n")
  decoy("packages/core/src/unrelated/junk.ts", "export const outsideInputRoots = true\n")
  const decoyed = serializeManifest(generateManifest({ repoRoot: scratch }))
  if (decoyed !== first) failures.push("a planted .artifacts/ decoy tree perturbed the digest")
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`assert-reproducible: ${failure}`)
  process.exit(1)
}
const groups = Object.keys(manifest.inputs)
  .map((group) => group + "(" + Object.keys(manifest.inputs[group] ?? {}).length + ")")
  .join(" ")
console.log(`manifest-digest reproducible: groups=[${groups}] overallDigest=${manifest.overallDigest}`)
console.log("manifest-digest: byte-stable across runs, .artifacts decoys invisible, all inputs git-tracked")
