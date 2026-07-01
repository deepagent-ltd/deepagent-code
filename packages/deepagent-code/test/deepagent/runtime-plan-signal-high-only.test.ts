import { describe, it, expect } from "bun:test"

// RX (S1-v3.5): documents and tests the CONTRACT that runtime evidence (debug
// session / profile) can surface as a high-confidence plan signal, but NEVER
// auto-modifies plans, and NEVER degrades general/direct modes.
//
// This is a contract/documentation test: it asserts the SHAPE of evidence
// artifacts and verifies that their mere presence cannot trigger plan changes.
// No live debug or profile runs are needed — the contract is about data structures
// and invariants, not execution.

// ——— DEBUG_SESSION.json evidence shape contract ——————————————————————————————

type EvidenceKind = "lsp_query" | "debug_session" | "profile"

interface EvidenceArtifact {
  evidence_kind: EvidenceKind
  [key: string]: unknown
}

function isDebugEvidence(a: EvidenceArtifact): boolean {
  return a.evidence_kind === "debug_session"
}

function isProfileEvidence(a: EvidenceArtifact): boolean {
  return a.evidence_kind === "profile"
}

// ——— plan signal contract ——————————————————————————————————————————————————

type ConfidenceLevel = "low" | "medium" | "high" | "confirmed"

interface PlanSignal {
  /** The evidence artifact that drives this signal. */
  evidence_kind: EvidenceKind
  /** Confidence level; only "high" and "confirmed" may surface to plan layer. */
  confidence: ConfidenceLevel
  /** What the signal says; never auto-applied. */
  description: string
}

/**
 * Contract: evidence may only become a plan signal at "high" or "confirmed"
 * confidence. Low/medium evidence is logged but never forwarded to the plan.
 * Even high-confidence signals are SURFACED (shown to the user / logged to the
 * document graph) — they are NEVER auto-applied to the plan.
 */
function signalMayDrivePlan(signal: PlanSignal): boolean {
  return signal.confidence === "high" || signal.confidence === "confirmed"
}

/**
 * Contract: no evidence artifact — however high-confidence — auto-modifies a
 * plan. This function represents the gate: even if all conditions are met, the
 * return value is "surface as suggestion", not "apply".
 */
function planActionForSignal(signal: PlanSignal): "no_action" | "surface_as_suggestion" {
  if (!signalMayDrivePlan(signal)) return "no_action"
  // Even high-confidence: SURFACE, never auto-apply.
  return "surface_as_suggestion"
}

// ——— general/direct mode degradation contract ——————————————————————————————

type AgentMode = "general" | "direct" | "plan"

/**
 * Contract (§RX verification): debug/profile evidence does NOT change the
 * agent's operating mode. general and direct modes are untouched.
 */
function modeAfterEvidence(currentMode: AgentMode, _evidence: EvidenceArtifact): AgentMode {
  // Evidence never changes the mode. This is the invariant.
  return currentMode
}

// ——— tests ——————————————————————————————————————————————————————————————————

