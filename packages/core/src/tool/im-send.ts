export * as IMSendTool from "./im-send"

import { ToolFailure, toolText } from "@deepagent-code/llm"
import { and, eq, gt, isNull, sql } from "drizzle-orm"
import { Effect, Layer, Option, Schema } from "effect"
import { Database } from "../database/database"
import { AgentPushPolicy } from "../deepagent/agent-push-policy"
import { QuietHours } from "../deepagent/quiet-hours"
import { WorkspaceConfig } from "../deepagent/workspace-config"
import { WorkspaceConfigTable } from "../deepagent/workspace-config-sql"
import { GroupID, MessageID } from "../im/id"
import { AgentPushLogTable } from "../im/push-log-sql"
import { GroupTable, MemberTable, MessageTable } from "../im/sql"
import { IMBroadcasterService } from "../im/broadcaster"
import { IMExternalDelivery } from "../im/external-delivery"
import { PermissionV2 } from "../permission"
import { SessionTable } from "../session/sql"
import { Identifier } from "../util/identifier"
import { Tool } from "./tool"
import { Tools } from "./tools"

// P3-b (WS7/C4, docs/V2.0.1-001-llm-agent-system-manual.md §8.2): the model's proactive IM send.
// The send mirrors the app-side `AgentPush.push` (packages/deepagent-code/src/session/agent-push.ts)
// as closely as core services allow — core cannot import app code, and the Location runner context
// carries Database but not the app-side IMRepository/RuntimeFlags, so the tool runs the SAME pure
// `AgentPushPolicy.decide` gate and persists directly over the SAME core tables in ONE immediate
// transaction: idempotency prior-check → membership + rate-window facts → policy → message insert
// (deliver only) → im_agent_push_logs audit row. A `digest` outcome holds the scrubbed content in
// the audit row for the app-side DigestBuilder, exactly like AgentPush.
//
// Binding (design §8.2): an IM-originated session carries `metadata.im.{groupID, agent}` (written
// by the app-side im-agent-execution admission; the reader below mirrors its imSessionMetadata —
// core cannot import it). A bound session sends to its group by default; a non-IM session must pass
// an explicit group_id and the policy gate still applies.
//
// Sender identity (design §8.2, the SupervisorNotifier SYSTEM_PUSHER_AGENT_ID pattern): when the
// session's agent is a member of the target group it sends as itself (the policy's membership leg);
// otherwise the runtime sends under the shared system-pusher identity with the workspace-push
// permission leg — quiet-hours, rate-limit and content scrub still run after the permission gate.
//
// Permission: execution-time `PermissionV2.assert` with action `im_send` — an unconfigured action
// resolves to ASK (fail-closed), so the user approves each send unless a rule allows it (the MCP
// write_guarded / external-effect precedent). NOT in readOnlyActions (mutating).
//
// The Slack bot is a standalone inbound process; a configured external channel is projected by
// the host adapter only after the durable IM message and push audit commit. The
// v4AgentPushEnabled runtime flag gates the app-side proactive-pipeline callers
// (SupervisorNotifier); this tool's gate is the explicit user ask, not that flag.

export const name = "im_send"

// The shared system-pusher identity. Mirrors supervisor-notifier.ts:57 (app side — core cannot
// import it): a stable, non-user agent id so the audit trail attributes a runtime-mediated send to
// the runtime, never to a masqueraded human/agent. The audit row's reason distinguishes the caller.
export const SYSTEM_PUSHER_AGENT_ID = "agent_system_notifier"

