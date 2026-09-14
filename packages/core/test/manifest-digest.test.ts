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
    const m1 = buildManifest({ a: { x: "d1".repeat(32), y: "d2".repeat(32) } })
    const m2 = buildManifest({ a: { y: "d2".repeat(32), x: "d1".repeat(32) } })
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
    expect(() => assertManifestShape({ ...m, inputs: { contract: "nope" } })).toThrow(
      /manifest.inputs.contract: expected an object mapping path to digest/,
    )
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

// C7-10 (a10 R3 close, W14) — the deterministic manifest MUST reproduce at the current HEAD. The
// values below are the regenerated digests for the Core V2 context-tool cutover tree: any drift in
// the manifest input groups (contract / migration registry / package versions / runtime flags) fails
// here, and the pinned value + the record in `beta-rc-evidence-manifest.md` §1 / compliance-matrix
// C7-10 must be refreshed TOGETHER (the R3 gap was exactly "recorded digests not reproducible at
// HEAD").
//
// SCOPE (fix): the gate digests the COMMITTED tree only (`includeExternalEvidence: false`). The two
// external-evidence groups hash artifacts under the git-ignored `packages/core/.artifacts/`
// (caller-inventory report, perf baseline), so with them included the digest is a function of
// whatever the machine happens to have generated — unreproducible in a clean checkout by
// construction, and guaranteed to drift the moment any new source file changes the inventory. That
// is not what "reproducible at HEAD" can mean; the externals are still collected and still perturb
// the digest (asserted below), they are simply outside the reproducibility claim.
describe("C7-10 HEAD reproducibility (a10 R3 close)", () => {
  const TREE_PIN = "0eae08fd5a55fcbc2e4a4d9ede72229763e6fb13a4f2c751629a222ac0525e46"
  const OVERALL_PIN = "17e270ce6e972b1b86df362c141e1c686284a53d573b9af4bc5b8470b005b0a8"

  test("regenerated manifest matches the HEAD-pinned digest", () => {
    const manifest = generateManifest({ includeExternalEvidence: false })
    expect(manifest.setTreeDigest).toBe(TREE_PIN)
    expect(manifest.overallDigest).toBe(OVERALL_PIN)
  })

  test("external evidence still enters the digest when present", () => {
    // The reproducibility claim excludes the git-ignored artifacts; it must not silently IGNORE
    // them. With evidence included the manifest digests them too, so a produced report is a real
    // input rather than a decoration.
    const withEvidence = generateManifest()
    const withoutEvidence = generateManifest({ includeExternalEvidence: false })
    expect(Object.keys(withEvidence.inputs)).toContain("c0-01-inventory-report")
    expect(Object.keys(withoutEvidence.inputs)).not.toContain("c0-01-inventory-report")
  })
})
