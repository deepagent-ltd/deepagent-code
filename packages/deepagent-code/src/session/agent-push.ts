export * as AgentPush from "./agent-push"

import nodePath from "path"
import { Cause, Context, Effect, Layer, Option } from "effect"
import { and, eq, gt, sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { AgentPushPolicy } from "@deepagent-code/core/deepagent/agent-push-policy"
import { WorkspaceConfig } from "@deepagent-code/core/deepagent/workspace-config"
import { QuietHours } from "@deepagent-code/core/deepagent/quiet-hours"
import { AgentPushLogTable } from "@deepagent-code/core/im/push-log-sql"
import { MemberTable } from "@deepagent-code/core/im/sql"
import { IMRepository } from "@deepagent-code/core/im/repository"
import * as IMID from "@deepagent-code/core/im/id"
import { WorkspaceTable } from "@deepagent-code/core/control-plane/workspace.sql"
import { ProjectTable, ProjectDirectoryTable } from "@deepagent-code/core/project/sql"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
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
// §E3 PATH ACL: scrub is called WITH `allowedPathRoots` resolved from the workspace's REAL filesystem
// root(s), so a proactive push can never leak a file path OUTSIDE the workspace. Resolution (see
// `defaultAllowedPathRootsFor` / `makeWorkspaceRootResolver`):
//   • a DIRECTORY-style workspaceID (an absolute-ish path, NOT a "wrk_"-synthetic id) doubles as its own
//     single root — unchanged from P2.8.
//   • a genuine multi-tenant "wrk_"-id is NOT a filesystem path, so it is resolved to the workspace's
//     real project root(s) via the SAME workspace→directory mechanism the control-plane uses: the
//     `workspace` row's `directory`, unioned with its project's directories (project_directory) +
//     worktree + sandboxes (multi-repo). Before P4.2 a "wrk_"-id resolved to NO roots ⇒ the path-ACL leg
//     was silently OFF for every genuine workspace; this closes that.
// A caller/test may override via `factOverrides.allowedPathRoots` (highest priority) or the layer's
// `allowedPathRootsFor` port. FAIL-SAFE: an unresolvable "wrk_"-id (no row / no on-disk root) resolves to
// `undefined` ⇒ the path leg stays OFF for that push (scrub still runs, push still proceeds) and the miss
// is logged — we do NOT fabricate a root (which would wrongly strip every path) nor crash the push.
//
// LAYERING: `deepagent-code`. The DECISION is pure (core); this owns the IO (DB reads/writes + flag). The
// wrk_→root resolver reads the SAME `workspace`/`project`/`project_directory` tables the control-plane
// Workspace service reads, over the ONE Database this layer already depends on — no new service needed in
// the daemon graph (Workspace.Service is not part of it), so `AgentPush.layer` closes the gap in prod
// without any wiring change at the call site.

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
   * §E3 — the SYNCHRONOUS path-roots port for the content path ACL. Injected so a test can PIN roots (for
   * ANY workspaceID, incl. a "wrk_"-id) and production/tests can swap the directory heuristic. Returns
   * `undefined` to defer: a directory-style workspaceID resolves to its own root here; a genuine "wrk_"-id
   * returns `undefined` from the default so the runtime falls through to the DB-backed wrk_→root resolver
   * (see `makeWorkspaceRootResolver`). A non-undefined return (incl. `[]`) SHORT-CIRCUITS that fallback.
   */
  readonly allowedPathRootsFor?: (workspaceID: string) => ReadonlyArray<string> | undefined
}

// Default SYNCHRONOUS path-roots resolver: a directory-routed workspaceID (single-user / directory model
// — an absolute-ish path, NOT a "wrk_"-prefixed synthetic id) doubles as the workspace's FS root, so a
// push may reference paths INSIDE it but not outside (/etc/passwd, ~/.ssh, ../../secrets are stripped). A
// genuine "wrk_"-id is not itself a path ⇒ returns `undefined` here so the caller falls through to the
// DB-backed resolver (P4.2) which looks up the workspace's REAL project root(s). We never fabricate a
// bogus root for a wrk_ id (that would strip every path).
const defaultAllowedPathRootsFor = (workspaceID: string): ReadonlyArray<string> | undefined =>
  workspaceID.length > 0 && !workspaceID.startsWith("wrk") ? [workspaceID] : undefined

// True when `dir` resolves to a filesystem root (posix "/" or a drive/UNC root). A project's worktree
// sentinel for non-git / "global" projects is "/", and including that as an allowed root would make the
// path ACL match EVERY absolute path (defeating the leg) — so such roots are excluded. Mirrors the
// instance-context invariant without importing the FS layer.
const isFilesystemRoot = (dir: string): boolean => {
  const trimmed = dir.trim()
  if (!trimmed) return true
  const resolved = nodePath.resolve(trimmed)
  return nodePath.dirname(resolved) === resolved
}

