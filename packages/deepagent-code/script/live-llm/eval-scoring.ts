import { scoreSummary } from "../../../llm/script/live-llm/eval-report"

export const verifierMarker = "__DEEPAGENT_EVAL_RUBRIC__"

export type RubricItem = {
  id: string
  label: string
  passed: boolean
  detail?: string
}

export type PythonVerifierCheck = {
  id: string
  label: string
  lines: string[]
}

export function scoreRubric(items: RubricItem[]) {
  const summary = scoreSummary([
    { earnedPoints: items.filter((item) => item.passed).length, possiblePoints: items.length },
  ])
  return { ...summary, items }
}

export function pythonVerifier(checks: PythonVerifierCheck[]) {
  const bodies = checks.flatMap((check, index) => [
    `def _check_${index}():`,
    ...check.lines.map((line) => `    ${line}`),
    "",
    "try:",
    `    _check_${index}()`,
    `    _results.append({"id": ${JSON.stringify(check.id)}, "passed": True})`,
    "except Exception as error:",
    `    _results.append({"id": ${JSON.stringify(check.id)}, "passed": False, "error": f"{type(error).__name__}: {error}"})`,
    "",
  ])
  return {
    script: [
      "#!/bin/sh",
      "set -eu",
      `"$DEEPAGENT_LIVE_LLM_PYTHON" -B - <<'PY'`,
      "import json",
      "_results = []",
      "",
      ...bodies,
      `print(${JSON.stringify(verifierMarker)} + json.dumps(_results, sort_keys=True))`,
      "if not all(result['passed'] for result in _results):",
      "    raise SystemExit(1)",
      "PY",
      "",
    ].join("\n"),
    checks: checks.map((check) => ({ id: check.id, label: check.label })),
  }
}

export function parseVerifierChecks(stdout: string, expected: Array<{ id: string; label: string }>): RubricItem[] {
  const line = stdout.split("\n").findLast((candidate) => candidate.startsWith(verifierMarker))
  if (!line) {
    return expected.map((check) => ({
      ...check,
      passed: false,
      detail: "verifier did not emit rubric results",
    }))
  }
  const value: unknown = JSON.parse(line.slice(verifierMarker.length))
  if (!Array.isArray(value)) {
    return expected.map((check) => ({ ...check, passed: false, detail: "invalid verifier rubric" }))
  }
  return expected.map((check) => {
    const result = value.find(
      (candidate): candidate is Record<string, unknown> =>
        typeof candidate === "object" && candidate !== null && !Array.isArray(candidate) && candidate.id === check.id,
    )
    return {
      ...check,
      passed: result?.passed === true,
      ...(typeof result?.error === "string" ? { detail: result.error.slice(0, 500) } : {}),
    }
  })
}
