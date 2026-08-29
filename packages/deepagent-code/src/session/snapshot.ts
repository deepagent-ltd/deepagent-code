import { Effect } from "effect"
import { asc, eq, inArray, sql } from "drizzle-orm"
import { randomBytes } from "node:crypto"
import { Database } from "@deepagent-code/core/database/database"
import { MessageTable, PartTable, SessionTable } from "@deepagent-code/core/session/sql"
import {
  ProjectScopeIdentityTable,
  SecurityNamespaceTable,
} from "@deepagent-code/core/context-federation/sql"
import { SessionProviderOwnerLeaseTable } from "@deepagent-code/core/context-federation/session-sql"
import { SessionActivityProgressTable, SessionLegacyActivityTable } from "./activity-sql"
import { SessionToolRequestReceiptTable } from "./tool-request-receipt.sql"
import { Identifier } from "@/id/id"

// ---------------------------------------------------------------------------
// 会话快照导出/导入(跨设备携带:完整现场 + 保证续跑)。
//
// 依据(已逐行核实):
//  - 续跑读历史走 Session.Service.messages() → MessageTable/PartTable,不走 EventV2。
//  - 续跑唯一硬阻塞:存在 state='active' 的 session_legacy_activity(prompt-intent.ts:803)。
//  - 时间线活动标记由 message-v2.ts:385-443 联 session_activity_progress ⋈
//    session_legacy_activity ⋈ message 计算,并强制 activity.session_id == message.session_id。
// 故"完整现场 + 续跑"= 5 张表:session、message、part、session_legacy_activity、
// session_activity_progress。
//
// 状态机触发器与导入的满足方式(全部核实到触发器定义):
//  - session_activity_progress 的 BEFORE INSERT 触发器要求:activity 处于 active,且存在同
//    session、同 assistant_message 的 session_tool_request_receipt。→ 逐活动"插 active →
//    合成 receipt → 插 progress → 终态化";session_legacy_activity_active_idx 限定每 session
//    同时至多一个 active,故严格逐活动串行。
//  - session_tool_request_receipt 有 5 个 BEFORE INSERT 触发器,分别要求:
//      * provider 执行簿记:owner_token 对应未释放且未过期的 session_provider_owner_lease;
//        provider_attempt_id 置 NULL 即跳过 attempt 校验。
//      * context 联邦权威:released_knowledge_security_namespace_id/project_scope_key 对应
//        context_project_scope_identity(retired_at NULL);binding_state='unavailable'+空
//        exact_refs+其 MD5 指纹满足 invalidBinding;context_selection_id 置 NULL 跳过 links。
//      * prepared 守卫:provider_state='preparing'、selected_refs 为 NULL、prepared 域字段为空。
//    上述行(owner lease / security namespace / scope identity)优先复用目标实例既有行,缺失才合成。
//  - session_legacy_activity_legal_update 只允许 active → 终态(settled_at/terminal_reason 必填、
//    不可变字段不得改);permission-effect 终态守卫对无 permission effect 的导入活动放行。
//  - activity.trigger_admission_id 为 NOT NULL 外键→admission(其后又外键→intent/session_input),
//    完整 FK 链会拉出整个执行簿记;时间线标记与续跑守卫均不读 admission,故导入时临时关闭
//    foreign_keys 并以占位值落库,导入后恢复 FK 约束(触发器不受 foreign_keys 影响,仍生效)。
// ---------------------------------------------------------------------------

export const SNAPSHOT_FORMAT = "deepagent-code.session-snapshot"
export const SNAPSHOT_VERSION = 1

// Released-knowledge binding fingerprint for empty exact refs, exactly as required by the
// released_knowledge_turn_binding trigger's 'unavailable' branch (hardcoded constant there).
const EMPTY_REFS_FINGERPRINT = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"

type SessionRow = typeof SessionTable.$inferSelect
type MessageRow = typeof MessageTable.$inferSelect
type PartRow = typeof PartTable.$inferSelect
type ActivityRow = typeof SessionLegacyActivityTable.$inferSelect
type ProgressRow = typeof SessionActivityProgressTable.$inferSelect

