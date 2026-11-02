export * as AttentionWorkSource from "./work-source"

import { sql, type SQL } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { AttentionSchema } from "./schema"
import { Hash } from "../util/hash"
import { SessionSchema } from "../session/schema"

type Db = Pick<Database.Interface["db"], "all">
export type Kind = "task" | "goal"
export const BATCH = 256

const taskScope = sql`r.execution_runtime='v2' AND p.v2_authority=1 AND p.workspace_id IS NULL
  AND p.id NOT LIKE ${`${SessionSchema.LEARNING_REVIEWER_SESSION_PREFIX}%`}
  AND a.request_hash=r.request_hash AND a.parent_session_id=r.parent_session_id
  AND a.parent_message_id=r.parent_message_id AND a.tool_call_id=r.tool_call_id
  AND typeof(r.generation)='integer' AND r.generation BETWEEN 1 AND 9007199254740991
  AND length(r.child_session_id) BETWEEN 1 AND 72
  AND (c.id IS NULL OR (c.v2_authority=1 AND c.workspace_id IS NULL AND c.parent_id=p.id
    AND c.project_id=p.project_id AND c.directory=CASE WHEN r.workspace_mode='worktree' THEN r.worktree_directory ELSE p.directory END))
  AND (r.state IN ('completed','failed','error','closed','interrupted','cancelled','recovery_required') OR r.control_state='close_requested')`
const taskFrom = sql`task_run r JOIN task_admission a ON a.run_id=r.run_id
  JOIN session p ON p.id=r.parent_session_id LEFT JOIN session c ON c.id=r.child_session_id`
// Goal control binds platform paths; Session columns encode Windows separators as '/'.
const goalScope = sql`g.is_current=1 AND g.driver_mode='event' AND p.v2_authority=1 AND p.workspace_id IS NULL
  AND g.workspace_id IS NULL AND g.project_id=p.project_id
  AND ${process.platform === "win32" ? sql`replace(g.directory, char(92), '/')` : sql`g.directory`}=p.directory
  AND p.id NOT LIKE ${`${SessionSchema.LEARNING_REVIEWER_SESSION_PREFIX}%`} AND length(g.goal_id) BETWEEN 1 AND 95
  AND (g.requested_phase IN ('paused','stopped','done','needs_human','rolled_back')
    OR g.preparation='recovery_required' OR g.recovery_reason IS NOT NULL OR g.pending_rebase_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM goal_tick_permit z WHERE z.goal_id=g.goal_id AND z.state='unknown'))`
const goalFrom = sql`goal_control g JOIN session p ON p.id=g.session_id`

// A source suppresses only its actual registered child evidence in the same local scope.
// All evidence stays durable; callers can inspect the child through the original Session APIs.
export const ownsActivity = (session: SQL, activity: SQL) => sql`(
  EXISTS (SELECT 1 FROM ${taskFrom} JOIN session_activity x ON x.session_id=r.child_session_id
    AND x.trigger_input_id=r.child_message_id WHERE ${taskScope} AND r.child_session_id=${session} AND x.activity_id=${activity})
  OR EXISTS (SELECT 1 FROM ${goalFrom} JOIN goal_child_unit u ON u.goal_id=g.goal_id
    JOIN goal_tick_permit t ON t.permit_id=u.permit_id AND t.goal_id=g.goal_id
    JOIN session c ON c.id=u.child_session_id AND c.parent_id=p.id AND c.project_id=p.project_id
    AND c.directory=p.directory AND c.workspace_id IS NULL AND c.v2_authority=1
    JOIN json_each(u.inputs) j ON json_extract(j.value,'$.activityID')=${activity}
    WHERE ${goalScope} AND u.child_session_id=${session})
)`
export const ownsSession = (session: SQL) => sql`(
  EXISTS (SELECT 1 FROM ${taskFrom} WHERE ${taskScope} AND r.child_session_id=${session}
    AND r.state='recovery_required' AND NOT EXISTS (SELECT 1 FROM session_activity x
      WHERE x.session_id=r.child_session_id AND x.trigger_input_id!=r.child_message_id))
  OR EXISTS (SELECT 1 FROM ${goalFrom} JOIN goal_child_unit u ON u.goal_id=g.goal_id
    JOIN goal_tick_permit t ON t.permit_id=u.permit_id AND t.goal_id=g.goal_id
    JOIN session c ON c.id=u.child_session_id AND c.parent_id=p.id AND c.project_id=p.project_id
      AND c.directory=p.directory AND c.workspace_id IS NULL AND c.v2_authority=1
    WHERE ${goalScope} AND u.child_session_id=${session} AND NOT EXISTS (SELECT 1 FROM session_activity x
      WHERE x.session_id=u.child_session_id AND NOT EXISTS (SELECT 1 FROM json_each(u.inputs) j
        WHERE json_extract(j.value,'$.inputID')=x.trigger_input_id)))
)`

