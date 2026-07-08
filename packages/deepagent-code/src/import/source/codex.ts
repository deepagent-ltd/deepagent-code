import { readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { readdirSyncStat } from "../util/fs"
import type { AssistantBlock, IRModel, ParsedSource, SourceSession, Turn } from "../ir"
import { isExcludedFile, redactSecrets } from "../util/secrets"
import { fromMarkdownTree } from "../map/memory"

/**
 * Parse a Codex (`~/.codex` / `~/.codex_backup`) tree into the shared IR.
 *
 * Source layout (verified against a real backup):
 *  - `session_index.jsonl` — `{id, thread_name, updated_at}` per session (titles)
 *  - `sessions/YYYY/MM/DD/rollout-*.jsonl` — one JSON object per line:
 *      * `session_meta`   payload: `{id/session_id, cwd, model_provider, …}`
 *      * `response_item`  payload.type ∈ {message, reasoning, function_call,
 *                        function_call_output}
 *      * `event_msg` / `turn_context` / `compacted` — higher-level, not needed
 *
 * A Codex exchange is flattened to deepagent-code turns: each user message
 * starts a new boundary; everything until the next user message (reasoning,
 * tool calls + outputs, final assistant text) becomes one assistant turn.
 */

const MAX_OUTPUT = 20_000

export function parseCodex(root: string, opts?: { cwdFilter?: string }): ParsedSource {
  const titles = readTitleIndex(join(root, "session_index.jsonl"))
  const rolloutFiles = discoverRollouts(join(root, "sessions"))
  const sessions: SourceSession[] = []
  const skipped: string[] = []

  for (const file of rolloutFiles) {
    if (isExcludedFile(file)) {
      skipped.push(file)
      continue
    }
    const parsed = parseRollout(file, titles)
    if (!parsed) {
      skipped.push(file)
      continue
    }
    if (opts?.cwdFilter && !parsed.cwd.startsWith(opts.cwdFilter)) continue
    sessions.push(parsed)
  }

  const memories = fromMarkdownTree("codex", join(root, "memories"))
  return { sessions, memories, skills: [], skipped }
}

function readTitleIndex(path: string): Map<string, string> {
  const map = new Map<string, string>()
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return map
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const o = JSON.parse(trimmed) as { id?: string; thread_name?: string }
      if (o.id && o.thread_name) map.set(o.id, o.thread_name)
    } catch {
      /* ignore malformed index lines */
    }
  }
  return map
}

function discoverRollouts(sessionsDir: string): string[] {
  const out: string[] = []
  try {
    for (const entry of readdirSyncStat(sessionsDir)) {
      if (entry.isDirectory) out.push(...discoverRollouts(entry.path))
      else if (entry.path.endsWith(".jsonl") && basename(entry.path).startsWith("rollout-")) out.push(entry.path)
    }
  } catch {
    /* sessions dir may not exist */
  }
  return out
}

interface RolloutLine {
  type: string
  payload?: unknown
  timestamp?: string
}