export interface SessionSnapshot {
  format: typeof SNAPSHOT_FORMAT
  format_version: number
  exported_at: number
  source: { session_id: string; title: string }
  session: SessionRow
  messages: MessageRow[]
  parts: PartRow[]
  activities: ActivityRow[]
  progress: ProgressRow[]
}

const randomHex = (bytes: number) => randomBytes(bytes).toString("hex")

/** 导出:读取会话的 5 张表,组装为自描述快照。 */
export const exportSessionSnapshot = Effect.fn("Session.exportSnapshot")(function* (sessionID: string) {
  const { db } = yield* Database.Service
  const session = yield* db
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID as SessionRow["id"]))
    .get()
    .pipe(Effect.orDie)
  if (!session) return yield* Effect.fail(new Error(`session not found: ${sessionID}`))

  const messages = yield* db
    .select()
    .from(MessageTable)
    .where(eq(MessageTable.session_id, session.id))
    .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
    .all()
    .pipe(Effect.orDie)
  const parts = yield* db
    .select()
    .from(PartTable)
    .where(eq(PartTable.session_id, session.id))
    .orderBy(asc(PartTable.time_created), asc(PartTable.id))
    .all()
    .pipe(Effect.orDie)
  const activities = yield* db
    .select()
    .from(SessionLegacyActivityTable)
    .where(eq(SessionLegacyActivityTable.session_id, session.id))
    .orderBy(asc(SessionLegacyActivityTable.ordinal))
    .all()
    .pipe(Effect.orDie)
  const activityIDs = activities.map((a) => a.activity_id)
  const progress =
    activityIDs.length === 0
      ? []
      : yield* db
          .select()
          .from(SessionActivityProgressTable)
          .where(inArray(SessionActivityProgressTable.activity_id, activityIDs))
          .orderBy(asc(SessionActivityProgressTable.activity_id), asc(SessionActivityProgressTable.revision))
          .all()
          .pipe(Effect.orDie)

  return {
    format: SNAPSHOT_FORMAT,
    format_version: SNAPSHOT_VERSION,
    exported_at: Date.now(),
    source: { session_id: session.id, title: session.title },
    session,
    messages,
    parts,
    activities,
    progress,
  } satisfies SessionSnapshot
})

/**
 * 导入:在单个事务内以全新 ID 重建 5 张表并重挂目标 project/directory;逐活动"插 active →
 * 合成 receipt → 插 progress → 终态化",既复刻活动标记(完整现场),又保证导入后无 active
 * activity(可续跑)。
 */
