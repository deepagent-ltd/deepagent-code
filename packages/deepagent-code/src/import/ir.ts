/**
 * Source-of-truth intermediate representation shared by every parser.
 *
 * Parsers (codex / claude) each translate their native on-disk format into
 * this IR; the mapper layer then turns {@link SourceSession.turns} into a
 * deepagent-code `SerializedEvent[]`. Keeping the IR source-agnostic means the
 * event-mapping recipe and the idempotent writer only have to be written once.
 */

export type ImportSource = "codex" | "claude"

/** A model reference in deepagent-code terms: `{id, providerID, variant?}`. */
export interface IRModel {
  id: string
  providerID: string
  variant?: string
}

/** A single user prompt (text only; attachments are out of scope for v1). */
export interface UserTurn {
  kind: "user"
  /** Epoch milliseconds, if the source recorded one. */
  timestampMs?: number
  text: string
}

export type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool"
      callID: string
      name: string
      /** Best-effort decoded tool input. */
      input: unknown
      /** Tool output text (truncated to a safe bound by the parser). */
      output?: string
      error?: string
    }

/** One assistant step: model + an ordered list of content blocks. */
export interface AssistantTurn {
  kind: "assistant"
  timestampMs?: number
  completedMs?: number
  model?: IRModel
  blocks: AssistantBlock[]
  finish?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cacheRead?: number
    cacheWrite?: number
  }
}

export type Turn = UserTurn | AssistantTurn

export interface SourceSession {
  source: ImportSource
  /** Original session id from the source (uuid / thread id). */
  sourceId: string
  /** Working directory the session ran in. */
  cwd: string
  title: string
  /** Epoch ms. */
  startedMs: number
  updatedMs?: number
  model?: IRModel
  /** Ordered turns; user/assistant interleaved. */
  turns: Turn[]
}

/** A memory/knowledge item extracted from the source's memory files. */
export interface MemoryItem {
  source: ImportSource
  /** Stable id within the source (filename slug / heading slug). */
  slug: string
  title: string
  description?: string
  body: string
  /** Origin cwd for per-project scoping; empty = global. */
  cwd?: string
  originSessionId?: string
}

/** A skill discovered in the source tree. */
export interface SkillItem {
  source: ImportSource
  name: string
  description?: string
  /** Full SKILL.md body (frontmatter may be missing/patched by the writer). */
  body: string
  /** Absolute path to the source skill folder (for copying assets later). */
  sourceDir?: string
}

export interface ParsedSource {
  sessions: SourceSession[]
  memories: MemoryItem[]
  skills: SkillItem[]
  /** Files intentionally skipped (secrets, binary, etc.). */
  skipped: string[]
}
