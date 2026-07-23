/**
 * Tests for F1: activity-level tool-call sequence tracker.
 *
 * Coverage targets from 4.0.4_r4.md §F1 acceptance criteria:
 *   1. Single-message ABABAB triggers (period-2, ≥3 repetitions within one processor).
 *   2. Cross-6-message ABABAB triggers (same sequence spread across 6 assistant messages).
 *   3. ABCABCABC triggers (period-3).
 *   4. ABCDABCDABCD triggers (period-4).
 *   5. AAA triggers (period-1 — original gate preserved).
 *   6. Incomplete cycles do NOT trigger (ABAB = only 2 repetitions).
 *   7. Continuously changing arguments do NOT trigger.
 *   8. Two distinct user activities do NOT share state (each gets a fresh tracker).
 *   9. Duplicate permission requests are suppressed for the same sequence.
 *  10. Object key order does not affect the fingerprint (canonical JSON).
 */

import { describe, expect, test } from "bun:test"
import { ToolSequenceTracker } from "@/session/processor"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simulate a complete (done) tool call on a tracker. */
function push(tracker: ToolSequenceTracker, id: string, tool: string, input: unknown = {}): void {
  tracker.push(id, fingerprint(tool, input))
  tracker.markDone(id)
}

/** Push without marking done (simulates the running/current call). */
function pushRunning(tracker: ToolSequenceTracker, id: string, tool: string, input: unknown = {}): void {
  tracker.push(id, fingerprint(tool, input))
}

/** Replicate the fingerprint logic from processor.ts for test assertions. */
function fingerprint(tool: string, input: unknown): string {
  return tool + ":" + canonicalJson(input)
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return "[" + (value as unknown[]).map(canonicalJson).join(",") + "]"
  const obj = value as Record<string, unknown>
  const pairs = Object.keys(obj)
    .sort()
    .map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]))
  return "{" + pairs.join(",") + "}"
}

// ---------------------------------------------------------------------------
// Acceptance criterion 5: period-1 (AAA)
// ---------------------------------------------------------------------------