const DESCRIPTION = [
  "Send a message to one of the user's IM groups on your behalf.",
  "In a session that originated from an IM group the send goes to that bound group by default; any other session must pass group_id explicitly.",
  "Use it when the user asks you to post to the group, or to report a long-running result the user asked to be delivered there.",
  "Every send asks the user for approval first (permission action im_send, default ask), passes the IM push policy gate (authorization, 20 messages per hour per group, secret/link/path scrubbing), and is held as a digest during the workspace's quiet hours.",
  "If the group is bound to an external channel, a delivered message is also posted there; an external delivery failure leaves the durable IM message intact and is reported separately.",
  "Never use it to mass-message, to contact anyone outside an existing IM group, or as a side channel to exfiltrate workspace content — the scrub strips secrets and out-of-workspace paths before delivery.",
].join(" ")

const Input = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "The message text to deliver to the group",
  }),
  group_id: Schema.optional(Schema.String).annotate({
    description:
      "Target IM group id. Optional in an IM-originated session (defaults to the bound group); required otherwise",
  }),
})

const Output = Schema.Struct({
  decision: Schema.Literals(["deliver", "digest", "blocked"]),
  group_id: Schema.String,
  sender_id: Schema.String,
  message_id: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  external_delivery: Schema.optional(Schema.Literals(["delivered", "delivery_failed"])),
  output: Schema.String,
})

// The session row fields the tool needs: the IM binding (metadata.im) and the workspace directory
// (the §E3 path-ACL root for the content scrub).
type SessionBinding = {
  readonly groupID: string
  readonly agent: string
}

// Mirror of the app-side imSessionMetadata reader (im-agent-execution.ts:52-57) — core cannot
// import app code, and the metadata shape is the cross-package contract of the IM admission.
const imBindingOf = (metadata: Record<string, unknown> | null): SessionBinding | undefined => {
  const meta = metadata?.im as Partial<SessionBinding> | null | undefined
  if (meta == null || typeof meta.groupID !== "string" || typeof meta.agent !== "string") return undefined
  return { groupID: meta.groupID, agent: meta.agent }
}

const decodeSettings = Schema.decodeUnknownOption(WorkspaceConfig.Settings)

