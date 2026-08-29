export * as TaskDagRefs from "./task-dag-refs"

import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { TaskRunTable } from "../session/sql"
import { AgentExecutionTable } from "./agent-execution-sql"
import { ApprovalQueueTable } from "./approval-queue-sql"
import { DeepAgentTaskDagRefTable, type TaskDagNodeKind } from "./task-dag-ref-sql"

// C5-08 — UNIFIED task DAG terminal reference. Design authority: docs/core-v2.0-beta/design.md §5
// (task DAG) + §8.4 (durable node + terminal receipt) + §8.6 (durable-only reconciliation; no
// in-memory registry). A caller that writes a DAG node (runs a task, settles an execution, resolves an
// approval, provisions a worktree, arbitrates a conflict) needs ONE typed reference and a restart-safe
// way to (a) prove the node is terminal, (b) refuse to write a terminal/conflicted node, and (c)
// reconcile the DAG purely from durable rows.
//
// The module is DURABLE-ONLY: every read goes through `db`, never an in-memory registry, so a
// reference resolved before a restart is re-derivable identically after one. The durable node rows are
// the live source of truth (`task_run` / `deepagent_agent_execution` / `deepagent_approval_queue`),
// and the `deepagent_task_dag_ref` ledger is the durable receipt binding them to terminal state.
//
// LAYERING: `core`. Reads only the durable tables; no session runtime, no dispatch, no legacy runner.

type DatabaseClient = Database.Interface["db"]

// ── Node identity + terminal-state vocabulary ────────────────────────────────────────────────

// Terminal (settled) states per durable node kind. A node OUTSIDE this set is still open for writes.
const TASK_RUN_TERMINAL = new Set(["completed", "error", "cancelled", "interrupted", "failed", "closed"])
const AGENT_EXECUTION_TERMINAL = new Set(["completed", "failed"])
const APPROVAL_TERMINAL = new Set(["resolved"])
const WORKTREE_TERMINAL = new Set(["retained", "submitted", "removed"])
// A conflict node is terminal once it has been RESOLVED (re-claimed enough to clear the conflict).
const CONFLICT_TERMINAL = new Set(["resolved"])

/** The live durable node read for a kind: given a `nodeId`, is the row terminal + at what generation? */
interface NodeRead {
  readonly terminal: boolean
  readonly terminalState?: string
  readonly generation: number
}

const isTerminalState = (kind: TaskDagNodeKind, state: string): boolean => {
  switch (kind) {
    case "task_run":
      return TASK_RUN_TERMINAL.has(state)
    case "agent_execution":
      return AGENT_EXECUTION_TERMINAL.has(state)
    case "approval":
      return APPROVAL_TERMINAL.has(state)
    case "worktree":
      return WORKTREE_TERMINAL.has(state)
    case "conflict":
      return CONFLICT_TERMINAL.has(state)
  }
}

// ── Typed failure vocabulary ─────────────────────────────────────────────────────────────────

/** Why a task-DAG reference operation failed. Fail-closed; each reason is a typed refusal. */
export type TaskDagRefErrorReason =
  | "unknown_node_kind"
  | "node_unresolved"
  | "terminal_node_missing_receipt"
  | "receipt_without_terminal_node"
  | "terminal_write_refused"
  | "conflict_write_refused"

/** Typed refusal thrown through the Effect failure channel (never a buried throw). */
export class TaskDagRefError extends Error {
  readonly _tag = "TaskDagRefs.TaskDagRefError"
  readonly reason: TaskDagRefErrorReason
  readonly nodeKind: TaskDagNodeKind
  readonly nodeId: string
  constructor(reason: TaskDagRefErrorReason, nodeKind: string, nodeId: string, message: string) {
    super(message)
    this.name = "TaskDagRefError"
    this.reason = reason
    this.nodeKind = nodeKind as TaskDagNodeKind
    this.nodeId = nodeId
  }
}

const fail = (reason: TaskDagRefErrorReason, nodeKind: string, nodeId: string, message: string) =>
  Effect.fail(new TaskDagRefError(reason, nodeKind, nodeId, message))

/** Endorse a node kind string (undefined → typed refusal). */
const endorseKind = (kind: string): kind is TaskDagNodeKind =>
  kind === "task_run" || kind === "agent_execution" || kind === "approval" || kind === "worktree" || kind === "conflict"

// ── The unified typed terminal reference ────────────────────────────────────────────────────

