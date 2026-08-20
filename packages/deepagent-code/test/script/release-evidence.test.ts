import { afterEach, describe, expect, test } from "bun:test"
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  RELEASE_EVIDENCE_SCHEMA_VERSION,
  ReleaseEvidenceError,
  archiveGate,
  buildManifest,
  checkManifest,
  findManifestPaths,
  manifestPathFor,
  parseEvidenceSpec,
  serializeManifest,
  sha256Hex,
  sha256OfFile,
} from "../../../../script/release-evidence"

const COMMIT = "a".repeat(40)
const FIXED_TIME = "2026-08-19T00:00:00Z"

const roots: string[] = []

async function newRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-evidence-test-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function baseArchiveOptions(root: string) {
  return {
    root,
    version: "v4.1",
    gateID: "release-gate-20260819",
    commit: COMMIT,
    date: "2026-08-19",
    generatedAt: FIXED_TIME,
    status: "passed" as const,
    summary: "gate summary",
    evidence: [
      {
        kind: "test-summary" as const,
        label: "full-suite",
        path: null,
        sha256: null,
        conclusion: "4967 pass / 0 fail / 5006 tests",
      },
    ],
    signatures: [{ role: "release-owner", actor: "", at: "" }],
  }
}

describe("release evidence manifest tooling", () => {
  test("sha256 is the stable FIPS-180 digest", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  })

  test("manifest serialization is deterministic", () => {
    const root = "unused"
    const options = baseArchiveOptions(root)
    expect(serializeManifest(buildManifest(options))).toBe(serializeManifest(buildManifest(options)))
    const serialized = serializeManifest(buildManifest(options))
    const parsed = JSON.parse(serialized) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual([
      "schema_version",
      "version",
      "gate_id",
      "commit",
      "date",
      "generated_at",
      "status",
      "summary",
      "evidence",
      "signatures",
    ])
    expect(parsed.schema_version).toBe(RELEASE_EVIDENCE_SCHEMA_VERSION)
  })

  test("archive writes the manifest at release-evidence/<version>/<commit>/<gate>/manifest.json", async () => {
    const root = await newRoot()
    const target = archiveGate(baseArchiveOptions(root))
    expect(target).toBe(manifestPathFor(root, "v4.1", COMMIT, "release-gate-20260819"))
    const parsed = JSON.parse(await Bun.file(target).text()) as Record<string, unknown>
    expect(parsed.commit).toBe(COMMIT)
    expect(parsed.date).toBe("2026-08-19")
    expect(parsed.generated_at).toBe(FIXED_TIME)
  })

  test("archive is immutable: regenerating the same gate fails without overwriting", async () => {
    const root = await newRoot()
    const target = archiveGate(baseArchiveOptions(root))
    const before = await Bun.file(target).text()
    expect(() => archiveGate({ ...baseArchiveOptions(root), summary: "changed" })).toThrow(ReleaseEvidenceError)
    expect(await Bun.file(target).text()).toBe(before)
  })

  test("archive validates gate id, commit, date, status and evidence consistency", async () => {
    const root = await newRoot()
    expect(() => archiveGate({ ...baseArchiveOptions(root), gateID: "bad gate" })).toThrow(/--gate/)
    expect(() => archiveGate({ ...baseArchiveOptions(root), commit: "abc" })).toThrow(/--commit/)
    expect(() => archiveGate({ ...baseArchiveOptions(root), date: "2026-08-19" })).not.toThrow()
    expect(() => archiveGate({ ...baseArchiveOptions(root), status: "green" as never })).toThrow(/--status/)
    expect(() =>
      archiveGate({
        ...baseArchiveOptions(root),
        gateID: "gate-2",
        evidence: [
          { kind: "log", label: "a", path: "x", sha256: null, conclusion: "c" },
        ],
      }),
    ).toThrow(/path and sha256/)
  })

  test("check passes for intact file evidence and detects tampering", async () => {
    const root = await newRoot()
    const evidenceFile = path.join(root, "run.log")
    await writeFile(evidenceFile, "original log line\n")
    const options = baseArchiveOptions(root)
    archiveGate({
      ...options,
      evidence: [
        {
          kind: "log",
          label: "run-log",
          path: "run.log",
          sha256: sha256OfFile(evidenceFile),
          conclusion: "captured run log",
        },
      ],
    })
    const manifestPath = manifestPathFor(root, "v4.1", COMMIT, "release-gate-20260819")

    expect(checkManifest(manifestPath).ok).toBe(true)

    await appendFile(evidenceFile, "tampered line\n")
    const tampered = checkManifest(manifestPath)
    expect(tampered.ok).toBe(false)
    expect(tampered.failures.some((failure) => failure.includes("sha256 mismatch"))).toBe(true)

    await rm(evidenceFile)
    const missing = checkManifest(manifestPath)
    expect(missing.ok).toBe(false)
    expect(missing.failures.some((failure) => failure.includes("file missing"))).toBe(true)
  })

  test("check rejects invalid manifests without crashing", async () => {
    const root = await newRoot()
    const manifestPath = path.join(root, "broken.json")
    await writeFile(manifestPath, "{ not json")
    expect(checkManifest(manifestPath).ok).toBe(false)
    expect(checkManifest(path.join(root, "absent.json")).failures[0]).toContain("not found")
  })

  test("findManifestPaths locates gates with and without a commit", async () => {
    const root = await newRoot()
    archiveGate(baseArchiveOptions(root))
    archiveGate({ ...baseArchiveOptions(root), commit: "b".repeat(40) })
    expect(findManifestPaths(root, "v4.1", "release-gate-20260819")).toHaveLength(2)
    expect(findManifestPaths(root, "v4.1", "release-gate-20260819", COMMIT)).toHaveLength(1)
    expect(findManifestPaths(root, "v4.1", "release-gate-20260819", "c".repeat(40))).toHaveLength(0)
  })

  test("parseEvidenceSpec hashes file evidence and keeps text-only entries null", async () => {
    const root = await newRoot()
    const textOnly = parseEvidenceSpec("test-summary:full-suite", root, "conclusion")
    expect(textOnly).toEqual({
      kind: "test-summary",
      label: "full-suite",
      path: null,
      sha256: null,
      conclusion: "conclusion",
    })

    const evidenceFile = path.join(root, "evidence.log")
    await writeFile(evidenceFile, "abc")
    const fileBacked = parseEvidenceSpec(`log:run-log:${evidenceFile}`, root, "conclusion")
    expect(fileBacked.path).toBe("evidence.log")
    expect(fileBacked.sha256).toBe(sha256Hex("abc"))

    expect(() => parseEvidenceSpec("bogus:x", root, "c")).toThrow(/kind/)
    expect(() => parseEvidenceSpec("log:missing:does-not-exist.log", root, "c")).toThrow(/not found/)
  })
})
