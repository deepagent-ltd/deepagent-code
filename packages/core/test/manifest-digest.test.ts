import { describe, expect, test } from "bun:test"
import { isAbsolute } from "node:path"
import {
  ManifestVersion,
  assertManifestMatches,
  assertManifestShape,
  buildManifest,
  generateManifest,
  serializeManifest,
  type DeterministicManifest,
} from "../script/manifest-digest/manifest"

const groupsA = { contract: { "contract/selection.ts": "a".repeat(64) } }
const groupsB = { contract: { "contract/selection.ts": "b".repeat(64) } }

describe("buildManifest", () => {
  test("is byte-stable across two builds of the same inputs", () => {
    const first = serializeManifest(buildManifest(groupsA))
    const second = serializeManifest(buildManifest(groupsA))
    expect(first).toBe(second)
  })

  test("differs when an input value (content) changes", () => {
    expect(buildManifest(groupsA).overallDigest).not.toBe(buildManifest(groupsB).overallDigest)
  })

  test("is key-insertion-order independent by construction", () => {
    const m1 = buildManifest({ a: { "x": "d1".repeat(32), "y": "d2".repeat(32) } })
    const m2 = buildManifest({ a: { "y": "d2".repeat(32), "x": "d1".repeat(32) } })
    expect(m1.schemaVersion).toBe(ManifestVersion.schema)
    expect(m2.schemaVersion).toBe(ManifestVersion.schema)
    expect(m1.overallDigest).toBe(m2.overallDigest)
  })
})

describe("assertManifestMatches", () => {
  test("passes for a self-consistent matching manifest", () => {
    const m = buildManifest(groupsA)
    expect(() => assertManifestMatches(m, buildManifest(groupsA))).not.toThrow()
  })

  test("fails the drift gate when the manifest diverges", () => {
    const actual = buildManifest(groupsA)
    const expected = buildManifest(groupsB)
    expect(() => assertManifestMatches(actual, expected)).toThrow(/manifest.overallDigest: drift detected/)
  })
})

describe("assertManifestShape", () => {
  test("rejects a missing schemaVersion with the exact path", () => {
    const bad = { inputs: {}, setTreeDigest: "0".repeat(64), overallDigest: "0".repeat(64) }
    expect(() => assertManifestShape(bad)).toThrow(/manifest.schemaVersion:/)
  })

  test("rejects an unknown top-level property with the exact path", () => {
    const m = buildManifest(groupsA) as DeterministicManifest
    expect(() => assertManifestShape({ ...m, extra: true })).toThrow(/manifest.extra: unexpected property/)
  })

  test("rejects a non-object input group with the exact path", () => {
    const m = buildManifest(groupsA) as DeterministicManifest
    expect(() =>
      assertManifestShape({ ...m, inputs: { contract: "nope" } }),
    ).toThrow(/manifest.inputs.contract: expected an object mapping path to digest/)
  })

  test("rejects a non-digest file value with the exact path", () => {
    const m = buildManifest(groupsA) as DeterministicManifest
    expect(() =>
      assertManifestShape({ ...m, inputs: { contract: { "contract/selection.ts": "not-a-digest" } } }),
    ).toThrow(/manifest\.inputs\.contract\.contract\/selection\.ts: expected a 64-character sha-256 hex digest/)
  })

  test("rejects a non-hex setTreeDigest with the exact path", () => {
    const m = buildManifest(groupsA) as DeterministicManifest
    expect(() => assertManifestShape({ ...m, setTreeDigest: "zz" })).toThrow(/manifest.setTreeDigest:/)
  })
})

describe("generateManifest (live tree)", () => {
  test("is byte-stable across two runs", () => {
    const first = serializeManifest(generateManifest())
    const second = serializeManifest(generateManifest())
    expect(first).toBe(second)
  })

  test("changes when an input is added to the input set", () => {
    const base = generateManifest()
    const changed = generateManifest({ extraInputs: { contract: { "contract/extra.ts": "export const x = 1" } } })
    expect(changed.overallDigest).not.toBe(base.overallDigest)
    expect(changed.setTreeDigest).not.toBe(base.setTreeDigest)
  })

  test("emits only repo-relative input keys (no absolute paths)", () => {
    const manifest = generateManifest()
    for (const group of Object.values(manifest.inputs)) {
      for (const key of Object.keys(group)) {
        expect(key.startsWith("/")).toBe(false)
        expect(key).not.toMatch(/^[A-Za-z]:[\\/]/)
        expect(key).not.toContain("core-v2-beta-w2-digest")
      }
    }
  })
})

describe("C0-05 requirement coverage", () => {
  test("handles absent input categories deterministically (missing dirs + non-existent repo)", () => {
    const manifest = generateManifest()
    // The C0-01/C0-06 evidence groups are absent in a clean checkout -> stable marker digests.
    expect(serializeManifest(manifest)).toBe(serializeManifest(generateManifest()))
    expect(Object.keys(manifest.inputs["c0-01-inventory-report"] ?? {})).toEqual([
      "packages/core/.artifacts/caller-inventory/report.json",
    ])
    expect(Object.keys(manifest.inputs["c0-06-perf-manifest"] ?? {})).toEqual([
      "packages/core/.artifacts/perf-baseline",
    ])

    // A repo root with none of the input categories present must not throw and stays byte-stable.
    const absent = generateManifest({ repoRoot: "/definitely/not/a/real/repo" })
    const absentAgain = generateManifest({ repoRoot: "/definitely/not/a/real/repo" })
    expect(serializeManifest(absent)).toBe(serializeManifest(absentAgain))
    expect(absent.schemaVersion).toBe(ManifestVersion.schema)
  })

  test("detects a migration-registry change", () => {
    const base = generateManifest()
    const changed = generateManifest({
      extraInputs: {
        "migration-registry": {
          "packages/core/src/database/migration.gen.ts": "export const migrations = []",
        },
      },
    })
    expect(changed.overallDigest).not.toBe(base.overallDigest)
    expect(changed.setTreeDigest).not.toBe(base.setTreeDigest)
  })

  test("output contains no timestamps or absolute paths", () => {
    const manifest = generateManifest()
    // Only the canonical manifest fields may appear at the top level (no time/absolute-path keys).
    expect(Object.keys(manifest).sort()).toEqual(["inputs", "overallDigest", "schemaVersion", "setTreeDigest"])
    const HEX64 = /^[0-9a-f]{64}$/
    for (const group of Object.values(manifest.inputs)) {
      for (const [key, digest] of Object.entries(group)) {
        expect(isAbsolute(key)).toBe(false)
        expect(digest).toMatch(HEX64)
      }
    }
    expect(serializeManifest(manifest)).not.toContain("/Users/")
  })
})