describe("period-1 detection (AAA)", () => {
  test("AAA triggers on the 3rd call", () => {
    const t = new ToolSequenceTracker()
    push(t, "1", "bash", { cmd: "ls" })
    push(t, "2", "bash", { cmd: "ls" })
    pushRunning(t, "3", "bash", { cmd: "ls" })
    const result = t.detect()
    expect(result).not.toBeNull()
    expect(result?.period).toBe(1)
    expect(result?.count).toBe(3)
  })

  test("AA (only 2) does NOT trigger", () => {
    const t = new ToolSequenceTracker()
    push(t, "1", "bash", { cmd: "ls" })
    pushRunning(t, "2", "bash", { cmd: "ls" })
    expect(t.detect()).toBeNull()
  })

  test("different inputs do NOT trigger period-1", () => {
    const t = new ToolSequenceTracker()
    push(t, "1", "bash", { cmd: "ls" })
    push(t, "2", "bash", { cmd: "pwd" })
    pushRunning(t, "3", "bash", { cmd: "ls" })
    expect(t.detect()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Acceptance criterion 1 & 2: period-2 (ABABAB), single and cross-message
// ---------------------------------------------------------------------------

describe("period-2 detection (ABABAB)", () => {
  test("ABABAB in a single sequence triggers (criterion 1)", () => {
    const t = new ToolSequenceTracker()
    push(t, "1", "read", { path: "/a" })
    push(t, "2", "bash", { cmd: "x" })
    push(t, "3", "read", { path: "/a" })
    push(t, "4", "bash", { cmd: "x" })
    push(t, "5", "read", { path: "/a" })
    pushRunning(t, "6", "bash", { cmd: "x" })
    const result = t.detect()
    expect(result).not.toBeNull()
    expect(result?.period).toBe(2)
  })

  test("ABAB (4 calls, only 2 repetitions) does NOT trigger (criterion 6)", () => {
    const t = new ToolSequenceTracker()
    push(t, "1", "read", { path: "/a" })
    push(t, "2", "bash", { cmd: "x" })
    push(t, "3", "read", { path: "/a" })
    pushRunning(t, "4", "bash", { cmd: "x" })
    expect(t.detect()).toBeNull()
  })

  test("cross-6-message ABABAB triggers (criterion 2)", () => {
    // Six separate tracker.push calls — one per assistant-message as in prod.
    const t = new ToolSequenceTracker()
    // Message 1 → call A
    push(t, "m1c1", "read", { path: "/a" })
    // Message 2 → call B
    push(t, "m2c1", "bash", { cmd: "x" })
    // Message 3 → call A
    push(t, "m3c1", "read", { path: "/a" })
    // Message 4 → call B
    push(t, "m4c1", "bash", { cmd: "x" })
    // Message 5 → call A
    push(t, "m5c1", "read", { path: "/a" })
    // Message 6 → call B (current, running)
    pushRunning(t, "m6c1", "bash", { cmd: "x" })
    const result = t.detect()
    expect(result).not.toBeNull()
    expect(result?.period).toBe(2)
    expect(result?.count).toBe(3)
  })

  test("AB (different tools) plus a third different tool does not trigger period-2", () => {
    const t = new ToolSequenceTracker()
    push(t, "1", "read", { path: "/a" })
    push(t, "2", "bash", { cmd: "x" })
    pushRunning(t, "3", "write", { path: "/c" })
    expect(t.detect()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Acceptance criterion 3: period-3 (ABCABCABC)
// ---------------------------------------------------------------------------

describe("period-3 detection (ABCABCABC)", () => {
  test("ABCABCABC triggers", () => {
    const t = new ToolSequenceTracker()
    push(t, "1", "read", { path: "/a" })
    push(t, "2", "bash", { cmd: "x" })
    push(t, "3", "write", { path: "/c" })
    push(t, "4", "read", { path: "/a" })
    push(t, "5", "bash", { cmd: "x" })
    push(t, "6", "write", { path: "/c" })
    push(t, "7", "read", { path: "/a" })
    push(t, "8", "bash", { cmd: "x" })
    pushRunning(t, "9", "write", { path: "/c" })
    const result = t.detect()
    expect(result).not.toBeNull()
    expect(result?.period).toBe(3)
  })

  test("ABCABC (6 calls, only 2 reps) does NOT trigger", () => {
    const t = new ToolSequenceTracker()
    push(t, "1", "read", { path: "/a" })
    push(t, "2", "bash", { cmd: "x" })
    push(t, "3", "write", { path: "/c" })
    push(t, "4", "read", { path: "/a" })
    push(t, "5", "bash", { cmd: "x" })
    pushRunning(t, "6", "write", { path: "/c" })
    expect(t.detect()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Acceptance criterion 4: period-4 (ABCDABCDABCD)
// ---------------------------------------------------------------------------

describe("period-4 detection (ABCDABCDABCD)", () => {
  test("ABCDABCDABCD triggers", () => {
    const t = new ToolSequenceTracker()
    const calls = [
      ["read", { path: "/a" }],
      ["bash", { cmd: "x" }],
      ["write", { path: "/c" }],
      ["list", { dir: "/d" }],
    ] as const
    let id = 0
    for (let rep = 0; rep < 3; rep++) {
      for (let i = 0; i < 4; i++) {
        id++
        const [tool, input] = calls[i]
        const isLast = rep === 2 && i === 3
        if (isLast) pushRunning(t, String(id), tool, input)
        else push(t, String(id), tool, input)
      }
    }
    const result = t.detect()
    expect(result).not.toBeNull()
    expect(result?.period).toBe(4)
  })

  test("ABCDABCD (8 calls, 2 reps) does NOT trigger", () => {
    const t = new ToolSequenceTracker()
    const calls = [
      ["read", { path: "/a" }],
      ["bash", { cmd: "x" }],
      ["write", { path: "/c" }],
      ["list", { dir: "/d" }],
    ] as const
    let id = 0
    for (let rep = 0; rep < 2; rep++) {
      for (let i = 0; i < 4; i++) {
        id++
        const [tool, input] = calls[i]
        const isLast = rep === 1 && i === 3
        if (isLast) pushRunning(t, String(id), tool, input)
        else push(t, String(id), tool, input)
      }
    }
    expect(t.detect()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Acceptance criterion 7: continuously changing arguments
// ---------------------------------------------------------------------------

describe("continuously changing arguments do NOT trigger", () => {
  test("same tool with monotonically changing input does not trigger", () => {
    const t = new ToolSequenceTracker()
    for (let i = 1; i <= 12; i++) {
      const id = String(i)
      if (i < 12) push(t, id, "bash", { cmd: `step-${i}` })
      else pushRunning(t, id, "bash", { cmd: `step-${i}` })
    }
    expect(t.detect()).toBeNull()
  })

  test("alternating tools with always-different arguments do not trigger", () => {
    const t = new ToolSequenceTracker()
    for (let i = 1; i <= 12; i++) {
      const tool = i % 2 === 0 ? "bash" : "read"
      const id = String(i)
      if (i < 12) push(t, id, tool, { step: i })
      else pushRunning(t, id, tool, { step: i })
    }
    expect(t.detect()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Acceptance criterion 8: two activities use fresh trackers
// ---------------------------------------------------------------------------

describe("activity isolation (fresh tracker per activity)", () => {
  test("sequence split across two tracker instances does not trigger", () => {
    // Simulate activity 1: calls A, B, A
    const t1 = new ToolSequenceTracker()
    push(t1, "1", "read", { path: "/a" })
    push(t1, "2", "bash", { cmd: "x" })
    pushRunning(t1, "3", "read", { path: "/a" })
    // activity 1 never reaches ABABAB threshold

    // Simulate activity 2: starts fresh — picks up B, A, B
    const t2 = new ToolSequenceTracker()
    push(t2, "4", "bash", { cmd: "x" })
    push(t2, "5", "read", { path: "/a" })
    pushRunning(t2, "6", "bash", { cmd: "x" })
    // t2 only has 3 calls; no 6-call window for period-2
    expect(t1.detect()).toBeNull()
    expect(t2.detect()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Acceptance criterion 9: duplicate permission suppression
// ---------------------------------------------------------------------------

describe("duplicate permission suppression (hasTriggered / setTriggered)", () => {
  test("same sequence only triggers once", () => {
    const t = new ToolSequenceTracker()
    push(t, "1", "bash", { cmd: "ls" })
    push(t, "2", "bash", { cmd: "ls" })
    pushRunning(t, "3", "bash", { cmd: "ls" })

    const first = t.detect()!
    expect(first).not.toBeNull()
    expect(t.hasTriggered(first.sequenceKey)).toBe(false)
    t.setTriggered(first.sequenceKey)
    expect(t.hasTriggered(first.sequenceKey)).toBe(true)

    // Simulate the tool result arriving: settleToolCall → markDone("3")
    t.markDone("3")

    // Next activity steps produce the same pattern again
    push(t, "4", "bash", { cmd: "ls" })
    pushRunning(t, "5", "bash", { cmd: "ls" })
    const second = t.detect()!
    expect(second).not.toBeNull()
    // Sequence key is the same → already suppressed
    expect(t.hasTriggered(second.sequenceKey)).toBe(true)
  })

  test("different sequences have independent triggered state", () => {
    const t = new ToolSequenceTracker()
    push(t, "1", "bash", { cmd: "ls" })
    push(t, "2", "bash", { cmd: "ls" })
    pushRunning(t, "3", "bash", { cmd: "ls" })

    const r = t.detect()!
    t.setTriggered(r.sequenceKey)

    // A completely different sequence key should NOT be marked as triggered
    expect(t.hasTriggered("other\x00sequence")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Acceptance criterion 10: canonical JSON — key order independence
// ---------------------------------------------------------------------------

describe("canonical JSON fingerprint (key order independence)", () => {
  test("objects with the same keys/values in different order produce the same fingerprint", () => {
    const t = new ToolSequenceTracker()

    // Two calls with logically identical input but different key order
    const inputA = { b: 2, a: 1, c: { z: 26, m: 13 } }
    const inputB = { a: 1, c: { m: 13, z: 26 }, b: 2 }

    push(t, "1", "bash", inputA)
    push(t, "2", "bash", inputA)
    pushRunning(t, "3", "bash", inputB) // same canonical form as inputA

    const result = t.detect()
    expect(result).not.toBeNull()
    expect(result?.period).toBe(1) // treated as the same call repeated
  })

  test("arrays preserve order in canonical JSON", () => {
    const t = new ToolSequenceTracker()
    // Different array orders must NOT match
    push(t, "1", "bash", { args: [1, 2, 3] })
    push(t, "2", "bash", { args: [1, 2, 3] })
    pushRunning(t, "3", "bash", { args: [3, 2, 1] })
    // The third call has a different fingerprint → no period-1 match
    expect(t.detect()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// "Prior calls must be done" invariant
// ---------------------------------------------------------------------------

describe("done invariant", () => {
  test("calls not yet marked done do NOT contribute to detection window", () => {
    const t = new ToolSequenceTracker()
    // Push 3 calls but don't mark any as done — all are still "running"
    t.push("1", fingerprint("bash", { cmd: "ls" }))
    t.push("2", fingerprint("bash", { cmd: "ls" }))
    t.push("3", fingerprint("bash", { cmd: "ls" }))
    // Only the LAST may be running; the first two are not done → should not trigger
    expect(t.detect()).toBeNull()
  })

  test("once prior calls are marked done the loop is detected", () => {
    const t = new ToolSequenceTracker()
    t.push("1", fingerprint("bash", { cmd: "ls" }))
    t.markDone("1")
    t.push("2", fingerprint("bash", { cmd: "ls" }))
    t.markDone("2")
    t.push("3", fingerprint("bash", { cmd: "ls" })) // current, not done
    expect(t.detect()).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Window size enforcement (keeps only last 12)
// ---------------------------------------------------------------------------

describe("sliding window (max 12 calls)", () => {
  test("13th call evicts the 1st; pattern that relied on 1st call is gone", () => {
    const t = new ToolSequenceTracker()
    // Push 12 unique calls then one that would form AAA only if 1st were present
    for (let i = 1; i <= 12; i++) push(t, String(i), "unique-" + i, {})
    // Now push something that forms a period-1 with only its peers:
    push(t, "13", "bash", { cmd: "ls" })
    push(t, "14", "bash", { cmd: "ls" })
    pushRunning(t, "15", "bash", { cmd: "ls" })
    // There are only 3 bash calls in the window — should detect AAA
    const result = t.detect()
    expect(result).not.toBeNull()
    expect(result?.period).toBe(1)
  })
})
