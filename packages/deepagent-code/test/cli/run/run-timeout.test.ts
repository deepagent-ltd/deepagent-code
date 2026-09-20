// RI-110 oracle: a wedged provider turn must not pin the non-interactive CLI forever.
//
// The TestLLMServer `hang` fixture makes the provider stream hang mid-turn deterministically
// (role chunk, then nothing — never an error, never a finish). Without a bounded wait, the run
// handler's awaits never settle and the process never reaches main()'s exit path — the observed
// failure was a subprocess that printed its timeout and still had to be SIGKILLed by the harness.
//
// Template mirrors #27371 (run-process.test.ts): the harness timeoutMs is the outer bound — a
// process that still hangs is killed AT it (~30s), while a process that exits on its own after
// DEEPAGENT_CODE_RUN_TIMEOUT_MS fires finishes well under it. The durationMs bound is what
// distinguishes "self-exit" from "harness kill".
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

describe("deepagentCode run (non-interactive timeout exit)", () => {
  cliIt.concurrent(
    "prints the timeout and exits on its own when the provider stream hangs (RI-110)",
    ({ llm, deepagentCode }) =>
      Effect.gen(function* () {
        yield* llm.hang
        const result = yield* deepagentCode.run("say hi", {
          timeoutMs: 30_000,
          env: { DEEPAGENT_CODE_RUN_TIMEOUT_MS: "5000" },
        })
        expect(result.exitCode).not.toBe(0)
        expect(`${result.stdout}\n${result.stderr}`).toContain("Timed out")
        expect(result.durationMs).toBeLessThan(25_000)
      }),
    45_000,
  )

  cliIt.concurrent(
    "still completes a normal turn when the deadline is armed (no false firing)",
    ({ llm, deepagentCode }) =>
      Effect.gen(function* () {
        yield* llm.text("deadline-armed success")
        const result = yield* deepagentCode.run("say hi", {
          timeoutMs: 30_000,
          env: { DEEPAGENT_CODE_RUN_TIMEOUT_MS: "15000" },
        })
        deepagentCode.expectExit(result, 0)
        expect(result.stdout).toContain("deadline-armed success")
      }),
    45_000,
  )
})
