import { Effect } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"
import { EOL } from "node:os"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { ImportJobSchema } from "@deepagent-code/core/import-job/schema"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { ALL_SCOPES, type ImportScope, type ImportSource } from "@/import/types"

/** CLI and GUI use the same durable import job, private copy target and explicit cancellation.
 * Imported conversation history never admits model or tool execution. */
export const ImportHistoryCommand = effectCmd({
  command: "import-history",
  aliases: ["importHistory"],
  describe: "import chat history, memory, and skills from Codex or Claude Code",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("from", {
        type: "string",
        choices: ["codex", "claude"] as const,
        demandOption: true,
        describe: "which agent's data to import",
      })
      .option("path", {
        type: "string",
        describe: "source data root (defaults to ~/.codex or ~/.claude)",
      })
      .option("scope", {
        type: "array",
        choices: ALL_SCOPES,
        default: ALL_SCOPES,
        describe: "categories to import (repeatable)",
      })
      .option("dry-run", {
        type: "boolean",
        default: false,
        describe: "parse and map only; write nothing",
      })
      .option("copy-live-db", {
        type: "boolean",
        default: true,
        describe: "write into a private database copy (default); disabling requires explicit live-merge confirmation",
      })
      .option("confirm-live-merge", {
        type: "boolean", default: false,
        describe: "explicitly confirm live session merge; memory and skills require a private copy",
      })
      .option("request-id", {
        type: "string", describe: "stable request identity for exact retries",
      })
      .option("cwd-filter", {
        type: "string",
        describe: "only import sessions whose cwd starts with this prefix",
      }),
  handler: Effect.fn("Cli.importHistory")(function* (args) {
    const { ImportJobs } = yield* Effect.promise(() => import("@/import/job"))
    const source = args.from as ImportSource
    const sourcePath = args.path || defaultSourcePath(source)
    const scopes = (args.scope as ImportScope[]) ?? ALL_SCOPES
    process.stdout.write(`Importing from ${source} (${sourcePath}) — scopes: ${scopes.join(",")}${args.dryRun ? " [dry-run]" : ""}${EOL}`)
    const jobs = yield* ImportJobs.make
    const admitted = yield* jobs.create({
      requestID: args.requestId ?? crypto.randomUUID(), source, sourcePath, scopes,
      dryRun: args.dryRun, copyLiveDb: args.copyLiveDb,
      mode: args.copyLiveDb ? "copy_to_new_db" : "merge_into_live",
      confirmLiveMerge: args.confirmLiveMerge, cwdFilter: args.cwdFilter,
    })
    process.stdout.write(`job=${admitted.id}  request=${admitted.requestID}${EOL}`)
    const stopping = { requested: false }
    const shutdown = () => { stopping.requested = true }
    yield* Effect.acquireRelease(Effect.sync(() => {
      process.on("SIGINT", shutdown)
      process.on("SIGTERM", shutdown)
    }), () => Effect.sync(() => {
      process.off("SIGINT", shutdown)
      process.off("SIGTERM", shutdown)
    }))
    const settled = yield* Effect.gen(function* () {
      for (;;) {
        const current = yield* (stopping.requested ? jobs.cancel(admitted.id) : jobs.get(admitted.id))
        if (ImportJobSchema.terminal(current.state)) return current
        yield* Effect.sleep("250 millis")
      }
    })
    const report = yield* jobs.report(admitted.id)
    process.stdout.write([
      `state=${settled.state}`, `elapsed=${report.elapsedMs}ms`, `sessions=${report.sessions.length}`,
      report.memory ? `memories_staged=${report.memory.staged}` : "",
      report.skills ? `skills=${report.skills.written}` : "",
      report.warnings.length ? `warnings=${report.warnings.length}` : "",
      report.dryRun ? "(dry-run, nothing written)" : "",
      report.target ? `target=${report.target.dbPath}` : "",
    ].filter(Boolean).join("  ") + EOL)
    for (const warning of report.warnings.slice(0, 20)) process.stdout.write(`  ! ${warning}${EOL}`)
    if (report.warnings.length > 20) process.stdout.write(`  ... and ${report.warnings.length - 20} more${EOL}`)
    if (settled.state !== "completed")
      return yield* fail(`Import ${settled.id} ended in ${settled.state}${settled.error ? ` (${settled.error.code})` : ""}; the durable job remains available for inspection`)
  }, Effect.provide(EffectFlock.defaultLayer), Effect.scoped, Effect.mapError((error) => error instanceof CliError ? error :
    new CliError({ message: error.message, exitCode: 1 }))),
})

function defaultSourcePath(source: ImportSource): string {
  return join(homedir(), source === "codex" ? ".codex" : ".claude")
}
