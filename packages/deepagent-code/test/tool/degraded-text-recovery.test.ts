/**
 * QUAL-005 (BUG-405-011 residue): degraded_text crash recovery + idempotent foreground metadata
 * repair, driven through the real task-run state machine (admit → claim → start → research →
 * finalize → seal evidence). No terminal task_run rows are inserted directly.
 *
 * Covers:
 *   1. recoverExpiredTaskRuns recovers a finalizing run whose executor crashed AFTER sealing its
 *      degraded_text receipt (persistDegradedStructuredOutput): the durable result must survive
 *      as completed/structured_output_degraded_text instead of being destroyed as
 *      execution_lease_expired. Recovered completions are excluded from the returned runs so the
 *      notification pump never projects them as expired errors.
 *   2. The idempotent foreground metadata repair (repairDurableSettledRunProjections) projects the
 *      recovered completion into the child session metadata exactly once.
 *   3. Unsealed finalizing runs still settle as failed/execution_lease_expired (prior behavior).
 *   4. Background delivery mode: recovery completes the run and enqueues the terminal
 *      notification outbox entry.
 */
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import {
  SessionTable,
  TaskNotificationOutboxTable,
  TaskRunEventTable,
  TaskRunTable,
} from "@deepagent-code/core/session/sql"
import { Session } from "../../src/session/session"
import { MessageID, SessionID } from "../../src/session/schema"
import {
  admitTaskRun,
  claimTaskProvisioning,
  markTaskFinalizing,
  markTaskResearchCompleted,
  recoverExpiredTaskRuns,
  startTaskRun,
} from "../../src/tool/task-run"
import {
  makeDegradedStructuredOutput,
  persistDegradedStructuredOutput,
} from "../../src/tool/task-structured-output-evidence"
import { repairDurableSettledRunProjections } from "../../src/tool/task"
import { testEffect } from "../lib/effect"

const database = Layer.mergeAll(Database.layerFromPath(":memory:"), CrossSpawnSpawner.defaultLayer)
const it = testEffect(database)
const directory = "/project"
const parentSessionID = SessionID.make("ses_degraded_recovery_parent")

const contract = {
  schema: {
    type: "object",
    properties: { result: { type: "string" } },
    required: ["result"],
    additionalProperties: false,
  },
  allowTextFallback: true,
  receiptVersion: 1 as const,
  maxAttempts: 2 as const,
}

const receipt = { attempt: 2, transport: "degraded_text", reason: "structured_output_missing" } as const
const researchText = "persisted degraded research"
const degradedOutput = makeDegradedStructuredOutput(researchText, receipt)

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: parentSessionID,
      project_id: ProjectV2.ID.global,
      slug: "degraded-recovery-parent",
      directory,
      title: "parent",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

/**
 * Drives the real state machine to the exact crash window: the executor finished research,
 * entered finalize, and persisted the raw result message. The caller decides whether the degraded
 * receipt gets sealed before the simulated crash.
 */
const driveToFinalizing = (suffix: string, deliveryMode: "foreground" | "background" = "foreground") =>
  Effect.gen(function* () {
    yield* setup
    const time = Date.now()
    const admission = yield* admitTaskRun({
      parentSessionID,
      parentMessageID: MessageID.ascending(`msg_degraded_${suffix}`),
      toolCallID: `call_degraded_${suffix}`,
      request: { prompt: "research", subagent_type: "researcher" },
      deliveryMode,
      executionSpec: {
        prompt: { text: "research" },
        agent: "researcher",
        model: { providerID: "test", modelID: "test" },
        structuredOutput: contract,
      },
    })
    const claimed = (yield* claimTaskProvisioning({
      run: admission.run,
      owner: "worker",
      now: time,
      leaseMs: 60_000,
    }))!
    const running = (yield* startTaskRun(claimed, "worker", time + 1, 60_000))!
    const { db } = yield* Database.Service
    const rawMessageID = MessageID.ascending(`msg_degraded_raw_${suffix}`)
    yield* db.run(sql`
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (
        ${running.childSessionID}, ${ProjectV2.ID.global},
        ${`degraded-${suffix}`}, ${directory}, 'child', 'test', ${time}, ${time}
      )
    `)
    yield* db.run(sql`
      INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (${rawMessageID}, ${running.childSessionID}, ${time + 2}, ${time + 2}, '{"role":"assistant"}')
    `)
    yield* db.run(sql`
      INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES (
        ${`prt_degraded_${suffix}`}, ${rawMessageID}, ${running.childSessionID},
        ${time + 2}, ${time + 2}, ${JSON.stringify({ type: "text", text: researchText })}
      )
    `)
    yield* markTaskResearchCompleted(running, "worker", rawMessageID, time + 2)
    yield* markTaskFinalizing(running, "worker", receipt.attempt, rawMessageID, time + 3)
    return { time, run: running, rawMessageID }
  })

