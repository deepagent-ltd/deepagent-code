export * as LocalTaskPolicy from "./local-task-policy"

import { and, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import type { WorkAuthority } from "../session/work-authority"
import { WorkAuthorityPolicy } from "../session/work-authority-policy"
import { WorkAuthoritySchema } from "../session/work-authority.schema"
import { ProjectScopeIdentityTable } from "../context-federation/sql"
import { LocalOperator } from "./local-operator"
import { LocalTaskConversationTable } from "./local-operator.sql"
import { GroupTable, MemberTable } from "./sql"

type Tx = WorkAuthority.Transaction
export type Conversation = typeof LocalTaskConversationTable.$inferSelect
export const lookup = Effect.fn("LocalTaskPolicy.lookup")(function* (
  tx: Tx | Database.Interface["db"],
  groupID: string,
) {
  return yield* tx
    .select()
    .from(LocalTaskConversationTable)
    .where(eq(LocalTaskConversationTable.group_id, groupID))
    .get()
    .pipe(Effect.orDie)
})

export const enable = Effect.fn("LocalTaskPolicy.enable")(function* (
  db: Database.Interface["db"],
  input: {
    operationID: string
    groupID: string
    targetID: string
    expectedRevision: number
    budget?: unknown
    now?: number
    directory?: string
  },
) {
  if (
    !input.operationID ||
    input.operationID.length > 512 ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  )
    return yield* LocalOperator.failure("LOCAL_OPERATOR_INVALID", "Invalid task-mode request")
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const operator = yield* LocalOperator.requireMutation(tx)
        yield* LocalOperator.validatePolicy(tx, operator.policy, operator.operator_id)
        const allowed = operator.policy.targets.find((target) => target.id === input.targetID)
        if (!allowed)
          return yield* LocalOperator.failure("LOCAL_TASK_SCOPE_DENIED", "Target was not enrolled by the operator")
        if (input.directory !== undefined && input.directory !== allowed.target.location.directory)
          return yield* LocalOperator.failure("LOCAL_TASK_SCOPE_DENIED", "Target is outside the current project")
        const budget =
          input.budget === undefined
            ? allowed.target.budget
            : yield* LocalOperator.decode(WorkAuthoritySchema.Budget, input.budget)
        if (!WorkAuthorityPolicy.checkBudgetCeiling(allowed.target.budget, budget).ok)
          return yield* LocalOperator.failure("LOCAL_TASK_SCOPE_DENIED", "Task-mode cannot expand the enrolled budget")
        const target = {
          ...allowed.target,
          budget,
          durationMs: Math.min(allowed.target.durationMs, budget.maxDurationMs),
        }
        yield* requireGroup(tx, input.groupID, target)
        const requestHash = LocalOperator.hash({
          action: "enable_conversation",
          operator: LocalOperator.principal(operator),
          groupID: input.groupID,
          targetID: input.targetID,
          target,
          expectedRevision: input.expectedRevision,
        })
        const retry = yield* LocalOperator.command(tx, operator.instance_id, input.operationID, requestHash)
        if (retry) {
          const current = yield* requireConversation(tx, input.groupID)
          if (current.revision !== input.expectedRevision + 1 || current.target_hash !== LocalOperator.hash(target))
            return yield* LocalOperator.failure(
              "LOCAL_OPERATOR_REVISION_CONFLICT",
              "Conversation policy changed after this command was accepted",
            )
          return { groupID: current.group_id, revision: current.revision }
        }
        const prior = yield* lookup(tx, input.groupID)
        if (prior && (prior.instance_id !== operator.instance_id || prior.operator_id !== operator.operator_id))
          return yield* LocalOperator.failure(
            "LOCAL_TASK_SCOPE_DENIED",
            "Conversation belongs to a different enrolled operator",
          )
        if ((prior?.revision ?? 0) !== input.expectedRevision)
          return yield* LocalOperator.failure(
            "LOCAL_OPERATOR_REVISION_CONFLICT",
            "Conversation policy revision changed",
          )
        yield* requireQuiescent(tx, input.groupID)
        const now = input.now ?? Date.now()
        const row = {
          group_id: input.groupID,
          instance_id: operator.instance_id,
          operator_id: operator.operator_id,
          operator_revision: operator.revision,
          target_id: allowed.id,
          revision: (prior?.revision ?? 0) + 1,
          mode: "explicit_task" as const,
          target,
          target_hash: LocalOperator.hash(target),
          location_key: allowed.locationKey,
          namespace_binding_hash: allowed.namespaceBindingHash,
          created_at: prior?.created_at ?? now,
          updated_at: now,
        }
        if (prior)
          yield* tx
            .update(LocalTaskConversationTable)
            .set(row)
            .where(
              and(
                eq(LocalTaskConversationTable.group_id, input.groupID),
                eq(LocalTaskConversationTable.revision, input.expectedRevision),
              ),
            )
            .run()
            .pipe(Effect.orDie)
        if (!prior) yield* tx.insert(LocalTaskConversationTable).values(row).run().pipe(Effect.orDie)
        const result = { groupID: row.group_id, revision: row.revision }
        yield* LocalOperator.saveCommand(tx, {
          instanceID: operator.instance_id,
          operationID: input.operationID,
          action: "enable_conversation",
          requestHash,
          expectedRevision: input.expectedRevision,
          result,
          now,
        })
        return result
      }),
    { behavior: "immediate" },
  )
})

