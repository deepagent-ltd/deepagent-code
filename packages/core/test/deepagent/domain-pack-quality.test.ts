import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import * as Registry from "../../src/deepagent/domain-pack-registry"
import { openUserGlobalStore } from "../../src/deepagent/durable-knowledge-store"
import { seedCoreKnowledge } from "../../src/deepagent/knowledge-seed"
import type { ExtendedProblemProfile } from "../../src/deepagent/domain-pack-registry"

type Pack = {
  readonly id: string
  readonly schema_version: string
  readonly risk?: string
  readonly domains?: readonly string[]
}

type IndexEntry = {
  readonly ref_id: string
  readonly type: string
  readonly title?: string
  readonly summary?: string
  readonly evidence_strength?: string
  readonly allowed_strengths?: readonly string[]
  readonly pack_id?: string
}

type SeedDoc = {
  readonly ref_id: string
  readonly type: string
  readonly description?: string
  readonly body?: string
  readonly evidence_strength?: string
  readonly pack_id?: string
}

type L3Smoke = {
  readonly schema_version: "domain_pack_eval.v1"
  readonly pack_id: string
  readonly maturity_target: "L3"
  readonly positive_profile: ExtendedProblemProfile
  readonly negative_profile: ExtendedProblemProfile
  readonly retrieval_query: string
  readonly expected_pack_id: string
  readonly expected_min_retrieved_refs: number
  readonly validation_smoke: { readonly name: string; readonly signals: readonly string[] }
  readonly diagnosis_smoke: { readonly name: string; readonly signals: readonly string[] }
}

const domainPackRoot = path.resolve(fileURLToPath(import.meta.url), "../../../..", "domain-packs")
const positiveTypes = new Set(["strategy", "methodology", "knowledge", "skill", "memory"])
const strictStrengthTypes = new Set(["strategy", "methodology", "knowledge", "memory"])
const requiredPaths = [
  "pack.json",
  "index.json",
  "README.md",
  "documents/strategies",
  "documents/methodologies",
  "documents/knowledge",
  "documents/skills",
  "documents/failure_dossiers",
]

// docs/review_38 Round 1/2: the previous rigid floor (strategy 6 / methodology 4 / knowledge 5 /
// skill 3 / failure 4) is exactly what incentivized the 611-doc noun-swap scaffold. It is replaced
// by an honest low floor (genuine cores legitimately differ in size) PLUS a hard scaffold gate
// (`scaffold_ratio == 0`, checked from quality/l3-report.json) and the existing per-doc behavior/
// thin checks. Packs that are real-but-small are now honestly L2-structural, not fake-L3.
const minimumCounts = {
  strategy: 3,
  methodology: 1,
  knowledge: 0,
  skill: 0,
  failure_dossier: 0,
}

const discoverPackDirs = () => {
  const dirs: string[] = []
  const scan = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const child = path.join(dir, entry.name)
      if (existsSync(path.join(child, "pack.json"))) {
        dirs.push(child)
        continue
      }
      scan(child)
    }
  }
  scan(domainPackRoot)
  return dirs.sort()
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T

const collectJsonFiles = (dir: string) => {
  if (!existsSync(dir)) return []
  const files: string[] = []
  const scan = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name)
      if (entry.isDirectory()) {
        scan(child)
        continue
      }
      if (entry.name.endsWith(".json")) files.push(child)
    }
  }
  scan(dir)
  return files.sort()
}

const hasBehaviorValue = (body: string) =>
  [
    /\b(use when|applies when|适用)\b/i,
    /\b(do not use|not use|不适用|avoid)\b/i,
    /\b(actions?|steps?|执行|inspect|verify|run|compare|record)\b/i,
    /\b(validation|verify|evidence|signal|test|smoke|log|trace|schema|benchmark|验证)\b/i,
    /\b(risk boundary|risk|boundary|escalate|human|deny|rollback|风险)\b/i,
  ].filter((pattern) => pattern.test(body)).length >= 3

