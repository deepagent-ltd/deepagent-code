export * as GitHubAgentExecution from "./github-agent-execution"

import { Effect, Option } from "effect"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Location } from "@deepagent-code/core/location"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { contentDigest } from "@deepagent-code/core/contract/digest"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import type { Prompt } from "@deepagent-code/core/session/prompt"

// v2w-j4 durable-only GitHub ingress (mirrors src/im/im-agent-execution.ts). The legacy GitHub Action
// path (a FRESH V1 Session per run through Session.Service.create + one SessionPrompt.prompt per chat
// turn) is deleted; this module is its durable V2-native replacement:
//
//   GitHub event delivery (issue/PR comment, issues/PR action, schedule/workflow_dispatch run)
//     → ONE durable SessionV2 admission into the STABLE session for (GitHub lane, target agent) — the
//       durable execution record is the `session_input` row itself, keyed by the deterministic prompt
//       message id for (GitHub delivery identity, agent, turn).
//     → a follow-up comment on the same issue/PR lane ADOPTS the same session and steers the active
//       activity (delivery "steer" — coalesces at the next safe provider-turn boundary).
//     → terminal evidence is the session's own durable state: the settled activity's newest assistant
//       message (text or error), read back through SessionV2's projected history. The GitHub comment /
//       PR delivery stays in the one-shot action process — a crashed run fails visibly on GitHub and a
//       re-run of the SAME event reconciles as an exact retry (the delivery side replays, the agent
//       work never duplicates).
//
// IDENTITY: the session id is derived from (laneID, agent) — the lane is the conversation the event
// belongs to (`owner/repo#<number>` for issue/PR events, the workflow run id for repo events) — so
// reusing a conversation reuses the session (SessionV2 adoption semantics). The prompt message id is
// derived from (deliveryID, agent, turn) so a duplicate delivery of the same GitHub event (action
// re-run, redelivered webhook, mock re-run) reconciles as an exact retry at SessionV2 — exactly one
// `session_input` row per (delivery, turn), never two.
//
// EXACT-RETRY HONESTY: the prompt must be byte-stable across deliveries of the same event identity.
// The trigger comment body and its attachments are stable per delivery; the appended live issue/PR
// context snapshot is not (new comments/reviews change it). A re-delivery with changed context under
// the same delivery id therefore fails typed (PromptConflictError) instead of silently mutating work —
// the operator sees the failed run, exactly the V2 reconcile contract.

/** Stable V2 session identity for one (GitHub lane, agent) conversation lane. */
export const githubSessionIDFor = (laneID: string, agent: string) =>
  SessionV2.ID.make(`ses_gh_${contentDigest(`${laneID}:${agent}`).slice(0, 24)}`)

/** Deterministic prompt message id for one (GitHub delivery, agent, turn) — the idempotency key. */
export const githubPromptIDFor = (deliveryID: string, agent: string, turn: string) =>
  SessionMessage.ID.make(`msg_${contentDigest(`gh:${deliveryID}:${agent}:${turn}`).slice(0, 40)}`)

/** The metadata binding this session carries (lane + agent — read back for reconciliation/debugging). */
export interface GitHubSessionMetadata {
  readonly laneID: string
  readonly agent: string
}

/** Read the GitHub binding off a session's metadata; non-GitHub sessions resolve to undefined. */
export const githubSessionMetadata = (info: SessionV2.Info): GitHubSessionMetadata | undefined => {
  const meta = info.metadata?.github as Partial<GitHubSessionMetadata> | null | undefined
  if (meta == null || typeof meta.laneID !== "string" || typeof meta.agent !== "string") return undefined
  return { laneID: meta.laneID, agent: meta.agent }
}

