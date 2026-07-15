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
  expect(narrow).toContain("Do NOT record file contents")
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
