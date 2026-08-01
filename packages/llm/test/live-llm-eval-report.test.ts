import { describe, expect, test } from "bun:test"
import { evalReport, scoreSummary, wilsonInterval, type EvalRun } from "../script/live-llm/eval-report"

describe("live LLM eval report", () => {
  test("computes Wilson confidence intervals for empty and observed samples", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 })
    expect(wilsonInterval(5, 5).low).toBeCloseTo(0.5655, 4)
    expect(wilsonInterval(0, 5).high).toBeCloseTo(0.4345, 4)
    expect(() => wilsonInterval(2, 1)).toThrow()
  })

  test("aggregates task, failure, usage, and resource statistics without selecting best runs", () => {
    const runs: EvalRun[] = [
      {
        task: "bug-fix",
        taskSeed: 1,
        passed: true,
        score: { earnedPoints: 8, possiblePoints: 10 },
        providerTurns: 2,
        toolCalls: 3,
        durationMs: 100,
        usage: { input: 10, output: 5, reasoning: 0 },
      },
      {
        task: "bug-fix",
        taskSeed: 2,
        passed: false,
        failure: "model-behavior",
        score: { earnedPoints: 6, possiblePoints: 10 },
        providerTurns: 4,
        toolCalls: 5,
        durationMs: 300,
        usage: { input: 30, output: 15, reasoning: 2 },
      },
    ]

    expect(evalReport(runs)).toMatchObject({
      runs: 2,
      passed: 1,
      failed: 1,
      successRate: 0.5,
      score: { earnedPoints: 14, possiblePoints: 20, normalized: 0.7, outOf100: 70 },
      averages: {
        providerTurns: 3,
        toolCalls: 4,
        durationMs: 200,
        inputTokens: 20,
        outputTokens: 10,
        reasoningTokens: 1,
      },
      failures: { "model-behavior": 1 },
      tasks: {
        "bug-fix": {
          runs: 2,
          passed: 1,
          successRate: 0.5,
          score: { earnedPoints: 14, possiblePoints: 20, normalized: 0.7, outOf100: 70 },
        },
      },
    })
  })

  test("normalizes partial-credit points and rejects invalid scores", () => {
    expect(scoreSummary([{ earnedPoints: 2, possiblePoints: 3 }])).toEqual({
      earnedPoints: 2,
      possiblePoints: 3,
      normalized: 2 / 3,
      outOf100: 66.67,
    })
    expect(scoreSummary([])).toEqual({ earnedPoints: 0, possiblePoints: 0, normalized: 0, outOf100: 0 })
    expect(() => scoreSummary([{ earnedPoints: 2, possiblePoints: 1 }])).toThrow()
  })
})