export const importSessionSnapshot = Effect.fn("Session.importSnapshot")(function* (input: {
  snapshot: SessionSnapshot
  projectID: string
  directory: string
}) {
  const { db } = yield* Database.Service
  const snap = input.snapshot
  if (snap.format !== SNAPSHOT_FORMAT)
    return yield* Effect.fail(new Error(`unsupported snapshot format: ${String(snap.format)}`))
  if (typeof snap.format_version !== "number" || snap.format_version > SNAPSHOT_VERSION)
    return yield* Effect.fail(new Error(`unsupported snapshot version: ${String(snap.format_version)}`))

  const newSessionID = Identifier.ascending("session")
  const messageMap = new Map<string, string>()
  const partMap = new Map<string, string>()
  const activityMap = new Map<string, string>()
  for (const message of snap.messages) messageMap.set(message.id, Identifier.ascending("message"))
  for (const part of snap.parts) partMap.set(part.id, Identifier.ascending("part"))
  for (const activity of snap.activities) activityMap.set(activity.activity_id, randomHex(32))

  const source = snap.session
  const providerID = (source.model as { providerID?: string } | null)?.providerID ?? "imported"
  const modelID = (source.model as { id?: string } | null)?.id ?? "imported"
  const firstMessageID = snap.messages.length > 0 ? messageMap.get(snap.messages[0].id)! : newSessionID

  const newSession = {
    ...source,
    id: newSessionID,
    project_id: input.projectID,
    directory: input.directory,
    // A snapshot becomes a fresh root session on the target; drop cross-instance references that
    // would otherwise dangle (workspace/parent/share are not FK-enforced but would be misleading).
    workspace_id: null,
    parent_id: null,
    share_url: null,
  }
  const newMessages = snap.messages.map((message) => ({
    ...message,
    id: messageMap.get(message.id)!,
    session_id: newSessionID,
  }))
  const newParts = snap.parts.map((part) => ({
    ...part,
    id: partMap.get(part.id)!,
    message_id: messageMap.get(part.message_id) ?? part.message_id,
    session_id: newSessionID,
  }))
  const progressByActivity = new Map<string, ProgressRow[]>()
  for (const row of snap.progress) {
    const list = progressByActivity.get(row.activity_id)
    if (list) list.push(row)
    else progressByActivity.set(row.activity_id, [row])
  }
  const now = Date.now()

  yield* Effect.acquireUseRelease(
    db.run("PRAGMA foreign_keys = OFF").pipe(Effect.orDie),
    () =>
      db.transaction(
        (tx) =>
          Effect.gen(function* () {
            // Authority rows required by the receipt BEFORE INSERT triggers: reuse existing target
            // rows when present, synthesize minimal ones otherwise.
            const { ownerToken, securityNamespaceID, projectScopeKey } = yield* resolveReceiptAuthority(
              tx,
              now,
            )

            yield* tx.insert(SessionTable).values(newSession as never).run().pipe(Effect.orDie)
            if (newMessages.length > 0)
              yield* tx.insert(MessageTable).values(newMessages as never).run().pipe(Effect.orDie)
            if (newParts.length > 0) yield* tx.insert(PartTable).values(newParts as never).run().pipe(Effect.orDie)

            // Per-activity: insert active → synthesize receipt(s) → insert progress → terminalize.
            // Sequential so the single-active-per-session unique index is never violated.
            for (const activity of snap.activities) {
              const newActivityID = activityMap.get(activity.activity_id)!
              yield* tx
                .insert(SessionLegacyActivityTable)
                .values({
                  activity_id: newActivityID,
                  session_id: newSessionID,
                  ordinal: activity.ordinal,
                  trigger_admission_id: randomHex(16),
                  owner_token: ownerToken,
                  state: "active",
                  terminal_reason: null,
                  created_at: activity.created_at,
                  settled_at: null,
                } as never)
                .run()
                .pipe(Effect.orDie)

              const rows = progressByActivity.get(activity.activity_id) ?? []
              for (const row of rows) {
                const assistantMessageID = messageMap.get(row.assistant_message_id) ?? row.assistant_message_id
                const receiptID = randomHex(16)
                // Synthetic receipt: satisfies the receipt BEFORE INSERT triggers (owner lease +
                // released-knowledge authority) and the progress trigger's existence check; it
                // carries no real execution data (attempt/selection left NULL).
                yield* tx
                  .insert(SessionToolRequestReceiptTable)
                  .values({
                    receipt_id: receiptID,
                    request_ordinal: row.revision + 1,
                    session_id: newSessionID,
                    user_message_id: firstMessageID,
                    assistant_message_id: assistantMessageID,
                    provider_id: providerID,
                    model_id: modelID,
                    registry_tool_ids: [],
                    permission_filtered_tool_ids: [],
                    final_offered_tool_ids: [],
                    call_ids: [],
                    provider_state: "preparing",
                    request_state: "prepared",
                    owner_token: ownerToken,
                    released_knowledge_security_namespace_id: securityNamespaceID,
                    released_knowledge_project_scope_key: projectScopeKey,
                    released_knowledge_binding_state: "unavailable",
                    released_knowledge_exact_refs: [],
                    released_knowledge_exact_refs_fingerprint: EMPTY_REFS_FINGERPRINT,
                    created_at: row.created_at,
                  } as never)
                  .run()
                  .pipe(Effect.orDie)
                yield* tx
                  .insert(SessionActivityProgressTable)
                  .values({
                    activity_id: newActivityID,
                    revision: row.revision,
                    assistant_message_id: assistantMessageID,
                    text_part_id: row.text_part_id ? (partMap.get(row.text_part_id) ?? row.text_part_id) : null,
                    provider_receipt_id: receiptID,
                    input_membership_ordinal: row.input_membership_ordinal,
                    state: row.state,
                    finish_observed: row.finish_observed,
                    response_fingerprint: row.response_fingerprint,
                    created_at: row.created_at,
                    settled_at: row.settled_at,
                  } as never)
                  .run()
                  .pipe(Effect.orDie)
              }

              // Terminalize (legal_update allows only active → terminal with settled_at + reason).
              // A source that was still active is terminalized to interrupted so the imported
              // session has no active activity and is immediately continuable.
              const wasActive = activity.state === "active"
              yield* tx
                .update(SessionLegacyActivityTable)
                .set({
                  state: wasActive ? "interrupted" : activity.state,
                  settled_at: wasActive ? now : (activity.settled_at ?? now),
                  terminal_reason: wasActive ? "imported_snapshot" : (activity.terminal_reason ?? "imported_snapshot"),
                } as never)
                .where(eq(SessionLegacyActivityTable.activity_id, newActivityID as never))
                .run()
                .pipe(Effect.orDie)
            }
            return { sessionID: newSessionID }
          }),
        { behavior: "immediate" },
      ),
    () => db.run("PRAGMA foreign_keys = ON").pipe(Effect.orDie),
  ).pipe(Effect.orDie)

  return { sessionID: newSessionID, messages: newMessages.length, parts: newParts.length }
})

