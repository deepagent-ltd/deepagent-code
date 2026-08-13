import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Database } from "@deepagent-code/core/database/database"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import {
  MessageTable,
  SessionTable,
  TaskRunEventTable,
  TaskRunTable,
  TaskStructuredFinalizerResponseTable,
  TaskStructuredOutputEvidenceTable,
} from "@deepagent-code/core/session/sql"
import { MessageID, SessionID } from "../../src/session/schema"
import { classifyOnStartup } from "../../src/tool/task-run"
import { testEffect } from "../lib/effect"

const database = Layer.mergeAll(Database.layerFromPath(":memory:"), CrossSpawnSpawner.defaultLayer)
const it = testEffect(database)
const directory = "/structured-response-recovery"
const runID = "run_structured_response_recovery"
const parentSessionID = SessionID.make("ses_structured_response_parent")
const childSessionID = SessionID.make("ses_structured_response_child")
const rawMessageID = MessageID.make("msg_structured_response_raw")
const requestMessageID = MessageID.make("msg_structured_response_request")
const responseMessageID = MessageID.make("msg_structured_response_result")

describe("structured finalizer response recovery", () => {
  it.effect("settles exact persisted assistant material without another provider turn", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const now = Date.now()
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values(
          [
            { id: parentSessionID, slug: "parent", title: "parent" },
            { id: childSessionID, slug: "child", title: "child" },
          ].map((session) => ({
            ...session,
            project_id: ProjectV2.ID.global,
            directory,
            version: "test",
          })),
        )
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(TaskRunTable)
        .values({
          run_id: runID,
          request_hash: "request-hash",
          parent_session_id: parentSessionID,
          parent_message_id: MessageID.make("msg_structured_response_parent"),
          tool_call_id: "call-structured-response-recovery",
          child_session_id: childSessionID,
          generation: 1,
          delivery_mode: "foreground",
          effective_delivery_mode: "foreground",
          phase: "finalize",
          state: "finalizing",
          attempts: 1,
          version: 3,
          control_state: "open",
          input_state: "ready",
          execution_owner: "expired-structured-owner",
          lease_expires_at: now - 1,
          execution_started_at: now - 5_000,
          finalizer_started_at: now - 2_000,
          claim_generation: 2,
          available_at: 0,
          start_attempts: 1,
          raw_result_message_id: rawMessageID,
          finalizer_input_message_id: rawMessageID,
          execution_spec: {
            prompt: { text: "inspect" },
            agent: "researcher",
            model: { providerID: "test", modelID: "test" },
            structuredOutput: {
              schema: {
                type: "object",
                properties: { result: { type: "string" } },
                required: ["result"],
                additionalProperties: false,
              },
              allowTextFallback: true,
              receiptVersion: 1,
              maxAttempts: 2,
            },
          },
          time_created: now - 10_000,
          time_updated: now - 2_000,
        } as typeof TaskRunTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(MessageTable)
        .values([
          {
            id: rawMessageID,
            session_id: childSessionID,
            data: { role: "assistant" },
            time_created: now - 3_000,
            time_updated: now - 3_000,
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
                    attempt: 1,
                    source_message_id: rawMessageID,
                    allow_text: false,
                  },
                },
              },
            },
            time_created: now - 2_000,
            time_updated: now - 2_000,
          },
          {
            id: responseMessageID,
            session_id: childSessionID,
            data: {
              role: "assistant",
              parentID: requestMessageID,
              structured: { result: "recovered" },
            },
            time_created: now - 1_000,
            time_updated: now - 1_000,
          },
        ] as (typeof MessageTable.$inferInsert)[])
        .run()
        .pipe(Effect.orDie)

      expect(yield* classifyOnStartup({ directory, now })).toEqual({ classified: 0, requeued: 0, recovered: 1 })
      expect(
        yield* db
          .select({
            state: TaskRunTable.state,
            phase: TaskRunTable.phase,
            output: TaskRunTable.output,
            receipt: TaskRunTable.structured_output_receipt,
            owner: TaskRunTable.execution_owner,
          })
          .from(TaskRunTable)
          .where(eq(TaskRunTable.run_id, runID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({
        state: "completed",
        phase: "settled",
        output: '{"result":"recovered"}',
        receipt: { attempt: 1, transport: "structured" },
        owner: null,
      })
      expect(
        yield* db
          .select({ runID: TaskStructuredFinalizerResponseTable.run_id })
          .from(TaskStructuredFinalizerResponseTable),
      ).toEqual([{ runID }])
      expect(
        yield* db.select({ runID: TaskStructuredOutputEvidenceTable.run_id }).from(TaskStructuredOutputEvidenceTable),
      ).toEqual([{ runID }])
      expect(
        yield* db
          .select({ type: TaskRunEventTable.type })
          .from(TaskRunEventTable)
          .where(eq(TaskRunEventTable.run_id, runID)),
      ).toContainEqual({ type: "structured_response_recovered" })
      expect(yield* classifyOnStartup({ directory, now: now + 1 })).toEqual({
        classified: 0,
        requeued: 0,
        recovered: 0,
      })
    }),
  )
})