describe("tool.degraded-text-recovery", () => {
  it.effect("recovers a sealed degraded_text completion and repairs foreground metadata idempotently", () =>
    Effect.gen(function* () {
      const { time, run, rawMessageID } = yield* driveToFinalizing("sealed")

      // Seal the degraded receipt, then crash without settling (the lease simply expires).
      yield* persistDegradedStructuredOutput({
        runID: run.runID,
        childSessionID: run.childSessionID,
        ownerToken: "worker",
        claimGeneration: run.claimGeneration,
        sourceMessageID: rawMessageID,
        contract,
        receipt,
        output: degradedOutput,
        now: time + 4,
      })
      const recovered = yield* recoverExpiredTaskRuns({ directory, now: time + 120_000 })

      // Recovered completions are NOT surfaced for expired-error projection.
      expect(recovered).toEqual([])

      const { db } = yield* Database.Service
      const row = (yield* db
        .select()
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, run.runID))
        .get()
        .pipe(Effect.orDie))!
      expect(row.state).toBe("completed")
      expect(row.phase).toBe("settled")
      expect(row.control_state).toBe("closed")
      expect(row.reason).toBe("structured_output_degraded_text")
      expect(row.output).toBe(degradedOutput)
      expect(row.structured_output_receipt).toEqual(receipt)
      expect(row.structured_result_message_id).toBeNull()
      expect(row.execution_owner).toBeNull()
      expect(row.time_settled).toBe(time + 120_000)

      expect(
        yield* db
          .select({ type: TaskRunEventTable.type, reason: TaskRunEventTable.reason })
          .from(TaskRunEventTable)
          .where(eq(TaskRunEventTable.run_id, run.runID))
          .all()
          .pipe(Effect.orDie),
      ).toContainEqual({ type: "structured_response_recovered", reason: "persisted_degraded_receipt" })

      // Idempotent: a second recovery pass finds nothing and changes nothing.
      expect(yield* recoverExpiredTaskRuns({ directory, now: time + 240_000 })).toEqual([])
      expect(
        ((yield* db
          .select({ version: TaskRunTable.version })
          .from(TaskRunTable)
          .where(eq(TaskRunTable.run_id, run.runID))
          .get()
          .pipe(Effect.orDie)) as { version: number }).version,
      ).toBe(row.version)

      // Foreground metadata repair: the child session still believes it is finalizing; the
      // durable-cp startup repair must project the recovered completion exactly once.
      const holder: { info: Session.Info } = {
        info: {
          id: run.childSessionID,
          slug: "degraded-child",
          projectID: ProjectV2.ID.global,
          directory,
          parentID: parentSessionID,
          title: "child",
          version: "test",
          metadata: {
            deepagent: {
              subagent: {
                finished: false,
                state: "finalizing",
                phase: "finalize",
                attempts: receipt.attempt,
                run_id: run.runID,
                generation: run.generation,
                raw_result_ref: rawMessageID,
              },
            },
          },
          time: { created: time, updated: time + 4 },
        },
      }
      const sessions = {
        get: () => Effect.succeed(holder.info),
        setMetadata: (input: { readonly metadata: Session.Info["metadata"] }) =>
          Effect.sync(() => {
            holder.info = { ...holder.info, metadata: input.metadata }
          }),
      } as unknown as Session.Interface

      expect(yield* repairDurableSettledRunProjections(sessions, { directory })).toBe(1)
      expect(yield* repairDurableSettledRunProjections(sessions, { directory })).toBe(0)
      expect(holder.info.metadata?.deepagent).toEqual({
        subagent: {
          finished: true,
          state: "completed",
          phase: "settled",
          run_id: run.runID,
          generation: run.generation,
          settled_at: time + 120_000,
          reason: "structured_output_degraded_text",
          attempts: receipt.attempt,
          raw_result_ref: rawMessageID,
          structured_output: receipt,
        },
      })
    }),
  )

  it.effect("still settles unsealed finalizing runs as execution_lease_expired", () =>
    Effect.gen(function* () {
      const { time, run } = yield* driveToFinalizing("unsealed")

      // Crash without sealing any receipt — the pre-existing failure path must be preserved.
      const recovered = yield* recoverExpiredTaskRuns({ directory, now: time + 120_000 })
      expect(recovered).toHaveLength(1)
      expect(recovered[0].runID).toBe(run.runID)
      expect(recovered[0].state).toBe("failed")
      expect(recovered[0].reason).toBe("execution_lease_expired")

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(TaskNotificationOutboxTable).all().pipe(Effect.orDie),
      ).toHaveLength(1)
    }),
  )

  it.effect("recovers a sealed background completion with its terminal notification", () =>
    Effect.gen(function* () {
      const { time, run, rawMessageID } = yield* driveToFinalizing("background", "background")
      yield* persistDegradedStructuredOutput({
        runID: run.runID,
        childSessionID: run.childSessionID,
        ownerToken: "worker",
        claimGeneration: run.claimGeneration,
        sourceMessageID: rawMessageID,
        contract,
        receipt,
        output: degradedOutput,
        now: time + 4,
      })

      expect(yield* recoverExpiredTaskRuns({ directory, now: time + 120_000 })).toEqual([])

      const { db } = yield* Database.Service
      const row = (yield* db
        .select()
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, run.runID))
        .get()
        .pipe(Effect.orDie))!
      expect(row.state).toBe("completed")
      expect(row.reason).toBe("structured_output_degraded_text")
      expect(row.structured_output_receipt).toEqual(receipt)

      const notifications = yield* db.select().from(TaskNotificationOutboxTable).all().pipe(Effect.orDie)
      expect(notifications).toHaveLength(1)
      expect(notifications[0].payload.text).toContain("Background task completed")
      expect(notifications[0].payload.text).toContain(run.childSessionID)
    }),
  )
})
