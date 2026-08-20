// PARITY-004 long-tail: domain pack listing for the CLI.
// Query-only template: SDK client + table/json output, no direct DB access.
import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import { attachOptions, createInstanceSDK, formatSdkError, formatTable, type QueryFormatArgs } from "./instance-sdk"

export const PacksCommand = cmd({
  command: "packs",
  describe: "inspect domain packs",
  builder: (yargs: Argv) => yargs.command(PacksListCommand).demandCommand(),
  async handler() {},
})

type PacksListArgs = QueryFormatArgs & { all?: boolean }

export const PacksListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list active domain packs (or the full catalog with --all)",
  builder: (yargs) =>
    attachOptions(yargs).option("all", {
      describe: "show the full installed catalog instead of the active set",
      type: "boolean",
      default: false,
    }),
  handler: Effect.fn("Cli.packs.list")(function* (rawArgs) {
    const args = rawArgs as unknown as PacksListArgs
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    const result = yield* Effect.promise(async () => {
      const sdk = await createInstanceSDK(args, ctx.worktree)
      const call = args.all ? sdk.deepagent.packsAll({}) : sdk.deepagent.packsActive({})
      return call.catch((error) => ({ data: undefined, error }))
    })
    if (result.error) return yield* fail(formatSdkError(args, result.error))
    const data = result.data
    if (!data) return yield* fail("Packs listing returned no data")
    const packs = data.packs
    if (args.format === "json") {
      console.log(JSON.stringify(data, null, 2))
      return
    }
    console.log(
      formatTable(
        ["ID", "Name", "Version", "Risk", "Pinned", "Domains"],
        packs.map((pack) => [
          pack.id,
          pack.name,
          pack.version,
          pack.risk,
          pack.pinned ? "yes" : "no",
          pack.domains.join(", "),
        ]),
      ),
    )
    if (!args.all && "snapshotId" in data) {
      console.log(`snapshot: ${data.snapshotId}`)
    }
  }),
})