type Common = {
  key: string
  title: string
  session_id: string
  project_id: string
  directory: string
  parent_id: string | null
}
type TaskRow = Common & {
  run_id: string
  parent_session_id: string
  child_session_id: string
  actual_child_id: string | null
  generation: number
  version: number
  state: string
  control_state: "open" | "close_requested" | "closed"
  claim: number | null
  execution_owner: string | null
  created_at: number
  settled_at: number | null
  terminal_receipt: string | null
  terminal_hash: string | null
  terminal_state: string | null
  pending_providers: number
  pending_attempts: number
  pending_effects: number
  attempt_frontier: number
  effect_frontier: string | null
  provider_frontier: string | null
}

/** Counts every scalar source in bounded batches; retains only one requested page. Counts are an
 * observation of the source inventory, not a writer-lock snapshot or an execution capability. */
export const inventory = (
  db: Db,
  kind: Kind,
  options: { project?: string; after?: string; unseen?: boolean; limit: number },
) =>
  Effect.gen(function* () {
    const result = { items: [] as AttentionSchema.Item[], unseenCount: 0, scanned: 0, batches: 0, peakBatch: 0 }
    const cursor = { after: undefined as string | undefined }
    while (true) {
      const rows = yield* page(db, kind, { project: options.project, after: cursor.after })
      result.batches++
      result.scanned += rows.length
      result.peakBatch = Math.max(result.peakBatch, rows.length)
      if (!rows.length) return result
      const receipts = yield* db
        .all<{ item_id: string; source_revision: string; seen_at: number }>(
          sql`SELECT item_id,source_revision,seen_at
        FROM attention_seen WHERE scope_key='implicit-local' AND actor_id='server'
        AND (${sql.join(
          rows.map((item) => sql`(item_id=${item.id} AND source_revision=${item.revision})`),
          sql` OR `,
        )})`,
        )
        .pipe(Effect.orDie)
      const seen = new Map(receipts.map((row) => [JSON.stringify([row.item_id, row.source_revision]), row.seen_at]))
      for (const item of rows) {
        const at = seen.get(JSON.stringify([item.id, item.revision]))
        const current = { ...item, seen: at !== undefined, seenAt: at ?? null }
        if (!current.seen) result.unseenCount++
        if (
          (!options.unseen || !current.seen) &&
          (!options.after || current.id > options.after) &&
          result.items.length < options.limit
        )
          result.items.push(current)
      }
      cursor.after = rows.at(-1)!.id
      if (rows.length < BATCH) return result
      yield* Effect.yieldNow
    }
  })

export const read = (db: Db, kind: Kind, id: string) =>
  Effect.gen(function* () {
    const item = (yield* page(db, kind, { id }))[0]
    if (!item || item.id !== id) return undefined
    const seen = (yield* db
      .all<{ seen_at: number }>(
        sql`SELECT seen_at FROM attention_seen
    WHERE scope_key='implicit-local' AND actor_id='server' AND item_id=${id} AND source_revision=${item.revision} LIMIT 1`,
      )
      .pipe(Effect.orDie))[0]
    return { ...item, seen: !!seen, seenAt: seen?.seen_at ?? null }
  })

export const ACTION_PROOF_BYTES = 262144
const ACTION_SOURCE_BYTES = 65536

/** Suggestions only. Execution always returns through the original source controller.
 * The aggregate inventory stays scalar; document proofs run only for the final visible page. */
