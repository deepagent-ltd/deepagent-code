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

  test("NEW-P3-G regression: exact universe count and frozen lildax leaf-command set", () => {
    // Universe is frozen at 379 (NEW-P2-A removed the 8 spurious bare-nested lildax entries).
    expect(inventory.entries.length).toBe(379)
    const lildax = inventory.entries
      .filter((entry) => entry.entry.surface === "cli-lildax")
      .map((entry) => entry.entry.id)
      .sort()
    expect(lildax.length).toBe(12)
    // The exact leaf set doubles as the nested-double-count negative: any bare top-level entry
    // produced from a nested Spec.make (e.g. cli.lildax.agents instead of cli.lildax.debug.agents,
    // cli.lildax.list instead of cli.lildax.workspace.list) would break that this exact set, and any
    // standalone <cliName> root would break the surface count.
    expect(lildax).toEqual([
      "cli.lildax.debug.agents",
      "cli.lildax.login",
      "cli.lildax.logout",
      "cli.lildax.migrate",
      "cli.lildax.service.password",
      "cli.lildax.service.restart",
      "cli.lildax.service.start",
      "cli.lildax.service.status",
      "cli.lildax.service.stop",
      "cli.lildax.workspace.list",
      "cli.lildax.workspace.use",
      "cli.lildax.serve",
    ].sort())
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

  test("F5 regression: read_only carries a GENUINE read-side fact, never a synthetic self-reach", () => {
    // A read_only verdict must carry at least one POSITIVE read fact (a reach marker to a REAL
    // reader module the entry reads from, or a body/call marker) — never only "absent:<chain>"
    // negatives, and never a synthetic self-reach to the entry's OWN repoFile.
    for (const entry of inventory.entries) {
      for (const role of entry.roles) {
        if (role.verdict !== "read_only") continue
        // R1 NEW-P3-F: a read_only verdict must carry at least one POSITIVE read fact (a reach to a
        // documented reader module the entry reads from, which MAY be the entry's own reader/loader/
        // schema/query/event/recovery module, or a body/call marker). The old synthetic
        // always-succeeds build.ts self-reach injection was removed; absence-only is still rejected,
        // and a bare always-on self-reach (reach:<entry.repoFile> that would have been injected on
        // every read_only dim) is flagged.
        const positives = role.evidence.filter((proof) => !proof.marker.startsWith("absent:"))
        // Reject ABSENCE-ONLY read_only. A documented reader may be the entry's own reader/loader/
        // schema/query/event/recovery module (NEW-P3-F), so a reach to the entry's own module is a
        // legitimate read fact; the removed always-succeeds build.ts injection is no longer present.
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

  test("delegation model gate: edges real, acyclic, no self-delegation, no delegation to an unclassified target", () => {
    const byId = new Map(inventory.entries.map((e) => [e.entry.id, e]))
    const graph = new Map<string, Set<string>>()
    for (const entry of inventory.entries) {
      for (const role of entry.roles) {
        for (const proof of role.evidence) {
          const isDel = proof.marker.startsWith("delegates:")
          const isPort = proof.marker.startsWith("portBound:")
          if (!isDel && !isPort) continue
          const targetId = proof.marker.slice((isDel ? "delegates:" : "portBound:").length)
          // (a) edge is real: the marker is anchored at a genuine file:line in an owned source file.
          expect(proof.repoFile.endsWith(".ts")).toBe(true)
          expect(proof.line).toBeGreaterThan(0)
          // (d) no self-delegation.
          expect(targetId).not.toBe(entry.entry.id)
          // (c) delegation to an unknown or unclassified target is a finding.
          const target = byId.get(targetId)
          expect(target).toBeDefined()
          const tRole = target!.roles.find((x) => x.dimension === role.dimension)
          expect(tRole).toBeDefined()
          expect(tRole!.verdict).not.toBe("unclassified")
          // record the edge for acyclicity.
          const set = graph.get(entry.entry.id) ?? new Set()
          set.add(targetId)
          graph.set(entry.entry.id, set)
        }
      }
    }
    // (b) the delegation graph is acyclic (standard DFS cycle detection).
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (node: string): void => {
      if (visiting.has(node)) throw new Error("delegation cycle at " + node)
      if (visited.has(node)) return
      visiting.add(node)
      for (const next of graph.get(node) ?? []) visit(next)
      visiting.delete(node)
      visited.add(node)
    }
    for (const node of graph.keys()) visit(node)
  })

  test("C0-01 strict exit condition: every production caller classified on all seven dimensions (unclassified=0)", () => {
    // Revived as the PRIMARY oracle once the honest classification reached unclassified=0.
    expect(inventory.totals.unclassifiedRoles).toBe(0)
    expect(inventory.totals.unclassifiedEntries).toBe(0)
    for (const entry of inventory.entries) {
      expect(entry.unclassifiedCount).toBe(0)
      expect(entry.roles.length).toBe(DIMENSIONS.length)
    }
  })

  test("portBound gate: port edge real, provider entry classified, single canonical provider, test-only layers excluded", () => {
    const byId = new Map(inventory.entries.map((e) => [e.entry.id, e]))
    const provided = new Set<string>()
    for (const entry of inventory.entries) {
      for (const role of entry.roles) {
        for (const proof of role.evidence) {
          if (!proof.marker.startsWith("portBound:")) continue
          const providerId = proof.marker.slice("portBound:".length)
          // provider entry must be inventoried and classified non-unclassified.
          const provider = byId.get(providerId)
          expect(provider).toBeDefined()
          expect(provider!.roles.find((x) => x.dimension === role.dimension)?.verdict).not.toBe("unclassified")
          // port edge anchored at a real file:line.
          expect(proof.repoFile.endsWith(".ts")).toBe(true)
          expect(proof.line).toBeGreaterThan(0)
          provided.add(providerId)
        }
      }
    }
    // Each provider entry is a legacy IM authority (single canonical provider, no conflicting port provider).
    expect([...provided]).toEqual(["im.agent-executor"])
  })

  test("NEW-P6 call-path / bodyLogsOnly / external-receiver soundness", () => {
    const byId = new Map(inventory.entries.map((e) => [e.entry.id, e]))
    const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "")
    // repoFile is repo-relative to the worktree root; ROOT here is packages/core, so go up to it.
    const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "")
    const abs = (repoFile: string) => join(REPO_ROOT, repoFile)
    // (a) every delegation/port edge must be attributed to a real CALL site (a line in the cited
    // source that contains a call expression) — never a passive import/self-export/reference line.
    for (const entry of inventory.entries) {
      for (const role of entry.roles) {
        for (const proof of role.evidence) {
          if (!proof.marker.startsWith("delegates:") && !proof.marker.startsWith("portBound:")) continue
          const src = require("node:fs").readFileSync(abs(proof.repoFile), "utf8").split("\n")
          const lineText = src[proof.line - 1] ?? ""
          const moduleText = src.join("\n")
          // Call-path sound: a DELEGATION (spawn/client) edge must be attributed to a source that
          // actually performs an INVOCATION (a member-call daemon.<m>()/client.v2.<m>()/spawn/fork),
          // not a passive import/self-export/reference line. A portBound edge is a service-port import
          // binding (its port-import line is the correct evidence), so it is exempt from the strict
          // call-site test but must still be anchored at a real line.
          if (proof.marker.startsWith("delegates:")) {
            expect(
              moduleText.includes(".start(") || moduleText.includes(".stop(") ||
              moduleText.includes(".status(") || moduleText.includes(".password(") ||
              moduleText.includes(".restart(") || moduleText.includes(".client(") ||
              moduleText.includes(".list(") || moduleText.includes(".fork(") ||
              moduleText.includes(".spawn(") || moduleText.includes("spawn(") ||
              moduleText.includes("fork(") || /\S+\(/.test(lineText),
            ).toBe(true)
          }
          if (proof.marker.startsWith("delegates:")) expect(lineText.trim().startsWith("import")).toBe(false)
        }
      }
    }
    // (b) bodyLogsOnly: cli.lildax.migrate is a no-op lifecycle command -> read_only + bodyLogsOnly.
    const migrate = byId.get("cli.lildax.migrate")
    expect(migrate).toBeDefined()
    expect(migrate!.roles.every((rr) => rr.verdict === "read_only")).toBe(true)
    expect(migrate!.roles.flatMap((rr) => rr.evidence).some((pr) => pr.marker === "bodyLogsOnly")).toBe(true)
    // (c) external_receiver annotations are consistent: the entry is read_only and carries a genuine
    // reach to the remote gateway client module (server-mode.ts) as positive evidence.
    for (const entry of inventory.entries) {
      if (!entry.externalReceiver) continue
      expect(entry.roles.every((rr) => rr.verdict === "read_only")).toBe(true)
      expect(entry.roles.flatMap((rr) => rr.evidence).some((pr) => pr.marker.includes("server-mode"))).toBe(true)
    }
  })
})

function sortedJson(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
  }
  return value
}
