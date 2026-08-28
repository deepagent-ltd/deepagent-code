// PARITY-004 long-tail: Wiki read-side for the CLI (list + search).
// Query-only template: SDK client + table/json output, no direct DB access.
// Endpoints are gated by the wiki flag — a disabled wiki surfaces as a
// friendly server error.
import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import { attachOptions, createInstanceSDK, formatSdkError, formatTable, type QueryFormatArgs } from "./instance-sdk"

export const WikiCommand = cmd({
  command: "wiki",
  describe: "browse and search the project Wiki",
  builder: (yargs: Argv) => yargs.command(WikiListCommand).command(WikiSearchCommand).demandCommand(),
  async handler() {},
})

type WikiListArgs = QueryFormatArgs & { type?: string }

export const WikiListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list Wiki pages",
  builder: (yargs) =>
    attachOptions(yargs).option("type", {
      describe: "filter by page type",
      type: "string",
    }),
  handler: Effect.fn("Cli.wiki.list")(function* (rawArgs) {
    const args = rawArgs as unknown as WikiListArgs
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    const result = yield* Effect.promise(async () => {
      const sdk = await createInstanceSDK(args, ctx.worktree)
      return sdk.deepagent.wiki
        .pages({ ...(args.type ? { type: args.type } : {}) })
        .catch((error) => ({ data: undefined, error }))
    })
    if (result.error) return yield* fail(formatSdkError(args, result.error))
    const pages = result.data?.pages ?? []
    if (args.format === "json") {
      yield* writeOutput(JSON.stringify(pages, null, 2))
      return
    }
    yield* writeOutput(
      formatTable(
        ["Doc", "Type", "Scope", "Version", "Editable", "Title"],
        pages.map((page) => [
          page.docId,
          page.type,
          page.scope,
          String(page.version),
          page.editable ? "yes" : "no",
          page.title,
        ]),
      ),
    )
  }),
})

type WikiSearchArgs = QueryFormatArgs & { text: string; type?: string; scope?: string }

export const WikiSearchCommand = effectCmd({
  command: "search <text>",
  describe: "full-text search over the Wiki",
  builder: (yargs) =>
    attachOptions(
      yargs
        .positional("text", {
          describe: "search text",
          type: "string",
          demandOption: true,
        })
        .option("type", { describe: "filter by page type", type: "string" })
        .option("scope", { describe: "filter by scope", type: "string" }),
    ),
  handler: Effect.fn("Cli.wiki.search")(function* (rawArgs) {
    const args = rawArgs as unknown as WikiSearchArgs
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    const result = yield* Effect.promise(async () => {
      const sdk = await createInstanceSDK(args, ctx.worktree)
      return sdk.deepagent
        .wikiSearch({
          text: args.text,
          ...(args.type ? { type: args.type } : {}),
          ...(args.scope ? { scope: args.scope } : {}),
        })
        .catch((error) => ({ data: undefined, error }))
    })
    if (result.error) return yield* fail(formatSdkError(args, result.error))
    const hits = result.data?.hits ?? []
    if (args.format === "json") {
      yield* writeOutput(JSON.stringify(hits, null, 2))
      return
    }
    yield* writeOutput(
      formatTable(
        ["Doc", "Type", "Scope", "Score", "Title"],
        hits.map((hit) => [hit.docId, hit.type, hit.scope, String(hit.score), hit.title]),
      ),
    )
  }),
})

const writeOutput = (value: string) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(`${value}\n`, (error) => {
          if (error) return reject(error)
          resolve()
        })
      }),
  )