export const actions = (
  db: Database.Interface["db"],
  input: AttentionSchema.Item,
  enabled: { task: boolean; goal: boolean },
  budget: { bytes: number },
) => {
  const item = input.kind === "task" || input.kind === "goal" ? { ...input, allowedActions: [] } : input
  return Effect.gen(function* () {
    const task = item.source.task
    const goal = item.source.goal
    if ((!task || !enabled.task) && (!goal || !enabled.goal)) return item
    const parentID = task?.parentSessionID ?? item.session.id
    const actual = yield* read(db, task ? "task" : "goal", item.id)
    if (!actual || actual.revision !== item.revision || JSON.stringify(actual.source) !== JSON.stringify(item.source))
      return item
    const { WorkSessionGuard } = yield* Effect.promise(() => import("../session/work-session-guard"))
    const { GoalChild } = yield* Effect.promise(() => import("../deepagent/goal-child"))
    yield* WorkSessionGuard.requireOrdinary(db, parentID)
    yield* GoalChild.requireOrdinary(db, parentID)
    const allowed: Array<NonNullable<AttentionSchema.Item["allowedActions"]>[number]> = []
    if (task) {
      if (
        ["completed", "failed", "error", "closed", "interrupted", "cancelled"].includes(task.state) ||
        task.controlState === "closed"
      )
        return item
      if (task.controlState === "open") allowed.push("task_request_close")
      if (task.state === "recovery_required" && !task.hasExecutionClaim) {
        const [run] = yield* db
          .all<{ owner: string | null }>(
            sql`SELECT execution_owner AS owner FROM task_run
          WHERE run_id=${task.runID} AND parent_session_id=${task.parentSessionID} AND child_session_id=${task.recordedChildSessionID}
            AND generation=${task.generation} AND version=${task.version} LIMIT 1`,
          )
          .pipe(Effect.orDie)
        const { TaskHumanControl } = yield* Effect.promise(() => import("../session/task-human-control"))
        if (run && run.owner === null && (yield* TaskHumanControl.beforeDispatch(db, task.recordedChildSessionID)))
          allowed.push("task_resolve_failed", "task_resolve_closed")
      }
      return { ...item, allowedActions: allowed }
    }
    if (!goal || goal.preparation !== "ready") return item
    const bounds = yield* goalProofBounds(db, goal.goalID)
    if (
      !bounds ||
      bounds.initialization > ACTION_SOURCE_BYTES ||
      bounds.parent > ACTION_SOURCE_BYTES ||
      budget.bytes + bounds.initialization + bounds.parent > ACTION_PROOF_BYTES
    )
      return item
    budget.bytes += bounds.initialization + bounds.parent
    const { GoalControl } = yield* Effect.promise(() => import("../deepagent/goal-control"))
    const row = yield* GoalControl.get(db, goal.goalID)
    if (
      !row ||
      !row.is_current ||
      row.session_id !== parentID ||
      row.revision !== goal.controlRevision ||
      row.plan_revision !== goal.planRevision ||
      row.driver_mode !== "event" ||
      row.preparation !== "ready"
    )
      return item
    if (!GoalControl.isTerminal(row.requested_phase)) allowed.push("goal_pause", "goal_stop")
    const safe = !row.pending_rebase_id && !row.recovery_reason && !goal.pendingPermits && !goal.unknownPermits
    if (safe && row.requested_phase === "paused" && row.plan_revision === 0) allowed.push("goal_resume")
    const edit =
      safe &&
      row.initialization.executionContract === "owned-goal-v2" &&
      !["done", "rolled_back"].includes(row.requested_phase)
    const resume = safe && row.requested_phase === "paused" && row.plan_revision > 0
    if (!edit && !resume) return { ...item, allowedActions: allowed }
    if (
      bounds.checkpoint > ACTION_SOURCE_BYTES ||
      bounds.permit > ACTION_SOURCE_BYTES ||
      bounds.rebase > ACTION_SOURCE_BYTES ||
      bounds.units > 16 ||
      bounds.providers > 64 ||
      bounds.messages > 128 ||
      bounds.records > 256 ||
      budget.bytes + bounds.proof > ACTION_PROOF_BYTES
    )
      return { ...item, allowedActions: allowed }
    budget.bytes += bounds.proof
    const { GoalPlanRebase } = yield* Effect.promise(() => import("../deepagent/goal-plan-rebase"))
    const base = yield* GoalPlanRebase.baseline(db, row)
    if (resume) {
      const { GoalTickState } = yield* Effect.promise(() => import("../deepagent/goal-tick-state"))
      const document = base.documents.find((entry) => entry.id === `doc:run_context:${row.goal_id}`)
      const runtime = document
        ? Schema.decodeUnknownOption(Schema.fromJsonString(GoalTickState.Runtime))(document.body)
        : Option.none()
      if (Option.isSome(runtime) && GoalTickState.remainingBudget(runtime.value)) allowed.push("goal_resume")
    }
    if (edit) {
      const { DeepAgentPlanStore } = yield* Effect.promise(() => import("../deepagent/plan-store"))
      const plan = base.documents.find((entry) => entry.id === row.plan_doc_id)
      const [capacity] = yield* db
        .all<{ records: number; bytes: number; eventSeq: number | null }>(
          sql`SELECT
        (SELECT count(*) FROM goal_plan_rebase) AS records,(SELECT coalesce(sum(reserved_bytes),0) FROM goal_plan_rebase) AS bytes,
        (SELECT seq FROM event_sequence WHERE aggregate_id=${parentID}) AS eventSeq`,
        )
        .pipe(Effect.orDie)
      if (
        plan &&
        DeepAgentPlanStore.decodePlanDoc(plan.body) &&
        capacity?.eventSeq !== null &&
        capacity &&
        capacity.records < 100000 &&
        capacity.bytes + 1048576 <= 268435456
      )
        allowed.push("goal_edit")
    }
    return { ...item, allowedActions: allowed }
  }).pipe(
    Effect.catch(() => Effect.succeed(item)),
    Effect.catchDefect(() => Effect.succeed(item)),
  )
}