export const requireConversation = Effect.fn("LocalTaskPolicy.requireConversation")(function* (
  tx: Tx,
  groupID: string,
) {
  const operator = yield* LocalOperator.requireCurrent(tx)
  const current = yield* lookup(tx, groupID)
  if (
    !current ||
    current.instance_id !== operator.instance_id ||
    current.operator_id !== operator.operator_id ||
    current.operator_revision !== operator.revision ||
    LocalOperator.hash(current.target) !== current.target_hash
  )
    return yield* LocalOperator.failure("LOCAL_TASK_SCOPE_DENIED", "Current conversation task policy is unavailable")
  yield* LocalOperator.validatePolicy(tx, operator.policy, operator.operator_id)
  const allowed = operator.policy.targets.find((entry) => entry.id === current.target_id)
  if (
    !allowed ||
    allowed.locationKey !== current.location_key ||
    allowed.namespaceBindingHash !== current.namespace_binding_hash ||
    !WorkAuthorityPolicy.checkBudgetCeiling(allowed.target.budget, current.target.budget).ok ||
    LocalOperator.hash({ ...current.target, budget: allowed.target.budget, durationMs: allowed.target.durationMs }) !==
      LocalOperator.hash(allowed.target)
  )
    return yield* LocalOperator.failure(
      "LOCAL_TASK_SCOPE_DENIED",
      "Conversation target no longer matches its enrolled policy",
    )
  if (
    current.target.durationMs > allowed.target.durationMs ||
    current.target.durationMs > current.target.budget.maxDurationMs
  )
    return yield* LocalOperator.failure("LOCAL_TASK_SCOPE_DENIED", "Conversation duration exceeds its enrolled policy")
  yield* requireGroup(tx, groupID, current.target)
  return current
})

