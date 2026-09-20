import { expect, test } from "bun:test"
import { SessionCompaction } from "@deepagent-code/core/session/compaction"

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      source: { type: "data", data: base64 },
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

// V4.0.1 P1 §3.4 — the four-bucket NARROW summary template (gated by worldStateReinjection at the
// deepagent-code call site). narrow OFF ⇒ the legacy template (byte-for-byte pre-V4.0.1).
test("buildPrompt narrow=true uses the four-bucket template and forbids file/env/diagnostics snapshots", () => {
  const narrow = SessionCompaction.buildPrompt({ context: [], narrow: true })
  expect(narrow).toContain("## Progress & Key Decisions")
  expect(narrow).toContain("## Data References")
  expect(narrow).toContain("Except for designated durable values, do NOT record file contents")
  expect(narrow).toContain("HIGHEST PRIORITY: preserve every value the user explicitly designated as a durable fact")
  expect(narrow).toContain("A designation may refer indirectly to a value")
  expect(narrow).toContain("verify that no designated durable value was omitted")
  // The narrowed template drops the legacy "Relevant Files" / "Critical Context" content buckets.
  expect(narrow).not.toContain("## Relevant Files")
  expect(narrow).not.toContain("## Critical Context")
})

test("buildPrompt narrow omitted ⇒ legacy template (unchanged)", () => {
  const legacy = SessionCompaction.buildPrompt({ context: [] })
  expect(legacy).toContain("## Relevant Files")
  expect(legacy).toContain("## Critical Context")
  expect(legacy).not.toContain("## Data References")
})

test("inputBudget subtracts only the input-side compaction buffer", () => {
  expect(SessionCompaction.inputBudget(1_048_576, 20_000)).toBe(1_028_576)
  expect(SessionCompaction.inputBudget(200_000, 20_000)).toBe(180_000)
})

// Compaction budgets (see the constants in src/session/compaction.ts): the trigger and the verbatim
// retention both scale with the model's window, because a fixed 20k headroom put the trigger at ~92%
// of the window — a 133-turn ablation run never reached it and compaction never relieved the replay.
test("the compaction trigger scales with the window and keeps a floor", () => {
  const proportional = { buffer: 0, bufferRatio: 0.18 }
  // 18% of a large window, floored for a small one.
  expect(SessionCompaction.resolvedBuffer(258_400, proportional)).toBe(Math.floor(258_400 * 0.18))
  expect(SessionCompaction.resolvedBuffer(1_000_000, proportional)).toBe(180_000)
  expect(SessionCompaction.resolvedBuffer(5_000, proportional)).toBe(2_000)
  // An explicit absolute buffer still wins over the ratio.
  expect(SessionCompaction.resolvedBuffer(258_400, { buffer: 20_000, bufferRatio: 0.18 })).toBe(20_000)
  // The budget handed to the trigger is window minus headroom.
  expect(SessionCompaction.inputBudget(200_000, SessionCompaction.resolvedBuffer(200_000, proportional))).toBe(
    200_000 - 36_000,
  )
})

test("verbatim retention scales with the window inside a clamped band", () => {
  // No ratio configured: the absolute default is used unchanged (existing behaviour).
  expect(SessionCompaction.resolvedKeepTokens(258_400, { tokens: 8_000 })).toBe(8_000)
  // 5% of the window, clamped to [8k, 32k]: a small window keeps the old default, a 1M window does
  // not retain 160k the way a raw 16% policy would.
  expect(SessionCompaction.resolvedKeepTokens(128_000, { tokens: 8_000, keepRatio: 0.05 })).toBe(8_000)
  expect(SessionCompaction.resolvedKeepTokens(258_400, { tokens: 8_000, keepRatio: 0.05 })).toBe(12_920)
  expect(SessionCompaction.resolvedKeepTokens(1_000_000, { tokens: 8_000, keepRatio: 0.05 })).toBe(32_000)
})
