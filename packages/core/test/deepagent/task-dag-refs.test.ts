import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { TaskDagRefs } from "@deepagent-code/core/deepagent/task-dag-refs"
import { taskDagRefMigration } from "@deepagent-code/core/deepagent/task-dag-ref-sql"
import { TaskRunTable } from "@deepagent-code/core/session/sql"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { AgentExecutionTable } from "@deepagent-code/core/deepagent/agent-execution-sql"
import { ApprovalQueueTable } from "@deepagent-code/core/deepagent/approval-queue-sql"

// C5-08 — unified task DAG terminal reference: typed receipt, integrity check, write isolation, and
// durable-only (post-restart) resolution. Design §5 task DAG + §8.4 durable node + §8.6 durable-only
// reconciliation.

type Db = Database.Interface["db"]

const REF = "ref:".repeat(32)

function run<A, E>(code: (db: Db) => Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* DatabaseMigration.applyOnly(db, [taskDagRefMigration])
      return yield* code(db)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
}

const refusalOf = <A>(effect: Effect.Effect<A, TaskDagRefs.TaskDagRefError>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => error,
      onSuccess: () => undefined,
    }),
  )

const PARENT = SessionSchema.ID.make("ses_c508_parent")
const PROJECT = Project.ID.make("p-c508")
const CHILD = SessionSchema.ID.make("ses_c508_child")

const seedParent = (db: Db) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: PROJECT, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: PARENT,
        project_id: PROJECT,
        slug: "c508-parent",
        directory: "/project",
        title: "parent",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const seedTaskRun = (
  db: Db,
  over: { run_id: string; state: string } & Partial<Omit<typeof TaskRunTable.$inferInsert, "state">>,
) =>
  Effect.gen(function* () {
    yield* seedParent(db)
    const { state, ...rest } = over
    yield* db
      .insert(TaskRunTable)
      .values({
        request_hash: "hash",
        parent_session_id: PARENT,
        parent_message_id: "msg-c508" as never,
        tool_call_id: "tc-c508",
        child_session_id: CHILD,
        generation: 3,
        delivery_mode: "foreground",
        phase: "admission",
        state,
        time_created: 1,
        time_updated: 2,
        ...rest,
      } as never)
      .run()
      .pipe(Effect.orDie)
  })

