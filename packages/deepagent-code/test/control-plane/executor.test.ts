/**
 * DET-FENCE-01: startExecution + settleRun CAS/lease/generation fences
 *
 * Covers:
 *  - startExecution: correct params succeed; wrong generation/owner/input_state fail
 *  - settleRun: correct params produce won=true; expired lease/wrong generation produce won=false
 *  - Audit trail: task_run_event rows written co-transactionally
 *
 * Design refs: §5 (stale callback), §6.4 (start fence), §6.7 (settle priority), §1.3 #24 (events)
 */
import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { and, eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import {
  MessageTable,
  PartTable,
  SessionTable,
  TaskRunTable,
  TaskRunEventTable,
  TaskStructuredFinalizerResponseTable,
  TaskStructuredOutputEvidenceTable,
} from "@deepagent-code/core/session/sql"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { SessionID, MessageID } from "../../src/session/schema"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import {
  markStructuredFinalizerAttempt,
  run as runExecutor,
  startExecution,
  settleRun,
} from "../../src/session/task-executor"
import { classifyOnStartup, requestClose, requestInterrupt } from "../../src/tool/task-run"
import { makeDegradedStructuredOutput } from "../../src/tool/task-structured-output-evidence"
import { testEffect } from "../lib/effect"

const database = Layer.mergeAll(Database.layerFromPath(":memory:"), CrossSpawnSpawner.defaultLayer)
const it = testEffect(database)

const PARENT_SID = SessionID.make("ses_exec_parent")
const DIRECTORY = "/exec_test_dir"
const OWNER = "test_owner_1"
const CLAIM_GEN = 1

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
      id: PARENT_SID,
      project_id: ProjectV2.ID.global,
      slug: "exec-parent",
      directory: DIRECTORY,
      title: "parent",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const insertProvisioningRun = (
  runID: string,
  childID: string,
  opts: {
    owner?: string
    version?: number
    claimGen?: number
    leaseExpiry?: number
    inputState?: string
    executionSpec?: Record<string, unknown>
  } = {},
) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = Date.now()
    const childSID = SessionID.make(childID)
    yield* db
      .insert(SessionTable)
      .values({
        id: childSID,
        project_id: ProjectV2.ID.global,
        slug: `exec-child-${runID}`,
        directory: DIRECTORY,
        title: `child-${runID}`,
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    // tsgo: run_id is a TEXT primaryKey() with no default — required in insert type,
    // but tsgo's Drizzle generic resolution incorrectly excludes it. Cast via any.
    yield* db
      .insert(TaskRunTable)
      .values({
        run_id: runID,
        request_hash: "rhash",
        parent_session_id: PARENT_SID,
        parent_message_id: MessageID.ascending(`msg_${runID}`) as any,
        tool_call_id: `tc_${runID}`,
        child_session_id: childSID,
        generation: 1,
        delivery_mode: "foreground",
        phase: "provision",
        state: "provisioning",
        version: opts.version ?? 0,
        control_state: "open",
        input_state: opts.inputState ?? "ready",
        execution_owner: opts.owner ?? OWNER,
        lease_expires_at: opts.leaseExpiry ?? now + 60_000,
        claim_generation: opts.claimGen ?? CLAIM_GEN,
        available_at: 0,
        start_attempts: 1,
        attempts: 1,
        time_created: now,
        time_updated: now,
        execution_spec: opts.executionSpec,
      } as any)
      .run()
      .pipe(Effect.orDie)
  })

const assistantMessage = (id: string, text: string) =>
  ({
    info: { id, role: "assistant" },
    parts: [{ type: "text", text, synthetic: false, ignored: false }],
  }) as unknown as SessionV1.WithParts

const structuredExecutionSpec = {
  prompt: { text: "inspect" },
  agent: "researcher",
  model: { providerID: "test", modelID: "test" },
  structuredOutput: {
    schema: { type: "object" },
    allowTextFallback: true,
    receiptVersion: 1 as const,
    maxAttempts: 2 as const,
  },
}

const insertAssistantEvidence = (sessionID: SessionID, messageID: MessageID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(MessageTable)
      .values({
        id: messageID,
        session_id: sessionID,
        data: { role: "assistant" },
        time_created: Date.now(),
        time_updated: Date.now(),
      } as any)
      .run()
      .pipe(Effect.orDie)
  })

// ── startExecution ────────────────────────────────────────────────────────────

describe("DET-FENCE-01 startExecution CAS", () => {
  it.effect("correct owner/version/claimGen → transitions to running + writes event", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertProvisioningRun("run_se_ok", "ses_exec_se_ok")

      const { db } = yield* Database.Service
      const run = {
        runID: "run_se_ok",
        version: 0,
        claimGeneration: CLAIM_GEN,
        inputState: "ready" as const,
        controlState: "open" as const,
        state: "provisioning" as const,
        phase: "provision" as const,
        // minimal run shape needed by startExecution
      } as any
      yield* startExecution({ run, ownerToken: OWNER, leaseMs: 30_000 })

      const row = yield* db
        .select({ state: TaskRunTable.state, version: TaskRunTable.version })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, "run_se_ok"))
        .get()
        .pipe(Effect.orDie)
      expect(row?.state).toBe("running")
      expect(row?.version).toBe(1)

      const events = yield* db
        .select({ type: TaskRunEventTable.type })
        .from(TaskRunEventTable)
        .where(eq(TaskRunEventTable.run_id, "run_se_ok"))
        .all()
        .pipe(Effect.orDie)
      expect(events.some((e) => e.type === "execution_started")).toBe(true)
    }),
  )

  it.effect("wrong claim_generation → ExecutorClaimLostError", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertProvisioningRun("run_se_badgen", "ses_exec_se_badgen")

      const run = { runID: "run_se_badgen", version: 0, claimGeneration: 99 } as any
      const result = yield* startExecution({ run, ownerToken: OWNER }).pipe(
        Effect.map(() => "ok" as const),
        Effect.catchTag("LegacySubagentExecutor.ClaimLost", () => Effect.succeed("claim_lost" as const)),
      )
      expect(result).toBe("claim_lost")
    }),
  )

  it.effect("wrong owner → ExecutorClaimLostError", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertProvisioningRun("run_se_badowner", "ses_exec_se_badowner")

      const run = { runID: "run_se_badowner", version: 0, claimGeneration: CLAIM_GEN } as any
      const result = yield* startExecution({ run, ownerToken: "wrong_owner" }).pipe(
        Effect.map(() => "ok" as const),
        Effect.catchTag("LegacySubagentExecutor.ClaimLost", () => Effect.succeed("claim_lost" as const)),
      )
      expect(result).toBe("claim_lost")
    }),
  )

  it.effect("input_state='legacy' (not ready) → ExecutorClaimLostError", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertProvisioningRun("run_se_notready", "ses_exec_se_notready", { inputState: "legacy" })

      const run = { runID: "run_se_notready", version: 0, claimGeneration: CLAIM_GEN } as any
      const result = yield* startExecution({ run, ownerToken: OWNER }).pipe(
        Effect.map(() => "ok" as const),
        Effect.catchTag("LegacySubagentExecutor.ClaimLost", () => Effect.succeed("claim_lost" as const)),
      )
      expect(result).toBe("claim_lost")
    }),
  )
})

