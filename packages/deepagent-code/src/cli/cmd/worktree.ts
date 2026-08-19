// PARITY-004 long-tail: basic worktree commands (list/create/remove) — CLI
// parity with the GUI worktree panel. Wraps the experimental worktree
// endpoints through the SDK client; removal is fail-closed (safe-remove)
// unless --force is passed.
import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import { UI } from "../ui"
import { attachOptions, createInstanceSDK, formatSdkError, formatTable, type QueryFormatArgs } from "./instance-sdk"

export const WorktreeCommand = cmd({
  command: "worktree",
  describe: "manage git worktrees for the current project",
  builder: (yargs: Argv) =>
    yargs
      .command(WorktreeListCommand)
      .command(WorktreeCreateCommand)
      .command(WorktreeRemoveCommand)
      .demandCommand(),
  async handler() {},
})

export const WorktreeListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list worktrees of the current project",
  builder: (yargs) => attachOptions(yargs),
  handler: Effect.fn("Cli.worktree.list")(function* (rawArgs) {
    const args = rawArgs as unknown as QueryFormatArgs
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    const result = yield* Effect.promise(async () => {
      const sdk = await createInstanceSDK(args, ctx.worktree)
      return sdk.worktree.list({}).catch((error) => ({ data: undefined, error }))
    })
    if (result.error) return yield* fail(formatSdkError(args, result.error))
    const worktrees = result.data ?? []
    if (args.format === "json") {
      console.log(JSON.stringify(worktrees, null, 2))
      return
    }
    console.log(formatTable(["Worktree"], worktrees.map((directory) => [directory])))
  }),
})

type WorktreeCreateArgs = QueryFormatArgs & { name?: string; startCommand?: string }

export const WorktreeCreateCommand = effectCmd({
  command: "create",
  describe: "create a new worktree",
  builder: (yargs) =>
    attachOptions(yargs)
      .option("name", {
        describe: "worktree/branch name (default: auto-generated)",
        type: "string",
      })
      .option("start-command", {
        describe: "additional startup script to run after the project's start command",
        type: "string",
      }),
  handler: Effect.fn("Cli.worktree.create")(function* (rawArgs) {
    const args = rawArgs as unknown as WorktreeCreateArgs
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    const result = yield* Effect.promise(async () => {
      const sdk = await createInstanceSDK(args, ctx.worktree)
      return sdk.worktree
        .create({
          worktreeCreateInput: {
            ...(args.name ? { name: args.name } : {}),
            ...(args.startCommand ? { startCommand: args.startCommand } : {}),
          },
        })
        .catch((error) => ({ data: undefined, error }))
    })
    if (result.error) return yield* fail(formatSdkError(args, result.error))
    const worktree = result.data
    if (!worktree) return yield* fail("Worktree creation returned no data")
    if (args.format === "json") {
      console.log(JSON.stringify(worktree, null, 2))
      return
    }
    UI.println(
      UI.Style.TEXT_SUCCESS_BOLD +
        `Created worktree "${worktree.name}"${worktree.branch ? ` (branch ${worktree.branch})` : ""} at ${worktree.directory}` +
        UI.Style.TEXT_NORMAL,
    )
  }),
})

type WorktreeRemoveArgs = QueryFormatArgs & { directory: string; force?: boolean }

export const WorktreeRemoveCommand = effectCmd({
  command: "remove <directory>",
  aliases: ["rm"],
  describe: "remove a worktree (fail-closed unless --force)",
  builder: (yargs) =>
    attachOptions(
      yargs
        .positional("directory", {
          describe: "worktree directory to remove",
          type: "string",
          demandOption: true,
        })
        .option("force", {
          describe: "remove even if the worktree has uncommitted changes",
          type: "boolean",
          default: false,
        }),
    ),
  handler: Effect.fn("Cli.worktree.remove")(function* (rawArgs) {
    const args = rawArgs as unknown as WorktreeRemoveArgs
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    const result = yield* Effect.promise(async () => {
      const sdk = await createInstanceSDK(args, ctx.worktree)
      return sdk.worktree
        .safeRemove({ worktreeSafeRemoveInput: { directory: args.directory, ...(args.force ? { force: true } : {}) } })
        .catch((error) => ({ data: undefined, error }))
    })
    if (result.error) return yield* fail(formatSdkError(args, result.error))
    if (args.format === "json") {
      console.log(JSON.stringify({ directory: args.directory, removed: result.data ?? false }, null, 2))
      return
    }
    if (!result.data) {
      return yield* fail(`Worktree ${args.directory} was not removed (uncommitted changes? retry with --force)`)
    }
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Removed worktree ${args.directory}` + UI.Style.TEXT_NORMAL)
  }),
})
