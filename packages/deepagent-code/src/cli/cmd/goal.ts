// PARITY-004 long-tail: goal loop controls (status/pause/resume/stop) — CLI
// parity with the GUI goal controls (app deepagent.ts goal endpoints). Goes
// through the instance httpapi via the SDK client; never touches the DB.
import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import { UI } from "../ui"
import { attachOptions, createInstanceSDK, formatSdkError, formatTable, type QueryFormatArgs } from "./instance-sdk"

export const GoalCommand = cmd({
  command: "goal",
  describe: "inspect and control the goal loop of a session",
  builder: (yargs: Argv) =>
    yargs
      .command(GoalStatusCommand)
      .command(GoalPauseCommand)
      .command(GoalResumeCommand)
      .command(GoalStopCommand)
      .demandCommand(),
  async handler() {},
})

type GoalSessionArgs = QueryFormatArgs & { sessionID: string }

function sessionBuilder(yargs: Argv) {
  return attachOptions(
    yargs.positional("sessionID", {
      describe: "session ID",
      type: "string",
      demandOption: true,
    }),
  )
}

export const GoalStatusCommand = effectCmd({
  command: "status <sessionID>",
  describe: "show the active goal of a session",
  builder: sessionBuilder,
  handler: Effect.fn("Cli.goal.status")(function* (rawArgs) {
    const args = rawArgs as unknown as GoalSessionArgs
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    const result = yield* Effect.promise(async () => {
      const sdk = await createInstanceSDK(args, ctx.worktree)
      return sdk.deepagent.goalStatus({ sessionID: args.sessionID }).catch((error) => ({ data: undefined, error }))
    })
    if (result.error) return yield* fail(formatSdkError(args, result.error))
    const goal = result.data?.goal ?? null
    if (args.format === "json") {
      console.log(JSON.stringify({ sessionID: args.sessionID, goal }, null, 2))
      return
    }
    if (!goal) {
      UI.println(`No active goal for session ${args.sessionID}`)
      return
    }
    console.log(
      formatTable(
        ["Goal", "Phase", "Running"],
        [[goal.goalId, goal.phase, goal.running ? "yes" : "no"]],
      ),
    )
  }),
})

// pause/resume/stop share one shape: POST with {sessionID} → {ok}. `ok:false`
// means the goal loop is disabled or there was no goal in the right state.
function goalControl(action: "pause" | "resume" | "stop", done: string) {
  return effectCmd({
    command: `${action} <sessionID>`,
    describe: `${action} the goal loop of a session`,
    builder: sessionBuilder,
    handler: Effect.fn(`Cli.goal.${action}`)(function* (rawArgs) {
      const args = rawArgs as unknown as GoalSessionArgs
      const maybeCtx = yield* InstanceRef
      if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
      const ctx = maybeCtx
      const result = yield* Effect.promise(async () => {
        const sdk = await createInstanceSDK(args, ctx.worktree)
        const call =
          action === "pause"
            ? sdk.deepagent.goalPause({ sessionID: args.sessionID })
            : action === "resume"
              ? sdk.deepagent.goalResume({ sessionID: args.sessionID })
              : sdk.deepagent.goalStop({ sessionID: args.sessionID })
        return call.catch((error) => ({ data: undefined, error }))
      })
      if (result.error) return yield* fail(formatSdkError(args, result.error))
      if (args.format === "json") {
        console.log(JSON.stringify({ sessionID: args.sessionID, action, ok: result.data?.ok ?? false }, null, 2))
        return
      }
      if (!result.data?.ok) {
        return yield* fail(
          `Could not ${action} the goal for session ${args.sessionID} — no active goal in the right state (or the goal loop is disabled)`,
        )
      }
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + `${done} goal for session ${args.sessionID}` + UI.Style.TEXT_NORMAL)
    }),
  })
}

export const GoalPauseCommand = goalControl("pause", "Paused")
export const GoalResumeCommand = goalControl("resume", "Resumed")
export const GoalStopCommand = goalControl("stop", "Stopped")
