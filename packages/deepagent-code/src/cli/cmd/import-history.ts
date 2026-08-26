import { Effect } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"
import { EOL } from "node:os"
import { effectCmd, fail } from "../effect-cmd"
import { runImport } from "@/import"
import { ALL_SCOPES, type ImportScope, type ImportSource } from "@/import/types"

/**
 * `deepagentcode import-history --from codex|claude`
 *
 * Hot-imports chat history (event-sourced, idempotent), memories (staged as
 * knowledge candidates for Agent review), and skills from a Codex or Claude
 * Code installation into the running deepagent-code database. Re-runnable: the
 * same source always converges on the same target sessions.
 *
 * This is the standalone equivalent of the desktop "Import history" settings
 * panel — both funnel into `runImport`.
 */
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
        default: false,
        describe: "snapshot the live DB and write into the copy (safe pre-validation)",
      })
      .option("cwd-filter", {
        type: "string",
        describe: "only import sessions whose cwd starts with this prefix",
      }),
  handler: Effect.fn("Cli.importHistory")(function* (args) {
    const source = args.from as ImportSource
    const sourcePath = (args.path as string) || defaultSourcePath(source)
    const scopes = (args.scope as ImportScope[]) ?? ALL_SCOPES

    process.stdout.write(`Importing from ${source} (${sourcePath}) — scopes: ${scopes.join(",")}${args.dryRun ? " [dry-run]" : ""}${EOL}`)

    const report = yield* Effect.promise(() =>
      runImport({
        source,
        sourcePath,
        scopes,
        dryRun: !!args.dryRun,
        copyLiveDb: !!args.copyLiveDb,
        cwdFilter: args.cwdFilter as string | undefined,
        onProgress: (event) => {
          switch (event.phase) {
            case "discover":
              process.stdout.write(`  discovered ${event.count} session(s)${EOL}`)
              break
            case "write-session":
              process.stdout.write(`  [session] ${event.sessionId} (${event.turns} turns${event.reimport ? ", re-imported" : ""})${EOL}`)
              break
            case "write-memory":
              process.stdout.write(`  [memory] staged ${event.staged} candidate(s) for review${EOL}`)
              break
            case "write-skill":
              process.stdout.write(`  [skill] wrote ${event.written}${EOL}`)
              break
            case "warn":
              process.stdout.write(`  [warn] ${event.label ?? ""} ${event.message}${EOL}`)
              break
          }
        },
      }),
    )

    const imported = report.sessions.length
    process.stdout.write(
      [
        `Done in ${report.elapsedMs}ms.`,
        `sessions=${imported}`,
        report.memory ? `memories_staged=${report.memory.staged}` : "",
        report.skills ? `skills=${report.skills.written}` : "",
        report.warnings.length ? `warnings=${report.warnings.length}` : "",
        report.dryRun ? "(dry-run, nothing written)" : "",
      ]
        .filter(Boolean)
        .join("  ") + EOL,
    )

    if (report.warnings.length > 0 && !report.dryRun) {
      for (const w of report.warnings.slice(0, 20)) process.stdout.write(`  ! ${w}${EOL}`)
      if (report.warnings.length > 20) process.stdout.write(`  ... and ${report.warnings.length - 20} more${EOL}`)
    }

    if (imported === 0 && report.warnings.length > 0) {
      return yield* fail("import produced no sessions; see warnings above")
    }
  }),
})

function defaultSourcePath(source: ImportSource): string {
  return join(homedir(), source === "codex" ? ".codex" : ".claude")
}
