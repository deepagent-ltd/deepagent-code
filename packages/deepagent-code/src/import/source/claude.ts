import { readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { readdirSyncStat } from "../util/fs"
import type { AssistantBlock, IRModel, ParsedSource, SourceSession, Turn } from "../ir"
import { isExcludedFile, redactSecrets } from "../util/secrets"
import { fromMarkdownTree, parseFrontmatter } from "../map/memory"

/**
 * Parse a Claude Code (`~/.claude`) tree into the shared IR.
 *
 * Source layout (verified on a real install):
 *  - `projects/<encoded-cwd>/<session-uuid>.jsonl` — one JSON object per line:
 *      { type: "user" | "assistant", uuid, parentUuid, timestamp(ISO),
 *        sessionId, cwd, message: { role, content: [...] } }
 *    content blocks:
 *      assistant → { type:"thinking", thinking } | { type:"text", text }
 *                  | { type:"tool_use", id, name, input }
 *      user      → string | [{ type:"tool_result", tool_use_id, content, is_error }]
 *  - `projects/<encoded-cwd>/memory/*.md` — per-topic memory (YAML frontmatter)
 *  - `skills/<name>/SKILL.md` — skills (auto-loaded by deepagent-code anyway)
 *
 * Turns are derived in file order: assistant lines open/extend an assistant
 * turn; a user line that is plain text starts a new user turn (and closes the
 * preceding assistant turn). tool_result blocks attach their output to the
 * matching tool_use by id without starting a new turn.
 */

const MAX_OUTPUT = 20_000

export function parseClaude(root: string, opts?: { cwdFilter?: string }): ParsedSource {
  const projectsDir = join(root, "projects")
  const sessions: SourceSession[] = []
  const skipped: string[] = []
  const memories = []
  const skills = parseClaudeSkills(join(root, "skills"))

  for (const projectEntry of readdirSyncStat(projectsDir)) {
    if (!projectEntry.isDirectory) continue
    // memories live under <project>/memory/
    memories.push(...fromMarkdownTree("claude", join(projectEntry.path, "memory")))
    for (const entry of readdirSyncStat(projectEntry.path)) {
      if (!entry.isFile || !entry.path.endsWith(".jsonl")) continue
      if (isExcludedFile(basename(entry.path))) {
        skipped.push(entry.path)
        continue
      }
      const parsed = parseSessionFile(entry.path)
      if (!parsed) {
        skipped.push(entry.path)
        continue
      }
      if (opts?.cwdFilter && !parsed.cwd.startsWith(opts.cwdFilter)) continue
      sessions.push(parsed)
    }
  }

  return { sessions, memories, skills, skipped }
}

interface ClaudeLine {
  type?: string
  uuid?: string
  parentUuid?: string | null
  timestamp?: string
  sessionId?: string
  cwd?: string
  message?: { role?: string; content?: unknown }
  isMeta?: boolean
  isSidechain?: boolean
  version?: string
}

function parseSessionFile(file: string): SourceSession | undefined {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return undefined
  }

  let sessionId = basename(file).replace(/\.jsonl$/, "")
  let cwd = ""
  let startedMs = 0
  let updatedMs = 0
  const turns: Turn[] = []
  let currentAssistant: AssistantBlock[] | null = null
  let currentAssistantStartMs: number | undefined
  let assistantModel: IRModel | undefined

  const flushAssistant = (timestampMs?: number) => {
    if (!currentAssistant || currentAssistant.length === 0) {
      currentAssistant = null
      return
    }
    const turn: Extract<Turn, { kind: "assistant" }> = {
      kind: "assistant",
      timestampMs,
      blocks: currentAssistant,
    }
    if (assistantModel) turn.model = assistantModel
    turns.push(turn)
    currentAssistant = null
  }

  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    let line: ClaudeLine
    try {
      line = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (line.isSidechain) continue // sidechain sub-tasks are not top-level turns
    const ts = line.timestamp ? Date.parse(line.timestamp) : 0
    if (ts > 0) {
      if (startedMs === 0) startedMs = ts
      if (ts > updatedMs) updatedMs = ts
    }
    if (line.sessionId) sessionId = line.sessionId
    if (line.cwd) cwd = line.cwd
    if (line.message?.role === "assistant" && line.message.content) {
      // Each assistant JSONL message is its own deepagent-code step (one
      // step.started → blocks → step.ended). Flush the previous assistant turn
      // first so tool_results still attach to the right (just-closed) turn.
      flushAssistant(currentAssistantStartMs)
      currentAssistant = []
      currentAssistantStartMs = ts
      const blocks = line.message.content as Array<Record<string, unknown>>
      if (line.message && typeof line.message === "object" && "model" in line.message) {
        const m = (line.message as { model?: unknown }).model
        if (typeof m === "string") assistantModel = { id: m, providerID: "anthropic" }
      }
      for (const block of blocks) {
        const type = block.type as string
        if (type === "thinking" && block.thinking) {
          currentAssistant.push({ type: "reasoning", text: redactSecrets(String(block.thinking)).text })
        } else if (type === "text" && block.text) {
          currentAssistant.push({ type: "text", text: redactSecrets(String(block.text)).text })
        } else if (type === "tool_use") {
          currentAssistant.push({
            type: "tool",
            callID: String(block.id ?? ""),
            name: String(block.name ?? "tool"),
            input: (block.input as Record<string, unknown>) ?? {},
          })
        }
      }
    } else if (line.type === "user") {
      const content = line.message?.content
      if (typeof content === "string") {
        if (line.isMeta) continue // system-injected user placeholders
        flushAssistant(ts)
        const t = redactSecrets(content).text.trim()
        if (t) turns.push({ kind: "user", text: t, timestampMs: ts || undefined })
      } else if (Array.isArray(content)) {
        // tool_result blocks attach to the in-flight assistant turn by tool_use_id
        for (const block of content) {
          if (block && typeof block === "object" && block.type === "tool_result") {
            const toolUseId = String((block as { tool_use_id?: unknown }).tool_use_id ?? "")
            const isError = (block as { is_error?: unknown }).is_error
            const outText = extractToolResultText(block)
            const target = currentAssistant?.find((b) => b.type === "tool" && b.callID === toolUseId)
            if (target && target.type === "tool") {
              if (isError) target.error = outText || "error"
              else target.output = clampOutput(outText)
            }
          }
        }
      }
    }
  }
  flushAssistant(updatedMs || startedMs)

  return {
    source: "claude",
    sourceId: sessionId,
    cwd: cwd || process.cwd(),
    title: firstUserText(turns) || sessionId.slice(-12),
    startedMs: startedMs || updatedMs || Date.now(),
    updatedMs: updatedMs || undefined,
    model: assistantModel,
    turns,
  }
}

function extractToolResultText(block: unknown): string {
  const content = (block as { content?: unknown }).content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c
        if (c && typeof c === "object" && "text" in c) return String((c as { text: unknown }).text ?? "")
        return ""
      })
      .join("\n")
  }
  return ""
}

function clampOutput(output: string): string {
  const { text } = redactSecrets(output)
  return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + "\n…[truncated]" : text
}

function firstUserText(turns: Turn[]): string {
  for (const t of turns) if (t.kind === "user") return t.text.slice(0, 60)
  return ""
}

function parseClaudeSkills(skillsDir: string): ParsedSource["skills"] {
  const out: ParsedSource["skills"] = []
  for (const entry of readdirSyncStat(skillsDir)) {
    if (!entry.isDirectory) continue
    const skillFile = join(entry.path, "SKILL.md")
    let text: string
    try {
      text = readFileSync(skillFile, "utf8")
    } catch {
      continue
    }
    const { front, body } = parseFrontmatter(text)
    out.push({
      source: "claude",
      name: front.name || basename(entry.path),
      description: front.description,
      body: redactSecrets(body).text,
      sourceDir: entry.path,
    })
  }
  return out
}
