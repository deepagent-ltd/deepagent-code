export * as IMAgentExecution from "./im-agent-execution"

import { Effect, Option } from "effect"
import { contentDigest } from "@deepagent-code/core/contract/digest"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import type { LocalOperatorSchema } from "@deepagent-code/core/im/local-operator.schema"
import type { IMRepositoryInterface, IMMentionIntent } from "@deepagent-code/core/im/repository"
import type { AgentListProvider } from "@deepagent-code/core/im/agent-list-provider"
import type { IMBroadcaster } from "@deepagent-code/core/im/websocket"

/** The same explicit opt-in used by the kernel responder also gates local IM admission. */
export const responderEnabled = () => false

// Historical identifiers and metadata remain readable. Mention messages no
// longer constitute permission to run the owner's DAC.

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

/** Retired API shape for historical fixtures; no admission or wake is performed. */
export const admitMention = (_session: SessionV2.Interface, _input: MentionAdmissionInput): Effect.Effect<{
  sessionID: SessionV2.ID
  admitted: Effect.Success<ReturnType<SessionV2.Interface["prompt"]>>
}, LocalOperatorSchema.Error | Effect.Error<ReturnType<SessionV2.Interface["prompt"]>>> => LocalOperator.failure("LOCAL_TASK_EXECUTION_UNAVAILABLE", "Automatic IM execution is retired; use the owner's private /dac command")

export const reconcileMentions = (_deps: {
  readonly repo: IMRepositoryInterface; readonly v2Session: SessionV2.Interface; readonly agents: AgentListProvider
  readonly broadcaster: IMBroadcaster; readonly origin: "local" | "kernel_live"; readonly receiverID?: string
  readonly authorize?: (intent: IMMentionIntent) => Effect.Effect<void, unknown>
}) => LocalOperator.failure("LOCAL_TASK_EXECUTION_UNAVAILABLE", "Automatic IM execution is retired")
