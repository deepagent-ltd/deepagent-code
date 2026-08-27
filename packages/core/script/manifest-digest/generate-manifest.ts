#!/usr/bin/env bun
/**
 * C0-05 deterministic manifest/digest generator — runnable entry.
 *
 *   bun run script/manifest-digest/generate-manifest.ts [--out <path>]
 *
 * Produces the single deterministic manifest bytes on stdout (or writes them to
 * --out). Re-running on the same base tree must yield byte-identical output;
 * any drift is an input-set/content change. The digest summary goes to stderr so
 * it never pollutes the deterministic stdout stream.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { generateManifest, serializeManifest } from "./manifest"

const args = process.argv.slice(2)
const outIndex = args.indexOf("--out")
const out = outIndex >= 0 ? args[outIndex + 1] : undefined

const manifest = generateManifest()
const bytes = serializeManifest(manifest) + "\n"

if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  fs.writeFileSync(path.resolve(out), bytes)
} else {
  process.stdout.write(bytes)
}

const groups = Object.keys(manifest.inputs)
  .map((group) => group + "(" + Object.keys(manifest.inputs[group] ?? {}).length + ")")
  .join(" ")
console.error("manifest-digest: schema=" + manifest.schemaVersion + " groups=[" + groups + "]")
console.error("manifest-digest: setTreeDigest=" + manifest.setTreeDigest)
console.error("manifest-digest: overallDigest=" + manifest.overallDigest)
