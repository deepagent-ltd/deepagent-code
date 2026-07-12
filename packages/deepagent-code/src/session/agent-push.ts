export * as AgentPush from "./agent-push"

import { Context, Effect, Layer, Option } from "effect"
import { and, eq, gt, sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { AgentPushPolicy } from "@deepagent-code/core/deepagent/agent-push-policy"
import { WorkspaceConfig } from "@deepagent-code/core/deepagent/workspace-config"
import { QuietHours } from "@deepagent-code/core/deepagent/quiet-hours"
import { AgentPushLogTable } from "@deepagent-code/core/im/push-log-sql"
import { MemberTable } from "@deepagent-code/core/im/sql"
import { IMRepository } from "@deepagent-code/core/im/repository"
import * as IMID from "@deepagent-code/core/im/id"
import { Identifier } from "@deepagent-code/core/util/identifier"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Log from "@deepagent-code/core/util/log"

// V4.0 §B2 — the Agent Push runtime. Resolves the facts the pure AgentPushPolicy (core) needs
// (group membership, this-window push count from im_agent_push_logs, the REAL quiet-hours window, and
// the workspace's allowed FS roots for the §E3 path ACL), runs the policy, and on a deliver/digest
// outcome persists the (scrubbed) message + an audit row in im_agent_push_logs. A blocked push writes
// only the audit row. Gated by v4AgentPushEnabled — a disabled flag rejects before any lookup (the
// legacy path has no proactive push, so OFF = feature absent, fail-closed).
//
// §E4 QUIET HOURS: resolved from WorkspaceConfig.get(workspaceID).quietHours + QuietHours.decide — NOT
// a hardcoded `false`. Fail-safe: a workspace with NO configured window is never quiet (false is
// correct there); but a CONFIGURED window is honored. `factOverrides.withinQuietHours` still wins so
// tests remain deterministic and a caller with its own tz logic can pass a resolved value.
//
// §E3 PATH ACL: scrub is called WITH `allowedPathRoots` resolved from the workspace's directory root, so
// a proactive push can never leak a file path OUTSIDE the workspace. Resolution (see
// `resolveAllowedPathRoots`) treats a directory-style workspaceID as its own root; a caller/test may
// override via `factOverrides.allowedPathRoots` or the layer's `allowedPathRootsFor` port.
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
    facts?: Partial<
      Pick<
        AgentPushPolicy.PushFacts,
        | "withinQuietHours"
        | "hasWorkspacePushPermission"
        | "allowedLinkHosts"
        | "maxContentChars"
        | "pushLimitPerHour"
        | "allowedPathRoots"
      >
    >,
  ) => Effect.Effect<PushResult>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/AgentPush") {}

export interface LayerOptions {
  readonly now?: () => number
  /**
   * §E3 — resolve the allowed FS roots for a workspace's push content path ACL. Injected so a test can
   * pin roots and production can swap in a richer project-roots resolver. Returns `undefined` to leave
   * the path leg OFF (no-op) for that workspace. Default: a directory-style workspaceID (not a "wrk"-id)
   * is its own single root; a bare "wrk_"-id resolves to no roots (nothing to contain against ⇒ leg off).
   */
  readonly allowedPathRootsFor?: (workspaceID: string) => ReadonlyArray<string> | undefined
}

// Default path-roots resolver: a directory-routed workspaceID (single-user / directory model — an
// absolute-ish path, NOT a "wrk_"-prefixed synthetic id) doubles as the workspace's FS root, so a push
// may reference paths INSIDE it but not outside (/etc/passwd, ~/.ssh, ../../secrets are stripped). A
// genuine "wrk_"-id is not a filesystem path, so there is nothing to contain against here ⇒ leave the
// leg off (undefined) rather than fabricate a bogus root that would strip every path.
const defaultAllowedPathRootsFor = (workspaceID: string): ReadonlyArray<string> | undefined =>
  workspaceID.length > 0 && !workspaceID.startsWith("wrk") ? [workspaceID] : undefined

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const repo = yield* IMRepository
      const flags = yield* RuntimeFlags.Service
      const now = options?.now ?? Date.now
      const allowedPathRootsFor = options?.allowedPathRootsFor ?? defaultAllowedPathRootsFor
      // §E4 — WorkspaceConfig is OPTIONAL so the AgentPush layer stays unit-testable with just Database +
      // IMRepository + Flags (the existing agent-push.test.ts provides no config layer). When present
      // (production + the digest-builder test graph both provide it), a CONFIGURED quiet-hours window is
      // resolved and honored; when absent, quiet-hours resolves to false (never quiet) — the same
      // fail-safe as a workspace with no window. A `factOverrides.withinQuietHours` always wins.
      const config = yield* Effect.serviceOption(WorkspaceConfig.Service)

      // §E4 — resolve whether `at` is inside the workspace's configured quiet-hours window. NO config
      // service or NO configured window ⇒ false (never quiet — the correct fail-safe). A lookup failure
      // is swallowed to false (fail-open on quiet-hours is safe: the always-on permission + rate + content
      // gates still run; treating a transient config error as "not quiet" just delivers instead of holding).
      const resolveWithinQuietHours = (workspaceID: string, at: number): Effect.Effect<boolean> =>
        Option.isNone(config)
          ? Effect.succeed(false)
          : config.value.get(workspaceID).pipe(
              Effect.map((resolved) =>
                resolved.quietHours != null
                  ? QuietHours.isWithinQuietHours(
                      at,
                      resolved.quietHours.startHour,
                      resolved.quietHours.endHour,
                      resolved.quietHours.tzOffsetMinutes,
                    )
                  : false,
              ),
              Effect.orElseSucceed(() => false),
            )

      const push: Interface["push"] = (request, factOverrides) =>
        Effect.gen(function* () {
          // fail-closed: the feature is OFF ⇒ no proactive push exists.
          if (!flags.v4AgentPushEnabled) return { decision: "flag_disabled" as const }

          const at = now()

          // §E4 — the REAL quiet-hours fact: an explicit override wins (tests / a caller with its own tz
          // resolution); otherwise resolve it from the workspace's configured window.
          const withinQuietHours =
            factOverrides?.withinQuietHours ?? (yield* resolveWithinQuietHours(request.workspaceID, at))

          // §E3 — the workspace's allowed FS roots for the content path ACL. An explicit override wins;
          // else the default/injected resolver. `undefined` ⇒ the path leg stays off for this workspace.
          const allowedPathRoots = factOverrides?.allowedPathRoots ?? allowedPathRootsFor(request.workspaceID)

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

          // §B2 越权文件路径 (NOW WIRED, §E3): `allowedPathRoots` (resolved above) is passed into the
          // policy's scrub below, so a push whose content names a file OUTSIDE the workspace roots has
          // that path stripped («path removed») via the shared PathAcl policy. Previously deferred; the
          // caller now resolves the roots so the leg is live.

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
                    // §E4 — the REAL resolved quiet-hours fact (override → configured window → false).
                    withinQuietHours,
                    ...(factOverrides?.pushLimitPerHour != null ? { pushLimitPerHour: factOverrides.pushLimitPerHour } : {}),
                    ...(factOverrides?.allowedLinkHosts != null ? { allowedLinkHosts: factOverrides.allowedLinkHosts } : {}),
                    ...(factOverrides?.maxContentChars != null ? { maxContentChars: factOverrides.maxContentChars } : {}),
                    // §E3 — the resolved workspace path ACL roots (undefined ⇒ leg stays off).
                    ...(allowedPathRoots != null ? { allowedPathRoots } : {}),
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
