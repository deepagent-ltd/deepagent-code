export * as GoalOptions from "./goal-options"

import { GoalClient } from "@deepagent-code/core/deepagent/goal-client"

export function parse(input: {
  goal?: boolean
  agent?: string
  tests?: readonly string[]
  diagnostics?: string
  reviewer?: string
  codeRefs?: readonly string[]
  workspacePlan?: boolean
  objective?: string
}) {
  const supplied = input.tests !== undefined || input.diagnostics !== undefined || input.reviewer !== undefined ||
    input.codeRefs !== undefined || input.workspacePlan === true
  if (supplied && (!input.goal || input.agent !== "loop"))
    throw new GoalClient.RequestError("Goal criteria and --goal-plan require --goal --agent loop", "invalid_request", 400, false)
  const criteria = input.tests !== undefined || input.diagnostics !== undefined || input.reviewer !== undefined
    ? [
        { kind: "plan_complete" },
        ...(input.tests !== undefined ? [{ kind: "tests_pass", commands: [...input.tests] }] : []),
        ...(input.diagnostics !== undefined ? [{ kind: "no_diagnostics", severityAtMost: input.diagnostics }] : []),
        ...(input.reviewer !== undefined ? [{ kind: "reviewer_clean", maxSeverity: input.reviewer }] : []),
      ]
    : undefined
  const result = {
    ...(criteria ? { criteria } : {}),
    ...(input.codeRefs !== undefined ? { codeRefs: [...input.codeRefs] } : {}),
    ...(input.workspacePlan ? { planSource: "workspace-file" as const } : {}),
  }
  GoalClient.validateStartInput({ sessionID: "validation", requestID: "validation", ...result, objective: input.objective })
  return result
}