/**
 * The unified typed reference to a terminal (or open) task-DAG node. `receiptRef` is the content-
 * addressed receipt proof of the node's terminal outcome, when one has been durably recorded; it is
 * absent for a node that is open or for which the settling consumer has not yet recorded the receipt
 * (which `assertTerminalRefIntegrity` then flags as a missing-receipt integrity failure).
 */
export interface TaskDagRef {
  readonly nodeKind: TaskDagNodeKind
  readonly nodeId: string
  readonly generation: number
  readonly terminalState?: string
  readonly receiptRef?: string
}

const decodeLedger = (
  row: typeof DeepAgentTaskDagRefTable.$inferSelect,
): TaskDagRef => ({
  nodeKind: row.node_kind,
  nodeId: row.node_id,
  generation: row.generation,
  terminalState: row.terminal_state,
  receiptRef: row.receipt_ref,
})

/** The durable receipt row for a (nodeKind, nodeId), if recorded. */
function receiptFor(db: DatabaseClient, nodeKind: TaskDagNodeKind, nodeId: string): Effect.Effect<TaskDagRef | undefined> {
  return Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(DeepAgentTaskDagRefTable)
      .where(and(eq(DeepAgentTaskDagRefTable.node_kind, nodeKind), eq(DeepAgentTaskDagRefTable.node_id, nodeId)))
      .get()
      .pipe(Effect.orDie)
    return row ? decodeLedger(row) : undefined
  })
}

// ── Live durable node readers ────────────────────────────────────────────────────────────────

/** Read a `task_run` node's durable state. */
function readTaskRun(db: DatabaseClient, nodeId: string): Effect.Effect<NodeRead | undefined> {
  return Effect.gen(function* () {
    const row = yield* db
      .select({ state: TaskRunTable.state, generation: TaskRunTable.generation, worktree_state: TaskRunTable.worktree_state })
      .from(TaskRunTable)
      .where(eq(TaskRunTable.run_id, nodeId))
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    const state = row.state as string
    return {
      terminal: TASK_RUN_TERMINAL.has(state),
      terminalState: TASK_RUN_TERMINAL.has(state) ? state : undefined,
      generation: row.generation,
    }
  })
}

/** Read an `agent_execution` node's durable state (keyed by its `task_id`). */
function readAgentExecution(db: DatabaseClient, nodeId: string): Effect.Effect<NodeRead | undefined> {
  return Effect.gen(function* () {
    const row = yield* db
      .select({ status: AgentExecutionTable.status, generation: AgentExecutionTable.generation, task_id: AgentExecutionTable.task_id })
      .from(AgentExecutionTable)
      .where(eq(AgentExecutionTable.task_id, nodeId))
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    const status = row.status as string
    return {
      terminal: AGENT_EXECUTION_TERMINAL.has(status),
      terminalState: AGENT_EXECUTION_TERMINAL.has(status) ? status : undefined,
      generation: row.generation,
    }
  })
}

/** Read an `approval` node's durable state (keyed by its queue-item `id`). */
function readApproval(db: DatabaseClient, nodeId: string): Effect.Effect<NodeRead | undefined> {
  return Effect.gen(function* () {
    const row = yield* db
      .select({ status: ApprovalQueueTable.status, created_at: ApprovalQueueTable.created_at })
      .from(ApprovalQueueTable)
      .where(eq(ApprovalQueueTable.id, nodeId))
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    const status = row.status as string
    return {
      terminal: APPROVAL_TERMINAL.has(status),
      terminalState: APPROVAL_TERMINAL.has(status) ? status : undefined,
      generation: row.created_at,
    }
  })
}

/** Read a `worktree` node's durable state — the owning `task_run` row's `worktree_state` facet. */
function readWorktree(db: DatabaseClient, nodeId: string): Effect.Effect<NodeRead | undefined> {
  return Effect.gen(function* () {
    const row = yield* db
      .select({ worktree_state: TaskRunTable.worktree_state, generation: TaskRunTable.generation })
      .from(TaskRunTable)
      .where(eq(TaskRunTable.run_id, nodeId))
      .get()
      .pipe(Effect.orDie)
    if (!row || row.worktree_state === "none") return undefined
    const state = row.worktree_state as string
    return {
      terminal: WORKTREE_TERMINAL.has(state),
      terminalState: WORKTREE_TERMINAL.has(state) ? state : undefined,
      generation: row.generation,
    }
  })
}

