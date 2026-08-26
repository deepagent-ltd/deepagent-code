import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

// PARITY-004 long-tail: goal controls + worktree basics. All commands go
// through the in-process instance httpapi (no attach needed), so a fresh
// isolated home is enough.
describe("deepagentCode goal (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "goal status reports no active goal (table + json)",
    ({ deepagentCode }) =>
      Effect.gen(function* () {
        const table = yield* deepagentCode.spawn(["goal", "status", "ses_parity000001"])
        deepagentCode.expectExit(table, 0, "goal status")
        expect(table.stderr + table.stdout).toContain("No active goal for session ses_parity000001")

        const json = yield* deepagentCode.spawn(["goal", "status", "ses_parity000001", "--format", "json"])
        deepagentCode.expectExit(json, 0, "goal status --format json")
        const parsed = JSON.parse(json.stdout) as { sessionID: string; goal: unknown }
        expect(parsed.sessionID).toBe("ses_parity000001")
        expect(parsed.goal).toBeNull()
      }),
    60_000,
  )

  cliIt.concurrent(
    "goal pause/resume/stop fail with a friendly error when no goal is active",
    ({ deepagentCode }) =>
      Effect.gen(function* () {
        for (const action of ["pause", "resume", "stop"]) {
          const result = yield* deepagentCode.spawn(["goal", action, "ses_parity000002"])
          expect(result.exitCode, `goal ${action} should fail`).not.toBe(0)
          expect(result.stderr + result.stdout).toContain(`Could not ${action} the goal for session ses_parity000002`)
        }
      }),
    90_000,
  )
})

describe("deepagentCode worktree (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "worktree list prints an empty set for a fresh non-git home",
    ({ deepagentCode }) =>
      Effect.gen(function* () {
        const table = yield* deepagentCode.spawn(["worktree", "list"])
        deepagentCode.expectExit(table, 0, "worktree list")
        expect(table.stdout).toContain("(empty)")

        const json = yield* deepagentCode.spawn(["worktree", "list", "--format", "json"])
        deepagentCode.expectExit(json, 0, "worktree list --format json")
        expect(JSON.parse(json.stdout)).toEqual([])
      }),
    60_000,
  )

  cliIt.concurrent(
    "worktree remove fails with a clear error for an unknown directory",
    ({ deepagentCode }) =>
      Effect.gen(function* () {
        const result = yield* deepagentCode.spawn(["worktree", "remove", "/tmp/not-a-worktree-parity"])
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr + result.stdout).not.toBe("")
      }),
    60_000,
  )
})
