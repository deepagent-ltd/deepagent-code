export * as IMAgentExecution from "./im-agent-execution"

import { Effect, Option } from "effect"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Location } from "@deepagent-code/core/location"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { contentDigest } from "@deepagent-code/core/contract/digest"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import type { IMRepositoryInterface, IMMentionIntent } from "@deepagent-code/core/im/repository"
import type { AgentListProvider } from "@deepagent-code/core/im/agent-list-provider"
import type { IMBroadcaster } from "@deepagent-code/core/im/websocket"
import { resolveMentioned } from "@deepagent-code/core/im/mention-parser"

/** The same explicit opt-in used by the kernel responder also gates local IM admission. */
export const responderEnabled = () => process.env.DEEPAGENT_IM_AGENT_RESPONDER === "on"

// V2 IM durable-only migration (design: DEEPAGENTCODE-2.0-DURABLE-MIGRATION handoff §5.3). The legacy
// IM path (ServerAgentExecutor → fresh V1 Session per turn → SessionPrompt.promptOrSteer) is deleted;
// this module is its durable V2-native replacement for the ADMISSION half of the slice:
//
//   IM message with @mentions
//     → (per mentioned agent) ONE durable SessionV2 admission into the STABLE session for
//       (group, agent) — the durable execution record is the `session_input` row itself, keyed by the
//       deterministic prompt message id for (IM message id, agent).
//     → follow-up mentions into the same (group, agent) ADOPT the same session and steer the active
//       activity (SessionInput delivery "steer" — coalesces at the next safe provider-turn boundary).
//     → the terminal assistant reply is delivered through the durable `im_reply_outbox`
//       (im-reply-outbox.ts), never a fire-and-forget publish.
//
// IDENTITY: the session id is derived from (groupID, agent) so reusing a conversation reuses the
// session — SessionV2 adoption semantics ("Reusing a Session ID adopts the existing Session"). The
// prompt message id is derived from (IM message id, agent) so a duplicate delivery of the same
// mention (client retry, redrive) reconciles as an exact retry at SessionV2 — exactly one
// `session_input` row per mention, never two (AGENTS.md "V2 Session Core": reusing a prompt message
// ID reconciles an exact retry when Session, prompt, and delivery mode match).
//
// The prompt text is a pure function of the persisted IM message (sender + content): it must be
// byte-stable across retries or the exact-retry equivalence check fails. Conversation context comes
// from the session's own projected history — the point of the stable per-(group, agent) session —
// never from a re-snapshotted recent-messages window (that was both the fresh-session defect and a
// retry-conflict hazard).

/** Stable V2 session identity for one (IM group, agent) conversation lane. */
export const imSessionIDFor = (groupID: string, agentID: string) =>
  SessionV2.ID.make(`ses_im_${contentDigest(`${groupID}:${agentID}`).slice(0, 24)}`)

/** Deterministic prompt message id for one (IM message, agent) mention — the idempotency key. */
export const imPromptIDFor = (messageID: string, agentID: string) =>
  SessionMessage.ID.make(`msg_${contentDigest(`im:${messageID}:${agentID}`).slice(0, 40)}`)

/** The metadata the reply collector reads back off the session (group + agent binding). */
export interface IMSessionMetadata {
  readonly groupID: string
  readonly agent: string
}

/** Read the IM binding off a session's metadata; non-IM sessions resolve to undefined. */
export const imSessionMetadata = (info: SessionV2.Info): IMSessionMetadata | undefined => {
  const meta = info.metadata?.im as Partial<IMSessionMetadata> | null | undefined
  if (meta == null || typeof meta.groupID !== "string" || typeof meta.agent !== "string") return undefined
  return { groupID: meta.groupID, agent: meta.agent }
}

/** The model-facing prompt text for one mention. Deterministic in the message — never re-derived
 * from mutable conversation state, so an exact retry presents byte-identical work. */
const promptTextFor = (input: MentionAdmissionInput) => `IM message from ${input.senderID}: ${input.content}`

export interface MentionAdmissionInput {
  /** The IM conversation (group) the message belongs to. */
  readonly groupID: string
  /** The persisted IM message id (the execution record's foreign identity). */
  readonly messageID: string
  /** The resolved, visible, mention-capable agent name (the admission target). */
  readonly agent: string
  /** The authenticated sender of the IM message. */
  readonly senderID: string
  /** The persisted message content (already contains the @mention). */
  readonly content: string
  /** The routed instance directory — the Location the session's work runs in. */
  readonly directory: string
}

/**
 * Perform the ONE durable V2 admission for a single mention. Idempotent by construction: the same
 * (messageID, agent, content) re-admits as an exact-retry no-op (SessionV2 reconcile), a changed
 * prompt under the same id fails typed (PromptConflictError) instead of silently mutating work.
 *
 * Execution is decoupled from admission exactly as the V2 core prescribes: `prompt` admits the
 * durable `session_input` row and schedules the advisory `SessionExecution.wake`; the serialized
 * runner promotes the input and runs the agent turns.
 */