/** Read a `conflict` node's durable state — the owning `task_run` row's conflict-capable sub-states. */
function readConflict(db: DatabaseClient, nodeId: string): Effect.Effect<NodeRead | undefined> {
  return Effect.gen(function* () {
    const row = yield* db
      .select({ input_state: TaskRunTable.input_state, workspace_branch_state: TaskRunTable.workspace_branch_state, generation: TaskRunTable.generation })
      .from(TaskRunTable)
      .where(eq(TaskRunTable.run_id, nodeId))
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    const conflicted = row.input_state === "conflict" || row.workspace_branch_state === "conflict"
    // A `task_run` row is only a CONFLICT node while a conflict is present; `run_id` without an active
    // conflict sub-state is not a conflict node.
    if (!conflicted) return undefined
    const state = "active"
    return {
      terminal: CONFLICT_TERMINAL.has(state),
      terminalState: CONFLICT_TERMINAL.has(state) ? state : undefined,
      generation: row.generation,
    }
  })
}

function readNode(db: DatabaseClient, kind: TaskDagNodeKind, nodeId: string): Effect.Effect<NodeRead | undefined> {
  switch (kind) {
    case "task_run":
      return readTaskRun(db, nodeId)
    case "agent_execution":
      return readAgentExecution(db, nodeId)
    case "approval":
      return readApproval(db, nodeId)
    case "worktree":
      return readWorktree(db, nodeId)
    case "conflict":
      return readConflict(db, nodeId)
  }
}

// ── Durable-only resolution (no in-memory registry) ─────────────────────────────────────────

/** Resolve a node by probing the durable rows; `undefined` if no durable row matches `nodeId`. */
function resolveRow(db: DatabaseClient, nodeId: string): Effect.Effect<{ kind: TaskDagNodeKind; read: NodeRead } | undefined> {
  return Effect.gen(function* () {
    const run = yield* readTaskRun(db, nodeId)
    if (run) return { kind: "task_run" as const, read: run }
    const exec = yield* readAgentExecution(db, nodeId)
    if (exec) return { kind: "agent_execution" as const, read: exec }
    const approval = yield* readApproval(db, nodeId)
    if (approval) return { kind: "approval" as const, read: approval }
    return undefined
  })
}

export interface RecordTerminalInput {
  readonly nodeKind: TaskDagNodeKind
  readonly nodeId: string
  readonly generation: number
  readonly terminalState: string
  readonly receiptRef: string
  readonly now: number
}

/**
 * Record the durable terminal receipt for a node. Idempotent: re-recording the SAME (nodeKind, nodeId)
 * with the SAME terminal state + receipt is a no-op returning the existing row; a DIFFERENT terminal
 * state or receipt for the same identity is a typed `receipt_conflict`... (the row is overwritten only
 * when recorded once and then re-settled to a NEW state, which is refused as an already-terminal node).
 */
export function recordTerminalRef(db: DatabaseClient, input: RecordTerminalInput): Effect.Effect<TaskDagRef, TaskDagRefError> {
  return Effect.gen(function* () {
    if (!endorseKind(input.nodeKind)) {
      return yield* fail("unknown_node_kind", input.nodeKind, input.nodeId, `unknown node kind "${input.nodeKind}"`)
    }
    const existing = yield* receiptFor(db, input.nodeKind, input.nodeId)
    if (existing) {
      if (existing.terminalState === input.terminalState && existing.receiptRef === input.receiptRef) return existing
      // Re-settling an already-terminal node to a DIFFERENT terminal receipt is refused.
      return yield* fail("terminal_write_refused", input.nodeKind, input.nodeId, `node ${input.nodeKind}/${input.nodeId} is already terminal at state "${existing.terminalState}"`)
    }
    yield* db
      .insert(DeepAgentTaskDagRefTable)
      .values([
        {
          node_kind: input.nodeKind,
          node_id: input.nodeId,
          generation: input.generation,
          terminal_state: input.terminalState,
          receipt_ref: input.receiptRef,
          recorded_at: input.now,
          updated_at: input.now,
        },
      ])
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const row = yield* db
      .select()
      .from(DeepAgentTaskDagRefTable)
      .where(and(eq(DeepAgentTaskDagRefTable.node_kind, input.nodeKind), eq(DeepAgentTaskDagRefTable.node_id, input.nodeId)))
      .get()
      .pipe(Effect.orDie)
    return decodeLedger(row!)
  })
}

