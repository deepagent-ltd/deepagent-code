import { Schema } from "effect"

/**
 * Parses @mentions from markdown content, excluding code blocks.
 */
export class MentionParser {
  /**
   * Extract all @AgentName mentions from markdown content.
   * Rules:
   * - Only parse from plain text (not fenced code blocks)
   * - Deduplicate mentions
   * - Preserve order of first occurrence
   */
  static parse(content: string): string[] {
    // Remove fenced code blocks and inline code
    const withoutCode = this.removeCode(content)

    // Extract mentions: @word (alphanumeric, underscore, hyphen)
    const mentionRegex = /@([\w-]+)/g
    const matches = withoutCode.matchAll(mentionRegex)

    const mentions = new Set<string>()
    const ordered: string[] = []

    for (const match of matches) {
      const name = match[1]
      if (!mentions.has(name)) {
        mentions.add(name)
        ordered.push(name)
      }
    }

    return ordered
  }

  /**
   * Remove fenced code blocks (``` ... ``` or ~~~ ... ~~~) and inline code
   * (`...`) from markdown content.
   */
  private static removeCode(content: string): string {
    const codeBlockRegex = /```[\s\S]*?```|~~~[\s\S]*?~~~/g
    const inlineCodeRegex = /`[^`]*`/g
    return content.replace(codeBlockRegex, "").replace(inlineCodeRegex, "")
  }
}

/**
 * Machine-readable agent metadata (V3.8.1 §C.3), consumed by V4.0's Agent
 * Registry / Task Partitioner / autonomy gates. Every field is OPTIONAL and
 * additive: an agent definition that sets none of them behaves exactly as it
 * did in V3.8 (not event-triggerable, no declared capabilities, autonomy
 * level_0, no extra limits). V3.8.1 only DECLARES and REGISTERS this metadata —
 * it does NOT dispatch on it (dispatch is V4.0's Event Bus/Router).
 */

/**
 * An event type/pattern the agent can respond to. `event` names align with
 * V4.0 C1 (e.g. `im.mention`, `ci.failure`, `code.changed`) but are kept as an
 * open string so new event kinds don't require a schema change. `match` is an
 * optional set of forward-compatible conditions (declaration only in V3.8.1).
 */
export const Trigger = Schema.Struct({
  event: Schema.String,
  match: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type Trigger = Schema.Schema.Type<typeof Trigger>

/**
 * Highest autonomy level the agent is allowed to run at. Literals align 1:1
 * with V4.0 C1/D. Default (when unset) is `level_0` — fully manual / all
 * actions require confirmation — the conservative choice.
 */
export const AutonomyLevel = Schema.Literals(["level_0", "level_1", "level_2", "level_3", "level_4", "level_5"])
export type AutonomyLevel = Schema.Schema.Type<typeof AutonomyLevel>
export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = "level_0"

/**
 * Resource & safety ceilings for an agent. Per the standing constraint
 * ("速率/长度类字段不要限制的太死"), every field is an OPTIONAL, CONFIGURABLE
 * ceiling whose default is LENIENT / UNLIMITED — an unset field means "no limit
 * imposed by the registry". Deployments tighten these as needed; nothing here
 * bakes in a restrictive number.
 *
 *   maxConcurrency    — unset ⇒ unlimited concurrent turns
 *   maxTokensPerTurn  — unset ⇒ no per-turn token budget
 *   maxTurnDurationMs — unset ⇒ no per-turn time budget
 *   maxFilesChanged   — unset ⇒ no per-subtask file-scope ceiling (§C1 max_files_changed)
 *   maxTokensPerHour  — unset ⇒ no per-agent-per-hour LLM token budget (§E2 token budget)
 *   writablePaths     — unset ⇒ no extra path restriction (kernel permissions apply)
 *   toolWhitelist     — unset ⇒ all tools allowed (kernel permissions apply)
 */
export const AgentLimits = Schema.Struct({
  maxConcurrency: Schema.optional(Schema.Int),
  maxTokensPerTurn: Schema.optional(Schema.Int),
  maxTurnDurationMs: Schema.optional(Schema.Int),
  // §C1 max_files_changed — the maximum number of files a single subtask may write. A subtask whose
  // declared fileScope exceeds this is BLOCKED (terminal) — the partition won't shrink on retry, so
  // blocking (not deferring) is the honest outcome. Unset ⇒ no ceiling.
  maxFilesChanged: Schema.optional(Schema.Int),
  // §E2 max_tokens_per_hour — a per-agent-per-hour LLM token budget. Enforced where real token usage is
  // available (the multi-agent runtime debits the runner's reported tokensUsed against a per-agent
  // fixed-window counter; a subtask that would run with the agent already over budget is deferred).
  // Unset ⇒ no budget. NOTE: event-driven turns currently report tokensUsed:0 (usage not yet threaded
  // through the event turn runner), so this budget only bites for runners that DO report usage.
  maxTokensPerHour: Schema.optional(Schema.Int),
  // mutable arrays: this schema flows into the deep-merged Config.Info agent map (config.ts
  // mergeDeep), whose target type has mutable arrays; a readonly decode would be unassignable.
  // Mutable is a safe superset — assignable to any readonly consumer.
  writablePaths: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  toolWhitelist: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
})
export type AgentLimits = Schema.Schema.Type<typeof AgentLimits>

/**
 * Agent descriptor for IM system — the canonical shape. `repository.ts` and the
 * HTTP `AgentDescriptorResponse` re-export this; the frontend mirror lives in
 * `packages/app/src/components/im/types.ts`. Legacy fields (id/name/displayName/
 * description/visible) are unchanged; the block below is the V3.8.1 metadata,
 * all optional and backward-compatible.
 */
export const AgentDescriptor = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  displayName: Schema.String,
  description: Schema.optional(Schema.String),
  visible: Schema.Boolean,
  // --- V3.8.1 §C.3 optional metadata ---
  triggers: Schema.optional(Schema.Array(Trigger)),
  capabilities: Schema.optional(Schema.Array(Schema.String)),
  autonomy: Schema.optional(AutonomyLevel),
  context_sources: Schema.optional(Schema.Array(Schema.String)),
  approval_required: Schema.optional(Schema.Boolean),
  limits: Schema.optional(AgentLimits),
})

export type AgentDescriptor = Schema.Schema.Type<typeof AgentDescriptor>
