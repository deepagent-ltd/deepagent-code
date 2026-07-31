import { describe, expect, test } from "bun:test"
import { parseVerifierChecks, pythonVerifier, scoreRubric } from "../../script/live-llm/eval-scoring"

describe("autonomous eval scoring", () => {
  test("awards one point per satisfied rubric item and normalizes to 100", () => {
    expect(
      scoreRubric([
        { id: "a", label: "A", passed: true },
        { id: "b", label: "B", passed: false },
        { id: "c", label: "C", passed: true },
      ]),
    ).toMatchObject({ earnedPoints: 2, possiblePoints: 3, normalized: 2 / 3, outOf100: 66.67 })
  })

  test("runs every hidden verifier check instead of failing at the first assertion", async () => {
    const verifier = pythonVerifier([
      { id: "pass", label: "passing code", lines: ["assert 2 + 2 == 4"] },
      { id: "fail", label: "failing code", lines: ["assert 2 + 2 == 5, 'wrong total'"] },
    ])
    const subprocess = Bun.spawn(["/bin/sh", "-c", verifier.script], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        DEEPAGENT_LIVE_LLM_PYTHON: process.env.DEEPAGENT_CODE_LIVE_LLM_PYTHON ?? "python3",
      },
    })
    const [stdout, exitCode] = await Promise.all([new Response(subprocess.stdout).text(), subprocess.exited])

    expect(exitCode).toBe(1)
    expect(parseVerifierChecks(stdout, verifier.checks)).toEqual([
      { id: "pass", label: "passing code", passed: true },
      { id: "fail", label: "failing code", passed: false, detail: "AssertionError: wrong total" },
    ])
  })

  test("gives zero credit when a verifier cannot emit structured results", () => {
    expect(parseVerifierChecks("syntax error\n", [{ id: "code", label: "code works" }])).toEqual([
      { id: "code", label: "code works", passed: false, detail: "verifier did not emit rubric results" },
    ])
  })
})