/**
 * Durable-only resolution. Given a `nodeId`, read the LIVE durable node row to determine its kind and
 * current state, then overlay the durable receipt (if recorded) to complete the reference. Works after
 * a restart because nothing is cached in memory.
 */
export function resolveDagFromRows(db: DatabaseClient, nodeId: string): Effect.Effect<TaskDagRef | undefined, TaskDagRefError> {
  return Effect.gen(function* () {
    const resolved = yield* resolveRow(db, nodeId)
    if (!resolved) return undefined
    const { kind, read } = resolved
    const receipt = yield* receiptFor(db, kind, nodeId)
    // When a durable receipt is recorded, the reference is the TERMINAL settlement — its generation
    // and terminal state are the receipt's (the authoritative settlement proof), not the live row's.
    // An un-receipted node falls back to the live row so an open/terminal-with-no-receipt node is
    // reported as it actually is (and the integrity check flags the missing receipt).
    const generation = receipt?.generation ?? read.generation
    const terminalState = receipt?.terminalState ?? read.terminalState
    return {
      nodeKind: kind,
      nodeId,
      generation,
      ...(terminalState != null ? { terminalState } : {}),
      ...(receipt?.receiptRef != null ? { receiptRef: receipt.receiptRef } : {}),
    }
  })
}

/**
 * Integrity check. A terminal durable NODE ROW must have a matching durable receipt, and a durable
 * RECEIPT must reference a truly terminal node. Either side alone is a typed integrity failure:
 *   - `terminal_node_missing_receipt`  the node row is terminal but no receipt has been recorded.
 *   - `receipt_without_terminal_node`  a receipt exists but the node row is NOT terminal.
 */
export function assertTerminalRefIntegrity(db: DatabaseClient, ref: TaskDagRef): Effect.Effect<void, TaskDagRefError> {
  return Effect.gen(function* () {
    if (!endorseKind(ref.nodeKind)) {
      return yield* fail("unknown_node_kind", ref.nodeKind, ref.nodeId, `unknown node kind "${ref.nodeKind}"`)
    }
    const node = yield* readNode(db, ref.nodeKind, ref.nodeId)
    // A receipt WITHOUT a terminal node row: the receipt exists but the node is not terminal.
    if (ref.receiptRef != null && (!node || !node.terminal)) {
      return yield* fail("receipt_without_terminal_node", ref.nodeKind, ref.nodeId, `receipt "${ref.receiptRef}" references a node that is not terminal`)
    }
    // A terminal node row WITHOUT a matching receipt.
    if (node?.terminal && ref.receiptRef == null) {
      return yield* fail("terminal_node_missing_receipt", ref.nodeKind, ref.nodeId, `node ${ref.nodeKind}/${ref.nodeId} is terminal but has no durable receipt`)
    }
    return undefined
  })
}

/**
 * Write isolation. Refuses to write a node that is TERMINAL (`terminal_write_refused`) or CONFLICTED
 * (an active conflict sub-state — `conflict_write_refused`). Never silently proceeds over a settled or
 * contested node.
 */
export function assertWritableNode(db: DatabaseClient, ref: TaskDagRef): Effect.Effect<void, TaskDagRefError> {
  return Effect.gen(function* () {
    if (!endorseKind(ref.nodeKind)) {
      return yield* fail("unknown_node_kind", ref.nodeKind, ref.nodeId, `unknown node kind "${ref.nodeKind}"`)
    }
    const node = yield* readNode(db, ref.nodeKind, ref.nodeId)
    if (node?.terminal) {
      return yield* fail("terminal_write_refused", ref.nodeKind, ref.nodeId, `node ${ref.nodeKind}/${ref.nodeId} is terminal at "${node.terminalState}" and must not be written`)
    }
    // For a task_run facet, an active conflict sub-state is a hard write barrier.
    if (ref.nodeKind === "task_run" || ref.nodeKind === "worktree" || ref.nodeKind === "conflict") {
      const conflict = yield* readConflict(db, ref.nodeId)
      if (conflict && !conflict.terminal) {
        return yield* fail("conflict_write_refused", ref.nodeKind, ref.nodeId, `node ${ref.nodeKind}/${ref.nodeId} has an active conflict and must not be written`)
      }
    }
    return undefined
  })
}