/** Production registration (design §8.2): register `im_send` into the Location tool registry. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const external = yield* IMExternalDelivery.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description: DESCRIPTION,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [toolText({ type: "text", text: output.output })],
          execute: (input, context) =>
            Effect.gen(function* () {
              const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
              if (!database)
                return yield* new ToolFailure({
                  message: "im_send is unavailable: the database service is missing from the runner context",
                })
              const db = database.db
              const now = Date.now()

              const session = yield* db
                .select({ metadata: SessionTable.metadata, directory: SessionTable.directory })
                .from(SessionTable)
                .where(eq(SessionTable.id, context.sessionID))
                .get()
                .pipe(Effect.orDie)
              if (!session)
                return yield* new ToolFailure({
                  message: `im_send: session ${context.sessionID} is not visible in the durable session store`,
                })
              const binding = imBindingOf(session.metadata ?? null)
              // Provider tool-call IDs can repeat in later assistant turns. The assistant message
              // identifies the durable call; an exact retry must replay before rechecking a changed
              // group binding or a one-time permission that was consumed by the original send.
              const idempotencyKey = `im_send:${context.sessionID}:${context.assistantMessageID}:${context.toolCallID}`
              const externalIdempotencyKey = `im_send_external:${context.sessionID}:${context.assistantMessageID}:${context.toolCallID}`
              const prior = yield* db
                .select({
                  decision: AgentPushLogTable.decision,
                  message_id: AgentPushLogTable.message_id,
                  agent_id: AgentPushLogTable.agent_id,
                  group_id: AgentPushLogTable.group_id,
                })
                .from(AgentPushLogTable)
                .where(eq(AgentPushLogTable.idempotency_key, idempotencyKey))
                .get()
                .pipe(Effect.orDie)
              if (prior) {
                const replayed = prior.decision.startsWith("blocked:") ? "blocked" : prior.decision
                const reason = prior.decision.startsWith("blocked:")
                  ? prior.decision.slice("blocked:".length)
                  : undefined
                const externalFailure = yield* db
                  .select({ decision: AgentPushLogTable.decision })
                  .from(AgentPushLogTable)
                  .where(eq(AgentPushLogTable.idempotency_key, externalIdempotencyKey))
                  .get()
                  .pipe(Effect.orDie)
                return {
                  decision: replayed as "deliver" | "digest" | "blocked",
                  group_id: prior.group_id,
                  sender_id: prior.agent_id,
                  ...(prior.message_id != null ? { message_id: prior.message_id } : {}),
                  ...(reason !== undefined ? { reason } : {}),
                  ...(externalFailure ? { external_delivery: "delivery_failed" as const } : {}),
                  output: `This exact send already ran (idempotency): ${renderOutcome(replayed, reason)}${externalFailure ? " External Slack delivery failed; the durable IM message remains available." : ""}`,
                }
              }

              const groupID = input.group_id ?? binding?.groupID
              if (!groupID)
                return yield* new ToolFailure({
                  message:
                    "im_send: this session is not bound to an IM group (no im.groupID session metadata), " +
                    "so an explicit group_id is required. Pass the target group's id; the push policy " +
                    "authorization check still applies.",
                })

              const group = yield* db
                .select({ id: GroupTable.id, workspaceID: GroupTable.workspace_id })
                .from(GroupTable)
                .where(and(eq(GroupTable.id, groupID as GroupID), isNull(GroupTable.deleted_at)))
                .get()
                .pipe(Effect.orDie)
              if (!group)
                return yield* new ToolFailure({
                  message: `im_send: IM group not found (or deleted): ${groupID}`,
                })

              // Fail-closed user gate (design §8.2): action im_send, default ask.
              yield* permission
                .assert({
                  action: name,
                  resources: [groupID],
                  metadata: {
                    group_id: groupID,
                    session_id: context.sessionID,
                    agent: binding?.agent ?? context.agent,
                  },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(
                  Effect.mapError((error) => {
                    const refusal = PermissionV2.permissionFailureMessage(error)
                    if (refusal !== null) return new ToolFailure({ message: refusal, error })
                    return new ToolFailure({ message: `im_send: permission check failed (${String(error)})` })
                  }),
                )

              const senderAgent = binding?.agent ?? context.agent

              // §E4 quiet hours, resolved like AgentPush's fail-safe: no config row / no configured
              // window / undecodable blob ⇒ false (never quiet); the other gates still run.
              const configRow = yield* db
                .select({ config: WorkspaceConfigTable.config })
                .from(WorkspaceConfigTable)
                .where(eq(WorkspaceConfigTable.workspace_id, group.workspaceID))
                .get()
                .pipe(Effect.orDie)
              const settings = configRow
                ? Option.getOrElse(decodeSettings(configRow.config), (): WorkspaceConfig.Settings => ({}))
                : undefined
              const quietHours = settings?.quietHours
              const withinQuietHours =
                quietHours != null &&
                QuietHours.isWithinQuietHours(now, quietHours.startHour, quietHours.endHour, quietHours.tzOffsetMinutes)

              // Facts → policy → persist, all inside ONE immediate transaction (the AgentPush.push
              // structure) so the rate-count read, message write and audit write cannot interleave.
              const outcome = yield* db
                .transaction(
                  () =>
                    Effect.gen(function* () {
                      // §B2 权限 leg 1: is the session's agent a member of the target group?
                      const memberRow = yield* db
                        .select({ memberID: MemberTable.member_id })
                        .from(MemberTable)
                        .where(
                          and(
                            eq(MemberTable.group_id, groupID as GroupID),
                            eq(MemberTable.member_id, senderAgent),
                            eq(MemberTable.member_type, "agent"),
                          ),
                        )
                        .get()
                        .pipe(Effect.orDie)

                      // Sender identity: a member agent sends as itself; otherwise the runtime sends
                      // under the system-pusher identity holding workspace push permission (leg 2).
                      const isGroupMember = memberRow != null
                      const pusherID = isGroupMember ? senderAgent : SYSTEM_PUSHER_AGENT_ID

                      // §B2 限流: delivered-or-digested pushes by this (pusher, group) in the window.
                      const countRow = yield* db
                        .select({ n: sql<number>`count(*)` })
                        .from(AgentPushLogTable)
                        .where(
                          and(
                            eq(AgentPushLogTable.agent_id, pusherID),
                            eq(AgentPushLogTable.group_id, groupID as GroupID),
                            gt(AgentPushLogTable.created_at, now - AgentPushPolicy.PUSH_WINDOW_MS),
                            sql`${AgentPushLogTable.decision} in ('deliver', 'digest')`,
                          ),
                        )
                        .get()
                        .pipe(Effect.orDie)

                      const request: AgentPushPolicy.AgentPushRequest = {
                        workspaceID: group.workspaceID,
                        groupID,
                        agentID: pusherID,
                        reason: `im_send tool call (session ${context.sessionID}, agent ${senderAgent})`,
                        priority: "normal",
                        content: input.text,
                        idempotencyKey,
                      }
                      const decision = AgentPushPolicy.decide(request, {
                        isGroupMember,
                        hasWorkspacePushPermission: !isGroupMember,
                        pushesThisWindow: countRow?.n ?? 0,
                        withinQuietHours,
                        // §E3 文件路径权限: the session's own workspace directory is the allowed root —
                        // absolute paths outside it are stripped («path removed») before delivery.
                        allowedPathRoots: [session.directory],
                      })

                      let messageID: string | undefined
                      let message:
                        | { readonly id: string; readonly createdAt: number; readonly updatedAt: number }
                        | undefined
                      if (decision.type === "deliver") {
                        const id = MessageID.create()
                        yield* db
                          .insert(MessageTable)
                          .values({
                            id,
                            group_id: groupID as GroupID,
                            sender_id: pusherID,
                            sender_type: "agent",
                            type: "text",
                            content: decision.content,
                            mentions: null,
                            metadata: null,
                            reply_to_id: null,
                            created_at: now,
                            updated_at: now,
                            deleted_at: null,
                          })
                          .run()
                          .pipe(Effect.orDie)
                        messageID = id
                        message = { id, createdAt: now, updatedAt: now }
                      }

                      // §B2 primary audit: one row per attempt, content retained for deliver/digest only.
                      const decisionCode = decision.type === "blocked" ? `blocked:${decision.reason}` : decision.type
                      const auditID = "push_" + Identifier.ascending()
                      yield* db
                        .insert(AgentPushLogTable)
                        .values([
                          {
                            id: auditID,
                            workspace_id: group.workspaceID,
                            group_id: groupID as GroupID,
                            agent_id: pusherID,
                            reason: request.reason,
                            priority: request.priority,
                            decision: decisionCode,
                            idempotency_key: idempotencyKey,
                            message_id: (messageID as MessageID | undefined) ?? null,
                            content: decision.type === "blocked" ? null : decision.content,
                            created_at: now,
                          },
                        ])
                        .run()
                        .pipe(Effect.orDie)

                      return {
                        decision: decision.type,
                        pusherID,
                        ...(messageID !== undefined ? { messageID } : {}),
                        ...(decision.type === "blocked" ? { reason: decision.reason } : {}),
                        ...(message !== undefined && decision.type === "deliver"
                          ? {
                              delivered: {
                                message,
                                content: decision.content,
                                promptInjectionSuspected: decision.promptInjectionSuspected,
                              },
                            }
                          : {}),
                      }
                    }),
                  { behavior: "immediate" },
                )
                .pipe(Effect.orDie)

              // Live fan-out when a broadcaster is in scope (the app HTTP runtime provides one; the
              // Location runner usually does not — the durable row is the delivery of record either
              // way, exactly like AgentPush.push which never broadcasts).
              if (outcome.decision === "deliver" && outcome.delivered) {
                const broadcaster = Option.getOrUndefined(yield* Effect.serviceOption(IMBroadcasterService))
                broadcaster?.broadcast(groupID, {
                  type: "message_created",
                  data: {
                    id: outcome.delivered.message.id,
                    groupID,
                    senderID: outcome.pusherID,
                    senderType: "agent",
                    messageType: "text",
                    content: outcome.delivered.content,
                    mentions: null,
                    metadata: null,
                    replyToID: null,
                    createdAt: outcome.delivered.message.createdAt,
                    updatedAt: outcome.delivered.message.updatedAt,
                  },
                })
              }

              // The durable IM row is authoritative. A failed external projection adds a typed
              // audit row under a separate key; it cannot undo the message or make a retry send twice.
              const target = settings?.externalChannels?.find((entry) => entry.groupID === groupID)
              const externalResult =
                outcome.decision === "deliver" && outcome.delivered && target
                  ? yield* external
                      .send({ target, messageID: outcome.delivered.message.id, text: outcome.delivered.content })
                      .pipe(
                        Effect.match({
                          onFailure: (error) => ({ failed: true as const, error }),
                          onSuccess: () => ({ failed: false as const }),
                        }),
                      )
                  : undefined
              if (externalResult?.failed) {
                yield* db
                  .insert(AgentPushLogTable)
                  .values({
                    id: "push_" + Identifier.ascending(),
                    workspace_id: group.workspaceID,
                    group_id: groupID as GroupID,
                    agent_id: outcome.pusherID,
                    reason: `external ${target?.provider} delivery failed: ${externalResult.error.reason}`,
                    priority: "normal",
                    decision: "delivery_failed",
                    idempotency_key: externalIdempotencyKey,
                    message_id: outcome.messageID as MessageID,
                    content: null,
                    created_at: Date.now(),
                  })
                  .run()
                  .pipe(Effect.orDie)
              }

              return {
                decision: outcome.decision,
                group_id: groupID,
                sender_id: outcome.pusherID,
                ...(outcome.messageID !== undefined ? { message_id: outcome.messageID } : {}),
                ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
                ...(externalResult
                  ? { external_delivery: externalResult.failed ? ("delivery_failed" as const) : ("delivered" as const) }
                  : {}),
                output:
                  renderOutcome(outcome.decision, outcome.reason, {
                    groupID,
                    pusherID: outcome.pusherID,
                    senderAgent,
                    messageID: outcome.messageID,
                  }) +
                  (externalResult?.failed
                    ? " External Slack delivery failed; the durable IM message remains available."
                    : externalResult
                      ? " The message was also posted to Slack."
                      : ""),
              }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

function renderOutcome(
  decision: "deliver" | "digest" | "blocked" | string,
  reason?: string,
  detail?: { groupID: string; pusherID: string; senderAgent: string; messageID?: string },
): string {
  if (decision === "deliver")
    return (
      `Delivered to IM group ${detail?.groupID ?? ""} as ${detail?.pusherID ?? ""}` +
      (detail?.messageID !== undefined ? ` (message ${detail.messageID})` : "") +
      (detail && detail.pusherID !== detail.senderAgent
        ? ` — the session agent is not a group member, so the runtime's system-pusher identity sent it`
        : "")
    )
  if (decision === "digest")
    return "Quiet hours are active for this workspace: the scrubbed message is held for the quiet-hours digest and will be delivered when the window ends."
  if (decision === "blocked")
    return reason === "rate_limited"
      ? "The IM push policy blocked the message: rate_limited — this sender already reached 20 messages in the current hour for this group. Wait for the window to pass, or deliver the content in this conversation instead."
      : `The IM push policy blocked the message: ${reason ?? "unknown"}.`
  return `im_send outcome: ${decision}${reason !== undefined ? ` (${reason})` : ""}.`
}