// Check all JSON that the original baseline/child result reader can inspect before loading it.
// A larger source still has the same readable facts; only this optional suggestion is omitted.
const goalProofBounds = (db: Db, goalID: string) =>
  db
    .all<{
      initialization: number
      parent: number
      checkpoint: number
      permit: number
      rebase: number
      units: number
      providers: number
      messages: number
      records: number
      proof: number
    }>(
      sql`WITH last AS (SELECT permit_id FROM goal_tick_permit WHERE goal_id=${goalID} AND state='settled' ORDER BY tick_seq DESC LIMIT 1),
  children AS (SELECT child_session_id FROM goal_child_unit WHERE permit_id IN (SELECT permit_id FROM last)),
  sizes AS (SELECT
    (SELECT length(CAST(initialization AS BLOB)) FROM goal_control WHERE goal_id=${goalID}) AS initialization,
    (SELECT coalesce(length(CAST(metadata AS BLOB)),0)+coalesce(length(CAST(permission AS BLOB)),0)+coalesce(length(CAST(model AS BLOB)),0)
      +coalesce(length(CAST(summary_diffs AS BLOB)),0)+coalesce(length(CAST(summary_diff_manifest AS BLOB)),0)+coalesce(length(CAST(revert AS BLOB)),0)+length(CAST(title AS BLOB))+length(CAST(slug AS BLOB))+length(CAST(directory AS BLOB))
      +coalesce(length(CAST(path AS BLOB)),0)+coalesce(length(CAST(preview AS BLOB)),0)+coalesce(length(CAST(share_url AS BLOB)),0)
      FROM session WHERE id=(SELECT session_id FROM goal_control WHERE goal_id=${goalID})) AS parent,
    (SELECT coalesce(sum(length(CAST(child_sessions AS BLOB))+coalesce(length(CAST(outcome AS BLOB)),0)),0) FROM goal_tick_permit WHERE permit_id IN (SELECT permit_id FROM last)) AS permit,
    (SELECT coalesce(sum(length(CAST(journal AS BLOB))),0) FROM goal_tick_checkpoint WHERE permit_id IN (SELECT permit_id FROM last)) AS checkpoint,
    (SELECT coalesce(sum(length(CAST(journal AS BLOB))),0) FROM goal_plan_rebase WHERE edit_id=(SELECT plan_rebase_id FROM goal_control WHERE goal_id=${goalID})) AS rebase,
    (SELECT count(*) FROM children) AS units,
    (SELECT count(*) FROM session_v2_provider_turn_receipt WHERE session_id IN (SELECT child_session_id FROM children)) AS providers,
    (SELECT count(*) FROM session_message WHERE session_id IN (SELECT child_session_id FROM children)) AS messages,
    (SELECT count(*) FROM session_v2_tool_effect_admission WHERE session_id IN (SELECT child_session_id FROM children))+
      (SELECT count(*) FROM session_provider_attempt WHERE session_id IN (SELECT child_session_id FROM children)) AS records,
    (SELECT coalesce(sum(length(CAST(binding AS BLOB))+length(CAST(inputs AS BLOB))+coalesce(length(CAST(creation_receipt AS BLOB)),0)),0)
      FROM goal_child_unit WHERE permit_id IN (SELECT permit_id FROM last))+
    (SELECT coalesce(sum(length(CAST(prompt AS BLOB))),0) FROM session_input WHERE session_id IN (SELECT child_session_id FROM children))+
    (SELECT coalesce(sum(coalesce(length(CAST(prepared_turn AS BLOB)),0)+coalesce(length(CAST(outcome_artifact AS BLOB)),0)+coalesce(length(CAST(integrity_evidence AS BLOB)),0)+coalesce(length(CAST(integrity_evidence_signature AS BLOB)),0)),0)
      FROM session_v2_provider_turn_receipt WHERE session_id IN (SELECT child_session_id FROM children))+
    (SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM session_message WHERE session_id IN (SELECT child_session_id FROM children))+
    (SELECT coalesce(sum(coalesce(length(CAST(known_read_proof AS BLOB)),0)+coalesce(length(CAST(known_write_proof AS BLOB)),0)+coalesce(length(CAST(known_command_proof AS BLOB)),0)),0)
      FROM session_v2_tool_effect WHERE session_id IN (SELECT child_session_id FROM children)) AS child_bytes)
  SELECT *,permit+rebase+(checkpoint*(units+1))+(3*child_bytes) AS proof FROM sizes`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]),
    )
