export type EvalFailure =
  | "preflight"
  | "infrastructure"
  | "sandbox-contract"
  | "provider-contract"
  | "runtime-contract"
  | "model-behavior"
  | "budget"

export type EvalRun = {
  task: string
  taskSeed: number
  passed: boolean
  failure?: EvalFailure
  score: {
    earnedPoints: number
    possiblePoints: number
  }
  providerTurns: number
  toolCalls: number
  durationMs: number
  usage: { input: number; output: number; reasoning: number }
}

export function evalReport(runs: EvalRun[]) {
  const passed = runs.filter((run) => run.passed).length
  const interval = wilsonInterval(passed, runs.length)
  const totals = runs.reduce(
    (result, run) => ({
      providerTurns: result.providerTurns + run.providerTurns,
      toolCalls: result.toolCalls + run.toolCalls,
      durationMs: result.durationMs + run.durationMs,
      inputTokens: result.inputTokens + run.usage.input,
      outputTokens: result.outputTokens + run.usage.output,
      reasoningTokens: result.reasoningTokens + run.usage.reasoning,
    }),
    { providerTurns: 0, toolCalls: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  )
  const divisor = runs.length || 1
  const score = scoreSummary(runs.map((run) => run.score))
  return {
    runs: runs.length,
    passed,
    failed: runs.length - passed,
    successRate: passed / divisor,
    score,
    confidence95: interval,
    averages: {
      providerTurns: totals.providerTurns / divisor,
      toolCalls: totals.toolCalls / divisor,
      durationMs: totals.durationMs / divisor,
      inputTokens: totals.inputTokens / divisor,
      outputTokens: totals.outputTokens / divisor,
      reasoningTokens: totals.reasoningTokens / divisor,
    },
    failures: Object.fromEntries(
      [...new Set(runs.flatMap((run) => (run.failure ? [run.failure] : [])))]
        .toSorted()
        .map((failure) => [failure, runs.filter((run) => run.failure === failure).length]),
    ),
    tasks: Object.fromEntries(
      [...new Set(runs.map((run) => run.task))].toSorted().map((task) => {
        const selected = runs.filter((run) => run.task === task)
        const selectedPassed = selected.filter((run) => run.passed).length
        return [
          task,
          {
            runs: selected.length,
            passed: selectedPassed,
            successRate: selectedPassed / selected.length,
            score: scoreSummary(selected.map((run) => run.score)),
            confidence95: wilsonInterval(selectedPassed, selected.length),
          },
        ]
      }),
    ),
  }
}

export function scoreSummary(scores: Array<{ earnedPoints: number; possiblePoints: number }>) {
  scores.forEach((score) => {
    if (
      !Number.isSafeInteger(score.earnedPoints) ||
      !Number.isSafeInteger(score.possiblePoints) ||
      score.earnedPoints < 0 ||
      score.possiblePoints < 0 ||
      score.earnedPoints > score.possiblePoints
    ) {
      throw new Error("Eval score requires integer points with 0 <= earnedPoints <= possiblePoints")
    }
  })
  const earnedPoints = scores.reduce((total, score) => total + score.earnedPoints, 0)
  const possiblePoints = scores.reduce((total, score) => total + score.possiblePoints, 0)
  const normalized = possiblePoints === 0 ? 0 : earnedPoints / possiblePoints
  return {
    earnedPoints,
    possiblePoints,
    normalized,
    outOf100: Number((normalized * 100).toFixed(2)),
  }
}

export function wilsonInterval(passed: number, total: number) {
  if (!Number.isSafeInteger(passed) || !Number.isSafeInteger(total) || passed < 0 || total < 0 || passed > total) {
    throw new Error("Wilson interval requires integer counts with 0 <= passed <= total")
  }
  if (total === 0) return { low: 0, high: 1 }
  const z = 1.959963984540054
  const rate = passed / total
  const denominator = 1 + (z * z) / total
  const center = (rate + (z * z) / (2 * total)) / denominator
  const margin = (z / denominator) * Math.sqrt((rate * (1 - rate)) / total + (z * z) / (4 * total * total))
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) }
}
