import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import path from "node:path"
import { openUserGlobalStore } from "../../src/deepagent/durable-knowledge-store"
import { seedCoreKnowledge, seedCoreKnowledgeAt } from "../../src/deepagent/knowledge-seed"

let base: string

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "deepagent-seed-"))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

type SeedDocFixture = {
  readonly pack_id: string
  readonly type: string
  readonly domain: string | null
}

const domainPacksDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../domain-packs")

const collectSeedDocs = (): SeedDocFixture[] => {
  const docs: SeedDocFixture[] = []
  const scan = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        scan(full)
        continue
      }
      if (!entry.name.endsWith(".json") || !full.includes(`${path.sep}documents${path.sep}`)) continue
      docs.push(JSON.parse(readFileSync(full, "utf8")) as SeedDocFixture)
    }
  }
  scan(domainPacksDir)
  return docs
}

const countByPack = (docs: readonly SeedDocFixture[]): Record<string, number> =>
  docs.reduce<Record<string, number>>((acc, doc) => ({ ...acc, [doc.pack_id]: (acc[doc.pack_id] ?? 0) + 1 }), {})

const countByType = (docs: readonly SeedDocFixture[], type: string): number =>
  docs.filter((doc) => doc.type === type).length

describe("S1 knowledge seed (file-based, docs/35)", () => {
  test("seeds strategies + methodologies from built-in pack documents/", () => {
    const store = openUserGlobalStore(base)
    const docs = collectSeedDocs()
    const report = seedCoreKnowledge(store)
    expect(report.total).toBe(docs.length)
    expect(report.byPack).toEqual(countByPack(docs))
  })

  test("seeded docs are active and retrievable", () => {
    const store = openUserGlobalStore(base)
    const docs = collectSeedDocs()
    seedCoreKnowledge(store)
    const strategies = store.retrieve({ types: ["strategy"] })
    const methodologies = store.retrieve({ types: ["methodology"] })
    expect(strategies.length).toBe(countByType(docs, "strategy"))
    expect(methodologies.length).toBe(countByType(docs, "methodology"))
  })

  test("gpu docs carry domain + pack tag", () => {
    const store = openUserGlobalStore(base)
    const docs = collectSeedDocs()
    seedCoreKnowledge(store)
    const all = store.retrieve({ types: ["strategy", "methodology"] })
    const gpuDocs = all.filter(({ doc }) => doc.domain === "gpu_kernel")
    expect(gpuDocs.length).toBe(
      docs.filter((doc) => doc.domain === "gpu_kernel" && ["strategy", "methodology"].includes(doc.type)).length,
    )
    for (const { doc } of gpuDocs) {
      expect(doc.tags).toContain("pack:code.gpu-kernel")
    }
  })

  test("re-seeding is idempotent", () => {
    const store = openUserGlobalStore(base)
    seedCoreKnowledge(store)
    const before = store.retrieve({ types: ["strategy", "methodology"] }).length
    seedCoreKnowledge(openUserGlobalStore(base)) // second boot
    const after = openUserGlobalStore(base).retrieve({ types: ["strategy", "methodology"] }).length
    expect(after).toBe(before)
  })

  test("seedCoreKnowledgeAt writes under injected base (no real home pollution)", () => {
    const report = seedCoreKnowledgeAt(base)
    expect(report.total).toBeGreaterThan(0)
    const store = openUserGlobalStore(base)
    expect(store.retrieve({ types: ["strategy"] }).length).toBeGreaterThan(0)
    expect(store.documentStore.verify().ok).toBe(true)
  })

  test("no failure_dossier / memory seeded as positive knowledge", () => {
    const store = openUserGlobalStore(base)
    seedCoreKnowledge(store)
    expect(store.retrieve({ types: ["memory"] })).toHaveLength(0)
  })
})
