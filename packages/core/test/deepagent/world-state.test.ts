import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DocumentStore } from "../../src/deepagent/document-store"
import * as WorldState from "../../src/deepagent/context/world-state"
import * as Bridge from "../../src/deepagent/context/bridge"

// V4.0.1 P1 (§3.6) — World State snapshot-diff + tail re-injection invariants.

describe("world state — upsertSlot snapshot-diff (§3.6)", () => {
  test("a brand-new slot starts at version 1", () => {
    const ws = WorldState.upsertSlot(WorldState.emptyWorldState("p"), "vcs", "branch main")
    expect(ws.slots).toHaveLength(1)
    expect(ws.slots[0]!.version).toBe(1)
    expect(ws.slots[0]!.value).toBe("branch main")
  })

  test("value UNCHANGED ⇒ no version bump (returns the same state, byte-stable)", () => {
    const a = WorldState.upsertSlot(WorldState.emptyWorldState("p"), "vcs", "branch main", 100)
    const b = WorldState.upsertSlot(a, "vcs", "branch main", 999)
    expect(b).toBe(a) // identical reference — no churn
    expect(b.slots[0]!.version).toBe(1)
    expect(b.slots[0]!.updatedAt).toBe(100) // timestamp not touched on a no-op
  })

  test("value CHANGED ⇒ version bumps + timestamp updates", () => {
    const a = WorldState.upsertSlot(WorldState.emptyWorldState("p"), "vcs", "branch main", 100)
    const b = WorldState.upsertSlot(a, "vcs", "branch feature", 200)
    expect(b.slots[0]!.version).toBe(2)
    expect(b.slots[0]!.value).toBe("branch feature")
    expect(b.slots[0]!.updatedAt).toBe(200)
  })
})

describe("world state — collectSlots preserves prior on non-collection", () => {
  test("omitted / empty kind keeps the prior slot value; present kinds are upserted", () => {
    let ws = WorldState.emptyWorldState("p")
    ws = WorldState.collectSlots(ws, { vcs: "branch main", diagnostics: "clean" }, 1)
    // Next tick: diagnostics could not be recomputed (undefined) and env is empty string.
    ws = WorldState.collectSlots(ws, { vcs: "branch feature", diagnostics: undefined, env: "  " }, 2)
    const byKind = (k: WorldState.WorldStateSlotKind) => ws.slots.find((s) => s.kind === k)
    expect(byKind("vcs")!.value).toBe("branch feature")
    expect(byKind("vcs")!.version).toBe(2)
    expect(byKind("diagnostics")!.value).toBe("clean") // preserved (non-collection)
    expect(byKind("diagnostics")!.version).toBe(1)
    expect(byKind("env")).toBeUndefined() // empty string was never collected
  })
})

describe("world state — renderWorldState tail byte-stability + responsibility separation", () => {
  test("unchanged slots ⇒ byte-identical render; only the changed slot's segment moves", () => {
    let ws = WorldState.emptyWorldState("p")
    ws = WorldState.collectSlots(ws, { open_files: "src/a.ts: entry", vcs: "branch main", env: "node v1" }, 1)
    const r1 = WorldState.renderWorldState(ws)
    // A tick that changed nothing renders byte-for-byte identically (near-end cache stays warm).
    const wsSame = WorldState.collectSlots(ws, { open_files: "src/a.ts: entry", vcs: "branch main", env: "node v1" }, 2)
    expect(WorldState.renderWorldState(wsSame)).toBe(r1)
    // Change only vcs: env + open_files segments are byte-identical; only the vcs line differs.
    const wsChanged = WorldState.collectSlots(ws, { vcs: "branch feature" }, 3)
    const r2 = WorldState.renderWorldState(wsChanged)
    expect(r2).toContain("node v1") // env segment unchanged
    expect(r2).toContain("src/a.ts: entry") // open_files segment unchanged
    expect(r2).toContain("branch feature")
    expect(r2).not.toContain("branch main")
  })

  test("empty world state renders to '' (⇒ caller injects nothing)", () => {
    expect(WorldState.renderWorldState(WorldState.emptyWorldState("p"))).toBe("")
  })

  test("responsibility separation: the render carries the LATEST file value, overriding a stale one", () => {
    // Simulate a summary having captured a stale file value; World State holds the fresh one. The tail
    // block re-injects the fresh value with an explicit "trust these over the summary" instruction.
    let ws = WorldState.upsertSlot(WorldState.emptyWorldState("p"), "open_files", "config.ts: PORT=3000")
    ws = WorldState.upsertSlot(ws, "open_files", "config.ts: PORT=8080")
    const rendered = WorldState.renderWorldState(ws)
    expect(rendered).toContain("PORT=8080") // latest wins
    expect(rendered).not.toContain("PORT=3000")
    expect(rendered).toContain("trust these over") // the override instruction
  })
})
