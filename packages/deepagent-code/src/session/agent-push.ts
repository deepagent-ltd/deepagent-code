export * as AgentPush from "./agent-push"

import { Context, Effect, Layer } from "effect"
import { and, eq, gt, sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { AgentPushPolicy } from "@deepagent-code/core/deepagent/agent-push-policy"
import { AgentPushLogTable } from "@deepagent-code/core/im/push-log-sql"
import { MemberTable } from "@deepagent-code/core/im/sql"
import { IMRepository } from "@deepagent-code/core/im/repository"
import * as IMID from "@deepagent-code/core/im/id"
import { Identifier } from "@deepagent-code/core/util/identifier"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Log from "@deepagent-code/core/util/log"

// V4.0 §B2 — the Agent Push runtime. Resolves the facts the pure AgentPushPolicy (core) needs
// (group membership, this-window push count from im_agent_push_logs, quiet-hours), runs the policy, and
// on a deliver/digest outcome persists the (scrubbed) message + an audit row in im_agent_push_logs. A
// blocked push writes only the audit row. Gated by v4AgentPushEnabled — a disabled flag rejects before
// any lookup (the legacy path has no proactive push, so OFF = feature absent, fail-closed).
//
// LAYERING: `deepagent-code`. The DECISION is pure (core); this owns the IO (DB reads/writes + flag).

const log = Log.create({ service: "agent-push" })

export interface PushResult {
  readonly decision: AgentPushPolicy.PushDecision["type"] | "flag_disabled"
  readonly messageID?: string
  readonly reason?: string
}

export interface Interface {
  /**
   * Attempt a proactive agent push. Resolves facts → policy → persist. Returns what happened. Never
   * throws for a policy rejection (returns a `blocked`/`flag_disabled` result); only a DB failure errors.
   */
  readonly push: (
    request: AgentPushPolicy.AgentPushRequest,
    facts?: Partial<Pick<AgentPushPolicy.PushFacts, "withinQuietHours" | "hasWorkspacePushPermission" | "allowedLinkHosts" | "maxContentChars" | "pushLimitPerHour">>,
  ) => Effect.Effect<PushResult>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/AgentPush") {}

export interface LayerOptions {
  readonly now?: () => number
}

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const repo = yield* IMRepository
      const flags = yield* RuntimeFlags.Service
      const now = options?.now ?? Date.now

      const push: Interface["push"] = (request, factOverrides) =>
        Effect.gen(function* () {
          // fail-closed: the feature is OFF ⇒ no proactive push exists.
          if (!flags.v4AgentPushEnabled) return { decision: "flag_disabled" as const }

          const at = now()

          // §B2 去重 (idempotency): a re-attempt with the same key returns the ORIGINAL outcome and
          // never re-delivers. Checked FIRST (before any persist) so a retry can't double-send the
          // message. The unique index on idempotency_key is the storage backstop against a race.
          const prior = yield* db
            .select({ decision: AgentPushLogTable.decision, message_id: AgentPushLogTable.message_id })
            .from(AgentPushLogTable)
            .where(eq(AgentPushLogTable.idempotency_key, request.idempotencyKey))
            .get()
            .pipe(Effect.orDie)
          if (prior) {
            const code = prior.decision.startsWith("blocked:") ? "blocked" : (prior.decision as PushResult["decision"])
            return {
              decision: code,
              ...(prior.message_id != null ? { messageID: prior.message_id } : {}),
              ...(prior.decision.startsWith("blocked:") ? { reason: prior.decision.slice("blocked:".length) } : {}),
            }
          }

          // NOTE (§B2 越权文件路径 — DEFERRED): the spec also requires stripping unauthorized file paths
          // from push content against the workspace FS ACL. ContentSafety.scrub does secrets/links/
          // truncation/injection but NOT path ACLs (that needs an FS-permission resolver). Until that
          // resolver lands, callers should pre-scrub paths; tracked as a follow-up, not silently done here.

          // §B2 权限 + 限流 facts, then decision, then persist — all inside ONE immediate transaction so
          // the rate-count read, message write, and audit write can't interleave with a concurrent push
          // (fixes the read-then-insert TOCTOU + the delivered-but-unaudited window).
          const outcome = yield* db
            .transaction(
              () =>
                Effect.gen(function* () {
                  // §B2 权限: is the agent a member of the target group?
                  const memberRow = yield* db
                    .select({ memberID: MemberTable.member_id })
                    .from(MemberTable)
                    .where(
                      and(
                        eq(MemberTable.group_id, request.groupID as IMID.GroupID),
                        eq(MemberTable.member_id, request.agentID),
                        eq(MemberTable.member_type, "agent"),
                      ),
                    )
                    .get()
                    .pipe(Effect.orDie)

                  // §B2 限流: delivered-or-digested pushes by this (agent, group) in the trailing window.
                  const windowStart = at - AgentPushPolicy.PUSH_WINDOW_MS
                  const countRow = yield* db
                    .select({ n: sql<number>`count(*)` })
                    .from(AgentPushLogTable)
                    .where(
                      and(
                        eq(AgentPushLogTable.agent_id, request.agentID),
                        eq(AgentPushLogTable.group_id, request.groupID as IMID.GroupID),
                        gt(AgentPushLogTable.created_at, windowStart),
                        // blocked pushes are stored as "blocked:<reason>" (never bare "blocked"), so
                        // exclude the whole family — only delivered/digested pushes consume rate quota.
                        sql`${AgentPushLogTable.decision} not like 'blocked:%'`,
                      ),
                    )
                    .get()
                    .pipe(Effect.orDie)

                  const facts: AgentPushPolicy.PushFacts = {
                    isGroupMember: memberRow != null,
                    hasWorkspacePushPermission: factOverrides?.hasWorkspacePushPermission ?? false,
                    pushesThisWindow: countRow?.n ?? 0,
                    withinQuietHours: factOverrides?.withinQuietHours ?? false,
                    ...(factOverrides?.pushLimitPerHour != null ? { pushLimitPerHour: factOverrides.pushLimitPerHour } : {}),
                    ...(factOverrides?.allowedLinkHosts != null ? { allowedLinkHosts: factOverrides.allowedLinkHosts } : {}),
                    ...(factOverrides?.maxContentChars != null ? { maxContentChars: factOverrides.maxContentChars } : {}),
                  }

                  const decision = AgentPushPolicy.decide(request, facts)

                  // persist the message ONLY on deliver.
                  let messageID: string | undefined
                  if (decision.type === "deliver") {
                    const msg = yield* repo
                      .createMessage({
                        groupID: request.groupID,
                        senderID: request.agentID,
                        senderType: "agent",
                        type: "text",
                        content: decision.content,
                      })
                      .pipe(Effect.orDie)
                    messageID = msg.id
                    if (decision.promptInjectionSuspected)
                      log.warn("agent push flagged for prompt-injection", { agentID: request.agentID, groupID: request.groupID })
                  }

                  // §B2 audit + digest source: one row per attempt. `content` is retained for deliver +
                  // digest (so the digest builder has a source) and null for blocked. The unique key
                  // makes a concurrent duplicate fail the insert → transaction rolls back → no double send.
                  const decisionCode = decision.type === "blocked" ? `blocked:${decision.reason}` : decision.type
                  const keepContent = decision.type === "deliver" || decision.type === "digest"
                  yield* db
                    .insert(AgentPushLogTable)
                    .values([
                      {
                        id: "push_" + Identifier.ascending(),
                        workspace_id: request.workspaceID,
                        group_id: request.groupID as IMID.GroupID,
                        agent_id: request.agentID,
                        reason: request.reason,
                        priority: request.priority,
                        decision: decisionCode,
                        idempotency_key: request.idempotencyKey,
                        message_id: (messageID as IMID.MessageID | undefined) ?? null,
                        content: keepContent && "content" in decision ? decision.content : null,
                        created_at: at,
                      },
                    ])
                    .run()
                    .pipe(Effect.orDie)

                  return {
                    decision: decision.type,
                    ...(messageID != null ? { messageID } : {}),
                    ...(decision.type === "blocked" ? { reason: decision.reason } : {}),
                  } satisfies PushResult
                }),
              { behavior: "immediate" },
            )
            .pipe(Effect.orDie)

          return outcome
        })

      return Service.of({ push })
    }),
  )

export const layer = layerWith()