export const admitMention = (v2Session: SessionV2.Interface, input: MentionAdmissionInput) =>
  Effect.gen(function* () {
    const sessionID = imSessionIDFor(input.groupID, input.agent)
    // Get-or-create (the C5-12-DEV-01 pattern from the v2 admission bridge): adoption on reuse.
    const existing = yield* v2Session.get(sessionID).pipe(Effect.option)
    if (Option.isNone(existing)) {
      yield* v2Session.create({
        id: sessionID,
        agent: AgentV2.ID.make(input.agent),
        title: `IM ${input.agent}`,
        metadata: { im: { groupID: input.groupID, agent: input.agent } },
        location: Location.Ref.make({ directory: AbsolutePath.make(input.directory) }),
      })
    }
    const admitted = yield* v2Session.prompt({
      id: imPromptIDFor(input.messageID, input.agent),
      sessionID,
      prompt: new Prompt({ text: promptTextFor(input) }),
      // Steer by default: a follow-up mention coalesces into the active activity at the next safe
      // provider-turn boundary (AGENTS.md delivery vocabulary).
      delivery: "steer",
      resume: true,
    })
    return { sessionID, admitted }
  })

/** Compensate only explicit live intents. Re-check current membership and Agent eligibility on
 * every attempt; the immutable source message and stable prompt identity are never reconstructed
 * from chat history. This is admission repair, not another execution loop. */
export const reconcileMentions = (deps: {
  readonly repo: IMRepositoryInterface
  readonly v2Session: SessionV2.Interface
  readonly agents: AgentListProvider
  readonly broadcaster: IMBroadcaster
  readonly origin: "local" | "kernel_live"
  readonly receiverID?: string
  readonly authorize?: (intent: IMMentionIntent) => Effect.Effect<void, unknown>
}) =>
  Effect.gen(function* () {
    if (deps.origin === "local" && !responderEnabled()) return
    const intents = yield* deps.repo.listPendingMentions({ origin: deps.origin, receiverID: deps.receiverID })
    for (const intent of intents) {
      yield* Effect.gen(function* () {
        if (deps.origin === "local" && !responderEnabled()) return
        if (deps.origin === "kernel_live") {
          if (!deps.authorize) return
          yield* deps.authorize(intent)
        }
        const group = yield* deps.repo.getGroup({ groupID: intent.message.groupID, userID: intent.user_id })
        if (!group) {
          yield* deps.repo.settleMention({ id: intent.id, status: "rejected", error: "group_access_revoked" })
          return
        }
        const agents = yield* deps.agents.listAgents({ workspaceID: intent.workspace_id, userID: intent.user_id })
        const target = resolveMentioned(agents, [intent.resolved_agent ?? intent.agent_name])[0]
        if (!target?.dispatchable || !target.agent) {
          const receipt = yield* deps.repo.createMessage({
            id: `imsg_receipt_${contentDigest(intent.id).slice(0, 40)}`,
            groupID: intent.message.groupID,
            senderID: "system",
            senderType: "system",
            type: "system",
            content: `@${intent.agent_name} was not executed: the Agent is unavailable or does not accept mentions.`,
            metadata: {
              type: "agent_no_trigger_mention",
              agentID: target?.agent?.id,
              agentNames: [intent.agent_name],
              messageID: intent.message_id,
            },
            replyToID: intent.message_id,
          })
          if (!receipt.replayed)
            deps.broadcaster.broadcast(receipt.groupID, {
              type: "message_created",
              data: { ...receipt, messageType: receipt.type },
            })
          yield* deps.repo.settleMention({ id: intent.id, status: "rejected", error: "agent_mention_not_allowed" })
          return
        }
        const bound = yield* deps.repo.bindMention({
          id: intent.id,
          agent: target.agent.name,
          sessionID: imSessionIDFor(intent.message.groupID, target.agent.name),
          inputID: imPromptIDFor(intent.message_id, target.agent.name),
        })
        if (!bound) return
        if (deps.origin === "local" && !responderEnabled()) return
        yield* admitMention(deps.v2Session, {
          groupID: bound.message.groupID,
          messageID: bound.message_id,
          agent: bound.resolved_agent!,
          senderID: bound.message.senderID,
          content: bound.message.content,
          directory: bound.directory,
        })
        yield* deps.repo.settleMention({ id: bound.id, status: "admitted" })
        deps.broadcaster.broadcast(bound.message.groupID, {
          type: "agent_status",
          data: { messageID: bound.message_id, agentID: target.agent.id, status: "started" },
        })
      }).pipe(
        Effect.catchCause(() =>
          deps.repo.settleMention({
            id: intent.id,
            status: "pending",
            error: "admission_unavailable_or_authorization_failed",
          }),
        ),
      )
    }
  })