const requireGroup = Effect.fn("LocalTaskPolicy.requireGroup")(function* (
  tx: Tx,
  groupID: string,
  target: Conversation["target"],
) {
  const group = yield* tx
    .select()
    .from(GroupTable)
    .where(sql`${GroupTable.id} = ${groupID}`)
    .get()
    .pipe(Effect.orDie)
  const member = yield* tx
    .select()
    .from(MemberTable)
    .where(
      and(
        sql`${MemberTable.group_id} = ${groupID}`,
        eq(MemberTable.member_id, "server"),
        eq(MemberTable.member_type, "user"),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  const project = yield* tx
    .select()
    .from(ProjectScopeIdentityTable)
    .where(
      and(
        eq(ProjectScopeIdentityTable.security_namespace_id, target.scope.securityNamespaceID),
        eq(ProjectScopeIdentityTable.project_scope_key, target.scope.projectScopeKey),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (
    !group ||
    group.deleted_at !== null ||
    group.kernel_conv_id !== null ||
    group.workspace_id !== target.location.directory ||
    target.scope.workspaceID !== group.workspace_id ||
    !member ||
    (group.project_id !== null && group.project_id !== project?.observed_project_id)
  )
    return yield* LocalOperator.failure(
      "LOCAL_TASK_SCOPE_DENIED",
      "Conversation is not an accessible local group in the enrolled project",
    )
  return group
})

/** This first cutover refuses every pending/admitted legacy intent, including settled history.
 * Complete historical-lane migration requires a separate terminal mapping. The conservative
 * refusal also keeps raw exact retries from racing a mode change after their SQL guard. */
const requireQuiescent = Effect.fn("LocalTaskPolicy.requireQuiescent")(function* (tx: Tx, groupID: string) {
  const result = yield* tx
    .all<{ blocked: number }>(
      sql`
    WITH RECURSIVE linked(id) AS (
      SELECT i.session_id FROM im_mention_intent i JOIN im_messages m ON m.id=i.message_id WHERE m.group_id=${groupID} AND i.session_id IS NOT NULL
      UNION SELECT g.session_id FROM im_task_grant g JOIN im_task_request r ON r.request_id=g.request_id JOIN im_task_source s ON s.source_id=r.source_id JOIN im_messages m ON m.id=s.message_id WHERE m.group_id=${groupID}
      UNION SELECT s.id FROM session s WHERE json_valid(s.metadata) AND json_extract(s.metadata, '$.im.groupID')=${groupID}
      UNION SELECT s.id FROM session s JOIN linked l ON s.parent_id=l.id LIMIT 10001
    ) SELECT (
      (SELECT count(*) FROM linked) >= 10001 OR
      EXISTS(SELECT 1 FROM im_mention_intent i JOIN im_messages m ON m.id=i.message_id WHERE m.group_id=${groupID} AND i.status IN ('pending','admitted')) OR
      EXISTS(SELECT 1 FROM linked l LEFT JOIN session s ON s.id=l.id WHERE s.id IS NULL OR s.execution_claim_token IS NOT NULL) OR
      EXISTS(SELECT 1 FROM session_input i JOIN linked l ON l.id=i.session_id WHERE i.promoted_seq IS NULL) OR
      EXISTS(SELECT 1 FROM session_activity a JOIN linked l ON l.id=a.session_id WHERE a.state='active') OR
      EXISTS(SELECT 1 FROM session_provider_attempt p JOIN linked l ON l.id=p.session_id WHERE p.state IN ('prepared','dispatching','streaming','indeterminate_after_crash')) OR
      EXISTS(SELECT 1 FROM session_v2_tool_effect_admission a JOIN linked l ON l.id=a.session_id LEFT JOIN session_v2_tool_effect e ON e.receipt_id=a.receipt_id AND e.tool_call_id=a.tool_call_id WHERE e.effect_id IS NULL) OR
      EXISTS(SELECT 1 FROM task_run t JOIN linked l ON l.id=t.parent_session_id OR l.id=t.child_session_id WHERE t.state NOT IN ('completed','error','cancelled','interrupted','failed','closed') OR t.time_settled IS NULL) OR
      EXISTS(SELECT 1 FROM work_execution w JOIN linked l ON l.id=w.session_id WHERE w.outcome IN ('pending','unknown')) OR
      EXISTS(SELECT 1 FROM im_reply_outbox o WHERE o.group_id=${groupID} AND o.status <> 'delivered') OR
      -- Local outbox completion does not settle its original remote dispatch,
      -- even after the conversation has been detached from that transport.
      EXISTS(SELECT 1 FROM im_reply_outbox o JOIN im_kernel_delivery d ON d.message_id=o.delivery_message_id
        WHERE o.group_id=${groupID} AND d.state <> 'acknowledged')
    ) blocked`,
    )
    .pipe(Effect.orDie)
  if (result[0]?.blocked !== 0)
    return yield* LocalOperator.failure(
      "LOCAL_TASK_LEGACY_UNSETTLED",
      "Conversation has unsettled or unclassified legacy work",
    )
})