// P4.2 §E3 — resolve a genuine multi-tenant "wrk_" workspaceID to its REAL filesystem root(s) using the
// SAME workspace→directory mechanism the control-plane Workspace service uses: the `workspace` row's
// `directory`, unioned with its project's roots (worktree + sandboxes + project_directory) so a MULTI-REPO
// workspace contains ALL its repos. Reads the shared Database (already a hard dep of this layer) directly
// — no new service in the daemon graph is needed. FAIL-SAFE: any DB error, a missing row, or a resolution
// that yields zero usable (non-filesystem-root) roots returns `undefined` (⇒ ACL leg stays OFF for that
// push, which still proceeds) and logs the miss; we never fabricate a root that would wrongly allow/deny.
const makeWorkspaceRootResolver = (db: Database.Interface["db"]) => {
  const collectRoots = (workspaceID: string) =>
    Effect.gen(function* () {
      const wsRow = yield* db
        .select({ directory: WorkspaceTable.directory, projectID: WorkspaceTable.project_id })
        .from(WorkspaceTable)
        .where(eq(WorkspaceTable.id, workspaceID as WorkspaceV2.ID))
        .get()
      if (!wsRow) {
        log.warn("wrk_ path-ACL: no workspace row — path leg OFF for this push", { workspaceID })
        return undefined
      }

      const roots = new Set<string>()
      const add = (dir: string | null | undefined) => {
        if (!dir) return
        const resolved = nodePath.resolve(dir)
        if (isFilesystemRoot(resolved)) return
        roots.add(resolved)
      }

      add(wsRow.directory)

      if (wsRow.projectID) {
        const projRow = yield* db
          .select({ worktree: ProjectTable.worktree, sandboxes: ProjectTable.sandboxes })
          .from(ProjectTable)
          .where(eq(ProjectTable.id, wsRow.projectID))
          .get()
        add(projRow?.worktree)
        for (const sandbox of projRow?.sandboxes ?? []) add(sandbox)

        // multi-repo: every registered project directory (main / root / git_worktree) is an allowed root.
        const dirRows = yield* db
          .select({ directory: ProjectDirectoryTable.directory })
          .from(ProjectDirectoryTable)
          .where(eq(ProjectDirectoryTable.project_id, wsRow.projectID))
          .all()
        for (const dirRow of dirRows) add(dirRow.directory)
      }

      if (roots.size === 0) {
        log.warn("wrk_ path-ACL: workspace resolved to no on-disk root — path leg OFF for this push", {
          workspaceID,
          projectID: wsRow.projectID,
        })
        return undefined
      }
      return [...roots]
    })

  // FAIL-SAFE outer guard: a DB failure must never crash the push — degrade to "leg off" + log.
  return (workspaceID: string): Effect.Effect<ReadonlyArray<string> | undefined> =>
    collectRoots(workspaceID).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          log.warn("wrk_ path-ACL resolution failed — path leg OFF for this push", {
            workspaceID,
            cause: Cause.pretty(cause),
          })
          return undefined
        }),
      ),
    )
}

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const repo = yield* IMRepository
      const flags = yield* RuntimeFlags.Service
      const now = options?.now ?? Date.now
      const allowedPathRootsFor = options?.allowedPathRootsFor ?? defaultAllowedPathRootsFor
      // §E3 (P4.2) — the DB-backed wrk_→real-root resolver, over the SAME Database this layer already
      // holds. Used only when the synchronous port defers (returns undefined) — i.e. for a genuine
      // "wrk_"-id. Fail-safe: unresolvable ⇒ undefined ⇒ leg off (logged), never a crash.
      const resolveWorkspaceRoots = makeWorkspaceRootResolver(db)
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

          // §E3 — the workspace's allowed FS roots for the content path ACL. Priority: an explicit
          // factOverrides wins (tests / a caller that pre-resolved) → the synchronous port (directory-id
          // becomes its own root) → for a genuine "wrk_"-id that deferred, the DB-backed resolver looks up
          // the REAL project root(s). `undefined` at every step ⇒ the path leg stays off for this push
          // (scrub still runs; the push still proceeds). Fail-safe throughout.
          const allowedPathRoots =
            factOverrides?.allowedPathRoots ??
            allowedPathRootsFor(request.workspaceID) ??
            (yield* resolveWorkspaceRoots(request.workspaceID))

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