/**
 * Resolve the authority rows the receipt BEFORE INSERT triggers require. Reuses an existing
 * unexpired owner lease and a non-retired project scope identity when present; synthesizes
 * minimal ones otherwise (an implicit_local security namespace + registered_root scope identity).
 */
type SnapshotTx = Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]
const resolveReceiptAuthority = Effect.fn("Session.resolveReceiptAuthority")(function* (
  tx: SnapshotTx,
  now: number,
) {
  const lease = yield* tx
    .select({
      owner_token: SessionProviderOwnerLeaseTable.owner_token,
      released_at: SessionProviderOwnerLeaseTable.released_at,
      lease_expires_at: SessionProviderOwnerLeaseTable.lease_expires_at,
    })
    .from(SessionProviderOwnerLeaseTable)
    .all()
    .pipe(Effect.orDie)
  const validLease = lease.find((row) => row.released_at === null && row.lease_expires_at > now)
  let ownerToken: string
  if (validLease) {
    ownerToken = validLease.owner_token
  } else {
    ownerToken = `imported-owner-${randomHex(12)}`
    // The lease insert clock guard requires registered_at/heartbeat_at to equal the DB-observed
    // time within the same statement; compute them atomically from julianday('now').
    const dbNowMs = sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`
    yield* tx
      .insert(SessionProviderOwnerLeaseTable)
      .values({
        owner_token: ownerToken,
        registered_at: dbNowMs,
        heartbeat_at: dbNowMs,
        lease_expires_at: sql`${dbNowMs} + 3600000`,
        released_at: null,
      } as never)
      .run()
      .pipe(Effect.orDie)
  }

  const scope = yield* tx
    .select({
      security_namespace_id: ProjectScopeIdentityTable.security_namespace_id,
      project_scope_key: ProjectScopeIdentityTable.project_scope_key,
      retired_at: ProjectScopeIdentityTable.retired_at,
    })
    .from(ProjectScopeIdentityTable)
    .all()
    .pipe(Effect.orDie)
  const validScope = scope.find((row) => row.retired_at === null)
  if (validScope) return { ownerToken, securityNamespaceID: validScope.security_namespace_id, projectScopeKey: validScope.project_scope_key }

  const securityNamespaceID = `imported-ns-${randomHex(12)}`
  const projectScopeKey = `imported-scope-${randomHex(8)}`
  yield* tx
    .insert(SecurityNamespaceTable)
    .values({
      id: securityNamespaceID,
      kind: "implicit_local",
      binding_hash: randomHex(32),
      created_at: now,
      retired_at: null,
    } as never)
    .run()
    .pipe(Effect.orDie)
  yield* tx
    .insert(ProjectScopeIdentityTable)
    .values({
      security_namespace_id: securityNamespaceID,
      project_scope_key: projectScopeKey,
      project_kind: "registered_root",
      project_identity_hash: randomHex(32),
      created_at: now,
      retired_at: null,
    } as never)
    .run()
    .pipe(Effect.orDie)
  return { ownerToken, securityNamespaceID, projectScopeKey }
})