describe("C5-08 unified task DAG terminal reference", () => {
  test("complete ref: a terminal node with a durable receipt resolves to a full typed reference", async () => {
    await run((db) =>
      Effect.gen(function* () {
        yield* seedTaskRun(db, { run_id: "run_c508_done", state: "completed" })
        const recorded = yield* TaskDagRefs.recordTerminalRef(db, {
          nodeKind: "task_run",
          nodeId: "run_c508_done",
          generation: 3,
          terminalState: "completed",
          receiptRef: REF,
          now: 5,
        })
        const resolved = yield* TaskDagRefs.resolveDagFromRows(db, "run_c508_done")
        expect(resolved?.nodeKind).toBe("task_run")
        expect(resolved?.nodeId).toBe("run_c508_done")
        expect(resolved?.generation).toBe(3)
        expect(resolved?.terminalState).toBe("completed")
        expect(resolved?.receiptRef).toBe(recorded.receiptRef)
        // A complete terminal ref passes integrity (receipt + terminal node both present).
        const err = yield* refusalOf(TaskDagRefs.assertTerminalRefIntegrity(db, resolved!))
        expect(err).toBe(undefined)
      }),
    )
  })

  test("missing-receipt integrity: a terminal node row with NO receipt is a typed integrity failure", async () => {
    await run((db) =>
      Effect.gen(function* () {
        yield* seedTaskRun(db, { run_id: "run_c508_noreceipt", state: "failed" })
        const resolved = yield* TaskDagRefs.resolveDagFromRows(db, "run_c508_noreceipt")
        expect(resolved?.terminalState).toBe("failed")
        expect(resolved?.receiptRef).toBe(undefined)
        const err = yield* refusalOf(TaskDagRefs.assertTerminalRefIntegrity(db, resolved!))
        expect(err?.reason).toBe("terminal_node_missing_receipt")
      }),
    )
  })

  test("receipt-without-terminal-node integrity: a receipt for a node that is NOT terminal is refused", async () => {
    await run((db) =>
      Effect.gen(function* () {
        yield* seedTaskRun(db, { run_id: "run_c508_open", state: "running" })
        yield* TaskDagRefs.recordTerminalRef(db, {
          nodeKind: "task_run",
          nodeId: "run_c508_open",
          generation: 3,
          terminalState: "completed",
          receiptRef: REF,
          now: 5,
        })
        const resolved = yield* TaskDagRefs.resolveDagFromRows(db, "run_c508_open")
        // The receipt was recorded, so the ref surfaces the recorded settlement; the LIVE row (still
        // running) is what the integrity check reads, and it refuses.
        expect(resolved?.receiptRef).toBeDefined()
        const err = yield* refusalOf(TaskDagRefs.assertTerminalRefIntegrity(db, resolved!))
        expect(err?.reason).toBe("receipt_without_terminal_node")
      }),
    )
  })

  test("terminal write refused: assertWritableNode refuses to write a settled node", async () => {
    await run((db) =>
      Effect.gen(function* () {
        yield* seedTaskRun(db, { run_id: "run_c508_settled", state: "completed" })
        const resolved = yield* TaskDagRefs.resolveDagFromRows(db, "run_c508_settled")
        const err = yield* refusalOf(TaskDagRefs.assertWritableNode(db, resolved!))
        expect(err?.reason).toBe("terminal_write_refused")
      }),
    )
  })

  test("conflict refused: assertWritableNode refuses a task_run with an active conflict sub-state", async () => {
    await run((db) =>
      Effect.gen(function* () {
        yield* seedTaskRun(db, { run_id: "run_c508_conflict", state: "running", input_state: "conflict" })
        const resolved = yield* TaskDagRefs.resolveDagFromRows(db, "run_c508_conflict")
        const err = yield* refusalOf(TaskDagRefs.assertWritableNode(db, resolved!))
        expect(err?.reason).toBe("conflict_write_refused")
      }),
    )
  })

  test("durable-only resolution survives a restart (no in-memory registry)", async () => {
    const fs = await import("node:fs/promises")
    const dir = await fs.mkdtemp("/tmp/dsh-c508-")
    const path = `${dir}/db.sqlite`
    // Ensure the receipt table physically exists WITHOUT touching the migration journal: a file DB's
    // preflight lineage check rejects a journal row whose id is not in the frozen migration.gen set
    // (wiring the ledger migration into the shared registry is the main agent's job). Raw idempotent
    // DDL keeps the journal clean so the second layer (the simulated restart) preflights cleanly.
    const ensure = (db: Db) =>
      db
        .run(
          sql`CREATE TABLE IF NOT EXISTS \`deepagent_task_dag_ref\` (
            \`node_kind\` text NOT NULL,
            \`node_id\` text NOT NULL,
            \`generation\` integer NOT NULL,
            \`terminal_state\` text NOT NULL,
            \`receipt_ref\` text NOT NULL,
            \`recorded_at\` integer NOT NULL,
            \`updated_at\` integer NOT NULL,
            CONSTRAINT \`deepagent_task_dag_ref_pk\` PRIMARY KEY(\`node_kind\`, \`node_id\`)
          )`,
        )
        .pipe(Effect.orDie)
    // Layer 1: write the terminal row + receipt.
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* ensure(db)
        yield* seedTaskRun(db, { run_id: "run_c508_restart", state: "closed" })
        yield* TaskDagRefs.recordTerminalRef(db, {
          nodeKind: "task_run",
          nodeId: "run_c508_restart",
          generation: 2,
          terminalState: "closed",
          receiptRef: REF,
          now: 1,
        })
      }).pipe(Effect.provide(Database.layerFromPath(path)), Effect.scoped),
    )
    // Layer 2: a fresh layer (simulated restart) resolves the SAME node purely from durable rows.
    const resolved = await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* ensure(db)
        return yield* TaskDagRefs.resolveDagFromRows(db, "run_c508_restart")
      }).pipe(Effect.provide(Database.layerFromPath(path)), Effect.scoped),
    )
    expect(resolved?.nodeKind).toBe("task_run")
    expect(resolved?.terminalState).toBe("closed")
    expect(resolved?.generation).toBe(2)
    expect(resolved?.receiptRef).toBe(REF)
  })

  test("agent_execution node kind resolves and is write-refused when terminal", async () => {
    await run((db) =>
      Effect.gen(function* () {
        yield* db
          .insert(AgentExecutionTable)
          .values({
            workspace_id: "ws-c508",
            event_id: DeepAgentEvent.ID.create(1_000),
            task_id: "task-c508",
            status: "completed",
            generation: 1,
            artifacts: [],
            tokens_used: 0,
            created_at: 1,
            updated_at: 2,
          })
          .run()
          .pipe(Effect.orDie)
        const resolved = yield* TaskDagRefs.resolveDagFromRows(db, "task-c508")
        expect(resolved?.nodeKind).toBe("agent_execution")
        expect(resolved?.terminalState).toBe("completed")
        const err = yield* refusalOf(TaskDagRefs.assertWritableNode(db, resolved!))
        expect(err?.reason).toBe("terminal_write_refused")
      }),
    )
  })

  test("approval node kind resolves; a resolved approval is terminal", async () => {
    await run((db) =>
      Effect.gen(function* () {
        yield* db
          .insert(ApprovalQueueTable)
          .values({
            id: "ap-c508",
            workspace_id: "ws-c508",
            event_id: DeepAgentEvent.ID.create(1_001),
            event_type: "goal.needs_human",
            summary: "needs human",
            status: "resolved",
            decision: "approved",
            created_at: 1,
          })
          .run()
          .pipe(Effect.orDie)
        const resolved = yield* TaskDagRefs.resolveDagFromRows(db, "ap-c508")
        expect(resolved?.nodeKind).toBe("approval")
        expect(resolved?.terminalState).toBe("resolved")
        const err = yield* refusalOf(TaskDagRefs.assertWritableNode(db, resolved!))
        expect(err?.reason).toBe("terminal_write_refused")
      }),
    )
  })
})
