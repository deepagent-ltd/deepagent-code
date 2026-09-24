import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { isAbsolute } from "node:path"
import { HeadPin } from "../script/manifest-digest/head-pin"
import {
  ManifestVersion,
  assertManifestMatches,
  assertManifestShape,
  buildManifest,
  digestFileContent,
  digestSourceText,
  generateManifest,
  serializeManifest,
  type DeterministicManifest,
} from "../script/manifest-digest/manifest"

const groupsA = { contract: { "contract/selection.ts": "a".repeat(64) } }
const groupsB = { contract: { "contract/selection.ts": "b".repeat(64) } }

test("source checkout CRLF and LF share one digest while external evidence preserves exact bytes", () => {
  expect(digestSourceText("export const x = 1\n")).toBe(digestSourceText("export const x = 1\r\n"))
  expect(digestFileContent("evidence\n")).not.toBe(digestFileContent("evidence\r\n"))
})

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
        expect(key).not.toContain("\\")
        expect(key).not.toContain("core-v2-beta-w2-digest")
      }
    }
  })
})

describe("C0-05 requirement coverage", () => {
  test("handles absent input categories deterministically (missing dirs + non-existent repo)", () => {
    const manifest = generateManifest()
    // The input set is closed over the committed-tree groups; no .artifacts evidence groups exist.
    expect(serializeManifest(manifest)).toBe(serializeManifest(generateManifest()))
    expect(Object.keys(manifest.inputs).sort()).toEqual([
      "contract",
      "migration-registry",
      "package-versions",
      "runtime-flag-config",
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
// pinned digests live in `script/manifest-digest/head-pin.ts` (the single source of truth shared
// with the reproducibility gate and the docs-claims gate): any drift in the manifest input groups
// (contract / migration registry / package versions / runtime flags) fails here.
//
// SCOPE (K-05/B-11 root fix): the generator input set is CLOSED over committed, git-tracked files.
// The historical leak was the digest reading the git-ignored `packages/core/.artifacts/**`
// (caller-inventory report, perf baseline), so a machine that had run those tools pinned a value a
// clean checkout could never reproduce (O-TEST-3 / O-W12-3) — unreproducible at HEAD by
// construction. External evidence now enters only when a caller explicitly binds produced bytes via
// `extraInputs` (content-addressed under the documented repo-relative key), which is what the
// candidate-ledger generator does for the freshly produced inventory report.
describe("C7-10 HEAD reproducibility (a10 R3 close)", () => {
  test("regenerated manifest matches the HEAD-pinned digest", () => {
    const manifest = generateManifest()
    expect(manifest.setTreeDigest).toBe(HeadPin.setTreeDigest)
    expect(manifest.overallDigest).toBe(HeadPin.overallDigest)
  })

  test("git-ignored .artifacts residue cannot perturb the digest", () => {
    // Build a minimal repo root with real inputs, then plant a .artifacts decoy tree (plus a stray
    // .ts outside every input dir): the manifest bytes must not move.
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-digest-decoy-"))
    const write = (relPath: string, content: unknown) => {
      const abs = path.join(repoRoot, relPath)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content))
    }
    try {
      for (const relPath of [
        "packages/core/package.json",
        "packages/deepagent-code/package.json",
        "packages/app/package.json",
        "packages/desktop/package.json",
      ])
        write(relPath, { name: relPath, version: "0.0.0" })
      write("packages/core/src/contract/selection.ts", "export const x = 1\n")
      write("packages/core/src/config/config.ts", "export const y = 2\n")
      write("packages/core/src/database/migration.gen.ts", "export const migrations = []\n")
      const base = generateManifest({ repoRoot })

      write("packages/core/.artifacts/caller-inventory/report.json", { callers: ["decoy"] })
      write("packages/core/.artifacts/perf-baseline/run-1/manifest.json", { runs: [1] })
      write("packages/core/.artifacts/junk.ts", "export const decoy = true\n")
      write("packages/core/src/unrelated/junk.ts", "export const outsideInputDirs = true\n")
      const decoyed = generateManifest({ repoRoot })

      expect(serializeManifest(decoyed)).toBe(serializeManifest(base))
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  test("external evidence enters only as explicit content-addressed inputs", () => {
    // Binding produced evidence is an explicit caller act: the exact bytes are hashed under the
    // documented repo-relative key, so the default manifest is untouched and a bound manifest is
    // reproducible from (tree, evidence bytes) alone.
    const base = generateManifest()
    const bound = generateManifest({
      extraInputs: {
        "c0-01-inventory-report": {
          "packages/core/.artifacts/caller-inventory/report.json": '{"callers":[]}',
        },
      },
    })
    expect(bound.overallDigest).not.toBe(base.overallDigest)
    expect(bound.inputs["c0-01-inventory-report"]?.["packages/core/.artifacts/caller-inventory/report.json"]).toBe(
      digestFileContent('{"callers":[]}'),
    )
  })
})
