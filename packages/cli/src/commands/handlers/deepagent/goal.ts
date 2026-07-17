import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { rawGet, rawPost, requireCapability } from "./util"

type GoalSnapshot = { goalId: string; planDocId: string; phase: string; running: boolean }

export default Runtime.handler(Commands.commands.goal, Effect.fn("cli.goal")(function* (input) {
  yield* requireCapability("goalLoop")

  if (input.action === "status") {
    const result = yield* rawGet<{ goal: GoalSnapshot | null }>(`/deepagent/goal/status?sessionID=${encodeURIComponent(input.sessionID)}`)
    const goal = result.data?.goal
    if (!goal) {
      console.log("No active goal for this session")
      return
    }
    console.log(`Goal: ${goal.goalId}`)
    console.log(`  Phase: ${goal.phase}`)
    console.log(`  Running: ${goal.running}`)
    console.log(`  Plan: ${goal.planDocId}`)
    return
  }

  if (input.action === "start") {
    const body: Record<string, unknown> = { sessionID: input.sessionID }
    const objective = Option.getOrElse(input.objective, () => undefined)
    if (objective) body.objective = objective
    const result = yield* rawPost<GoalSnapshot>("/deepagent/goal/start", body)
    const goal = result.data
    if (goal) console.log(`Goal started: ${goal.goalId} (phase: ${goal.phase})`)
    else console.log("Goal start failed")
    return
  }

  // pause / resume / stop — all take { sessionID }
  const result = yield* rawPost<{ ok: boolean }>(`/deepagent/goal/${input.action}`, { sessionID: input.sessionID })
  if (result.data?.ok) console.log(`Goal ${input.action}: ${input.sessionID}`)
  else console.log(`Goal ${input.action} failed: ${input.sessionID}`)
}))