// ── settleRun ─────────────────────────────────────────────────────────────────

describe("DET-FENCE-01 settleRun CAS + lease fence", () => {
  const settleParams = (runID: string) => ({
    runID,
    parentSessionID: PARENT_SID as string,
    ownerToken: OWNER,
    claimGeneration: CLAIM_GEN,
    deliveryMode: "foreground" as const,
    directory: DIRECTORY,
    agentType: "task",
    state: "completed" as const,
    reason: "test_settled",
  })

  it.effect("correct params → won=true, state=completed, run_settled event", () =>
    Effect.gen(function* () {
      yield* setup
      // Start as running (settle requires active state)
      yield* insertProvisioningRun("run_settle_ok", "ses_exec_settle_ok")
      const { db } = yield* Database.Service
      yield* db
        .update(TaskRunTable)
        .set({ state: "running", phase: "research", version: 1, execution_started_at: Date.now() })
        .where(eq(TaskRunTable.run_id, "run_settle_ok"))
        .run()
        .pipe(Effect.orDie)

      const result = yield* settleRun({ ...settleParams("run_settle_ok"), now: Date.now() })
      expect(result.won).toBe(true)
      if (result.won) expect(result.finalState).toBe("completed")

      const row = yield* db
        .select({ state: TaskRunTable.state })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, "run_settle_ok"))
        .get()
        .pipe(Effect.orDie)
      expect(row?.state).toBe("completed")

      const events = yield* db
        .select({ type: TaskRunEventTable.type })
        .from(TaskRunEventTable)
        .where(eq(TaskRunEventTable.run_id, "run_settle_ok"))
        .all()
        .pipe(Effect.orDie)
      expect(events.some((e) => e.type === "run_settled")).toBe(true)
    }),
  )

  it.effect("expired lease → won=false (claim_lost) — stale callback cannot settle", () =>
    Effect.gen(function* () {
      yield* setup
      const pastExpiry = Date.now() - 10_000 // lease expired 10s ago
      yield* insertProvisioningRun("run_settle_expired", "ses_exec_settle_expired", {
        leaseExpiry: pastExpiry,
      })
      const { db } = yield* Database.Service
      yield* db
        .update(TaskRunTable)
        .set({ state: "running", phase: "research", version: 1, execution_started_at: Date.now() })
        .where(eq(TaskRunTable.run_id, "run_settle_expired"))
        .run()
        .pipe(Effect.orDie)

      const result = yield* settleRun({
        ...settleParams("run_settle_expired"),
        now: Date.now(),
      })
      // Design §5: expired lease fence prevents settlement
      expect(result.won).toBe(false)
    }),
  )

  it.effect("wrong claimGeneration → won=false (claim_lost)", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertProvisioningRun("run_settle_badgen", "ses_exec_settle_badgen")
      const { db } = yield* Database.Service
      yield* db
        .update(TaskRunTable)
        .set({ state: "running", phase: "research", version: 1, execution_started_at: Date.now() })
        .where(eq(TaskRunTable.run_id, "run_settle_badgen"))
        .run()
        .pipe(Effect.orDie)

      // D-1 (P1-9): explicitly pass a WRONG claimGeneration token so the fence is actually tested.
      // The correct generation is CLAIM_GEN (1); we pass 999 which must cause won=false.
      const wrongGen = 999
      const result = yield* settleRun({
        ...settleParams("run_settle_badgen"),
        claimGeneration: wrongGen, // wrong generation — CAS must reject this
      })
      // Wrong generation must produce won=false
      expect(result.won).toBe(false)

      // Row state must be unchanged — wrong generation settle must not modify state
      const row = yield* db
        .select({ state: TaskRunTable.state, version: TaskRunTable.version })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, "run_settle_badgen"))
        .get()
        .pipe(Effect.orDie)
      expect(row?.state).toBe("running") // unchanged
      expect(row?.version).toBe(1) // version not bumped
    }),
  )

  it.effect("close intent wins a structured completion without writing incompatible terminal evidence", () =>
    Effect.gen(function* () {
      yield* setup
      const runID = "run_settle_structured_close_race"
      const childSessionID = SessionID.make("ses_exec_settle_structured_close_race")
      const rawResultMessageID = MessageID.make("msg_settle_structured_close_raw")
      const structuredResultMessageID = MessageID.make("msg_settle_structured_close_result")
      yield* insertProvisioningRun(runID, childSessionID, { executionSpec: structuredExecutionSpec })
      yield* insertAssistantEvidence(childSessionID, rawResultMessageID)
      yield* insertAssistantEvidence(childSessionID, structuredResultMessageID)
      const { db } = yield* Database.Service
      yield* db
        .update(TaskRunTable)
        .set({ state: "running", phase: "research", version: 1, execution_started_at: Date.now() })
        .where(eq(TaskRunTable.run_id, runID))
        .run()
        .pipe(Effect.orDie)
      yield* markStructuredFinalizerAttempt({
        runID,
        ownerToken: OWNER,
        claimGeneration: CLAIM_GEN,
        attempt: 1,
        sourceMessageID: rawResultMessageID,
      })
      yield* db
        .update(TaskRunTable)
        .set({
          control_state: "close_requested",
          close_reason: "parent_closed",
          close_requested_at: Date.now(),
          version: 3,
        })
        .where(and(eq(TaskRunTable.run_id, runID), eq(TaskRunTable.version, 2)))
        .run()
        .pipe(Effect.orDie)

      const result = yield* settleRun({
        ...settleParams(runID),
        reason: "structured_output_valid",
        output: '{"result":"done"}',
        rawResultMessageID,
        structuredResultMessageID,
        structuredOutputReceipt: { attempt: 1, transport: "structured" },
      })
      expect(result).toEqual({ won: true, finalState: "closed" })
      expect(
        yield* db
          .select({
            state: TaskRunTable.state,
            controlState: TaskRunTable.control_state,
            reason: TaskRunTable.reason,
            attempts: TaskRunTable.attempts,
            output: TaskRunTable.output,
            rawResultMessageID: TaskRunTable.raw_result_message_id,
            structuredResultMessageID: TaskRunTable.structured_result_message_id,
            structuredOutputReceipt: TaskRunTable.structured_output_receipt,
            error: TaskRunTable.error,
          })
          .from(TaskRunTable)
          .where(eq(TaskRunTable.run_id, runID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({
        state: "closed",
        controlState: "closed",
        reason: "parent_closed",
        attempts: 1,
        output: null,
        rawResultMessageID,
        structuredResultMessageID: null,
        structuredOutputReceipt: null,
        error: { code: "closed", message: "parent_closed" },
      })
      expect(
        yield* db
          .select({ runID: TaskStructuredOutputEvidenceTable.run_id })
          .from(TaskStructuredOutputEvidenceTable)
          .where(eq(TaskStructuredOutputEvidenceTable.run_id, runID))
          .all(),
      ).toEqual([])
    }),
  )
})

describe("DET-EXEC-01 executor lifecycle", () => {
  it.live("persists the assistant text and raw result message before terminal completion", () =>
    Effect.gen(function* () {
      yield* setup
      const runID = "run_executor_success"
      const childSessionID = SessionID.make("ses_exec_success")
      yield* insertProvisioningRun(runID, childSessionID)

      yield* runExecutor({
        run: { runID, version: 0, claimGeneration: CLAIM_GEN } as any,
        ownerToken: OWNER,
        claimGeneration: CLAIM_GEN,
        childSessionID,
        parentSessionID: PARENT_SID,
        deliveryMode: "foreground",
        directory: DIRECTORY,
        agentType: "researcher",
        leaseMs: 300,
        loopFn: () => Effect.succeed(assistantMessage("msg_executor_success", "verified result")),
      })

      const { db } = yield* Database.Service
      const row = yield* db
        .select({
          state: TaskRunTable.state,
          output: TaskRunTable.output,
          messageID: TaskRunTable.raw_result_message_id,
        })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, runID))
        .get()
        .pipe(Effect.orDie)
      expect(row).toMatchObject({
        state: "completed",
        output: "verified result",
        messageID: "msg_executor_success",
      })
    }),
  )

  it.live("settles the frozen durable structured contract with its exact receipt", () =>
    Effect.gen(function* () {
      yield* setup
      const runID = "run_executor_structured"
      const childSessionID = SessionID.make("ses_exec_structured")
      yield* insertProvisioningRun(runID, childSessionID, {
        executionSpec: {
          prompt: { text: "inspect" },
          agent: "researcher",
          model: { providerID: "test", modelID: "test" },
          structuredOutput: {
            schema: { type: "object" },
            allowTextFallback: true,
            receiptVersion: 1,
            maxAttempts: 2,
          },
        },
      })
      const { db } = yield* Database.Service
      const rawMessageID = MessageID.make("msg_executor_research")
      const requestMessageID = MessageID.make("msg_executor_structured_request")
      const responseMessageID = MessageID.make("msg_executor_structured")
      yield* db
        .insert(MessageTable)
        .values([
          {
            id: rawMessageID,
            session_id: childSessionID,
            data: { role: "assistant" },
            time_created: Date.now(),
            time_updated: Date.now(),
          },
          {
            id: requestMessageID,
            session_id: childSessionID,
            data: {
              role: "user",
              metadata: {
                deepagent: {
                  structured_finalizer: {
                    run_id: runID,
                    attempt: 2,
                    source_message_id: rawMessageID,
                    allow_text: true,
                  },
                },
              },
            },
            time_created: Date.now(),
            time_updated: Date.now(),
          },
          {
            id: responseMessageID,
            session_id: childSessionID,
            data: { role: "assistant", parentID: requestMessageID },
            time_created: Date.now(),
            time_updated: Date.now(),
          },
        ] as any)
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(PartTable)
        .values({
          id: "prt_executor_structured",
          message_id: responseMessageID,
          session_id: childSessionID,
          data: { type: "text", text: '{"result":"object"}' },
          time_created: Date.now(),
          time_updated: Date.now(),
        } as any)
        .run()
        .pipe(Effect.orDie)

      yield* runExecutor({
        run: {
          runID,
          version: 0,
          claimGeneration: CLAIM_GEN,
          executionSpec: {
            prompt: { text: "inspect" },
            agent: "researcher",
            model: { providerID: "test", modelID: "test" },
            structuredOutput: {
              schema: { type: "object" },
              allowTextFallback: true,
              receiptVersion: 1,
              maxAttempts: 2,
            },
          },
        } as any,
        ownerToken: OWNER,
        claimGeneration: CLAIM_GEN,
        childSessionID,
        parentSessionID: PARENT_SID,
        deliveryMode: "foreground",
        directory: DIRECTORY,
        agentType: "researcher",
        leaseMs: 300,
        loopFn: () => Effect.succeed(assistantMessage("msg_executor_research", "research")),
        finalizeFn: ({ contract, onFinalizing, onPrepared, research }) =>
          onFinalizing({ attempt: 1, sourceMessageID: research.info.id }).pipe(
            Effect.andThen(onFinalizing({ attempt: 2, sourceMessageID: research.info.id })),
            Effect.andThen(
              onPrepared({
                attempt: 2,
                sourceMessageID: rawMessageID,
                responseMessageID,
                receipt: { attempt: 2, transport: "text_fallback" },
                output: JSON.stringify({ result: contract.schema.type }),
              }),
            ),
            Effect.as({
              output: JSON.stringify({ result: contract.schema.type }),
              structuredResultMessageID: responseMessageID,
              receipt: { attempt: 2, transport: "text_fallback" } as const,
            }),
          ),
      })

      const row = yield* db
        .select({
          state: TaskRunTable.state,
          reason: TaskRunTable.reason,
          attempts: TaskRunTable.attempts,
          output: TaskRunTable.output,
          rawResultMessageID: TaskRunTable.raw_result_message_id,
          structuredResultMessageID: TaskRunTable.structured_result_message_id,
          structuredOutputReceipt: TaskRunTable.structured_output_receipt,
        })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, runID))
        .get()
        .pipe(Effect.orDie)
      expect(row).toEqual({
        state: "completed",
        reason: "structured_output_text_fallback",
        attempts: 2,
        output: '{"result":"object"}',
        rawResultMessageID: MessageID.make("msg_executor_research"),
        structuredResultMessageID: MessageID.make("msg_executor_structured"),
        structuredOutputReceipt: { attempt: 2, transport: "text_fallback" },
      })
    }),
  )

  it.live("persists a first-attempt structured finalizer transport failure without retrying the finalizer", () =>
    Effect.gen(function* () {
      yield* setup
      const runID = "run_executor_finalizer_transport_failure"
      const childSessionID = SessionID.make("ses_exec_finalizer_transport_failure")
      const rawResultMessageID = MessageID.make("msg_executor_finalizer_transport_research")
      yield* insertProvisioningRun(runID, childSessionID, { executionSpec: structuredExecutionSpec })
      yield* insertAssistantEvidence(childSessionID, rawResultMessageID)
      let finalizerCalls = 0

      yield* runExecutor({
        run: { runID, version: 0, claimGeneration: CLAIM_GEN, executionSpec: structuredExecutionSpec } as any,
        ownerToken: OWNER,
        claimGeneration: CLAIM_GEN,
        childSessionID,
        parentSessionID: PARENT_SID,
        deliveryMode: "foreground",
        directory: DIRECTORY,
        agentType: "researcher",
        leaseMs: 300,
        loopFn: () => Effect.succeed(assistantMessage(rawResultMessageID, "durable research")),
        finalizeFn: ({ onFinalizing, research }) =>
          onFinalizing({ attempt: 1, sourceMessageID: research.info.id }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                finalizerCalls++
                throw new Error(
                  `[provider_error] APIError: provider unavailable Child session: ${childSessionID}. Phase: finalize. Attempts: 1.`,
                )
              }),
            ),
          ),
      })

      const { db } = yield* Database.Service
      const row = yield* db
        .select({
          state: TaskRunTable.state,
          reason: TaskRunTable.reason,
          attempts: TaskRunTable.attempts,
          rawResultMessageID: TaskRunTable.raw_result_message_id,
          receipt: TaskRunTable.structured_output_receipt,
          error: TaskRunTable.error,
        })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, runID))
        .get()
        .pipe(Effect.orDie)

      expect(finalizerCalls).toBe(1)
      expect(row).toEqual({
        state: "failed",
        reason: "structured_finalizer_transport_error",
        attempts: 1,
        rawResultMessageID,
        receipt: null,
        error: {
          code: "structured_finalizer_transport_error",
          message: expect.stringContaining("provider unavailable"),
          data: { phase: "finalize", attempt: 1, failure_class: "transport", source_code: "provider_error" },
        },
      })
    }),
  )

  it.live("settles a normally completed degraded receipt from its pre-sealed raw material", () =>
    Effect.gen(function* () {
      yield* setup
      const runID = "run_executor_degraded_complete"
      const childSessionID = SessionID.make("ses_exec_degraded_complete")
      const rawResultMessageID = MessageID.make("msg_executor_degraded_complete_research")
      const receipt = { attempt: 2, transport: "degraded_text", reason: "structured_output_missing" } as const
      const output = makeDegradedStructuredOutput("durable degraded research", receipt)
      yield* insertProvisioningRun(runID, childSessionID, { executionSpec: structuredExecutionSpec })
      yield* insertAssistantEvidence(childSessionID, rawResultMessageID)
      const { db } = yield* Database.Service
      yield* db
        .insert(PartTable)
        .values({
          id: "prt_executor_degraded_complete_research",
          message_id: rawResultMessageID,
          session_id: childSessionID,
          data: { type: "text", text: "durable degraded research" },
          time_created: Date.now(),
          time_updated: Date.now(),
        } as any)
        .run()
        .pipe(Effect.orDie)

      yield* runExecutor({
        run: { runID, version: 0, claimGeneration: CLAIM_GEN, executionSpec: structuredExecutionSpec } as any,
        ownerToken: OWNER,
        claimGeneration: CLAIM_GEN,
        childSessionID,
        parentSessionID: PARENT_SID,
        deliveryMode: "foreground",
        directory: DIRECTORY,
        agentType: "researcher",
        loopFn: () => Effect.succeed(assistantMessage(rawResultMessageID, "durable degraded research")),
        finalizeFn: ({ onFinalizing, onPrepared, research }) =>
          onFinalizing({ attempt: 1, sourceMessageID: research.info.id }).pipe(
            Effect.andThen(onFinalizing({ attempt: 2, sourceMessageID: research.info.id })),
            Effect.andThen(onPrepared({ attempt: 2, sourceMessageID: rawResultMessageID, receipt, output })),
            Effect.as({ output, receipt }),
          ),
      })

      expect(
        yield* db
          .select({
            state: TaskRunTable.state,
            reason: TaskRunTable.reason,
            receipt: TaskRunTable.structured_output_receipt,
            evidence: TaskStructuredOutputEvidenceTable.run_id,
          })
          .from(TaskRunTable)
          .innerJoin(
            TaskStructuredOutputEvidenceTable,
            eq(TaskStructuredOutputEvidenceTable.run_id, TaskRunTable.run_id),
          )
          .where(eq(TaskRunTable.run_id, runID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ state: "completed", reason: "structured_output_degraded_text", receipt, evidence: runID })
    }),
  )

  it.live("persists a second-attempt structured validation failure with the raw research identity", () =>
    Effect.gen(function* () {
      yield* setup
      const runID = "run_executor_finalizer_validation_failure"
      const childSessionID = SessionID.make("ses_exec_finalizer_validation_failure")
      const rawResultMessageID = MessageID.make("msg_executor_finalizer_validation_research")
      yield* insertProvisioningRun(runID, childSessionID, { executionSpec: structuredExecutionSpec })
      yield* insertAssistantEvidence(childSessionID, rawResultMessageID)

      yield* runExecutor({
        run: { runID, version: 0, claimGeneration: CLAIM_GEN, executionSpec: structuredExecutionSpec } as any,
        ownerToken: OWNER,
        claimGeneration: CLAIM_GEN,
        childSessionID,
        parentSessionID: PARENT_SID,
        deliveryMode: "foreground",
        directory: DIRECTORY,
        agentType: "researcher",
        leaseMs: 300,
        loopFn: () => Effect.succeed(assistantMessage(rawResultMessageID, "durable research")),
        finalizeFn: ({ onFinalizing, research }) =>
          onFinalizing({ attempt: 1, sourceMessageID: research.info.id }).pipe(
            Effect.andThen(onFinalizing({ attempt: 2, sourceMessageID: research.info.id })),
            Effect.andThen(
              Effect.fail(
                new Error(
                  `[structured_output_invalid] /result is required Child session: ${childSessionID}. Phase: finalize. Attempts: 2.`,
                ),
              ),
            ),
          ),
      })

      const { db } = yield* Database.Service
      const row = yield* db
        .select({
          state: TaskRunTable.state,
          reason: TaskRunTable.reason,
          attempts: TaskRunTable.attempts,
          rawResultMessageID: TaskRunTable.raw_result_message_id,
          receipt: TaskRunTable.structured_output_receipt,
          error: TaskRunTable.error,
        })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, runID))
        .get()
        .pipe(Effect.orDie)

      expect(row).toEqual({
        state: "failed",
        reason: "structured_finalizer_validation_error",
        attempts: 2,
        rawResultMessageID,
        receipt: null,
        error: {
          code: "structured_finalizer_validation_error",
          message: expect.stringContaining("/result is required"),
          data: {
            phase: "finalize",
            attempt: 2,
            failure_class: "validation",
            source_code: "structured_output_invalid",
          },
        },
      })
    }),
  )

  it.live("persists finalizer-unavailable before attempt one while retaining the raw research identity", () =>
    Effect.gen(function* () {
      yield* setup
      const runID = "run_executor_finalizer_unavailable"
      const childSessionID = SessionID.make("ses_exec_finalizer_unavailable")
      const rawResultMessageID = MessageID.make("msg_executor_finalizer_unavailable_research")
      yield* insertProvisioningRun(runID, childSessionID, { executionSpec: structuredExecutionSpec })
      yield* insertAssistantEvidence(childSessionID, rawResultMessageID)

      yield* runExecutor({
        run: { runID, version: 0, claimGeneration: CLAIM_GEN, executionSpec: structuredExecutionSpec } as any,
        ownerToken: OWNER,
        claimGeneration: CLAIM_GEN,
        childSessionID,
        parentSessionID: PARENT_SID,
        deliveryMode: "foreground",
        directory: DIRECTORY,
        agentType: "researcher",
        leaseMs: 300,
        loopFn: () => Effect.succeed(assistantMessage(rawResultMessageID, "durable research")),
      })

      const { db } = yield* Database.Service
      const row = yield* db
        .select({
          state: TaskRunTable.state,
          reason: TaskRunTable.reason,
          attempts: TaskRunTable.attempts,
          rawResultMessageID: TaskRunTable.raw_result_message_id,
          receipt: TaskRunTable.structured_output_receipt,
          error: TaskRunTable.error,
        })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, runID))
        .get()
        .pipe(Effect.orDie)

      expect(row).toEqual({
        state: "failed",
        reason: "structured_finalizer_unavailable",
        attempts: 0,
        rawResultMessageID,
        receipt: null,
        error: {
          code: "structured_finalizer_unavailable",
          message: "durable structured finalizer is unavailable",
          data: { phase: "finalize", attempt: 0, failure_class: "unavailable" },
        },
      })
    }),
  )

  it.live(
    "seals the exact structured finalizer attempt before provider work and leaves no terminal evidence on crash",
    () =>
      Effect.gen(function* () {
        yield* setup
        const runID = "run_executor_finalizer_crash_after_admission"
        const childSessionID = SessionID.make("ses_exec_finalizer_crash_after_admission")
        const rawResultMessageID = MessageID.make("msg_executor_finalizer_crash_research")
        yield* insertProvisioningRun(runID, childSessionID, { executionSpec: structuredExecutionSpec })
        yield* insertAssistantEvidence(childSessionID, rawResultMessageID)
        const started = yield* Deferred.make<void>()
        const execution = yield* runExecutor({
          run: { runID, version: 0, claimGeneration: CLAIM_GEN, executionSpec: structuredExecutionSpec } as any,
          ownerToken: OWNER,
          claimGeneration: CLAIM_GEN,
          childSessionID,
          parentSessionID: PARENT_SID,
          deliveryMode: "foreground",
          directory: DIRECTORY,
          agentType: "researcher",
          leaseMs: 30_000,
          loopFn: () => Effect.succeed(assistantMessage(rawResultMessageID, "durable research")),
          finalizeFn: ({ onFinalizing, research }) =>
            onFinalizing({ attempt: 1, sourceMessageID: research.info.id }).pipe(
              Effect.tap(() => Deferred.succeed(started, undefined)),
              Effect.andThen(Effect.never),
            ),
        }).pipe(Effect.forkChild)

        yield* Deferred.await(started)
        const { db } = yield* Database.Service
        expect(
          yield* db
            .select({
              state: TaskRunTable.state,
              phase: TaskRunTable.phase,
              attempts: TaskRunTable.attempts,
              rawResultMessageID: TaskRunTable.raw_result_message_id,
              finalizerInputMessageID: TaskRunTable.finalizer_input_message_id,
              finalizerStartedAt: TaskRunTable.finalizer_started_at,
            })
            .from(TaskRunTable)
            .where(eq(TaskRunTable.run_id, runID))
            .get()
            .pipe(Effect.orDie),
        ).toEqual({
          state: "finalizing",
          phase: "finalize",
          attempts: 1,
          rawResultMessageID,
          finalizerInputMessageID: rawResultMessageID,
          finalizerStartedAt: expect.any(Number),
        })
        expect(
          yield* db
            .select({ runID: TaskStructuredOutputEvidenceTable.run_id })
            .from(TaskStructuredOutputEvidenceTable)
            .where(eq(TaskStructuredOutputEvidenceTable.run_id, runID)),
        ).toEqual([])
        expect(
          yield* db
            .select({ type: TaskRunEventTable.type, reason: TaskRunEventTable.reason })
            .from(TaskRunEventTable)
            .where(eq(TaskRunEventTable.run_id, runID)),
        ).toContainEqual({ type: "structured_finalizer_attempt_started", reason: "attempt:1" })

        yield* Fiber.interrupt(execution)
        expect(
          yield* db
            .select({ state: TaskRunTable.state, attempts: TaskRunTable.attempts })
            .from(TaskRunTable)
            .where(eq(TaskRunTable.run_id, runID))
            .get()
            .pipe(Effect.orDie),
        ).toEqual({ state: "finalizing", attempts: 1 })
      }),
  )

  it.live("writes response authority before terminal settlement and recovers it without provider replay", () =>
    Effect.gen(function* () {
      yield* setup
      const runID = "run_executor_response_authority_crash"
      const childSessionID = SessionID.make("ses_exec_response_authority_crash")
      const rawResultMessageID = MessageID.make("msg_executor_response_authority_research")
      const requestMessageID = MessageID.make("msg_executor_response_authority_request")
      const responseMessageID = MessageID.make("msg_executor_response_authority_response")
      yield* insertProvisioningRun(runID, childSessionID, { executionSpec: structuredExecutionSpec })
      yield* insertAssistantEvidence(childSessionID, rawResultMessageID)
      const { db } = yield* Database.Service
      yield* db
        .insert(MessageTable)
        .values([
          {
            id: requestMessageID,
            session_id: childSessionID,
            data: {
              role: "user",
              metadata: {
                deepagent: {
                  structured_finalizer: {
                    run_id: runID,
                    attempt: 1,
                    source_message_id: rawResultMessageID,
                    allow_text: false,
                  },
                },
              },
            },
            time_created: Date.now(),
            time_updated: Date.now(),
          },
          {
            id: responseMessageID,
            session_id: childSessionID,
            data: {
              role: "assistant",
              parentID: requestMessageID,
              structured: { result: "prepared" },
            },
            time_created: Date.now(),
            time_updated: Date.now(),
          },
        ] as any)
        .run()
        .pipe(Effect.orDie)
      const prepared = yield* Deferred.make<void>()
      let finalizerCalls = 0
      const execution = yield* runExecutor({
        run: { runID, version: 0, claimGeneration: CLAIM_GEN, executionSpec: structuredExecutionSpec } as any,
        ownerToken: OWNER,
        claimGeneration: CLAIM_GEN,
        childSessionID,
        parentSessionID: PARENT_SID,
        deliveryMode: "foreground",
        directory: DIRECTORY,
        agentType: "researcher",
        leaseMs: 30_000,
        loopFn: () => Effect.succeed(assistantMessage(rawResultMessageID, "durable research")),
        finalizeFn: ({ onFinalizing, onPrepared, research }) =>
          onFinalizing({ attempt: 1, sourceMessageID: research.info.id }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                finalizerCalls++
              }),
            ),
            Effect.andThen(
              onPrepared({
                attempt: 1,
                sourceMessageID: rawResultMessageID,
                responseMessageID,
                receipt: { attempt: 1, transport: "structured" },
                output: '{"result":"prepared"}',
              }),
            ),
            Effect.tap(() => Deferred.succeed(prepared, undefined)),
            Effect.andThen(Effect.never),
          ),
      }).pipe(Effect.forkChild)

      yield* Deferred.await(prepared)
      expect(
        yield* db
          .select({ runID: TaskStructuredFinalizerResponseTable.run_id })
          .from(TaskStructuredFinalizerResponseTable)
          .where(eq(TaskStructuredFinalizerResponseTable.run_id, runID)),
      ).toEqual([{ runID }])
      yield* db
        .update(TaskRunTable)
        .set({ version: 4, lease_expires_at: Date.now() - 1 })
        .where(eq(TaskRunTable.run_id, runID))
        .run()
        .pipe(Effect.orDie)
      yield* Fiber.interrupt(execution)

      expect(yield* classifyOnStartup({ directory: DIRECTORY })).toMatchObject({ recovered: 1 })
      expect(finalizerCalls).toBe(1)
      expect(
        yield* db
          .select({ state: TaskRunTable.state, output: TaskRunTable.output })
          .from(TaskRunTable)
          .where(eq(TaskRunTable.run_id, runID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ state: "completed", output: '{"result":"prepared"}' })
      expect(
        yield* db
          .select({ runID: TaskStructuredOutputEvidenceTable.run_id })
          .from(TaskStructuredOutputEvidenceTable)
          .where(eq(TaskStructuredOutputEvidenceTable.run_id, runID)),
      ).toEqual([{ runID }])
    }),
  )

  it.live("seals degraded raw material before settlement and recovers without another provider turn", () =>
    Effect.gen(function* () {
      yield* setup
      const runID = "run_executor_degraded_authority_crash"
      const childSessionID = SessionID.make("ses_exec_degraded_authority_crash")
      const rawResultMessageID = MessageID.make("msg_executor_degraded_authority_research")
      const receipt = { attempt: 2, transport: "degraded_text", reason: "structured_output_invalid" } as const
      const output = makeDegradedStructuredOutput("durable research", receipt)
      yield* insertProvisioningRun(runID, childSessionID, { executionSpec: structuredExecutionSpec })
      yield* insertAssistantEvidence(childSessionID, rawResultMessageID)
      const { db } = yield* Database.Service
      yield* db
        .insert(PartTable)
        .values({
          id: "prt_executor_degraded_authority_research",
          message_id: rawResultMessageID,
          session_id: childSessionID,
          data: { type: "text", text: "durable research" },
          time_created: Date.now(),
          time_updated: Date.now(),
        } as any)
        .run()
        .pipe(Effect.orDie)
      const prepared = yield* Deferred.make<void>()
      let providerTurns = 0
      const execution = yield* runExecutor({
        run: { runID, version: 0, claimGeneration: CLAIM_GEN, executionSpec: structuredExecutionSpec } as any,
        ownerToken: OWNER,
        claimGeneration: CLAIM_GEN,
        childSessionID,
        parentSessionID: PARENT_SID,
        deliveryMode: "foreground",
        directory: DIRECTORY,
        agentType: "researcher",
        leaseMs: 30_000,
        loopFn: () =>
          Effect.sync(() => {
            providerTurns++
            return assistantMessage(rawResultMessageID, "durable research")
          }),
        finalizeFn: ({ onFinalizing, onPrepared, research }) =>
          Effect.sync(() => {
            providerTurns++
          }).pipe(
            Effect.andThen(onFinalizing({ attempt: 1, sourceMessageID: research.info.id })),
            Effect.andThen(
              Effect.sync(() => {
                providerTurns++
              }),
            ),
            Effect.andThen(onFinalizing({ attempt: 2, sourceMessageID: research.info.id })),
            Effect.andThen(
              onPrepared({
                attempt: 2,
                sourceMessageID: rawResultMessageID,
                receipt,
                output,
              }),
            ),
            Effect.tap(() => Deferred.succeed(prepared, undefined)),
            Effect.andThen(Effect.never),
          ),
      }).pipe(Effect.forkChild)

      yield* Deferred.await(prepared)
      expect(
        yield* db
          .select({
            receipt: TaskStructuredOutputEvidenceTable.structured_output_receipt,
            output: TaskStructuredOutputEvidenceTable.output,
            resultMessageID: TaskStructuredOutputEvidenceTable.result_message_id,
          })
          .from(TaskStructuredOutputEvidenceTable)
          .where(eq(TaskStructuredOutputEvidenceTable.run_id, runID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ receipt, output, resultMessageID: null })
      expect(
        yield* db
          .select({ runID: TaskStructuredFinalizerResponseTable.run_id })
          .from(TaskStructuredFinalizerResponseTable)
          .where(eq(TaskStructuredFinalizerResponseTable.run_id, runID)),
      ).toEqual([])
      yield* db
        .update(TaskRunTable)
        .set({ version: 5, lease_expires_at: Date.now() - 1 })
        .where(eq(TaskRunTable.run_id, runID))
        .run()
        .pipe(Effect.orDie)
      yield* Fiber.interrupt(execution)

      expect(yield* classifyOnStartup({ directory: DIRECTORY })).toMatchObject({ recovered: 1 })
      expect(providerTurns).toBe(3)
      expect(
        yield* db
          .select({
            state: TaskRunTable.state,
            reason: TaskRunTable.reason,
            output: TaskRunTable.output,
            resultMessageID: TaskRunTable.structured_result_message_id,
            receipt: TaskRunTable.structured_output_receipt,
          })
          .from(TaskRunTable)
          .where(eq(TaskRunTable.run_id, runID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({
        state: "completed",
        reason: "structured_output_degraded_text",
        output,
        resultMessageID: null,
        receipt,
      })
    }),
  )

  it.live("does not start a structured finalizer after a durable close intent wins", () =>
    Effect.gen(function* () {
      yield* setup
      const runID = "run_executor_finalizer_close_before_attempt"
      const childSessionID = SessionID.make("ses_exec_finalizer_close_before_attempt")
      const rawResultMessageID = MessageID.make("msg_executor_finalizer_close_research")
      yield* insertProvisioningRun(runID, childSessionID, { executionSpec: structuredExecutionSpec })
      yield* insertAssistantEvidence(childSessionID, rawResultMessageID)
      const database = yield* Database.Service
      let providerCalls = 0

      yield* runExecutor({
        run: { runID, version: 0, claimGeneration: CLAIM_GEN, executionSpec: structuredExecutionSpec } as any,
        ownerToken: OWNER,
        claimGeneration: CLAIM_GEN,
        childSessionID,
        parentSessionID: PARENT_SID,
        deliveryMode: "foreground",
        directory: DIRECTORY,
        agentType: "researcher",
        leaseMs: 30_000,
        loopFn: () =>
          requestClose({ rootRunID: runID, reason: "parent_closed" }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.as(assistantMessage(rawResultMessageID, "durable research")),
          ),
        finalizeFn: ({ onFinalizing, research }) =>
          onFinalizing({ attempt: 1, sourceMessageID: research.info.id }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                providerCalls++
                return {
                  output: '{"result":"must not dispatch"}',
                  receipt: { attempt: 1 as const, transport: "structured" as const },
                }
              }),
            ),
          ),
      })

      const { db } = yield* Database.Service
      expect(providerCalls).toBe(0)
      expect(
        yield* db
          .select({ state: TaskRunTable.state, reason: TaskRunTable.reason })
          .from(TaskRunTable)
          .where(eq(TaskRunTable.run_id, runID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ state: "closed", reason: "parent_closed" })
      expect(
        yield* db
          .select({ type: TaskRunEventTable.type })
          .from(TaskRunEventTable)
          .where(eq(TaskRunEventTable.run_id, runID))
          .all(),
      ).not.toContainEqual({ type: "structured_finalizer_attempt_started" })
    }),
  )

  it.live("does not start a structured finalizer after a durable interrupt intent wins", () =>
    Effect.gen(function* () {
      yield* setup
      const runID = "run_executor_finalizer_interrupt_before_attempt"
      const childSessionID = SessionID.make("ses_exec_finalizer_interrupt_before_attempt")
      const rawResultMessageID = MessageID.make("msg_executor_finalizer_interrupt_research")
      yield* insertProvisioningRun(runID, childSessionID, { executionSpec: structuredExecutionSpec })
      yield* insertAssistantEvidence(childSessionID, rawResultMessageID)
      const database = yield* Database.Service
      let providerCalls = 0

      yield* runExecutor({
        run: { runID, version: 0, claimGeneration: CLAIM_GEN, executionSpec: structuredExecutionSpec } as any,
        ownerToken: OWNER,
        claimGeneration: CLAIM_GEN,
        childSessionID,
        parentSessionID: PARENT_SID,
        deliveryMode: "foreground",
        directory: DIRECTORY,
        agentType: "researcher",
        leaseMs: 30_000,
        loopFn: () =>
          requestInterrupt({ runID, reason: "human_interrupted" }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.as(assistantMessage(rawResultMessageID, "durable research")),
          ),
        finalizeFn: ({ onFinalizing, research }) =>
          onFinalizing({ attempt: 1, sourceMessageID: research.info.id }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                providerCalls++
                return {
                  output: '{"result":"must not dispatch"}',
                  receipt: { attempt: 1 as const, transport: "structured" as const },
                }
              }),
            ),
          ),
      })

      const { db } = yield* Database.Service
      expect(providerCalls).toBe(0)
      expect(
        yield* db
          .select({ state: TaskRunTable.state, reason: TaskRunTable.reason })
          .from(TaskRunTable)
          .where(eq(TaskRunTable.run_id, runID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ state: "interrupted", reason: "human_interrupted" })
      expect(
        yield* db
          .select({ type: TaskRunEventTable.type })
          .from(TaskRunEventTable)
          .where(eq(TaskRunEventTable.run_id, runID))
          .all(),
      ).not.toContainEqual({ type: "structured_finalizer_attempt_started" })
    }),
  )

  it.live("interrupts a live provider activity when its lease fence is lost", () =>
    Effect.gen(function* () {
      yield* setup
      const runID = "run_executor_lease_lost"
      const childSessionID = SessionID.make("ses_exec_lease_lost")
      yield* insertProvisioningRun(runID, childSessionID)

      const execution = yield* runExecutor({
        run: { runID, version: 0, claimGeneration: CLAIM_GEN } as any,
        ownerToken: OWNER,
        claimGeneration: CLAIM_GEN,
        childSessionID,
        parentSessionID: PARENT_SID,
        deliveryMode: "foreground",
        directory: DIRECTORY,
        agentType: "researcher",
        leaseMs: 60,
        loopFn: () => Effect.never,
      }).pipe(Effect.forkChild)

      const { db } = yield* Database.Service
      yield* Effect.sleep("10 millis")
      yield* db
        .update(TaskRunTable)
        .set({ lease_expires_at: Date.now() - 1 })
        .where(eq(TaskRunTable.run_id, runID))
        .run()
        .pipe(Effect.orDie)
      yield* Fiber.join(execution)

      const row = yield* db
        .select({ state: TaskRunTable.state, reason: TaskRunTable.reason })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, runID))
        .get()
        .pipe(Effect.orDie)
      expect(row).toMatchObject({ state: "recovery_required", reason: "execution_lease_lost" })

      const events = yield* db
        .select({ type: TaskRunEventTable.type })
        .from(TaskRunEventTable)
        .where(eq(TaskRunEventTable.run_id, runID))
        .all()
        .pipe(Effect.orDie)
      expect(events.some((event) => event.type === "execution_recovery_required")).toBe(true)
    }),
  )

  it.live("persists the provider failure for the parent instead of returning a generic terminal state", () =>
    Effect.gen(function* () {
      yield* setup
      const runID = "run_executor_provider_failure"
      const childSessionID = SessionID.make("ses_exec_provider_failure")
      yield* insertProvisioningRun(runID, childSessionID)

      yield* runExecutor({
        run: { runID, version: 0, claimGeneration: CLAIM_GEN } as any,
        ownerToken: OWNER,
        claimGeneration: CLAIM_GEN,
        childSessionID,
        parentSessionID: PARENT_SID,
        deliveryMode: "foreground",
        directory: DIRECTORY,
        agentType: "researcher",
        leaseMs: 300,
        loopFn: () => Effect.fail(new Error("injected provider failure")),
      })

      const { db } = yield* Database.Service
      const row = yield* db
        .select({ state: TaskRunTable.state, reason: TaskRunTable.reason, error: TaskRunTable.error })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, runID))
        .get()
        .pipe(Effect.orDie)
      expect(row?.state).toBe("failed")
      expect(row?.reason).toContain("injected provider failure")
      expect(row?.error).toMatchObject({ code: "failed" })
      expect(row?.error?.message).toContain("injected provider failure")
    }),
  )

  it.live("renews the lease and records a durable PR receipt before completing an automatic writer", () =>
    Effect.gen(function* () {
      yield* setup
      const runID = "run_executor_pr_success"
      const childSessionID = SessionID.make("ses_exec_pr_success")
      yield* insertProvisioningRun(runID, childSessionID)
      const { db } = yield* Database.Service
      yield* db
        .update(TaskRunTable)
        .set({
          workspace_mode: "worktree",
          workspace_owner: "run",
          workspace_operation_key: childSessionID,
          worktree_state: "ready",
          worktree_directory: "/exec_worktree",
          worktree_branch: "deepagent-code/task-exec-pr",
        })
        .where(eq(TaskRunTable.run_id, runID))
        .run()
        .pipe(Effect.orDie)
      let submissions = 0

      yield* runExecutor({
        run: { runID, version: 0, claimGeneration: CLAIM_GEN } as any,
        ownerToken: OWNER,
        claimGeneration: CLAIM_GEN,
        childSessionID,
        parentSessionID: PARENT_SID,
        deliveryMode: "foreground",
        directory: DIRECTORY,
        agentType: "general",
        automaticWorktree: {
          name: "task-exec-pr",
          directory: "/exec_worktree",
          branch: "deepagent-code/task-exec-pr",
        },
        submitWorktree: () =>
          Effect.gen(function* () {
            submissions++
            yield* Effect.sleep("180 millis")
            return { id: "pr:executor:success", workerCommit: "commit-success" }
          }),
        leaseMs: 90,
        loopFn: () => Effect.succeed(assistantMessage("msg_executor_pr_success", "implemented")),
      })

      const row = yield* db
        .select({
          state: TaskRunTable.state,
          prID: TaskRunTable.pr_id,
          operationKey: TaskRunTable.pr_operation_key,
          worktreeState: TaskRunTable.worktree_state,
        })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, runID))
        .get()
        .pipe(Effect.orDie)
      const events = yield* db
        .select({ type: TaskRunEventTable.type })
        .from(TaskRunEventTable)
        .where(eq(TaskRunEventTable.run_id, runID))
        .all()
        .pipe(Effect.orDie)

      expect(submissions).toBe(1)
      expect(row).toEqual({
        state: "completed",
        prID: "pr:executor:success",
        operationKey: childSessionID,
        worktreeState: "submitted",
      })
      expect(events.map((event) => event.type)).toEqual([
        "execution_started",
        "pr_submission_started",
        "pr_submitted",
        "run_settled",
      ])
    }),
  )

  it.live("requires recovery when PR submission fails after its durable marker", () =>
    Effect.gen(function* () {
      yield* setup
      const runID = "run_executor_pr_unknown"
      const childSessionID = SessionID.make("ses_exec_pr_unknown")
      yield* insertProvisioningRun(runID, childSessionID)
      const { db } = yield* Database.Service
      yield* db
        .update(TaskRunTable)
        .set({
          workspace_mode: "worktree",
          workspace_owner: "run",
          workspace_operation_key: childSessionID,
          worktree_state: "ready",
          worktree_directory: "/exec_worktree_unknown",
          worktree_branch: "deepagent-code/task-exec-pr-unknown",
        })
        .where(eq(TaskRunTable.run_id, runID))
        .run()
        .pipe(Effect.orDie)

      yield* runExecutor({
        run: { runID, version: 0, claimGeneration: CLAIM_GEN } as any,
        ownerToken: OWNER,
        claimGeneration: CLAIM_GEN,
        childSessionID,
        parentSessionID: PARENT_SID,
        deliveryMode: "foreground",
        directory: DIRECTORY,
        agentType: "general",
        automaticWorktree: {
          name: "task-exec-pr-unknown",
          directory: "/exec_worktree_unknown",
          branch: "deepagent-code/task-exec-pr-unknown",
        },
        submitWorktree: () => Effect.fail(new Error("injected ambiguous PR failure")),
        leaseMs: 300,
        loopFn: () => Effect.succeed(assistantMessage("msg_executor_pr_unknown", "implemented")),
      })

      const row = yield* db
        .select({
          state: TaskRunTable.state,
          reason: TaskRunTable.reason,
          owner: TaskRunTable.execution_owner,
          lease: TaskRunTable.lease_expires_at,
        })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, runID))
        .get()
        .pipe(Effect.orDie)
      const events = yield* db
        .select({ type: TaskRunEventTable.type })
        .from(TaskRunEventTable)
        .where(eq(TaskRunEventTable.run_id, runID))
        .all()
        .pipe(Effect.orDie)

      expect(row).toEqual({
        state: "recovery_required",
        reason: "worktree_submission_outcome_unknown",
        owner: null,
        lease: null,
      })
      expect(events.map((event) => event.type)).toEqual([
        "execution_started",
        "pr_submission_started",
        "pr_submission_recovery_required",
      ])
    }),
  )

  it.live("requires recovery when the PR adapter returns but the durable receipt CAS is lost", () =>
    Effect.gen(function* () {
      yield* setup
      const runID = "run_executor_pr_receipt_lost"
      const childSessionID = SessionID.make("ses_exec_pr_receipt_lost")
      yield* insertProvisioningRun(runID, childSessionID)
      const { db } = yield* Database.Service
      yield* db
        .update(TaskRunTable)
        .set({
          workspace_mode: "worktree",
          workspace_owner: "run",
          workspace_operation_key: childSessionID,
          worktree_state: "ready",
          worktree_directory: "/exec_worktree_receipt_lost",
          worktree_branch: "deepagent-code/task-exec-pr-receipt-lost",
        })
        .where(eq(TaskRunTable.run_id, runID))
        .run()
        .pipe(Effect.orDie)

      yield* runExecutor({
        run: { runID, version: 0, claimGeneration: CLAIM_GEN } as any,
        ownerToken: OWNER,
        claimGeneration: CLAIM_GEN,
        childSessionID,
        parentSessionID: PARENT_SID,
        deliveryMode: "foreground",
        directory: DIRECTORY,
        agentType: "general",
        automaticWorktree: {
          name: "task-exec-pr-receipt-lost",
          directory: "/exec_worktree_receipt_lost",
          branch: "deepagent-code/task-exec-pr-receipt-lost",
        },
        submitWorktree: () =>
          Effect.gen(function* () {
            yield* db
              .update(TaskRunTable)
              .set({ lease_expires_at: Date.now() - 1 })
              .where(eq(TaskRunTable.run_id, runID))
              .run()
              .pipe(Effect.orDie)
            return { id: "pr:executor:receipt-lost", workerCommit: "commit-receipt-lost" }
          }),
        leaseMs: 30_000,
        loopFn: () => Effect.succeed(assistantMessage("msg_executor_pr_receipt_lost", "implemented")),
      })

      const row = yield* db
        .select({
          state: TaskRunTable.state,
          reason: TaskRunTable.reason,
          prID: TaskRunTable.pr_id,
          owner: TaskRunTable.execution_owner,
          lease: TaskRunTable.lease_expires_at,
        })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, runID))
        .get()
        .pipe(Effect.orDie)
      const events = yield* db
        .select({ type: TaskRunEventTable.type })
        .from(TaskRunEventTable)
        .where(eq(TaskRunEventTable.run_id, runID))
        .all()
        .pipe(Effect.orDie)

      expect(row).toEqual({
        state: "recovery_required",
        reason: "worktree_submission_outcome_unknown",
        prID: null,
        owner: null,
        lease: null,
      })
      expect(events.map((event) => event.type)).toEqual([
        "execution_started",
        "pr_submission_started",
        "pr_submission_recovery_required",
      ])
    }),
  )
})