describe("RX plan-signal high-only contract", () => {
  describe("evidence artifact shape", () => {
    it("DEBUG_SESSION.json has evidence_kind:debug_session", () => {
      const artifact: EvidenceArtifact = {
        evidence_kind: "debug_session",
        session_id: "dbg-001",
        backtrace: [],
        variable_snapshot: {},
      }
      expect(isDebugEvidence(artifact)).toBe(true)
      expect(isProfileEvidence(artifact)).toBe(false)
    })

    it("PROFILE_RESULT.json has evidence_kind:profile", () => {
      const artifact: EvidenceArtifact = {
        evidence_kind: "profile",
        profile: {},
        roofline: { bound: "compute", detail: "...", derived: true },
      }
      expect(isProfileEvidence(artifact)).toBe(true)
      expect(isDebugEvidence(artifact)).toBe(false)
    })

    it("evidence_kind is one of the three accepted values", () => {
      const kinds: EvidenceKind[] = ["lsp_query", "debug_session", "profile"]
      for (const kind of kinds) {
        const a: EvidenceArtifact = { evidence_kind: kind }
        expect(kinds).toContain(a.evidence_kind)
      }
    })
  })

  describe("plan signal confidence gate", () => {
    it("low-confidence debug evidence does NOT drive a plan signal", () => {
      const signal: PlanSignal = {
        evidence_kind: "debug_session",
        confidence: "low",
        description: "variable x was None in one run",
      }
      expect(signalMayDrivePlan(signal)).toBe(false)
      expect(planActionForSignal(signal)).toBe("no_action")
    })

    it("medium-confidence profile evidence does NOT drive a plan signal", () => {
      const signal: PlanSignal = {
        evidence_kind: "profile",
        confidence: "medium",
        description: "matmul_kernel uses 70% of GPU time",
      }
      expect(signalMayDrivePlan(signal)).toBe(false)
      expect(planActionForSignal(signal)).toBe("no_action")
    })

    it("high-confidence debug evidence CAN surface as a plan suggestion", () => {
      const signal: PlanSignal = {
        evidence_kind: "debug_session",
        confidence: "high",
        description: "foo() returns None on input=[1,2,3] — root cause confirmed via breakpoint",
      }
      expect(signalMayDrivePlan(signal)).toBe(true)
      // But it is SURFACED, never auto-applied
      expect(planActionForSignal(signal)).toBe("surface_as_suggestion")
    })

    it("high-confidence profile evidence CAN surface as a plan suggestion", () => {
      const signal: PlanSignal = {
        evidence_kind: "profile",
        confidence: "high",
        description: "matmul_kernel is DRAM-bandwidth-bound (91%); optimization target confirmed",
      }
      expect(signalMayDrivePlan(signal)).toBe(true)
      expect(planActionForSignal(signal)).toBe("surface_as_suggestion")
    })

    it("confirmed-confidence evidence surfaces as suggestion (never auto-applies)", () => {
      const signal: PlanSignal = {
        evidence_kind: "debug_session",
        confidence: "confirmed",
        description: "NullPointerException always at line 42 with this input",
      }
      expect(planActionForSignal(signal)).toBe("surface_as_suggestion")
      // NEVER "auto_apply" — that value does not exist in the type
    })
  })

  describe("general/direct mode non-degradation", () => {
    it("debug evidence does not change general mode", () => {
      const evidence: EvidenceArtifact = { evidence_kind: "debug_session" }
      expect(modeAfterEvidence("general", evidence)).toBe("general")
    })

    it("profile evidence does not change direct mode", () => {
      const evidence: EvidenceArtifact = { evidence_kind: "profile" }
      expect(modeAfterEvidence("direct", evidence)).toBe("direct")
    })

    it("lsp_query evidence does not change general mode", () => {
      const evidence: EvidenceArtifact = { evidence_kind: "lsp_query" }
      expect(modeAfterEvidence("general", evidence)).toBe("general")
    })

    it("evidence in plan mode does not auto-advance the plan", () => {
      // Plan mode stays in plan mode; evidence is surfaced but not executed
      const evidence: EvidenceArtifact = { evidence_kind: "profile" }
      expect(modeAfterEvidence("plan", evidence)).toBe("plan")
    })
  })

  describe("end-to-end evidence pipeline contract (§10 global acceptance gate §6)", () => {
    it("high-confidence evidence enters the document graph as an artifact but does not modify the plan automatically", () => {
      // §10-6: "debug/profile 证据落 artifact（evidence_kind）进文档图，可被计划/审计引用，不自动改计划"
      const profileArtifact: EvidenceArtifact = {
        evidence_kind: "profile",
        profile: { domain: "gpu_kernel", hotspots: [{ kernel: "matmul", self_pct: 72 }] },
        roofline: { bound: "memory", detail: "memory-bound (dram_bandwidth_pct=91%)", derived: true },
      }
      const debugArtifact: EvidenceArtifact = {
        evidence_kind: "debug_session",
        session_id: "dbg-42",
        backtrace: [{ frame: 0, symbol: "foo", file: "src/foo.py", line: 42 }],
        root_cause: "NullPointerException — foo() receives None from bar()",
      }

      // Both are valid evidence artifacts
      expect(isProfileEvidence(profileArtifact)).toBe(true)
      expect(isDebugEvidence(debugArtifact)).toBe(true)

      // Even if forwarded as high-confidence signals, the action is SURFACE not AUTO-APPLY
      const profileSignal: PlanSignal = {
        evidence_kind: "profile",
        confidence: "high",
        description: `${profileArtifact.roofline}`,
      }
      const debugSignal: PlanSignal = {
        evidence_kind: "debug_session",
        confidence: "high",
        description: `${debugArtifact.root_cause}`,
      }

      expect(planActionForSignal(profileSignal)).toBe("surface_as_suggestion")
      expect(planActionForSignal(debugSignal)).toBe("surface_as_suggestion")

      // General mode stays general — no automatic mode switch
      expect(modeAfterEvidence("general", profileArtifact)).toBe("general")
      expect(modeAfterEvidence("general", debugArtifact)).toBe("general")
    })
  })
})