function parseRollout(file: string, titles: Map<string, string>): SourceSession | undefined {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return undefined
  }

  let sessionId = ""
  let cwd = ""
  let model: IRModel | undefined
  let startedMs = 0
  let updatedMs = 0
  const turns: Turn[] = []
  let currentAssistant: { turn: AssistantTurnBlocks } | null = null

  const flushAssistant = () => {
    if (!currentAssistant) return
    const built = currentAssistant.turn.build()
    if (built) turns.push(built)
    currentAssistant = null
  }

  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    let line: RolloutLine
    try {
      line = JSON.parse(trimmed)
    } catch {
      continue
    }
    const ts = line.timestamp ? Date.parse(line.timestamp) : 0
    if (ts > 0) {
      if (startedMs === 0) startedMs = ts
      if (ts > updatedMs) updatedMs = ts
    }

    if (line.type === "session_meta") {
      const p = line.payload as Record<string, unknown> | undefined
      sessionId = String(p?.session_id ?? p?.id ?? "")
      cwd = String(p?.cwd ?? "")
      const provider = String(p?.model_provider ?? "openai").toLowerCase()
      const modelId = p?.model ? String(p.model) : undefined
      if (modelId) model = { id: modelId, providerID: provider }
      continue
    }

    if (line.type !== "response_item") continue
    const p = line.payload as Record<string, unknown> | undefined
    if (!p) continue
    const kind = p.type as string

    if (kind === "message") {
      const role = p.role as string
      const contentText = joinMessageContent(p.content)
      if (role === "user") {
        flushAssistant()
        if (contentText.trim()) {
          const { text } = redactSecrets(contentText)
          turns.push({ kind: "user", text, timestampMs: ts || undefined })
        }
      } else if (role === "assistant") {
        if (!currentAssistant) currentAssistant = { turn: new AssistantTurnBlocks(ts) }
        if (contentText.trim()) currentAssistant.turn.text(contentText)
      }
      // role === "developer" / "system" are Codex internals — skipped.
    } else if (kind === "reasoning") {
      if (!currentAssistant) currentAssistant = { turn: new AssistantTurnBlocks(ts) }
      const summary = p.summary as Array<{ text?: string }> | undefined
      const reasoningText = (summary ?? []).map((s) => s.text ?? "").join("\n").trim()
      if (reasoningText) currentAssistant.turn.reasoning(reasoningText)
    } else if (kind === "function_call") {
      if (!currentAssistant) currentAssistant = { turn: new AssistantTurnBlocks(ts) }
      const callID = String(p.call_id ?? p.id ?? "")
      const name = String(p.name ?? "tool")
      const input = safeParseArgs(p.arguments)
      currentAssistant.turn.tool(callID, name, input)
    } else if (kind === "function_call_output") {
      const callID = String(p.call_id ?? "")
      const output = clampOutput(String(p.output ?? ""))
      // attach to the most recent matching tool block across the current turn
      currentAssistant?.turn.attachOutput(callID, output)
    }
  }

  flushAssistant()

  if (!sessionId) {
    // fall back to the filename so the session is still importable & dedupable
    sessionId = basename(file).replace(/\.jsonl$/, "")
  }

  return {
    source: "codex",
    sourceId: sessionId,
    cwd: cwd || process.cwd(),
    title: titles.get(sessionId) || firstUserText(turns) || sessionId.slice(-12),
    startedMs: startedMs || updatedMs || Date.now(),
    updatedMs: updatedMs || undefined,
    model,
    turns,
  }
}

function joinMessageContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((c) => {
      if (typeof c === "string") return c
      if (c && typeof c === "object" && "text" in c) return String((c as { text: unknown }).text ?? "")
      return ""
    })
    .join("\n")
    .trim()
}

function safeParseArgs(argumentsJson: unknown): Record<string, unknown> {
  if (typeof argumentsJson !== "string") return {}
  try {
    const parsed = JSON.parse(argumentsJson)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { value: parsed }
  } catch {
    return { raw: argumentsJson }
  }
}

function clampOutput(output: string): string {
  const { text } = redactSecrets(output)
  return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + "\n…[truncated]" : text
}

function firstUserText(turns: Turn[]): string {
  for (const t of turns) if (t.kind === "user") return t.text.slice(0, 60)
  return ""
}

/**
 * Mutable builder for one assistant turn so blocks append in source order and
 * tool outputs can be attached after their call by `call_id`.
 */
class AssistantTurnBlocks {
  private blocks: AssistantBlock[] = []
  private model: IRModel | undefined
  private finish: string | undefined
  private cost: number | undefined
  private tokens: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number } | undefined
  constructor(private readonly timestampMs: number) {}

  text(t: string) {
    this.blocks.push({ type: "text", text: redactSecrets(t).text })
  }
  reasoning(t: string) {
    this.blocks.push({ type: "reasoning", text: redactSecrets(t).text })
  }
  tool(callID: string, name: string, input: unknown) {
    this.blocks.push({ type: "tool", callID, name, input })
  }
  attachOutput(callID: string, output: string) {
    const block = this.blocks.find((b) => b.type === "tool" && b.callID === callID)
    if (block && block.type === "tool") block.output = output
  }

  setModel(m: IRModel) {
    this.model = m
  }
  setUsage(u: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number }) {
    this.tokens = u
  }

  build(): Turn | null {
    if (this.blocks.length === 0) return null
    const turn: Extract<Turn, { kind: "assistant" }> = {
      kind: "assistant",
      timestampMs: this.timestampMs || undefined,
      blocks: this.blocks,
    }
    if (this.model) turn.model = this.model
    if (this.tokens) turn.tokens = this.tokens
    if (this.finish) turn.finish = this.finish
    if (this.cost !== undefined) turn.cost = this.cost
    return turn
  }
}