type GoalRow = Common & {
  goal_id: string
  revision: number
  plan_revision: number
  next_seq: number
  plan_doc_id: string
  requested_phase: string
  preparation: string
  pending_rebase_id: string | null
  recovery_reason: string | null
  created_at: number
  pending_permits: number
  unknown_permits: number
  permit_frontier: string | null
  checkpoint_state: string | null
  checkpoint_hash: string | null
}

export const page = (db: Db, kind: Kind, options: { project?: string; after?: string; id?: string } = {}) => {
  if (kind === "task")
    return db
      .all<TaskRow>(
        sql`SELECT
    ('task:' || r.child_session_id || ':' || r.generation) AS key, r.run_id,r.parent_session_id,r.child_session_id,
    c.id AS actual_child_id,r.generation,r.version,r.state,r.control_state,
    CASE WHEN r.state IN ('completed','failed','error','closed','interrupted','cancelled') THEN NULL ELSE c.execution_claim_token END AS claim,r.execution_owner,
    r.time_created AS created_at,r.time_settled AS settled_at,
    coalesce(c.id,p.id) AS session_id,substr(coalesce(c.title,p.title),1,512) AS title,p.project_id,
    coalesce(c.directory,p.directory) AS directory,coalesce(c.parent_id,p.parent_id) AS parent_id,
    q.receipt_id AS terminal_receipt,q.outcome_hash AS terminal_hash,q.state AS terminal_state,
    (SELECT count(*) FROM session_v2_provider_turn_receipt v WHERE v.session_id=r.child_session_id
      AND EXISTS (SELECT 1 FROM session_activity x WHERE x.activity_id=v.activity_id AND x.trigger_input_id=r.child_message_id)
      AND v.state IN ('preparing','dispatching','streaming','indeterminate_after_crash')) AS pending_providers,
    (SELECT count(*) FROM session_provider_attempt v WHERE v.session_id=r.child_session_id
      AND EXISTS (SELECT 1 FROM session_activity x WHERE x.activity_id=v.activity_id AND x.trigger_input_id=r.child_message_id)
      AND v.state IN ('prepared','dispatching','streaming','indeterminate_after_crash')) AS pending_attempts,
    (SELECT coalesce(sum(v.attempt_version),0) FROM session_provider_attempt v WHERE v.session_id=r.child_session_id
      AND EXISTS (SELECT 1 FROM session_activity x WHERE x.activity_id=v.activity_id AND x.trigger_input_id=r.child_message_id)) AS attempt_frontier,
    (SELECT v.receipt_id || ':' || v.state || ':' || coalesce(v.outcome_hash,'') FROM session_v2_provider_turn_receipt v
      WHERE v.session_id=r.child_session_id AND EXISTS (SELECT 1 FROM session_activity x WHERE x.activity_id=v.activity_id AND x.trigger_input_id=r.child_message_id)
      ORDER BY v.request_ordinal DESC LIMIT 1) AS provider_frontier,
    (SELECT count(*) FROM session_v2_tool_effect_admission v LEFT JOIN session_v2_tool_effect e
      ON e.receipt_id=v.receipt_id AND e.tool_call_id=v.tool_call_id WHERE v.session_id=r.child_session_id AND e.effect_id IS NULL
      AND EXISTS (SELECT 1 FROM session_v2_provider_turn_receipt p JOIN session_activity x ON x.activity_id=p.activity_id
        WHERE p.receipt_id=v.receipt_id AND x.trigger_input_id=r.child_message_id)) AS pending_effects,
    (SELECT v.admission_id FROM session_v2_tool_effect_admission v WHERE v.session_id=r.child_session_id
      AND EXISTS (SELECT 1 FROM session_v2_provider_turn_receipt p JOIN session_activity x ON x.activity_id=p.activity_id
        WHERE p.receipt_id=v.receipt_id AND x.trigger_input_id=r.child_message_id)
      ORDER BY v.time_created DESC,v.admission_id DESC LIMIT 1) AS effect_frontier
    FROM ${taskFrom} LEFT JOIN session_v2_task_run_receipt q ON q.run_id=r.run_id
      AND q.session_id=r.parent_session_id AND q.child_session_id=r.child_session_id AND q.generation=r.generation
    WHERE ${taskScope} ${options.project ? sql`AND p.project_id=${options.project}` : sql``}
      ${options.after ? sql`AND ('task:' || r.child_session_id || ':' || r.generation)>${options.after}` : sql``}
      ${options.id ? sql`AND r.child_session_id=${options.id.slice(5, options.id.lastIndexOf(":"))} AND r.generation=${Number(options.id.slice(options.id.lastIndexOf(":") + 1))}` : sql``}
    ORDER BY key LIMIT ${options.id ? 1 : BATCH}`,
      )
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map(taskItem)),
      )
  return db
    .all<GoalRow>(
      sql`SELECT ('goal:' || g.goal_id) AS key,g.goal_id,g.revision,g.plan_revision,g.next_seq,g.plan_doc_id,
    g.requested_phase,g.preparation,g.pending_rebase_id,g.recovery_reason,g.created_at,
    p.id AS session_id,substr(p.title,1,512) AS title,p.project_id,p.directory,p.parent_id,
    (SELECT count(*) FROM goal_tick_permit z WHERE z.goal_id=g.goal_id AND z.state!='settled') AS pending_permits,
    (SELECT count(*) FROM goal_tick_permit z WHERE z.goal_id=g.goal_id AND z.state='unknown') AS unknown_permits,
    (SELECT z.permit_id || ':' || z.state || ':' || z.owner_id || ':' || z.interrupt_state FROM goal_tick_permit z
      WHERE z.goal_id=g.goal_id ORDER BY z.tick_seq DESC LIMIT 1) AS permit_frontier,
    (SELECT z.state FROM goal_tick_checkpoint z WHERE z.goal_id=g.goal_id ORDER BY z.tick_seq DESC LIMIT 1) AS checkpoint_state,
    (SELECT z.journal_hash FROM goal_tick_checkpoint z WHERE z.goal_id=g.goal_id ORDER BY z.tick_seq DESC LIMIT 1) AS checkpoint_hash
    FROM ${goalFrom} WHERE ${goalScope}
      ${options.project ? sql`AND p.project_id=${options.project}` : sql``}
      ${options.after ? sql`AND ('goal:' || g.goal_id)>${options.after}` : sql``}
      ${options.id ? sql`AND g.goal_id=${options.id.slice(5)}` : sql``}
    ORDER BY key LIMIT ${options.id ? 1 : BATCH}`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(goalItem)),
    )
}

