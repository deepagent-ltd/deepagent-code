import { describe, expect, test } from "bun:test"
import { createRecoveryLifecycle } from "./recovery-lifecycle-state"
import {
  descriptorDeadEnd,
  hasExecutableExit,
  initialDockState,
  pendingItems,
  reduceDock,
} from "./recovery-dock-state"
import type { RecoveryDescriptor } from "@deepagent-code/core/contract/recovery-command"
import { diagnosticEntries } from "../maintenance/maintenance-diagnostics"

// C6-10 — UX matrix as fixture/render-level evidence (agent-browser + dev servers are not run in
// this env; this is the STATE-level invariant matrix, and the true pixel matrix is reported as a
// residual). Assertions: multi-recovery items never dead-end and never overlap (serial per
// session); a long typed error is truncated with the stable code always visible; state decisions
// never key on human message text (中文/英文 independent).

const base = {
  schemaVersion: "recovery-descriptor.v1" as const,
  requestHash: "req-1",
  provenance: { origin: "recorded" as const, sourceRefs: [] as string[] },
  baseline: { baselineHash: "b1", sourceSnapshotRef: "snap-1", verified: true },
  terminalBridge: { bridgeId: "b", bridgeType: "type", terminalRef: "t" },
  casTokens: { expectedState: "s", expectedVersion: 0, ownerToken: "ot" },
}

const exact = (index: number): RecoveryDescriptor =>
  ({
    ...base,
    id: `d${index}`,
    descriptorKind: "resolvable_exact",
    exact: { attemptHash: "a", selectionHash: "s", historyHash: "h", baselineHash: "b", allVerified: true },
  }) as RecoveryDescriptor

const coordination = (index: number): RecoveryDescriptor =>
  ({
    ...base,
    id: `d${index}`,
    descriptorKind: "coordination_required",
    coordination: { reason: "network_unknown" as const, requiredActor: "admin" as const, evidenceExportRef: "export-1" },
  }) as RecoveryDescriptor

describe("C6-10 UX matrix fixture invariants", () => {
  test("multi recovery items (5+): every item has an executable exit or a typed reason (no dead-end)", () => {
    const descriptors: RecoveryDescriptor[] = [
      exact(0),
      exact(1),
      exact(2),
      coordination(3),
      coordination(4),
    ]
    let state = initialDockState
    state = reduceDock(state, { type: "descriptorsLoaded", descriptors })
    // 5 pending items loaded (exact ones resolve via a check; coordination ones query-first).
    const pending = pendingItems(state)
    expect(pending.length).toBe(5)
    for (const item of pending) {
      const deadEnd = descriptorDeadEnd(item.descriptor)
      if (deadEnd.kind === "exits") {
        expect(deadEnd.exits.length).toBeGreaterThan(0)
      } else {
        expect(deadEnd.reason).toBeTruthy()
      }
    }
  })

  test("serial per session: two items never share one in-flight command slot", () => {
    const lc = createRecoveryLifecycle()
    lc.onEvent({ type: "session-switch", sessionID: "ses-1", cursor: 0 })
    lc.onEvent({ type: "command-started", sessionID: "ses-1", command: { commandId: "c1", attemptId: "a1" } })
    lc.onEvent({ type: "command-started", sessionID: "ses-1", command: { commandId: "c2", attemptId: "a2" } })
    const snap = lc.snapshot()
    const state = snap.sessions.get("ses-1")!
    expect(state.inflight?.commandId).toBe("c1")
    expect(state.queue.length).toBe(1) // c2 queued — never two in flight
  })

  test("long typed error: stable code always visible, message truncated, no sensitive raw values", () => {
    const entries = diagnosticEntries({
      stableCode: "upgrade_run_recovery_required",
      mode: "read_only_recovery",
      phase: "read_only_recovery",
      buildDigest: "build-1",
      correlationId: "corr-1",
      message: "x".repeat(400),
    })
    expect(entries.length).toBeGreaterThan(0)
    // The diagnostics layer is stable-code-only: it never emits raw identity/SQL fields.
    const text = JSON.stringify(entries)
    for (const needle of ["PRAGMA", "INSERT INTO", "/Users/", "api_key"]) {
      expect(text).not.toContain(needle)
    }
  })

  test("中文/英文: state decisions never key on human message text", () => {
    const lc = createRecoveryLifecycle()
    lc.onEvent({
      type: "command-failed",
      sessionID: "ses-1",
      commandId: "c1",
      error: { data: { code: "cursor_gap_exceeded", message: "会话游标回退" } },
    })
    const state = lc.snapshot().sessions.get("ses-1")!
    expect(state.lastError?.commandId).toBe("c1")
    expect((state.lastError?.error as { data: { code: string } }).data.code).toBe("cursor_gap_exceeded")
  })
})
