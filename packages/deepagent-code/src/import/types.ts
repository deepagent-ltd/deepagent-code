import type { ImportSource } from "./ir"
export type { ImportSource } from "./ir"

/**
 * Which categories of data to import from the external agent.
 * Default in the CLI/UI is all three; each can be toggled independently.
 */
export type ImportScope = "session" | "memory" | "skill"

/**
 * Progress events emitted during an import run, for the CLI logger and the
 * desktop UI to surface to the user.
 */
export type ImportProgress =
  | { phase: "discover"; source: ImportSource; count: number }
  | { phase: "parse"; source: ImportSource; current: number; total: number; label?: string }
  | { phase: "write-session"; sessionId: string; turns: number; reimport: boolean }
  | { phase: "write-memory"; staged: number }
  | { phase: "write-memory-review"; approved: number; pending: number }
  | { phase: "write-skill"; written: number }
  | { phase: "skip"; reason: string; label?: string }
  | { phase: "warn"; message: string; label?: string }

export type ProgressFn = (event: ImportProgress) => void

/**
 * Top-level options for a single import run. Both the CLI and the desktop UI
 * build one of these and hand it to {@link runImport}.
 */
export interface ImportOptions {
  /** Which agent produced the source data. */
  source: ImportSource
  /**
   * Root of the source data.
   *  - codex:  the `~/.codex` (or `~/.codex_backup`) directory
   *  - claude: the `~/.claude` directory
   * Defaults to the agent's home directory when omitted.
   */
  sourcePath?: string
  /** Which categories to import. Defaults to all. */
  scopes?: ImportScope[]
  /** When true, parse + map only; do not write anything. */
  dryRun?: boolean
  /**
   * When true, copy the live deepagent-code DB to `outputDbPath` and write
   * into the copy (safe pre-validation before swapping). When false (default),
   * write into the live DB.
   */
  copyLiveDb?: boolean
  /** Override the target SQLite path. Defaults to the live deepagent-code DB. */
  outputDbPath?: string
  /** Override the deepagent-code data root (where knowledge/skills land). */
  outputDataRoot?: string
  /** Override the deepagent-code config dir (where global skills land). */
  outputConfigDir?: string
  /** Optional sink for progress events. */
  onProgress?: ProgressFn
  /** Restrict import to sessions whose cwd matches this prefix (optional). */
  cwdFilter?: string
}

export interface SessionImportResult {
  sourceId: string
  targetId: string
  turns: number
  reimport: boolean
}

export interface MemoryImportResult {
  staged: number
  writtenToInstructions: boolean
  /** Candidates the auto-review pass promoted to active. */
  approved: number
  /** Candidates left pending (sensitive / secret / blocked / empty / conflict). */
  pending: number
}

export interface SkillImportResult {
  written: number
  skipped: number
}

export interface ImportReport {
  source: ImportSource
  scopes: ImportScope[]
  dryRun: boolean
  sessions: SessionImportResult[]
  memory?: MemoryImportResult
  skills?: SkillImportResult
  warnings: string[]
  /** Elapsed milliseconds. */
  elapsedMs: number
}

export const ALL_SCOPES: ImportScope[] = ["session", "memory", "skill"]
