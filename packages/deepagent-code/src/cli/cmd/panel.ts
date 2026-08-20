// PARITY-004 long-tail: Expert Panel armed-state query for the CLI.
// Query-only template: SDK client + table/json output, no direct DB access.
import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import { attachOptions, createInstanceSDK, formatSdkError, formatTable, type QueryFormatArgs } from "./instance-sdk"

export const PanelCommand = cmd({
  command: "panel",
  describe: "inspect the Expert Panel state",
  builder: (yargs: Argv) => yargs.command(PanelStatusCommand).demandCommand(),
  async handler() {},
})

type PanelStatusArgs = QueryFormatArgs & { sessionID: string }

export const PanelStatusCommand = effectCmd({
  command: "status <sessionID>",
  describe: "show the effective Expert Panel armed state for a session",
  builder: (yargs) =>
    attachOptions(
      yargs.positional("sessionID", {
        describe: "session ID",
        type: "string",
        demandOption: true,
      }),
    ),
  handler: Effect.fn("Cli.panel.status")(function* (rawArgs) {
    const args = rawArgs as unknown as PanelStatusArgs
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    const result = yield* Effect.promise(async () => {
      const sdk = await createInstanceSDK(args, ctx.worktree)
      return sdk.deepagent.panel.status({ sessionID: args.sessionID }).catch((error) => ({ data: undefined, error }))
    })
    if (result.error) return yield* fail(formatSdkError(args, result.error))
    const status = result.data
    if (!status) return yield* fail("Panel status returned no data")
    if (args.format === "json") {
      console.log(JSON.stringify(status, null, 2))
      return
    }
    console.log(
      formatTable(
        ["Session", "Armed", "Explicit", "Rounds"],
        [[status.sessionID, status.armed ? "yes" : "no", status.explicit ? "yes" : "no (global default)", status.rounds]],
      ),
    )
  }),
})
