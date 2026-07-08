import { Effect, Exit, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { ProjectV2 } from "@deepagent-code/core/project"
import { Git } from "@deepagent-code/core/git"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { parseCodex } from "./source/codex"
import { parseClaude } from "./source/claude"
import { importSession } from "./writer/session"
import { stageAndReviewMemories } from "./writer/memory"
import { writeSkills } from "./writer/skill"
import type { ImportOptions, ImportReport, ImportScope, ImportSource, SessionImportResult } from "./types"
import { ALL_SCOPES } from "./types"
import type { SourceSession } from "./ir"

const DEFAULT_DB_PATH = join(homedir(), ".local", "share", "deepagent-code", "deepagent-code-local.db")
const DEFAULT_DATA_ROOT = process.env.DEEPAGENT_CODE_HOME || join(homedir(), ".deepagent", "code")
const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "deepagent-code")

function defaultSourcePath(source: ImportSource): string {
  return join(homedir(), source === "codex" ? ".codex" : ".claude")
}

/**
 * End-to-end import entry point. Both the CLI (`import --from <codex|claude>`)
 * and the desktop settings panel funnel through here.
 *
 * Parsers are pure; only the session write path needs the deepagent-code
 * service stack (assembled from `outputDbPath`). Memory + skill writes are
 * plain filesystem operations. Each session imports in isolation so one
 * malformed source session cannot abort the rest.
 */
export async function runImport(options: ImportOptions): Promise<ImportReport> {
  const started = Date.now()
  const scopes = options.scopes ?? ALL_SCOPES
  const onProgress = options.onProgress ?? (() => {})
  const warnings: string[] = []
  const report: ImportReport = {
    source: options.source,
    scopes,
    dryRun: !!options.dryRun,
    sessions: [],
    warnings,
    elapsedMs: 0,
  }

  // 1. Parse
  const sourcePath = options.sourcePath ?? defaultSourcePath(options.source)
  const parsed = options.source === "codex" ? parseCodex(sourcePath, options) : parseClaude(sourcePath, options)
  onProgress({ phase: "discover", source: options.source, count: parsed.sessions.length })
  for (const skip of parsed.skipped) warnings.push(`skipped: ${skip}`)

  if (options.dryRun) {
    report.sessions = parsed.sessions.map((s) => ({ sourceId: s.sourceId, targetId: "(dry-run)", turns: s.turns.length, reimport: false }))
    report.elapsedMs = Date.now() - started
    return report
  }

  // 2. Sessions (event-sourced, idempotent delete-then-replay)
  if (scopes.includes("session") && parsed.sessions.length > 0) {
    const dbPath = resolveDbPath(options)
    const collected: Array<SessionImportResult | { error: string; sourceId: string }> = []
    await Effect.runPromise(
      runSessionImports(parsed.sessions, dbPath, (r) => {
        collected.push(r)
        if ("error" in r) {
          onProgress({ phase: "warn", message: r.error, label: r.sourceId })
        } else {
          onProgress({ phase: "write-session", sessionId: r.targetId, turns: r.turns, reimport: r.reimport })
        }
      }),
    )
    for (const r of collected) {
      if ("error" in r) warnings.push(`session ${r.sourceId}: ${r.error}`)
      else report.sessions.push(r)
    }
  }

  // 3. Memory (knowledge candidates → AI auto-review: approve safe, leave risky/conflict pending)
  if (scopes.includes("memory") && parsed.memories.length > 0) {
    const dataRoot = options.outputDataRoot ?? DEFAULT_DATA_ROOT
    try {
      report.memory = stageAndReviewMemories(parsed.memories, dataRoot)
      onProgress({ phase: "write-memory", staged: report.memory.staged })
      onProgress({ phase: "write-memory-review", approved: report.memory.approved, pending: report.memory.pending })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warnings.push(`memory: ${message}`)
      onProgress({ phase: "warn", message })
    }
  }

  // 4. Skills
  if (scopes.includes("skill") && parsed.skills.length > 0) {
    const configDir = options.outputConfigDir ?? DEFAULT_CONFIG_DIR
    try {
      report.skills = writeSkills(parsed.skills, configDir)
      onProgress({ phase: "write-skill", written: report.skills.written })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warnings.push(`skill: ${message}`)
    }
  }

  report.elapsedMs = Date.now() - started
  return report
}

/** Resolve the SQLite path, optionally snapshotting the live DB first. */
function resolveDbPath(options: ImportOptions): string {
  const live = DEFAULT_DB_PATH
  if (options.outputDbPath) return options.outputDbPath
  if (options.copyLiveDb) {
    const out = join(dirname(live), "import-snapshot.db")
    if (existsSync(live)) {
      mkdirSync(dirname(out), { recursive: true })
      copyFileSync(live, out)
    }
    return out
  }
  return live
}

/**
 * Run session imports against a database at `dbPath`, assembling the
 * Database + EventV2 + SessionProjector layers exactly as session-create.test
 * does. Each import is isolated via `Effect.either` so a failure is captured,
 * not thrown.
 */
export function runSessionImports(
  sessions: SourceSession[],
  dbPath: string,
  onResult: (r: SessionImportResult | { error: string; sourceId: string }) => void,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const database = Database.layerFromPath(dbPath)
    const events = EventV2.layer.pipe(Layer.provide(database))
    const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
    const projects = ProjectV2.layer.pipe(
      Layer.provide(database),
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(Git.defaultLayer),
    )
    const runtime = Layer.mergeAll(database, events, projector, projects)

    for (const session of sessions) {
      const exit = yield* Effect.exit(importSession(session).pipe(Effect.provide(runtime)))
      if (Exit.isSuccess(exit)) {
        onResult(exit.value)
      } else {
        const cause = exit.cause
        const message = cause instanceof Error ? cause.message : String((cause as { _tag?: string })._tag ?? cause)
        onResult({ error: message, sourceId: session.sourceId })
      }
    }
  })
}
