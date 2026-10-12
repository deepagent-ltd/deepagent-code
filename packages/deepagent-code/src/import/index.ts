import { Cause, Effect, Exit, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMode } from "@deepagent-code/core/database/mode"
import { EventV2 } from "@deepagent-code/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { ProjectV2 } from "@deepagent-code/core/project"
import { Git } from "@deepagent-code/core/git"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { resolveConfigPath, resolveDataPath } from "@deepagent-code/core/global-path"
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { parseCodex } from "./source/codex"
import { parseClaude } from "./source/claude"
import { importSession } from "./writer/session"
import { stageAndReviewMemories } from "./writer/memory"
import { writeSkills } from "./writer/skill"
import { ImportFileSet } from "./writer/file-set"
import { ImportJob } from "@deepagent-code/core/import-job"
import { ImportJobSchema } from "@deepagent-code/core/import-job/schema"
import type {
  ImportControl,
  ImportOptions,
  ImportReport,
  ImportScope,
  ImportSource,
  SessionImportResult,
} from "./types"
import { ALL_SCOPES } from "./types"
import type { SourceSession } from "./ir"

const DEFAULT_DATA_ROOT = resolveDataPath(process.env)
const DEFAULT_DB_PATH = join(DEFAULT_DATA_ROOT, "deepagent-code-local.db")
// Imported skills/config are config-class output (D-W1): they follow the roaming config home
// (%APPDATA%\deepagent-code on Windows; identical to the data root elsewhere).
const DEFAULT_CONFIG_DIR = resolveConfigPath(process.env)

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
export async function runImport(
  options: ImportOptions,
  currentDatabase?: Database.Interface,
  control?: ImportControl,
): Promise<ImportReport> {
  if (!options.dryRun && currentDatabase?.mode) DatabaseMode.ensureReady(currentDatabase.mode)
  const started = Date.now()
  const scopes = options.scopes ?? ALL_SCOPES
  if (!options.dryRun && scopes.some((scope) => scope !== "session") && !control?.files)
    throw new ImportJobSchema.Error({
      code: "invalid_request",
      message: "IMPORT_DURABLE_FILE_JOB_REQUIRED: memory and skill writes require a durable copy import job",
    })
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
  const parsed =
    control?.parsed ?? (options.source === "codex" ? parseCodex(sourcePath, options) : parseClaude(sourcePath, options))
  onProgress({ phase: "discover", source: options.source, count: parsed.sessions.length })
  for (const skip of parsed.skipped) warnings.push(`skipped: ${skip}`)

  if (options.dryRun) {
    report.sessions = parsed.sessions.map((s) => ({
      sourceId: s.sourceId,
      targetId: "(dry-run)",
      turns: s.turns.length,
      reimport: false,
    }))
    report.elapsedMs = Date.now() - started
    return report
  }

  // 2. Sessions (event-sourced, idempotent delete-then-replay)
  if (scopes.includes("session") && parsed.sessions.length > 0) {
    const dbPath = resolveDbPath(options)
    const collected: Array<SessionImportResult | { error: string; sourceId: string }> = []
    report.cancelled = await Effect.runPromise(
      runSessionImports(
        parsed.sessions,
        dbPath,
        (r) => {
          collected.push(r)
          if ("error" in r) {
            onProgress({ phase: "warn", message: r.error, label: r.sourceId })
          } else {
            onProgress({ phase: "write-session", sessionId: r.targetId, turns: r.turns, reimport: r.reimport })
          }
        },
        currentDatabase,
        control,
      ),
    )
    for (const r of collected) {
      if ("error" in r) warnings.push(`session ${r.sourceId}: ${r.error}`)
      else report.sessions.push(r)
    }
  }

  if (report.cancelled) {
    report.elapsedMs = Date.now() - started
    return report
  }

  if (control?.files && scopes.some((scope) => scope === "memory" || scope === "skill")) {
    await ImportFileSet.run({
      parsed,
      jobID: control.jobID,
      sourceDigest: control.sourceDigest,
      target: {
        id: control.jobID,
        mode: "copy_to_new_db",
        sourcePath,
        dbPath: resolveDbPath(options),
        dataRoot: options.outputDataRoot!,
        configDir: options.outputConfigDir!,
        dryRun: false,
      },
      scopes,
      sourceRoot: sourcePath,
      sourceFiles: control.sourceFiles ?? [],
      control: control.files,
    })
    const proof = await Effect.runPromise(
      ImportJob.receipts({
        filename: resolveDbPath(options),
        jobID: control.jobID,
        sourceDigest: control.sourceDigest,
        includeResults: true,
      }),
    )
    report.memory = proof.fileResults
      .filter((result) => result.scope === "memory")
      .reduce(
        (sum, result) => ({
          staged: sum.staged + result.summary.staged,
          approved: sum.approved + result.summary.approved,
          pending: sum.pending + result.summary.pending,
          writtenToInstructions: false,
        }),
        { staged: 0, approved: 0, pending: 0, writtenToInstructions: false },
      )
    report.skills = proof.fileResults
      .filter((result) => result.scope === "skill")
      .reduce(
        (sum, result) => ({
          written: sum.written + result.summary.written,
          skipped: sum.skipped + result.summary.skipped,
        }),
        { written: 0, skipped: 0 },
      )
    report.elapsedMs = Date.now() - started
    return report
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
 * Database + EventV2Bridge + SessionProjector layers exactly as session-create.test
 * does. Each import is isolated via `Effect.either` so a failure is captured,
 * not thrown.
 */
export function runSessionImports(
  sessions: SourceSession[],
  dbPath: string,
  onResult: (r: SessionImportResult | { error: string; sourceId: string }) => void,
  currentDatabase?: Database.Interface,
  control?: ImportControl,
): Effect.Effect<boolean> {
  return Effect.scoped(
    Effect.gen(function* () {
      const database = currentDatabase
        ? Layer.succeed(Database.Service, currentDatabase)
        : Database.layerFromPath(dbPath)
      const events = EventV2.layer.pipe(Layer.provide(database))
      const bridge = EventV2Bridge.layer.pipe(Layer.provide(events), Layer.provide(database))
      const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
      const projects = ProjectV2.layer.pipe(
        Layer.provide(database),
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(Git.defaultLayer),
      )
      const runtime = Layer.mergeAll(database, events, bridge, projector, projects)
      const context = yield* Layer.build(runtime).pipe(Effect.orDie)

      for (const [index, session] of sessions.entries()) {
        if (control && !(yield* Effect.promise(() => control.beforeBatch(session, index)))) return true
        const exit = yield* Effect.exit(
          importSession(
            session,
            control
              ? {
                  jobID: control.jobID,
                  batchID: String(index),
                  sourceDigest: control.sourceDigest,
                  assertAuthority: control.assertBatch(index),
                }
              : undefined,
          ).pipe(Effect.provide(context)),
        )
        if (Exit.isSuccess(exit)) {
          if ("kind" in exit.value)
            return yield* Effect.die(new Error("IMPORT_BATCH_CONFLICT: session batch has a file receipt"))
          onResult(exit.value)
          if (control) yield* Effect.promise(() => control.afterBatch(exit.value, index))
        } else {
          const cause = exit.cause
          const message = Cause.pretty(cause)
          onResult({ error: message, sourceId: session.sourceId })
          if (control)
            yield* Effect.promise(() => control.afterBatch({ error: message, sourceId: session.sourceId }, index))
        }
      }
      return false
    }),
  )
}
