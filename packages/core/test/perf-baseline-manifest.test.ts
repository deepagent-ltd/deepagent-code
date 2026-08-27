import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { EVIDENCE_LEVEL_DECLARATION, buildAndWriteManifest } from "../script/perf-baseline/manifest"
import { UNIT, writeSummariesJsonl } from "../script/perf-baseline/samples"
import type { ScenarioOutcome } from "../script/perf-baseline/lib"

const sampleOutcome: ScenarioOutcome = {
  name: "probe-scenario",
  owner_note: "unit-test probe",
  status: "ok",
  evidence_refs: ["unit-test"],
  duration_ms: 12,
  groups: [
    { group: "warmup", values: [1, 2], failures: 0 },
    { group: "measured", values: [3, 4, 5.5], failures: 1 },
  ],
  extras: { unit: "ms", sample_basis: "unit-test", warmup_policy: "unit-test declared" },
}

const REQUIRED_TOP_LEVEL_FIELDS = [
  "run_id",
  "declaration",
  "started_at",
  "finished_at",
  "evidence_level",
  "frozen_base",
  "tools",
  "machine",
  "power_state",
  "interference_processes",
  "fixture_scale",
  "env_allowlist",
  "warmup_policy",
  "statistics_method",
  "unit",
  "isolation",
  "exit_status",
  "scenarios",
] as const

const REQUIRED_GROUP_SUMMARY_FIELDS = ["n", "min", "max", "mean", "stdev", "p50", "p95", "p99"] as const

describe("perf baseline run manifest integrity", () => {
  test("evidence-level declaration is present and names D3-local plus the non-package caveat", () => {
    expect(EVIDENCE_LEVEL_DECLARATION).toContain("D3-local")
    expect(EVIDENCE_LEVEL_DECLARATION).toContain("不等同 D5/D6")
  })

  test("written manifest carries every required identity/environment/statistics field", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-manifest-test-"))
    try {
      const manifestPath = await buildAndWriteManifest({
        runId: "unit-run-id",
        outputDir: dir,
        startedAtMs: Date.now() - 1000,
        outcomes: [sampleOutcome],
        fixtureScale: { empty: { session_rows: 0, message_rows: 0 } },
        testHome: "/tmp/perf-unit-test-home",
        expectations: { commit: "unit-commit", tree: "unit-tree" },
      })
      expect(manifestPath.endsWith(path.join("manifest.json"))).toBe(true)

      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
      for (const field of REQUIRED_TOP_LEVEL_FIELDS) expect(Object.hasOwn(manifest, field)).toBe(true)

      expect(manifest.run_id).toBe("unit-run-id")
      expect(manifest.declaration).toBe(EVIDENCE_LEVEL_DECLARATION)
      expect(manifest.evidence_level).toBe("D3-local")
      expect(manifest.unit).toBe(UNIT)
      expect(manifest.frozen_base.expected_commit).toBe("unit-commit")
      expect(manifest.frozen_base.warn_mismatch).toBe(true) // real HEAD cannot equal the unit-test sentinel
      // Environment boundary fields must be populated objects, never empty stubs.
      expect(Object.keys(manifest.machine).length).toBeGreaterThan(0)
      expect(manifest.env_allowlist.DEEPAGENT_CODE_TEST_HOME).toBe("/tmp/perf-unit-test-home")
      // ok-only outcomes record a non-failing exit status.
      expect(manifest.exit_status).toBe(0)
      expect(manifest.isolation).toBe(null) // not supplied in this unit-test call

      const scenario = manifest.scenarios[0]
      expect(scenario.name).toBe("probe-scenario")
      expect(scenario.owner_note).toBe("unit-test probe")
      expect(scenario.groups.measured.n).toBe(3)
      for (const field of REQUIRED_GROUP_SUMMARY_FIELDS) {
        expect(Object.hasOwn(scenario.groups.measured, field)).toBe(true)
      }
      expect(scenario.groups.measured.failures).toBe(1)
      // Every group emits one raw-samples artifact with a recorded hash.
      expect(scenario.artifacts.length).toBe(2)
      for (const artifact of scenario.artifacts) {
        expect(artifact.path.startsWith("raw/")).toBe(true)
        expect(artifact.sha256_12).toMatch(/^[0-9a-f]{12}$/)
      }

      const digests = JSON.parse(fs.readFileSync(path.join(dir, "artifact-hashes.json"), "utf8"))
      expect(digests.files.length).toBe(2)
      expect(digests.files[0].sha256_12).toMatch(/^[0-9a-f]{12}$/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("interference at_start/at_end are genuine independent samples with capture timestamps", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-manifest-iso-"))
    try {
      const startSnapshot = {
        captured_at: "2026-01-01T00:00:00.000Z",
        elapsed_ms: 0,
        processes: [{ pcpu: "0.0", pmem: "0.0", command: "test-proc" }],
      }
      const manifestPath = await buildAndWriteManifest({
        runId: "iso-run-id",
        outputDir: dir,
        startedAtMs: Date.now() - 5000,
        outcomes: [sampleOutcome],
        fixtureScale: { empty: { session_rows: 0, message_rows: 0 } },
        testHome: "/tmp/perf-unit-test-home",
        interferenceAtStart: startSnapshot,
        expectations: { commit: "unit-commit", tree: "unit-tree" },
      })
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
      const atStart = manifest.interference_processes.at_start
      const atEnd = manifest.interference_processes.at_end

      // StStart: the value we injected verbatim (manifest must NOT re-sample it at build time).
      expect(atStart.captured_at).toBe("2026-01-01T00:00:00.000Z")
      expect(atStart.elapsed_ms).toBe(0)
      expect(atStart.processes[0].command).toBe("test-proc")
      // AtEnd: captured at build time, so it must be a DIFFERENT sample (independent, not byte-identical).
      expect(atEnd.captured_at).not.toBe(atStart.captured_at)
      expect(atEnd.elapsed_ms).toBeGreaterThan(atStart.elapsed_ms)
      // Both carry capture metadata and a process list; timestamps parse.
      for (const snap of [atStart, atEnd]) {
        expect(Object.hasOwn(snap, "captured_at")).toBe(true)
        expect(Object.hasOwn(snap, "elapsed_ms")).toBe(true)
        expect(Array.isArray(snap.processes)).toBe(true)
        expect(Number.isNaN(Date.parse(snap.captured_at))).toBe(false)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("summaries jsonl writes one parseable JSON object per line", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-jsonl-test-"))
    try {
      const target = path.join(dir, "summaries.jsonl")
      writeSummariesJsonl(target, [
        { scenario: "a", group: "g", n: 2 },
        { scenario: "b", group: "h", n: 3 },
      ])
      const lines = fs.readFileSync(target, "utf8").trim().split("\n")
      expect(lines.length).toBe(2)
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
      expect(JSON.parse(lines[0]).scenario).toBe("a")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