function common(row: Common) {
  return {
    id: row.key,
    observedAt: Date.now(),
    session: {
      id: row.session_id,
      title: row.title,
      projectID: row.project_id,
      directory: row.directory,
      workspaceID: null,
      ...(row.parent_id ? { parentID: row.parent_id } : {}),
    },
    allowedActions: [],
    seen: false,
    seenAt: null,
  }
}
function taskItem(row: TaskRow): AttentionSchema.Item {
  const terminal = row.state === "error" ? "failed" : row.state
  const consistent = row.terminal_receipt !== null && row.terminal_state === terminal
  const unknown =
    row.pending_providers > 0 ||
    row.pending_attempts > 0 ||
    row.pending_effects > 0 ||
    row.claim !== null ||
    (!consistent && row.execution_owner !== null)
  const recovering = row.state === "recovery_required" || unknown || !consistent
  const state = recovering
    ? "recovery_required"
    : row.control_state === "close_requested"
      ? "close_requested"
      : (terminal as "completed" | "failed" | "closed" | "interrupted" | "cancelled")
  return {
    ...common(row),
    kind: "task",
    state,
    reasonCode: recovering
      ? "task_recovery"
      : row.control_state === "close_requested"
        ? "task_close_requested"
        : "task_result",
    revision: Hash.sha256(JSON.stringify(row)),
    occurredAt: consistent ? row.settled_at : null,
    source: {
      task: {
        runID: row.run_id,
        parentSessionID: row.parent_session_id,
        childSessionID: row.actual_child_id,
        recordedChildSessionID: row.child_session_id,
        generation: row.generation,
        version: row.version,
        state: row.state,
        controlState: row.control_state,
        terminalReceiptID: row.terminal_receipt,
        pendingProviders: row.pending_providers,
        pendingProviderAttempts: row.pending_attempts,
        pendingToolEffects: row.pending_effects,
        hasExecutionClaim: row.claim !== null,
      },
    },
  }
}
function goalItem(row: GoalRow): AttentionSchema.Item {
  const unknown =
    row.unknown_permits > 0 ||
    row.recovery_reason !== null ||
    row.preparation === "recovery_required" ||
    row.checkpoint_state === "recovery_required"
  const state = unknown
    ? "recovery_required"
    : row.requested_phase === "done"
      ? "completed"
      : row.requested_phase === "running"
        ? "execution_claim_pending"
        : (row.requested_phase as "paused" | "stopped" | "needs_human" | "rolled_back")
  return {
    ...common(row),
    kind: "goal",
    state,
    reasonCode: unknown
      ? "goal_recovery"
      : row.requested_phase === "paused"
        ? "goal_paused"
        : row.requested_phase === "stopped"
          ? "goal_stopped"
          : "goal_result",
    revision: Hash.sha256(JSON.stringify(row)),
    occurredAt: row.created_at,
    source: {
      goal: {
        goalID: row.goal_id,
        controlRevision: row.revision,
        planRevision: row.plan_revision,
        nextSeq: row.next_seq,
        planDocID: row.plan_doc_id,
        phase: row.requested_phase,
        preparation: row.preparation,
        pendingRebase: row.pending_rebase_id !== null,
        pendingPermits: row.pending_permits,
        unknownPermits: row.unknown_permits,
        checkpointState: row.checkpoint_state,
        checkpointHash: row.checkpoint_hash,
      },
    },
  }
}
