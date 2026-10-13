import { GoalClient } from "@deepagent-code/core/deepagent/goal-client"

// This is a display hint from the original scoped GET, never a replacement for mutator guards.
export function sessionControls(input: {
  sessionID?: string
  directory: string
  session?: { id: string; directory: string; ordinaryEligible?: unknown }
  goal?: { control?: GoalClient.Snapshot }
}) {
  if (!input.sessionID) return "editable"
  if (
    input.session?.id !== input.sessionID ||
    input.session.directory !== input.directory ||
    !("ordinaryEligible" in input.session) ||
    typeof input.session.ordinaryEligible !== "boolean"
  )
    return "pending"
  if (!input.session.ordinaryEligible) return "controlled"
  if (input.goal && (!input.goal.control || !GoalClient.confirmedTerminal(input.goal.control))) return "goal"
  return "editable"
}
