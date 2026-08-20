// PARITY-004 long-tail: DeepAgent run review list for the CLI.
// Query-only template: SDK client + table/json output, no direct DB access.
import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import { attachOptions, createInstanceSDK, formatSdkError, formatTable, type QueryFormatArgs } from "./instance-sdk"

export const ReviewCommand = cmd({
  command: "review",
  describe: "inspect DeepAgent run reviews",
  builder: (yargs: Argv) => yargs.command(ReviewListCommand).demandCommand(),
  async handler() {},
})

export const ReviewListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list recent DeepAgent run reviews",
  builder: (yargs) => attachOptions(yargs),
  handler: Effect.fn("Cli.review.list")(function* (rawArgs) {
    const args = rawArgs as unknown as QueryFormatArgs
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    const result = yield* Effect.promise(async () => {
      const sdk = await createInstanceSDK(args, ctx.worktree)
      return sdk.deepagent.reviews({}).catch((error) => ({ data: undefined, error }))
    })
    if (result.error) return yield* fail(formatSdkError(args, result.error))
    const reviews = result.data?.reviews ?? []
    if (args.format === "json") {
      console.log(JSON.stringify(reviews, null, 2))
      return
    }
    console.log(
      formatTable(
        ["Run", "Mode", "Status", "Next action", "Diagnosis"],
        reviews.map((review) => [
          review.runId,
          review.agentMode,
          review.status,
          review.nextAction,
          review.diagnosis.status,
        ]),
      ),
    )
  }),
})