describe("domain pack quality", () => {
  test("all built-in packs satisfy layout, index, evidence, and minimum L2 density", () => {
    const duplicateRefs = new Map<string, string[]>()
    const failures: string[] = []

    for (const packDir of discoverPackDirs()) {
      for (const requiredPath of requiredPaths) {
        if (!existsSync(path.join(packDir, requiredPath))) failures.push(`${packDir}: missing ${requiredPath}`)
      }
      if (!existsSync(path.join(packDir, "pack.json")) || !existsSync(path.join(packDir, "index.json"))) continue

      const pack = readJson<Pack>(path.join(packDir, "pack.json"))
      if (pack.schema_version !== "domain_pack.v1") failures.push(`${pack.id}: bad schema_version ${pack.schema_version}`)

      const index = readJson<IndexEntry[]>(path.join(packDir, "index.json"))
      const indexByRef = new Map(index.map((entry) => [entry.ref_id, entry]))
      const docs = collectJsonFiles(path.join(packDir, "documents")).map((file) => ({
        file,
        doc: readJson<SeedDoc>(file),
      }))
      const docByRef = new Map<string, SeedDoc>()
      const counts = {
        strategy: 0,
        methodology: 0,
        knowledge: 0,
        skill: 0,
        failure_dossier: 0,
      }

      for (const { file, doc } of docs) {
        const rel = path.relative(packDir, file)
        if (!doc.ref_id) {
          failures.push(`${pack.id}: ${rel} missing ref_id`)
          continue
        }
        duplicateRefs.set(doc.ref_id, [...(duplicateRefs.get(doc.ref_id) ?? []), `${pack.id}:${rel}`])
        if (docByRef.has(doc.ref_id)) failures.push(`${pack.id}: duplicate ref_id ${doc.ref_id}`)
        docByRef.set(doc.ref_id, doc)
        if (doc.pack_id !== pack.id) failures.push(`${pack.id}: ${doc.ref_id} pack_id=${doc.pack_id}`)
        if (doc.type in counts) counts[doc.type as keyof typeof counts] += 1
        if (doc.type !== "failure_dossier" && !positiveTypes.has(doc.type)) failures.push(`${pack.id}: ${doc.ref_id} unsupported type ${doc.type}`)
        if (doc.evidence_strength === "weak" || doc.evidence_strength === "none") failures.push(`${pack.id}: ${doc.ref_id} weak/none evidence`)
        if (positiveTypes.has(doc.type)) {
          if ((doc.body ?? "").trim().length < 180) failures.push(`${pack.id}: ${doc.ref_id} thin body`)
          if (!hasBehaviorValue(doc.body ?? "")) failures.push(`${pack.id}: ${doc.ref_id} lacks behavior value`)
        }
      }

      for (const entry of index) {
        if (entry.pack_id !== pack.id) failures.push(`${pack.id}: ${entry.ref_id} index pack_id=${entry.pack_id}`)
        if (!docByRef.has(entry.ref_id)) failures.push(`${pack.id}: ${entry.ref_id} indexed without document`)
        if (entry.type === "failure_dossier") failures.push(`${pack.id}: ${entry.ref_id} failure_dossier indexed`)
        if (entry.evidence_strength === "weak" || entry.evidence_strength === "none") failures.push(`${pack.id}: ${entry.ref_id} weak/none index evidence`)
        if (strictStrengthTypes.has(entry.type) && JSON.stringify(entry.allowed_strengths) !== JSON.stringify(["max", "ultra"])) {
          failures.push(`${pack.id}: ${entry.ref_id} bad allowed_strengths ${JSON.stringify(entry.allowed_strengths)}`)
        }
        if (entry.type === "skill" && !entry.allowed_strengths?.includes("high")) failures.push(`${pack.id}: ${entry.ref_id} skill missing high`)
      }

      for (const [ref, doc] of docByRef) {
        if (doc.type === "failure_dossier") {
          if (indexByRef.has(ref)) failures.push(`${pack.id}: ${ref} failure_dossier present in index`)
          continue
        }
        if (!indexByRef.has(ref)) failures.push(`${pack.id}: ${ref} positive document missing from index`)
        if (indexByRef.get(ref)?.type !== doc.type) failures.push(`${pack.id}: ${ref} index/doc type mismatch`)
      }

      for (const [type, minimum] of Object.entries(minimumCounts)) {
        if (counts[type as keyof typeof counts] < minimum) failures.push(`${pack.id}: ${type} count ${counts[type as keyof typeof counts]} < ${minimum}`)
      }

      if (!existsSync(path.join(packDir, "evals/smoke/l3-smoke.json"))) failures.push(`${pack.id}: missing evals/smoke/l3-smoke.json`)
      const reportPath = path.join(packDir, "quality/l3-report.json")
      if (!existsSync(reportPath)) failures.push(`${pack.id}: missing quality/l3-report.json`)
      else {
        // docs/review_38 Round 2c: hard anti-scaffold gate. No machine-generated noun-swap clones
        // (quality_expansion / l3_smoke:paraphrased) may remain. Recomputed at delete time; asserted here.
        const report = readJson<{ scaffold_ratio?: number }>(reportPath)
        if ((report.scaffold_ratio ?? 1) > 0) failures.push(`${pack.id}: scaffold_ratio ${report.scaffold_ratio} > 0 (machine-cloned docs present)`)
      }
    }

    for (const [ref, locations] of duplicateRefs) {
      if (locations.length > 1) failures.push(`duplicate global ref ${ref}: ${locations.join(", ")}`)
    }

    expect(failures).toEqual([])
  })

  test("every L3 pack has activation and pack-scoped retrieval smoke", () => {
    Registry.configureRegistry(undefined)
    const manifests = Registry.discover()
    const base = mkdtempSync(path.join(tmpdir(), "deepagent-pack-l3-smoke-"))
    try {
      const store = openUserGlobalStore(base)
      seedCoreKnowledge(store)
      const failures: string[] = []

      for (const packDir of discoverPackDirs()) {
        const pack = readJson<Pack>(path.join(packDir, "pack.json"))
        const smoke = readJson<L3Smoke>(path.join(packDir, "evals/smoke/l3-smoke.json"))
        if (smoke.pack_id !== pack.id) failures.push(`${pack.id}: smoke pack_id=${smoke.pack_id}`)
        if (smoke.maturity_target !== "L3") failures.push(`${pack.id}: smoke maturity=${smoke.maturity_target}`)
        if (smoke.validation_smoke.signals.length === 0) failures.push(`${pack.id}: missing validation smoke signals`)
        if (smoke.diagnosis_smoke.signals.length === 0) failures.push(`${pack.id}: missing diagnosis smoke signals`)

        const positiveScore = Registry.score(smoke.positive_profile, manifests).find((score) => score.packId === pack.id)?.score ?? 0
        const negativeScore = Registry.score(smoke.negative_profile, manifests).find((score) => score.packId === pack.id)?.score ?? 0
        if (positiveScore < 0.5) failures.push(`${pack.id}: positive activation score ${positiveScore}`)
        if (negativeScore >= 0.5) failures.push(`${pack.id}: negative activation score ${negativeScore}`)

        const refs = store.retrieve({
          types: ["strategy", "methodology", "knowledge", "skill"],
          activePackIds: [pack.id],
          keywords: smoke.retrieval_query.toLowerCase().split(/[^a-z0-9_.#+-]+/).filter((word) => word.length > 2),
          limit: 20,
        }).filter(({ doc }) => doc.extensions?.pack_id === pack.id)
        if (refs.length < smoke.expected_min_retrieved_refs) failures.push(`${pack.id}: retrieved ${refs.length}`)
      }

      expect(failures).toEqual([])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
