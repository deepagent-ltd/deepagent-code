import { describe, expect, test, beforeEach } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as SessionState from "../../src/deepagent/session-state"

// v4.0.5 PR-3 (observeUserAdmission) + PR-4 (structured validation dismissal). Pure session-state
// seams the live request-prep loop calls; no running instance required.

describe("PR-3 observeUserAdmission", () => {
  beforeEach(() => {
    SessionState.configure(mkdtempSync(path.join(tmpdir(), "observe-admission-")))
  })

  test("first observation on a fresh session is 'initial' and records the baseline (no stale)", () => {
    SessionState.getOrCreate("obs-1", "high")
    expect(SessionState.observeUserAdmission("obs-1", "msg_a")).toBe("initial")
    // baseline recorded → the SAME id is now a no-op continuation
    expect(SessionState.observeUserAdmission("obs-1", "msg_a")).toBe("same")
  })

  test("a genuinely new admission id returns 'new'", () => {
    SessionState.getOrCreate("obs-2", "high")
    expect(SessionState.observeUserAdmission("obs-2", "msg_a")).toBe("initial")
    expect(SessionState.observeUserAdmission("obs-2", "msg_b")).toBe("new")
    // and re-observing the newest id is 'same' again
    expect(SessionState.observeUserAdmission("obs-2", "msg_b")).toBe("same")
  })

  test("an unknown session returns 'initial' without throwing", () => {
    expect(SessionState.observeUserAdmission("no-such-session", "msg_x")).toBe("initial")
  })

  test("old persisted state without lastAdmissionUserMessageId migrates as 'initial'", () => {
    // Simulate a session created before the field existed by getOrCreate (field starts undefined).
    SessionState.getOrCreate("obs-3", "high")
    // First observation must NOT be treated as a new user message (would spuriously mark stale).
    expect(SessionState.observeUserAdmission("obs-3", "msg_first")).toBe("initial")
  })
})

describe("PR-4 structured validation dismissal", () => {
  beforeEach(() => {
    SessionState.configure(mkdtempSync(path.join(tmpdir(), "dismissal-")))
  })

  test("suppressValidation stores a structured record keyed by command+exitCode fingerprint", () => {
    SessionState.getOrCreate("sup-1", "high")
    SessionState.suppressValidation("sup-1", "bun run test", 1, "known flake")
    const all = SessionState.getSuppressedValidations("sup-1")
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({
      command: "bun run test",
      exitCode: 1,
      fingerprint: "bun run test 1",
      reason: "known flake",
    })
    expect(typeof all[0]!.suppressedAt).toBe("number")
  })

  test("re-suppressing the same fingerprint is idempotent (refreshes reason, no duplicate)", () => {
    SessionState.getOrCreate("sup-2", "high")
    SessionState.suppressValidation("sup-2", "tsc", 2, "first")
    SessionState.suppressValidation("sup-2", "tsc", 2, "second")
    const all = SessionState.getSuppressedValidations("sup-2")
    expect(all).toHaveLength(1)
    expect(all[0]!.reason).toBe("second")
  })

  test("a command with spaces + a different exit code is a distinct fingerprint", () => {
    SessionState.getOrCreate("sup-3", "high")
    SessionState.suppressValidation("sup-3", "bun run test --filter x", 1, "a")
    SessionState.suppressValidation("sup-3", "bun run test --filter x", 137, "b")
    const fps = SessionState.getSuppressedValidations("sup-3").map((v) => v.fingerprint)
    expect(fps).toEqual(["bun run test --filter x 1", "bun run test --filter x 137"])
  })

  test("unsuppressValidation removes only the matching fingerprint", () => {
    SessionState.getOrCreate("sup-4", "high")
    SessionState.suppressValidation("sup-4", "cmd a", 1, "x")
    SessionState.suppressValidation("sup-4", "cmd b", 1, "y")
    SessionState.unsuppressValidation("sup-4", "cmd a 1")
    const remaining = SessionState.getSuppressedValidations("sup-4").map((v) => v.fingerprint)
    expect(remaining).toEqual(["cmd b 1"])
  })

  test("the deprecated suppressFingerprint alias splits on the LAST space (commands may contain spaces)", () => {
    SessionState.getOrCreate("sup-5", "high")
    SessionState.suppressFingerprint("sup-5", "bun run test --filter x 1")
    const rec = SessionState.getSuppressedValidations("sup-5")[0]!
    expect(rec.command).toBe("bun run test --filter x")
    expect(rec.exitCode).toBe(1)
  })

  test("legacy on-disk suppressedFingerprints (string[]) migrate to SuppressedValidation[] on load", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dismissal-migrate-"))
    // Seed a pre-PR-4 sessions.json carrying the OLD flat string[] format. Command contains a space,
    // so the migration must split on the LAST space to recover command + exit code.
    const legacy = {
      "mig-1": {
        sessionId: "mig-1",
        mode: "high",
        suppressedFingerprints: ["bun run test --filter y 1", "tsc 2"],
        createdAt: new Date().toISOString(),
        completedAt: null,
      },
    }
    writeFileSync(path.join(dir, "sessions.json"), JSON.stringify(legacy))
    SessionState.configure(dir)
    const migrated = SessionState.getSuppressedValidations("mig-1")
    expect(migrated.map((v) => ({ command: v.command, exitCode: v.exitCode, reason: v.reason }))).toEqual([
      { command: "bun run test --filter y", exitCode: 1, reason: "migrated" },
      { command: "tsc", exitCode: 2, reason: "migrated" },
    ])
    // The old flat field must not survive alongside the structured one.
    expect((SessionState.get("mig-1") as unknown as Record<string, unknown>).suppressedFingerprints).toBeUndefined()
  })
})