export interface GitHubTurnInput {
  /** The conversation lane the event belongs to (issue/PR lane, or the workflow run for repo events). */
  readonly laneID: string
  /** The GitHub event delivery identity — the durable execution record's foreign key. */
  readonly deliveryID: string
  /** Discriminates turns of one delivery (the work turn, the title summary, the actions summary). */
  readonly turn: string
  /** The resolved target agent name (the routed instance's default agent). */
  readonly agent: string
  readonly title: string
  /** The routed instance directory — the Location the session's work runs in. */
  readonly directory: string
  readonly prompt: Prompt
  /** The model the event's turns run on (provider default when omitted). */
  readonly model?: SessionV2.Info["model"]
}

/**
 * Perform the ONE durable V2 admission for one GitHub event turn. Idempotent by construction: the
 * same (deliveryID, agent, turn) re-admits as an exact-retry no-op (SessionV2 reconcile); a changed
 * prompt under the same id fails typed (PromptConflictError) instead of silently mutating work.
 *
 * Execution is decoupled from admission exactly as the V2 core prescribes: `prompt` admits the
 * durable `session_input` row and schedules the advisory `SessionExecution.wake`; the serialized
 * runner promotes the input and runs the agent turns (the caller awaits via `SessionV2.wait`).
 */
export const admitTurn = (v2Session: SessionV2.Interface, input: GitHubTurnInput) =>
  Effect.gen(function* () {
    const sessionID = githubSessionIDFor(input.laneID, input.agent)
    // Get-or-create (adoption on reuse — the C5-12-DEV-01 pattern): follow-up comments on the same
    // lane adopt the stable conversation session; only the first delivery creates it.
    const existing = yield* v2Session.get(sessionID).pipe(Effect.option)
    if (Option.isNone(existing)) {
      yield* v2Session.create({
        id: sessionID,
        agent: AgentV2.ID.make(input.agent),
        title: input.title,
        metadata: { github: { laneID: input.laneID, agent: input.agent } },
        location: Location.Ref.make({ directory: AbsolutePath.make(input.directory) }),
        ...(input.model ? { model: input.model } : {}),
      })
    }
    const admitted = yield* v2Session.prompt({
      id: githubPromptIDFor(input.deliveryID, input.agent, input.turn),
      sessionID,
      prompt: input.prompt,
      // Steer by default: a follow-up delivery on the same lane coalesces into the active activity
      // at the next safe provider-turn boundary (AGENTS.md delivery vocabulary).
      delivery: "steer",
      resume: true,
    })
    return { sessionID, admitted }
  })

// ── Terminal evidence ────────────────────────────────────────────────────────────────────────────

/** The joined text parts of an assistant message, or undefined when it has none (tool-only turn). */
const assistantText = (message: SessionMessage.Message): string | undefined => {
  if (message.type !== "assistant") return undefined
  const text = message.content
    .filter((part): part is SessionMessage.AssistantText => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text.length > 0 ? text : undefined
}

export interface TerminalReply {
  /** The newest assistant message of the settled activity (the durable terminal evidence). */
  readonly messageID: string
  /** The joined text parts — undefined when the turn ended without text (tool-only) or in error. */
  readonly text?: string
  /** The terminal error the runner recorded on the assistant message, if any. */
  readonly error?: { readonly type: string; readonly message: string }
}

/**
 * Read the settled activity's terminal evidence: the newest assistant message (text or error), the
 * same projection the im reply collector reads. Undefined when the session has no assistant message
 * yet (nothing settled).
 */
export const terminalReply = (v2Session: SessionV2.Interface, sessionID: SessionV2.ID) =>
  Effect.gen(function* () {
    // Newest-first: the first assistant IS the terminal reply of the settled activity.
    const messages = yield* v2Session
      .messages({ sessionID, order: "desc", limit: 50 })
      .pipe(Effect.orElseSucceed(() => [] as const))
    const terminal = messages.find((message) => message.type === "assistant")
    if (!terminal || terminal.type !== "assistant") return undefined
    return {
      messageID: terminal.id,
      ...(assistantText(terminal) !== undefined ? { text: assistantText(terminal) } : {}),
      ...(terminal.error ? { error: terminal.error } : {}),
    } satisfies TerminalReply
  })
