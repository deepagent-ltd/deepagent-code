// FEAT-002 regression suite: ONE pack-activation authority per run. Locks that the unified
// gateway profile (profile-builder.buildProfile) and the retriever's activationForProfile produce
// the same active pack set, and that the deterministic read-only policy flip follows that SAME
// active_pack_set the run records. Also pins the pre/post-unification verdict comparison so the
// deterministic-task.ts:86-91 `activePackIds.includes("code.query")` flip cannot silently regress.

import { describe, expect, test, beforeAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildProfile } from "../../src/deepagent/profile-builder"
import { activationForProfile } from "../../src/deepagent/knowledge-retriever"
import { configureRegistry, type ExtendedProblemProfile } from "../../src/deepagent/domain-pack-registry"
import { deterministicToolPolicy, shouldActivateQueryControls } from "../../src/deepagent/deterministic-task"

beforeAll(() => configureRegistry(undefined))

const withWorkspace = (fn: (cwd: string) => void) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "deepagent-feat002-"))
  try {
    fn(cwd)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

// The pre-FEAT-002 profile the gateway hardcoded for the recorded pack snapshot (audit finding:
// scenario_mode/task_kind/languages fixed, repo_signals = run.input.feature only).
const legacyHardcodedProfile = (feature: string): ExtendedProblemProfile => ({
  scenario_mode: "intelligence",
  agent_strength: "high",
  task_kind: "implement",
  code_domains: ["code"],
  business_domains: [],
  platforms: [],
  languages: ["typescript"],
  frameworks: [],
  data_classes: [],
  risk_markers: [],
  repo_signals: [feature],
  round_signals: [],
  user_overrides: [],
})

describe("FEAT-002 unified pack activation authority", () => {
  test("read-only query request activates code.query and flips the deterministic policy read-only", () => {
    withWorkspace((cwd) => {
      const request = "请查一下数据库里有多少条用户记录"
      const profile = buildProfile({ cwd, agentMode: "max", scenarioMode: "intelligence", userRequest: request })
      const activation = activationForProfile(profile)
      expect(activation.activePackIds).toContain("code.query")
      const policy = deterministicToolPolicy({ raw: request, activePackIds: activation.activePackIds })
      expect(policy.read_only).toBe(true)
      expect(policy.denied_actions).toContain("update")
    })
  })

  test("mutation request never activates code.query and keeps mutation tools allowed", () => {
    withWorkspace((cwd) => {
      const request = "请修复登录逻辑并更新依赖"
      const profile = buildProfile({ cwd, agentMode: "max", scenarioMode: "intelligence", userRequest: request })
      const activation = activationForProfile(profile)
      expect(activation.activePackIds).not.toContain("code.query")
      expect(deterministicToolPolicy({ raw: request, activePackIds: activation.activePackIds }).read_only).toBe(false)
    })
  })

  test("authority flip: state-inspection queries missed by the legacy hardcoded profile are now covered", () => {
    withWorkspace((cwd) => {
      const request = "看一下当前状态"
      // Pre-unification record truth: the hardcoded profile could NOT activate code.query here.
      const legacy = activationForProfile(legacyHardcodedProfile(request))
      expect(legacy.activePackIds).not.toContain("code.query")
      // Post-unification: the single authoritative profile activates it.
      const unified = activationForProfile(
        buildProfile({ cwd, agentMode: "max", scenarioMode: "intelligence", userRequest: request }),
      )
      expect(unified.activePackIds).toContain("code.query")
      // The deterministic verdict stays read-only on BOTH sides — the flip is about WHO decides
      // (pack authority), and the verdict must not regress in either direction.
      expect(shouldActivateQueryControls({ raw: request, activePackIds: legacy.activePackIds })).toBe(true)
      expect(shouldActivateQueryControls({ raw: request, activePackIds: unified.activePackIds })).toBe(true)
    })
  })

  test("count queries activated under the legacy profile stay activated after unification", () => {
    withWorkspace((cwd) => {
      const request = "请查一下数据库里有多少条用户记录"
      const legacy = activationForProfile(legacyHardcodedProfile(request))
      const unified = activationForProfile(
        buildProfile({ cwd, agentMode: "max", scenarioMode: "intelligence", userRequest: request }),
      )
      // Both authorities agree on the pack that drives the read-only flip — no silent regression.
      expect(legacy.activePackIds).toContain("code.query")
      expect(unified.activePackIds).toContain("code.query")
      expect(deterministicToolPolicy({ raw: request, activePackIds: unified.activePackIds }).read_only).toBe(true)
    })
  })

  test("active_pack_set membership alone can activate query controls (deterministic-task.ts:86-91 lock)", () => {
    const neutral = "run the scheduled job"
    expect(shouldActivateQueryControls({ raw: neutral })).toBe(false)
    expect(shouldActivateQueryControls({ raw: neutral, activePackIds: ["code.query"] })).toBe(true)
    // Mutation intent still wins even when code.query is active (locked behavior).
    expect(shouldActivateQueryControls({ raw: "请删除旧记录", activePackIds: ["code.query"] })).toBe(false)
  })

  test("activation is deterministic and honors pinned overrides (FEAT-001 behavior preserved)", () => {
    withWorkspace((cwd) => {
      const signals = {
        cwd,
        agentMode: "max" as const,
        scenarioMode: "intelligence" as const,
        userRequest: "rename a local helper function",
      }
      const a = activationForProfile(buildProfile(signals))
      const b = activationForProfile(buildProfile(signals))
      expect(b.activePackIds).toEqual(a.activePackIds)
      // Core fallback packs are part of the retrieval-constrained active set the gateway records.
      expect(a.activePackIds).toContain("code.core")
      // Pins remain force-included through the unified authority.
      const pinned = activationForProfile(buildProfile({ ...signals, userOverrides: ["code.gpu-kernel"] }))
      expect(pinned.activePackIds).toContain("code.gpu-kernel")
    })
  })
})
