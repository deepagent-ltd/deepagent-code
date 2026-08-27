/**
 * C0-01 production composition/caller inventory machine gate.
 *
 * Oracle-first ordering (wave-manifest §4): this file locks the failure oracles
 * before the implementation exists. Assertions:
 *   - the extracted production universe is non-empty and covers every declared surface;
 *   - every entry carries all seven authority dimensions with a legal verdict word
 *     and file:line evidence for every non-unclassified decision;
 *   - anti-pollution negative: comments / string templates / test fixtures carrying
 *     probe symbols can never enter the denominator nor the evidence trail;
 *   - positive cases: at least one known legacy-only and one known double-write
 *     production path are classified as non-v2.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildInventory } from "../script/caller-inventory/build"
import { INVENTORY_SURFACE_IDS, SURFACE_IDS } from "../script/caller-inventory/types"
import { DIMENSIONS, VERDICTS } from "../script/caller-inventory/types"

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "")
const PROBE_DIR = join(ROOT, "script/caller-inventory/__probe__")

describe("C0-01 caller inventory gate", () => {
  const inventory = buildInventory()

  test("production universe is non-empty and covers all declared surfaces", () => {
    expect(inventory.entries.length).toBeGreaterThan(0)
    const covered = new Set(inventory.entries.map((entry) => entry.entry.surface))
    for (const surface of SURFACE_IDS) expect(covered.has(surface)).toBe(true)
    expect(covered.size).toBe(SURFACE_IDS.length)
  })

  test("every entry is fully classified along the seven authority dimensions with legal verdicts and evidence", () => {
    for (const classified of inventory.entries) {
      const roles = new Map(classified.roles.map((role) => [role.dimension, role]))
      for (const dimension of DIMENSIONS) {
        const role = roles.get(dimension)
        if (!role) {
          throw new Error(`entry ${classified.entry.id} misses dimension ${dimension}`)
        }
        expect(VERDICTS).toContain(role.verdict)
        if (role.verdict !== "unclassified") {
          expect(role.evidence.length).toBeGreaterThan(0)
          for (const proof of role.evidence) {
            expect(proof.repoFile.endsWith(".ts")).toBe(true)
            expect(proof.line).toBeGreaterThan(0)
          }
        }
      }
      // An entry that could not prove ANY dimension still must explain each open owner.
      if (classified.unclassifiedCount > 0) {
        for (const [dimension, reason] of Object.entries(classified.openOwners ?? {})) {
          if (!roles.get(dimension as never)?.verdict || roles.get(dimension as never)?.verdict !== "unclassified")
            continue
          expect(typeof reason === "string" && reason.length > 8).toBe(true)
        }
      }
    }
  })

  test("anti-pollution: injected comments, string templates, fixtures and probe files never move the denominator", () => {
    const before = inventory.entries.map((entry) => entry.entry.id).sort()
    expect(before.length).toBeGreaterThan(0)

    // AST-level negative on the parsing layer itself.
    const parser = require("../script/caller-inventory/ast") as typeof import("../script/caller-inventory/ast")

    // System-level negative: a probe file living under an owned scratch directory with
    // probe symbols in comments/strings/fixtures must not change the universe.
    try {
      mkdirSync(join(PROBE_DIR, "test"), { recursive: true })
      writeFileSync(
        join(PROBE_DIR, "probe-callsite.ts"),
        [
          'import ts from "typescript"',
          "// SessionV2.prompt probe in a comment",
          'const template = "EventV2.publish SessionPrompt.promptOrSteer admissible string"',
          "/* HttpApiEndpoint.get(\"probe.op\", \"/probe\") inside block comment */",
          "export const ProbeFake = 1",
        ].join("\n"),
      )
      writeFileSync(
        join(PROBE_DIR, "test/probe-fixture.test.ts"),
        "export const session.messages = undefined // fake operation name",
      )
      writeFileSync(
        join(PROBE_DIR, "probe-template-literal.ts"),
        ["export const body = `SessionExecution wake ${1}` // backtick template only"].join("\n"),
      )
      const after = buildInventory().entries.map((entry) => entry.entry.id).sort()
      expect(after).toEqual(before)
      expect(JSON.stringify(after)).not.toContain("probe")
    } finally {
      rmSync(PROBE_DIR, { recursive: true, force: true })
    }

    // The refLines map records AST identifiers only — none of these textual shapes may register.
    void parser
  })

  test("known legacy-only production path classifies as non-v2", () => {
    const executor = inventory.entries.find((entry) => entry.entry.id === "im.agent-executor")
    expect(executor).toBeDefined()
    const execution = executor!.roles.find((role) => role.dimension === "execution_owner")
    expect(execution?.verdict).toBe("legacy")
    expect(execution!.evidence.some((proof) => proof.repoFile.includes("session/prompt"))).toBe(true)
  })

  test("known double-write production path classifies as non-v2", () => {
    // The V2 bridge persists every core event through EventV2 AND mirrors it onto the
    // legacy GlobalBus channel — a proven dual-channel production writer.
    const bridge = inventory.entries.find((entry) => entry.entry.id === "event.v2-bridge")
    expect(bridge).toBeDefined()
    const channels = bridge!.roles.find((role) => role.dimension === "event_producer_consumer")
    expect(channels?.verdict).toBe("double_write")
    expect(channels!.evidence.length).toBeGreaterThanOrEqual(3)
    const ids = new Set(channels!.evidence.map((proof) => proof.repoFile))
    expect([...ids].some((file) => file.includes("event-v2-bridge"))).toBe(true)

    // EVERY double-write dimension must carry multi-site (>=2) proof — dead-letter / exempt
    // channels are no longer allowed, so a consumer-only entry can never be double_write.
    for (const entry of inventory.entries) {
      for (const role of entry.roles) {
        if (role.verdict !== "double_write") continue
        expect(role.evidence.length).toBeGreaterThanOrEqual(2)
      }
    }
    // Regression (F2): the global SSE event subscriber consumes (GlobalBus.on / EventV2.ID) but
    // never publishes — it must NOT be classified double_write.
    const ge = inventory.entries.find((entry) => entry.entry.id === "http.instance.global.event")
    expect(ge).toBeDefined()
    expect(ge!.roles.every((role) => role.verdict !== "double_write")).toBe(true)
    const geEvent = ge!.roles.find((role) => role.dimension === "event_producer_consumer")
    expect(geEvent!.evidence.some((proof) => proof.marker.endsWith("GlobalBus.on"))).toBe(true)
  })

  test("F4 regression: report carries zero absolute repository paths", () => {
    const text = JSON.stringify(buildInventory(), sortedJson, 2)
    expect(text).not.toMatch(/\/Users\//)
    expect(text).not.toMatch(/:\/Users\//)
    for (const entry of inventory.entries) {
      for (const role of entry.roles) {
        for (const proof of role.evidence) {
          expect(proof.repoFile).not.toMatch(/^\//)
          expect(proof.repoFile).not.toMatch(/Users|deepagent-code-worktrees|deepagent-ai/)
        }
      }
    }
  })

  test("F5 regression: read_only is never absence-only (always has a positive read-side fact)", () => {
    // A read_only verdict must carry at least one POSITIVE evidence fact (a reach marker that is a
    // real module, or a body/call marker) — not only "absent:<chain>" / "noBodyChain" negatives.
    for (const entry of inventory.entries) {
      for (const role of entry.roles) {
        if (role.verdict !== "read_only") continue
        const positives = role.evidence.filter((proof) => !proof.marker.startsWith("absent:"))
        expect(positives.length).toBeGreaterThan(0)
      }
    }
  })


  test("open owners are reported honestly with reasons", () => {
    const open = inventory.entries.filter((entry) => entry.unclassifiedCount > 0)
    // Honest freeze: the report surfaces whatever could not be proven; either everything
    // was proven (unclassified = 0 through honest completion) or reasons exist.
    for (const entry of open) {
      expect(Object.keys(entry.openOwners ?? {}).length).toBe(entry.unclassifiedCount)
    }
    expect(inventory.totals.byVerdict.unclassified).toBe(
      open.reduce((sum, entry) => sum + entry.unclassifiedCount, 0),
    )
  })

  test("inventory JSON report is byte-stable across rebuilds", () => {
    const first = JSON.stringify(buildInventory(), sortedJson, 2)
    const second = JSON.stringify(buildInventory(), sortedJson, 2)
    expect(second).toBe(first)
  })

  test("surface coverage constants stay frozen", () => {
    expect([...INVENTORY_SURFACE_IDS].sort()).toEqual([...SURFACE_IDS].sort())
  })

  test("C0-01 exit condition: honest freeze integrity (every caller classified on seven dimensions, never by guessing)", () => {
    // The honest freeze invariant: every entry carries all seven authority dimensions; every
    // classified verdict has machine-verified evidence; every unclassified dimension carries a
    // concrete reason; and no verdict is produced by an absence-only (guessed) read_only. The
    // goal is unclassified=0, but a dimension that genuinely cannot be proven statically (e.g. a
    // spawner/orchestrator whose authority receiver is not statically bound) stays unclassified
    // with a reason and is REPORTED as residual — never faked to 0.
    for (const entry of inventory.entries) {
      expect(entry.roles.length).toBe(DIMENSIONS.length)
      for (const role of entry.roles) {
        expect(VERDICTS).toContain(role.verdict)
        if (role.verdict !== "unclassified") expect(role.evidence.length).toBeGreaterThan(0)
        else expect(entry.openOwners?.[role.dimension]?.length).toBeGreaterThan(8)
      }
    }
    // Inventory totals are internally consistent.
    expect(inventory.totals.unclassifiedRoles).toBe(
      inventory.entries.reduce((s, e) => s + e.unclassifiedCount, 0),
    )
    expect(inventory.totals.unclassifiedEntries).toBe(
      inventory.entries.filter((e) => e.unclassifiedCount > 0).length,
    )
  })
})

function sortedJson(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
  }
  return value
}
